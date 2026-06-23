// log-management 覆盖补缺：补 test/log-management.test.js / jsonl-archive.test.js / delta-e2e.test.js
// 合并后仍未触达的分支。目标缺口（c8）：
//   - validateLogPath ACCESS_DENIED（symlink 逃逸到 logDir 之外）：18-23
//   - listLocalLogs：stats json 解析失败的 catch + stats 缓存命中（turns/preview 注入）：48-49
//   - deleteLogFiles：Not found / Access denied(symlink 逃逸) / unlink 抛错的 catch：93-107
//   - mergeLogFiles：NOT_FOUND（某文件缺失）/ 超出 400MB 体积上限：137-152
//   - archiveLogFiles：非法名 / 非法路径 / Not found / Access denied / archive failed / skipped(target-exists)
//                       + migrateStatsCacheKey 把统计缓存键从 .jsonl 迁到 .jsonl.zip：178-266
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { mkdtempSync as _mkdtempForTmp } from 'node:fs';
import { tmpdir as _osTmpdir } from 'node:os';
// 缓存隔离：本文件 afterEach 会 rmSync 整个 getExtractCacheRoot()（= join(os.tmpdir(),'ccv-extract')），
// 该 root 全进程共享。与 jsonl-archive.test.js 并行跑（node:test 每文件独立进程、共用 os.tmpdir）时，
// 本文件的 afterEach 会误删 jsonl-archive 刚建的 fresh cache dir → 对方「缓存命中」偶发失败（G5 定位）。
// 给本进程私有 TMPDIR，使 getExtractCacheRoot() 落到独立 root，afterEach 只清自己的。
// 必须在首次调用 getExtractCacheRoot 之前设置（静态 import 仅定义函数、不读 tmpdir）。
process.env.TMPDIR = _mkdtempForTmp(`${_osTmpdir()}/ccv-logmgmt-tmp-`);
import {
  validateLogPath, listLocalLogs, deleteLogFiles, mergeLogFiles, archiveLogFiles,
} from '../server/lib/log-management.js';
import { getExtractCacheRoot } from '../server/lib/jsonl-archive.js';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

let tmpDir;
function entry(ts, url) { return JSON.stringify({ timestamp: ts, url, body: { model: 'm' } }); }
function writeLog(project, filename, lines) {
  const pd = join(tmpDir, project);
  mkdirSync(pd, { recursive: true });
  writeFileSync(join(pd, filename), lines.join('\n---\n') + '\n---\n');
  return join(pd, filename);
}

beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'ccv-logmgmt-gap-')); });
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  try { const r = getExtractCacheRoot(); if (existsSync(r)) rmSync(r, { recursive: true, force: true }); } catch { /* noop */ }
});

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

  it('maps an archived .jsonl.zip back to its .jsonl stats key (archived branch)', async () => {
    const base = 'proj_20260601_120000.jsonl';
    const pd = join(tmpDir, 'proj');
    mkdirSync(pd, { recursive: true });
    // 写一个真实 zip（size>0）以通过 stat 过滤
    const z = new AdmZip();
    z.addFile('inner.jsonl', Buffer.from(entry('t1', 'u1')));
    z.writeZip(join(pd, base + '.zip'));
    writeFileSync(join(pd, 'proj.json'), JSON.stringify({
      files: { [base]: { summary: { sessionCount: 3 }, preview: ['p'] } },
    }));
    const res = await listLocalLogs(tmpDir, 'proj');
    const item = res.proj.find((x) => x.archived);
    assert.ok(item, 'archived entry present');
    assert.equal(item.turns, 3, 'stats keyed by .jsonl resolved for the .zip');
    assert.deepEqual(item.preview, ['p']);
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

describe('mergeLogFiles guards', () => {
  it('throws NOT_FOUND when one of the files is missing', async () => {
    writeLog('proj', 'a_20260101_000000.jsonl', [entry('t1', 'u1')]);
    await assert.rejects(
      () => mergeLogFiles(tmpDir, ['proj/a_20260101_000000.jsonl', 'proj/missing_20260101_000000.jsonl']),
      (e) => e.code === 'NOT_FOUND' && /missing/.test(e.message),
    );
  });

  it('merges two real files (exercises the size-accumulation loop under the 400MB limit)', async () => {
    // 体积上限分支（>400MB）需要真实超大文件，代价过高，记入 skipped；
    // 这里走正向路径覆盖 size 累加循环本身（totalSize += stat().size）。
    writeLog('proj', 'm1_20260101_000000.jsonl', [entry('t1', 'u1')]);
    writeLog('proj', 'm2_20260101_000000.jsonl', [entry('t2', 'u2')]);
    const out = await mergeLogFiles(tmpDir, ['proj/m1_20260101_000000.jsonl', 'proj/m2_20260101_000000.jsonl']);
    assert.equal(out, 'proj/m1_20260101_000000.jsonl');
    assert.equal(existsSync(join(tmpDir, 'proj/m2_20260101_000000.jsonl')), false, 'second file consumed');
  });
});

describe('archiveLogFiles branches + migrateStatsCacheKey', () => {
  it('rejects invalid names and invalid paths up front', () => {
    const res = archiveLogFiles(tmpDir, [
      null,                       // falsy → Invalid file name
      'no_extension',             // not .jsonl → Invalid file name
      '../escape.jsonl',          // .. → Invalid file name
      'toplevel.jsonl',           // single segment → Invalid file path
    ]);
    assert.equal(res.failed.find((x) => x.file === null)?.reason, 'Invalid file name');
    assert.equal(res.failed.find((x) => x.file === 'no_extension')?.reason, 'Invalid file name');
    assert.equal(res.failed.find((x) => x.file === '../escape.jsonl')?.reason, 'Invalid file name');
    assert.equal(res.failed.find((x) => x.file === 'toplevel.jsonl')?.reason, 'Invalid file path');
    assert.equal(res.archived.length, 0);
  });

  it('reports Not found for a missing file (that is not the latest)', () => {
    // 该 project 里另有一个更新的文件作为 latest，使目标文件不被 latest 规则跳过。
    writeLog('proj', 'zlatest_20260301_000000.jsonl', [entry('t', 'u')]);
    const res = archiveLogFiles(tmpDir, ['proj/aold_20260101_000000.jsonl']);
    assert.equal(res.failed[0].reason, 'Not found');
  });

  it('reports Access denied for a symlink escaping logDir', (t) => {
    const outside = mkdtempSync(join(tmpdir(), 'ccv-outside-arch-'));
    const secret = join(outside, 's.jsonl');
    writeFileSync(secret, entry('t', 'u'));
    const pd = join(tmpDir, 'proj');
    mkdirSync(pd, { recursive: true });
    writeLog('proj', 'zlatest_20260301_000000.jsonl', [entry('t', 'u')]); // latest guard 占位
    try { symlinkSync(secret, join(pd, 'alink_20260101_000000.jsonl')); }
    catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('no symlink perm'); rmSync(outside, { recursive: true, force: true }); return; } throw e; }
    const res = archiveLogFiles(tmpDir, ['proj/alink_20260101_000000.jsonl']);
    assert.equal(res.failed[0].reason, 'Access denied');
    rmSync(outside, { recursive: true, force: true });
  });

  it('reports the latest file as skipped (latest-not-allowed)', () => {
    writeLog('proj', 'only_20260101_000000.jsonl', [entry('t', 'u')]);
    const res = archiveLogFiles(tmpDir, ['proj/only_20260101_000000.jsonl']);
    assert.equal(res.skipped[0].reason, 'latest-not-allowed');
    assert.equal(res.archived.length, 0);
  });

  it('protects the timestamp-latest file even when a <pid>__ prefix sorts it earlier by name', () => {
    // 无标签旧日志(名以 'p' 开头) + pid 标签新日志(名以 '1' 开头)。
    // 旧的"文件名整串排序+reverse"会误判更旧的 'proj_…' 为 latest 而放行归档活跃日志;
    // 修复后按时间戳判定 → 真正最新的 123__ 文件被 latest-not-allowed 保护。
    writeLog('proj', 'proj_20260101_000000.jsonl', [entry('t1', 'u1')]);        // 旧
    writeLog('proj', '123__proj_20260401_000000.jsonl', [entry('t2', 'u2')]);   // 新(latest)
    const res = archiveLogFiles(tmpDir, ['proj/123__proj_20260401_000000.jsonl']);
    assert.equal(res.skipped[0]?.reason, 'latest-not-allowed');
    assert.equal(res.archived.length, 0);
  });

  it('archives an older file, migrates its stats-cache key to .jsonl.zip', () => {
    const old = 'aold_20260101_000000.jsonl';
    const newer = 'bnew_20260301_000000.jsonl';
    writeLog('proj', old, [entry('t1', 'u1')]);
    writeLog('proj', newer, [entry('t2', 'u2')]);
    // 预置 stats 缓存，键为旧 .jsonl 名 → 归档后应迁移成 old + '.zip'
    writeFileSync(join(tmpDir, 'proj', 'proj.json'), JSON.stringify({
      files: { [old]: { size: 1, lastModified: 'x', summary: { sessionCount: 9 } } },
    }, null, 2));

    const res = archiveLogFiles(tmpDir, [`proj/${old}`]);
    assert.deepEqual(res.archived, [`proj/${old}`]);
    assert.equal(existsSync(join(tmpDir, 'proj', old + '.zip')), true);
    assert.equal(existsSync(join(tmpDir, 'proj', old)), false);

    const stats = JSON.parse(readFileSync(join(tmpDir, 'proj', 'proj.json'), 'utf-8'));
    assert.ok(stats.files[old + '.zip'], 'stats key migrated to .zip');
    assert.equal(stats.files[old + '.zip'].summary.sessionCount, 9, 'preserves original stats payload');
    assert.equal(stats.files[old], undefined, 'old key removed');
    // size/lastModified 应被新 zip 的真实 stat 覆盖
    assert.notEqual(stats.files[old + '.zip'].size, 1);
  });

  it('reports skipped(target-exists) when the .jsonl.zip already exists', () => {
    const old = 'aold_20260101_000000.jsonl';
    writeLog('proj', old, [entry('t1', 'u1')]);
    writeLog('proj', 'bnew_20260301_000000.jsonl', [entry('t2', 'u2')]); // latest guard
    writeFileSync(join(tmpDir, 'proj', old + '.zip'), 'pre-existing'); // 目标已存在
    const res = archiveLogFiles(tmpDir, [`proj/${old}`]);
    assert.equal(res.skipped[0].reason, 'target-exists');
    assert.equal(existsSync(join(tmpDir, 'proj', old)), true, 'source preserved on skip');
  });

  it('maps everything to failed when realpathSync(logDir) itself throws (missing logDir)', () => {
    const res = archiveLogFiles(join(tmpDir, 'does-not-exist'), ['proj/x_20260101_000000.jsonl']);
    assert.equal(res.archived.length, 0);
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].file, 'proj/x_20260101_000000.jsonl');
    assert.ok(res.failed[0].reason, 'reason carries the realpath error message');
  });
});
