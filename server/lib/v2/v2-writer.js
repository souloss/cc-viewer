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

// Below this many free bytes on the log volume, v2 skips writing (v1 keeps its
// own behavior) and reports once — dual-write must not be the thing that fills
// the disk (plan risk #9 / F-review 6).
const MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1GB

export class V2Writer {
  /**
   * @param {object} opts
   * @param {string} opts.logDir       - LOG_DIR root
   * @param {string|Function} opts.project - project directory name, or a getter —
   *   workspace mode rebinds the interceptor's _projectName at runtime; a falsy
   *   resolved project makes ingest a no-op (mirrors v1's empty-LOG_FILE no-op)
   * @param {string|null} [opts.instanceId] - CCV_INSTANCE_ID (pid) for meta ownership
   * @param {object|null} [opts.leader]     - teammate processes: {agentName, teamName, parentSessionId}
   * @param {boolean} [opts.enabled]   - master switch (CCV_WIRE_V2); default off
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
    this._instanceId = opts.instanceId || null;
    this._leader = opts.leader || null;
    this._enabled = !!opts.enabled;
    this._queue = opts.queue || new AsyncWriteQueue(''); // paths are always explicit
    this._minFreeBytes = typeof opts.minFreeBytes === 'number' ? opts.minFreeBytes : MIN_FREE_BYTES;
    this._statfs = opts.statfs || statfsSync;
    this._sessions = new Map(); // sessionId → {paths, blobs, journal, convs, resolver}
    this._currentSid = null;    // last successfully resolved session (fallback routing §8.3)
    this._pendingNoSid = [];    // requests seen before any sid (cold-start heartbeats).
    // Contract with the caller: originalMessages held here must be a reference
    // the caller never MUTATES (the interceptor's original array is only ever
    // REASSIGNED away from body.messages, never mutated in place — safe).
    this._lateHandles = new Map(); // rid → handle for held requests whose completion arrives after the flush
    this._diskGuardTripped = false;
  }

  get enabled() { return this._enabled; }
  setEnabled(v) { this._enabled = !!v; }

  _session(sessionId, userIdRaw, encoding, project) {
    let s = this._sessions.get(sessionId);
    if (s) return s;
    const meta = {
      ...(this._instanceId && { instanceId: this._instanceId }),
      pid: process.pid,
      ...(userIdRaw && { userIdRaw }),
      ...(encoding && { userIdEncoding: encoding }),
      ...(this._leader && { leader: this._leader }),
    };
    const paths = ensureSessionDirSync(this._logDir, project, sessionId, meta);
    s = {
      paths,
      blobs: new BlobStore(paths),
      journal: new Journal(paths, this._queue),
      convs: new ConversationStore(paths, this._queue),
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
          this._pendingNoSid.push({ entry, originalMessages });
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
          const prid = p.entry && p.entry.requestId;
          if (pseq != null && prid) {
            this._lateHandles.set(prid, { sid, seq: pseq, rid: prid });
            if (this._lateHandles.size > 64) {
              this._lateHandles.delete(this._lateHandles.keys().next().value);
            }
          }
        }
      }

      const seq = this._ingestInto(s, sid, entry, originalMessages);
      return seq == null ? null : { sid, seq, rid: entry.requestId || `${seq}` };
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
    return seq;
  }

  /**
   * Completion ingest: responses line + journal done line (+ Agent-spawn
   * registration for future sub-conversation keying, spec §10).
   * @param {{sid:string, seq:number}|null} handle - from ingestRequest
   * @param {object} entry - completed v1 entry (response populated)
   */
  ingestCompletion(handle, entry) {
    if (!this._enabled || !entry) return;
    try {
      // Held cold-start requests returned a null handle at ingestRequest time;
      // recover it by rid (the seam calls us while entry.requestId is intact).
      if (!handle && entry.requestId && this._lateHandles.has(entry.requestId)) {
        handle = this._lateHandles.get(entry.requestId);
        this._lateHandles.delete(entry.requestId);
      }
      if (!handle) return;
      const s = this._sessions.get(handle.sid);
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
        ts: new Date().toISOString(),
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
    } catch (err) {
      reportSwallowed('v2-write.ingestCompletion', err);
    }
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
