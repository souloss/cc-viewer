// 分支补全：server/routes/events.js —— 针对 api-events-gap / events-deep /
// events-kv-context-scan / events-backpressure 仍未触达的残余臂（单跑口径 branch 74.75%）。
// 逐一覆盖：
//   turnEndNotify：空 body → JSON {}（38）；payload.sessionId/ts/transcriptPath 默认臂（45）
//   registerLog / resumeChoice：body 超 MAX_POST_BODY → req.destroy（54 / 76）
//   resumeChoice 成功广播 4 个 client.write catch（98/103/107/111）：throwing client
//   /events：ping write catch（146）；incremental 全真路径（173 右臂 / 174 / 230 / 231）；
//            load_chunk res.destroyed 早退（210）；out 含换行三元 true 臂（218）；
//            onScan 带空格 "mainAgent": true 子串臂（236）；ring 校验 continue 非 mainAgent（262）；
//            ring parse catch（275）
//   entriesPage：file 含 '..' 短路（352）；validateLogPath ACCESS_DENIED → 403（358）；
//                entries.map 内 JSON.parse 抛 → null 过滤（370）
//
// 隔离范式（与 events-deep.test.js 同）：「冷启动」模式 —— 必须在 import interceptor 之前
// 设好 env / cwd / 预置 recent log，让 _initPromise 填充 _resumeState（resumeChoice 成功
// 广播 catch 的前置）。私有 tmp LOG_DIR / CLAUDE_CONFIG_DIR / chdir 确定性工程目录；
// CCV_PROXY_MODE=1 跳过 http patch + server 自启。handler 直调（EventEmitter 假 req +
// 收集型 res），无端口、无固定 sleep。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

// ── 冷启动隔离：import interceptor 之前设 env / cwd / 预置 recent log ──────────────
const tmpRoot = mkdtempSync(join(tmpdir(), 'ccv-branch-events-'));
const logRoot = join(tmpRoot, 'logs');
const projectCwd = join(tmpRoot, 'evbranchproj');
mkdirSync(logRoot, { recursive: true });
mkdirSync(projectCwd, { recursive: true });
process.env.CCV_LOG_DIR = logRoot;
process.env.CLAUDE_CONFIG_DIR = logRoot;
process.env.CCV_PROXY_MODE = '1';        // 跳过 http patch + server 自启
delete process.env.CCV_WORKSPACE_MODE;   // 走冷启动 resume 流程
delete process.env.CCV_CLI_MODE;
delete process.env.CCV_IM_PLATFORM;
const origCwd = process.cwd();
process.chdir(projectCwd);

const projectName = basename(projectCwd).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
const projectLogDir = join(logRoot, projectName);
mkdirSync(projectLogDir, { recursive: true });

const SEP = '\n---\n';

function tsName(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function mainAgentEntry(ts, inputTokens, extra = {}) {
  return {
    timestamp: ts,
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    status: 200,
    mainAgent: true,
    body: {
      model: 'claude-opus-4-8',
      system: [{ type: 'text', text: 'You are Claude Code' }],
      tools: [{ name: 'Bash' }],
      messages: [{ role: 'user', content: 'hi' }],
    },
    response: { body: { usage: { input_tokens: inputTokens, output_tokens: 10 } } },
    ...extra,
  };
}
function serialize(entries) { return entries.map((e) => JSON.stringify(e)).join(SEP) + SEP; }

// 预置「最近日志」让冷启动 _initPromise 设 _resumeState
const recentLogPath = join(projectLogDir, `${projectName}_${tsName(Date.now())}.jsonl`);
writeFileSync(recentLogPath, serialize([mainAgentEntry('2026-06-06T00:00:00.000Z', 42)]));

/** 收集型 res（EventEmitter，可注入 onWrite 行为） */
function makeRes(opts = {}) {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = null;
  res.chunks = [];
  res.ended = false;
  res.destroyed = false;
  res.writable = true;
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {}; return res; };
  res.write = (c) => {
    const s = c == null ? '' : (Buffer.isBuffer(c) ? c.toString('utf-8') : String(c));
    if (opts.onWrite) { const r = opts.onWrite(s, res); if (r !== undefined) return r; }
    res.chunks.push(s);
    return true;
  };
  res.end = (c) => { if (c != null) res.chunks.push(Buffer.isBuffer(c) ? c.toString('utf-8') : String(c)); res.ended = true; res.emit('finish'); return res; };
  res.on('error', () => {});
  return res;
}
function bodyStr(res) { return res.chunks.join(''); }
function parseFrames(out) {
  const frames = [];
  for (const block of out.split('\n\n')) {
    if (!block.trim()) continue;
    const ev = { event: 'message', data: '' };
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) ev.event = line.slice(7);
      else if (line.startsWith('data: ')) ev.data += line.slice(6);
    }
    frames.push(ev);
  }
  return frames;
}
function url(pathname, query = {}) { return { pathname, searchParams: new URLSearchParams(query) }; }

let interceptor;
let events, entriesPage, turnEndNotify, registerLog, resumeChoice;
let LOG_FILE_TEMP;

before(async () => {
  interceptor = await import('../server/interceptor.js');
  await interceptor._initPromise;
  LOG_FILE_TEMP = interceptor.LOG_FILE;
  assert.ok(interceptor._resumeState, '_resumeState 必须由冷启动 _initPromise 设置');
  assert.equal(interceptor._projectName, projectName);
  mkdirSync(dirname(LOG_FILE_TEMP), { recursive: true });

  const mod = await import('../server/routes/events.js');
  const find = (p, m) => mod.eventsRoutes.find((r) => r.path === p && r.method === m).handler;
  events = find('/events', 'GET');
  entriesPage = find('/api/entries/page', 'GET');
  turnEndNotify = find('/api/turn-end-notify', 'POST');
  registerLog = find('/api/register-log', 'POST');
  resumeChoice = find('/api/resume-choice', 'POST');
});

after(() => {
  process.chdir(origCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

// 注意：写日志要写到当前 LOG_FILE（冷启动后为 *_temp.jsonl）；resumeChoice 成功后切换。
function writeLog(entries) { writeFileSync(interceptor.LOG_FILE, serialize(entries)); }

function eventsDeps(over = {}) {
  return {
    turnEndDebounceMs: 1234,
    DEFAULT_EVENTS_LIMIT: 400,
    SSE_BACKPRESSURE_TIMEOUT_MS: 30,
    pendingMajorUpdate: null,
    clients: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
describe('POST /api/turn-end-notify 默认臂', () => {
  const TOKEN = 'tok-branch';
  function depsT(calls) {
    return { INTERNAL_TOKEN: TOKEN, scheduleTurnEndBroadcast: (...a) => calls.push(a) };
  }

  it('空 body → JSON.parse 走 {} 臂，sessionId/ts/transcriptPath 取默认值（38/45）', async () => {
    const calls = [];
    const req = new EventEmitter();
    req.headers = { 'x-ccviewer-internal': TOKEN };
    req.destroy = () => {};
    const res = makeRes();
    const beforeTs = Date.now();
    await new Promise((resolve) => {
      res.on('finish', resolve);
      turnEndNotify(req, res, url('/api/turn-end-notify'), true, depsT(calls));
      req.emit('end'); // 不发 data → body === '' → payload = {}
    });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    const [sid, ts, tp] = calls[0];
    assert.equal(sid, null, 'sessionId 默认 null');
    assert.equal(tp, null, 'transcriptPath 默认 null');
    assert.ok(typeof ts === 'number' && ts >= beforeTs, 'ts 默认 Date.now()');
  });
});

// ---------------------------------------------------------------------------
describe('POST body 超限 → req.destroy（54 / 76）', () => {
  it('registerLog body 超过 MAX_POST_BODY 触发 destroy（54）', () => {
    let destroyed = false;
    const req = new EventEmitter();
    req.headers = {};
    req.destroy = () => { destroyed = true; };
    const res = makeRes();
    const deps = { MAX_POST_BODY: 4, logWatcherOpts: (lf) => ({ logFile: lf, clients: [] }) };
    registerLog(req, res, url('/api/register-log'), true, deps);
    req.emit('data', 'xxxxxxxx'); // > 4 字节
    assert.equal(destroyed, true, 'registerLog 在超限时 destroy');
  });

  it('resumeChoice body 超过 MAX_POST_BODY 触发 destroy（76）', () => {
    let destroyed = false;
    const req = new EventEmitter();
    req.headers = {};
    req.destroy = () => { destroyed = true; };
    const res = makeRes();
    const deps = { MAX_POST_BODY: 4, clients: [], logWatcherOpts: (lf) => ({ logFile: lf, clients: [] }) };
    resumeChoice(req, res, url('/api/resume-choice'), true, deps);
    req.emit('data', 'yyyyyyyy');
    assert.equal(destroyed, true, 'resumeChoice 在超限时 destroy');
  });
});

// ---------------------------------------------------------------------------
describe('GET /events 写路径 + 扫描分支', () => {
  it('ping write catch：ping write 抛被吞（146）', async (t) => {
    writeLog([mainAgentEntry('2026-06-06T01:00:00.000Z', 10)]);
    t.mock.timers.enable({ apis: ['setInterval'] });
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes({ onWrite(s) { if (s.startsWith('event: ping')) throw new Error('ping pipe gone'); } });
    const deps = eventsDeps();
    await events(req, res, url('/events'), true, deps);
    // 触发 30s ping 回调 → res.write 抛 → catch 吞掉，不抛穿
    assert.doesNotThrow(() => t.mock.timers.tick(30000));
    req.emit('close'); // clearInterval
    t.mock.timers.reset();
  });

  it('incremental 全真路径：projectMatch 右臂 + since/limit 三元 true 臂（173/174/230/231）', async () => {
    writeLog([
      mainAgentEntry('2026-06-06T01:00:00.000Z', 1),
      mainAgentEntry('2026-06-06T01:01:00.000Z', 2),
      mainAgentEntry('2026-06-06T01:02:00.000Z', 3),
    ]);
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes();
    const deps = eventsDeps();
    // since=有效 ISO & cc>0 & project===_projectName & 日期有效 → useIncremental=true
    await events(req, res, url('/events', {
      since: '2026-06-06T01:00:30.000Z', cc: '1', project: projectName,
    }), true, deps);
    const frames = parseFrames(bodyStr(res));
    const ls = frames.find((f) => f.event === 'load_start');
    assert.ok(ls, 'load_start 存在');
    const lsData = JSON.parse(ls.data);
    assert.equal(lsData.incremental, true, 'incremental 模式标记');
    assert.equal('hasMore' in lsData, false, 'incremental 不附 hasMore（useLimit=false）');
    const chunks = frames.filter((f) => f.event === 'load_chunk');
    assert.ok(chunks.length >= 1, 'incremental 流式 load_chunk');
  });

  it('load_chunk res.destroyed 早退（210）', async () => {
    writeLog([mainAgentEntry('2026-06-06T01:00:00.000Z', 5), mainAgentEntry('2026-06-06T01:01:00.000Z', 6)]);
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes();
    res.destroyed = true; // 进入流回调即早退
    const deps = eventsDeps();
    await events(req, res, url('/events'), true, deps);
    const frames = parseFrames(bodyStr(res));
    assert.equal(frames.filter((f) => f.event === 'load_chunk').length, 0, 'destroyed 时无 load_chunk');
  });

  it('out 含换行 → 三元 true 臂 replace（218）', async () => {
    const pretty = JSON.stringify(mainAgentEntry('2026-06-06T01:00:00.000Z', 7), null, 2);
    writeFileSync(interceptor.LOG_FILE, pretty + SEP);
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes();
    const deps = eventsDeps();
    await events(req, res, url('/events'), true, deps);
    const frames = parseFrames(bodyStr(res));
    const chunk = frames.find((f) => f.event === 'load_chunk');
    assert.ok(chunk, 'load_chunk 存在');
    assert.equal(chunk.data.includes('\n'), false, 'pretty 换行被 replace 去除');
    assert.match(chunk.data, /"input_tokens": 7|"input_tokens":7/);
  });

  it('onScan 带空格 "mainAgent": true 子串 + ring continue/parse-catch（236/262/275）', async () => {
    // A) 带空格 "mainAgent": true 的真实 mainAgent（命中 236 第二子串臂，结构化通过）
    // B) 含 "mainAgent":true 但非真实 mainAgent 结构 → isMainAgentEntry false → continue（262）
    // C) 含 "mainAgent":true 但 JSON 截断不可 parse → ring parse catch（275）
    const realPretty = JSON.stringify(mainAgentEntry('2026-06-06T01:00:00.000Z', 88), null, 1); // 带空格冒号
    const notMain = JSON.stringify({
      timestamp: '2026-06-06T01:01:00.000Z', mainAgent: true,
      body: { model: 'x', messages: [] }, response: { body: {} },
    });
    const brokenRaw = '{"mainAgent":true, "timestamp":"2026-06-06T01:02:00.000Z", broken';
    writeFileSync(interceptor.LOG_FILE, [realPretty, notMain, brokenRaw].join(SEP) + SEP);
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes();
    const deps = eventsDeps();
    await events(req, res, url('/events'), true, deps);
    const frames = parseFrames(bodyStr(res));
    const cw = frames.find((f) => f.event === 'context_window');
    assert.ok(cw, 'context_window 来自唯一真实 mainAgent');
    assert.equal(JSON.parse(cw.data).total_input_tokens, 88);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/entries/page 校验分支', () => {
  it("file 含 '..' 短路 → 400（352 左臂）", async () => {
    const res = makeRes();
    await entriesPage({ headers: {} }, res, url('/api/entries/page', {
      before: '2026-06-06T03:00:00.000Z', file: `${projectName}/../x.jsonl`,
    }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(bodyStr(res)).error, 'Invalid file name');
  });

  it('validateLogPath ACCESS_DENIED → 403（358 中间臂）', async () => {
    // LOG_DIR 内放一个 *.jsonl 符号链接，realpath 指向 LOG_DIR 之外 → ACCESS_DENIED
    const outside = join(tmpRoot, 'outside-target.jsonl');
    writeFileSync(outside, serialize([mainAgentEntry('2026-06-06T01:00:00.000Z', 1)]));
    const linkName = `${projectName}/escape-link.jsonl`;
    const linkPath = join(logRoot, linkName);
    mkdirSync(dirname(linkPath), { recursive: true });
    try { symlinkSync(outside, linkPath); } catch {
      assert.ok(true, 'symlink 不支持，跳过 ACCESS_DENIED 用例');
      return;
    }
    const res = makeRes();
    await entriesPage({ headers: {} }, res, url('/api/entries/page', {
      before: '2026-06-06T03:00:00.000Z', file: linkName,
    }));
    assert.equal(res.statusCode, 403, 'symlink 越界 → ACCESS_DENIED 403');
  });

  it('entries.map 内 JSON.parse 抛 → null 过滤（370 catch）', async () => {
    // 合法 + 损坏 raw（手工裸写），readPagedEntries 返回两条 raw，
    // map 内 JSON.parse(损坏) 抛 → catch return null → filter(Boolean) 剔除。
    const good = JSON.stringify(mainAgentEntry('2026-06-06T01:00:00.000Z', 11));
    const bad = '{"timestamp":"2026-06-06T01:01:00.000Z", not-json';
    writeFileSync(interceptor.LOG_FILE, [good, bad].join(SEP) + SEP);
    const res = makeRes();
    await entriesPage({ headers: {} }, res, url('/api/entries/page', {
      before: '2026-06-06T03:00:00.000Z', limit: '50',
    }));
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(bodyStr(res));
    assert.ok(data.count >= 1, '至少保留合法条目');
    assert.ok(data.entries.every((e) => e && typeof e === 'object'), '无 null 残留（已过滤）');
  });
});

// ---------------------------------------------------------------------------
// 必须放最后：resumeChoice 成功会消费 _resumeState（置 null）并切换 LOG_FILE。
// 用全部抛错的 client 覆盖 4 个广播 catch（98/103/107/111）。
describe('POST /api/resume-choice 成功广播 catch（98/103/107/111）', () => {
  function postC(body, deps) {
    const req = new EventEmitter(); req.headers = {}; req.destroy = () => {};
    const res = makeRes();
    return new Promise((resolve) => {
      res.on('finish', () => resolve(res));
      resumeChoice(req, res, url('/api/resume-choice'), true, deps);
      req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      req.emit('end');
    });
  }

  it('continue：每个 client.write 抛 → 4 个广播 catch 全被吞，仍 200', async () => {
    assert.ok(interceptor._resumeState, '前置：_resumeState 仍在（尚未被消费）');
    // recentFile 里放可流式读取的真实条目，保证 load_chunk 广播被触发（命中 107 catch）
    writeFileSync(interceptor._resumeState.recentFile,
      serialize([mainAgentEntry('2026-06-06T02:00:00.000Z', 5), mainAgentEntry('2026-06-06T02:01:00.000Z', 6)]));
    let writeAttempts = 0;
    const throwingClient = { write: () => { writeAttempts++; throw new Error('client gone'); } };
    const deps = {
      MAX_POST_BODY: 1024 * 1024,
      clients: [throwingClient],
      logWatcherOpts: (lf) => ({ logFile: lf, clients: [] }),
    };
    const res = await postC({ choice: 'continue' }, deps);
    assert.equal(res.statusCode, 200, 'client 全抛仍返回 200（catch 吞掉）');
    assert.equal(JSON.parse(bodyStr(res)).ok, true);
    // resume_resolved + load_start + load_chunk* + load_end 各尝试 write 一次以上
    assert.ok(writeAttempts >= 3, '多个广播帧 write 均被尝试并抛错（catch 覆盖）');
    assert.equal(interceptor._resumeState, null, 'resume 已解决，_resumeState 置空');
  });
});
