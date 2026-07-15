// Cold-load fallback session selection (task B, 2026-07-15).
//
// On `ccv`/`ccv -c` startup the current session's dir does not exist until its
// first API request resolves a sid, so `getLiveLogSource()` would return '' and
// the [对话] panel loads empty. This picker supplies the session to cold-load:
// the most-recent MAIN (non-teammate) session that actually has a main turn,
// so the panel shows the last real conversation.
//
// CONTENT REQUIREMENT (2026-07-15 refresh-bug fix): a session can be the
// writer's "current" session (its sid resolved) while having NO main turn yet —
// e.g. `-c` startup, or a background sub / count_tokens request sets _currentSid
// before the user sends anything. Cold-loading such an empty session renders a
// blank panel (the symptom: fresh load shows data, a refresh once the empty
// current session exists shows nothing, and it only fills after the user sends
// a request). So selection requires at least one `kind:'main'` request — the
// "activated" session — and both getLiveLogSource and the picker apply it.
//
// Deliberately lightweight — meta.json + a bounded journal HEAD read only. It
// does NOT use listV2Sessions (dirSizeSync recursion + prompts head-reads +
// full turn counting): this runs on every cold `/events` connection.

import { existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { listSessionIds } from './replay.js';
import { isSupportedWireFormat } from './layout.js';

/**
 * Find the on-disk dir NAME of an existing session for `sessionId` (a UUID), or
 * null. Task C: dir names are `<ts>_<uuid>` (new) or `<uuid>` (legacy/staging),
 * so the identity UUID is recovered by suffix. Used by the writer (restart /
 * `-c` re-attach: must reuse the existing dir, not mint a second one) and by
 * convert's dual-write skip. Match precedence: exact `=== sessionId` (legacy),
 * then `endsWith('_'+sessionId)`; on >1 suffix match prefer meta.sessionId===id,
 * else the newest meta.startTs (partial-migration / live-skip can leave both).
 * @returns {string|null} the dir basename, or null if none exists
 */
export function resolveSessionDirName(projectDir, sessionId, sessionsDirName = 'sessions') {
  if (!projectDir || !sessionId) return null;
  const suffix = '_' + sessionId;
  let bestSuffix = null; // { name, startTs, idMatch }
  for (const name of listSessionIds(projectDir, sessionsDirName)) {
    if (name === sessionId) return name; // exact legacy dir — unambiguous
    if (!name.endsWith(suffix)) continue;
    let meta = null;
    try { meta = JSON.parse(readFileSync(join(projectDir, sessionsDirName, name, 'meta.json'), 'utf-8')); } catch { /* tolerate */ }
    const idMatch = !!(meta && meta.sessionId === sessionId);
    const startTs = (meta && meta.startTs) || '';
    if (bestSuffix === null
      || (idMatch && !bestSuffix.idMatch)
      || (idMatch === bestSuffix.idMatch && startTs > bestSuffix.startTs)) {
      bestSuffix = { name, startTs, idMatch };
    }
  }
  return bestSuffix ? bestSuffix.name : null;
}

const MAIN_REQ_SCAN_BUDGET = 256 * 1024; // a session's first main req sits at the journal head

/**
 * Does this session dir have at least one `kind:'main'` request on disk? A
 * bounded head read of journal.jsonl — the opening main request is at the top,
 * so a session that has ANY main turn is detected within the budget. An empty /
 * sub-only / not-yet-activated session returns false.
 * @param {string} dir - absolute session dir
 * @returns {boolean}
 */
export function sessionHasMainTurn(dir) {
  const journal = join(dir, 'journal.jsonl');
  if (!existsSync(journal)) return false;
  let fd;
  try {
    fd = openSync(journal, 'r');
    const buf = Buffer.alloc(MAIN_REQ_SCAN_BUDGET);
    const n = readSync(fd, buf, 0, MAIN_REQ_SCAN_BUDGET, 0);
    const head = buf.toString('utf-8', 0, n);
    let start = 0;
    for (;;) {
      let nl = head.indexOf('\n', start);
      const complete = nl !== -1;
      const line = (complete ? head.slice(start, nl) : head.slice(start)).trim();
      if (line) {
        // Cheap prefilter before JSON.parse: a main req line carries both.
        if (line.includes('"ph":"req"') && line.includes('"kind":"main"')) {
          try {
            const o = JSON.parse(line);
            if (o && o.ph === 'req' && o.kind === 'main') return true;
          } catch { /* torn line — keep scanning */ }
        }
      }
      if (!complete) break; // last (possibly truncated) line consumed
      start = nl + 1;
      if (start >= n) break;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

/**
 * Absolute dir of the newest readable, non-teammate session that HAS a main
 * turn, or '' if there is none. "Readable" mirrors listV2Sessions' gates (spec
 * §14): journal.jsonl exists and the wireFormat is supported. Candidates are
 * ordered by meta.startTs (desc) and the first with a main turn wins.
 * @param {string} projectDir - absolute LOG_DIR/<project>
 * @returns {string} absolute session dir, or ''
 */
export function latestMainSessionDir(projectDir) {
  if (!projectDir) return '';
  const candidates = []; // { dir, startTs }
  for (const sid of listSessionIds(projectDir)) {
    const dir = join(projectDir, 'sessions', sid);
    if (!existsSync(join(dir, 'journal.jsonl'))) continue;
    let meta = null;
    try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8')); } catch { continue; }
    if (!meta) continue;
    if (meta.wireFormat != null && !isSupportedWireFormat(meta.wireFormat)) continue;
    // Teammate/sub sessions carry a `leader` pointer; only a leader session
    // folds in its siblings when rendered, so a teammate dir loaded directly
    // renders wrong. Keep only main (leader-less) sessions.
    if (meta.leader) continue;
    candidates.push({ dir, startTs: meta.startTs || '' });
  }
  // Newest first, then return the first that actually has a main turn — skipping
  // a not-yet-activated newest session (the refresh-bug fix).
  candidates.sort((a, b) => (a.startTs < b.startTs ? 1 : a.startTs > b.startTs ? -1 : 0));
  for (const c of candidates) {
    if (sessionHasMainTurn(c.dir)) return c.dir;
  }
  return '';
}
