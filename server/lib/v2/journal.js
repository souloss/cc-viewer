// Wire Format v2 — journal writer (docs/refactor/WIRE_FORMAT_V2.md §4).
//
// The journal is the single ordering axis. Two-phase, append-only:
//   req line  — built in the SAME synchronous segment as the request initiation
//               (the caller allocates seq via nextSeq() there; enqueuing later
//               is fine, MUTATING history lines is not);
//   done line — on completion/error.
// The reader folds the two phases by seq; a req without a done is in-flight
// (or the process died) — that IS the v1 placeholder, minus the duplicated body.

export class Journal {
  /**
   * @param {object} paths - sessionPaths() object
   * @param {{appendTo: Function}} queue - AsyncWriteQueue (explicit-path API)
   */
  constructor(paths, queue) {
    this._paths = paths;
    this._queue = queue;
    this._seq = 0;
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
