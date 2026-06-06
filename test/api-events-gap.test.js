// 覆盖目标：server/routes/events.js 的 6 个 handler + sseUpdateBadgeFrame（按当前工作区状态测）。
//   sseUpdateBadgeFrame —— 纯函数帧格式
//   GET  /events            events       —— server_config / update badge / load_start/chunk/end /
//                              context_window(来自 mainAgent) / context_window fallback(读 file) /
//                              limit 参数 / 推入 clients + close 清理
//   GET  /api/requests      requests     —— 流式 JSON 数组输出
//   GET  /api/entries/page  entriesPage  —— 400 缺/非法 before、非法 file、404 validateLogPath、200 分页
//   POST /api/turn-end-notify turnEndNotify —— 403 非 local / 403 token 错 / 200 / 400 bad json / 16KB 截断
//   POST /api/register-log  registerLog  —— 400 非法路径 / 200 合法（LOG_DIR 内）
//   POST /api/resume-choice resumeChoice —— 400 非法 choice / 409 already resolved / 400 bad json
// 范式：import 前先建临时 LOG_DIR 并设 env；用 interceptor.initForWorkspace 让 LOG_FILE（live binding）
// 指向 tmp 路径，预写日志后直接调用 handler（EventEmitter 假 req + 收集型 res）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const tmpDir = mkdtempSync(join(tmpdir(), 'ccv-api-events-gap-'));
process.env.CCV_LOG_DIR = tmpDir;
process.env.CLAUDE_CONFIG_DIR = tmpDir;
process.env.CCV_WORKSPACE_MODE = '1';
process.env.CCV_CLI_MODE = '0';

const SEP = '\n---\n';

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

/** 收集型 res（亦 EventEmitter，支持 res.on('close'/'error') 兜底 + write/end 收集 SSE 帧） */
function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = null;
  res.chunks = [];
  res.ended = false;
  res.destroyed = false;
  res.writable = true;
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {}; return res; };
  res.write = (c) => { if (c != null) res.chunks.push(Buffer.isBuffer(c) ? c.toString('utf-8') : String(c)); return true; };
  res.end = (c) => { if (c != null) res.chunks.push(Buffer.isBuffer(c) ? c.toString('utf-8') : String(c)); res.ended = true; res.emit('finish'); return res; };
  res.on('error', () => {});
  return res;
}
function bodyStr(res) { return res.chunks.join(''); }

/** 解析 SSE 帧块（event/data） */
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

function url(pathname, query = {}) {
  const sp = new URLSearchParams(query);
  return { pathname, searchParams: sp };
}

let events, sseUpdateBadgeFrame, requests, entriesPage, turnEndNotify, registerLog, resumeChoice;
let interceptor;
let LOG_FILE;

before(async () => {
  interceptor = await import('../server/interceptor.js');
  interceptor.initForWorkspace(join(tmpDir, 'evproj'), { forceNew: true });
  LOG_FILE = interceptor.LOG_FILE;
  assert.ok(LOG_FILE, 'LOG_FILE set after initForWorkspace');
  mkdirSync(dirname(LOG_FILE), { recursive: true });

  const mod = await import('../server/routes/events.js');
  sseUpdateBadgeFrame = mod.sseUpdateBadgeFrame;
  const find = (p, m) => mod.eventsRoutes.find((r) => r.path === p && r.method === m).handler;
  events = find('/events', 'GET');
  requests = find('/api/requests', 'GET');
  entriesPage = find('/api/entries/page', 'GET');
  turnEndNotify = find('/api/turn-end-notify', 'POST');
  registerLog = find('/api/register-log', 'POST');
  resumeChoice = find('/api/resume-choice', 'POST');
});

after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function writeLog(entries) {
  writeFileSync(LOG_FILE, entries.map((e) => JSON.stringify(e)).join(SEP) + SEP);
}

// ---------------------------------------------------------------------------
describe('sseUpdateBadgeFrame', () => {
  it('returns a formatted SSE frame when pending is set', () => {
    const frame = sseUpdateBadgeFrame({ version: '1.7.0', source: 'npm' });
    assert.equal(frame, 'event: update_major_available\ndata: {"version":"1.7.0","source":"npm"}\n\n');
  });
  it('returns null when pending is falsy', () => {
    assert.equal(sseUpdateBadgeFrame(null), null);
    assert.equal(sseUpdateBadgeFrame(undefined), null);
  });
});

// ---------------------------------------------------------------------------
describe('GET /events', () => {
  function eventsDeps(over = {}) {
    return {
      turnEndDebounceMs: 1234,
      DEFAULT_EVENTS_LIMIT: 400,
      SSE_BACKPRESSURE_TIMEOUT_MS: 1000,
      pendingMajorUpdate: null,
      clients: [],
      ...over,
    };
  }

  it('emits server_config first, then load_start/load_chunk*/load_end and a context_window', async () => {
    writeLog([
      mainAgentEntry('2026-06-06T01:00:00.000Z', 111),
      mainAgentEntry('2026-06-06T01:01:00.000Z', 222),
    ]);
    const req = new EventEmitter();
    req.headers = {};
    const res = makeRes();
    const deps = eventsDeps();
    await events(req, res, url('/events'), true, deps);
    const out = bodyStr(res);
    const frames = parseFrames(out);
    // server_config 携带 turnEndDebounceMs
    const sc = frames.find((f) => f.event === 'server_config');
    assert.ok(sc, 'server_config emitted');
    assert.equal(JSON.parse(sc.data).turnEndDebounceMs, 1234);
    // load_start → load_chunk×2 → load_end
    assert.ok(frames.find((f) => f.event === 'load_start'));
    assert.equal(frames.filter((f) => f.event === 'load_chunk').length, 2);
    assert.ok(frames.find((f) => f.event === 'load_end'));
    // context_window 反映最后一条 mainAgent (222)
    const cw = frames.find((f) => f.event === 'context_window');
    assert.ok(cw, 'context_window emitted');
    assert.equal(JSON.parse(cw.data).total_input_tokens, 222);
    // 客户端被推入 clients 列表（load 全部完成后）
    assert.ok(deps.clients.includes(res), 'res pushed to clients after load');
  });

  it('补推 update badge frame when deps.pendingMajorUpdate is set', async () => {
    writeLog([mainAgentEntry('2026-06-06T01:00:00.000Z', 50)]);
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes();
    await events(req, res, url('/events'), true, eventsDeps({ pendingMajorUpdate: { version: '9.9.9', source: 'gh' } }));
    const frames = parseFrames(bodyStr(res));
    const badge = frames.find((f) => f.event === 'update_major_available');
    assert.ok(badge, 'update badge補推');
    assert.equal(JSON.parse(badge.data).version, '9.9.9');
  });

  it('honours an explicit ?limit and reports hasMore in load_start', async () => {
    writeLog(Array.from({ length: 5 }, (_, i) => mainAgentEntry(`2026-06-06T01:0${i}:00.000Z`, 100 + i)));
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes();
    await events(req, res, url('/events', { limit: '2' }), true, eventsDeps());
    const frames = parseFrames(bodyStr(res));
    const ls = frames.find((f) => f.event === 'load_start');
    const data = JSON.parse(ls.data);
    assert.ok('hasMore' in data, 'limit mode load_start carries hasMore');
    assert.equal(data.hasMore, true);
    assert.ok('oldestTs' in data);
  });

  it('removes res from clients on req close (cleanup)', async () => {
    writeLog([mainAgentEntry('2026-06-06T01:00:00.000Z', 10)]);
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes();
    const deps = eventsDeps();
    await events(req, res, url('/events'), true, deps);
    assert.ok(deps.clients.includes(res));
    req.emit('close');
    assert.equal(deps.clients.includes(res), false, 'res removed from clients on close');
  });

  it('falls back to context-window.json when the log has no MainAgent', async () => {
    // 只有 teammate 伪 mainAgent → 无真实 mainAgent → 走 CONTEXT_WINDOW_FILE 回落
    writeLog([mainAgentEntry('2026-06-06T01:00:00.000Z', 333, { teammate: 'bob' })]);
    const cwFile = join(tmpDir, 'context-window.json');
    writeFileSync(cwFile, JSON.stringify({
      context_window: { total_input_tokens: 1000, total_output_tokens: 200 },
    }));
    const req = new EventEmitter(); req.headers = {};
    const res = makeRes();
    await events(req, res, url('/events'), true, eventsDeps());
    const frames = parseFrames(bodyStr(res));
    const cw = frames.find((f) => f.event === 'context_window');
    assert.ok(cw, 'fallback context_window emitted from file');
    const data = JSON.parse(cw.data);
    assert.equal(data.total_input_tokens, 1000);
    assert.ok('used_percentage' in data);
    // 清理 fallback 文件，避免影响后续用例
    rmSync(cwFile, { force: true });
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/requests', () => {
  it('streams a JSON array of raw entries', async () => {
    writeLog([
      mainAgentEntry('2026-06-06T01:00:00.000Z', 1),
      mainAgentEntry('2026-06-06T01:01:00.000Z', 2),
    ]);
    const res = makeRes();
    await requests({ headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/json');
    const arr = JSON.parse(bodyStr(res));
    assert.ok(Array.isArray(arr));
    assert.equal(arr.length, 2);
    assert.equal(arr[0].response.body.usage.input_tokens, 1);
    assert.equal(arr[1].response.body.usage.input_tokens, 2);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/entries/page', () => {
  it('400 when before is missing', async () => {
    const res = makeRes();
    await entriesPage({ headers: {} }, res, url('/api/entries/page'));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(bodyStr(res)).error, /before/);
  });

  it('400 when before is not a valid date', async () => {
    const res = makeRes();
    await entriesPage({ headers: {} }, res, url('/api/entries/page', { before: 'not-a-date' }));
    assert.equal(res.statusCode, 400);
  });

  it('400 for a file param with path traversal or bad extension', async () => {
    const res = makeRes();
    await entriesPage({ headers: {} }, res, url('/api/entries/page', { before: '2026-06-06T02:00:00.000Z', file: '../evil.jsonl' }));
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(bodyStr(res)).error, 'Invalid file name');
  });

  it('404 for a file param that does not exist (validateLogPath NOT_FOUND)', async () => {
    const res = makeRes();
    await entriesPage({ headers: {} }, res, url('/api/entries/page', { before: '2026-06-06T02:00:00.000Z', file: 'evproj/missing.jsonl' }));
    assert.equal(res.statusCode, 404);
  });

  it('200 returns paged entries from the active log (default file)', async () => {
    writeLog([
      mainAgentEntry('2026-06-06T01:00:00.000Z', 1),
      mainAgentEntry('2026-06-06T01:01:00.000Z', 2),
      mainAgentEntry('2026-06-06T01:02:00.000Z', 3),
    ]);
    const res = makeRes();
    await entriesPage({ headers: {} }, res, url('/api/entries/page', { before: '2026-06-06T03:00:00.000Z', limit: '10' }));
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(bodyStr(res));
    assert.ok(Array.isArray(data.entries));
    assert.equal(typeof data.hasMore, 'boolean');
    assert.equal(typeof data.count, 'number');
    assert.ok(data.count >= 1);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/turn-end-notify', () => {
  const TOKEN = 'secret-bridge-token';
  function depsT() {
    return {
      INTERNAL_TOKEN: TOKEN,
      scheduleTurnEndBroadcast: (...args) => { depsT._calls = (depsT._calls || []); depsT._calls.push(args); },
    };
  }

  function postT({ isLocal = true, headers = {}, body = '' } = {}, deps) {
    const req = new EventEmitter();
    req.headers = headers;
    req.destroy = () => { req.destroyed = true; };
    const res = makeRes();
    return new Promise((resolve) => {
      res.on('finish', () => resolve(res));
      turnEndNotify(req, res, url('/api/turn-end-notify'), isLocal, deps);
      if (body) req.emit('data', body);
      req.emit('end');
      // 无 body 时也要 resolve（end 立即触发）
      if (!body) setImmediate(() => { if (!res.ended) resolve(res); else resolve(res); });
    });
  }

  it('403 when not loopback', async () => {
    const res = await postT({ isLocal: false }, depsT());
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(bodyStr(res)).error, /Loopback only/);
  });

  it('403 when bridge token is missing/invalid', async () => {
    const res = await postT({ headers: { 'x-ccviewer-internal': 'wrong' } }, depsT());
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(bodyStr(res)).error, /Invalid bridge token/);
  });

  it('200 and schedules a broadcast with the valid token', async () => {
    depsT._calls = [];
    const deps = depsT();
    const res = await postT({
      headers: { 'x-ccviewer-internal': TOKEN },
      body: JSON.stringify({ sessionId: 's1', ts: 999, transcriptPath: '/p' }),
    }, deps);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(bodyStr(res)), { ok: true });
    assert.equal(depsT._calls.length, 1, 'scheduleTurnEndBroadcast called once');
    assert.deepEqual(depsT._calls[0], ['s1', 999, '/p']);
  });

  it('400 on malformed JSON body (valid token)', async () => {
    const res = await postT({ headers: { 'x-ccviewer-internal': TOKEN }, body: '{bad json' }, depsT());
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(bodyStr(res)).error, /malformed JSON/);
  });

  it('destroys the request and never responds when body exceeds 16KB', async () => {
    const deps = depsT();
    const req = new EventEmitter();
    req.headers = { 'x-ccviewer-internal': TOKEN };
    let destroyed = false;
    req.destroy = () => { destroyed = true; };
    const res = makeRes();
    turnEndNotify(req, res, url('/api/turn-end-notify'), true, deps);
    req.emit('data', 'x'.repeat(16385));
    assert.equal(destroyed, true, 'req destroyed on oversize body');
    req.emit('end');
    // truncated 路径 return 前不写响应
    assert.equal(res.ended, false, 'no response written after destroy');
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/register-log', () => {
  function depsR() {
    return {
      MAX_POST_BODY: 1024 * 1024,
      logWatcherOpts: (logFile) => ({ logFile, clients: [] }),
    };
  }
  function postR(body, deps) {
    const req = new EventEmitter();
    req.headers = {};
    req.destroy = () => {};
    const res = makeRes();
    return new Promise((resolve) => {
      res.on('finish', () => resolve(res));
      registerLog(req, res, url('/api/register-log'), true, deps);
      req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      req.emit('end');
    });
  }

  it('400 when logFile is outside LOG_DIR or non-existent', async () => {
    const res = await postR({ logFile: '/etc/passwd' }, depsR());
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(bodyStr(res)).error, /Invalid log file path/);
  });

  it('400 on invalid JSON body', async () => {
    const res = await postR('{bad', depsR());
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(bodyStr(res)).error, /Invalid request body/);
  });

  it('200 registers a log inside LOG_DIR that exists', async () => {
    writeLog([mainAgentEntry('2026-06-06T01:00:00.000Z', 1)]);
    const res = await postR({ logFile: LOG_FILE }, depsR());
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(bodyStr(res)), { ok: true });
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/resume-choice', () => {
  function depsC() {
    return {
      MAX_POST_BODY: 1024 * 1024,
      clients: [],
      logWatcherOpts: (logFile) => ({ logFile, clients: [] }),
    };
  }
  function postC(body, deps) {
    const req = new EventEmitter();
    req.headers = {};
    req.destroy = () => {};
    const res = makeRes();
    return new Promise((resolve) => {
      res.on('finish', () => resolve(res));
      resumeChoice(req, res, url('/api/resume-choice'), true, deps);
      req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      req.emit('end');
    });
  }

  it('400 on an invalid choice value', async () => {
    const res = await postC({ choice: 'maybe' }, depsC());
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(bodyStr(res)).error, 'Invalid choice');
  });

  it('409 already resolved when there is no pending resume state', async () => {
    // workspace 模式下 _resumeState 恒为 null → resolveResumeChoice 返回 undefined → 409
    const res = await postC({ choice: 'continue' }, depsC());
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(bodyStr(res)).error, 'Already resolved');
  });

  it('400 on invalid JSON body', async () => {
    const res = await postC('{bad', depsC());
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(bodyStr(res)).error, 'Invalid request body');
  });
});
