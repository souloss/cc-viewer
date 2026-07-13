/**
 * Wire Format v2 core library unit tests (S2 — server/lib/v2/*).
 * Spec: docs/refactor/WIRE_FORMAT_V2.md; plan: docs/refactor/WIRE_FORMAT_V2_PLAN.md.
 *
 * Pure unit tier: everything runs against mkdtemp dirs, no interceptor, no
 * server. Coverage mandated by the plan's S2 row: dual-encoding user_id,
 * path-injection rejection, /clear→epoch, /compact→continuation, same-prompt
 * parallel subAgents (tool_use.id), no-metadata fallback, write-order/atomic
 * files, failure isolation, disk guard.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sanitizePathComponent, sessionPaths, ensureSessionDirSync, convEpochPath, writeFileAtomicSync } from '../server/lib/v2/layout.js';
import { parseUserId, ConvResolver, classifyKind, firstUserPromptText } from '../server/lib/v2/identity.js';
import { BlobStore } from '../server/lib/v2/blob-store.js';
import { ConversationStore } from '../server/lib/v2/conversation-store.js';
import { Journal } from '../server/lib/v2/journal.js';
import { V2Writer } from '../server/lib/v2/v2-writer.js';
import { AsyncWriteQueue } from '../server/lib/async-write-queue.js';
import { _resetForTest } from '../server/lib/error-report.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccv-v2-')); _resetForTest(); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const SID = 'a9883ab8-0ab7-459a-bcfd-4c8950a14384';
const jsonUserId = JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: SID });
const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }] });
const clearMsg = () => textMsg('user', '<command-name>/clear</command-name>');

function readLines(path) {
  return readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

// ─── identity: dual-encoding user_id (spec §8) ──────────────────────────────
describe('parseUserId dual encoding', () => {
  it('parses the modern JSON encoding', () => {
    assert.deepEqual(parseUserId(jsonUserId), { sessionId: SID, encoding: 'json' });
  });

  it('parses the legacy underscore-delimited encoding', () => {
    const legacy = `user_deadbeef123_account__session_${SID}`;
    assert.deepEqual(parseUserId(legacy), { sessionId: SID, encoding: 'delimited' });
    const withAcct = `user_x_account_9f-uuid_session_${SID}`;
    assert.deepEqual(parseUserId(withAcct), { sessionId: SID, encoding: 'delimited' });
  });

  it('returns null for garbage, JSON without session_id, and non-UUID tails', () => {
    assert.equal(parseUserId(undefined), null);
    assert.equal(parseUserId(''), null);
    assert.equal(parseUserId('{"device_id":"d"}'), null);
    assert.equal(parseUserId('user_x_session_notauuid'), null);
    assert.equal(parseUserId('plain string'), null);
  });
});

// ─── layout: path-injection rejection + atomic files (spec §2/§3) ───────────
describe('layout sanitization and atomic creation', () => {
  it('rejects path-traversal in every derived component', () => {
    assert.equal(sanitizePathComponent('../../etc/passwd'), '.._.._etc_passwd');
    assert.equal(sanitizePathComponent('..'), '_');
    assert.equal(sanitizePathComponent(''), '_');
    assert.equal(sanitizePathComponent('sub-abc123DEF_-.'), 'sub-abc123DEF_-.');
    const p = sessionPaths(dir, '../evil', 'sid/../../up');
    assert.ok(p.dir.startsWith(join(dir, '.._evil')), p.dir);
    assert.ok(!p.dir.includes('/../'), 'no traversal survives');
  });

  it('creates skeleton + meta + journal sentinel idempotently', () => {
    const p1 = ensureSessionDirSync(dir, 'proj', SID, { instanceId: '42', userIdRaw: jsonUserId, userIdEncoding: 'json' });
    const p2 = ensureSessionDirSync(dir, 'proj', SID, { instanceId: 'SHOULD-NOT-OVERWRITE' });
    assert.equal(p1.metaPath, p2.metaPath);
    const meta = JSON.parse(readFileSync(p1.metaPath, 'utf8'));
    assert.equal(meta.wireFormat, 2);
    assert.equal(meta.sessionId, SID);
    assert.equal(meta.instanceId, '42', 'second ensure must not rewrite meta');
    const sentinel = readLines(p1.journalPath);
    assert.equal(sentinel.length, 1);
    assert.deepEqual(sentinel[0], { ph: 'meta', wireFormat: 2, sessionId: SID });
    assert.ok(existsSync(p1.conversationsDir) && existsSync(p1.blobsDir));
  });

  it('writeFileAtomicSync leaves no tmp residue', () => {
    const target = join(dir, 'x.json');
    writeFileAtomicSync(target, '{"a":1}');
    assert.equal(readFileSync(target, 'utf8'), '{"a":1}');
    assert.deepEqual(readdirSync(dir).filter(f => f.includes('.tmp-')), []);
  });
});

// ─── blob store: CAS + idempotence (spec §7) ────────────────────────────────
describe('BlobStore', () => {
  it('same content → same ref, one file; different content → different refs', () => {
    const paths = ensureSessionDirSync(dir, 'proj', SID);
    const store = new BlobStore(paths);
    const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
    const r1 = store.put(tools);
    const r2 = store.put(JSON.parse(JSON.stringify(tools)));
    assert.equal(r1, r2);
    assert.match(r1, /^sha256-[0-9a-f]{16}$/);
    const r3 = store.put([{ name: 'Other' }]);
    assert.notEqual(r1, r3);
    assert.equal(readdirSync(paths.blobsDir).length, 2);
    assert.equal(store.put(undefined), null);
    assert.deepEqual(JSON.parse(readFileSync(join(paths.blobsDir, `${r1}.json`), 'utf8')), tools);
  });
});

// ─── conversation store: event predicate matrix (spec §6/§9) ────────────────
describe('ConversationStore event judgement', () => {
  let paths, queue, store;
  beforeEach(() => {
    paths = ensureSessionDirSync(dir, 'proj', SID);
    queue = new AsyncWriteQueue('', { syncMode: true }); // deterministic: writes land immediately
    store = new ConversationStore(paths, queue);
  });

  const ingest = (msgs, seq) => store.ingest('main', msgs, { seq, rid: `r${seq}` });

  it('first event snapshots, prefix growth appends, unchanged wire writes nothing', () => {
    const m1 = [textMsg('user', 'hello')];
    const r1 = ingest(m1, 1);
    assert.equal(r1.evt, 'snapshot');
    assert.deepEqual([r1.msgFrom, r1.msgTo], [0, 1]);

    const m2 = [...m1, textMsg('assistant', 'hi'), textMsg('user', 'go on')];
    const r2 = ingest(m2, 2);
    assert.equal(r2.evt, 'append');
    assert.deepEqual([r2.msgFrom, r2.msgTo], [1, 3]);

    const r3 = ingest(m2, 3);
    assert.equal(r3.evt, null, 'unchanged wire → no conversation event');

    const lines = readLines(convEpochPath(paths, 'main', 0));
    assert.deepEqual(lines.map(l => l.t), ['snapshot', 'append']);
    assert.deepEqual(lines[1].msgs.length, 2, 'append stores only the tail slice');
    assert.deepEqual(lines.map(l => l.seq), [1, 2], 'every line carries its initiating seq');
  });

  it('/clear opens a new epoch file (spec §3.4→epoch)', () => {
    ingest([textMsg('user', 'a'), textMsg('assistant', 'b'), textMsg('user', 'c'),
            textMsg('assistant', 'd'), textMsg('user', 'e'), textMsg('assistant', 'f')], 1);
    const post = [clearMsg(), textMsg('assistant', 'fresh')];
    const r = store.ingest('main', post, { seq: 2, rid: 'r2' });
    assert.equal(r.boundary, 'clear');
    assert.equal(r.epoch, 1);
    assert.equal(r.evt, 'snapshot');
    assert.ok(existsSync(convEpochPath(paths, 'main', 0)));
    const e1 = readLines(convEpochPath(paths, 'main', 1));
    assert.equal(e1[0].t, 'snapshot');
    assert.equal(e1[0].msgs.length, 2);
  });

  it('/compact stays in the SAME epoch with a compact ctl (spec §3.5)', () => {
    ingest([textMsg('user', 'a'), textMsg('assistant', 'b'), textMsg('user', 'c'),
            textMsg('assistant', 'd'), textMsg('user', 'e'), textMsg('assistant', 'f'),
            textMsg('user', 'g'), textMsg('assistant', 'h')], 1);
    const summary = [textMsg('user', 'This session is being continued from a previous conversation. Summary: …')];
    const r = store.ingest('main', summary, { seq: 2, rid: 'r2' });
    assert.equal(r.epoch, 0, 'compact must NOT fork the epoch');
    assert.equal(r.evt, 'snapshot');
    assert.equal(r.ctl, 'compact');
    const lines = readLines(convEpochPath(paths, 'main', 0));
    assert.deepEqual(lines.map(l => l.t), ['snapshot', 'snapshot', 'ctl']);
    assert.equal(lines[2].op, 'compact');
  });

  it('same-length tail-content change → replace-tail ctl (spec §3.3)', () => {
    const base = [textMsg('user', 'q'), textMsg('assistant', 'draft answer')];
    ingest(base, 1);
    const replaced = [base[0], textMsg('assistant', 'REAL answer')];
    const r = ingest(replaced, 2);
    assert.equal(r.ctl, 'replace-tail');
    const lines = readLines(convEpochPath(paths, 'main', 0));
    const ctl = lines[lines.length - 1];
    assert.equal(ctl.t, 'ctl');
    assert.equal(ctl.op, 'replace-tail');
    assert.equal(ctl.msg.content[0].text, 'REAL answer');
  });

  it('prefix-test failure without /clear (short window / overlap) → raw snapshot', () => {
    ingest([textMsg('user', 'a'), textMsg('assistant', 'b'), textMsg('user', 'c')], 1);
    // v1 §3.1-style short window: unrelated 2-msg sequence, shorter than prev
    const r = ingest([textMsg('user', 'plan-mode window'), textMsg('assistant', 'x')], 2);
    assert.equal(r.evt, 'snapshot');
    const lines = readLines(convEpochPath(paths, 'main', 0));
    assert.equal(lines[lines.length - 1].reason, 'shrunk');
    // tail-mismatch flavor: longer but the claimed prefix boundary doesn't match
    ingest([textMsg('user', 'X'), textMsg('assistant', 'Y'), textMsg('user', 'Z'), textMsg('user', 'W')], 3);
    const lines2 = readLines(convEpochPath(paths, 'main', 0));
    assert.equal(lines2[lines2.length - 1].reason, 'tail-mismatch');
  });

  it('two conversations never cross-contaminate state', () => {
    const a1 = store.ingest('main', [textMsg('user', 'main1')], { seq: 1, rid: 'r1' });
    const b1 = store.ingest('sub-x', [textMsg('user', 'sub1')], { seq: 2, rid: 'r2' });
    const a2 = store.ingest('main', [textMsg('user', 'main1'), textMsg('assistant', 'm2')], { seq: 3, rid: 'r3' });
    assert.equal(a1.evt, 'snapshot');
    assert.equal(b1.evt, 'snapshot');
    assert.equal(a2.evt, 'append', 'sub ingest in between must not disturb main continuity');
  });
});

// ─── identity: parallel same-prompt subagents (plan risk #7) ────────────────
describe('ConvResolver', () => {
  it('two parallel same-prompt subagents get DISTINCT keys via tool_use.id', () => {
    const r = new ConvResolver();
    r.registerSpawns({
      content: [
        { type: 'tool_use', name: 'Agent', id: 'toolu_AAAAAAAAAAAA1', input: { prompt: 'Review the diff carefully' } },
        { type: 'tool_use', name: 'Agent', id: 'toolu_BBBBBBBBBBBB2', input: { prompt: 'Review the diff carefully' } },
      ],
    });
    const k1 = r.resolveSub([textMsg('user', 'Review the diff carefully')]);
    const k2 = r.resolveSub([textMsg('user', 'Review the diff carefully')]);
    assert.notEqual(k1.convKey, k2.convKey);
    assert.ok(k1.convKey.startsWith('sub-') && !k1.convKey.startsWith('sub-fp-'), k1.convKey);
    assert.ok(k1.isNew && k2.isNew);
  });

  it('continuity: a growing sub conversation keeps its key', () => {
    const r = new ConvResolver();
    r.registerSpawns({ content: [{ type: 'tool_use', name: 'Task', id: 'toolu_CCCCCCCCCCCC3', input: { prompt: 'explore the code' } }] });
    const first = r.resolveSub([textMsg('user', 'explore the code')]);
    const second = r.resolveSub([textMsg('user', 'explore the code'), textMsg('assistant', 'found'), textMsg('user', 'more')]);
    assert.equal(second.convKey, first.convKey);
    assert.equal(second.isNew, false);
  });

  it('no registered spawn → fp fallback with ordinal split for identical prompts', () => {
    const r = new ConvResolver();
    const a = r.resolveSub([textMsg('user', 'same prompt')]);
    const b = r.resolveSub([textMsg('user', 'same prompt')]); // same len → continuity match
    assert.equal(b.convKey, a.convKey, 'same length re-send is continuity, not a new conv');
    assert.match(a.convKey, /^sub-fp-[0-9a-f]{8}$/);
  });

  it('firstUserPromptText handles string and block content', () => {
    assert.equal(firstUserPromptText([{ role: 'user', content: 'plain' }]), 'plain');
    assert.equal(firstUserPromptText([textMsg('user', 'blocky')]), 'blocky');
    assert.equal(firstUserPromptText([]), '');
  });
});

// ─── classifyKind ────────────────────────────────────────────────────────────
describe('classifyKind', () => {
  it('maps entry flags to journal kinds', () => {
    assert.equal(classifyKind({ isHeartbeat: true }), 'heartbeat');
    assert.equal(classifyKind({ isCountTokens: true }), 'countTokens');
    assert.equal(classifyKind({ teammate: 'cr-x', mainAgent: true }), 'teammate');
    assert.equal(classifyKind({ mainAgent: true }), 'main');
    assert.equal(classifyKind({ body: { messages: [] } }), 'sub');
    assert.equal(classifyKind({ body: {} }), 'misc');
  });
});

// ─── journal: two-phase lines + seq monotonicity ─────────────────────────────
describe('Journal', () => {
  it('writes req/done phases; seq allocated at initiation stays the semantic order', async () => {
    const paths = ensureSessionDirSync(dir, 'proj', SID);
    const queue = new AsyncWriteQueue('');
    const j = new Journal(paths, queue);
    const s1 = j.nextSeq();
    const s2 = j.nextSeq(); // two requests initiated in order…
    j.writeReq({ seq: s2, rid: 'b', ts: 't2', kind: 'main', url: 'u' });
    j.writeDone({ seq: s2, rid: 'b', ts: 't3', status: 'ok' });
    j.writeReq({ seq: s1, rid: 'a', ts: 't1', kind: 'main', url: 'u' }); // …completing out of order
    j.writeDone({ seq: s1, rid: 'a', ts: 't4', status: 'ok' });
    await queue.flush();
    const lines = readLines(paths.journalPath);
    assert.equal(lines[0].ph, 'meta', 'sentinel first frame survives');
    const folded = new Map();
    for (const l of lines.slice(1)) folded.set(`${l.seq}:${l.ph}`, l);
    assert.ok(folded.has('1:req') && folded.has('1:done') && folded.has('2:req') && folded.has('2:done'),
      'reader folds by seq regardless of physical order');
  });
});

// ─── V2Writer: orchestration, fallback routing, isolation, disk guard ────────
describe('V2Writer', () => {
  const mkEntry = (over = {}) => ({
    timestamp: '2026-07-13T12:00:00.000Z',
    url: 'https://api.anthropic.com/v1/messages?beta=true',
    method: 'POST',
    headers: { 'x-api-key': 'sk-12****ab' },
    requestId: over.requestId || 'req_1',
    mainAgent: true,
    body: {
      model: 'claude-fable-5',
      metadata: { user_id: jsonUserId },
      tools: [{ name: 'Bash' }],
      system: [{ type: 'text', text: 'You are Claude Code' }],
      messages: [textMsg('user', 'hello')],
    },
    ...over,
  });

  it('full request+completion round trip produces blob-deduped journal/conv/responses', async () => {
    const w = new V2Writer({ logDir: dir, project: 'proj', instanceId: '77', enabled: true });
    const e1 = mkEntry();
    const h1 = w.ingestRequest(e1, e1.body.messages);
    assert.ok(h1 && h1.seq === 1 && h1.sid === SID);
    w.ingestCompletion(h1, { ...e1, duration: 1234, response: { status: 200, body: { model: 'claude-fable-5', usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn', content: [] } } });

    const e2 = mkEntry({ requestId: 'req_2' });
    e2.body.messages = [...e1.body.messages, textMsg('assistant', 'hi'), textMsg('user', 'next')];
    const h2 = w.ingestRequest(e2, e2.body.messages);
    w.ingestCompletion(h2, { ...e2, duration: 99, response: { status: 200, body: { usage: {}, content: [] } } });
    await w.flush();

    const paths = sessionPaths(dir, 'proj', SID);
    const journal = readLines(paths.journalPath);
    const reqs = journal.filter(l => l.ph === 'req');
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].blobs.tools, reqs[1].blobs.tools, 'unchanged tools → same blob ref');
    assert.equal(readdirSync(paths.blobsDir).length, 2, 'tools + system, deduped across requests');
    assert.deepEqual(journal.filter(l => l.ph === 'done').map(l => l.status), ['ok', 'ok']);
    assert.equal(journal.find(l => l.ph === 'done' && l.seq === 1).usage.in, 10);

    const conv = readLines(convEpochPath(paths, 'main', 0));
    assert.deepEqual(conv.map(l => l.t), ['snapshot', 'append']);

    const responses = readLines(paths.responsesPath);
    assert.equal(responses.length, 2);
    assert.equal(responses[0].body.stop_reason, 'end_turn');

    const meta = JSON.parse(readFileSync(paths.metaPath, 'utf8'));
    assert.equal(meta.instanceId, '77');
    assert.equal(meta.userIdEncoding, 'json');
  });

  it('metadata-less requests route to the current session; cold-start ones are held then flushed', async () => {
    const w = new V2Writer({ logDir: dir, project: 'proj', enabled: true });
    // cold start: heartbeat arrives before any sid-bearing request
    const hb = { timestamp: 't0', url: 'https://api/eval/sdk-x', method: 'POST', isHeartbeat: true, requestId: 'hb1', body: {} };
    assert.equal(w.ingestRequest(hb, null), null, 'held in memory, no dir yet');
    assert.ok(!existsSync(join(dir, 'proj')), 'nothing on disk before first sid');

    const e = mkEntry();
    const h = w.ingestRequest(e, e.body.messages);
    assert.ok(h);
    await w.flush();
    const journal = readLines(sessionPaths(dir, 'proj', SID).journalPath);
    const kinds = journal.filter(l => l.ph === 'req').map(l => l.kind);
    assert.deepEqual(kinds, ['heartbeat', 'main'], 'held heartbeat flushed into the resolved session first');

    // subsequent metadata-less request routes straight to the active session
    const ct = { timestamp: 't2', url: 'https://api/v1/messages/count_tokens', method: 'POST', isCountTokens: true, requestId: 'ct1', body: { messages: [textMsg('user', 'count me')] } };
    const hct = w.ingestRequest(ct, ct.body.messages);
    assert.ok(hct && hct.sid === SID);
    await w.flush();
    const journal2 = readLines(sessionPaths(dir, 'proj', SID).journalPath);
    const ctReq = journal2.find(l => l.ph === 'req' && l.kind === 'countTokens');
    assert.equal(ctReq.conv, 'misc', 'countTokens keeps wire fidelity under misc');
  });

  it('disabled writer is a total no-op', () => {
    const w = new V2Writer({ logDir: dir, project: 'proj', enabled: false });
    const e = mkEntry();
    assert.equal(w.ingestRequest(e, e.body.messages), null);
    assert.ok(!existsSync(join(dir, 'proj')));
  });

  it('v2 failure is swallowed+reported, never thrown (failure isolation)', () => {
    // Force ensureSessionDirSync to fail: logDir points at a FILE.
    const fileAsDir = join(dir, 'not-a-dir');
    writeFileSync(fileAsDir, 'x');
    const w = new V2Writer({ logDir: fileAsDir, project: 'proj', enabled: true });
    const e = mkEntry();
    let handle;
    assert.doesNotThrow(() => { handle = w.ingestRequest(e, e.body.messages); });
    assert.equal(handle, null);
    assert.doesNotThrow(() => w.ingestCompletion(null, e));
  });

  it('disk guard: low free space disables v2 writes for the process', () => {
    const w = new V2Writer({
      logDir: dir, project: 'proj', enabled: true,
      statfs: () => ({ bavail: 10, bsize: 512 }), // 5KB free
    });
    const e = mkEntry();
    assert.equal(w.ingestRequest(e, e.body.messages), null);
    assert.ok(!existsSync(join(dir, 'proj')), 'no session dir created under disk pressure');
  });

  it('teammate meta records leader linkage (spec §10)', async () => {
    const w = new V2Writer({
      logDir: dir, project: 'proj', enabled: true,
      leader: { agentName: 'cr-product', teamName: 'review', parentSessionId: 'leader-sid' },
    });
    const e = mkEntry({ teammate: 'cr-product', teamName: 'review' });
    const h = w.ingestRequest(e, e.body.messages);
    assert.ok(h);
    await w.flush();
    const paths = sessionPaths(dir, 'proj', SID);
    const meta = JSON.parse(readFileSync(paths.metaPath, 'utf8'));
    assert.equal(meta.leader.agentName, 'cr-product');
    const req = readLines(paths.journalPath).find(l => l.ph === 'req');
    assert.equal(req.kind, 'teammate');
    assert.equal(req.conv, 'main', 'teammate traffic is the main conversation of its own session');
  });

  it('Agent spawns registered from completions key subsequent sub conversations', async () => {
    const w = new V2Writer({ logDir: dir, project: 'proj', enabled: true });
    const e = mkEntry();
    const h = w.ingestRequest(e, e.body.messages);
    w.ingestCompletion(h, {
      ...e,
      response: { status: 200, body: { content: [{ type: 'tool_use', name: 'Agent', id: 'toolu_ZZZZZZZZZZZZ9', input: { prompt: 'do the sub work' } }], usage: {} } },
    });
    const sub = mkEntry({ requestId: 'req_sub', mainAgent: false });
    sub.body.messages = [textMsg('user', 'do the sub work')];
    const hs = w.ingestRequest(sub, sub.body.messages);
    assert.ok(hs);
    await w.flush();
    const paths = sessionPaths(dir, 'proj', SID);
    const req = readLines(paths.journalPath).find(l => l.rid === 'req_sub');
    assert.equal(req.kind, 'sub');
    assert.equal(req.conv, 'sub-' + 'toolu_ZZZZZZZZZZZZ9'.slice(-12), 'conv key derives from the spawning tool_use.id');
    assert.ok(existsSync(convEpochPath(paths, req.conv, 0)));
  });

  it('resetConversations drops continuity → next ingest snapshots fresh, seq keeps counting', async () => {
    const w = new V2Writer({ logDir: dir, project: 'proj', enabled: true });
    const e1 = mkEntry();
    w.ingestRequest(e1, e1.body.messages);
    w.resetConversations();
    const e2 = mkEntry({ requestId: 'req_2' });
    e2.body.messages = [...e1.body.messages, textMsg('assistant', 'hi')];
    const h2 = w.ingestRequest(e2, e2.body.messages);
    assert.equal(h2.seq, 2, 'journal seq survives the reset');
    await w.flush();
    const conv = readLines(convEpochPath(sessionPaths(dir, 'proj', SID), 'main', 0));
    assert.deepEqual(conv.map(l => l.t), ['snapshot', 'snapshot'], 'post-reset ingest re-snapshots');
  });
});

// ─── write-order: conv lines land before/with the journal line ───────────────
describe('write-order protocol', () => {
  it('within one ingest, blob exists on disk before the journal line is even enqueued', () => {
    const paths = ensureSessionDirSync(dir, 'proj', SID);
    const observed = [];
    const spyQueue = {
      appendTo(path, data, onDone) {
        if (path === paths.journalPath) {
          // At journal-enqueue time the blob referenced by the line must exist.
          const line = JSON.parse(data);
          if (line.ph === 'req' && line.blobs) {
            observed.push(existsSync(join(paths.blobsDir, `${line.blobs.tools}.json`)));
          }
        }
        if (onDone) onDone();
      },
      flush: async () => {}, close: async () => {},
    };
    const w = new V2Writer({ logDir: dir, project: 'proj', enabled: true, queue: spyQueue });
    const e = {
      timestamp: 't', url: 'u', method: 'POST', requestId: 'r1', mainAgent: true,
      body: { metadata: { user_id: jsonUserId }, tools: [{ name: 'Bash' }], messages: [textMsg('user', 'x')] },
    };
    w.ingestRequest(e, e.body.messages);
    assert.deepEqual(observed, [true], 'journal line enqueued only after its blob is durable');
  });
});
