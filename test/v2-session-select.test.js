/**
 * Task B — cold-load fallback session picker (server/lib/v2/session-select.js).
 *
 * latestMainSessionDir(projectDir) returns the newest readable NON-teammate
 * session dir of a project (by meta.startTs), or '' — so a fresh `ccv` cold
 * load isn't blank. These pin the selection gates: journal-exists,
 * wireFormat support, teammate exclusion, newest-by-startTs, empty cases.
 *
 * Data-safety: fixtures are hand-built under mkdtemp; nothing touches the real
 * CCV_LOG_DIR.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { latestMainSessionDir, sessionHasMainTurn } from '../server/lib/v2/session-select.js';

let projectDir;
beforeEach(() => { projectDir = mkdtempSync(join(tmpdir(), 'ccv-sel-')); });
afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }); } catch {} });

/** Build a session dir under projectDir/sessions/<sid> with a meta.json and
 *  (optionally) a journal.jsonl. `mainTurn` (default true) writes a kind:'main'
 *  req so the session counts as "activated"; false leaves it empty/sub-only. */
function seed(sid, { startTs, wireFormat = 2, leader = null, journal = true, mainTurn = true } = {}) {
  const dir = join(projectDir, 'sessions', sid);
  mkdirSync(dir, { recursive: true });
  const meta = { wireFormat, sessionId: sid, project: 'proj', startTs };
  if (leader) meta.leader = leader;
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  if (journal) {
    const lines = [JSON.stringify({ ph: 'meta', wireFormat, sessionId: sid })];
    if (mainTurn) {
      lines.push(JSON.stringify({ ph: 'req', seq: 1, rid: 'r1', kind: 'main', ts: startTs, url: 'u' }));
      lines.push(JSON.stringify({ ph: 'done', seq: 1, rid: 'r1', ts: startTs, status: 'ok' }));
    } else {
      // sub-only / not-yet-activated: a non-main req sets a sid but no main turn.
      lines.push(JSON.stringify({ ph: 'req', seq: 1, rid: 'r1', kind: 'sub', ts: startTs, url: 'u' }));
    }
    writeFileSync(join(dir, 'journal.jsonl'), lines.join('\n') + '\n');
  }
  return dir;
}

const iso = (n) => new Date(Date.UTC(2026, 6, 14, 5, 0, n)).toISOString();

describe('latestMainSessionDir', () => {
  it('returns "" when the project has no sessions', () => {
    assert.equal(latestMainSessionDir(projectDir), '');
  });

  it('returns "" for a falsy projectDir', () => {
    assert.equal(latestMainSessionDir(''), '');
    assert.equal(latestMainSessionDir(null), '');
  });

  it('selects the single main session', () => {
    const dir = seed('s1', { startTs: iso(1) });
    assert.equal(latestMainSessionDir(projectDir), dir);
  });

  it('selects the newest by meta.startTs among N sessions', () => {
    seed('s1', { startTs: iso(1) });
    const newest = seed('s2', { startTs: iso(3) });
    seed('s3', { startTs: iso(2) });
    assert.equal(latestMainSessionDir(projectDir), newest);
  });

  it('excludes teammate sessions (meta.leader present) even when newest', () => {
    const leaderDir = seed('leader', { startTs: iso(1) });
    seed('tm', { startTs: iso(5), leader: { agentName: 'worker-1', teamName: 'team-x' } });
    // The teammate is newest by startTs but must be skipped → the leader wins.
    assert.equal(latestMainSessionDir(projectDir), leaderDir);
  });

  it('returns "" when the only session is a teammate', () => {
    seed('tm', { startTs: iso(5), leader: { agentName: 'w' } });
    assert.equal(latestMainSessionDir(projectDir), '');
  });

  it('skips a torn session (meta but no journal), picking the next readable one', () => {
    seed('torn', { startTs: iso(5), journal: false });
    const good = seed('good', { startTs: iso(2) });
    assert.equal(latestMainSessionDir(projectDir), good);
  });

  it('skips an unsupported wireFormat session (future v3)', () => {
    seed('v3', { startTs: iso(5), wireFormat: 3 });
    const good = seed('good', { startTs: iso(2) });
    assert.equal(latestMainSessionDir(projectDir), good);
  });

  it('tolerates a missing/corrupt meta.json without crashing', () => {
    const dir = join(projectDir, 'sessions', 'bad');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'journal.jsonl'), 'x\n');
    writeFileSync(join(dir, 'meta.json'), '{ not json');
    const good = seed('good', { startTs: iso(2) });
    assert.equal(latestMainSessionDir(projectDir), good);
  });

  it('skips a newest session that has NO main turn (the refresh-bug case), picking the newest activated one', () => {
    const activated = seed('act', { startTs: iso(2) });          // has a main turn
    seed('empty', { startTs: iso(9), mainTurn: false });          // newest but sub-only → skip
    assert.equal(latestMainSessionDir(projectDir), activated);
  });

  it('returns "" when NO session has a main turn', () => {
    seed('e1', { startTs: iso(2), mainTurn: false });
    seed('e2', { startTs: iso(5), mainTurn: false });
    assert.equal(latestMainSessionDir(projectDir), '');
  });
});

describe('sessionHasMainTurn', () => {
  it('true when the journal has a kind:main req', () => {
    const dir = seed('s1', { startTs: iso(1) });
    assert.equal(sessionHasMainTurn(dir), true);
  });
  it('false for a sub-only / not-yet-activated session', () => {
    const dir = seed('s1', { startTs: iso(1), mainTurn: false });
    assert.equal(sessionHasMainTurn(dir), false);
  });
  it('false when the journal is missing', () => {
    const dir = seed('s1', { startTs: iso(1), journal: false });
    assert.equal(sessionHasMainTurn(dir), false);
  });
});
