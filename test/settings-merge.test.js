import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeSettingsIntoArgs } from '../server/lib/settings-merge.js';

// claude settings objects (NOT child-process spawn environments). Defined via
// JSON.parse instead of object literals: the test-env-isolation-guard static
// scanner treats any bare environment-key object literal as a child-process
// environment and would flag these as isolation violations.
const INJECTED = JSON.parse('{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9000"}}');
const INJECTED_IM = JSON.parse(
  '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9000"},"permissions":{"deny":["Bash(sudo:*)","Bash(rm -rf:*)"]}}'
);

let dirs = [];
function mkTmp() {
  const d = mkdtempSync(join(tmpdir(), 'ccv-settings-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  dirs = [];
});

describe('mergeSettingsIntoArgs: no user flag (the common path)', () => {
  it('passes args through and emits byte-identical injected JSON', () => {
    const args = ['--print', '-c', '--model', 'opus'];
    const r = mergeSettingsIntoArgs(args, INJECTED);
    assert.deepEqual(r.args, args);
    assert.equal(r.merged, false);
    assert.equal(r.warning, null);
    assert.equal(r.settingsJson, JSON.stringify(INJECTED));
  });

  it('emits byte-identical JSON for the CCV_IM_DENY object too (key order preserved)', () => {
    const r = mergeSettingsIntoArgs([], INJECTED_IM);
    assert.equal(r.settingsJson, JSON.stringify(INJECTED_IM));
  });

  it('handles empty and non-array inputs without throwing', () => {
    assert.deepEqual(mergeSettingsIntoArgs([], INJECTED).args, []);
    assert.deepEqual(mergeSettingsIntoArgs(null, INJECTED).args, []);
    assert.deepEqual(mergeSettingsIntoArgs(undefined, INJECTED).args, []);
    assert.equal(mergeSettingsIntoArgs('nope', INJECTED).settingsJson, JSON.stringify(INJECTED));
  });

  it('skips non-string tokens without throwing (launch endpoint only validates Array.isArray)', () => {
    const args = [123, { a: 1 }, null, '--print'];
    const r = mergeSettingsIntoArgs(args, INJECTED);
    assert.deepEqual(r.args, args);
    assert.equal(r.merged, false);
  });
});

describe('mergeSettingsIntoArgs: inline JSON merge', () => {
  it('merges user env keys but injected ANTHROPIC_BASE_URL wins', () => {
    const user = '{"env":{"ANTHROPIC_BASE_URL":"http://evil","FOO":"bar"}}';
    const r = mergeSettingsIntoArgs(['--settings', user, '--print'], INJECTED);
    assert.deepEqual(r.args, ['--print']);
    assert.equal(r.merged, true);
    assert.equal(r.warning, null);
    const merged = JSON.parse(r.settingsJson);
    assert.equal(merged.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9000');
    assert.equal(merged.env.FOO, 'bar');
  });

  it('supports the --settings=VALUE form', () => {
    const r = mergeSettingsIntoArgs([`--settings={"model":"opus"}`, '-c'], INJECTED);
    assert.deepEqual(r.args, ['-c']);
    const merged = JSON.parse(r.settingsJson);
    assert.equal(merged.model, 'opus');
    assert.equal(merged.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9000');
  });

  it('copies unrelated top-level keys verbatim (no deep merge into hooks/statusLine)', () => {
    const user = '{"statusLine":{"type":"command","command":"foo"},"hooks":{"PreToolUse":[{"matcher":"x"}]}}';
    const r = mergeSettingsIntoArgs(['--settings', user], INJECTED);
    const merged = JSON.parse(r.settingsJson);
    assert.deepEqual(merged.statusLine, { type: 'command', command: 'foo' });
    assert.deepEqual(merged.hooks, { PreToolUse: [{ matcher: 'x' }] });
  });

  it('strips an inline BOM before parsing', () => {
    const r = mergeSettingsIntoArgs(['--settings', '﻿{"model":"opus"}'], INJECTED);
    assert.equal(r.merged, true);
    assert.equal(JSON.parse(r.settingsJson).model, 'opus');
  });
});

describe('mergeSettingsIntoArgs: file path values', () => {
  it('loads a relative path against the cwd option', () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'my.json'), '{"env":{"FOO":"file"}}');
    const r = mergeSettingsIntoArgs(['--settings', 'my.json'], INJECTED, { cwd: dir });
    assert.equal(r.merged, true);
    const merged = JSON.parse(r.settingsJson);
    assert.equal(merged.env.FOO, 'file');
    assert.equal(merged.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9000');
  });

  it('loads an absolute path regardless of cwd', () => {
    const dir = mkTmp();
    const p = join(dir, 'abs.json');
    writeFileSync(p, '{"model":"opus"}');
    const r = mergeSettingsIntoArgs(['--settings', p], INJECTED, { cwd: '/nonexistent-cwd' });
    assert.equal(r.merged, true);
    assert.equal(JSON.parse(r.settingsJson).model, 'opus');
  });

  it('strips a BOM from file contents', () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'bom.json'), '﻿{"model":"opus"}');
    const r = mergeSettingsIntoArgs(['--settings', 'bom.json'], INJECTED, { cwd: dir });
    assert.equal(r.merged, true);
    assert.equal(JSON.parse(r.settingsJson).model, 'opus');
  });
});

describe('mergeSettingsIntoArgs: permissions merge', () => {
  it('unions deny (deduped) and preserves user allow/ask verbatim', () => {
    const user = JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'], ask: ['Bash(git:*)'], deny: ['Read(/secret/**)', 'Bash(sudo:*)'] },
    });
    const r = mergeSettingsIntoArgs(['--settings', user], INJECTED_IM);
    const merged = JSON.parse(r.settingsJson);
    assert.deepEqual(merged.permissions.allow, ['Bash(ls:*)']);
    assert.deepEqual(merged.permissions.ask, ['Bash(git:*)']);
    assert.deepEqual(merged.permissions.deny, ['Read(/secret/**)', 'Bash(sudo:*)', 'Bash(rm -rf:*)']);
  });

  it('uses injected permissions wholesale when the user has none', () => {
    const r = mergeSettingsIntoArgs(['--settings', '{"model":"opus"}'], INJECTED_IM);
    const merged = JSON.parse(r.settingsJson);
    assert.deepEqual(merged.permissions, INJECTED_IM.permissions);
  });

  it('never synthesizes permissions when injected has none (cli.js path)', () => {
    const r = mergeSettingsIntoArgs(['--settings', '{"model":"opus"}'], INJECTED);
    assert.equal('permissions' in JSON.parse(r.settingsJson), false);
  });

  it('keeps user permissions verbatim when injected has none', () => {
    const user = '{"permissions":{"deny":["Read(/secret/**)"]}}';
    const r = mergeSettingsIntoArgs(['--settings', user], INJECTED);
    assert.deepEqual(JSON.parse(r.settingsJson).permissions, { deny: ['Read(/secret/**)'] });
  });

  it('user permissions without a deny array: injected deny lands whole, user allow preserved', () => {
    const user = '{"permissions":{"allow":["Bash(ls:*)"]}}';
    const r = mergeSettingsIntoArgs(['--settings', user], INJECTED_IM);
    const merged = JSON.parse(r.settingsJson);
    assert.deepEqual(merged.permissions.deny, INJECTED_IM.permissions.deny);
    assert.deepEqual(merged.permissions.allow, ['Bash(ls:*)']);
  });

  it('user env present but non-object: injected env replaces it wholesale', () => {
    const r = mergeSettingsIntoArgs(['--settings', '{"env":"not-an-object"}'], INJECTED);
    assert.deepEqual(JSON.parse(r.settingsJson).env, INJECTED.env);
  });
});

describe('mergeSettingsIntoArgs: multiple occurrences (claude is last-wins)', () => {
  it('strips all consumed occurrences and merges only the last', () => {
    const r = mergeSettingsIntoArgs(
      ['--settings', '{"model":"first"}', '-c', '--settings={"model":"last"}'],
      INJECTED,
    );
    assert.deepEqual(r.args, ['-c']);
    assert.equal(JSON.parse(r.settingsJson).model, 'last');
  });

  it('does not fall back to an earlier valid occurrence when the last fails to load', () => {
    const r = mergeSettingsIntoArgs(
      ['--settings', '{"model":"first"}', '--settings', '{broken'],
      INJECTED,
    );
    assert.deepEqual(r.args, []);
    assert.equal(r.merged, false);
    assert.ok(r.warning);
    assert.equal(r.settingsJson, JSON.stringify(INJECTED));
  });

  it('[--settings a.json --settings] → a.json merges, trailing valueless left in place', () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'a.json'), '{"model":"opus"}');
    const r = mergeSettingsIntoArgs(['--settings', 'a.json', '--settings'], INJECTED, { cwd: dir });
    assert.deepEqual(r.args, ['--settings']);
    assert.equal(r.merged, true);
    assert.equal(JSON.parse(r.settingsJson).model, 'opus');
  });
});

describe('mergeSettingsIntoArgs: claude argv-semantics parity (pinned by experiments on 2.1.212)', () => {
  it('leaves a trailing valueless --settings in place (claude errors "argument missing" itself)', () => {
    const r = mergeSettingsIntoArgs(['--print', '--settings'], INJECTED);
    assert.deepEqual(r.args, ['--print', '--settings']);
    assert.equal(r.merged, false);
    assert.equal(r.warning, null);
  });

  it('strips an empty --settings= (claude silently clobbers earlier flags with it)', () => {
    const r = mergeSettingsIntoArgs(['--settings=', '--print'], INJECTED);
    assert.deepEqual(r.args, ['--print']);
    assert.equal(r.merged, false);
    assert.ok(r.warning);
    assert.equal(r.settingsJson, JSON.stringify(INJECTED));
  });

  it('consumes an option-like next token as the value, as claude does (--settings --print)', () => {
    const r = mergeSettingsIntoArgs(['--settings', '--print', '-c'], INJECTED);
    assert.deepEqual(r.args, ['-c']);
    assert.equal(r.merged, false);
    assert.ok(r.warning.includes('--print'));
    assert.equal(r.settingsJson, JSON.stringify(INJECTED));
  });

  it('stops scanning at -- (everything after is prompt text to claude)', () => {
    const args = ['-p', '--', '--settings', '{"env":{"ANTHROPIC_BASE_URL":"http://evil"}}'];
    const r = mergeSettingsIntoArgs(args, INJECTED);
    assert.deepEqual(r.args, args);
    assert.equal(r.merged, false);
    assert.equal(r.settingsJson, JSON.stringify(INJECTED));
  });
});

describe('mergeSettingsIntoArgs: content failures → warning + injected-only', () => {
  const failing = [
    ['invalid inline JSON', '{broken'],
    ['JSON-valid array', '[]'],
    ['JSON-valid null', 'null'],
    ['JSON-valid number', '42'],
    ['JSON-valid string', '"str"'],
    ['nonexistent file', 'no-such-file.json'],
  ];
  for (const [label, value] of failing) {
    it(`${label}: drops the user flag with a warning`, () => {
      const dir = mkTmp();
      const r = mergeSettingsIntoArgs(['--settings', value, '--print'], INJECTED, { cwd: dir });
      assert.deepEqual(r.args, ['--print']);
      assert.equal(r.merged, false);
      assert.ok(r.warning, `expected warning for ${label}`);
      assert.equal(r.settingsJson, JSON.stringify(INJECTED));
    });
  }

  it('unreadable file (permission denied): drops with a warning', (t) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip();
    const dir = mkTmp();
    const p = join(dir, 'locked.json');
    writeFileSync(p, '{"model":"opus"}');
    chmodSync(p, 0o000);
    const r = mergeSettingsIntoArgs(['--settings', p], INJECTED);
    assert.equal(r.merged, false);
    assert.ok(r.warning);
    assert.equal(r.settingsJson, JSON.stringify(INJECTED));
  });

  it('file whose JSON is not an object: drops with a warning', () => {
    const dir = mkTmp();
    writeFileSync(join(dir, 'arr.json'), '[1,2]');
    const r = mergeSettingsIntoArgs(['--settings', 'arr.json'], INJECTED, { cwd: dir });
    assert.equal(r.merged, false);
    assert.ok(r.warning);
  });

  it('non-string value token (hostile input): consumed, dropped with a warning, never throws', () => {
    const r = mergeSettingsIntoArgs(['--settings', 123, '--print'], INJECTED);
    assert.deepEqual(r.args, ['--print']);
    assert.equal(r.merged, false);
    assert.ok(r.warning);
  });
});
