/**
 * wire-v2 S4 — verifier end-to-end + replay units.
 *
 * The end-to-end suite drives REAL dual-write through the interceptor's fetch
 * hook (same harness as interceptor-v2-dualwrite.test.js), then runs the
 * verifier over the produced v1 file + v2 session dirs:
 *   clean run → zero diffs; tampered v2 conv file → reported diff;
 *   this pins the verifier's power to actually catch divergence (a verifier
 *   that never fails would make the 5-day soak gate meaningless).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// ████ 数据安全死命令：env 先于动态 import 锁死到临时目录；禁止顶层静态 import 项目模块 ████
process.env.CCV_PROXY_MODE = '1';
process.env.CCV_SYNC_WRITES = '1';
process.env.CCV_WIRE_V2 = '1';
delete process.env.CCV_WORKSPACE_MODE;
delete process.env.CCV_IM_PLATFORM;
const __isoDir = mkdtempSync(join(tmpdir(), 'ccv-v2vfy-'));
process.env.CCV_LOG_DIR = __isoDir;
process.env.CLAUDE_CONFIG_DIR = __isoDir;

const SID = 'aaaa1111-2222-3333-4444-bbbb5555cccc';
const USER_ID = JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: SID });
const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }] });

let mod, verify, replay;
let nextResponse;

function mainAgentBody(messages) {
  return {
    system: [{ type: 'text', text: 'You are Claude Code, the official CLI.' }],
    tools: [
      { name: 'Edit' }, { name: 'Bash' }, { name: 'Task' }, { name: 'Read' },
      { name: 'Write' }, { name: 'Glob' }, { name: 'Grep' }, { name: 'Agent' },
      { name: 'WebFetch' }, { name: 'WebSearch' }, { name: 'NotebookEdit' }, { name: 'AskUser' },
    ],
    metadata: { user_id: USER_ID },
    messages,
  };
}

async function fireMainAgent(messages) {
  nextResponse = () => new Response(JSON.stringify({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  const res = await globalThis.fetch('https://api.anthropic.com/v1/messages?beta=true', {
    method: 'POST',
    body: JSON.stringify(mainAgentBody(messages)),
  });
  assert.equal(res.status, 200);
}

before(async () => {
  globalThis.fetch = async () => (nextResponse ? nextResponse() : new Response('{}', { status: 200 }));
  mod = await import('../server/interceptor.js');
  mod.setupInterceptor();
  verify = await import('../server/lib/v2/verify.js');
  replay = await import('../server/lib/v2/replay.js');
});

after(() => { setTimeout(() => process.exit(0), 30).unref(); });

describe('replay units', () => {
  it('mechanical replay: snapshot / append / replace-tail', () => {
    const events = [
      { seq: 1, t: 'snapshot', msgs: [textMsg('user', 'a')] },
      { seq: 2, t: 'append', msgs: [textMsg('assistant', 'b'), textMsg('user', 'c')] },
      { seq: 3, t: 'ctl', op: 'replace-tail', msg: textMsg('user', 'C2') },
      { seq: 4, t: 'snapshot', msgs: [textMsg('user', 'fresh')] },
    ];
    const bySeq = replay.replayConversation(events);
    assert.equal(bySeq.get(1).len, 1);
    assert.equal(bySeq.get(2).len, 3);
    assert.equal(bySeq.get(3).len, 3);
    assert.notEqual(bySeq.get(2).digest, bySeq.get(3).digest, 'replace-tail changes the digest');
    assert.equal(bySeq.get(3).digest, replay.messagesDigest([textMsg('user', 'a'), textMsg('assistant', 'b'), textMsg('user', 'C2')]));
    assert.equal(bySeq.get(4).len, 1);
  });

  it('readJsonlTolerant drops a truncated tail line', () => {
    const p = join(__isoDir, 'trunc.jsonl');
    writeFileSync(p, '{"a":1}\n{"b":2}\n{"trunca', 'utf-8');
    assert.deepEqual(replay.readJsonlTolerant(p), [{ a: 1 }, { b: 2 }]);
  });

  it('blobRefOf matches the BlobStore CAS formula', async () => {
    const { BlobStore } = await import('../server/lib/v2/blob-store.js');
    const { ensureSessionDirSync } = await import('../server/lib/v2/layout.js');
    const paths = ensureSessionDirSync(mkdtempSync(join(tmpdir(), 'ccv-ref-')), 'p', SID);
    const store = new BlobStore(paths);
    const val = [{ name: 'Bash', x: 1 }];
    assert.equal(replay.blobRefOf(val), store.put(val));
    assert.equal(replay.blobRefOf(null), null);
  });
});

describe('verifier end-to-end over real dual-write', () => {
  it('clean dual-write verifies with zero diffs', async () => {
    await fireMainAgent([textMsg('user', 'turn 1')]);
    await fireMainAgent([textMsg('user', 'turn 1'), textMsg('assistant', 'r1'), textMsg('user', 'turn 2')]);
    // in-place tail replace (same length, different tail) → ctl path
    await fireMainAgent([textMsg('user', 'turn 1'), textMsg('assistant', 'r1'), textMsg('user', 'turn 2 EDITED')]);
    await mod._v2Writer.flush();

    const report = await verify.verifyV1File(mod.LOG_FILE);
    assert.equal(report.ok, true, JSON.stringify(report.diffs, null, 2));
    assert.equal(report.counters.matched, 3);
    assert.equal(report.counters.v1Only, 0);
    assert.equal(report.integrity.length, 0);
    assert.ok(report.v2Sessions.includes(SID));
  });

  it('a v1-only entry (v2 disabled window) is counted, not failed', async () => {
    mod._v2Writer.setEnabled(false);
    await fireMainAgent([
      textMsg('user', 'turn 1'), textMsg('assistant', 'r1'),
      textMsg('user', 'turn 2 EDITED'), textMsg('assistant', 'r2'), textMsg('user', 'turn 3'),
    ]);
    mod._v2Writer.setEnabled(true);
    const report = await verify.verifyV1File(mod.LOG_FILE);
    assert.equal(report.ok, true);
    assert.equal(report.counters.v1Only, 1, 'the v2-off request has no twin');
  });

  it('tampered v2 conversation file → digest diff reported (verifier has teeth)', async () => {
    const project = basename(process.cwd()).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const convFile = join(__isoDir, project, 'sessions', SID, 'conversations', 'main', 'e0.jsonl');
    const original = readFileSync(convFile, 'utf-8');
    try {
      // Corrupt the last stored event's content: swap the tail message text.
      appendFileSync(convFile, JSON.stringify({ seq: 3, rid: 'tamper', t: 'ctl', op: 'replace-tail', msg: textMsg('user', 'TAMPERED') }) + '\n');
      const report = await verify.verifyV1File(mod.LOG_FILE);
      assert.equal(report.ok, false, 'tampering must be detected');
      assert.ok(report.diffs.some(d => d.type === 'messages-digest'), 'digest diff reported');
    } finally {
      writeFileSync(convFile, original, 'utf-8');
    }
    const clean = await verify.verifyV1File(mod.LOG_FILE);
    assert.equal(clean.ok, true, 'restored state verifies clean again');
  });

  it('tampered blob ref → tools-ref diff reported', async () => {
    const project = basename(process.cwd()).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const journalFile = join(__isoDir, project, 'sessions', SID, 'journal.jsonl');
    const original = readFileSync(journalFile, 'utf-8');
    try {
      const lines = original.trim().split('\n');
      const idx = lines.findIndex(l => l.includes('"ph":"req"'));
      const req = JSON.parse(lines[idx]);
      req.blobs.tools = 'sha256-0000000000000000';
      lines[idx] = JSON.stringify(req);
      writeFileSync(journalFile, lines.join('\n') + '\n', 'utf-8');
      const report = await verify.verifyV1File(mod.LOG_FILE);
      assert.equal(report.ok, false);
      assert.ok(report.diffs.some(d => d.type === 'tools-ref'));
    } finally {
      writeFileSync(journalFile, original, 'utf-8');
    }
  });
});
