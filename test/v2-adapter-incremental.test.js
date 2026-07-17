/**
 * wire-v2 S6b (1.7.0) — SessionSynthesizer incremental mode + windowed reads
 * (server/lib/v2/adapter.js).
 *
 * The synthesizer is the SINGLE synthesis path: cold generators feed it
 * eagerly, the live feed feeds it incrementally from file cursors. These tests
 * pin the contract that makes that safe:
 *   - incremental completed output is byte-identical to a cold read
 *   - a live placeholder is byte-identical to a cold read of the same
 *     in-flight request
 *   - a journal req line whose conversation event line lags is PARKED and
 *     retried (not skipped/lost), with a deadline fallback to cold-style skip
 *   - a done line whose responses line lags is parked until the line arrives,
 *     with a deadline fallback to a null response
 *   - readV2WindowedEntries synthesizes a baseline checkpoint when the window
 *     starts on a main-conversation delta (sparse-checkpoint truncation fix)
 *
 * Data-safety: all fixtures live in mkdtemp dirs; nothing touches a real
 * CCV_LOG_DIR.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { V2Writer } from '../server/lib/v2/v2-writer.js';
import { SessionSynthesizer, iterateV2RawEntries, readV2WindowedEntries, findTeammateSessionDirs } from '../server/lib/v2/adapter.js';
import { readTailEntries } from '../server/lib/log-stream.js';
import { reconstructEntries } from '../server/lib/delta-reconstructor.js';
import { _resetForTest } from '../server/lib/error-report.js';
import { resolveSessionDirName } from '../server/lib/v2/session-select.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccv-v2inc-')); _resetForTest(); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const SID = 'c1234567-89ab-4cde-8f01-23456789abcd';
const userIdOf = (sid) => JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: sid });
const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }] });

const SYSTEM = [{ type: 'text', text: 'You are Claude Code, the official CLI.' }];
const TOOLS = [{ name: 'Edit', input_schema: {} }, { name: 'Bash', input_schema: {} }];

let tsCounter = 0;
function nextTs() {
  return new Date(Date.UTC(2026, 6, 14, 5, 0, 0, ++tsCounter)).toISOString();
}

function mainEntry(messages) {
  return {
    timestamp: nextTs(),
    project: 'proj',
    url: 'https://api.anthropic.com/v1/messages?beta=true',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { model: 'claude-fable-5', system: SYSTEM, tools: TOOLS, metadata: { user_id: userIdOf(SID) }, messages },
    response: null,
    duration: 0,
    isStream: false,
    isHeartbeat: false,
    isCountTokens: false,
    mainAgent: true,
    requestId: `rid_${++tsCounter}`,
  };
}

function newWriter() {
  return new V2Writer({ logDir: dir, project: 'proj', enabled: true, minFreeBytes: 0 });
}

function fire(w, entry, { complete = true } = {}) {
  const h = w.ingestRequest(entry, entry.body.messages);
  if (complete) {
    w.ingestCompletion(h, {
      ...entry,
      response: { status: 200, headers: { 'x-req': '1' }, body: { content: [], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 7 } } },
      duration: 42,
    });
  }
  return h;
}

const sessionDirOf = (sid) => join(dir, 'proj', 'sessions', resolveSessionDirName(join(dir, 'proj'), sid) || sid);

/** Parse a session dir's files into feedable line streams (file order). */
function sessionLines(sessionDir) {
  const parseLines = (p) => !existsSync(p) ? [] : readFileSync(p, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  const journal = parseLines(join(sessionDir, 'journal.jsonl')).map(l => JSON.parse(l));
  const responses = parseLines(join(sessionDir, 'responses.jsonl'));
  const convs = new Map(); // key → parsed events in file order
  const convRoot = join(sessionDir, 'conversations');
  if (existsSync(convRoot)) {
    for (const key of readdirSync(convRoot)) {
      const events = [];
      const files = readdirSync(join(convRoot, key)).filter(f => /^e\d+\.jsonl$/.test(f))
        .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
      for (const f of files) events.push(...parseLines(join(convRoot, key, f)).map(l => JSON.parse(l)));
      convs.set(key, events);
    }
  }
  return { journal, responses, convs };
}

/** Feed a synthesizer in realistic disk order: each req's conv events land
 *  just before its journal line; each done's responses line lands just before
 *  the done line. Options withhold pieces to simulate lag. */
function feedRealistic(synth, lines, { holdDones = false } = {}) {
  const convPtr = new Map();
  const respBySeq = new Map();
  for (const raw of lines.responses) {
    const m = raw.match(/"seq":\s*(\d+)/);
    if (m) respBySeq.set(Number(m[1]), raw);
  }
  const held = [];
  for (const line of lines.journal) {
    if (line.ph === 'req' && line.conv) {
      const events = lines.convs.get(line.conv) || [];
      let p = convPtr.get(line.conv) || 0;
      while (p < events.length && events[p].seq <= line.seq) {
        synth.ingestConvLine(line.conv, events[p++]);
      }
      convPtr.set(line.conv, p);
    }
    if (line.ph === 'done') {
      if (holdDones) { held.push(line); continue; }
      const resp = respBySeq.get(line.seq);
      if (resp) synth.ingestResponseLine(resp);
    }
    synth.ingestJournalLine(line);
  }
  return { held, respBySeq };
}

// ─── incremental vs cold byte parity ─────────────────────────────────────────
describe('SessionSynthesizer incremental parity', () => {
  it('incrementally fed completed entries are byte-identical to a cold read', async () => {
    const w = newWriter();
    const t1 = [textMsg('user', 'turn 1')];
    const t2 = [...t1, textMsg('assistant', 'r1'), textMsg('user', 'turn 2')];
    const t3 = [...t2, textMsg('assistant', 'r2'), textMsg('user', 'turn 3')];
    for (const msgs of [t1, t2, t3]) fire(w, mainEntry(msgs));
    await w.flush();

    const sessionDir = sessionDirOf(SID);
    const cold = [...iterateV2RawEntries(sessionDir)];
    assert.equal(cold.length, 3);

    const synth = new SessionSynthesizer(sessionDir, { deferMs: 5000, now: () => 0 });
    feedRealistic(synth, sessionLines(sessionDir));
    const items = synth.drain();
    const completed = items.filter(i => i.phase === 'completed');
    assert.equal(completed.length, 3);
    // Completion follows each req immediately here, so seq order == cold order.
    for (let i = 0; i < 3; i++) {
      assert.equal(JSON.stringify(completed[i].entry), cold[i], `entry ${i} byte parity`);
    }
  });

  it('a live placeholder is byte-identical to the cold read of the same in-flight request', async () => {
    const w = newWriter();
    fire(w, mainEntry([textMsg('user', 'turn 1')]), { complete: false });
    await w.flush();

    const sessionDir = sessionDirOf(SID);
    const cold = [...iterateV2RawEntries(sessionDir)];
    assert.equal(cold.length, 1);
    assert.match(cold[0], /"inProgress":true/);

    const synth = new SessionSynthesizer(sessionDir, { deferMs: 5000, now: () => 0 });
    feedRealistic(synth, sessionLines(sessionDir));
    const items = synth.drain();
    assert.equal(items.length, 1);
    assert.equal(items[0].phase, 'placeholder');
    assert.equal(JSON.stringify(items[0].entry), cold[0]);
  });

  it('placeholder → completed mutation stringifies byte-identical to cold', async () => {
    const w = newWriter();
    fire(w, mainEntry([textMsg('user', 'turn 1')]));
    await w.flush();

    const sessionDir = sessionDirOf(SID);
    const cold = [...iterateV2RawEntries(sessionDir)];
    const lines = sessionLines(sessionDir);

    const synth = new SessionSynthesizer(sessionDir, { deferMs: 5000, now: () => 0 });
    const { held, respBySeq } = feedRealistic(synth, lines, { holdDones: true });
    const first = synth.drain();
    assert.equal(first.length, 1);
    assert.equal(first[0].phase, 'placeholder');
    assert.match(JSON.stringify(first[0].entry), /"inProgress":true/);

    for (const done of held) {
      const resp = respBySeq.get(done.seq);
      if (resp) synth.ingestResponseLine(resp);
      synth.ingestJournalLine(done);
    }
    const second = synth.drain();
    assert.equal(second.length, 1);
    assert.equal(second[0].phase, 'completed');
    assert.equal(JSON.stringify(second[0].entry), cold[0]);
  });
});

// ─── lag handling: defer/retry + deadlines ───────────────────────────────────
describe('SessionSynthesizer lag handling', () => {
  it('parks a req whose conv event line lags, then emits it when the line arrives (no loss)', async () => {
    const w = newWriter();
    const t1 = [textMsg('user', 'turn 1')];
    const t2 = [...t1, textMsg('assistant', 'r1'), textMsg('user', 'turn 2')];
    fire(w, mainEntry(t1));
    fire(w, mainEntry(t2));
    await w.flush();

    const sessionDir = sessionDirOf(SID);
    const cold = [...iterateV2RawEntries(sessionDir)];
    const lines = sessionLines(sessionDir);
    const mainEvents = lines.convs.get('main');
    assert.equal(mainEvents.length, 2);

    const synth = new SessionSynthesizer(sessionDir, { deferMs: 5000, now: () => 0 });
    // Feed conv event 0, journal req 0 + done 0 — normal.
    synth.ingestConvLine('main', mainEvents[0]);
    const reqs = lines.journal.filter(l => l.ph === 'req');
    const dones = lines.journal.filter(l => l.ph === 'done');
    synth.ingestJournalLine(reqs[0]);
    for (const r of lines.responses) synth.ingestResponseLine(r);
    synth.ingestJournalLine(dones[0]);
    assert.equal(synth.drain().filter(i => i.phase === 'completed').length, 1);

    // Journal req 1 arrives BEFORE its conv event (write-order window).
    synth.ingestJournalLine(reqs[1]);
    synth.ingestJournalLine(dones[1]);
    assert.equal(synth.drain().length, 0, 'req parked, nothing emitted');
    assert.ok(synth.hasPending());

    // The lagging conv line lands → the parked req completes, byte-true.
    synth.ingestConvLine('main', mainEvents[1]);
    const items = synth.drain();
    assert.equal(items.length, 1);
    assert.equal(items[0].phase, 'completed');
    assert.equal(JSON.stringify(items[0].entry), cold[1]);
  });

  it('an expired conv deferral degrades to the cold-style skip and unblocks the queue', async () => {
    const w = newWriter();
    const t1 = [textMsg('user', 'turn 1')];
    const t2 = [...t1, textMsg('assistant', 'r1'), textMsg('user', 'turn 2')];
    const t3 = [...t2, textMsg('assistant', 'r2'), textMsg('user', 'turn 3')];
    for (const msgs of [t1, t2, t3]) fire(w, mainEntry(msgs));
    await w.flush();

    const sessionDir = sessionDirOf(SID);
    const lines = sessionLines(sessionDir);
    const mainEvents = lines.convs.get('main');
    let clock = 0;
    const synth = new SessionSynthesizer(sessionDir, { deferMs: 1000, now: () => clock });
    const reqs = lines.journal.filter(l => l.ph === 'req');

    synth.ingestConvLine('main', mainEvents[0]);
    synth.ingestJournalLine(reqs[0]);
    assert.equal(synth.drain().length, 1);

    // Event for req 1 never arrives; event for req 2 does.
    synth.ingestJournalLine(reqs[1]);
    synth.ingestConvLine('main', mainEvents[2]);
    synth.ingestJournalLine(reqs[2]);
    assert.equal(synth.drain().length, 0, 'queue blocked behind the parked head');

    clock = 2000;
    synth.sweepDeadlines();
    const items = synth.drain();
    // Head skipped (cold semantics); req 2 emits. Its append event applies, so
    // the count gate passes and no history is lost beyond the skipped entry.
    assert.equal(items.length, 1);
    assert.equal(items[0].seq, reqs[2].seq);
  });

  it('parks a done whose responses line lags; the line arriving completes with the real body', async () => {
    const w = newWriter();
    fire(w, mainEntry([textMsg('user', 'turn 1')]));
    await w.flush();

    const sessionDir = sessionDirOf(SID);
    const cold = [...iterateV2RawEntries(sessionDir)];
    const lines = sessionLines(sessionDir);
    const synth = new SessionSynthesizer(sessionDir, { deferMs: 5000, now: () => 0 });
    const { held, respBySeq } = feedRealistic(synth, lines, { holdDones: true });
    synth.drain(); // placeholder

    synth.ingestJournalLine(held[0]); // done, no responses line yet
    assert.equal(synth.drain().length, 0, 'done parked awaiting responses line');
    assert.ok(synth.hasPending());

    synth.ingestResponseLine(respBySeq.get(held[0].seq));
    const items = synth.drain();
    assert.equal(items.length, 1);
    assert.equal(JSON.stringify(items[0].entry), cold[0]);
  });

  it('an expired done deferral completes with a null response body', async () => {
    const w = newWriter();
    fire(w, mainEntry([textMsg('user', 'turn 1')]));
    await w.flush();

    const sessionDir = sessionDirOf(SID);
    const lines = sessionLines(sessionDir);
    let clock = 0;
    const synth = new SessionSynthesizer(sessionDir, { deferMs: 1000, now: () => clock });
    const { held } = feedRealistic(synth, lines, { holdDones: true });
    synth.drain();

    synth.ingestJournalLine(held[0]);
    assert.equal(synth.drain().length, 0);
    clock = 2000;
    synth.sweepDeadlines();
    const items = synth.drain();
    assert.equal(items.length, 1);
    assert.equal(items[0].phase, 'completed');
    assert.equal(items[0].entry.response.body, null);
    assert.equal(items[0].entry.response.status, 200, 'http status still comes from the done line');
  });
});

// ─── windowed reads: baseline checkpoint synthesis ───────────────────────────
describe('readV2WindowedEntries baseline', () => {
  async function buildDeltaHeavySession() {
    const w = newWriter();
    const msgs = [textMsg('user', 'turn 1')];
    fire(w, mainEntry([...msgs]));
    for (let i = 2; i <= 6; i++) {
      msgs.push(textMsg('assistant', `r${i - 1}`), textMsg('user', `turn ${i}`));
      fire(w, mainEntry([...msgs]));
    }
    await w.flush();
    return { sessionDir: sessionDirOf(SID), finalMsgs: msgs };
  }

  it('a window starting on a delta gets a synthesized checkpoint carrying full state', async () => {
    const { sessionDir, finalMsgs } = await buildDeltaHeavySession();
    const full = [...iterateV2RawEntries(sessionDir)];
    assert.equal(full.length, 6);
    // Only the first entry is an organic checkpoint — the window would have no
    // baseline without synthesis.
    assert.match(full[1], /"_isCheckpoint":false/);

    const win = await readV2WindowedEntries(sessionDir, { limit: 2 });
    assert.equal(win.entries.length, 2);
    assert.equal(win.hasMore, true);
    assert.equal(win.totalCount, 6);
    const first = JSON.parse(win.entries[0]);
    assert.equal(first._isCheckpoint, true, 'window head promoted to checkpoint');
    assert.equal(first.body.messages.length, first._totalMessageCount);

    // The windowed stream reconstructs to the same final conversation state.
    const reconstructed = reconstructEntries(win.entries.map(r => JSON.parse(r)));
    const last = reconstructed[reconstructed.length - 1];
    assert.deepEqual(last.body.messages, finalMsgs);
  });

  it('a window that happens to start on an organic checkpoint is left untouched', async () => {
    const { sessionDir } = await buildDeltaHeavySession();
    const win = await readV2WindowedEntries(sessionDir, { limit: 6 });
    assert.equal(win.hasMore, false);
    assert.equal(JSON.parse(win.entries[0])._isCheckpoint, true);
    // Untouched == byte-equal to the full cold read.
    assert.deepEqual(win.entries, [...iterateV2RawEntries(sessionDir)]);
  });

  it('readTailEntries routes v2 dirs through the windowed reader; before-filter windows get a baseline too', async () => {
    const { sessionDir } = await buildDeltaHeavySession();
    const tail = await readTailEntries(sessionDir, { limit: 2 });
    assert.equal(tail.entries.length, 2);
    assert.equal(tail.hasMore, true);
    assert.equal(JSON.parse(tail.entries[0])._isCheckpoint, true);
    assert.equal(tail.estimatedTotal, 6);

    const all = [...iterateV2RawEntries(sessionDir)].map(r => JSON.parse(r));
    const before = all[4].timestamp;
    const page = await readV2WindowedEntries(sessionDir, { before, limit: 2 });
    assert.equal(page.entries.length, 2);
    const pageFirst = JSON.parse(page.entries[0]);
    assert.equal(pageFirst._isCheckpoint, true, 'before-filtered window also gets a baseline');
    assert.ok(JSON.parse(page.entries[1]).timestamp < before);
  });
});

// ─── leaderless teammate fallback (native team mode) ─────────────────────────
describe('leaderless teammate re-join fallback', () => {
  const SID_L1 = 'f0000000-0000-4000-8000-000000000001'; // older leader
  const SID_L2 = 'f0000000-0000-4000-8000-000000000002'; // newer leader
  const SID_TM = 'f0000000-0000-4000-8000-00000000000a';

  async function buildLeader(sid) {
    const w = newWriter();
    const e = mainEntry([textMsg('user', `hello from ${sid}`)]);
    e.body.metadata.user_id = JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: sid });
    fire(w, e);
    await w.flush();
    return sessionDirOf(sid);
  }

  async function buildTeammate(leaderMeta) {
    const w = new V2Writer({ logDir: dir, project: 'proj', enabled: true, minFreeBytes: 0, leader: leaderMeta });
    const e = mainEntry([textMsg('user', 'teammate work')]);
    e.body.metadata.user_id = JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: SID_TM });
    fire(w, e);
    await w.flush();
    return sessionDirOf(SID_TM);
  }

  it('a teammate meta WITHOUT parentSessionId joins the most recently started leader', async () => {
    const l1 = await buildLeader(SID_L1);
    // startTs granularity is ms — space the sessions out.
    await new Promise((r) => setTimeout(r, 5));
    const l2 = await buildLeader(SID_L2);
    await new Promise((r) => setTimeout(r, 5));
    await buildTeammate({ agentName: 'worker-1', teamName: 'team-x' }); // native mode: no sid

    assert.equal(findTeammateSessionDirs(l1).length, 0, 'older leader does not adopt the orphan');
    const joined = findTeammateSessionDirs(l2);
    assert.equal(joined.length, 1, 'newest leader adopts the orphan');
    assert.equal(joined[0].leader.agentName, 'worker-1');

    // End-to-end: reading the newer leader renders the teammate entry, tagged.
    const entries = [...iterateV2RawEntries(l2)].map((r) => JSON.parse(r));
    const tm = entries.filter((e) => e.teammate === 'worker-1');
    assert.equal(tm.length, 1);
    assert.equal(tm[0].teamName, 'team-x');
  });

  it('an explicit parentSessionId still wins over temporal attribution', async () => {
    const l1 = await buildLeader(SID_L1);
    await new Promise((r) => setTimeout(r, 5));
    const l2 = await buildLeader(SID_L2);
    await new Promise((r) => setTimeout(r, 5));
    await buildTeammate({ agentName: 'worker-1', parentSessionId: SID_L1 });

    assert.equal(findTeammateSessionDirs(l2).length, 0);
    assert.equal(findTeammateSessionDirs(l1).length, 1, 'recorded sid beats recency');
  });
});

// ─── out-of-order conv events: the live seq-sort invariant (2026-07-15) ──────
// File order across epoch files is NOT globally seq-ordered on dirs written by
// a pre-fix restarted writer (newer seqs appended into an older epoch file).
// Cold reads always sort globally; the synthesizer must tolerate the same
// disorder via sorted insert — a stranded lower-seq event previously parked
// forever and degraded (missing-conv-event → state-count-mismatch, all false).
describe('SessionSynthesizer out-of-order conv events', () => {
  it('conv events arriving out of seq order still yield byte-true completed entries', async () => {
    const w = newWriter();
    const t1 = [textMsg('user', 'turn 1')];
    const t2 = [...t1, textMsg('assistant', 'r1'), textMsg('user', 'turn 2')];
    const t3 = [...t2, textMsg('assistant', 'r2'), textMsg('user', 'turn 3')];
    for (const msgs of [t1, t2, t3]) fire(w, mainEntry(msgs));
    await w.flush();

    const sessionDir = sessionDirOf(SID);
    const cold = [...iterateV2RawEntries(sessionDir)];
    const lines = sessionLines(sessionDir);
    const mainEvents = lines.convs.get('main');
    assert.equal(mainEvents.length, 3);

    const synth = new SessionSynthesizer(sessionDir, { deferMs: 5000, now: () => 0 });
    // Scrambled arrival: the seq-1 snapshot lands LAST (the disordered-dir
    // seed shape: e1 fed before e0's tail).
    synth.ingestConvLine('main', mainEvents[1]);
    synth.ingestConvLine('main', mainEvents[2]);
    synth.ingestConvLine('main', mainEvents[0]);
    for (const r of lines.responses) synth.ingestResponseLine(r);
    for (const l of lines.journal) synth.ingestJournalLine(l);

    const items = synth.drain().filter((i) => i.phase === 'completed');
    assert.equal(items.length, 3, 'nothing parked or degraded');
    assert.ok(!synth.hasPending(), 'no stranded deferrals');
    for (let i = 0; i < 3; i++) {
      assert.equal(JSON.stringify(items[i].entry), cold[i], `entry ${i} byte-parity with cold`);
    }
  });

  it('a late lower-seq event arriving after later seqs were consumed is still applied in order', async () => {
    const w = newWriter();
    const t1 = [textMsg('user', 'turn 1')];
    const t2 = [...t1, textMsg('assistant', 'r1'), textMsg('user', 'turn 2')];
    const t3 = [...t2, textMsg('assistant', 'r2'), textMsg('user', 'turn 3')];
    for (const msgs of [t1, t2, t3]) fire(w, mainEntry(msgs));
    await w.flush();

    const sessionDir = sessionDirOf(SID);
    const cold = [...iterateV2RawEntries(sessionDir)];
    const lines = sessionLines(sessionDir);
    const mainEvents = lines.convs.get('main');
    const reqs = lines.journal.filter((l) => l.ph === 'req');
    const dones = lines.journal.filter((l) => l.ph === 'done');

    const synth = new SessionSynthesizer(sessionDir, { deferMs: 5000, now: () => 0 });
    for (const r of lines.responses) synth.ingestResponseLine(r);
    // Turn 1 flows normally and is CONSUMED (ptr advanced past seq 1).
    synth.ingestConvLine('main', mainEvents[0]);
    synth.ingestJournalLine(reqs[0]);
    synth.ingestJournalLine(dones[0]);
    assert.equal(synth.drain().filter((i) => i.phase === 'completed').length, 1);
    // Turn 3's event arrives BEFORE turn 2's (cross-file disorder), reqs after.
    synth.ingestConvLine('main', mainEvents[2]);
    synth.ingestConvLine('main', mainEvents[1]);
    synth.ingestJournalLine(reqs[1]);
    synth.ingestJournalLine(dones[1]);
    synth.ingestJournalLine(reqs[2]);
    synth.ingestJournalLine(dones[2]);
    const items = synth.drain().filter((i) => i.phase === 'completed');
    assert.equal(items.length, 2, 'both later turns emitted, none stranded behind the pointer');
    assert.equal(JSON.stringify(items[0].entry), cold[1]);
    assert.equal(JSON.stringify(items[1].entry), cold[2]);
  });
});
