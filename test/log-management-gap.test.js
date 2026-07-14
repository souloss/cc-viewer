// log-management 覆盖补缺：补 test/log-management.test.js / delta-e2e.test.js
// 合并后仍未触达的分支。目标缺口（c8）：
//   - validateLogPath ACCESS_DENIED（symlink 逃逸到 logDir 之外）
//   - listLocalLogs：stats json 解析失败的 catch + stats 缓存命中（turns/preview 注入）
//   - deleteLogFiles：Not found / Access denied(symlink 逃逸) / unlink 抛错的 catch
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateLogPath, listLocalLogs, deleteLogFiles,
} from '../server/lib/log-management.js';

let tmpDir;
function entry(ts, url) { return JSON.stringify({ timestamp: ts, url, body: { model: 'm' } }); }
function writeLog(project, filename, lines) {
  const pd = join(tmpDir, project);
  mkdirSync(pd, { recursive: true });
  writeFileSync(join(pd, filename), lines.join('\n---\n') + '\n---\n');
  return join(pd, filename);
}

beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'ccv-logmgmt-gap-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe('validateLogPath ACCESS_DENIED', () => {
  it('throws ACCESS_DENIED when the file is a symlink escaping logDir', (t) => {
    const outside = mkdtempSync(join(tmpdir(), 'ccv-outside-'));
    const secret = join(outside, 'secret.jsonl');
    writeFileSync(secret, entry('t', 'u'));
    const pd = join(tmpDir, 'proj');
    mkdirSync(pd, { recursive: true });
    try { symlinkSync(secret, join(pd, 'link.jsonl')); }
    catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('no symlink perm'); return; } throw e; }
    assert.throws(
      () => validateLogPath(tmpDir, 'proj/link.jsonl'),
      (e) => e.code === 'ACCESS_DENIED',
    );
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('listLocalLogs stats handling', () => {
  it('tolerates a corrupt <project>.json (catch swallows parse error, file still listed)', async () => {
    writeLog('proj', 'proj_20260601_120000.jsonl', [entry('t1', 'u1')]);
    writeFileSync(join(tmpDir, 'proj', 'proj.json'), '{ broken json'); // JSON.parse 抛 → catch
    const res = await listLocalLogs(tmpDir, 'proj');
    assert.equal(res.proj.length, 1);
    assert.equal(res.proj[0].turns, 0, 'no usable stats → turns defaults to 0');
    assert.deepEqual(res.proj[0].preview, []);
  });

  it('injects turns/preview from a valid <project>.json stats cache', async () => {
    const fname = 'proj_20260601_120000.jsonl';
    writeLog('proj', fname, [entry('t1', 'u1')]);
    writeFileSync(join(tmpDir, 'proj', 'proj.json'), JSON.stringify({
      files: { [fname]: { summary: { sessionCount: 7 }, preview: ['hello'] } },
    }));
    const res = await listLocalLogs(tmpDir, 'proj');
    assert.equal(res.proj[0].turns, 7);
    assert.deepEqual(res.proj[0].preview, ['hello']);
  });
});

describe('deleteLogFiles error branches', () => {
  it('reports "Not found" for a missing but well-formed log filename', () => {
    const res = deleteLogFiles(tmpDir, ['proj/ghost_20260101_000000.jsonl']);
    assert.equal(res[0].error, 'Not found');
  });

  it('reports "Access denied" for a symlink escaping logDir', (t) => {
    const outside = mkdtempSync(join(tmpdir(), 'ccv-outside-del-'));
    const secret = join(outside, 's.jsonl');
    writeFileSync(secret, 'x');
    const pd = join(tmpDir, 'proj');
    mkdirSync(pd, { recursive: true });
    try { symlinkSync(secret, join(pd, 'l.jsonl')); }
    catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('no symlink perm'); rmSync(outside, { recursive: true, force: true }); return; } throw e; }
    const res = deleteLogFiles(tmpDir, ['proj/l.jsonl']);
    assert.equal(res[0].error, 'Access denied');
    assert.equal(existsSync(secret), true, 'symlink target must NOT be deleted');
    rmSync(outside, { recursive: true, force: true });
  });

  it('catches an unlink failure and surfaces err.message (target is a directory)', () => {
    // 构造一个名为 *.jsonl 的目录：通过名字校验与 existsSync，但 unlinkSync 抛 EISDIR/EPERM → catch。
    const pd = join(tmpDir, 'proj');
    mkdirSync(join(pd, 'dir_20260101_000000.jsonl'), { recursive: true });
    const res = deleteLogFiles(tmpDir, ['proj/dir_20260101_000000.jsonl']);
    assert.equal(res[0].ok, undefined);
    assert.ok(res[0].error, 'an error string should be reported');
    assert.ok(/EISDIR|EPERM|directory|operation not permitted/i.test(res[0].error), `unexpected: ${res[0].error}`);
  });
});
