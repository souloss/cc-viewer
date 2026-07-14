// Wire Format v2 — persisted mode switch (S4 UX).
//
// One enum covers the whole migration lifecycle; only the modes whose steps
// have landed are selectable, the rest are declared but locked:
//   off        v1 only (default)
//   dual       v1 + v2 dual-write (S3+, the soak mode)
//   dual-read  dual-write + v2-backed read path   — locked until S5
//   v2         v2 read/write, v1 writes stopped   — locked until S9
//
// Persistence: LOG_DIR/wire-v2.json {"mode":"dual"} (same home as profile.json).
// The file is read ONCE at interceptor boot — switching takes effect on the
// next ccv/claude launch, never mid-process (user decision: startup-only).
// Precedence: env CCV_WIRE_V2 ('1'→dual, '0'→off) OVERRIDES the file — the env
// vars keep their absolute escape-hatch/rollback semantics (plan risk F9).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const WIRE_V2_MODES = ['off', 'dual', 'dual-read', 'v2'];
export const WIRE_V2_UNLOCKED = ['off', 'dual', 'dual-read']; // grows as plan steps land ('dual-read' since S5)

export function wireV2ConfigPath(logDir) {
  return join(logDir, 'wire-v2.json');
}

/** Read the persisted mode; missing/corrupt/locked values degrade to 'off'. */
export function readWireV2Config(logDir) {
  try {
    const p = wireV2ConfigPath(logDir);
    if (!existsSync(p)) return { mode: 'off', present: false };
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    const mode = WIRE_V2_UNLOCKED.includes(data?.mode) ? data.mode : 'off';
    return { mode, present: true };
  } catch {
    return { mode: 'off', present: false };
  }
}

/**
 * Resolve the effective mode at boot.
 * @returns {{mode: string, source: 'env'|'config'|'default'}}
 */
export function resolveWireV2Mode(logDir, env = process.env) {
  if (env.CCV_WIRE_V2 === '1') return { mode: 'dual', source: 'env' };
  if (env.CCV_WIRE_V2 === '0') return { mode: 'off', source: 'env' };
  const cfg = readWireV2Config(logDir);
  if (cfg.present) return { mode: cfg.mode, source: 'config' };
  return { mode: 'off', source: 'default' };
}

/** Modes whose READ path is v2-backed (adapter, S5). */
const READ_MODES = ['dual-read', 'v2'];

/**
 * Resolve whether the v2-backed read path is enabled at boot (S5).
 * Independent kill switch (plan F9): env CCV_WIRE_V2_READ ('1'/'0') overrides
 * the config file in BOTH directions, exactly like CCV_WIRE_V2 does for writes.
 * @returns {{enabled: boolean, source: 'env'|'config'|'default'}}
 */
export function resolveWireV2ReadEnabled(logDir, env = process.env) {
  if (env.CCV_WIRE_V2_READ === '1') return { enabled: true, source: 'env' };
  if (env.CCV_WIRE_V2_READ === '0') return { enabled: false, source: 'env' };
  const cfg = readWireV2Config(logDir);
  if (cfg.present) return { enabled: READ_MODES.includes(cfg.mode), source: 'config' };
  return { enabled: false, source: 'default' };
}

/** Modes under which the v2 WRITE tap runs (dual-read still dual-writes). */
export function isWriteMode(mode) {
  return mode === 'dual' || mode === 'dual-read';
}

/**
 * Persist a mode choice. Throws on unknown modes; rejects locked-but-declared
 * modes with a distinguishable error so the route can 400 with a clear message.
 */
export function writeWireV2Config(logDir, mode) {
  if (!WIRE_V2_MODES.includes(mode)) {
    const err = new Error(`unknown wire-v2 mode: ${mode}`);
    err.code = 'UNKNOWN_MODE';
    throw err;
  }
  if (!WIRE_V2_UNLOCKED.includes(mode)) {
    const err = new Error(`wire-v2 mode not yet available: ${mode}`);
    err.code = 'LOCKED_MODE';
    throw err;
  }
  writeFileSync(wireV2ConfigPath(logDir), JSON.stringify({ mode }, null, 2) + '\n', { mode: 0o600 });
  return { mode };
}
