/**
 * wire-v2 S3 — dual-write integration through the real fetch hook.
 *
 * Drives the interceptor exactly like test/interceptor-fetch.test.js (manual
 * setupInterceptor over a fake fetch) with CCV_WIRE_V2=1, and asserts the
 * plan's S3 automated gate:
 *   (a) the v2 session directory takes the WIRE_FORMAT_V2.md shape,
 *   (b) v1 entries on disk are byte-level unchanged in structure (placeholder +
 *       completed with delta envelope),
 *   (c) a sabotaged v2 writer cannot disturb the v1 write path.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

// ████ 数据安全死命令(2026-06-06 事故:测试五次删用户真实 ~/.claude 数据)████
// env 必须先于任何项目模块的【动态】import 锁死到进程私有临时目录；
// 严禁把 ../server/interceptor.js 改成顶层静态 import。
process.env.CCV_PROXY_MODE = '1';      // 跳过模块顶层 setupInterceptor 自执行
process.env.CCV_SYNC_WRITES = '1';     // 同步写盘，便于读取断言（v1 与 v2 队列都读此 env）
process.env.CCV_WIRE_V2 = '1';         // S3 双写开启
delete process.env.CCV_WORKSPACE_MODE;
delete process.env.CCV_IM_PLATFORM;    // IM worker 强制 v1-only，测试进程必须不是
const __isoDir = mkdtempSync(join(tmpdir(), 'ccv-v2dw-'));
process.env.CCV_LOG_DIR = __isoDir;
process.env.CLAUDE_CONFIG_DIR = __isoDir;

const SID = '11112222-3333-4444-5555-666677778888';
const USER_ID = JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: SID });

let mod;
let nextResponse;

function makeMainAgentTools() {
  return [
    { name: 'Edit' }, { name: 'Bash' }, { name: 'Task' },
    { name: 'Read' }, { name: 'Write' }, { name: 'Glob' },
    { name: 'Grep' }, { name: 'Agent' }, { name: 'WebFetch' },
    { name: 'WebSearch' }, { name: 'NotebookEdit' }, { name: 'AskUser' },
  ];
}
const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }] });
function mainAgentBody(messages, extra = {}) {
  return {
    system: [{ type: 'text', text: 'You are Claude Code, the official CLI.' }],
    tools: makeMainAgentTools(),
    metadata: { user_id: USER_ID },
    messages,
    ...extra,
  };
}

function readV1Entries() {
  if (!mod.LOG_FILE || !existsSync(mod.LOG_FILE)) return [];
  return readFileSync(mod.LOG_FILE, 'utf-8')
    .split('\n---\n')
    .filter(p => p.trim())
    .map(p => JSON.parse(p));
}

function sessionDir() {
  // project name derives from cwd basename, same sanitization as interceptor
  const project = basename(process.cwd()).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  return join(__isoDir, project, 'sessions', SID);
}

function readJsonl(path) {
  return readFileSync(path, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
}

async function fireMainAgent(messages, respBody = { content: [], usage: { input_tokens: 3, output_tokens: 2 } }) {
  nextResponse = () => new Response(JSON.stringify(respBody), { status: 200, headers: { 'content-type': 'application/json' } });
  const res = await globalThis.fetch('https://api.anthropic.com/v1/messages?beta=true', {
    method: 'POST',
    headers: { 'x-api-key': 'sk-test-key-000000' },
    body: JSON.stringify(mainAgentBody(messages)),
  });
  assert.equal(res.status, 200);
}

before(async () => {
  globalThis.fetch = async () => (nextResponse ? nextResponse() : new Response('{}', { status: 200 }));
  mod = await import('../server/interceptor.js');
  mod.setupInterceptor();
  assert.ok(mod.LOG_FILE, 'LOG_FILE auto-initialized');
  assert.ok(mod._v2Writer.enabled, 'CCV_WIRE_V2=1 must enable the v2 writer');
});

after(() => {
  setTimeout(() => process.exit(0), 30).unref();
});

describe('wire-v2 S3 dual-write', () => {
  it('(a)+(b) one mainAgent round trip: v1 entries unchanged, v2 dir takes spec shape', async () => {
    await fireMainAgent([textMsg('user', 'hello v2')]);
    await mod._v2Writer.flush();

    // v1 side: placeholder + completed, delta envelope intact (first request → checkpoint)
    const v1 = readV1Entries();
    const completed = v1.filter(e => !e.inProgress && !e.ccvRotationContext);
    assert.equal(completed.length, 1);
    assert.equal(completed[0]._isCheckpoint, true);
    assert.equal(completed[0]._deltaFormat, 1);
    assert.equal(completed[0]._seq, 1);
    assert.ok(v1.some(e => e.inProgress), 'v1 placeholder still written (no live port)');

    // v2 side: full spec shape
    const dir = sessionDir();
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
    assert.equal(meta.wireFormat, 2);
    assert.equal(meta.sessionId, SID);
    assert.equal(meta.userIdRaw, USER_ID);

    const journal = readJsonl(join(dir, 'journal.jsonl'));
    assert.equal(journal[0].ph, 'meta', 'self-describing sentinel first');
    const req = journal.find(l => l.ph === 'req');
    const done = journal.find(l => l.ph === 'done');
    assert.equal(req.seq, 1);
    assert.equal(req.kind, 'main');
    assert.equal(req.conv, 'main');
    assert.equal(req.evt, 'snapshot');
    assert.ok(req.blobs.tools && req.blobs.sys, 'tools/system extracted to blob refs');
    assert.equal(req.headers['x-api-key'] === undefined ? 'redacted-or-absent' : typeof req.headers['x-api-key'], 'string', 'headers captured');
    assert.equal(done.seq, 1);
    assert.equal(done.status, 'ok');
    assert.equal(done.usage.in, 3);

    const conv = readJsonl(join(dir, 'conversations', 'main', 'e0.jsonl'));
    assert.equal(conv.length, 1);
    assert.equal(conv[0].t, 'snapshot');
    assert.equal(conv[0].msgs[0].content[0].text, 'hello v2');

    const responses = readJsonl(join(dir, 'responses.jsonl'));
    assert.equal(responses.length, 1);
    assert.equal(responses[0].seq, 1);
    assert.deepEqual(responses[0].body.usage, { input_tokens: 3, output_tokens: 2 });

    const blobs = readdirSync(join(dir, 'blobs'));
    assert.equal(blobs.length, 2, 'tools + system blobs');
  });

  it('(a) second request extending the wire appends a delta slice and reuses blob refs', async () => {
    await fireMainAgent([
      textMsg('user', 'hello v2'),
      textMsg('assistant', 'hi there'),
      textMsg('user', 'second turn'),
    ]);
    await mod._v2Writer.flush();

    const dir = sessionDir();
    const journal = readJsonl(join(dir, 'journal.jsonl'));
    const reqs = journal.filter(l => l.ph === 'req');
    assert.equal(reqs.length, 2);
    assert.equal(reqs[1].seq, 2);
    assert.equal(reqs[1].evt, 'append');
    assert.deepEqual([reqs[1].msgFrom, reqs[1].msgTo], [1, 3]);
    assert.equal(reqs[0].blobs.tools, reqs[1].blobs.tools, 'unchanged tools → same CAS ref');

    const conv = readJsonl(join(dir, 'conversations', 'main', 'e0.jsonl'));
    assert.equal(conv.length, 2);
    assert.equal(conv[1].t, 'append');
    assert.equal(conv[1].msgs.length, 2, 'only the new tail slice is stored');

    assert.equal(readdirSync(join(dir, 'blobs')).length, 2, 'no new blobs for identical tools/system');
  });

  it('(c) a sabotaged v2 writer cannot disturb the v1 write path', async () => {
    const origIngest = mod._v2Writer.ingestRequest;
    const origCompletion = mod._v2Writer.ingestCompletion;
    mod._v2Writer.ingestRequest = () => { throw new Error('v2 exploded (request)'); };
    mod._v2Writer.ingestCompletion = () => { throw new Error('v2 exploded (completion)'); };
    try {
      const beforeCount = readV1Entries().filter(e => !e.inProgress).length;
      await fireMainAgent([
        textMsg('user', 'hello v2'),
        textMsg('assistant', 'hi there'),
        textMsg('user', 'second turn'),
        textMsg('assistant', 'sure'),
        textMsg('user', 'third turn — v2 is broken now'),
      ]);
      const v1 = readV1Entries().filter(e => !e.inProgress);
      assert.equal(v1.length, beforeCount + 1, 'v1 completed entry still written');
      const last = v1[v1.length - 1];
      assert.equal(last._deltaFormat, 1, 'v1 delta envelope unaffected');
    } finally {
      mod._v2Writer.ingestRequest = origIngest;
      mod._v2Writer.ingestCompletion = origCompletion;
    }
  });

  it('(a) journal seq allocation order matches v1 _seq order', async () => {
    await fireMainAgent([
      textMsg('user', 'hello v2'),
      textMsg('assistant', 'hi there'),
      textMsg('user', 'second turn'),
      textMsg('assistant', 'sure'),
      textMsg('user', 'third turn — v2 is broken now'),
      textMsg('assistant', 'recovered'),
      textMsg('user', 'fourth turn'),
    ]);
    await mod._v2Writer.flush();
    const v1 = readV1Entries().filter(e => !e.inProgress && e._seq != null);
    const dir = sessionDir();
    const reqs = readJsonl(join(dir, 'journal.jsonl')).filter(l => l.ph === 'req');
    const lastV1 = v1[v1.length - 1];
    const lastReq = reqs[reqs.length - 1];
    // the sabotage test consumed one v1 _seq without a v2 seq, so absolute
    // values differ — but ORDER must agree: the newest v1 entry and the newest
    // v2 req line describe the same request (same requestId linkage).
    assert.equal(lastReq.rid.length > 0, true);
    assert.equal(lastReq.msgTo, 7, 'newest v2 req describes the 7-message wire');
    assert.equal(lastV1._totalMessageCount, 7, 'newest v1 entry describes the same request');
  });
});
