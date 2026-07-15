// Wire Format v2 — v2→v1 adapter read layer (docs/refactor/WIRE_FORMAT_V2.md §11).
//
// Synthesizes a v1-shape raw-entry stream from a v2 session directory so the
// existing log-stream consumers (SSE cold load, tail read, paging, download)
// work unchanged. The synthesis is MECHANICAL replay (same semantics as
// replay.js): conversation events are applied exactly as the write side derived
// them; no reverse-anchor/merge inference happens here — the client applies its
// own sessionMerge to the synthesized stream exactly like it does to v1 logs.
//
// Envelope equivalence to v1 (per request, main conversation):
//   snapshot event        → checkpoint (_isCheckpoint:true, full state)
//   ctl replace-tail      → checkpoint + _inPlaceReplaceDetected (paired signal)
//   append event          → delta (_isCheckpoint:false, the appended slice)
//   no event (wire unchanged) → empty delta (v1 wrote those too)
// Entries are yielded in journal seq order (initiation order), so the client's
// completion-order guard never fires: _staleReorder/_reconstructBroken are
// structurally impossible on this stream (spec §11 "绝不输出").
//
// SINGLE SYNTHESIS PATH (S6b): SessionSynthesizer below is the one and only
// implementation of the per-event envelope synthesis. The cold generators feed
// it eagerly (all lines up front, defer disabled); the live feed
// (server/lib/v2/live-feed.js) feeds it incrementally from file cursors, so
// cold reads and live emission are byte-identical by construction.
//
// Teammate re-join (spec §10): reading a leader session merges in every sibling
// session whose meta.leader.parentSessionId points at it, ordered by ts with
// (sessionId, seq) tie-break — field-equivalent to v1's "teammate writes the
// leader's file".

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { reportSwallowed } from '../error-report.js';
import { isMainAgentRequest } from '../interceptor-core.js';
import { readPromptsHead, collectPromptsFromEvents } from '../user-prompt-extract.js';
import { readSession, readJsonlTolerant, listSessionIds } from './replay.js';
import { blobPath, isSupportedWireFormat, dirSizeSync } from './layout.js';

// Same stamping rules as the v1 interceptor (KEEP IN SYNC: server/interceptor.js
// requestEntry construction) — recomputed from the journal's url, not from kind,
// so edge cases (a countTokens body that also looks main-agent) fold the same way.
const HEARTBEAT_URL_RE = /\/api\/eval\/sdk-/;
const COUNT_TOKENS_URL_RE = /\/messages\/count_tokens/;

/** A v2 read source is a session DIRECTORY containing a journal.jsonl. */
export function isV2SessionDir(p) {
  if (typeof p !== 'string' || p === '') return false;
  try {
    if (!statSync(p).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(p, 'journal.jsonl'));
}

/** responses.jsonl folded by seq (first line wins, mirroring §14 done-folding).
 *  Values stay RAW strings — parsed one at a time at yield to keep peak memory
 *  at "one response", not "all responses" (plan F16). */
function readResponsesRaw(sessionDir) {
  const bySeq = new Map();
  const p = join(sessionDir, 'responses.jsonl');
  if (!existsSync(p)) return bySeq;
  let raw = '';
  try { raw = readFileSync(p, 'utf-8'); } catch { return bySeq; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/"seq":\s*(\d+)/);
    if (!m) continue;
    const seq = Number(m[1]);
    if (!bySeq.has(seq)) bySeq.set(seq, t);
  }
  return bySeq;
}

/** Parsed-blob cache, one per synthesizer: refs repeat across most requests
 *  (that is the whole point of the CAS), so each distinct blob is read+parsed
 *  once. Objects are shared by reference — safe, entries are stringified
 *  immediately and never mutated. */
function makeBlobLoader(paths, sessionId) {
  const cache = new Map();
  return (ref) => {
    if (!ref) return undefined;
    if (cache.has(ref)) return cache.get(ref);
    let value;
    try {
      value = JSON.parse(readFileSync(blobPath(paths, ref), 'utf-8'));
    } catch (err) {
      // Orphan journal reference (spec §14): tolerate, surface, keep reading.
      reportSwallowed('v2-read.blob-missing', new Error(`${sessionId}/${ref}: ${err.message}`));
      value = undefined;
    }
    cache.set(ref, value);
    return value;
  };
}

/**
 * Incremental per-event synthesis engine — the single synthesis path shared by
 * the cold generators and the live feed.
 *
 * Feeding contract (mirrors the writer's per-file append order, which is
 * seq-ascending for journal req lines and file order for conversation event
 * lines):
 *   ingestJournalLine(parsedLine)   — 'meta' | 'req' | 'done' phases
 *   ingestConvLine(convKey, event)  — conversation event lines, file order
 *   ingestResponseLine(rawLine)     — responses.jsonl lines (raw strings)
 * Synthesized items accumulate internally; callers collect them via drain().
 *
 * Item shape: { ts, sessionId, seq, phase: 'placeholder'|'completed',
 *               entry, isMain, stateRef }
 * `entry` is the v1-shape object (stringify on receipt: a live placeholder's
 * entry object is MUTATED in place into its completed form when the done
 * arrives, exactly so both stringify byte-identical to a cold read).
 * `stateRef` is the conversation state array as of this seq (immutably
 * replaced by the replay, so the reference stays valid) — used by the window
 * mode to synthesize a baseline checkpoint at an arbitrary start seq.
 *
 * Live-mode ordering hazards handled here (S6b review):
 * - A journal req line can land before its own conversation event line
 *   (write-order window, spec §14). Cold reads retry for free on the next full
 *   read; an incremental cursor has already consumed the journal line, so the
 *   request is parked per-conversation and retried when the event arrives.
 *   deferMs=0 (cold) degrades to the historical skip-immediately behavior.
 * - A done line can land before its responses.jsonl line (cross-path queue
 *   groups). Every completion writes a responses line, so the done is parked
 *   until the line arrives, with a deadline fallback to a null response.
 * - Orphan safety: journal req lines are strictly seq-ascending within one
 *   journal file, so at the time req N is processed every req ≤ N that will
 *   ever exist is known — the crash-orphan check is exact even incrementally.
 */
export class SessionSynthesizer {
  /**
   * @param {string} sessionDir - absolute session directory
   * @param {object} [opts]
   * @param {object|null} [opts.teammateOf] - meta.leader of this session when
   *   it is being re-joined into (or read as) a teammate stream
   * @param {number} [opts.deferMs] - how long live mode parks a request whose
   *   conversation event (or a done whose response line) has not landed yet.
   *   0 = cold semantics: skip immediately, next full read self-heals.
   * @param {Function} [opts.now] - clock injection (tests)
   */
  constructor(sessionDir, opts = {}) {
    this.sessionDir = sessionDir;
    this.projectDir = dirname(dirname(sessionDir));
    this.sessionId = basename(sessionDir);
    this._deferMs = typeof opts.deferMs === 'number' ? opts.deferMs : 0;
    this._now = opts.now || Date.now;
    let meta = null;
    try { meta = JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf-8')); } catch { /* tolerated — journal is self-describing */ }
    this._meta = meta || {};
    this._leader = opts.teammateOf || this._meta.leader || null;
    this._loadBlob = makeBlobLoader({ blobsDir: join(sessionDir, 'blobs') }, this.sessionId);
    this.unsupported = false;
    if (meta && meta.wireFormat != null && !isSupportedWireFormat(meta.wireFormat)) {
      this._markUnsupported(meta.wireFormat);
    }
    this._reqs = new Map();      // seq → journal req line
    this._dones = new Map();     // seq → journal done line (first wins, §14)
    this._responses = new Map(); // seq → raw responses.jsonl line (first wins)
    this._convs = new Map();     // convKey → {events, ptr, state, queue, deferSince}
    this._await = new Map();     // seq → item built, waiting for its done
    this._doneWaitingResp = new Map(); // seq → parkedAtMs (done before responses line)
    this._out = [];
  }

  _markUnsupported(v) {
    if (this.unsupported) return;
    // Reader version gate (spec §14): never interpret a session stamped with a
    // version this build doesn't understand — refuse loudly, emit nothing.
    this.unsupported = true;
    reportSwallowed('v2-read.unsupported-wire-format', new Error(`${this.sessionId}: wireFormat=${v}`));
  }

  _conv(key) {
    let c = this._convs.get(key);
    if (!c) {
      c = { events: [], ptr: 0, state: [], queue: [], deferSince: null };
      this._convs.set(key, c);
    }
    return c;
  }

  /** Feed one parsed journal line ('meta' sentinel, 'req', or 'done'). */
  ingestJournalLine(line) {
    if (this.unsupported || !line || typeof line !== 'object') return;
    if (line.ph === 'meta') {
      if (typeof line.wireFormat === 'number' && !isSupportedWireFormat(line.wireFormat)) {
        this._markUnsupported(line.wireFormat);
      }
      return;
    }
    if (line.ph === 'req') {
      if (this._reqs.has(line.seq)) return;
      this._reqs.set(line.seq, line);
      if (line.conv) {
        const c = this._conv(line.conv);
        c.queue.push(line.seq);
        this._pumpConv(line.conv, c);
      } else {
        // Conversation-less request (heartbeat): nothing to gate on.
        this._emit(line, null, []);
      }
      return;
    }
    if (line.ph === 'done') {
      if (this._dones.has(line.seq)) return; // fold duplicate done lines (§14)
      this._dones.set(line.seq, line);
      this._tryComplete(line.seq);
    }
  }

  /** Feed one conversation event line. Events are kept SEQ-SORTED on insert:
   *  file order across epoch files is NOT globally seq-ordered (a restarted
   *  writer historically appended newer seqs into an older epoch file, and the
   *  cold reader has always sorted globally — replay.js). The monotonic pump
   *  pointer requires the sorted invariant or a late-lower-seq event strands
   *  behind it forever (2026-07-15 fix: live missing-conv-event /
   *  state-count-mismatch false alarms). In-order arrival stays O(1). */
  ingestConvLine(convKey, ev) {
    if (this.unsupported || !ev || typeof ev !== 'object') return;
    const c = this._conv(convKey);
    const events = c.events;
    if (events.length === 0 || ev.seq >= events[events.length - 1].seq) {
      events.push(ev);
    } else {
      let i = events.length - 1;
      while (i >= c.ptr && events[i].seq > ev.seq) i--;
      events.splice(i + 1, 0, ev);
    }
    this._pumpConv(convKey, c);
  }

  /** Feed one raw responses.jsonl line. */
  ingestResponseLine(rawLine) {
    if (this.unsupported) return;
    const t = String(rawLine).trim();
    const m = t.match(/"seq":\s*(\d+)/);
    if (!m) return;
    const seq = Number(m[1]);
    if (!this._responses.has(seq)) this._responses.set(seq, t);
    if (this._doneWaitingResp.has(seq)) {
      this._doneWaitingResp.delete(seq);
      this._complete(seq);
    }
  }

  /** Collect synthesized items accumulated since the last drain. */
  drain() {
    if (this._out.length === 0) return [];
    const out = this._out;
    this._out = [];
    return out;
  }

  /** True when a deferred request or done is parked (live watcher uses this to
   *  keep its safety poll armed). */
  hasPending() {
    if (this._doneWaitingResp.size > 0) return true;
    for (const c of this._convs.values()) if (c.deferSince != null) return true;
    return false;
  }

  /** Live mode: force progress past deferrals older than deferMs. */
  sweepDeadlines() {
    const now = this._now();
    for (const [key, c] of this._convs) {
      if (c.deferSince != null && now - c.deferSince >= this._deferMs) {
        this._pumpConv(key, c, { forceHead: true });
      }
    }
    for (const [seq, parkedAt] of [...this._doneWaitingResp]) {
      if (now - parkedAt >= this._deferMs) {
        this._doneWaitingResp.delete(seq);
        this._complete(seq);
      }
    }
  }

  /** Process this conversation's request queue as far as the arrived events
   *  allow. forceHead skips the (expired) head request cold-style. */
  _pumpConv(convKey, c, { forceHead = false } = {}) {
    while (c.queue.length > 0) {
      const seq = c.queue[0];
      const req = this._reqs.get(seq);
      // Apply this conversation's events up to and including this seq.
      const applied = [];
      while (c.ptr < c.events.length && c.events[c.ptr].seq <= seq) {
        const ev = c.events[c.ptr++];
        if (!this._reqs.has(ev.seq)) continue; // crash orphan (spec §14)
        if (ev.t === 'snapshot') {
          c.state = Array.isArray(ev.msgs) ? ev.msgs : [];
        } else if (ev.t === 'append') {
          if (Array.isArray(ev.msgs) && ev.msgs.length > 0) c.state = c.state.concat(ev.msgs);
        } else if (ev.t === 'ctl' && ev.op === 'replace-tail' && ev.msg && c.state.length > 0) {
          c.state = c.state.slice(0, -1).concat([ev.msg]);
        } // ctl compact: marker only — the same request's snapshot carries the state
        if (ev.seq === seq) applied.push(ev);
      }

      // Gate: journal says a conversation event exists but the line is not on
      // disk yet (write-order window, §14 pendingTail) or is lost. Emitting a
      // delta against a state missing that slice would poison the client's
      // reconstruction — park (live) or skip (cold/expired); a skip is safe
      // because the next cold read retries with the line present.
      let gap = null;
      if (req.evt && applied.length === 0) {
        gap = () => reportSwallowed('v2-read.missing-conv-event', new Error(`${this.sessionId}/${req.conv} seq=${seq} evt=${req.evt}`));
      } else if (!req.evt && typeof req.msgTo === 'number' && req.msgTo !== c.state.length) {
        // No-event request whose recorded wire count disagrees with the
        // replayed state — an earlier line of this conv is missing.
        gap = () => reportSwallowed('v2-read.state-count-mismatch', new Error(`${this.sessionId}/${req.conv} seq=${seq} msgTo=${req.msgTo} replayed=${c.state.length}`));
      }
      if (gap) {
        if (this._deferMs > 0 && !forceHead) {
          if (c.deferSince == null) c.deferSince = this._now();
          return; // parked — a later ingest or sweepDeadlines resumes the pump
        }
        gap();
        c.queue.shift();
        c.deferSince = null;
        forceHead = false;
        continue;
      }

      c.deferSince = null;
      c.queue.shift();
      forceHead = false;
      this._emit(req, c, applied);
    }
    // Live-mode memory bound (review P2): applied events are never re-read —
    // drop the consumed prefix so a long session doesn't keep every slice
    // resident. Thresholded so the cold path's per-req pumping doesn't turn
    // this into an O(n²) shift storm. (State arrays are shared immutably;
    // this only trims the event-line objects.)
    if (c.ptr > 64 && c.queue.length === 0) {
      c.events.splice(0, c.ptr);
      c.ptr = 0;
    }
  }

  /** Build the v1-shape entry for one request and emit it (placeholder now /
   *  completed when the done is already known). */
  _emit(req, conv, applied) {
    const seq = req.seq;
    const meta = this._meta;
    const leader = this._leader;

    // ---- body (blob backfill is per-request by journal ref — never carried) --
    const tools = this._loadBlob(req.blobs && req.blobs.tools);
    const system = this._loadBlob(req.blobs && req.blobs.sys);
    const body = {
      ...(req.model && { model: req.model }),
      ...(system !== undefined && { system }),
      ...(tools !== undefined && { tools }),
      ...(meta.userIdRaw && { metadata: { user_id: meta.userIdRaw } }),
    };

    const isTeammateEntry = !!leader;
    const isMainKind = req.kind === 'main' && !isTeammateEntry;
    const entry = {
      timestamp: req.ts,
      project: meta.project || basename(this.projectDir),
      url: req.url,
      method: req.method || 'POST',
      ...(req.headers && { headers: req.headers }),
      body,
      response: null,
      duration: 0,
      isStream: !!req.isStream,
      isHeartbeat: HEARTBEAT_URL_RE.test(req.url || ''),
      isCountTokens: COUNT_TOKENS_URL_RE.test(req.url || ''),
      mainAgent: false, // finalized below once messages are attached
      ...(isTeammateEntry && { teammate: leader.agentName || true, ...(leader.teamName && { teamName: leader.teamName }) }),
      ...(req.proxy && { proxyProfile: req.proxy.profile, ...(req.proxy.url && { proxyUrl: req.proxy.url }) }),
    };

    // ---- messages + envelope ------------------------------------------------
    if (conv) {
      if (isMainKind) {
        // v1 delta envelope synthesis. The stream is seq-ordered, so the client
        // seq guard sees a strictly increasing sequence in one epoch.
        entry._seq = seq;
        entry._seqEpoch = `v2:${this.sessionId}`;
        entry._deltaFormat = 1;
        entry._totalMessageCount = conv.state.length;
        entry._conversationId = 'mainAgent';
        const snapshot = applied.find((e) => e.t === 'snapshot');
        const replaceTail = applied.find((e) => e.t === 'ctl' && e.op === 'replace-tail');
        const append = applied.find((e) => e.t === 'append');
        if (snapshot || replaceTail || !append) {
          entry._isCheckpoint = !!(snapshot || replaceTail);
          if (replaceTail && !snapshot) {
            entry._isCheckpoint = true;
            // Paired signal (KEEP IN SYNC: src/utils/sessionManager.js
            // applyInPlaceLastMsgReplace) — same protocol as the v1 writer.
            entry._inPlaceReplaceDetected = true;
          }
          entry.body.messages = entry._isCheckpoint ? conv.state : [];
        } else {
          entry._isCheckpoint = false;
          entry.body.messages = Array.isArray(append.msgs) ? append.msgs : [];
        }
      } else {
        // sub / misc / teammate streams are full-messages in v1 (no envelope).
        entry.body.messages = conv.state;
      }
    }

    // v1 stamps mainAgent = isMainAgentRequest(body) at request time; kind
    // 'main' was CLASSIFIED by that same predicate, so it maps back to true
    // directly (its delta body would defeat a recompute). Everything else —
    // teammate dual-tag included — recomputes over the backfilled body.
    entry.mainAgent = isMainKind || isMainAgentRequest(entry.body);

    const item = {
      ts: req.ts || '',
      sessionId: this.sessionId,
      seq,
      phase: 'placeholder',
      entry,
      isMain: isMainKind,
      stateRef: conv ? conv.state : null,
    };
    this._await.set(seq, item);

    if (this._dones.has(seq)) {
      this._tryComplete(seq);
    } else {
      // req without done — in-flight or the process died (spec §4). This IS the
      // v1 placeholder, so it wears the same flags.
      entry.inProgress = true;
      entry.requestId = req.rid || `${seq}`;
      this._out.push(item);
    }
  }

  /** A done is known for this seq — complete now, or park until its responses
   *  line lands (every completion writes one; cross-path flush can reorder). */
  _tryComplete(seq) {
    if (!this._await.has(seq)) return; // req not synthesized yet — _emit retries
    if (this._deferMs > 0 && !this._responses.has(seq) && !this._doneWaitingResp.has(seq)) {
      this._doneWaitingResp.set(seq, this._now());
      return;
    }
    this._doneWaitingResp.delete(seq);
    this._complete(seq);
  }

  _complete(seq) {
    const item = this._await.get(seq);
    const done = this._dones.get(seq);
    if (!item || !done) return;
    this._await.delete(seq);
    // If the placeholder is still queued (req and done landed in the same
    // batch), drop it — its entry object is about to be mutated into the
    // completed form and emitting both would just send the same frame twice.
    const queued = this._out.indexOf(item);
    if (queued !== -1) this._out.splice(queued, 1);
    const entry = item.entry;
    // A live placeholder was already emitted for this entry object; strip its
    // in-flight markers so the completed form stringifies byte-identical to a
    // cold read of the same session.
    delete entry.inProgress;
    delete entry.requestId;
    const respRaw = this._responses.get(seq);
    let resp = null;
    if (respRaw) {
      try { resp = JSON.parse(respRaw); } catch { resp = null; }
    }
    entry.response = {
      ...(typeof done.http === 'number' && { status: done.http }),
      ...(resp && resp.headers && { headers: resp.headers }),
      body: resp ? resp.body : null,
    };
    if (typeof done.dur === 'number') entry.duration = done.dur;
    // Live-mode memory bound (review P2): completed seqs never need their raw
    // response line or done line again — a duplicate done re-arriving is a
    // no-op above (the awaited item is gone). Cold reads drain immediately,
    // so this is pure win there too.
    this._responses.delete(seq);
    this._dones.delete(seq);
    this._out.push({ ...item, phase: 'completed' });
  }
}

/**
 * Cold generator over ONE session dir: yields items (see SessionSynthesizer)
 * in seq order — the eager feeding of the shared synthesis engine.
 */
function* iterateSessionItems(sessionDir, opts = {}) {
  const projectDir = dirname(dirname(sessionDir));
  const sessionId = basename(sessionDir);
  const session = readSession(projectDir, sessionId);
  if (session.unsupported) {
    reportSwallowed('v2-read.unsupported-wire-format', new Error(`${sessionId}: wireFormat=${session.wireFormat}`));
    return;
  }
  const synth = new SessionSynthesizer(sessionDir, { teammateOf: opts.teammateOf, deferMs: 0 });
  if (synth.unsupported) return; // meta gate already reported by the constructor
  // Eager seed: all conversation events, responses, and done lines are known
  // before any req is pumped — every gate then resolves exactly like the
  // historical whole-file read.
  for (const [key, events] of session.convEvents) synth._conv(key).events = events;
  synth._responses = readResponsesRaw(sessionDir);
  synth._dones = session.dones;
  const seqs = [...session.reqs.keys()].sort((a, b) => a - b);
  for (const seq of seqs) {
    synth.ingestJournalLine(session.reqs.get(seq));
    yield* synth.drain();
  }
}

/** Sibling sessions whose meta.leader points at this session (spec §10).
 *
 *  Leaderless fallback (S6b review P1): native team mode spawns teammates with
 *  `--agent-name` but possibly WITHOUT `--parent-session-id`, so meta.leader
 *  carries no sid. Those sessions are attributed to the leader session that was
 *  most recently started at (or before) the teammate's own start — the exact
 *  semantics of v1's findRecentLog ("append to the newest leader log"). */
export function findTeammateSessionDirs(sessionDir) {
  const sessionsRoot = dirname(sessionDir);
  const leaderSid = basename(sessionDir);
  const out = [];
  let names = [];
  try {
    names = readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  const orphans = []; // teammate sessions without a recorded leader sid
  const leaderStarts = []; // {sid, startTs} of every non-teammate session
  let ownStartTs = '';
  for (const name of names) {
    const dir = join(sessionsRoot, name);
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
      const l = meta && meta.leader;
      if (name === leaderSid) {
        ownStartTs = (meta && meta.startTs) || '';
        continue;
      }
      if (!l) {
        leaderStarts.push({ sid: name, startTs: (meta && meta.startTs) || '' });
        continue;
      }
      // The writer records parentSessionId (interceptor.js); tolerate the spec's
      // original sessionId spelling for hand-built or future dirs.
      if (l.parentSessionId === leaderSid || l.sessionId === leaderSid) {
        out.push({ dir, leader: l });
      } else if (!l.parentSessionId && !l.sessionId) {
        orphans.push({ dir, leader: l, startTs: (meta && meta.startTs) || '' });
      }
    } catch { /* not a readable session dir — skip */ }
  }
  for (const o of orphans) {
    // Best temporal match: the latest leader started at or before the teammate.
    // Ties break on sid so exactly ONE leader ever claims an orphan — a strict
    // ">" alone let two leaders sharing a startTs both claim it, duplicating
    // the teammate's traffic into both streams (review P2).
    let best = null; // {startTs, sid}
    if (ownStartTs && ownStartTs <= o.startTs) best = { startTs: ownStartTs, sid: leaderSid };
    for (const cand of leaderStarts) {
      if (!cand.startTs || cand.startTs > o.startTs) continue;
      if (best == null
        || cand.startTs > best.startTs
        || (cand.startTs === best.startTs && cand.sid > best.sid)) {
        best = cand;
      }
    }
    if (best && best.sid === leaderSid) out.push({ dir: o.dir, leader: o.leader });
  }
  return out;
}

/**
 * Item-level iteration of one v2 session with teammate re-join — the shared
 * core of the raw-string generators and the window reader below.
 */
function* iterateV2Items(sessionDir) {
  const streams = [iterateSessionItems(sessionDir)];
  const ownMeta = (() => {
    try { return JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf-8')); } catch { return null; }
  })();
  // A teammate session read directly renders itself (tagged via its own meta.
  // leader inside iterateSessionItems); only a LEADER pulls in siblings.
  if (!ownMeta || !ownMeta.leader) {
    for (const tm of findTeammateSessionDirs(sessionDir)) {
      streams.push(iterateSessionItems(tm.dir, { teammateOf: tm.leader }));
    }
  }
  if (streams.length === 1) {
    yield* streams[0];
    return;
  }
  // k-way merge by (ts, sessionId, seq) — ISO timestamps compare lexically;
  // cross-process seqs are not comparable so sessionId breaks ts ties (§10).
  const heads = streams.map((s) => ({ s, cur: s.next() }));
  for (;;) {
    let best = -1;
    for (let i = 0; i < heads.length; i++) {
      if (heads[i].cur.done) continue;
      if (best === -1) { best = i; continue; }
      const a = heads[i].cur.value;
      const b = heads[best].cur.value;
      if (a.ts < b.ts || (a.ts === b.ts && (a.sessionId < b.sessionId || (a.sessionId === b.sessionId && a.seq < b.seq)))) {
        best = i;
      }
    }
    if (best === -1) return;
    yield heads[best].cur.value;
    heads[best].cur = heads[best].s.next();
  }
}

/**
 * Main entry: iterate one v2 session as a v1-shape raw-entry stream, teammate
 * sessions re-joined. Yields raw JSON strings (same contract as
 * log-stream.iterateRawEntries).
 * @param {string} sessionDir - absolute LOG_DIR/<project>/sessions/<sid>
 */
export function* iterateV2RawEntries(sessionDir) {
  for (const item of iterateV2Items(sessionDir)) yield JSON.stringify(item.entry);
}

/** Async wrapper with periodic event-loop yields (the synthesis itself is CPU
 *  work over small v2 files; the yields keep a live proxy responsive while a
 *  big session is being adapted). */
export async function* iterateV2RawEntriesAsync(sessionDir) {
  let n = 0;
  for (const raw of iterateV2RawEntries(sessionDir)) {
    yield raw;
    if (++n % 20 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Windowed read of a v2 session: dedup (timestamp|url, last wins), optional
 * `before` filter, tail-`limit` slice — and a BASELINE GUARANTEE the byte-tail
 * heuristics of v1 files cannot give: when the window starts on a main-
 * conversation delta, that entry is re-synthesized as a checkpoint carrying
 * the full replayed state at its seq (the adapter holds it for free), so a
 * window is always reconstructable regardless of how sparse the session's
 * organic snapshots are (S6b review P1: expand-to-checkpoint over adapter
 * output could otherwise walk arbitrarily far back or truncate history).
 *
 * @param {string} sessionDir
 * @param {{limit?: number, before?: string|null, onScan?: (raw:string)=>void}} [opts]
 * @returns {Promise<{entries: string[], hasMore: boolean, oldestTimestamp: string, totalCount: number}>}
 */
export async function readV2WindowedEntries(sessionDir, opts = {}) {
  const limit = opts.limit || 0;
  const before = opts.before || null;
  const onScan = opts.onScan || null;
  const dedup = new Map(); // key → rec
  let nokey = 0;
  let n = 0;
  for (const item of iterateV2Items(sessionDir)) {
    const e = item.entry;
    const raw = JSON.stringify(e);
    if (onScan) onScan(raw);
    const key = e.timestamp && e.url ? `${e.timestamp}|${e.url}` : `__nokey_${nokey++}`;
    const isMainDelta = item.isMain && e._deltaFormat === 1 && e._isCheckpoint === false;
    dedup.set(key, {
      raw,
      ts: e.timestamp || '',
      isMain: item.isMain,
      isMainDelta,
      // Rebuild inputs kept ONLY for delta candidates (checkpoints already
      // carry their state; non-main entries need no baseline).
      ...(isMainDelta && { entry: e, stateRef: item.stateRef }),
    });
    if (++n % 20 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  let recs = [...dedup.values()];
  if (before) recs = recs.filter((r) => r.ts && r.ts < before);
  const totalCount = recs.length;
  let hasMore = false;
  if (limit > 0 && recs.length > limit) {
    hasMore = true;
    recs = recs.slice(recs.length - limit);
  }
  // Baseline: if the first main-conversation record in the window is a delta,
  // promote it to a synthesized checkpoint over its replayed state.
  const firstMainIdx = recs.findIndex((r) => r.isMain);
  if (firstMainIdx >= 0 && recs[firstMainIdx].isMainDelta) {
    const src = recs[firstMainIdx];
    const state = src.stateRef || [];
    const rebuilt = { ...src.entry, body: { ...src.entry.body, messages: state } };
    rebuilt._isCheckpoint = true;
    rebuilt._totalMessageCount = state.length;
    recs[firstMainIdx] = { ...src, raw: JSON.stringify(rebuilt) };
  }
  return {
    entries: recs.map((r) => r.raw),
    hasMore,
    oldestTimestamp: recs.length > 0 ? recs[0].ts : '',
    totalCount,
  };
}

// ─── session listing (spec §12, list entry pulled forward from S6a) ─────────

/** Bounded head read: parse the FIRST JSONL line of a file without loading the
 *  whole thing (a main conversation's opening snapshot can be multi-MB; the
 *  list only wants a preview). Returns null on any shortfall. */
function readFirstJsonLine(path, budget = 256 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(budget);
    const n = readSync(fd, buf, 0, budget, 0);
    const head = buf.toString('utf-8', 0, n);
    const nl = head.indexOf('\n');
    if (nl <= 0) return null; // no complete first line inside the budget
    return JSON.parse(head.slice(0, nl));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

/**
 * Summarize every session under LOG_DIR/<project>/ for the log list (spec §12).
 * Deliberately cheap: journal lines only (small) + a bounded head read of the
 * main conversation's first epoch for the preview — conversation bodies are
 * never loaded. Teammate linkage is surfaced via `leader` so the caller can
 * fold those sessions into their leader's view instead of double-listing.
 * @returns {Array<{sid, dir, startTs, leader, turns, size, preview}>}
 */
export function listV2Sessions(projectDir) {
  const out = [];
  for (const sid of listSessionIds(projectDir)) {
    try {
      const dir = join(projectDir, 'sessions', sid);
      if (!existsSync(join(dir, 'journal.jsonl'))) continue;
      let meta = null;
      try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8')); } catch { /* tolerated — journal is self-describing */ }
      if (meta && meta.wireFormat != null && !isSupportedWireFormat(meta.wireFormat)) {
        // Reader version gate (spec §14): don't list a session this build
        // can't read — a garbage preview/turn-count is worse than absence.
        reportSwallowed('v2-read.unsupported-wire-format', new Error(`${sid}: wireFormat=${meta.wireFormat}`));
        continue;
      }

      // turns = main requests that completed (journal two-phase fold). The
      // journal sentinel is checked in the same pass: per §14 the per-file
      // sentinel WINS over meta.json, and readSession/adapter refuse such a
      // session — listing it would show a phantom row that opens empty.
      const reqKind = new Map();
      let turns = 0;
      let sentinelVersion = null;
      for (const line of readJsonlTolerant(join(dir, 'journal.jsonl'))) {
        if (line.ph === 'req') reqKind.set(line.seq, line.kind);
        else if (line.ph === 'done' && reqKind.get(line.seq) === 'main') {
          turns++;
          reqKind.delete(line.seq); // fold duplicate done lines (§14)
        } else if (line.ph === 'meta' && typeof line.wireFormat === 'number' && !isSupportedWireFormat(line.wireFormat)) {
          sentinelVersion = line.wireFormat;
          break;
        }
      }
      if (sentinelVersion != null) {
        reportSwallowed('v2-read.unsupported-wire-format', new Error(`${sid}: wireFormat=${sentinelVersion} (journal sentinel)`));
        continue;
      }

      // preview = ALL user prompts of the session, from the prompts.jsonl
      // display cache (written by V2Writer / the converter; bounded head read
      // so the list stays O(budget) per session). Sessions predating the
      // cache fall back to the first epoch's first line — routed through the
      // shared extractor so command/caveat chrome never leaks into the row.
      let preview = readPromptsHead(join(dir, 'prompts.jsonl'));
      if (preview.length === 0) {
        const first = readFirstJsonLine(join(dir, 'conversations', 'main', 'e0.jsonl'));
        if (first && Array.isArray(first.msgs)) {
          preview = collectPromptsFromEvents([first]);
        }
      }

      out.push({
        sid,
        dir,
        startTs: (meta && meta.startTs) || '',
        leader: (meta && meta.leader) || null,
        turns,
        size: dirSizeSync(dir),
        preview,
      });
    } catch { /* one unreadable session must not break the list */ }
  }
  return out;
}
