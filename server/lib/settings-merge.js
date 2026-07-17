import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Merges a user-supplied `--settings` launch arg into cc-viewer's injected settings
// object, so the final claude argv carries a SINGLE `--settings` flag.
//
// Why: claude's argv parser is last-wins for duplicate `--settings` (empirically
// verified on 2.1.212 — not documented). cc-viewer prepends its injected flag before
// user args, so a user-supplied `--settings` used to silently clobber the injected
// env.ANTHROPIC_BASE_URL proxy override (breaking capture) and the CCV_IM_DENY
// permissions.deny hardening. Merging keeps both: injected keys win, everything
// else the user set rides along.
//
// Parse rules pinned by experiments against claude 2.1.212:
// - Tokens after a literal `--` are prompt text, never flags → scan stops there.
// - `--settings <next>` consumes the next token as its value unconditionally, even
//   an option-like one (`--settings --print` → claude reads "--print" as a settings
//   path and hard-errors). The helper mirrors that consumption.
// - A trailing valueless `--settings` makes claude exit with "argument missing" →
//   left in place so claude surfaces its own usage error, exactly as pre-fix.
// - An empty `--settings=` does NOT error but still clobbers earlier `--settings`
//   flags via last-wins (the most dangerous form) → always stripped.
//
// Known accepted limitation (shared with withDefaultThinkingDisplay / hasArg): a
// literal "--settings" appearing before `--` as ANOTHER value-flag's argument
// (e.g. `--append-system-prompt "--settings"`) is indistinguishable without a full
// claude flag table. Probability negligible; bounded by the stop-at-`--` rule.

const FLAG = '--settings';

function stripBom(s) {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Load a --settings value the way claude does: inline JSON when it looks like an
// object literal, otherwise a settings file path (resolved against the cwd claude
// itself will run with). Throws on any failure — caller turns that into a warning.
function loadSettingsValue(value, cwd) {
  const trimmed = stripBom(value).trim();
  if (trimmed === '') throw new Error('empty value');
  let parsed;
  if (trimmed.startsWith('{')) {
    parsed = JSON.parse(trimmed);
  } else {
    parsed = JSON.parse(stripBom(readFileSync(resolve(cwd, trimmed), 'utf8')));
  }
  if (!isPlainObject(parsed)) throw new Error('settings must be a JSON object');
  return parsed;
}

// Shallow top-level merge with two special cases; injected keys win. Deep-merging
// other keys (hooks, statusLine, ...) would splice into structures the user owns.
function mergeSettings(userSettings, injectedSettings) {
  const merged = { ...userSettings };
  for (const [key, injectedValue] of Object.entries(injectedSettings)) {
    if (key === 'env' && isPlainObject(merged.env)) {
      merged.env = { ...merged.env, ...injectedValue };
    } else if (key === 'permissions' && isPlainObject(merged.permissions)) {
      const userDeny = Array.isArray(merged.permissions.deny) ? merged.permissions.deny : [];
      const injectedDeny = Array.isArray(injectedValue.deny) ? injectedValue.deny : [];
      merged.permissions = {
        ...merged.permissions,
        ...injectedValue,
        deny: [...new Set([...userDeny, ...injectedDeny])],
      };
    } else {
      merged[key] = injectedValue;
    }
  }
  return merged;
}

/**
 * Extract any user `--settings` occurrences from launch args and merge the last
 * one into the injected settings object (injected keys win; permissions.deny is
 * unioned). Never throws — a value that cannot be loaded is dropped and reported
 * via `warning` so the caller can surface it (injection must never block spawn).
 *
 * @param {unknown} args launch args (user-controlled; may contain non-strings)
 * @param {object} injectedSettings cc-viewer's settings object (env.ANTHROPIC_BASE_URL, optional permissions.deny)
 * @param {{cwd?: string}} [opts] base dir for relative settings file paths — must match the cwd claude runs with
 * @returns {{args: unknown[], settingsJson: string, merged: boolean, warning: string|null, warningDetail: {value: string, reason: string}|null}}
 *   args: input args with consumed `--settings` occurrences removed;
 *   settingsJson: JSON for the single injected flag (byte-identical to
 *   JSON.stringify(injectedSettings) when nothing merged);
 *   merged: whether a user value was folded in; warning: composed load-failure
 *   message (or null); warningDetail: the same failure as {value, reason} parts
 *   for callers that localize the sentence themselves.
 */
export function mergeSettingsIntoArgs(args, injectedSettings, { cwd = process.cwd() } = {}) {
  const passthrough = { merged: false, warning: null, warningDetail: null, settingsJson: JSON.stringify(injectedSettings) };
  if (!Array.isArray(args)) return { args: [], ...passthrough };

  const cleaned = [];
  let lastValue = null; // last consumed --settings value (claude is last-wins)
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (typeof token !== 'string') { cleaned.push(token); continue; }
    if (token === '--') { cleaned.push(...args.slice(i)); break; }
    if (token.startsWith(FLAG + '=')) {
      lastValue = token.slice(FLAG.length + 1); // may be '' — still stripped (empty form clobbers via last-wins)
      continue;
    }
    if (token === FLAG) {
      if (i + 1 >= args.length) { cleaned.push(token); continue; } // trailing valueless: claude errors "argument missing" itself
      lastValue = args[i + 1];
      i++;
      continue;
    }
    cleaned.push(token);
  }

  if (lastValue === null) return { args: cleaned, ...passthrough };

  try {
    if (typeof lastValue !== 'string') throw new Error('value is not a string');
    const userSettings = loadSettingsValue(lastValue, cwd);
    return {
      args: cleaned,
      settingsJson: JSON.stringify(mergeSettings(userSettings, injectedSettings)),
      merged: true,
      warning: null,
      warningDetail: null,
    };
  } catch (err) {
    const shown = typeof lastValue === 'string' ? lastValue : String(lastValue);
    const reason = String(err?.message || err);
    return {
      args: cleaned,
      ...passthrough,
      warning: `could not load user --settings value ${JSON.stringify(shown)} (${reason}); launching with cc-viewer's injected settings only`,
      warningDetail: { value: shown, reason },
    };
  }
}
