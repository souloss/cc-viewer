// Deep coverage for server/routes/events.js — fills the残余臂 left by
// api-events-gap.test.js / events-kv-context-scan.test.js / events-backpressure.test.js:
//   resumeChoice 成功路径（91-114）：watchLogFile + 广播 resume_resolved / load_start /
//                                    load_chunk* / load_end 到 deps.clients
//   /events resume_prompt 帧（161-162）：_resumeState 非空时补推
//   /events ping timer 回调（146）：30s setInterval 写 ping
//   /events server_config write catch（156-157）：res.write 抛 → warn 吞掉
//   /events streamRawEntriesAsync write catch（221-222）：load_chunk 写抛 → return
//   /events backpressure await（227-228）：res.write 返回 false → awaitDrainOrClose
//   entriesPage file 参数成功（363-364）：file 通过 validateLogPath → readPagedEntries
//   entriesPage catch（380-382）：file 是目录(名为 *.jsonl) → readPagedEntries 抛 → 500
//
// 隔离范式（关键）：本文件以「非 workspace 冷启动」模式驱动 interceptor，以便 _initPromise
// 找到预置的「最近日志」并填充 _resumeState（events.js 通过 live binding 读到它）。
//   - chdir 到确定性临时工程目录 → projectName=basename 可预测
//   - CCV_PROXY_MODE=1 → 跳过 setupInterceptor() 的 http/https patch 与 server.js 自启
//     （interceptor.js:1075/1080 的两处 guard），但 _initPromise（IIFE）仍正常运行
//   - 预置 LOG_DIR/<project>/<project>_<ts>.jsonl → findRecentLog 命中 → 设 _resumeState
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

// ── 冷启动隔离：必须在 import interceptor 之前设好 env / cwd / 预置 recent log ──────
const tmpRoot = mkdtempSync(join(tmpdir(), 'ccv-events-deep-'));
const logRoot = join(tmpRoot, 'logs');
const projectCwd = join(tmpRoot, 'evdeepproj');
mkdirSync(logRoot, { recursive: true });
mkdirSync(projectCwd, { recursive: true });
process.env.CCV_LOG_DIR = logRoot;
process.env.CCV_PROXY_MODE = '1';            // 跳过 http patch + server 自启
delete process.env.CCV_WORKSPACE_MODE;       // 走冷启动 resume 流程
delete process.env.CCV_CLI_MODE;
delete process.env.CCV_IM_PLATFORM;
const origCwd = process.cwd();
process.chdir(projectCwd);

const projectName = basename(projectCwd).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
const projectLogDir = join(logRoot, projectName);
mkdirSync(projectLogDir, { recursive: true });

function ts(t) {
  const d = new Date(t);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function mainAgentEntry(tstamp, inputTokens, extra = {}) {
  return {
    timestamp: tstamp,
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST', status: 200, mainAgent: true,
    body: { model: 'claude-opus-4-8', system: [{ type: 'text', text: 'You are Claude Code' }], tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: 'hi' }] },
    response: { body: { usage: { input_tokens: inputTokens, output_tokens: 10 } } },
    ...extra,
  };
}
const SEP = '\n---\n';
function serialize(entries) { return entries.map(e => JSON.stringify(e)).join(SEP) + SEP; }

// 预置一份「最近日志」（recentFile），让冷启动 _initPromise 设 _resumeState
const recentLogPath = join(projectLogDir, `${projectName}_${ts(Date.now())}.jsonl`);
writeFileSync(recentLogPath, serialize([mainAgentEntry('2026-06-06T00:00:00.000Z', 42)]));

// ── 收集型 res（亦 EventEmitter，支持可注入 write 行为） ─────────────────────────
function makeRes(opts = {}) {
  const res = new EventEmitter();
  res.statusCode = 0; res.headers = null; res.chunks = []; res.ended = false;
  res.destroyed = false; res.writable = true;
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

let interceptor, eventsMod, events, resumeChoice, entriesPage;
let LOG_FILE_TEMP;

before(async () => {
  interceptor = await import('../server/interceptor.js');
  await interceptor._initPromise;
  // 冷启动后：LOG_FILE 应指向 *_temp.jsonl，_resumeState 非空
  LOG_FILE_TEMP = interceptor.LOG_FILE;
  assert.ok(interceptor._resumeState, '_resumeState 必须由冷启动 _initPromise 设置（resume 流程前置条件）');
  // temp 文件存在并含至少一条，供 /events 流式读取
  mkdirSync(dirname(LOG_FILE_TEMP), { recursive: true });
  writeFileSync(LOG_FILE_TEMP, serialize([mainAgentEntry('2026-06-06T01:00:00.000Z', 100)]));

  eventsMod = await import('../server/routes/events.js');
  const find = (p, m) => eventsMod.eventsRoutes.find(r => r.path === p && r.method === m).handler;
  events = find('/events', 'GET');
  resumeChoice = find('/api/resume-choice', 'POST');
  entriesPage = find('/api/entries/page', 'GET');
});

after(() => {
  process.chdir(origCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function eventsDeps(over = {}) {
  return {
    turnEndDebounceMs: 1234, DEFAULT_EVENTS_LIMIT: 400, SSE_BACKPRESSURE_TIMEOUT_MS: 50,
    pendingMajorUpdate: null, clients: [], ...over,
  };
}

describe('events-deep: /events resume_prompt + server_config catch + ping', () => {
  it('emits resume_prompt frame when _resumeState is set (161-162)', async () => {
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes();
    await events(req, res, url('/events'), true, eventsDeps());
    const frames = parseFrames(bodyStr(res));
    const rp = frames.find(f => f.event === 'resume_prompt');
    assert.ok(rp, 'resume_prompt 帧必须存在（_resumeState 非空）');
    assert.ok(JSON.parse(rp.data).recentFileName, 'resume_prompt 带 recentFileName');
  });

  it('swallows a throwing server_config write and still completes (156-157)', async () => {
    const req = new EventEmitter(); req.headers = {};
    // 仅在 server_config 那次 write 抛错，其余照常
    const res = makeRes({
      onWrite(s) { if (s.startsWith('event: server_config')) throw new Error('boom'); },
    });
    await events(req, res, url('/events'), true, eventsDeps());
    // 后续帧仍写入（load_end 等），handler 不抛
    const frames = parseFrames(bodyStr(res));
    assert.ok(frames.find(f => f.event === 'load_end'), 'server_config 写失败后流程继续');
  });

  it('ping timer writes an SSE ping after 30s (146)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes();
    const deps = eventsDeps();
    await events(req, res, url('/events'), true, deps);
    res.chunks.length = 0; // 清掉加载阶段帧，只看 ping
    t.mock.timers.tick(30000);
    const frames = parseFrames(bodyStr(res));
    assert.ok(frames.find(f => f.event === 'ping'), 'ping 帧在 30s 后写出');
    // 清理：移除 client + 停掉 interval（close 会 clearInterval）
    req.emit('close');
  });
});

describe('events-deep: /events streaming write catch + backpressure', () => {
  it('returns from the stream callback when a load_chunk write throws (221-222)', async () => {
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes({
      onWrite(s) { if (s.startsWith('event: load_chunk')) throw new Error('pipe gone'); },
    });
    // handler 不应抛；load_chunk 写抛被 catch → return（该条跳过）
    await events(req, res, url('/events'), true, eventsDeps());
    assert.ok(true, 'events 在 load_chunk 写抛时不抛穿');
  });

  it('awaits drain when a data write returns false (227-228)', async () => {
    const req = new EventEmitter(); req.headers = {};
    // data 行（load_chunk 的第二次 write，即 raw 内容）返回 false → !drained → awaitDrainOrClose
    let dataWrites = 0;
    const res = makeRes({
      onWrite(s) {
        // load_chunk 的内容行不以 'event:' 开头（是 raw JSON 串）
        if (!s.startsWith('event: ') && !s.startsWith('data: ') && s.includes('"mainAgent"')) {
          dataWrites++;
          return false; // 触发 backpressure
        }
      },
    });
    await events(req, res, url('/events'), true, eventsDeps({ SSE_BACKPRESSURE_TIMEOUT_MS: 30 }));
    assert.ok(dataWrites >= 1, 'data 写至少一次返回 false 触发 backpressure 路径');
  });
});

describe('events-deep: /api/entries/page file 参数成功 + catch', () => {
  it('200 reads paged entries from a valid file= under LOG_DIR (363-364)', async () => {
    const seeded = `${projectName}_seed.jsonl`;
    writeFileSync(join(projectLogDir, seeded), serialize([
      mainAgentEntry('2026-06-06T01:00:00.000Z', 1),
      mainAgentEntry('2026-06-06T01:01:00.000Z', 2),
    ]));
    const res = makeRes();
    await entriesPage({ headers: {} }, res, url('/api/entries/page', {
      before: '2026-06-06T03:00:00.000Z', limit: '10', file: `${projectName}/${seeded}`,
    }));
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(bodyStr(res));
    assert.ok(Array.isArray(data.entries));
    assert.ok(data.count >= 1, 'file= 指定的日志被分页读取');
  });

  it('500 when readPagedEntries throws (file= resolves to a directory named *.jsonl) (380-382)', async () => {
    // 目录名以 .jsonl 结尾 → 通过 events.js 的扩展名校验 + validateLogPath（existsSync 真）→
    // readPagedEntries 把它当文件读 → iterateRawEntriesAsync 抛 → 500 catch。
    const dirAsFile = join(projectLogDir, 'isdir.jsonl');
    mkdirSync(dirAsFile, { recursive: true });
    const res = makeRes();
    await entriesPage({ headers: {} }, res, url('/api/entries/page', {
      before: '2026-06-06T03:00:00.000Z', file: `${projectName}/isdir.jsonl`,
    }));
    assert.equal(res.statusCode, 500);
    assert.ok(JSON.parse(bodyStr(res)).error);
  });
});

// 放最后：resumeChoice 成功会消费 _resumeState（置 null）并切换 LOG_FILE，
// 故必须在依赖 _resumeState 的 /events 用例之后执行。
describe('events-deep: /api/resume-choice 成功路径 (91-114)', () => {
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

  it('200 continue: resolveResumeChoice 真 → watchLogFile + 广播 resume_resolved/load_*/load_end', async () => {
    assert.ok(interceptor._resumeState, '前置：_resumeState 仍在（尚未被消费）');
    // continue 会把 temp 内容 append 到 recentFile 并把 LOG_FILE 切回 recentFile；
    // 之后 countLogEntries/streamRawEntriesAsync 读 recentFile（含我们预置的条目）。
    const clientFrames = [];
    const fakeClient = { write: (s) => clientFrames.push(s) };
    const deps = {
      MAX_POST_BODY: 1024 * 1024,
      clients: [fakeClient],
      logWatcherOpts: (logFile) => ({ logFile, clients: [] }),
    };
    const res = await postC({ choice: 'continue' }, deps);
    assert.equal(res.statusCode, 200);
    const out = JSON.parse(bodyStr(res));
    assert.equal(out.ok, true);
    assert.ok(out.logFile, '返回 logFile');
    const joined = clientFrames.join('');
    assert.match(joined, /event: resume_resolved/, '广播 resume_resolved');
    assert.match(joined, /event: load_start/, '广播 load_start');
    assert.match(joined, /event: load_end/, '广播 load_end');
    // 消费后 _resumeState 归 null
    assert.equal(interceptor._resumeState, null, 'resume 已解决，_resumeState 置空');
  });
});
