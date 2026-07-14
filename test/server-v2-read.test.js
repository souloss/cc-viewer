// ████ 文件内显式隔离(第六层闸) — ESM 静态 import 会被提升(hoist) ████
// LOG_DIR 在 ../findcc.js 加载时即固化。必须:node: 内置静态 import → 隔离段锁
// env → 动态 import 项目模块(与 server-logs.test.js 同款,详见该文件头注)。
// 私有端口窗 18400-18409;CCV_WIRE_V2_READ=1 必须在 interceptor 动态 import 之前
// 就位(读开关是 boot 时一次性解析,S5 startup-only 语义本身就是被测对象)。
import { describe, it, before, after } from 'node:test';
import { describeCli } from './_helpers/cli-tier.mjs';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── 隔离段:务必早于任何项目模块 import ──
const __isoDir = mkdtempSync(join(tmpdir(), 'ccv-srvv2r-'));
process.env.CCV_LOG_DIR = __isoDir;
process.env.CLAUDE_CONFIG_DIR = __isoDir;
delete process.env.CCV_INSTANCE_ID;
process.env.CCV_START_PORT = '18400';
process.env.CCV_MAX_PORT = '18409';
process.env.CCV_WORKSPACE_MODE = '1';
process.env.CCV_CLI_MODE = '0';
process.env.CCV_WIRE_V2_READ = '1'; // boot-time read switch under test

const { LOG_DIR } = await import('../findcc.js');

const SID = 'c1d2e3f4-1111-2222-3333-444455556666';
const USER_ID = JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: SID });
const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }] });

function httpRequest(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, json() { return JSON.parse(data); } }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpRequestPost(port, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, json() { return JSON.parse(data); } }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Parse the /api/local-log SSE payload into its load_chunk entries. */
function parseSseEntries(body) {
  const entries = [];
  for (const block of body.split('\n\n')) {
    const m = block.match(/^event: load_chunk\ndata: (.*)$/s);
    if (m) entries.push(...JSON.parse(m[1]));
  }
  return entries;
}

describeCli('server v2 read path (wire-v2 S5)', { concurrency: false }, () => {
  let stopViewer, port;
  const projectName = `projV2_${Date.now()}`;
  const v2Ref = `v2:${projectName}/${SID}`;

  before(async () => {
    // Build a real v2 session with the real writer BEFORE the server boots.
    const { V2Writer } = await import('../server/lib/v2/v2-writer.js');
    const w = new V2Writer({ logDir: LOG_DIR, project: projectName, enabled: true, minFreeBytes: 0 });
    const wires = [
      [textMsg('user', 'turn 1')],
      [textMsg('user', 'turn 1'), textMsg('assistant', 'r1'), textMsg('user', 'turn 2')],
    ];
    wires.forEach((messages, i) => {
      const entry = {
        timestamp: `2026-07-13T05:00:0${i}.000Z`,
        project: projectName,
        url: 'https://api.anthropic.com/v1/messages?beta=true',
        method: 'POST',
        headers: {},
        body: { model: 'claude-fable-5', system: 'You are Claude Code test system.', tools: [{ name: 'Bash' }], metadata: { user_id: USER_ID }, messages },
        response: null, duration: 0, isStream: false, isHeartbeat: false, isCountTokens: false,
        mainAgent: true, requestId: `rid_${i}`,
      };
      const h = w.ingestRequest(entry, entry.body.messages);
      w.ingestCompletion(h, { ...entry, response: { status: 200, headers: {}, body: { content: [], usage: {} } }, duration: 9 });
    });
    await w.flush();

    const mod = await import('../server/server.js');
    stopViewer = mod.stopViewer;
    await mod.startViewer();
    port = mod.getPort();
  });

  after(() => {
    stopViewer();
    rmSync(join(LOG_DIR, projectName), { recursive: true, force: true });
  });

  it('GET /api/wire-v2-mode reports the read path as running (env source)', async () => {
    const res = await httpRequest(port, '/api/wire-v2-mode');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.readRunning, true);
    assert.equal(data.readEnvOverride, true);
    assert.ok(data.unlocked.includes('dual-read'));
  });

  it('GET /api/local-log?file=v2:… streams adapted v1-shape entries over SSE', async () => {
    const res = await httpRequest(port, `/api/local-log?file=${encodeURIComponent(v2Ref)}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('event: load_start'));
    assert.ok(res.body.includes('event: load_end'));
    const entries = parseSseEntries(res.body);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]._isCheckpoint, true);
    assert.deepEqual(entries[0].body.messages, [textMsg('user', 'turn 1')]);
    assert.equal(entries[1]._isCheckpoint, false);
    assert.equal(entries[1]._totalMessageCount, 3);
    assert.deepEqual(entries[1].body.tools, [{ name: 'Bash' }], 'per-request blob backfill over HTTP');
    assert.equal(entries[1].response.status, 200);
  });

  it('GET /api/entries/page pages a v2 session', async () => {
    const res = await httpRequest(port, `/api/entries/page?file=${encodeURIComponent(v2Ref)}&before=2026-07-13T05:00:01.000Z&limit=5`);
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.entries.length, 1, 'only the entry older than `before`');
    assert.equal(data.entries[0]._isCheckpoint, true);
  });

  it('GET /api/local-logs?v2=1 lists the session as an openable v2 item', async () => {
    const res = await httpRequest(port, '/api/local-logs?v2=1&all=1');
    assert.equal(res.status, 200);
    const data = res.json();
    assert.ok(Array.isArray(data[projectName]), 'project group present');
    const item = data[projectName].find((it) => it.file === v2Ref);
    assert.ok(item, 'session listed under its v2: address');
    assert.equal(item.kind, 'v2');
    assert.equal(item.turns, 2);
    assert.match(item.timestamp, /^\d{8}_\d{6}$/);
    assert.match(item.preview[0], /^turn 1/);
  });

  it('GET /api/download-log streams the rebuilt v1-shape jsonl for a v2 ref; raw is 400', async () => {
    const res = await httpRequest(port, `/api/download-log?file=${encodeURIComponent(v2Ref)}`);
    assert.equal(res.status, 200);
    const frames = res.body.split('\n---\n').filter((s) => s.trim());
    assert.equal(frames.length, 2);
    assert.equal(JSON.parse(frames[0])._isCheckpoint, true);
    const raw = await httpRequest(port, `/api/download-log?file=${encodeURIComponent(v2Ref)}&format=raw`);
    assert.equal(raw.status, 400, 'raw zip export lands in S6a');
  });

  it('reader version gate over HTTP: an unsupported-wireFormat session is unlisted and streams empty (spec §14)', async () => {
    // Build a second real session, then stamp a future version into BOTH
    // meta.json and the journal sentinel — the server reads disk per request,
    // so creating it after boot is fine.
    const sid3 = 'c1d2e3f4-9999-8888-7777-666655554444';
    const userId3 = JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: sid3 });
    const { V2Writer } = await import('../server/lib/v2/v2-writer.js');
    const w = new V2Writer({ logDir: LOG_DIR, project: projectName, enabled: true, minFreeBytes: 0 });
    const entry = {
      timestamp: '2026-07-13T06:00:00.000Z', project: projectName,
      url: 'https://api.anthropic.com/v1/messages?beta=true', method: 'POST', headers: {},
      body: { model: 'claude-fable-5', metadata: { user_id: userId3 }, messages: [textMsg('user', 'future format')] },
      response: null, duration: 0, isStream: false, isHeartbeat: false, isCountTokens: false,
      mainAgent: true, requestId: 'rid_gate',
    };
    const h = w.ingestRequest(entry, entry.body.messages);
    w.ingestCompletion(h, { ...entry, response: { status: 200, headers: {}, body: { content: [], usage: {} } }, duration: 1 });
    await w.flush();

    const { readFileSync, writeFileSync } = await import('node:fs');
    const sdir = join(LOG_DIR, projectName, 'sessions', sid3);
    const meta = JSON.parse(readFileSync(join(sdir, 'meta.json'), 'utf-8'));
    writeFileSync(join(sdir, 'meta.json'), JSON.stringify({ ...meta, wireFormat: 3 }));
    const jPath = join(sdir, 'journal.jsonl');
    const lines = readFileSync(jPath, 'utf-8').split('\n');
    lines[0] = JSON.stringify({ ph: 'meta', wireFormat: 3, sessionId: sid3 });
    writeFileSync(jPath, lines.join('\n'));

    const list = await httpRequest(port, '/api/local-logs?v2=1&all=1');
    assert.equal(list.status, 200);
    const items = list.json()[projectName] || [];
    assert.ok(!items.find((it) => it.file === `v2:${projectName}/${sid3}`), 'unsupported session must not be listed');
    assert.ok(items.find((it) => it.file === v2Ref), 'supported sibling still listed');

    const stream = await httpRequest(port, `/api/local-log?file=${encodeURIComponent(`v2:${projectName}/${sid3}`)}`);
    assert.equal(stream.status, 200, 'stream opens (dir exists) …');
    assert.deepEqual(parseSseEntries(stream.body), [], '… but yields ZERO entries — never partial garbage');

    rmSync(sdir, { recursive: true, force: true });
  });

  it('rejects traversal-shaped and unknown v2 refs', async () => {
    assert.equal((await httpRequest(port, '/api/local-log?file=v2:proj/..')).status, 400, '`..` is caught by the generic guard');
    assert.equal((await httpRequest(port, '/api/local-log?file=v2:pro%26j/sid')).status, 403, 'whitelist-rejected component');
    assert.equal((await httpRequest(port, `/api/local-log?file=v2:${projectName}/deadbeef`)).status, 404, 'unknown session');
  });

  // wire-v2 S8: migration-task endpoints (the task itself is unit-tested in
  // test/v2-convert.test.js — here only the HTTP contract).
  it('GET /api/wire-v2-convert reports an idle task; POST validates its action', async () => {
    const res = await httpRequest(port, '/api/wire-v2-convert');
    assert.equal(res.status, 200);
    assert.equal(res.json().running, false);

    const bad = await httpRequestPost(port, '/api/wire-v2-convert', { action: 'frobnicate' });
    assert.equal(bad.status, 400);
    assert.match(bad.json().error, /action must be/);

    const stop = await httpRequestPost(port, '/api/wire-v2-convert', { action: 'stop' });
    assert.equal(stop.status, 409, 'stop with nothing running is a clean conflict');
  });
});
