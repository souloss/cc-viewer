/**
 * Gap top-up for src/utils/ptyChunkBuilder.js
 *
 * The sibling test/pty-chunk-builder.test.js asserts the keystroke sequences but
 * exercises an *inlined copy* of the logic — the real ESM module is never imported,
 * so c8 reports it ~60%. This file imports the REAL module and drives every exported
 * function + every branch the inline copy can't reach against the actual code:
 *   - getCursorIdx via prompt.options[].selected and the number-remap branch (L56-59)
 *   - buildSingleSelect with prompt whose option .number does NOT match (no remap)
 *   - the buildChunksForAnswer dispatcher's 4 arms (L198-207)
 *   - buildBracketPasteSubmitChunks happy + falsy/non-string paths (L223-225)
 *
 * Module has clean imports (no svg / extensionless), so a direct static import works.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSingleSelectChunks,
  buildMultiSelectChunks,
  buildOtherChunks,
  buildMultiSelectOtherChunks,
  buildChunksForAnswer,
  buildBracketPasteSubmitChunks,
  BRACKET_PASTE_SUBMIT_SETTLE_MS,
} from '../src/utils/ptyChunkBuilder.js';

const ARROW_DOWN = '\x1b[B';
const ARROW_UP = '\x1b[A';
const ARROW_RIGHT = '\x1b[C';
const SPACE = ' ';
const ENTER = '\r';

// Build a prompt whose options[].number matches 1-based positions and whose
// `selected` flag marks the cursor.
function makePrompt(count, cursorAt = 0) {
  const options = [];
  for (let i = 0; i < count; i++) {
    options.push({ number: i + 1, label: `Option ${i + 1}`, selected: i === cursorAt });
  }
  return { options };
}

describe('ptyChunkBuilder (real module) — getCursorIdx & number remap', () => {
  it('reads cursor from the option flagged selected (not index 0)', () => {
    const prompt = makePrompt(4, 2); // cursor at idx 2
    // target idx 0 → 2 up arrows
    const chunks = buildSingleSelectChunks({ optionIndex: 0 }, prompt);
    assert.deepEqual(chunks, [ARROW_UP, ARROW_UP, ENTER]);
  });

  it('remaps optionIndex→targetIdx by matching option.number (L56-59)', () => {
    // options reordered so option.number !== array position. optionIndex 0 → number 1,
    // which lives at array index 2 → cursor 0 must travel down 2.
    const prompt = {
      options: [
        { number: 3, selected: true },  // cursor here (idx 0)
        { number: 2, selected: false },
        { number: 1, selected: false }, // number 1 → array idx 2
      ],
    };
    const chunks = buildSingleSelectChunks({ optionIndex: 0 }, prompt);
    assert.deepEqual(chunks, [ARROW_DOWN, ARROW_DOWN, ENTER]);
  });

  it('falls back to raw optionIndex when no option.number matches (found < 0)', () => {
    // No option has number === optionIndex+1, so targetIdx stays = answer.optionIndex.
    const prompt = { options: [{ number: 10, selected: true }, { number: 20 }, { number: 30 }] };
    const chunks = buildSingleSelectChunks({ optionIndex: 2 }, prompt);
    assert.deepEqual(chunks, [ARROW_DOWN, ARROW_DOWN, ENTER]);
  });

  it('null prompt → cursor 0, target uses raw optionIndex', () => {
    const chunks = buildSingleSelectChunks({ optionIndex: 1 }, null);
    assert.deepEqual(chunks, [ARROW_DOWN, ENTER]);
  });

  it('prompt with options but none selected → cursor 0', () => {
    const prompt = { options: [{ number: 1 }, { number: 2 }, { number: 3 }] };
    const chunks = buildSingleSelectChunks({ optionIndex: 2 }, prompt);
    assert.deepEqual(chunks, [ARROW_DOWN, ARROW_DOWN, ENTER]);
  });
});

describe('ptyChunkBuilder (real module) — multi-question last-question extra Enter', () => {
  it('single-select last question in multi-question form appends a second Enter', () => {
    const prompt = makePrompt(3, 0);
    const chunks = buildSingleSelectChunks({ optionIndex: 1, isLast: true }, prompt, true);
    assert.deepEqual(chunks, [ARROW_DOWN, ENTER, ENTER]);
  });

  it('other (single-select) last question in multi-question form appends a second Enter', () => {
    const prompt = makePrompt(2, 0);
    const chunks = buildOtherChunks({ optionIndex: 1, text: 'x', isLast: true }, prompt, true);
    assert.deepEqual(chunks, [ARROW_DOWN, 'x', ENTER, ENTER]);
  });

  it('multi-select non-last in multi-question form emits → with NO Enter', () => {
    const prompt = makePrompt(3, 0);
    const chunks = buildMultiSelectChunks({ selectedIndices: [0], isLast: false }, prompt, true);
    assert.deepEqual(chunks, [SPACE, ARROW_RIGHT]);
  });

  it('multi-select-other non-last in multi-question form omits the trailing Enter', () => {
    const prompt = makePrompt(2, 0);
    const chunks = buildMultiSelectOtherChunks(
      { optionIndex: 1, text: 'a', isLast: false }, prompt, true,
    );
    assert.deepEqual(chunks, [ARROW_DOWN, 'a', 'a', ARROW_RIGHT, ARROW_UP, ARROW_RIGHT]);
  });

  it('multi-select-other empty text → no sacrifice char', () => {
    const prompt = makePrompt(2, 0);
    const chunks = buildMultiSelectOtherChunks(
      { optionIndex: 1, text: '', isLast: true }, prompt, false,
    );
    assert.deepEqual(chunks, [ARROW_DOWN, ARROW_RIGHT, ARROW_UP, ARROW_RIGHT, ENTER]);
  });

  it('multi-select-other CJK text duplicates last grapheme as sacrifice', () => {
    const prompt = makePrompt(2, 0);
    const chunks = buildMultiSelectOtherChunks(
      { optionIndex: 1, text: '测试', isLast: true }, prompt, false,
    );
    assert.deepEqual(chunks, [ARROW_DOWN, '测', '试', '试', ARROW_RIGHT, ARROW_UP, ARROW_RIGHT, ENTER]);
  });
});

describe('ptyChunkBuilder (real module) — buildChunksForAnswer dispatcher (L198-207)', () => {
  it('type "multi" → buildMultiSelectChunks', () => {
    const prompt = makePrompt(3, 0);
    const chunks = buildChunksForAnswer({ type: 'multi', selectedIndices: [0], isLast: true }, prompt, false);
    assert.deepEqual(chunks, [SPACE, ARROW_RIGHT, ENTER]);
  });

  it('type "other" + isMultiSelect → buildMultiSelectOtherChunks', () => {
    const prompt = makePrompt(2, 0);
    const chunks = buildChunksForAnswer(
      { type: 'other', isMultiSelect: true, optionIndex: 1, text: 'a', isLast: true }, prompt, false,
    );
    assert.deepEqual(chunks, [ARROW_DOWN, 'a', 'a', ARROW_RIGHT, ARROW_UP, ARROW_RIGHT, ENTER]);
  });

  it('type "other" without isMultiSelect → buildOtherChunks', () => {
    const prompt = makePrompt(2, 0);
    const chunks = buildChunksForAnswer({ type: 'other', optionIndex: 1, text: 'z' }, prompt, false);
    assert.deepEqual(chunks, [ARROW_DOWN, 'z', ENTER]);
  });

  it('unknown / "single" type → buildSingleSelectChunks (default arm)', () => {
    const prompt = makePrompt(3, 0);
    const chunks = buildChunksForAnswer({ type: 'single', optionIndex: 2 }, prompt, false);
    assert.deepEqual(chunks, [ARROW_DOWN, ARROW_DOWN, ENTER]);
  });

  it('missing type also routes to the single-select default arm', () => {
    const prompt = makePrompt(2, 0);
    const chunks = buildChunksForAnswer({ optionIndex: 1 }, prompt, false);
    assert.deepEqual(chunks, [ARROW_DOWN, ENTER]);
  });
});

describe('ptyChunkBuilder (real module) — buildBracketPasteSubmitChunks (L223-225)', () => {
  it('wraps a non-empty string in bracket-paste markers and appends Enter', () => {
    assert.deepEqual(buildBracketPasteSubmitChunks('hi'), ['\x1b[200~hi\x1b[201~', ENTER]);
  });

  it('preserves multi-byte content verbatim inside the paste block', () => {
    assert.deepEqual(buildBracketPasteSubmitChunks('日本語'), ['\x1b[200~日本語\x1b[201~', ENTER]);
  });

  it('returns [] for empty string, null, undefined and non-string inputs', () => {
    assert.deepEqual(buildBracketPasteSubmitChunks(''), []);
    assert.deepEqual(buildBracketPasteSubmitChunks(null), []);
    assert.deepEqual(buildBracketPasteSubmitChunks(undefined), []);
    assert.deepEqual(buildBracketPasteSubmitChunks(42), []);
    assert.deepEqual(buildBracketPasteSubmitChunks({}), []);
  });

  it('exports the settle-ms constant used to space paste→Enter', () => {
    assert.equal(BRACKET_PASTE_SUBMIT_SETTLE_MS, 250);
  });
});
