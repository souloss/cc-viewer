/**
 * Batch/live session-boundary parity — regression suite for the "only show
 * current session" wrong-anchor bug.
 *
 * The pin identifies a session by its stable id (= messages[0]._timestamp).
 * Historically the batch reload path (_processOneEntry) and the live SSE path
 * (_flushPendingEntries) used DIVERGENT boundary heuristics, so the same log
 * prefix segmented differently live vs after a reload: stable ids shifted, the
 * persisted pin missed, and resolveDisplaySessions silently fell back — one of
 * the root causes of the intermittent wrong-session anchoring.
 *
 * Both paths now share isSessionBoundary (clearCheckpoint.js). This suite runs
 * one entry sequence through BOTH production pipelines and asserts identical
 * session counts and identical stable ids:
 *
 *   batch: createEntrySlimmer (process + finalize — the slim pass runs BEFORE
 *          boundary detection in production and empties compact-continuation
 *          messages, which is exactly why the _compactContinuation flag exists)
 *          → applyBatchEntryTimestamps → mergeMainAgentSessions
 *   live:  isSessionBoundary → assignMessageTimestamps →
 *          applyInPlaceLastMsgReplace (with the COMPUTED boundary) →
 *          mergeMainAgentSessions({ skipTransientFilter: true })
 *
 * KEEP IN SYNC: the two leg helpers below mirror AppBase.jsx _processOneEntry
 * and _flushPendingEntries. If the production call order around
 * applyBatchEntryTimestamps / isSessionBoundary changes, update these mirrors.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntrySlimmer } from '../src/utils/entry-slim.js';
import { mergeMainAgentSessions, isMergeBlockedEntry } from '../src/utils/sessionMerge.js';
import {
  applyBatchEntryTimestamps,
  assignMessageTimestamps,
  applyInPlaceLastMsgReplace,
  getSessionStableId,
} from '../src/utils/sessionManager.js';
import { isSessionBoundary } from '../src/utils/clearCheckpoint.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AUTO_COMPACT_TEXT = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier discussion.';

function msg(i, role, text) {
  return { role, content: [{ type: 'text', text: text || `msg-${i}-${role}-content` }] };
}

/** n alternating user/assistant messages; optional custom first text */
function conv(n, { firstText, seed = '' } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    out.push(msg(i, role, i === 0 && firstText ? firstText : `${seed}msg-${i}-${role}`));
  }
  return out;
}

function entryOf(messages, ts, userId = 'u1') {
  return {
    timestamp: ts,
    mainAgent: true,
    url: 'https://api.anthropic.com/v1/messages',
    body: { messages, metadata: { user_id: userId } },
    response: { status: 200, body: { content: [{ type: 'text', text: 'resp' }] } },
  };
}

const deepCopy = (o) => JSON.parse(JSON.stringify(o));

// ─── Pipeline mirrors ────────────────────────────────────────────────────────

/** Production batch reload: slim pass first, then boundary+timestamps, then merge. */
function runBatchLeg(fileEntries) {
  const entries = fileEntries.map(deepCopy);
  const slimmer = createEntrySlimmer((e) => !!e.mainAgent);
  const acc = [];
  for (let i = 0; i < entries.length; i++) {
    slimmer.process(entries[i], acc, i);
    acc.push(entries[i]);
  }
  slimmer.finalize(acc);

  const st = { timestamps: [], generatedTimestamps: [], currentSessionId: null, prevUserId: null, prevMainAgentTs: null, sessions: [] };
  for (const entry of acc) {
    if (!(entry.mainAgent && entry.body && Array.isArray(entry.body.messages))) continue;
    applyBatchEntryTimestamps(st, entry);
    if (!entry._slimmed && !isMergeBlockedEntry(entry, { batch: true })) {
      st.sessions = mergeMainAgentSessions(st.sessions, entry);
    }
  }
  return st.sessions;
}

/** Production live SSE: entries arrive unslimmed, one at a time. */
function runLiveLeg(fileEntries) {
  let sessions = [];
  let prevMainAgentTs = null;
  for (const raw of fileEntries) {
    const entry = deepCopy(raw);
    if (!(entry.mainAgent && entry.body && Array.isArray(entry.body.messages))) continue;
    if (entry._slimmed || isMergeBlockedEntry(entry)) continue;
    const timestamp = entry.timestamp;
    const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;
    const prevMessages = lastSession?.messages || [];
    const prevCount = prevMessages.length;
    const messages = entry.body.messages;
    const userId = entry.body.metadata?.user_id || null;

    const isNewSession = isSessionBoundary(entry, {
      prevCount,
      count: messages.length,
      prevUserId: lastSession ? lastSession.userId : null,
      userId,
    });
    if (isNewSession) prevMainAgentTs = null;

    assignMessageTimestamps(messages, prevMessages, isNewSession, prevCount, timestamp, prevMainAgentTs);
    const r = applyInPlaceLastMsgReplace(sessions, entry, timestamp, isNewSession);
    sessions = r.applied
      ? r.sessions
      : mergeMainAgentSessions(sessions, entry, { skipTransientFilter: true });
    prevMainAgentTs = timestamp;
  }
  return sessions;
}

function stableIds(sessions) {
  return sessions.map(getSessionStableId);
}

function assertParity(fileEntries, label) {
  const batch = runBatchLeg(fileEntries);
  const live = runLiveLeg(fileEntries);
  assert.equal(batch.length, live.length,
    `${label}: session counts diverge — batch ${batch.length}, live ${live.length}`);
  assert.deepEqual(stableIds(batch), stableIds(live),
    `${label}: stable ids diverge — batch ${JSON.stringify(stableIds(batch))}, live ${JSON.stringify(stableIds(live))}`);
  return { batch, live };
}

// ─── Cases ───────────────────────────────────────────────────────────────────

const T1 = '2026-07-01T08:00:00.000Z';
const T2 = '2026-07-01T09:00:00.000Z';
const T3 = '2026-07-01T10:00:00.000Z';
const T4 = '2026-07-01T11:00:00.000Z';

describe('session-boundary parity — /compact continuation survives the slim pass (P0)', () => {
  // Long session → /compact continuation (>4 msgs) → follow-up growth.
  // In production the follow-up entry slims the compact entry (messages emptied),
  // so without the _compactContinuation flag the batch leg would split at the
  // compact and derive a different stable id than the live leg.
  const longSession = conv(30);
  const compactMsgs = [msg(0, 'user', AUTO_COMPACT_TEXT), ...conv(9).map((m, i) => msg(i + 1, m.role, `post-compact-${i}`))];
  const followUp = [...compactMsgs.map(deepCopy), msg(10, 'user', 'next question'), msg(11, 'assistant', 'next answer')];
  const entries = [
    entryOf(longSession, T1),
    entryOf(compactMsgs, T2),
    entryOf(followUp, T3),
  ];

  it('premise guard: the slim pass really empties the compact entry (else this suite proves nothing)', () => {
    // The P0 scenario only exists because the follow-up entry slims the compact
    // entry BEFORE boundary detection runs. If a future slimmer change stops
    // slimming it, isCompactContinuation would still see the summary and these
    // parity tests would pass without exercising the _compactContinuation flag.
    const copies = entries.map(deepCopy);
    const slimmer = createEntrySlimmer((e) => !!e.mainAgent);
    const acc = [];
    for (let i = 0; i < copies.length; i++) {
      slimmer.process(copies[i], acc, i);
      acc.push(copies[i]);
    }
    slimmer.finalize(acc);
    assert.equal(acc[1]._slimmed, true, 'compact entry must be slimmed by the follow-up');
    assert.equal(acc[1].body.messages.length, 0, 'compact entry messages must be emptied');
    assert.equal(acc[1]._compactContinuation, true, 'flag must be stamped before slimming');
  });

  it('batch and live segment identically with identical stable ids', () => {
    const { batch } = assertParity(entries, 'compact-continuation');
    assert.equal(batch.length, 1, 'compact continuation must stay one logical session');
  });

  it('stable id is the ORIGINAL session start ts, not the compact entry ts', () => {
    const { batch, live } = assertParity(entries, 'compact-continuation-id');
    assert.equal(getSessionStableId(batch[0]), T1);
    assert.equal(getSessionStableId(live[0]), T1);
  });

  it('post-compact growth gets fresh timestamps in both legs (accumulator truncation)', () => {
    const { batch, live } = assertParity(entries, 'compact-continuation-fresh-ts');
    const lastBatch = batch[0].messages[batch[0].messages.length - 1];
    const lastLive = live[0].messages[live[0].messages.length - 1];
    assert.equal(lastBatch._timestamp, T3);
    assert.equal(lastLive._timestamp, T3);
  });
});

describe('session-boundary parity — same-user new-terminal bigDrop', () => {
  // A fresh terminal session from the same user: big drop, msg[0] is a genuine
  // user prompt (not a compact summary) → both legs must treat it as a boundary
  // and derive the NEW entry ts as the current session id.
  const entries = [
    entryOf(conv(30), T1),
    entryOf(conv(6, { firstText: 'brand new terminal prompt', seed: 'nt-' }), T2),
    entryOf([...conv(6, { firstText: 'brand new terminal prompt', seed: 'nt-' }), msg(6, 'user', 'more'), msg(7, 'assistant', 'ok')], T3),
  ];

  it('batch and live agree, and the derived current-session id is the new terminal start', () => {
    const { batch, live } = assertParity(entries, 'new-terminal');
    assert.equal(getSessionStableId(batch[batch.length - 1]), T2);
    assert.equal(getSessionStableId(live[live.length - 1]), T2);
  });
});

describe('session-boundary parity — live user_id change (duplicate stable id regression)', () => {
  // Before the shared predicate, the live path had no user_id trigger: merge
  // appended a new session while assignMessageTimestamps positionally inherited
  // the OLD session's first _timestamp → two sessions with the SAME stable id,
  // and the pin resolved to the older one.
  const entries = [
    entryOf(conv(20, { seed: 'u1-' }), T1, 'u1'),
    entryOf(conv(25, { seed: 'u2-' }), T2, 'u2'),
    entryOf([...conv(25, { seed: 'u2-' }), msg(25, 'user', 'more'), msg(26, 'assistant', 'ok')], T4, 'u2'),
  ];

  it('batch and live agree with two distinct sessions', () => {
    const { batch, live } = assertParity(entries, 'userid-change');
    assert.equal(batch.length, 2);
    assert.deepEqual(stableIds(batch), [T1, T2]);
    assert.deepEqual(stableIds(live), [T1, T2]);
  });

  it('no duplicate stable ids in the live leg', () => {
    const live = runLiveLeg(entries);
    const ids = stableIds(live);
    assert.equal(new Set(ids).size, ids.length, `duplicate stable ids: ${JSON.stringify(ids)}`);
  });
});

describe('session-boundary parity — post-/clear checkpoint', () => {
  // /clear always splits in both legs, even for a 1-message checkpoint.
  const clearMsg = {
    role: 'user',
    content: [{ type: 'text', text: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' }],
  };
  const clearEntry = { ...entryOf([clearMsg], T2), _isCheckpoint: true, _deltaFormat: 1, _totalMessageCount: 1 };
  const entries = [
    entryOf(conv(30), T1),
    clearEntry,
    entryOf([deepCopy(clearMsg), msg(1, 'assistant', 'fresh answer'), msg(2, 'user', 'q'), msg(3, 'assistant', 'a'), msg(4, 'user', 'q2'), msg(5, 'assistant', 'a2')], T3),
  ];

  it('batch and live agree: /clear starts a new session anchored at the checkpoint ts', () => {
    const { batch, live } = assertParity(entries, 'post-clear');
    assert.equal(batch.length, 2);
    assert.equal(getSessionStableId(batch[1]), T2);
    assert.equal(getSessionStableId(live[1]), T2);
  });
});
