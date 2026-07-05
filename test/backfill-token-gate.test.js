/**
 * Contract tests for AppBase._fetchPrevSegmentTeammates' supersede-token gate
 * and NDJSON handling. AppBase is a React class (antd / CSS modules) that
 * cannot be imported under node:test; per the cold-ingest-gate.test.js
 * precedent, this mirrors the method's control flow verbatim (fetch → token
 * check → parse → dedup → token check → setState). KEEP IN SYNC with
 * src/AppBase.jsx _fetchPrevSegmentTeammates.
 *
 * Also covers the byte-budget eviction of the real
 * collectFilteredRawEntriesAsync (server/lib/log-stream.js) on a tmp file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectFilteredRawEntriesAsync } from '../server/lib/log-stream.js';

// Mirror of the method's gate structure (AppBase.jsx _fetchPrevSegmentTeammates).
function makeMirror({ fetchImpl }) {
  const self = {
    _ingestToken: 1,
    _unmounted: false,
    _backfillDoneFor: null,
    _rotationContext: null,
    _requestIndexMap: new Map(),
    state: { requests: [], showAll: false },
    setStateCalls: 0,
    setState() { this.setStateCalls++; },
    async fetchPrev() {
      const ctxKey = this._rotationContext?.from || '__probe__';
      if (this._backfillDoneFor === ctxKey) return;
      const tok = this._ingestToken;
      let lines;
      try {
        const res = await fetchImpl();
        if (!res.ok) return;
        const text = await res.text();
        lines = text.split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
      } catch { return; }
      if (this._ingestToken !== tok || this._unmounted) return; // superseded mid-flight
      if (!lines || lines.length === 0) return;
      this._backfillDoneFor = ctxKey;
      const done = lines[lines.length - 1];
      if (!done || done.error || !done.prevSegment) return;
      const entries = lines.slice(1, -1).filter((e) => e && e.timestamp && e.url && !e.done);
      const fresh = entries.filter((e) => !this._requestIndexMap.has(`${e.timestamp}|${e.url}`));
      if (fresh.length === 0) return;
      if (this._ingestToken !== tok || this._unmounted) return;
      this.setState();
    },
  };
  return self;
}

const NDJSON_OK = [
  JSON.stringify({ rotationContext: { from: 'old.jsonl' }, teammateNames: [['p', 'a']] }),
  JSON.stringify({ timestamp: 't1', url: '/v1/messages', body: {} }),
  JSON.stringify({ done: true, truncated: false, prevSegment: 'old.jsonl' }),
].join('\n') + '\n';

describe('backfill supersede-token gate (mirror of _fetchPrevSegmentTeammates)', () => {
  it('a stale-token response (workspace switch mid-flight) must NOT setState', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const m = makeMirror({
      fetchImpl: async () => ({
        ok: true,
        text: async () => { await gate; return NDJSON_OK; },
      }),
    });
    const p = m.fetchPrev();
    m._ingestToken++; // supersede while the fetch is in flight
    release();
    await p;
    assert.equal(m.setStateCalls, 0);
    assert.equal(m._backfillDoneFor, null, 'superseded probe must stay retryable');
  });

  it('a current-token response with fresh entries DOES setState exactly once', async () => {
    const m = makeMirror({ fetchImpl: async () => ({ ok: true, text: async () => NDJSON_OK }) });
    await m.fetchPrev();
    assert.equal(m.setStateCalls, 1);
    assert.equal(m._backfillDoneFor, '__probe__');
    await m.fetchPrev(); // one-shot: same key skips
    assert.equal(m.setStateCalls, 1);
  });

  it('deduped-away entries and no-predecessor responses are silent no-ops', async () => {
    const m = makeMirror({ fetchImpl: async () => ({ ok: true, text: async () => NDJSON_OK }) });
    m._requestIndexMap.set('t1|/v1/messages', 0);
    await m.fetchPrev();
    assert.equal(m.setStateCalls, 0);
    const m2 = makeMirror({
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify({ rotationContext: null, teammateNames: [] }) + '\n'
          + JSON.stringify({ done: true, truncated: false, prevSegment: null }) + '\n',
      }),
    });
    await m2.fetchPrev();
    assert.equal(m2.setStateCalls, 0);
  });
});

describe('collectFilteredRawEntriesAsync byte budget', () => {
  it('evicts oldest matches beyond maxBytes and reports truncated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccv-budget-'));
    try {
      const file = join(dir, 'seg_20260101_000000.jsonl');
      const pad = 'x'.repeat(400);
      const frames = [];
      for (let i = 0; i < 10; i++) {
        frames.push(JSON.stringify({ timestamp: `t${i}`, url: `/u${i}`, teammate: 'tm', pad }));
      }
      writeFileSync(file, frames.join('\n---\n') + '\n---\n');
      const { entries, truncated } = await collectFilteredRawEntriesAsync(
        file, (e) => !!e.teammate, { maxBytes: 1500, yieldEvery: 3 },
      );
      assert.equal(truncated, true);
      assert.ok(entries.length >= 1 && entries.length < 10);
      // Newest survive eviction.
      assert.equal(entries[entries.length - 1].timestamp, 't9');
      // A single over-budget entry is still returned, untruncated.
      const single = await collectFilteredRawEntriesAsync(
        file, (e) => e.timestamp === 't0', { maxBytes: 10 },
      );
      assert.equal(single.entries.length, 1);
      assert.equal(single.truncated, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
