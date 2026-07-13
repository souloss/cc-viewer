// Wire Format v2 — conversation event store (docs/refactor/WIRE_FORMAT_V2.md §6).
//
// The write side performs EXACTLY ONE cheap judgement — the prefix-extension
// test (same one v1's delta path does) — and stores wire events faithfully:
//   append   — wire messages prefix-extend the previous state → store the tail;
//   snapshot — anything else (v1 §3.1 plan-mode window, §3.2 K-tail overlap,
//              unexplained shrink, process restart) → store the FULL wire array
//              and let the READ-side materializer resolve it with the shared
//              reverse-anchor module. No merge logic ever runs at write time
//              (plan decision F6: a write-side merge mistake would be permanent).
//   ctl      — replace-tail (v1 §3.3 in-place replace) / compact continuation.
//
// /clear (shared predicate, §3.4) closes the epoch and opens e<N+1>;
// /compact (§3.5) stays in the SAME epoch with a ctl marker.
//
// Every stored line carries the initiating seq + rid (plan risk F8): physical
// append order is completion order, semantic order is seq.

import { isPostClearCheckpoint, isCompactContinuation, messageFingerprint } from '../session-boundary.js';
import { ensureConvDirSync, convEpochPath } from './layout.js';

export class ConversationStore {
  /**
   * @param {object} paths - sessionPaths() object
   * @param {{appendTo: Function}} queue - AsyncWriteQueue (explicit-path API)
   */
  constructor(paths, queue) {
    this._paths = paths;
    this._queue = queue;
    this._convs = new Map(); // convKey → { epoch, count, tailFp, dirEnsured }
  }

  _state(convKey) {
    let st = this._convs.get(convKey);
    if (!st) {
      st = { epoch: 0, count: 0, tailFp: '', dirEnsured: false, everWrote: false };
      this._convs.set(convKey, st);
    }
    return st;
  }

  /**
   * Ingest one request's wire messages for a conversation.
   * @param {string} convKey
   * @param {Array} messages - ORIGINAL wire messages (pre any v1 delta mutation)
   * @param {{seq:number, rid:string}} ids
   * @returns {{evt:'append'|'snapshot'|null, ctl:string|null, epoch:number,
   *            boundary:'clear'|'compact'|'replace-tail'|null,
   *            msgFrom:number, msgTo:number}}
   *   evt/ctl describe what was written (journal req line mirrors this, §4);
   *   msgFrom/msgTo are the [from,to) wire counts for integrity checks.
   */
  ingest(convKey, messages, ids) {
    const st = this._state(convKey);
    const msgs = Array.isArray(messages) ? messages : [];
    const len = msgs.length;
    const tailFp = len > 0 ? messageFingerprint(msgs[len - 1]) : '';
    const prev = st.count;
    const prevTailFp = st.tailFp;

    let evt = null;
    let ctl = null;
    let boundary = null;
    const lines = [];

    // /clear has priority over every other judgement (spec §6). The predicate
    // wants the v1 entry shape; at write time this IS a full wire snapshot, so
    // a synthetic _isCheckpoint:true carrier is faithful.
    const isClear = prev > 0 && isPostClearCheckpoint({ _isCheckpoint: true, body: { messages: msgs } }, prev);
    if (isClear) {
      st.epoch += 1;
      st.count = 0;
      st.tailFp = '';
      boundary = 'clear';
      evt = 'snapshot';
      lines.push({ seq: ids.seq, rid: ids.rid, t: 'snapshot', msgs, reason: 'first' });
    } else if (len === prev && tailFp === prevTailFp) {
      // Unchanged wire state → no conversation event (journal still records req/done).
      evt = null;
    } else if (len === prev && prev > 0 && prevTailFp !== '' && tailFp !== '' && tailFp !== prevTailFp) {
      // v1 §3.3 in-place last-message replace (same judgement as interceptor.js:802-808).
      evt = 'ctl';
      ctl = 'replace-tail';
      boundary = 'replace-tail';
      lines.push({ seq: ids.seq, rid: ids.rid, t: 'ctl', op: 'replace-tail', msg: msgs[len - 1] });
    } else if (len > prev && (prev === 0 || messageFingerprint(msgs[prev - 1]) === prevTailFp)) {
      if (prev === 0 && st.epoch === 0 && st.count === 0 && !st.everWrote) {
        // First event of a brand-new conversation → snapshot(first), so every
        // epoch file is self-contained even when it starts mid-wire (teammate
        // logs, process restart onto an existing session dir).
        evt = 'snapshot';
        lines.push({ seq: ids.seq, rid: ids.rid, t: 'snapshot', msgs, reason: 'first' });
      } else {
        evt = 'append';
        lines.push({ seq: ids.seq, rid: ids.rid, t: 'append', msgs: msgs.slice(prev) });
      }
    } else {
      // Prefix test failed: §3.1 short window / §3.2 overlap / unexplained
      // shrink / restart-onto-existing-state. Store the full wire truth.
      const reason = prev === 0 ? 'first' : (len < prev ? 'shrunk' : 'tail-mismatch');
      evt = 'snapshot';
      lines.push({ seq: ids.seq, rid: ids.rid, t: 'snapshot', msgs, reason });
      if (isCompactContinuation({ body: { messages: msgs } })) {
        ctl = 'compact';
        boundary = 'compact';
        lines.push({ seq: ids.seq, rid: ids.rid, t: 'ctl', op: 'compact' });
      }
    }

    if (lines.length > 0) {
      if (!st.dirEnsured) {
        ensureConvDirSync(this._paths, convKey);
        st.dirEnsured = true;
      }
      const path = convEpochPath(this._paths, convKey, st.epoch);
      for (const line of lines) {
        this._queue.appendTo(path, JSON.stringify(line) + '\n');
      }
      st.everWrote = true;
    }

    // Advance state to this wire truth (eagerly, mirroring v1's eager-update
    // fix for <30ms bursts — the next request must compare against THIS one).
    st.count = len;
    st.tailFp = tailFp;

    // [from,to) of the wire messages this event covers (spec §4):
    // snapshot ⇒ [0,len); append ⇒ [prev,len); replace-tail ⇒ [len-1,len);
    // no event ⇒ empty range at len.
    const msgFrom = evt === 'snapshot' ? 0 : (ctl === 'replace-tail' ? Math.max(0, len - 1) : (evt === 'append' ? prev : len));
    return { evt, ctl, epoch: st.epoch, boundary, msgFrom, msgTo: len };
  }

  /** Forget in-memory conversation states (workspace reset / resume hooks). */
  reset() {
    this._convs.clear();
  }
}
