// Wire Format v2 — journal writer (docs/refactor/WIRE_FORMAT_V2.md §4).
//
// The journal is the single ordering axis. Two-phase, append-only:
//   req line  — built in the SAME synchronous segment as the request initiation
//               (the caller allocates seq via nextSeq() there; enqueuing later
//               is fine, MUTATING history lines is not);
//   done line — on completion/error.
// The reader folds the two phases by seq; a req without a done is in-flight
// (or the process died) — that IS the v1 placeholder, minus the duplicated body.

import { existsSync, readFileSync } from 'node:fs';

export class Journal {
  /**
   * @param {object} paths - sessionPaths() object
   * @param {{appendTo: Function}} queue - AsyncWriteQueue (explicit-path API)
   */
  constructor(paths, queue) {
    this._paths = paths;
    this._queue = queue;
    // Seed from any existing journal so seq stays monotonic per session FILE,
    // not per Journal instance (spec §4 "session 内单调"). Without this, a
    // session-object recreation onto the same dir (workspace switch A→B→A,
    // resetSessions, process re-attach) would restart at 1 and collide with
    // prior lines — the reader folds by seq, so collisions silently corrupt.
    // Journal lines are small; a one-time full read at session bind is cheap.
    this._seq = Journal._maxSeqIn(paths.journalPath);
  }

  static _maxSeqIn(journalPath) {
    try {
      if (!existsSync(journalPath)) return 0;
      let max = 0;
      // Regex scan instead of per-line JSON.parse: tolerant of a truncated
      // tail line and ~10x cheaper on large journals.
      for (const m of readFileSync(journalPath, 'utf-8').matchAll(/"seq":\s*(\d+)/g)) {
        const n = Number(m[1]);
        if (n > max) max = n;
      }
      return max;
    } catch {
      return 0; // unreadable journal → fresh numbering beats crashing the writer
    }
  }

  /** Allocate the next initiation-order seq. MUST be called in the request's
   *  synchronous initiation segment (§3.7 guard — completion order must never
   *  become the semantic order). */
  nextSeq() {
    return ++this._seq;
  }

  /** Enqueue a req-phase line. `fields` carries the spec §4 req schema minus ph. */
  writeReq(fields, onDone) {
    this._queue.appendTo(this._paths.journalPath, JSON.stringify({ ph: 'req', ...fields }) + '\n', onDone);
  }

  /** Enqueue a done-phase line. */
  writeDone(fields, onDone) {
    this._queue.appendTo(this._paths.journalPath, JSON.stringify({ ph: 'done', ...fields }) + '\n', onDone);
  }
}
