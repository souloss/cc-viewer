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
import { processWatchedEntry } from '../log-watcher.js';
import { SessionSynthesizer } from './adapter.js';

const FSWATCH_DEBOUNCE_MS = 80;
const SAFETY_POLL_MS = 5000;
const DEFER_MS = 3000;          // synthesizer park deadline (lagging lines)
const ATTACH_RECENT_MS = 5 * 60 * 1000; // pre-existing dirs considered "live"
const TICK_RETRY_MS = 250;      // in-process tick raced the first queue drain
const TICK_RETRY_MAX = 8;

/** Read newly appended complete lines from a file cursor {path, offset,
 *  pending}. Returns an array of raw line strings (possibly empty). A file
 *  that shrank (should never happen — v2 files are append-only) returns null
 *  so the caller can rebuild the cursor. */
function readNewLines(cursor) {
  let size;
  try {
    size = statSync(cursor.path).size;
  } catch {
    return []; // not created yet
  }
  if (size < cursor.offset) return null;
  if (size === cursor.offset) return [];
  const toRead = size - cursor.offset;
  const buf = Buffer.alloc(toRead);
  let fd;
  try {
    fd = openSync(cursor.path, 'r');
    readSync(fd, buf, 0, toRead, cursor.offset);
  } catch (err) {
    reportSwallowed('v2-live.read', err);
    return [];
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
  cursor.offset = size;
  const chunk = cursor.pending + buf.toString('utf-8');
  const parts = chunk.split('\n');
  cursor.pending = parts.pop() || '';
  return parts.map((l) => l.trim()).filter(Boolean);
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
    this._sessions = new Map(); // dir → cursor bundle
    this._seenDirs = new Map(); // dir → last observed journal mtimeMs (attached or not)
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
    const cur = {
      dir,
      synth: new SessionSynthesizer(dir, { deferMs: this._deferMs, now: this._now }),
      // Per-session reconstructor (review P2): two concurrently-followed main
      // producers in one project (a second ccv process, IM worker) must not
      // rebase each other's accumulated baseline — v1's tail followed exactly
      // one file, so a single shared reconstructor was a new interleave surface.
      reconstructor: createIncrementalReconstructor(),
      journal: { path: join(dir, 'journal.jsonl'), offset: 0, pending: '' },
      responses: { path: join(dir, 'responses.jsonl'), offset: 0, pending: '' },
      convFiles: new Map(), // path → {key, offset, pending}
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
        for (const raw of respLines) cur.synth.ingestResponseLine(raw);
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
          fc = { key, path: p, offset: 0, pending: '' };
          cur.convFiles.set(p, fc);
        }
        const lines = readNewLines(fc);
        if (lines === null) { this._rebuildCursor(cur); return; }
        for (const raw of lines) {
          let ev = null;
          try { ev = JSON.parse(raw); } catch (err) {
            reportSwallowed('v2-live.conv-parse', new Error(`${cur.dir}/${key}: ${err.message}`));
          }
          if (ev) cur.synth.ingestConvLine(key, ev);
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
        });
        emitted++;
      } catch (err) {
        reportSwallowed('v2-live.emit', err);
      }
    }
    if (emitted > 0 && this._notifyStatsWorker) {
      try { this._notifyStatsWorker(cur.dir); } catch (err) { reportSwallowed('v2-live.stats-notify', err); }
    }
  }

  // ── safety poll ────────────────────────────────────────────────────────────

  _safetyTick() {
    if (!this._active) return;
    this._armRootWatcher(); // re-arm after errors / late directory creation
    // Attached sessions: unconditional slow re-read (fs.watch is lossy).
    for (const cur of [...this._sessions.values()]) {
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
