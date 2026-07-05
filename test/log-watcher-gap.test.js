// log-watcher 覆盖补缺：补 test/log-watcher.test.js 未触达的分支，聚焦 _readDelta 增量读核心、
// 轮转切换 _switchToRotatedFile、_safeSseWrite 边界、startWatching/unwatchLogFile 导出。
// 目标缺口（c8）：53-55(readLogFile catch) / 70-72(_safeSseWrite destroyed) /
//   101-148 & 167-258(_readDelta + 实体广播 + kv_cache_content + context_window + 轮转) /
//   314-352(startWatching / unwatchLogFile / 部分分支)。
// 驱动方式：用真实 fs.watch（事件驱动，~80ms 去抖），向被 watch 的文件 append，轮询等待客户端收包。
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readLogFile, sendToClients, sendEventToClients, sendChunkToClients,
  watchLogFile, unwatchAll, unwatchLogFile, startWatching, getWatchedFiles,
} from '../server/lib/log-watcher.js';

function makeTmpDir() {
  const dir = join(tmpdir(), `ccv-logwatch-gap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 轮询等待 predicate。默认 6.5s 上限：fs.watch 在 macOS 偶发漏首个事件，
// 6.5s > 5s 安全网慢轮询（SAFETY_POLL_MS）确保兜底必触发，避免偶发超时假阳性。
function waitFor(predicate, { timeout = 6500, interval = 30 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      if (predicate()) { clearInterval(id); resolve(true); }
      else if (Date.now() - t0 > timeout) { clearInterval(id); resolve(false); }
    }, interval);
  });
}

function rec(line) { return line + '\n---\n'; }

describe('log-watcher gap', () => {
  let dir;
  beforeEach(() => { dir = makeTmpDir(); unwatchAll(); });
  afterEach(() => { unwatchAll(); rmSync(dir, { recursive: true, force: true }); });

  function collector() {
    const data = [];
    const events = [];
    const client = {
      destroyed: false, writable: true,
      write(p) {
        if (p.startsWith('event: ')) {
          const m = /^event: (\S+)\ndata: (.*)\n\n$/s.exec(p);
          if (m) events.push({ name: m[1], data: JSON.parse(m[2]) });
        } else {
          const m = /^data: (.*)\n\n$/s.exec(p);
          if (m) data.push(JSON.parse(m[1]));
        }
        return true;
      },
      end() {},
    };
    return { client, data, events };
  }

  function makeOpts(logFile, clients, over = {}) {
    return {
      logFile, clients,
      getClaudePid: () => 99999,
      runParallelHook: async () => {},
      notifyStatsWorker: () => {},
      getLogFile: () => logFile,
      ...over,
    };
  }

  // ── readLogFile catch（读到一个目录 → readFileSync 抛 EISDIR） (53-55) ─────
  it('readLogFile returns [] and swallows a read error (path is a directory)', () => {
    const d = join(dir, 'adir.jsonl');
    mkdirSync(d);
    // existsSync(dir) 为 true → 进入 try → readFileSync 抛 EISDIR → catch 返回 []
    assert.deepEqual(readLogFile(d), []);
  });

  // ── _safeSseWrite：destroyed / writable=false 的客户端被剔除 (70-72) ───────
  it('sendToClients drops a destroyed client without calling write', () => {
    let wrote = false;
    const dead = { destroyed: true, writable: true, write() { wrote = true; return true; } };
    const live = collector();
    const clients = [dead, live.client];
    sendToClients(clients, { timestamp: 't', url: '/u' });
    assert.equal(wrote, false, 'destroyed client must not be written to');
    assert.equal(clients.includes(dead), false, 'destroyed client removed from array');
    assert.equal(live.data.length, 1, 'live client still receives');
  });

  it('sendEventToClients / sendChunkToClients format event frames and drop !writable clients', () => {
    const c = collector();
    const notWritable = { destroyed: false, writable: false, write() { throw new Error('should not write'); } };
    const clients = [notWritable, c.client];
    sendEventToClients(clients, 'load_start', { total: 3 });
    sendChunkToClients(clients, JSON.stringify([{ a: 1 }]));
    assert.equal(clients.includes(notWritable), false);
    assert.deepEqual(c.events[0], { name: 'load_start', data: { total: 3 } });
    // sendChunkToClients 用固定事件名 load_chunk
    assert.equal(c.events[1].name, 'load_chunk');
    assert.deepEqual(c.events[1].data, [{ a: 1 }]);
  });

  // ── _readDelta：增量解析 + pid 注入 + 广播（167-258 主线） ─────────────────
  it('streams a newly appended entry, injecting claude pid when missing', async () => {
    const file = join(dir, 'live.jsonl');
    writeFileSync(file, '');
    const { client, data } = collector();
    watchLogFile(makeOpts(file, [client]));

    appendFileSync(file, rec(JSON.stringify({ timestamp: 't1', url: '/v1/messages' })));
    const got = await waitFor(() => data.length > 0);
    assert.ok(got, 'entry should arrive via fs.watch debounce');
    assert.equal(data[0].timestamp, 't1');
    assert.equal(data[0].pid, 99999, 'missing pid back-filled from getClaudePid()');
  });

  it('keeps an existing pid intact (no overwrite)', async () => {
    const file = join(dir, 'pid.jsonl');
    writeFileSync(file, '');
    const { client, data } = collector();
    watchLogFile(makeOpts(file, [client]));
    appendFileSync(file, rec(JSON.stringify({ timestamp: 't', url: '/u', pid: 4242 })));
    await waitFor(() => data.length > 0);
    assert.equal(data[0].pid, 4242);
  });

  // ── pendingTail：单条 JSON 没有结尾分隔符也能解析（fast path） ─────────────
  it('parses a trailing single JSON object that lacks a closing separator', async () => {
    const file = join(dir, 'tail.jsonl');
    writeFileSync(file, '');
    const { client, data } = collector();
    watchLogFile(makeOpts(file, [client]));
    // 不带 \n---\n 结尾：parts 为空、pendingTail 是合法 JSON → 走 JSON.parse 提升分支
    appendFileSync(file, JSON.stringify({ timestamp: 'solo', url: '/v1/messages' }));
    const got = await waitFor(() => data.length > 0);
    assert.ok(got, 'trailing-JSON fast path should emit the entry');
    assert.equal(data[0].timestamp, 'solo');
  });

  // ── mainAgent 实体 → kv_cache_content + context_window 事件 ────────────────
  it('emits kv_cache_content and context_window for a completed mainAgent entry', async () => {
    const file = join(dir, 'main.jsonl');
    writeFileSync(file, '');
    const { client, data, events } = collector();
    watchLogFile(makeOpts(file, [client]));

    const entry = {
      timestamp: 'm1', url: '/v1/messages', mainAgent: true, inProgress: false,
      body: {
        model: 'claude-opus-4-6-20250514',
        system: [{ type: 'text', text: 'You are Claude Code', cache_control: { type: 'ephemeral' } }],
        tools: [],
        messages: [],
      },
      response: { body: { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } } },
    };
    appendFileSync(file, rec(JSON.stringify(entry)));
    const got = await waitFor(() => data.length > 0 && events.length >= 2);
    assert.ok(got, 'entry + both side events should arrive');
    const names = events.map((e) => e.name);
    assert.ok(names.includes('kv_cache_content'), 'kv_cache_content emitted');
    const cw = events.find((e) => e.name === 'context_window');
    assert.ok(cw, 'context_window emitted');
    // opus → 1M 窗
    assert.equal(cw.data.context_window_size, 1000000);
    assert.equal(cw.data.total_input_tokens, 150);
    assert.equal(cw.data.total_output_tokens, 20);
  });

  // ── 轮转切换：文件被截断 + getLogFile 指向新文件 → _switchToRotatedFile (101-148/240+) ──
  it('switches to a rotated file when the watched file shrinks and getLogFile points elsewhere', async () => {
    const oldFile = join(dir, 'rot_20260101_000000.jsonl');
    const newFile = join(dir, 'rot_20260102_000000.jsonl');
    // old 先有一些内容（lastByteOffset 起点 > 0）
    writeFileSync(oldFile, rec(JSON.stringify({ timestamp: 'old', url: '/u' })));
    // new 已是“当前”文件，含若干历史条目，countLogEntries/stream 会重放
    writeFileSync(newFile, rec(JSON.stringify({ timestamp: 'n1', url: '/u' })) + rec(JSON.stringify({ timestamp: 'n2', url: '/u' })));

    const { client, data, events } = collector();
    let active = oldFile;
    const opts = makeOpts(oldFile, [client], { getLogFile: () => active });
    watchLogFile(opts);

    // 切到 newFile 并把 oldFile 截断（currentSize < lastByteOffset → 触发 reset + 轮转判定）
    active = newFile;
    truncateSync(oldFile, 0);

    const got = await waitFor(() => events.some((e) => e.name === 'load_end'), { timeout: 7000 });
    assert.ok(got, 'rotation should run load_start→chunks→load_end');
    const names = events.map((e) => e.name);
    assert.ok(names.includes('load_start'));
    assert.ok(names.includes('load_end'));
    // 轮转后 newFile 被纳入 watch；oldFile 保持被 watch —— 外部进程 teammate 启动时
    // 解析一次 leader 日志路径后就一直向旧段追加，取消 watch 会让它们的轮转后条目
    // 在 live 路径彻底不可见（client 端 dedup 吸收重复帧）。
    assert.equal(getWatchedFiles().has(newFile), true, 'rotated-to file is now watched');
    assert.equal(getWatchedFiles().has(oldFile), true, 'old file STAYS watched after rotation');
    // load_start 报告了新文件的条目总数
    const ls = events.find((e) => e.name === 'load_start');
    assert.equal(ls.data.incremental, false);
    // 旧段追加（模拟外部 teammate 完成写入）仍会被广播
    const before = data.length;
    appendFileSync(oldFile, rec(JSON.stringify({ timestamp: 'late-teammate', url: '/u', teammate: 'tm' })));
    const gotLate = await waitFor(() => data.length > before && data.some((d) => d && d.timestamp === 'late-teammate'), { timeout: 7000 });
    assert.ok(gotLate, 'old-segment append still broadcasts after rotation');
  });

  // ── unwatchLogFile 单文件移除 + startWatching 入口 ────────────────────────
  it('unwatchLogFile removes a single watched file, leaving others', () => {
    const a = join(dir, 'a.jsonl'); const b = join(dir, 'b.jsonl');
    writeFileSync(a, ''); writeFileSync(b, '');
    watchLogFile(makeOpts(a, []));
    watchLogFile(makeOpts(b, []));
    assert.equal(getWatchedFiles().size, 2);
    unwatchLogFile(a);
    assert.equal(getWatchedFiles().has(a), false);
    assert.equal(getWatchedFiles().has(b), true);
  });

  // ── 增量条目后再检测轮转：先广播 validParts，再走底部的 _switchToRotatedFile (199-202) ──
  it('after streaming fresh entries, follows a rotation if getLogFile moved on', async () => {
    const a = join(dir, 'grow_20260101_000000.jsonl');
    const b = join(dir, 'grow_20260102_000000.jsonl');
    writeFileSync(a, '');
    writeFileSync(b, rec(JSON.stringify({ timestamp: 'b1', url: '/u' })));
    const { client, data, events } = collector();
    let active = a;
    watchLogFile(makeOpts(a, [client], { getLogFile: () => active }));

    // 同一轮 delta 里：先给 a append 一条新条目（validParts>0 → 广播），
    // 再把 active 指向 b（底部 getLogFile 检测到轮转 → _switchToRotatedFile）。
    active = b;
    appendFileSync(a, rec(JSON.stringify({ timestamp: 'a-new', url: '/u' })));

    const ended = await waitFor(() => events.some((e) => e.name === 'load_end'), { timeout: 7000 });
    assert.ok(ended, 'rotation after streaming should complete with load_end');
    // 先广播的新条目应已送达
    assert.ok(data.some((d) => d.timestamp === 'a-new'), 'fresh entry streamed before rotation');
    assert.equal(getWatchedFiles().has(b), true);
    // 旧段保持被 watch（外部 teammate 轮转后仍向旧段写入，见 _switchToRotatedFile 注释）
    assert.equal(getWatchedFiles().has(a), true);
  });

  // ── 目录 watcher 创建失败 → 退回 watchFile 轮询；卸载走 polling 分支 (322-325 / 252-257 / 270-272) ──
  it('falls back to watchFile polling when the dir watcher cannot be created, and unwatch tears it down', () => {
    const sub = join(dir, 'gone');
    mkdirSync(sub);
    const file = join(sub, 'p_20260101_000000.jsonl');
    writeFileSync(file, '');
    // 删掉父目录 → watch(dir) 抛 ENOENT → _getOrCreateDirWatcher 返回 null → _fallbackToPolling
    rmSync(sub, { recursive: true, force: true });

    watchLogFile(makeOpts(file, []));
    const st = getWatchedFiles().get(file);
    assert.ok(st, 'file registered even when dir watcher fails');
    assert.equal(st.polling, true, 'fell back to watchFile polling');

    // 卸载应命中 polling 分支（unwatchFile），不抛。
    assert.doesNotThrow(() => unwatchLogFile(file));
    assert.equal(getWatchedFiles().has(file), false);
  });

  it('startWatching forwards clients into watchLogFile', () => {
    const f = join(dir, 'sw.jsonl');
    writeFileSync(f, '');
    const { client } = collector();
    startWatching({ ...makeOpts(f, undefined), clients: [client] });
    assert.equal(getWatchedFiles().has(f), true);
    const st = getWatchedFiles().get(f);
    assert.ok(st.opts.clients.includes(client), 'clients threaded through to fileState.opts');
  });
});
