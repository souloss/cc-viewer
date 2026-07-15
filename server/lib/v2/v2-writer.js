// Wire Format v2 — write-path orchestrator (docs/refactor/WIRE_FORMAT_V2.md §13).
//
// The single entry point the interceptor's writeEntry seam will call in S3.
// Hard contract: a v2 failure must NEVER disturb the v1 path — every public
// method is fully caught and routed through reportSwallowed (CLAUDE.md rule);
// the caller does not need its own try/catch.
//
// Write-order protocol per request (spec §1.3):
//   blob (sync, fsync barrier) → conversation event lines → journal req line.
// The HARD guarantee is the blob half: a journal line can never reference a
// missing blob (blobs are durable before the line is even enqueued). The conv
// half is best-effort batch grouping — AsyncWriteQueue._drain groups by path at
// first-enqueue position, so when several requests flush in one batch (e.g. the
// cold-start hold queue), a later request's journal line can land before its
// own conv line. The read side tolerates a missing conv tail by design
// (spec §14, pendingTail-style retry), so this is defense-in-depth, not a
// correctness dependency.

import { statfsSync } from 'node:fs';
import { AsyncWriteQueue } from '../async-write-queue.js';
import { reportSwallowed } from '../error-report.js';
import { ensureSessionDirSync } from './layout.js';
import { BlobStore } from './blob-store.js';
import { Journal } from './journal.js';
import { ConversationStore } from './conversation-store.js';
import { parseUserId, classifyKind, ConvResolver } from './identity.js';
import { extractUserTexts, flattenPromptText, isSuggestionMode, readPromptsHead } from '../user-prompt-extract.js';

// Below this many free bytes on the log volume, v2 skips writing and reports
// once — logging must not be the thing that fills the disk (plan risk #9).
const MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1GB

// Hard ceiling on distinct prompts recorded per session in prompts.jsonl —
// keeps both the in-memory dedup set and the side file bounded for extreme
// thousand-turn sessions (the read side additionally caps at a byte budget).
const PROMPTS_MAX_PER_SESSION = 2000;

export class V2Writer {
  /**
   * @param {object} opts
   * @param {string} opts.logDir       - LOG_DIR root
   * @param {string|Function} opts.project - project directory name, or a getter —
   *   workspace mode rebinds the interceptor's _projectName at runtime; a falsy
   *   resolved project makes ingest a no-op (mirrors v1's empty-LOG_FILE no-op)
   * @param {object|null} [opts.leader]     - teammate processes: {agentName, teamName, parentSessionId}
   * @param {boolean} [opts.enabled]   - always on since 1.7.0; `enabled: false`
   *   is honored only as a test seam (fixtures asserting "nothing written")
   * @param {AsyncWriteQueue} [opts.queue]  - injected queue (tests); defaults to a
   *   dedicated instance so v2 volume never head-of-line-blocks v1's queue.
   * @param {number} [opts.minFreeBytes]    - disk guard threshold (tests)
   * @param {Function} [opts.statfs]        - injected statfsSync (tests)
   */
  constructor(opts = {}) {
    this._logDir = opts.logDir || '';
    this._projectFn = typeof opts.project === 'function'
      ? opts.project
      : () => (opts.project || '');
    this._leader = opts.leader || null;
    // 1.7.0: always on in production; opts.enabled === false is honored only
    // as a test seam (fixtures that must assert "nothing written").
    this._enabled = opts.enabled === false ? false : true;
    this._queue = opts.queue || new AsyncWriteQueue(''); // paths are always explicit
    this._minFreeBytes = typeof opts.minFreeBytes === 'number' ? opts.minFreeBytes : MIN_FREE_BYTES;
    this._statfs = opts.statfs || statfsSync;
    // Offline-converter seams (S8): write under a sibling staging dir name,
    // stamp extra meta fields (e.g. {origin:'convert'}), and use exact
    // conversation judgement fingerprints (byte-grade golden gate). Live
    // writers pass none of these.
    this._sessionsDirName = opts.sessionsDirName || 'sessions';
    this._metaExtra = opts.metaExtra || null;
    this._exactConvFps = !!opts.exactConvFps;
    // S6b live feed: called with the session dir after every ingest so the
    // in-process live cursor can read the fresh appends with zero fs-watch
    // latency. Purely a nudge — the feed's data source stays the files.
    this._onActivity = typeof opts.onActivity === 'function' ? opts.onActivity : null;
    this._sessions = new Map(); // sessionId → {paths, blobs, journal, convs, resolver}
    this._currentSid = null;    // last successfully resolved session (fallback routing §8.3)
    this._pendingNoSid = [];    // requests seen before any sid (cold-start heartbeats).
    // Contract with the caller: originalMessages held here must be a reference
    // the caller never MUTATES (the interceptor's original array is only ever
    // REASSIGNED away from body.messages, never mutated in place — safe).
    this._lateHandles = new Map(); // rid → handle for held requests whose completion arrives after the flush
    this._diskGuardTripped = false;
    this._continuedSeen = false;   // P2: wire-level `claude -c` continuation marker
  }

  /** P2: true once any session's FIRST main wire already carried assistant
   *  turns — the wire-level signature of a continued (-c/-r) conversation. */
  sawContinuedSession() { return this._continuedSeen; }

  // 1.7.0: v2 is the only format — the writer is always on. The getter is kept
  // because read-side helpers key off it; the sole write inhibitor left is the
  // in-band disk guard.
  get enabled() { return this._enabled; }

  /** Late wiring seam: the live feed is constructed by server.js AFTER this
   *  writer exists (module init order), so the nudge callback arrives here. */
  setOnActivity(fn) { this._onActivity = typeof fn === 'function' ? fn : null; }

  _session(sessionId, userIdRaw, encoding, project) {
    let s = this._sessions.get(sessionId);
    if (s) return s;
    const meta = {
      pid: process.pid,
      ...(userIdRaw && { userIdRaw }),
      ...(encoding && { userIdEncoding: encoding }),
      ...(this._leader && { leader: this._leader }),
      ...(this._metaExtra || {}),
    };
    const paths = ensureSessionDirSync(this._logDir, project, sessionId, meta, this._sessionsDirName);
    s = {
      paths,
      blobs: new BlobStore(paths),
      journal: new Journal(paths, this._queue),
      convs: new ConversationStore(paths, this._queue, { exactFps: this._exactConvFps }),
      resolver: new ConvResolver(),
    };
    this._sessions.set(sessionId, s);
    return s;
  }

  _diskOk() {
    if (this._diskGuardTripped) return false;
    try {
      const st = this._statfs(this._logDir);
      const free = Number(st.bavail) * Number(st.bsize);
      if (free < this._minFreeBytes) {
        this._diskGuardTripped = true;
        reportSwallowed('v2-write.disk-guard', new Error(`free ${free}B < ${this._minFreeBytes}B — v2 writes disabled for this process`));
        return false;
      }
      return true;
    } catch (err) {
      // statfs failing is not a reason to stop logging — warn once, keep writing.
      reportSwallowed('v2-write.statfs', err);
      return true;
    }
  }

  /**
   * Request-initiation ingest. MUST be called in the interceptor's synchronous
   * initiation segment (same place v1 assigns _seq), with the ORIGINAL messages
   * array captured BEFORE the v1 delta path mutates body.messages in place.
   *
   * @param {object} entry - the fully materialized v1 requestEntry
   * @param {Array|null} originalMessages - pre-mutation body.messages reference
   * @returns {{sid:string, seq:number}|null} handle for ingestCompletion, or
   *   null when disabled/failed (caller passes it back verbatim either way).
   */
  ingestRequest(entry, originalMessages) {
    if (!this._enabled || !entry) return null;
    try {
      const project = this._projectFn();
      if (!project) return null; // workspace not selected yet — mirrors v1's empty-LOG_FILE no-op
      if (!this._diskOk()) return null;

      const parsed = parseUserId(entry.body && entry.body.metadata && entry.body.metadata.user_id);
      let sid;
      if (parsed) {
        sid = parsed.sessionId;
        this._currentSid = sid;
      } else if (this._currentSid) {
        sid = this._currentSid; // §8.3 fallback: route metadata-less requests to the active session
      } else {
        // Cold start before any sid-bearing request: hold in memory; flushed by
        // the first resolved request. Bounded to avoid growing forever on a
        // process that only ever sees metadata-less traffic.
        if (this._pendingNoSid.length < 64) {
          // rid captured NOW: the v1 seam deletes entry.requestId at completion,
          // which can happen before the hold queue flushes (review P3-4 — the
          // held request would otherwise never get its done line).
          this._pendingNoSid.push({ entry, originalMessages, rid: entry.requestId || null });
          return null;
        }
        sid = `noid-${process.pid}-${Date.now()}`;
        this._currentSid = sid;
      }

      const s = this._session(sid, parsed && entry.body.metadata.user_id, parsed && parsed.encoding, project);

      // Flush requests that arrived before the first sid (they belong here).
      // Their handles are parked in _lateHandles so a completion that arrives
      // after the flush still gets its done line (folded by rid).
      if (this._pendingNoSid.length > 0) {
        const pending = this._pendingNoSid.splice(0);
        for (const p of pending) {
          const pseq = this._ingestInto(s, sid, p.entry, p.originalMessages);
          const prid = p.rid; // captured at hold time — the seam may have deleted entry.requestId by now
          if (pseq != null && prid) {
            this._lateHandles.set(prid, { s, sid, seq: pseq, rid: prid });
            if (this._lateHandles.size > 64) {
              this._lateHandles.delete(this._lateHandles.keys().next().value);
            }
          }
        }
      }

      const seq = this._ingestInto(s, sid, entry, originalMessages);
      if (seq != null && this._onActivity) {
        try { this._onActivity(s.paths.dir); } catch { /* nudge only — never disturb the write */ }
      }
      // The handle carries the RESOLVED session object, not just the sid:
      // resetSessions() (workspace switch) clears the _sessions map, and a
      // completion arriving after the switch must still land its done/response
      // lines in the session the request belonged to (review P2: a map lookup
      // at completion time silently dropped them).
      return seq == null ? null : { s, sid, seq, rid: entry.requestId || `${seq}` };
    } catch (err) {
      reportSwallowed('v2-write.ingestRequest', err);
      return null;
    }
  }

  _ingestInto(s, sid, entry, originalMessages) {
    const kind = classifyKind(entry);
    const seq = s.journal.nextSeq();
    const rid = entry.requestId || `${seq}`;
    const msgs = Array.isArray(originalMessages) ? originalMessages
      : (entry.body && Array.isArray(entry.body.messages) ? entry.body.messages : null);

    // P2 wire-level continuation detection: the very first main wire of a
    // session that already carries assistant turns can only be `claude -c`
    // (or -r) resuming an older conversation — a fresh one starts with a
    // single user message. Used by the migrate prompt's `continued` flag.
    if (!this._continuedSeen && kind === 'main' && !s._sawMain && msgs && msgs.length > 1
        && msgs.some((m) => m && m.role === 'assistant')) {
      this._continuedSeen = true;
    }
    if (kind === 'main') s._sawMain = true;

    // 1. Blobs (sync + fsync — the durability barrier).
    const toolsRef = s.blobs.put(entry.body && entry.body.tools);
    const sysRef = s.blobs.put(entry.body && entry.body.system);

    // 2. Conversation event (heartbeats carry no conversation).
    let convKey = null;
    let convResult = null;
    if (kind !== 'heartbeat' && msgs) {
      if (kind === 'main' || kind === 'teammate') convKey = 'main';
      else if (kind === 'sub') convKey = s.resolver.resolveSub(msgs).convKey;
      else convKey = 'misc'; // countTokens & friends: keep wire fidelity under misc
      convResult = s.convs.ingest(convKey, msgs, { seq, rid });
    }

    // 3. Journal req line — LAST, so it never references missing content.
    s.journal.writeReq({
      seq,
      rid,
      ts: entry.timestamp,
      kind,
      ...(convKey && { conv: convKey }),
      ...(convResult && { epoch: convResult.epoch }),
      url: entry.url,
      method: entry.method,
      ...(entry.body && entry.body.model && { model: entry.body.model }),
      ...(entry.isStream && { isStream: true }),
      ...(entry.headers && { headers: entry.headers }),
      ...((toolsRef || sysRef) && { blobs: { ...(toolsRef && { tools: toolsRef }), ...(sysRef && { sys: sysRef }) } }),
      ...(convResult && { msgFrom: convResult.msgFrom, msgTo: convResult.msgTo }),
      ...(convResult && convResult.evt && { evt: convResult.evt }),
      ...(convResult && convResult.boundary && { boundary: convResult.boundary }),
      ...(entry.proxyProfile && { proxy: { profile: entry.proxyProfile, ...(entry.proxyUrl && { url: entry.proxyUrl }) } }),
    });

    // 4. prompts.jsonl display cache — strictly AFTER the journal line (a
    // prompts failure must never cost the request its journal record) and
    // fully caught on its own. Main conversation only; the converter drives
    // this same path, so migrated sessions get the cache for free.
    if (convKey === 'main' && convResult && msgs) {
      try { this._appendPrompts(s, seq, msgs, convResult); }
      catch (err) { reportSwallowed('v2-write.prompts', err); }
    }
    return seq;
  }

  /**
   * Append newly-seen user prompts of the main conversation to the session's
   * `prompts.jsonl` ({seq, texts} lines). Idempotent across process restarts:
   * the dedup set is seeded once from the existing file (bounded head read),
   * so a resume/`-c` snapshot replaying the full history appends nothing new.
   */
  _appendPrompts(s, seq, msgs, convResult) {
    // snapshot (msgFrom=0, full wire), append (new tail) — and replace-tail:
    // a suggestion-mode probe replaced by the REAL next user prompt arrives as
    // a same-length tail swap, so skipping ctl entirely would lose exactly
    // those prompts.
    const covered = convResult.evt === 'append' || convResult.evt === 'snapshot'
      || (convResult.evt === 'ctl' && convResult.ctl === 'replace-tail');
    if (!covered) return;
    if (isSuggestionMode(msgs)) return; // next-input probes are not user prompts
    if (!s._promptSeen) s._promptSeen = new Set(readPromptsHead(s.paths.promptsPath));
    const slice = msgs.slice(convResult.msgFrom);
    const texts = [];
    for (const text of extractUserTexts(slice)) {
      if (s._promptSeen.size >= PROMPTS_MAX_PER_SESSION) break;
      const flat = flattenPromptText(text);
      if (!flat || s._promptSeen.has(flat)) continue;
      s._promptSeen.add(flat);
      texts.push(flat);
    }
    if (texts.length > 0) {
      this._queue.appendTo(s.paths.promptsPath, JSON.stringify({ seq, texts }) + '\n');
    }
  }

  /**
   * Completion ingest: responses line + journal done line (+ Agent-spawn
   * registration for future sub-conversation keying, spec §10).
   * @param {{sid:string, seq:number}|null} handle - from ingestRequest
   * @param {object} entry - completed v1 entry (response populated)
   * @param {{doneTs?: string}} [opts] - offline converter: historical done
   *   timestamp (entry start + duration); live callers omit it (wall clock).
   */
  ingestCompletion(handle, entry, opts = {}) {
    if (!this._enabled || !entry) return;
    try {
      // Held cold-start requests returned a null handle at ingestRequest time;
      // recover it by rid (the seam calls us while entry.requestId is intact).
      if (!handle && entry.requestId && this._lateHandles.has(entry.requestId)) {
        handle = this._lateHandles.get(entry.requestId);
        this._lateHandles.delete(entry.requestId);
      }
      if (!handle) return;
      // Prefer the session object carried in the handle (survives
      // resetSessions); the map lookup is only a legacy fallback.
      const s = handle.s || this._sessions.get(handle.sid);
      if (!s) return;

      const resp = entry.response || null;
      const respBody = resp && resp.body !== undefined ? resp.body : null;
      if (respBody && typeof respBody === 'object') s.resolver.registerSpawns(respBody);

      // rid comes from the handle, NOT entry.requestId — the v1 completion path
      // deletes requestId from the entry before writing, and the seam must be
      // free to call us before or after those deletes.
      const rid = handle.rid || `${handle.seq}`;
      this._queue.appendTo(
        s.paths.responsesPath,
        JSON.stringify({
          seq: handle.seq,
          rid,
          body: respBody,
          ...(resp && resp.headers && { headers: resp.headers }),
        }) + '\n'
      );

      const usage = respBody && respBody.usage ? respBody.usage : null;
      s.journal.writeDone({
        seq: handle.seq,
        rid,
        ts: opts.doneTs || new Date().toISOString(),
        ...(typeof entry.duration === 'number' && { dur: entry.duration }),
        status: resp && resp.error ? 'error' : (respBody == null ? 'capture-failed' : 'ok'),
        ...(resp && typeof resp.status === 'number' && { http: resp.status }),
        ...(usage && {
          usage: {
            ...(usage.input_tokens != null && { in: usage.input_tokens }),
            ...(usage.output_tokens != null && { out: usage.output_tokens }),
            ...(usage.cache_read_input_tokens != null && { cr: usage.cache_read_input_tokens }),
            ...(usage.cache_creation_input_tokens != null && { cw: usage.cache_creation_input_tokens }),
          },
        }),
        ...(respBody && respBody.stop_reason && { stop: respBody.stop_reason }),
      });
      if (this._onActivity && s.paths) {
        try { this._onActivity(s.paths.dir); } catch { /* nudge only — never disturb the write */ }
      }
    } catch (err) {
      reportSwallowed('v2-write.ingestCompletion', err);
    }
  }

  /** Session directory of the writer's current (fallback-routing) session, or
   *  null before the first sid-bearing request. The read side uses this to
   *  resolve "the live session" for /events cold loads (S6b). */
  currentSessionDir() {
    if (!this._currentSid) return null;
    const s = this._sessions.get(this._currentSid);
    return s ? s.paths.dir : null;
  }

  /** Lifecycle hook (resume / workspace reset): drop in-memory conversation
   *  continuity so the next request snapshots fresh. Journal seq keeps counting
   *  (same process, same session dirs — seq must stay monotonic per session). */
  resetConversations() {
    try {
      for (const s of this._sessions.values()) {
        s.convs.reset();
        s.resolver.reset();
      }
      this._currentSid = null;
    } catch (err) {
      reportSwallowed('v2-write.reset', err);
    }
  }

  /** Lifecycle hook (workspace switch): drop ALL cached session bindings so the
   *  next request re-creates its session dir under the newly resolved project.
   *  A sid that persists across the switch gets a fresh dir (and fresh seq)
   *  under the new project — different directory, so no seq collision. */
  resetSessions() {
    try {
      this._sessions.clear();
      this._pendingNoSid.length = 0;
      this._lateHandles.clear();
      this._currentSid = null;
    } catch (err) {
      reportSwallowed('v2-write.reset-sessions', err);
    }
  }

  /** Flush pending queue writes (tests / graceful shutdown). */
  async flush() {
    await this._queue.flush();
  }

  async close() {
    await this._queue.close();
  }
}
