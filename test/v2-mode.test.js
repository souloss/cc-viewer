/**
 * wire-v2 S4 — startup-only mode switch (server/lib/v2/mode.js).
 * Pins: default off, env absolute precedence (both directions), config
 * roundtrip, locked/unknown mode rejection, corrupt-file degradation.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveWireV2Mode, resolveWireV2ReadEnabled, isWriteMode,
  readWireV2Config, writeWireV2Config, wireV2ConfigPath,
  WIRE_V2_MODES, WIRE_V2_UNLOCKED,
} from '../server/lib/v2/mode.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccv-v2mode-')); });
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('wire-v2 mode switch', () => {
  it('defaults to off with no config and no env', () => {
    assert.deepEqual(resolveWireV2Mode(dir, {}), { mode: 'off', source: 'default' });
  });

  it('config roundtrip: write dual → resolve dual from config', () => {
    writeWireV2Config(dir, 'dual');
    assert.deepEqual(readWireV2Config(dir), { mode: 'dual', present: true });
    assert.deepEqual(resolveWireV2Mode(dir, {}), { mode: 'dual', source: 'config' });
    writeWireV2Config(dir, 'off');
    assert.deepEqual(resolveWireV2Mode(dir, {}), { mode: 'off', source: 'config' });
  });

  it('env overrides the config in BOTH directions (escape hatch semantics)', () => {
    writeWireV2Config(dir, 'dual');
    assert.deepEqual(resolveWireV2Mode(dir, { CCV_WIRE_V2: '0' }), { mode: 'off', source: 'env' });
    writeWireV2Config(dir, 'off');
    assert.deepEqual(resolveWireV2Mode(dir, { CCV_WIRE_V2: '1' }), { mode: 'dual', source: 'env' });
  });

  it('locked modes are declared but rejected; unknown modes rejected', () => {
    assert.ok(WIRE_V2_MODES.includes('dual-read') && WIRE_V2_MODES.includes('v2'));
    // 'dual-read' unlocked since S5; 'v2' stays locked until S9.
    assert.ok(WIRE_V2_UNLOCKED.includes('dual-read'));
    assert.ok(!WIRE_V2_UNLOCKED.includes('v2'));
    assert.throws(() => writeWireV2Config(dir, 'v2'), /not yet available/);
    assert.throws(() => writeWireV2Config(dir, 'bogus'), /unknown wire-v2 mode/);
    // a locked mode smuggled into the file on disk degrades to off
    writeFileSync(wireV2ConfigPath(dir), JSON.stringify({ mode: 'v2' }));
    assert.deepEqual(readWireV2Config(dir), { mode: 'off', present: true });
  });

  it('dual-read roundtrip: dual-writes stay on, read resolves enabled (S5)', () => {
    writeWireV2Config(dir, 'dual-read');
    assert.deepEqual(readWireV2Config(dir), { mode: 'dual-read', present: true });
    assert.ok(isWriteMode('dual-read') && isWriteMode('dual') && !isWriteMode('off') && !isWriteMode('v2'));
    assert.deepEqual(resolveWireV2ReadEnabled(dir, {}), { enabled: true, source: 'config' });
    writeWireV2Config(dir, 'dual');
    assert.deepEqual(resolveWireV2ReadEnabled(dir, {}), { enabled: false, source: 'config' });
  });

  it('CCV_WIRE_V2_READ env overrides the config in BOTH directions', () => {
    writeWireV2Config(dir, 'dual-read');
    assert.deepEqual(resolveWireV2ReadEnabled(dir, { CCV_WIRE_V2_READ: '0' }), { enabled: false, source: 'env' });
    writeWireV2Config(dir, 'off');
    assert.deepEqual(resolveWireV2ReadEnabled(dir, { CCV_WIRE_V2_READ: '1' }), { enabled: true, source: 'env' });
    // read env is independent from the write env (plan F9)
    writeWireV2Config(dir, 'dual-read');
    assert.deepEqual(resolveWireV2ReadEnabled(dir, { CCV_WIRE_V2: '0' }), { enabled: true, source: 'config' });
  });

  it('read defaults to off with no config and no env', () => {
    assert.deepEqual(resolveWireV2ReadEnabled(dir, {}), { enabled: false, source: 'default' });
  });

  it('corrupt config degrades to off', () => {
    writeFileSync(wireV2ConfigPath(dir), '{not json');
    assert.deepEqual(readWireV2Config(dir), { mode: 'off', present: false });
    assert.deepEqual(resolveWireV2Mode(dir, {}), { mode: 'off', source: 'default' });
  });

  it('config file is plain reviewable JSON', () => {
    writeWireV2Config(dir, 'dual');
    assert.deepEqual(JSON.parse(readFileSync(wireV2ConfigPath(dir), 'utf-8')), { mode: 'dual' });
  });
});
