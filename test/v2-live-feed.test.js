/**
 * wire-v2 S6b (1.7.0) — V2LiveFeed (server/lib/v2/live-feed.js).
 *
 * Deterministic tier: fs.watch is stubbed out and the feed is driven manually
 * through tick() / _safetyTick(), so no timing sleeps are needed. The fixture
 * write side is the REAL V2Writer; assertions compare the live SSE emissions
 * against the cold adapter read fed through the client reconstructor — the
 * cold/live parity gate of plan step 1.2.
 *
 * Data-safety: all fixtures live in mkdtemp dirs; nothing touches a real
 * CCV_LOG_DIR.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { V2Writer } from '../server/lib/v2/v2-writer.js';
import { V2LiveFeed } from '../server/lib/v2/live-feed.js';
import { iterateV2RawEntries } from '../server/lib/v2/adapter.js';
import { reconstructEntries } from '../server/lib/delta-reconstructor.js';
import { _resetForTest } from '../server/lib/error-report.js';
import { resolveSessionDirName } from '../server/lib/v2/session-select.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccv-v2feed-')); _resetForTest(); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const SID = 'd1234567-89ab-4cde-8f01-23456789abcd';
const SID_TM = 'e2345678-9abc-4def-8012-3456789abcde';
const userIdOf = (sid) => JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: sid });
const textMsg = (role, text) => ({ role, content: [{ type: 'text', text }] });

const SYSTEM = [{ type: 'text', text: 'You are Claude Code, the official CLI.' }];
const TOOLS = [{ name: 'Edit', input_schema: {} }, { name: 'Bash', input_schema: {} }];

let tsCounter = 0;
function nextTs() {
  return new Date(Date.UTC(2026, 6, 14, 6, 0, 0, ++tsCounter)).toISOString();
}

function mainEntry(messages, { sid = SID } = {}) {
  return {
    timestamp: nextTs(),
    project: 'proj',
    url: 'https://api.anthropic.com/v1/messages?beta=true',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { model: 'claude-fable-5', system: SYSTEM, tools: TOOLS, metadata: { user_id: userIdOf(sid) }, messages },
    response: null,
    duration: 0,
    isStream: false,
    isHeartbeat: false,
    isCountTokens: false,
    mainAgent: true,
    requestId: `rid_${++tsCounter}`,
  };
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

const projectDirOf = () => join(dir, 'proj');
const sessionDirOf = (sid) => join(dir, 'proj', 'sessions', resolveSessionDirName(join(dir, 'proj'), sid) || sid);

/** Fake SSE client capturing everything written to it. */
function fakeClient() {
  return {
    writes: [],
    destroyed: false,
    writable: true,
    write(payload) { this.writes.push(payload); return true; },
    once() {},
    end() {},
  };
}

/** Parse `data:`-event entries out of captured SSE writes. */
function dataEntries(client) {
  const out = [];
  for (const w of client.writes) {
    if (w.startsWith('data: ')) out.push(JSON.parse(w.slice(6, w.indexOf('\n\n'))));
  }
  return out;
}
function eventNames(client) {
  return client.writes.filter((w) => w.startsWith('event: ')).map((w) => w.slice(7, w.indexOf('\n')));
}

const stubWatch = () => ({ close() {}, on() {} });

function newFeed(clients, extra = {}) {
  return new V2LiveFeed({
    clients,
    getClaudePid: () => 4242,
    runParallelHook: () => Promise.resolve(),
    watchImpl: stubWatch,
    safetyPollMs: 0, // driven manually
    ...extra,
  });
}

function newWriter(opts = {}) {
  return new V2Writer({ logDir: dir, project: 'proj', enabled: true, minFreeBytes: 0, ...opts });
}

// ─── cold/live parity ────────────────────────────────────────────────────────
describe('V2LiveFeed cold/live parity', () => {
  it('live emissions reconstruct to the same final state as a cold read through the client path', async () => {
    const client = fakeClient();
    const feed = newFeed([client]);
    feed.start(projectDirOf());

    const w = newWriter();
    const t1 = [textMsg('user', 'turn 1')];
    const t2 = [...t1, textMsg('assistant', 'r1'), textMsg('user', 'turn 2')];
    const t3 = [...t2, textMsg('assistant', 'r2'), textMsg('user', 'turn 3')];
    for (const msgs of [t1, t2, t3]) fire(w, mainEntry(msgs));
    await w.flush();

    feed.tick(sessionDirOf(SID));
    // The stubbed watcher never fires; the tick attach reads synchronously.
    assert.ok(feed.isFollowing(sessionDirOf(SID)));

    const live = dataEntries(client);
    // req and done land in the same batch → the placeholder is folded away
    // and only the completed frame is emitted (one per request).
    assert.equal(live.length, 3);
    assert.equal(live.filter((e) => e.inProgress).length, 0);
    const liveFinal = live;

    // Cold path: raw adapter output through the client's own reconstruction.
    const cold = reconstructEntries([...iterateV2RawEntries(sessionDirOf(SID))].map((r) => JSON.parse(r)));
    assert.equal(liveFinal.length, cold.length);
    for (let i = 0; i < cold.length; i++) {
      assert.deepEqual(liveFinal[i].body.messages, cold[i].body.messages, `entry ${i} reconstructed messages parity`);
      assert.equal(liveFinal[i]._seq, cold[i]._seq);
      assert.equal(liveFinal[i]._seqEpoch, cold[i]._seqEpoch);
      assert.equal(liveFinal[i].pid, 4242, 'pid stamped by the shared pipeline');
    }

    // Completed main entries produce the kv/context side events like v1 did.
    const events = eventNames(client);
    assert.ok(events.includes('context_window'), 'context_window side event emitted');
  });

  it('emits incrementally: entries written after attach are broadcast on the next tick', async () => {
    const client = fakeClient();
    const feed = newFeed([client]);
    feed.start(projectDirOf());

    const w = newWriter();
    fire(w, mainEntry([textMsg('user', 'turn 1')]));
    await w.flush();
    feed.tick(sessionDirOf(SID));
    const before = dataEntries(client).length;
    assert.equal(before, 1);

    fire(w, mainEntry([textMsg('user', 'turn 1'), textMsg('assistant', 'r1'), textMsg('user', 'turn 2')]));
    await w.flush();
    feed._safetyTick(); // tick() debounces; the safety poll reads synchronously
    const after = dataEntries(client);
    assert.equal(after.length, before + 1, 'exactly the new completed frame');
    const last = after[after.length - 1];
    assert.equal(last.inProgress, undefined);
    assert.equal(last.body.messages.length, 3, 'delta reconstructed to full messages');
  });
});

// ─── suppression & discovery ─────────────────────────────────────────────────
describe('V2LiveFeed suppression and discovery', () => {
  it('a session that predates the feed is followed silently; only new appends emit', async () => {
    const w = newWriter();
    fire(w, mainEntry([textMsg('user', 'old turn')]));
    await w.flush();

    const client = fakeClient();
    const feed = newFeed([client]);
    feed.start(projectDirOf()); // initial scan: recent mtime → attach suppressed
    assert.ok(feed.isFollowing(sessionDirOf(SID)));
    assert.equal(dataEntries(client).length, 0, 'history suppressed');

    fire(w, mainEntry([textMsg('user', 'old turn'), textMsg('assistant', 'r'), textMsg('user', 'new turn')]));
    await w.flush();
    feed._safetyTick(); // stubbed watcher never fires — safety poll delivers
    const live = dataEntries(client);
    assert.equal(live.length, 1);
    assert.equal(live[0].body.messages.length, 3);
  });

  it('a teammate session appearing cross-process is discovered and emitted with its tag', async () => {
    const client = fakeClient();
    const feed = newFeed([client]);
    feed.start(projectDirOf());

    // Leader session first (so the teammate dir appears mid-run).
    const w = newWriter();
    fire(w, mainEntry([textMsg('user', 'leader turn')]));
    await w.flush();
    feed.tick(sessionDirOf(SID));
    const baseline = dataEntries(client).length;

    // Cross-process teammate: separate writer instance, own sid, leader meta.
    const tm = newWriter({ leader: { agentName: 'worker-1', teamName: 'team-x', parentSessionId: SID } });
    fire(tm, mainEntry([textMsg('user', 'teammate turn')], { sid: SID_TM }));
    await tm.flush();

    feed._safetyTick(); // discovery fallback path (root watcher is stubbed)
    assert.ok(feed.isFollowing(sessionDirOf(SID_TM)));
    const live = dataEntries(client).slice(baseline);
    assert.ok(live.length >= 1);
    const tmEntries = live.filter((e) => e.teammate === 'worker-1');
    assert.equal(tmEntries.length, 1, 'teammate completed frame emitted');
    assert.equal(tmEntries[0].teamName, 'team-x');
  });

  it('notifyStatsWorker is nudged with the session dir after an emitting batch', async () => {
    const notified = [];
    const client = fakeClient();
    const feed = newFeed([client], { notifyStatsWorker: (d) => notified.push(d) });
    feed.start(projectDirOf());

    const w = newWriter();
    fire(w, mainEntry([textMsg('user', 'turn 1')]));
    await w.flush();
    feed.tick(sessionDirOf(SID));
    assert.deepEqual(notified, [sessionDirOf(SID)]);
  });

  it('stop() detaches everything and further writes emit nothing', async () => {
    const client = fakeClient();
    const feed = newFeed([client]);
    feed.start(projectDirOf());
    const w = newWriter();
    fire(w, mainEntry([textMsg('user', 'turn 1')]));
    await w.flush();
    feed.tick(sessionDirOf(SID));
    const count = dataEntries(client).length;

    feed.stop();
    fire(w, mainEntry([textMsg('user', 'turn 1'), textMsg('assistant', 'r'), textMsg('user', 'turn 2')]));
    await w.flush();
    feed.tick(sessionDirOf(SID));
    feed._safetyTick();
    assert.equal(dataEntries(client).length, count);
  });
});

// ─── writer onActivity nudge ─────────────────────────────────────────────────
describe('V2Writer onActivity → live feed', () => {
  it('the writer nudges the feed on every ingest (request and completion)', async () => {
    const ticks = [];
    const w = new V2Writer({
      logDir: dir, project: 'proj', enabled: true, minFreeBytes: 0,
      onActivity: (d) => ticks.push(d),
    });
    fire(w, mainEntry([textMsg('user', 'turn 1')]));
    await w.flush();
    assert.equal(ticks.length, 2, 'one nudge per ingest phase');
    assert.ok(ticks.every((d) => d === sessionDirOf(SID)));
  });

  it('an in-process tick before the queue drained retries and delivers (no lost first entry)', async () => {
    const client = fakeClient();
    const feed = newFeed([client]);
    feed.start(projectDirOf());

    const w = new V2Writer({
      logDir: dir, project: 'proj', enabled: true, minFreeBytes: 0,
      onActivity: (d) => feed.tick(d),
    });
    // ingest fires the nudge synchronously, before any file exists on disk —
    // the meta/dir exist (sync) but journal.jsonl only lands on queue drain.
    fire(w, mainEntry([textMsg('user', 'turn 1')]));
    await w.flush();
    // The tick retry timer (250ms) picks the session up.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.ok(feed.isFollowing(sessionDirOf(SID)), 'retry attached the session');
    assert.equal(dataEntries(client).length, 1);
    feed.stop();
  });
});

// ─── writer generation restart: Fix A+B joint acceptance (2026-07-15) ────────
describe('V2LiveFeed across a writer restart continuation', () => {
  it('a fresh writer generation continues in the latest epoch and live stays cold-parity', async () => {
    const client = fakeClient();
    const feed = newFeed([client]);
    feed.start(projectDirOf());

    // Generation A: two turns, then a /clear continuation (opens e1).
    const wA = newWriter();
    const t1 = [textMsg('user', 'turn 1')];
    const t2 = [...t1, textMsg('assistant', 'r1'), textMsg('user', 'turn 2')];
    const clear = [textMsg('user', '<command-name>/clear</command-name>'), textMsg('assistant', 'fresh')];
    for (const msgs of [t1, t2, clear]) fire(wA, mainEntry(msgs));
    await wA.flush();
    feed.tick(sessionDirOf(SID));

    // Generation B: process restart onto the same session dir (`-c`). The
    // fresh ConversationStore must seed epoch=1 from disk — its snapshot and
    // all later events land in e1, keeping file order == seq order.
    const wB = newWriter();
    const cont = [...clear, textMsg('user', 'after restart')];
    fire(wB, mainEntry(cont));
    await wB.flush();
    feed._safetyTick(); // tick() debounces; the safety poll reads synchronously

    const e0 = readFileSync(join(sessionDirOf(SID), 'conversations', 'main', 'e0.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const e1 = readFileSync(join(sessionDirOf(SID), 'conversations', 'main', 'e1.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(Math.max(...e0.map((l) => l.seq)) < Math.min(...e1.map((l) => l.seq)),
      'restart continuation landed in e1 — cross-file seq order preserved (Fix A)');

    // Live emissions reconstruct to the same final state as a cold read.
    const live = dataEntries(client);
    const cold = reconstructEntries([...iterateV2RawEntries(sessionDirOf(SID))].map((r) => JSON.parse(r)));
    assert.equal(live.length, cold.length, 'every generation-B entry emitted live');
    for (let i = 0; i < cold.length; i++) {
      assert.deepEqual(live[i].body.messages, cold[i].body.messages, `entry ${i} parity across the restart`);
    }
  });
});
