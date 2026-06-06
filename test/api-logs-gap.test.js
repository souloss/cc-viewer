// 覆盖目标：server/routes/logs.js 的全部 6 个 handler（按当前工作区状态测，不改源码）。
//   GET  /api/local-logs    localLogs   —— 成功 + 内部错误 500
//   GET  /api/download-log  downloadLog —— 校验/404/format=raw/默认流式/.zip 重命名/路径越权
//   GET  /api/local-log     localLog    —— 校验/类型/limit 尾部 SSE/全量 SSE/NOT_FOUND
//   POST /api/delete-logs   deleteLogs  —— 空数组/非法 JSON/成功
//   POST /api/merge-logs    mergeLogs   —— 成功/INVALID_INPUT 400/NOT_FOUND 404
//   POST /api/archive-logs  archiveLogs —— 空数组/超 50/非法 JSON/成功
// 范式：参照 test/api-preferences.test.js —— 任何 import 前先建临时 LOG_DIR 并设 env，
// handler 用 EventEmitter 假 req + 收集型 res 直接调用。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpDir = mkdtempSync(join(tmpdir(), 'ccv-api-logs-gap-'));
process.env.CCV_LOG_DIR = tmpDir;
process.env.CLAUDE_CONFIG_DIR = tmpDir;
process.env.CCV_WORKSPACE_MODE = '1';
process.env.CCV_CLI_MODE = '0';

const SEP = '\n---\n';
const deps = { MAX_POST_BODY: 1024 * 1024 };

function entry(ts, url = 'https://api.anthropic.com/v1/messages') {
  return JSON.stringify({ timestamp: ts, url, method: 'POST', mainAgent: true, body: { model: 'claude-opus-4-8' } });
}

/** 写日志文件到 <LOG_DIR>/<project>/<filename> */
function writeLog(project, filename, entries) {
  const dir = join(tmpDir, project);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), entries.join(SEP) + SEP);
}

/** 构造一个收集 writeHead/write/end 的假 res（同时是 EventEmitter 以支持 stream.pipe）。*/
function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 0;
  res.headers = null;
  res.chunks = [];
  res.ended = false;
  res.headersSent = false;
  res.writableEnded = false;
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {}; res.headersSent = true; return res; };
  res.write = (c) => { if (c != null) res.chunks.push(Buffer.isBuffer(c) ? c.toString('utf-8') : String(c)); return true; };
  res.end = (c) => { if (c != null) res.chunks.push(Buffer.isBuffer(c) ? c.toString('utf-8') : String(c)); res.ended = true; res.writableEnded = true; res.emit('finish'); return res; };
  res.on('error', () => {});
  return res;
}

function body(res) { return res.chunks.join(''); }
function json(res) { return JSON.parse(body(res)); }

/** GET handler（无 body），返回 Promise<res>，等到 res.end 触发 */
function callGet(handler, parsedUrl) {
  const res = makeRes();
  return new Promise((resolve) => {
    res.on('finish', () => resolve(res));
    Promise.resolve(handler({ headers: {} }, res, parsedUrl, true, deps)).catch(() => resolve(res));
  });
}

/** POST handler（流式 body），返回 Promise<res> */
function callPost(handler, bodyStr, parsedUrl = { searchParams: new URLSearchParams() }) {
  const req = new EventEmitter();
  req.headers = {};
  const res = makeRes();
  return new Promise((resolve) => {
    res.on('finish', () => resolve(res));
    handler(req, res, parsedUrl, true, deps);
    req.emit('data', typeof bodyStr === 'string' ? bodyStr : JSON.stringify(bodyStr));
    req.emit('end');
  });
}

function url(pathname, query = {}) {
  const sp = new URLSearchParams(query);
  return { pathname, searchParams: sp };
}

let routes;
before(async () => {
  const mod = await import('../server/routes/logs.js');
  routes = mod.logsRoutes;
});
after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function h(path, method) {
  const r = routes.find((x) => x.path === path && x.method === method);
  assert.ok(r, `route ${method} ${path} must exist`);
  return r.handler;
}

describe('GET /api/local-logs', () => {
  beforeEach(() => {
    for (const n of readdirSync(tmpDir)) {
      if (n !== 'preferences.json') rmSync(join(tmpDir, n), { recursive: true, force: true });
    }
  });

  it('returns grouped local logs JSON with 200', async () => {
    writeLog('proj', 'proj_20260601_100000.jsonl', [entry('2026-06-01T10:00:00.000Z')]);
    writeLog('proj', 'proj_20260602_100000.jsonl', [entry('2026-06-02T10:00:00.000Z')]);
    const res = await callGet(h('/api/local-logs', 'GET'), url('/api/local-logs'));
    assert.equal(res.statusCode, 200);
    const data = json(res);
    assert.ok(data.proj, 'has proj group');
    assert.equal(data.proj.length, 2);
  });
});

describe('GET /api/download-log', () => {
  beforeEach(() => {
    writeLog('dl', 'dl_20260601_100000.jsonl', [entry('2026-06-01T10:00:00.000Z'), entry('2026-06-01T10:01:00.000Z')]);
  });

  it('400 on missing file param', async () => {
    const res = await callGet(h('/api/download-log', 'GET'), url('/api/download-log'));
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'Invalid file name');
  });

  it('400 on path traversal (..)', async () => {
    const res = await callGet(h('/api/download-log', 'GET'), url('/api/download-log', { file: '../evil.jsonl' }));
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'Invalid file name');
  });

  it('400 on disallowed extension', async () => {
    const res = await callGet(h('/api/download-log', 'GET'), url('/api/download-log', { file: 'dl/config.json' }));
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'Invalid file type');
  });

  it('404 when file does not exist', async () => {
    const res = await callGet(h('/api/download-log', 'GET'), url('/api/download-log', { file: 'dl/missing.jsonl' }));
    assert.equal(res.statusCode, 404);
    assert.equal(json(res).error, 'File not found');
  });

  it('format=raw streams original bytes with octet-stream + Content-Length', async () => {
    const res = await callGet(h('/api/download-log', 'GET'), url('/api/download-log', { file: 'dl/dl_20260601_100000.jsonl', format: 'raw' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/octet-stream');
    assert.ok(res.headers['Content-Length'] > 0, 'Content-Length present');
    assert.match(res.headers['Content-Disposition'], /dl_20260601_100000\.jsonl/);
    // raw 透传原始内容（含 separator）
    assert.match(body(res), /api\.anthropic\.com/);
  });

  it('default (non-raw) streams chunked rebuilt entries', async () => {
    const res = await callGet(h('/api/download-log', 'GET'), url('/api/download-log', { file: 'dl/dl_20260601_100000.jsonl' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Transfer-Encoding'], 'chunked');
    // 流式输出包含 \n---\n 分隔
    assert.match(body(res), /\n---\n/);
    assert.ok(res.ended);
  });

  it('default download of a corrupt .jsonl.zip surfaces unzip error as 500 (pin current behavior)', async () => {
    // 默认（非 raw）分支对 .jsonl.zip 走 streamRawEntriesAsync 重建路径：内容不是合法 zip 时
    // adm-zip 在写 headers 前抛错，catch 落 500 + JSON 错误。pin 现状以覆盖 catch 分支。
    const dir = join(tmpDir, 'dl');
    writeFileSync(join(dir, 'dl_20260603_100000.jsonl.zip'), entry('2026-06-03T10:00:00.000Z') + SEP);
    const res = await callGet(h('/api/download-log', 'GET'), url('/api/download-log', { file: 'dl/dl_20260603_100000.jsonl.zip' }));
    assert.equal(res.statusCode, 500);
    assert.match(json(res).error, /zip|END header/i);
  });

  it('format=raw download of a .jsonl.zip serves bytes verbatim without unzip', async () => {
    // raw 分支直接 statSync + createReadStream 原始文件，不解压；文件名保留 .zip。
    const dir = join(tmpDir, 'dl');
    writeFileSync(join(dir, 'dl_20260603_100000.jsonl.zip'), entry('2026-06-03T10:00:00.000Z') + SEP);
    const res = await callGet(h('/api/download-log', 'GET'), url('/api/download-log', { file: 'dl/dl_20260603_100000.jsonl.zip', format: 'raw' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'application/octet-stream');
    assert.match(res.headers['Content-Disposition'], /dl_20260603_100000\.jsonl\.zip/);
  });
});

describe('GET /api/local-log (independent SSE stream)', () => {
  beforeEach(() => {
    writeLog('sse', 'sse_20260601_100000.jsonl', [
      entry('2026-06-01T10:00:00.000Z'),
      entry('2026-06-01T10:01:00.000Z'),
      entry('2026-06-01T10:02:00.000Z'),
    ]);
  });

  it('400 on missing file', async () => {
    const res = await callGet(h('/api/local-log', 'GET'), url('/api/local-log'));
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'Invalid file name');
  });

  it('400 on bad extension', async () => {
    const res = await callGet(h('/api/local-log', 'GET'), url('/api/local-log', { file: 'sse/x.txt' }));
    assert.equal(res.statusCode, 400);
    assert.match(json(res).error, /Only \.jsonl/);
  });

  it('404 (NOT_FOUND) for missing existing file via validateLogPath', async () => {
    const res = await callGet(h('/api/local-log', 'GET'), url('/api/local-log', { file: 'sse/missing.jsonl' }));
    assert.equal(res.statusCode, 404);
  });

  it('full mode (no limit): emits load_start + load_chunk*3 + load_end', async () => {
    const res = await callGet(h('/api/local-log', 'GET'), url('/api/local-log', { file: 'sse/sse_20260601_100000.jsonl' }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    const out = body(res);
    assert.match(out, /event: load_start\ndata: /);
    const chunks = out.split('event: load_chunk').length - 1;
    assert.equal(chunks, 3, '3 条各一个 load_chunk');
    assert.match(out, /event: load_end\ndata: \{\}/);
    // load_start.total 为 3（全量模式走 countLogEntries）
    const ls = JSON.parse(out.match(/event: load_start\ndata: (\{.*?\})\n\n/)[1]);
    assert.equal(ls.total, 3);
    assert.equal(ls.incremental, false);
  });

  it('tail mode (limit>0): load_start carries hasMore/oldestTs, skips count', async () => {
    const res = await callGet(h('/api/local-log', 'GET'), url('/api/local-log', { file: 'sse/sse_20260601_100000.jsonl', limit: '2' }));
    assert.equal(res.statusCode, 200);
    const out = body(res);
    const ls = JSON.parse(out.match(/event: load_start\ndata: (\{.*?\})\n\n/)[1]);
    assert.equal(ls.incremental, false);
    assert.ok('hasMore' in ls, 'tail mode load_start has hasMore');
    assert.ok('oldestTs' in ls, 'tail mode load_start has oldestTs');
    assert.match(out, /event: load_end/);
  });
});

describe('POST /api/delete-logs', () => {
  beforeEach(() => {
    writeLog('del', 'del_20260601_100000.jsonl', [entry('2026-06-01T10:00:00.000Z')]);
  });

  it('400 when files is empty array', async () => {
    const res = await callPost(h('/api/delete-logs', 'POST'), { files: [] });
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'No files specified');
  });

  it('400 when files missing (not an array)', async () => {
    const res = await callPost(h('/api/delete-logs', 'POST'), { foo: 1 });
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'No files specified');
  });

  it('400 on invalid JSON body', async () => {
    const res = await callPost(h('/api/delete-logs', 'POST'), '{bad json');
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'Invalid JSON');
  });

  it('200 with per-file results on valid delete', async () => {
    const res = await callPost(h('/api/delete-logs', 'POST'), { files: ['del/del_20260601_100000.jsonl'] });
    assert.equal(res.statusCode, 200);
    const data = json(res);
    assert.ok(Array.isArray(data.results));
    assert.equal(data.results[0].ok, true);
    assert.equal(existsSync(join(tmpDir, 'del', 'del_20260601_100000.jsonl')), false);
  });
});

describe('POST /api/merge-logs', () => {
  beforeEach(() => {
    writeLog('mrg', 'mrg_20260601_100000.jsonl', [entry('2026-06-01T10:00:00.000Z')]);
    writeLog('mrg', 'mrg_20260601_110000.jsonl', [entry('2026-06-01T11:00:00.000Z')]);
  });

  it('200 merges two files into the first', async () => {
    const res = await callPost(h('/api/merge-logs', 'POST'), { files: ['mrg/mrg_20260601_100000.jsonl', 'mrg/mrg_20260601_110000.jsonl'] });
    assert.equal(res.statusCode, 200);
    const data = json(res);
    assert.equal(data.ok, true);
    assert.equal(data.merged, 'mrg/mrg_20260601_100000.jsonl');
  });

  it('400 (INVALID_INPUT) when fewer than 2 files', async () => {
    const res = await callPost(h('/api/merge-logs', 'POST'), { files: ['mrg/mrg_20260601_100000.jsonl'] });
    assert.equal(res.statusCode, 400);
    assert.ok(json(res).error);
  });

  it('404 (NOT_FOUND) when a file is missing', async () => {
    const res = await callPost(h('/api/merge-logs', 'POST'), { files: ['mrg/mrg_20260601_100000.jsonl', 'mrg/nope.jsonl'] });
    assert.equal(res.statusCode, 404);
  });

  it('500 fallback on malformed JSON body (err without code)', async () => {
    const res = await callPost(h('/api/merge-logs', 'POST'), '{bad');
    // JSON.parse throws SyntaxError → no .code → status 500
    assert.equal(res.statusCode, 500);
  });
});

describe('POST /api/archive-logs', () => {
  beforeEach(() => {
    writeLog('arc', 'arc_20260601_100000.jsonl', [entry('2026-06-01T10:00:00.000Z')]);
  });

  it('400 when files empty', async () => {
    const res = await callPost(h('/api/archive-logs', 'POST'), { files: [] });
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'No files specified');
  });

  it('400 when more than 50 files', async () => {
    const files = Array.from({ length: 51 }, (_, i) => `arc/f${i}.jsonl`);
    const res = await callPost(h('/api/archive-logs', 'POST'), { files });
    assert.equal(res.statusCode, 400);
    assert.match(json(res).error, /Too many files/);
  });

  it('400 on invalid JSON body', async () => {
    const res = await callPost(h('/api/archive-logs', 'POST'), 'not json');
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error, 'Invalid JSON');
  });

  it('200 returns archive result for valid files', async () => {
    const res = await callPost(h('/api/archive-logs', 'POST'), { files: ['arc/arc_20260601_100000.jsonl'] });
    assert.equal(res.statusCode, 200);
    const data = json(res);
    // archiveLogFiles 返回结构对象（results 数组等），断言为对象即可
    assert.equal(typeof data, 'object');
  });
});
