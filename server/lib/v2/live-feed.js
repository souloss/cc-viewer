// Wire Format v2 — live feed (S6b): streams v2 session-dir appends to the SSE
// clients, replacing the v1 log-file tail as the live channel.
//
// Architecture (plan 1.2):
// - One incremental cursor per live session dir, built on SessionSynthesizer —
//   the SAME synthesis engine cold reads use, so live emission is
//   byte-identical to a later cold read by construction.
// - Two-level watcher topology: a watcher on `sessions/` sees new session dirs
//   appear (cross-process producers: teammates, IM workers); a per-session-dir
//   watcher sees journal.jsonl / responses.jsonl appends (direct children).
//   Conversation event files live two levels deeper where non-recursive
//   fs.watch cannot see them — but the writer appends the conv line BEFORE the
//   journal line, so the journal append is the tick; the synthesizer's
//   defer/retry covers the rare flush inversion, and a safety poll covers
//   missed events entirely (fs.watch is lossy under load).
// - The leader process's own writer nudges the feed in-process (`tick()`)
//   for zero-latency delivery — the nudge only schedules a cursor read; the
//   DATA always comes from the files, keeping one synthesis path.
//
// Emission: every synthesized item is round-tripped through JSON (protecting
// the synthesizer's internal objects from downstream mutation) and pushed
// through log-watcher's processWatchedEntry pipeline — the same enrichment,
// reconstruction and side-events the v1 tail produced.

import { watch, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { reportSwallowed } from '../error-report.js';
import { createIncrementalReconstructor } from '../delta-reconstructor.js';
import { processWatchedEntry, sendEventToClients, sendEventRawToClients } from '../log-watcher.js';
import { SessionSynthesizer } from './adapter.js';
import { isDiscardableSession } from './session-select.js';
import { isForeignLiveOwned } from './session-owner.js';
import { computeCacheLoss } from './meta-rows.js';
import { classifyRequest } from '../../../src/utils/requestType.js';

const FSWATCH_DEBOUNCE_MS = 80;
const SAFETY_POLL_MS = 5000;
const DEFER_MS = 3000;          // synthesizer park deadline (lagging lines)
const ATTACH_RECENT_MS = 5 * 60 * 1000; // pre-existing dirs considered "live"
const TICK_RETRY_MS = 250;      // in-process tick raced the first queue drain
const TICK_RETRY_MAX = 8;

const READ_CHUNK_BYTES = 8 * 1024 * 1024;
// Node's max string length (~512MiB) — a longer line can never be decoded.
const MAX_LINE_BYTES = 0x1fffffe8;

/** Read newly appended complete lines from a file cursor {path, offset}
 *  (partial-line carry lives on lazily-initialized _pendBufs/_pendBytes/
 *  _skipLine cursor fields). Returns an array of raw line strings (possibly
 *  empty). A file
 *  that shrank (should never happen — v2 files are append-only) returns null
 *  so the caller can rebuild the cursor.
 *
 *  Chunked + byte-level newline split (issue #129 twin): the first attach to
 *  a session seeds from offset 0, so one whole-file read + decode would throw
 *  ERR_STRING_TOO_LONG on an oversized journal and crash-loop the boot path
 *  exactly like the cold-scan crash the streaming reader fixed. The partial
 *  tail line is carried on the cursor as Buffer fragments (never decoded
 *  until its newline lands); a single line past the string cap is skipped
 *  with a report instead of thrown. Exported for tests (chunkBytes seam).
 */
export function readNewLines(cursor, chunkBytes = READ_CHUNK_BYTES, maxLineBytes = MAX_LINE_BYTES) {
  let size;
  try {
    size = statSync(cursor.path).size;
  } catch {
    return []; // not created yet
  }
  if (size < cursor.offset) return null;
  if (size === cursor.offset) return [];
  if (cursor._pendBufs === undefined) {
    cursor._pendBufs = [];
    cursor._pendBytes = 0;
    cursor._skipLine = false;
  }
  const out = [];
  let fd;
  try {
    fd = openSync(cursor.path, 'r');
    const chunk = Buffer.alloc(Math.min(chunkBytes, size - cursor.offset));
    while (cursor.offset < size) {
      const toRead = Math.min(chunk.length, size - cursor.offset);
      const n = readSync(fd, chunk, 0, toRead, cursor.offset);
      if (n === 0) break;
      cursor.offset += n;
      const view = chunk.subarray(0, n);
      let from = 0;
      while (from < n) {
        const nl = view.indexOf(10, from);
        if (nl === -1) {
          if (!cursor._skipLine) {
            const restLen = n - from;
            if (cursor._pendBytes + restLen > maxLineBytes) {
              cursor._skipLine = true;
              cursor._pendBufs = [];
              cursor._pendBytes = 0;
              reportSwallowed('v2-live.read-line-too-long', new Error(`${cursor.path}: line exceeds ${maxLineBytes} bytes — skipped`));
            } else {
              // chunk is reused next readSync — the carried slice must own its bytes
              cursor._pendBufs.push(Buffer.from(view.subarray(from)));
              cursor._pendBytes += restLen;
            }
          }
          break;
        }
        if (cursor._skipLine) {
          cursor._skipLine = false; // the oversized line ends at this newline
        } else {
          const seg = view.subarray(from, nl);
          let text = null;
          try {
            if (cursor._pendBufs.length > 0) {
              cursor._pendBufs.push(seg);
              text = Buffer.concat(cursor._pendBufs).toString('utf-8');
            } else {
              text = seg.toString('utf-8');
            }
          } catch (err) {
            reportSwallowed('v2-live.read-line-too-long', err);
          }
          cursor._pendBufs = [];
          cursor._pendBytes = 0;
          if (text !== null) {
            const t = text.trim();
            if (t) out.push(t);
          }
        }
        from = nl + 1;
      }
    }
  } catch (err) {
    // Deliver what was already parsed; offset only advanced past read bytes,
    // so the next poll resumes from the failure point.
    reportSwallowed('v2-live.read', err);
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
  return out;
}

export class V2LiveFeed {
  /**
   * @param {object} opts
   * @param {Array} opts.clients - shared SSE client array (server.js)
   * @param {Function} opts.getClaudePid
   * @param {Function} opts.runParallelHook
   * @param {Function} [opts.notifyStatsWorker] - called with the session dir
   *   after a batch of entries was emitted from it
   * @param {Function} [opts.watchImpl] - fs.watch injection (tests)
   * @param {number} [opts.safetyPollMs] - 0 disables the timer (tests drive
   *   _safetyTick manually)
   * @param {number} [opts.deferMs]
   * @param {Function} [opts.now]
   * @param {Function} [opts.isForeignOwnedFn] - injection seam (tests):
   *   (dir) => boolean, defaults to session-owner's isForeignLiveOwned
   */
  constructor(opts = {}) {
    this._clients = opts.clients || [];
    this._getClaudePid = opts.getClaudePid || (() => null);
    this._runParallelHook = opts.runParallelHook || (() => Promise.resolve());
    this._notifyStatsWorker = opts.notifyStatsWorker || null;
    this._watchImpl = opts.watchImpl || watch;
    this._safetyPollMs = typeof opts.safetyPollMs === 'number' ? opts.safetyPollMs : SAFETY_POLL_MS;
    this._deferMs = typeof opts.deferMs === 'number' ? opts.deferMs : DEFER_MS;
    this._now = opts.now || Date.now;
    this._isForeignOwned = opts.isForeignOwnedFn || isForeignLiveOwned;
    // Wire v3 (V3.S2): when on, every emitted item ALSO broadcasts a metadata
    // row (v2_requests_delta). Explicit ctor param — this module has no access
    // to the server deps object.
    this._wireV3 = !!opts.wireV3;
    this._sessions = new Map(); // dir → cursor bundle
    this._seenDirs = new Map(); // dir → last observed journal mtimeMs (attached or not)
    this._discardGated = new Set(); // dirs refused by the discard gate — first real attach must NOT suppress history
    this._sessionsRoot = null;
    this._rootWatcher = null;
    this._safetyTimer = null;
    this._startedAt = 0;
    this._active = false;
  }

  /** Begin (or switch to) live-following a project's sessions/ root. */
  start(projectDir) {
    this.stop();
    this._active = true;
    this._startedAt = this._now();
    this._sessionsRoot = join(projectDir, 'sessions');
    this._armRootWatcher();
    this._initialScan();
    if (this._safetyPollMs > 0) {
      this._safetyTimer = setInterval(() => this._safetyTick(), this._safetyPollMs);
    }
  }

  stop() {
    this._active = false;
    if (this._safetyTimer) { clearInterval(this._safetyTimer); this._safetyTimer = null; }
    if (this._rootWatcher) { try { this._rootWatcher.close(); } catch { /* already closed */ } this._rootWatcher = null; }
    for (const cur of this._sessions.values()) this._closeCursor(cur);
    this._sessions.clear();
    this._seenDirs.clear();
    this._discardGated.clear();
    this._sessionsRoot = null;
  }

  /** In-process nudge from the local V2Writer after an ingest: attach the
   *  session on first sight and schedule a cursor read. Zero-latency path for
   *  the leader's own traffic. The write queue drains asynchronously, so the
   *  very first tick can race the journal's creation — retry briefly (the
   *  per-dir watcher and safety poll are the durable fallbacks). */
  tick(sessionDir, _retries = 0) {
    if (!this._active || !sessionDir) return;
    let cur = this._sessions.get(sessionDir);
    if (!cur) {
      cur = this._attach(sessionDir, { suppressExisting: false });
      if (!cur) {
        if (_retries < TICK_RETRY_MAX) {
          setTimeout(() => this.tick(sessionDir, _retries + 1), TICK_RETRY_MS);
        }
        return;
      }
    }
    this._scheduleRead(cur);
  }

  /** True when a session dir is being followed (tests / diagnostics). */
  isFollowing(sessionDir) {
    return this._sessions.has(sessionDir);
  }

  // ── watcher topology ───────────────────────────────────────────────────────

  _armRootWatcher() {
    if (this._rootWatcher || !this._sessionsRoot) return;
    if (!existsSync(this._sessionsRoot)) return; // re-tried by the safety tick
    try {
      const watcher = this._watchImpl(this._sessionsRoot, (eventType, filename) => {
        // A new (or renamed) direct child is potentially a fresh session dir.
        if (!this._active) return;
        if (filename) {
          const dir = join(this._sessionsRoot, filename);
          this._maybeAttachNew(dir);
        } else {
          this._scanRoot();
        }
      });
      watcher.on('error', (err) => {
        reportSwallowed('v2-live.root-watch', err);
        try { watcher.close(); } catch { /* already closed */ }
        if (this._rootWatcher === watcher) this._rootWatcher = null; // safety poll re-arms
      });
      this._rootWatcher = watcher;
    } catch (err) {
      reportSwallowed('v2-live.root-watch', err);
    }
  }

  _initialScan() {
    if (!existsSync(this._sessionsRoot)) return;
    let names = [];
    try {
      names = readdirSync(this._sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      reportSwallowed('v2-live.scan', err);
      return;
    }
    for (const name of names) {
      const dir = join(this._sessionsRoot, name);
      const mtime = this._journalMtime(dir);
      this._seenDirs.set(dir, mtime);
      // Pre-existing dirs with recent activity are live producers that predate
      // this feed (mid-run server start / workspace switch): follow them but
      // suppress their history — the cold reload channel covers it.
      if (mtime > 0 && this._now() - mtime <= ATTACH_RECENT_MS) {
        this._attach(dir, { suppressExisting: true });
      }
    }
  }

  _scanRoot() {
    if (!existsSync(this._sessionsRoot)) return;
    let names = [];
    try {
      names = readdirSync(this._sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return;
    }
    for (const name of names) this._maybeAttachNew(join(this._sessionsRoot, name));
  }

  /** Attach a dir first seen after feed start (root watcher / safety scan). */
  _maybeAttachNew(dir) {
    if (this._sessions.has(dir)) return;
    const mtime = this._journalMtime(dir);
    if (mtime === 0) return; // no journal yet — the next event/tick retries
    const seenBefore = this._seenDirs.has(dir);
    this._seenDirs.set(dir, mtime);
    if (!seenBefore) {
      // Genuinely new session dir: everything in it is new — emit from byte 0
      // when it was born after the feed started, otherwise treat as history.
      // birthtime ≤ 0 (Linux filesystems without btime) must count as new:
      // suppressing would swallow a cross-process session's first entries
      // (review P2).
      const bornAfterStart = (() => {
        try {
          const bt = statSync(dir).birthtimeMs;
          return !(bt > 0) || bt >= this._startedAt - 1000;
        } catch { return true; }
      })();
      this._attach(dir, { suppressExisting: !bornAfterStart });
    }
  }

  _journalMtime(dir) {
    try { return statSync(join(dir, 'journal.jsonl')).mtimeMs; } catch { return 0; }
  }

  // ── per-session cursors ────────────────────────────────────────────────────

  _attach(dir, { suppressExisting }) {
    if (this._sessions.has(dir)) return this._sessions.get(dir);
    if (!existsSync(join(dir, 'journal.jsonl'))) return null;
    // Multi-window isolation: a dir exclusively claimed by ANOTHER live ccv
    // window (owner.lock, pid-liveness validity) never enters this feed — its
    // traffic belongs to that window. Checked BEFORE the discard gate so a
    // foreign dir never lands in _discardGated (whose delete side-effect would
    // flip suppressExisting to false on a later attach and flood clients with
    // the whole foreign history). Re-evaluated on every attach attempt — no
    // persistent gate set — so a dead owner's claim stops mattering the
    // moment its pid dies. Own dirs (tick path) and unclaimed teammate/IM
    // dirs pass through untouched.
    if (this._isForeignOwned(dir)) return null;
    // Discardable sessions (quota-probe orphans — no main/teammate req, no
    // meta.leader) are never followed: single choke point, every attach path
    // (_initialScan / _maybeAttachNew / tick / _safetyTick / _rebuildCursor)
    // funnels here and handles null. Self-healing when a dir later gains its
    // first main: the leader's own dir re-attaches via tick's retry chain
    // (sub-second); cross-process dirs via the 5s safety poll's mtime-bump
    // scan (_seenDirs bookkeeping stays in the callers, so the bump fires).
    if (isDiscardableSession(dir)) {
      this._discardGated.add(dir);
      return null;
    }
    // A dir previously refused by the discard gate is attaching for the FIRST
    // time — its first renderable turn was never broadcast, so the safety
    // poll's suppressExisting:true (meant for "old stale dir resumed") must
    // not swallow it: cross-process producers (IM worker, second ccv) have no
    // cold-load fallback for a connected client.
    if (this._discardGated.delete(dir)) suppressExisting = false;
    const cur = {
      dir,
      synth: new SessionSynthesizer(dir, { deferMs: this._deferMs, now: this._now }),
      // Per-session reconstructor (review P2): two concurrently-followed main
      // producers in one project (a second ccv process, IM worker) must not
      // rebase each other's accumulated baseline — v1's tail followed exactly
      // one file, so a single shared reconstructor was a new interleave surface.
      reconstructor: createIncrementalReconstructor(),
      journal: { path: join(dir, 'journal.jsonl'), offset: 0 },
      responses: { path: join(dir, 'responses.jsonl'), offset: 0 },
      convFiles: new Map(), // path → {key, offset} (+ lazy _pendBufs carry)
      watcher: null,
      debounce: null,
      reading: false,
      dirty: false,
      suppress: !!suppressExisting,
    };
    this._sessions.set(dir, cur);
    this._seenDirs.set(dir, this._journalMtime(dir));
    try {
      cur.watcher = this._watchImpl(dir, () => this._scheduleRead(cur));
      cur.watcher.on('error', (err) => {
        reportSwallowed('v2-live.session-watch', err);
        try { cur.watcher.close(); } catch { /* already closed */ }
        cur.watcher = null; // safety poll keeps the cursor alive
      });
    } catch (err) {
      reportSwallowed('v2-live.session-watch', err);
    }
    this._readCursor(cur); // seed (suppressed history or brand-new content)
    cur.suppress = false;
    return cur;
  }

  _closeCursor(cur) {
    if (cur.debounce) { clearTimeout(cur.debounce); cur.debounce = null; }
    if (cur.watcher) { try { cur.watcher.close(); } catch { /* already closed */ } cur.watcher = null; }
  }

  _scheduleRead(cur) {
    if (!this._active) return;
    if (cur.debounce) return;
    cur.debounce = setTimeout(() => {
      cur.debounce = null;
      this._readCursor(cur);
    }, FSWATCH_DEBOUNCE_MS);
  }

  /** Read all new bytes of one session (conv events → responses → journal —
   *  the order that maximizes gate success), feed the synthesizer, emit. */
  _readCursor(cur) {
    if (cur.reading) { cur.dirty = true; return; }
    cur.reading = true;
    try {
      do {
        cur.dirty = false;
        this._feedConvFiles(cur);
        const respLines = readNewLines(cur.responses);
        if (respLines === null) { this._rebuildCursor(cur); return; }
        for (const raw of respLines) {
          cur.synth.ingestResponseLine(raw);
          // Wire v3 (V3.S4): forward the raw stored line — the flagged client
          // assembles v1-shape entries from native lines locally. Suppressed
          // during seed (history is covered by the cold-load channel).
          if (this._wireV3 && !cur.suppress) this._forwardNative(cur, 'resp', null, raw);
        }
        const journalLines = readNewLines(cur.journal);
        if (journalLines === null) { this._rebuildCursor(cur); return; }
        for (const raw of journalLines) {
          let line = null;
          try { line = JSON.parse(raw); } catch (err) {
            reportSwallowed('v2-live.journal-parse', new Error(`${cur.dir}: ${err.message}`));
          }
          if (line) cur.synth.ingestJournalLine(line);
        }
        this._emitDrained(cur);
      } while (cur.dirty);
    } finally {
      cur.reading = false;
    }
  }

  _feedConvFiles(cur) {
    const convRoot = join(cur.dir, 'conversations');
    if (!existsSync(convRoot)) return;
    let keys = [];
    try {
      keys = readdirSync(convRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return;
    }
    for (const key of keys) {
      let files = [];
      try {
        files = readdirSync(join(convRoot, key)).filter((f) => /^e\d+\.jsonl$/.test(f));
      } catch {
        continue;
      }
      // Numeric epoch order. NB: file order is NOT guaranteed to be globally
      // seq-ordered (a pre-fix writer restart appended newer seqs into an
      // older epoch file) — the synthesizer's ingestConvLine keeps its event
      // window seq-sorted on insert, so feed order only needs to be stable.
      files.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
      for (const f of files) {
        const p = join(convRoot, key, f);
        let fc = cur.convFiles.get(p);
        if (!fc) {
          fc = { key, path: p, offset: 0 };
          cur.convFiles.set(p, fc);
        }
        const lines = readNewLines(fc);
        if (lines === null) { this._rebuildCursor(cur); return; }
        for (const raw of lines) {
          let ev = null;
          try { ev = JSON.parse(raw); } catch (err) {
            reportSwallowed('v2-live.conv-parse', new Error(`${cur.dir}/${key}: ${err.message}`));
          }
          if (ev) {
            cur.synth.ingestConvLine(key, ev);
            if (this._wireV3 && !cur.suppress) this._forwardNative(cur, 'conv', key, raw);
          }
        }
      }
    }
  }

  /** Append-only invariant broke (shrunk file): rebuild the whole cursor with
   *  a fresh synthesizer, replaying silently to the current state. */
  _rebuildCursor(cur) {
    reportSwallowed('v2-live.cursor-rebuild', new Error(`${cur.dir}: file shrank — rebuilding cursor`));
    this._closeCursor(cur);
    this._sessions.delete(cur.dir);
    const fresh = this._attach(cur.dir, { suppressExisting: true });
    if (fresh) this._scheduleRead(fresh);
  }

  _emitDrained(cur) {
    cur.synth.sweepDeadlines();
    const items = cur.synth.drain();
    if (items.length === 0) return;
    if (cur.suppress) {
      // Seed phase: history is already covered by the cold-load channel, so
      // nothing is broadcast — but the shared reconstructor still consumes it,
      // giving later deltas a baseline (v1's tail restarted with no baseline
      // and passed bare slices through; the cold reload had to cover them).
      for (const item of items) {
        try {
          cur.reconstructor.reconstruct(JSON.parse(JSON.stringify(item.entry)));
        } catch (err) {
          reportSwallowed('v2-live.seed', err);
        }
      }
      return;
    }
    let emitted = 0;
    for (const item of items) {
      let parsed = null;
      try {
        // JSON round-trip: downstream (reconstructor/enrichers) mutate entries
        // in place — the synthesizer's own objects must stay pristine so the
        // placeholder→completed mutation stays byte-true.
        parsed = JSON.parse(JSON.stringify(item.entry));
      } catch (err) {
        reportSwallowed('v2-live.emit', err);
        continue;
      }
      try {
        processWatchedEntry(parsed, {
          reconstructor: cur.reconstructor,
          clients: this._clients,
          getClaudePid: this._getClaudePid,
          runParallelHook: this._runParallelHook,
          suppressEntryBroadcast: this._wireV3,
        });
        emitted++;
      } catch (err) {
        reportSwallowed('v2-live.emit', err);
      }
      // Wire v3: derive the metadata row from the post-reconstruction entry
      // (main deltas carry full messages here — classification/cacheLoss get
      // the same inputs the legacy list sees). Row-level errors must not
      // disturb the legacy broadcast above.
      if (this._wireV3) {
        try {
          this._emitRow(cur, item, parsed);
        } catch (err) {
          reportSwallowed('v2-live.row', err);
        }
      }
    }
    if (emitted > 0 && this._notifyStatsWorker) {
      try { this._notifyStatsWorker(cur.dir); } catch (err) { reportSwallowed('v2-live.stats-notify', err); }
    }
  }

  /** Wire v3 (V3.S4): broadcast one raw native line (conv event or responses
   *  line) — the flagged client's assembler replays these into v1-shape
   *  entries. `raw` is forwarded verbatim inside a JSON envelope carrying the
   *  session identity + channel. sessionId comes from the synthesizer (the
   *  UUID, matching the rows' sessionId and the entries' _seqEpoch). */
  _forwardNative(cur, kind, channel, raw) {
    try {
      const payload = kind === 'conv'
        ? `{"sessionId":${JSON.stringify(cur.synth.sessionId)},"channel":${JSON.stringify(channel)},"line":${raw}}`
        : `{"sessionId":${JSON.stringify(cur.synth.sessionId)},"line":${raw}}`;
      const eventName = kind === 'conv' ? 'v3_conv' : 'v3_resp';
      sendEventRawToClients(this._clients, eventName, payload);
    } catch (err) {
      reportSwallowed('v2-live.native-forward', err);
    }
  }

  /** Wire v3 (V3.S2): one metadata row per emitted item, derived from the
   *  post-reconstruction entry. Rows upsert client-side by (sessionId, seq):
   *  a placeholder row precedes its completed row, and a correction re-send
   *  follows when the NEXT request's arrival changes the previous row's
   *  classification (classifyRequest's Preflight/Plan cases read nextReq). */
  _rowFrom(item, parsed) {
    const usage = parsed.response?.body?.usage || null;
    return {
      seq: item.seq,
      sessionId: item.sessionId,
      timestamp: parsed.timestamp || '',
      url: parsed.url || '',
      method: parsed.method || 'POST',
      // conv/evt/kind/mainAgent mirror the cold fold (meta-rows.js foldDir) —
      // journal truth, NOT re-derivation. conv is load-bearing: the client
      // assembler's buildEntry is `if (row.conv)`-gated, so a conv-less live
      // row rebuilt every entry with EMPTY messages (chat vanished at stream
      // end). mainAgent must be kind-derived like cold: parsed.mainAgent
      // re-derives from the body and mis-tags countTokens (main system/tools
      // aboard) as true, which would merge its turn into the chat live-only.
      conv: item.conv,
      evt: item.evt,
      kind: item.kind || (item.isMain ? 'main' : (parsed.teammate ? 'teammate' : 'sub')),
      mainAgent: item.isMain === true,
      teammate: parsed.teammate || undefined,
      model: parsed.body?.model,
      proxyUrl: parsed.proxyUrl || undefined,
      status: parsed.response?.status,
      duration: parsed.duration,
      usage: usage ? {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      } : null,
      inProgress: !!parsed.inProgress,
      typeTag: null,
      cacheLoss: null,
    };
  }

  _emitRow(cur, item, parsed) {
    const row = this._rowFrom(item, parsed);
    try {
      const tag = classifyRequest(parsed, null);
      row.typeTag = tag ? { type: tag.type, subType: tag.subType ?? null } : null;
    } catch (err) { reportSwallowed('v2-live.row-classify', err); }
    if (row.mainAgent && !row.inProgress) {
      const u = parsed.response?.body?.usage;
      const cw = (u && u.cache_creation_input_tokens) || 0;
      const cr = (u && u.cache_read_input_tokens) || 0;
      if (cur._v3PrevMain && cw > 0 && cw > cr) {
        try { row.cacheLoss = computeCacheLoss(cur._v3PrevMain, parsed); } catch (err) { reportSwallowed('v2-live.row-cacheloss', err); }
      }
      cur._v3PrevMain = parsed; // one full entry retained per cursor (bounded)
    }
    // Lookahead correction: this entry is the previous row's nextReq.
    const prev = cur._v3Last;
    if (prev && (prev.row.sessionId !== row.sessionId || prev.row.seq !== row.seq)) {
      try {
        const tag = classifyRequest(prev.entry, parsed);
        const corrected = tag ? { type: tag.type, subType: tag.subType ?? null } : null;
        if (JSON.stringify(corrected) !== JSON.stringify(prev.row.typeTag)) {
          prev.row.typeTag = corrected;
          sendEventToClients(this._clients, 'v2_requests_delta', prev.row);
        }
      } catch (err) { reportSwallowed('v2-live.row-classify', err); }
    }
    cur._v3Last = { row, entry: parsed };
    sendEventToClients(this._clients, 'v2_requests_delta', row);
  }

  // ── safety poll ────────────────────────────────────────────────────────────

  _safetyTick() {
    if (!this._active) return;
    this._armRootWatcher(); // re-arm after errors / late directory creation
    // Attached sessions: unconditional slow re-read (fs.watch is lossy).
    for (const cur of [...this._sessions.values()]) {
      // Multi-window isolation: an ATTACHED dir can turn foreign-owned after
      // the fact — an unowned (dead-owner) dir followed since startup gets
      // adopted by another window's `ccv -c`. The attach-time gate can't see
      // that, so re-check here and detach before the unconditional re-read
      // would stream the adopter's traffic into this window (bounded to one
      // safety-poll period). _seenDirs keeps the current mtime so a later
      // ownership release (owner exits) plus new activity re-attaches through
      // the normal mtime-bump path below.
      if (this._isForeignOwned(cur.dir)) {
        this._closeCursor(cur);
        this._sessions.delete(cur.dir);
        this._seenDirs.set(cur.dir, this._journalMtime(cur.dir));
        continue;
      }
      this._readCursor(cur);
    }
    // Unattached dirs: attach brand-new ones (missed root events) and
    // re-attach previously idle ones whose journal moved again.
    if (!existsSync(this._sessionsRoot)) return;
    let names = [];
    try {
      names = readdirSync(this._sessionsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return;
    }
    for (const name of names) {
      const dir = join(this._sessionsRoot, name);
      if (this._sessions.has(dir)) continue;
      const mtime = this._journalMtime(dir);
      if (mtime === 0) continue;
      const seen = this._seenDirs.get(dir);
      if (seen === undefined) {
        this._maybeAttachNew(dir);
      } else if (mtime > seen) {
        // A dir skipped at the initial scan (stale then) has resumed activity:
        // follow it now, history suppressed (it predates this feed).
        this._seenDirs.set(dir, mtime);
        this._attach(dir, { suppressExisting: true });
      }
    }
  }
}
