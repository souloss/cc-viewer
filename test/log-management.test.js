import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateLogPath, listLocalLogs, readLocalLog, deleteLogFiles, mergeLogFiles } from '../server/lib/log-management.js';

let tmpDir;

function makeEntry(ts, url, mainAgent = true) {
  return JSON.stringify({ timestamp: ts, url, mainAgent, body: { model: 'test' } });
}

function writeLog(dir, project, filename, entries) {
  const projectDir = join(dir, project);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, filename), entries.join('\n---\n') + '\n---\n');
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ccv-logmgmt-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('validateLogPath', () => {
  it('returns real path for valid file', () => {
    writeLog(tmpDir, 'proj', 'proj_20260601_120000.jsonl', [makeEntry('t1', 'u1')]);
    const p = validateLogPath(tmpDir, 'proj/proj_20260601_120000.jsonl');
    assert.ok(p.endsWith('proj_20260601_120000.jsonl'));
  });

  it('throws NOT_FOUND for missing file', () => {
    assert.throws(() => validateLogPath(tmpDir, 'nope/nope.jsonl'), (e) => e.code === 'NOT_FOUND');
  });
});

describe('listLocalLogs', () => {
  it('returns empty grouped for missing dir', async () => {
    const result = await listLocalLogs(join(tmpDir, 'nonexistent'), 'proj');
    assert.equal(result._currentProject, 'proj');
  });

  it('lists files grouped by project, sorted reverse', async () => {
    writeLog(tmpDir, 'proj', 'proj_20260601_100000.jsonl', [makeEntry('t1', 'u1')]);
    writeLog(tmpDir, 'proj', 'proj_20260602_100000.jsonl', [makeEntry('t2', 'u2')]);
    const result = await listLocalLogs(tmpDir, 'proj');
    assert.ok(result.proj);
    assert.equal(result.proj.length, 2);
    assert.ok(result.proj[0].timestamp > result.proj[1].timestamp);
  });

  it('skips empty files', async () => {
    const projectDir = join(tmpDir, 'proj');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'proj_20260601_100000.jsonl'), '');
    writeLog(tmpDir, 'proj', 'proj_20260602_100000.jsonl', [makeEntry('t2', 'u2')]);
    const result = await listLocalLogs(tmpDir, 'proj');
    assert.equal(result.proj.length, 1);
  });
});

describe('listLocalLogs instance isolation (--pid)', () => {
  const untagged = 'proj_20260601_100000.jsonl';        // 无标签(旧)
  const tagged = '123__proj_20260602_100000.jsonl';     // pid=123(新)

  function seedMixed() {
    writeLog(tmpDir, 'proj', untagged, [makeEntry('t1', 'u1')]);
    writeLog(tmpDir, 'proj', tagged, [makeEntry('t2', 'u2')]);
  }

  it('default (no instanceId) lists only untagged logs, excludes <pid>__ files', async () => {
    seedMixed();
    const result = await listLocalLogs(tmpDir, 'proj');
    assert.equal(result.proj.length, 1);
    assert.ok(result.proj[0].file.endsWith(untagged));
    assert.equal(result.proj[0].instanceId, null);
  });

  it('instanceId scopes the list to that pid only', async () => {
    seedMixed();
    const result = await listLocalLogs(tmpDir, 'proj', { instanceId: '123' });
    assert.equal(result.proj.length, 1);
    assert.ok(result.proj[0].file.endsWith(tagged));
    assert.equal(result.proj[0].instanceId, '123');
  });

  it('showAll returns every instance, newest-by-timestamp first (sort-bug fix)', async () => {
    seedMixed();
    const result = await listLocalLogs(tmpDir, 'proj', { showAll: true });
    assert.equal(result.proj.length, 2);
    // 修复前：'123__' 因 '1' < 'p' 被排到列表最底；修复后按时间戳，最新的 pid 日志排最前。
    assert.ok(result.proj[0].file.endsWith(tagged), 'newest (pid-tagged) is first, not buried');
    assert.equal(result.proj[0].instanceId, '123');
    assert.equal(result.proj[1].instanceId, null);
  });

  it('parses pid correctly when the project name itself contains underscores', async () => {
    writeLog(tmpDir, 'my_proj', 'alpha__my_proj_20260601_100000.jsonl', [makeEntry('t', 'u')]);
    const scoped = await listLocalLogs(tmpDir, 'my_proj', { instanceId: 'alpha' });
    assert.equal(scoped['my_proj'].length, 1);
    assert.equal(scoped['my_proj'][0].instanceId, 'alpha');
    // 默认实例看不到 alpha 的日志
    const def = await listLocalLogs(tmpDir, 'my_proj');
    assert.equal(def['my_proj'], undefined);
  });
});

describe('readLocalLog', () => {
  it('reads and deduplicates entries', async () => {
    const e1 = makeEntry('2026-06-01T00:00:00Z', 'http://api/v1/messages');
    const e2 = makeEntry('2026-06-01T00:00:01Z', 'http://api/v1/messages');
    writeLog(tmpDir, 'proj', 'proj_20260601_100000.jsonl', [e1, e2, e1]);
    const entries = await readLocalLog(tmpDir, 'proj/proj_20260601_100000.jsonl');
    assert.equal(entries.length, 2);
  });

  it('throws for path traversal', async () => {
    await assert.rejects(
      () => readLocalLog(tmpDir, '../etc/passwd'),
      (e) => e.code === 'NOT_FOUND' || e.code === 'ACCESS_DENIED'
    );
  });
});

describe('deleteLogFiles', () => {
  it('deletes valid files and returns ok', () => {
    writeLog(tmpDir, 'proj', 'proj_20260601_100000.jsonl', [makeEntry('t1', 'u1')]);
    const results = deleteLogFiles(tmpDir, ['proj/proj_20260601_100000.jsonl']);
    assert.equal(results[0].ok, true);
  });

  it('rejects path traversal', () => {
    const results = deleteLogFiles(tmpDir, ['../evil.jsonl']);
    assert.ok(results[0].error);
  });

  it('rejects non-log filenames', () => {
    const results = deleteLogFiles(tmpDir, ['proj/config.json']);
    assert.ok(results[0].error);
  });
});

describe('mergeLogFiles', () => {
  it('merges two files into the first, deletes the second', async () => {
    const e1 = makeEntry('2026-06-01T00:00:00Z', 'http://api/v1/messages');
    const e2 = makeEntry('2026-06-01T00:00:01Z', 'http://api/v1/messages');
    writeLog(tmpDir, 'proj', 'proj_20260601_100000.jsonl', [e1]);
    writeLog(tmpDir, 'proj', 'proj_20260601_110000.jsonl', [e2]);
    const target = await mergeLogFiles(tmpDir, [
      'proj/proj_20260601_100000.jsonl',
      'proj/proj_20260601_110000.jsonl',
    ]);
    assert.equal(target, 'proj/proj_20260601_100000.jsonl');
    const merged = await readLocalLog(tmpDir, target);
    assert.equal(merged.length, 2);
  });

  it('rejects fewer than 2 files', async () => {
    await assert.rejects(
      () => mergeLogFiles(tmpDir, ['proj/a.jsonl']),
      (e) => e.code === 'INVALID_INPUT'
    );
  });

  it('rejects cross-project merge', async () => {
    writeLog(tmpDir, 'a', 'a_20260601_100000.jsonl', [makeEntry('t1', 'u1')]);
    writeLog(tmpDir, 'b', 'b_20260601_100000.jsonl', [makeEntry('t2', 'u2')]);
    await assert.rejects(
      () => mergeLogFiles(tmpDir, ['a/a_20260601_100000.jsonl', 'b/b_20260601_100000.jsonl']),
      (e) => e.code === 'INVALID_INPUT'
    );
  });

  it('rejects archived (.jsonl.zip) files', async () => {
    await assert.rejects(
      () => mergeLogFiles(tmpDir, ['proj/a.jsonl.zip', 'proj/b.jsonl']),
      (e) => e.code === 'INVALID_INPUT'
    );
  });

  it('rejects path traversal in file paths', async () => {
    await assert.rejects(
      () => mergeLogFiles(tmpDir, ['proj/../evil.jsonl', 'proj/b.jsonl']),
      (e) => e.code === 'INVALID_INPUT'
    );
  });
});
