/**
 * Unit tests for resolveAskQuestions (src/utils/askOptionDesc.js).
 *
 * Regression guard for the 2026-07-02 blank multi-question popup: the modal body is
 * filled by the streamed tool_use block, which can carry empty/short questions while
 * the stream is still assembling. resolveAskQuestions falls back to the authoritative
 * pendingAsk.questions for the currently-pending ask so the popup never renders blank.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAskQuestions } from '../src/utils/askOptionDesc.js';

const Q1 = [{ question: 'a', header: 'A', options: [{ label: 'x' }] }];
const Q2 = [
  { question: 'a', header: 'A', options: [{ label: 'x' }] },
  { question: 'b', header: 'B', options: [{ label: 'y' }] },
];
const TOOL_ID = 'tooluse_abc';

describe('resolveAskQuestions', () => {
  it('uses authoritative pendingAsk.questions when streamed is empty (owner block)', () => {
    const pendingAsk = { id: TOOL_ID, questions: Q2 };
    const out = resolveAskQuestions([], TOOL_ID, TOOL_ID, pendingAsk);
    assert.equal(out, Q2);
  });

  it('uses authoritative when streamed is shorter than authoritative', () => {
    const pendingAsk = { id: TOOL_ID, questions: Q2 };
    const out = resolveAskQuestions(Q1, TOOL_ID, TOOL_ID, pendingAsk);
    assert.equal(out, Q2);
  });

  it('keeps streamed when it is already complete (same length)', () => {
    const streamed = Q2.map((q) => ({ ...q }));
    const pendingAsk = { id: TOOL_ID, questions: Q2 };
    const out = resolveAskQuestions(streamed, TOOL_ID, TOOL_ID, pendingAsk);
    assert.equal(out, streamed);
  });

  it('keeps streamed when toolId is not the pending ask (history block)', () => {
    const pendingAsk = { id: 'other_id', questions: Q2 };
    const out = resolveAskQuestions(Q1, TOOL_ID, 'other_id', pendingAsk);
    assert.equal(out, Q1);
  });

  it('keeps streamed when toolId is not the last pending ask id', () => {
    // block matches pendingAsk.id but is not the interactive owner (lastPendingAskId differs)
    const pendingAsk = { id: TOOL_ID, questions: Q2 };
    const out = resolveAskQuestions(Q1, TOOL_ID, 'someone_else', pendingAsk);
    assert.equal(out, Q1);
  });

  it('returns [] and never throws when streamed is non-array and no pendingAsk', () => {
    assert.deepEqual(resolveAskQuestions(undefined, TOOL_ID, TOOL_ID, null), []);
    assert.deepEqual(resolveAskQuestions(null, null, null, undefined), []);
  });

  it('does not fall back when authoritative is not longer (never shrinks streamed)', () => {
    const pendingAsk = { id: TOOL_ID, questions: Q1 };
    const out = resolveAskQuestions(Q2, TOOL_ID, TOOL_ID, pendingAsk);
    assert.equal(out, Q2);
  });
});
