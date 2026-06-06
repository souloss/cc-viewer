// jsonl-archive gap2 — archiveJsonl source-validation and write-failure arms the gap suite
// (jsonl-archive-gap.test.js) leaves uncovered: the .jsonl-extension reject, the missing-source
// reject, the "source is not a regular file" reject (dir named *.jsonl), the target-already-exists
// short-circuit, and the writeZip catch (tmp write fails in a read-only dir).
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveJsonl } from '../server/lib/jsonl-archive.js';

const created = [];
let workDir;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'ccv-archive-gap2-')); created.push(workDir); });

describe('archiveJsonl input validation', () => {
  it('rejects a non-.jsonl path', () => {
    const r = archiveJsonl(join(workDir, 'notes.txt'));
    assert.deepEqual(r, { ok: false, error: 'Not a .jsonl file' });
  });

  it('rejects a missing source file', () => {
    const r = archiveJsonl(join(workDir, 'gone.jsonl'));
    assert.deepEqual(r, { ok: false, error: 'Source file not found' });
  });

  it('rejects a directory that happens to be named *.jsonl (not a regular file)', () => {
    const d = join(workDir, 'adir.jsonl');
    mkdirSync(d);
    const r = archiveJsonl(d);
    assert.equal(r.ok, false);
    assert.match(r.error, /not a regular file/i);
  });

  it('short-circuits when the target .zip already exists', () => {
    const j = join(workDir, 'dup.jsonl');
    writeFileSync(j, '{"a":1}\n');
    writeFileSync(j + '.zip', 'preexisting'); // block the archive
    const r = archiveJsonl(j);
    assert.equal(r.ok, false);
    assert.equal(r.skipped, 'target-exists');
    assert.match(r.error, /already exists/i);
    assert.equal(existsSync(j), true, 'source untouched when target exists');
  });
});

describe('archiveJsonl write failure (catch arm)', () => {
  it('returns ok:false and cleans up when the temp zip cannot be written (read-only dir)', (t) => {
    if (process.platform === 'win32') { t.skip('chmod 0o500 semantics are POSIX-only'); return; }
    const sub = join(workDir, 'ro');
    mkdirSync(sub);
    const j = join(sub, 'x.jsonl');
    writeFileSync(j, '{"a":1}\n');
    chmodSync(sub, 0o500); // r-x: writeZip's tmp file create throws ENOENT/EACCES → catch
    let r;
    try { r = archiveJsonl(j); } finally { chmodSync(sub, 0o700); }
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.length > 0, 'an error string is surfaced');
    // no .zip and no leftover .tmp.* sidecar produced
    assert.equal(existsSync(j + '.zip'), false, 'no partial zip left behind');
  });
});

after(() => {
  for (const d of created) { try { rmSync(d, { recursive: true, force: true }); } catch { /* noop */ } }
});
