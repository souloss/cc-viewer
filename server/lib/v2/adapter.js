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
// Teammate re-join (spec §10): reading a leader session merges in every sibling
// session whose meta.leader.parentSessionId points at it, ordered by ts with
// (sessionId, seq) tie-break — field-equivalent to v1's "teammate writes the
// leader's file".

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { reportSwallowed } from '../error-report.js';
import { isMainAgentRequest } from '../interceptor-core.js';
import { firstUserPromptText } from './identity.js';
import { readSession, readJsonlTolerant, listSessionIds } from './replay.js';
import { blobPath, isSupportedWireFormat } from './layout.js';

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

/** Parsed-blob cache, one per generator run: refs repeat across most requests
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
 * Generator over ONE session dir: yields { ts, sessionId, seq, raw } in seq
 * order, where raw is the synthesized v1-shape JSON string.
 * @param {string} sessionDir - absolute session directory
 * @param {{teammateOf?: object}} [opts] - meta.leader of this session when it is
 *   being re-joined into (or read as) a teammate stream
 */
function* iterateSessionEntries(sessionDir, opts = {}) {
  const projectDir = dirname(dirname(sessionDir));
  const sessionId = basename(sessionDir);
  const session = readSession(projectDir, sessionId);
  if (session.unsupported) {
    // Reader version gate (spec §14): never interpret a session stamped with a
    // version this build doesn't understand — refuse loudly, yield nothing.
    reportSwallowed('v2-read.unsupported-wire-format', new Error(`${sessionId}: wireFormat=${session.wireFormat}`));
    return;
  }
  const meta = session.meta || {};
  const paths = { blobsDir: join(sessionDir, 'blobs') };
  const loadBlob = makeBlobLoader(paths, sessionId);
  const responses = readResponsesRaw(sessionDir);
  const leader = opts.teammateOf || meta.leader || null;

  // Per-conversation mechanical replay state + event cursor. Events arrive
  // sorted by seq (readSession sorts); a cursor per conv applies them as the
  // journal walk passes their seq. Conv lines whose seq has no journal req are
  // crash orphans — never applied (spec §14).
  const convState = new Map(); // convKey → { events, ptr, state: Array }
  const convOf = (key) => {
    let st = convState.get(key);
    if (!st) {
      st = { events: session.convEvents.get(key) || [], ptr: 0, state: [] };
      convState.set(key, st);
    }
    return st;
  };

  const seqs = [...session.reqs.keys()].sort((a, b) => a - b);
  for (const seq of seqs) {
    const req = session.reqs.get(seq);
    const done = session.dones.get(seq) || null;

    // Apply this conversation's events up to and including this seq.
    const applied = [];
    let conv = null;
    if (req.conv) {
      conv = convOf(req.conv);
      while (conv.ptr < conv.events.length && conv.events[conv.ptr].seq <= seq) {
        const ev = conv.events[conv.ptr++];
        if (!session.reqs.has(ev.seq)) continue; // crash orphan (spec §14)
        if (ev.t === 'snapshot') {
          conv.state = Array.isArray(ev.msgs) ? ev.msgs : [];
        } else if (ev.t === 'append') {
          if (Array.isArray(ev.msgs) && ev.msgs.length > 0) conv.state = conv.state.concat(ev.msgs);
        } else if (ev.t === 'ctl' && ev.op === 'replace-tail' && ev.msg && conv.state.length > 0) {
          conv.state = conv.state.slice(0, -1).concat([ev.msg]);
        } // ctl compact: marker only — the same request's snapshot carries the state
        if (ev.seq === seq) applied.push(ev);
      }
      // Journal says a conversation event exists but the line is not on disk
      // yet (write-order window, §14 pendingTail) or is lost: emitting a delta
      // against a state that is missing that slice would poison the client's
      // reconstruction, so the request is skipped — the next cold read (or the
      // S6b watcher tick) retries with the line present.
      if (req.evt && applied.length === 0) {
        reportSwallowed('v2-read.missing-conv-event', new Error(`${sessionId}/${req.conv} seq=${seq} evt=${req.evt}`));
        continue;
      }
      if (!req.evt && typeof req.msgTo === 'number' && req.msgTo !== conv.state.length) {
        // No-event request whose recorded wire count disagrees with the replayed
        // state — an earlier line of this conv is missing. Skip rather than emit
        // a wrong-count envelope the client would flag as broken.
        reportSwallowed('v2-read.state-count-mismatch', new Error(`${sessionId}/${req.conv} seq=${seq} msgTo=${req.msgTo} replayed=${conv.state.length}`));
        continue;
      }
    }

    // ---- body (blob backfill is per-request by journal ref — never carried) --
    const tools = loadBlob(req.blobs && req.blobs.tools);
    const system = loadBlob(req.blobs && req.blobs.sys);
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
      project: meta.project || basename(projectDir),
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
        entry._seqEpoch = `v2:${sessionId}`;
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

    // ---- completion / in-flight --------------------------------------------
    if (done) {
      const respRaw = responses.get(seq);
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
    } else {
      // req without done — in-flight or the process died (spec §4). This IS the
      // v1 placeholder, so it wears the same flags.
      entry.inProgress = true;
      entry.requestId = req.rid || `${seq}`;
    }

    yield { ts: req.ts || '', sessionId, seq, raw: JSON.stringify(entry) };
  }
}

/** Sibling sessions whose meta.leader points at this session (spec §10). */
function findTeammateSessionDirs(sessionDir) {
  const sessionsRoot = dirname(sessionDir);
  const leaderSid = basename(sessionDir);
  const out = [];
  let names = [];
  try {
    names = readdirSync(sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === leaderSid) continue;
    const dir = join(sessionsRoot, name);
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
      const l = meta && meta.leader;
      // The writer records parentSessionId (interceptor.js); tolerate the spec's
      // original sessionId spelling for hand-built or future dirs.
      if (l && (l.parentSessionId === leaderSid || l.sessionId === leaderSid)) {
        out.push({ dir, leader: l });
      }
    } catch { /* not a readable session dir — skip */ }
  }
  return out;
}

/**
 * Main entry: iterate one v2 session as a v1-shape raw-entry stream, teammate
 * sessions re-joined. Yields raw JSON strings (same contract as
 * log-stream.iterateRawEntries).
 * @param {string} sessionDir - absolute LOG_DIR/<project>/sessions/<sid>
 */
export function* iterateV2RawEntries(sessionDir) {
  const streams = [iterateSessionEntries(sessionDir)];
  const ownMeta = (() => {
    try { return JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf-8')); } catch { return null; }
  })();
  // A teammate session read directly renders itself (tagged via its own meta.
  // leader inside iterateSessionEntries); only a LEADER pulls in siblings.
  if (!ownMeta || !ownMeta.leader) {
    for (const tm of findTeammateSessionDirs(sessionDir)) {
      streams.push(iterateSessionEntries(tm.dir, { teammateOf: tm.leader }));
    }
  }
  if (streams.length === 1) {
    for (const item of streams[0]) yield item.raw;
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
    yield heads[best].cur.value.raw;
    heads[best].cur = heads[best].s.next();
  }
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

function dirSizeSync(dir) {
  let total = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return total; }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeSync(p);
      else if (e.isFile()) total += statSync(p).size;
    } catch { /* raced deletion — skip */ }
  }
  return total;
}

/**
 * Summarize every session under LOG_DIR/<project>/ for the log list (spec §12).
 * Deliberately cheap: journal lines only (small) + a bounded head read of the
 * main conversation's first epoch for the preview — conversation bodies are
 * never loaded. Teammate linkage is surfaced via `leader` so the caller can
 * fold those sessions into their leader's view instead of double-listing.
 * @returns {Array<{sid, dir, startTs, instanceId, leader, turns, size, preview}>}
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

      // preview = first user prompt of the main conversation's first epoch.
      let preview = '';
      const first = readFirstJsonLine(join(dir, 'conversations', 'main', 'e0.jsonl'));
      if (first && Array.isArray(first.msgs)) {
        preview = firstUserPromptText(first.msgs).slice(0, 200);
      }

      out.push({
        sid,
        dir,
        startTs: (meta && meta.startTs) || '',
        instanceId: (meta && meta.instanceId) || null,
        leader: (meta && meta.leader) || null,
        turns,
        size: dirSizeSync(dir),
        preview,
      });
    } catch { /* one unreadable session must not break the list */ }
  }
  return out;
}
