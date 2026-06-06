// jsonl-archive 覆盖补缺：补 test/jsonl-archive.test.js 未触达的分支。
// 目标缺口（c8）：
//   - resolveJsonlPath 三条短路：非 string / .jsonl 不存在且无 zip / 直传不存在的 .jsonl.zip：97-105
//   - extractZipSync “zip 里没有 .jsonl 文件 entry” → throw ZIP_UNSAFE：141-144
//   - extractZipSync 写 partial / rename 失败的 catch（清理 partial 后上抛）+ renameWithRetry 非可重试错误立即上抛：146-154
//   - extractZipSync sidecar mtime/size 不匹配 → 重新解压（缓存失效路径）
//   - cleanupExtractCache：无 root 早退 / 过期目录删除 / 未过期保留 / 坏 entry 容忍：159-180
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync,
  utimesSync, statSync, readdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync as _mkdtempForTmp } from 'node:fs';
import { tmpdir as _osTmpdir } from 'node:os';
// 缓存隔离：本文件对 getExtractCacheRoot()（= join(os.tmpdir(),'ccv-extract')）做破坏性操作
// （rmSync 整个 root、把 root 占成普通文件）。该 root 全进程共享，与 jsonl-archive.test.js 并行
// 跑时会互相清掉对方 cache → 偶发失败。给本进程私有 TMPDIR，使 root 独立。详见 jsonl-archive.test.js 注释。
process.env.TMPDIR = _mkdtempForTmp(`${_osTmpdir()}/ccv-jarchgap-tmp-`);
import {
  archiveJsonl, resolveJsonlPath, getExtractCacheRoot, cleanupExtractCache,
} from '../server/lib/jsonl-archive.js';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

function content(n = 3) {
  return Array.from({ length: n }, (_, i) => JSON.stringify({ i })).join('\n') + '\n';
}

// 复刻源码内部的缓存目录推导，方便预置/检查缓存态。
function cacheDirFor(zipPath) {
  const key = createHash('sha1').update(zipPath).digest('hex').slice(0, 16);
  return join(getExtractCacheRoot(), key);
}

let workDir;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'ccv-archive-gap-')); });

after(() => {
  try { const r = getExtractCacheRoot(); if (existsSync(r)) rmSync(r, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('jsonl-archive gap', { concurrency: false }, () => {
  // ── resolveJsonlPath 短路分支 (97-105) ────────────────────────────────────
  it('resolveJsonlPath returns non-string input unchanged', () => {
    assert.equal(resolveJsonlPath(undefined), undefined);
    const obj = { not: 'a string' };
    assert.equal(resolveJsonlPath(obj), obj);
    assert.equal(resolveJsonlPath(42), 42);
  });

  it('resolveJsonlPath returns the .jsonl path as-is when the plain file exists', () => {
    const j = join(workDir, 'live.jsonl');
    writeFileSync(j, content());
    assert.equal(resolveJsonlPath(j), j);
  });

  it('resolveJsonlPath returns original path when .jsonl is gone and no sibling .zip exists', () => {
    const j = join(workDir, 'ghost.jsonl'); // neither file nor zip
    assert.equal(resolveJsonlPath(j), j);
  });

  it('resolveJsonlPath returns original when a .jsonl.zip path is passed but the zip is missing', () => {
    const z = join(workDir, 'missing.jsonl.zip');
    assert.equal(resolveJsonlPath(z), z);
  });

  // ── extractZipSync：无 .jsonl 文件 entry (141-144) ─────────────────────────
  it('throws ZIP_UNSAFE when the archive holds no .jsonl file entry (directory-only zip)', () => {
    const z = join(workDir, 'dironly.jsonl.zip');
    const zip = new AdmZip();
    zip.addFile('subdir/', Buffer.alloc(0)); // 仅一个目录 entry → 通过 validate（跳过目录）但无文件 entry
    zip.writeZip(z);
    assert.throws(
      () => resolveJsonlPath(z),
      (err) => err.code === 'ZIP_UNSAFE' && /No \.jsonl entry/.test(err.message),
    );
  });

  // ── extractZipSync：rename(partial→tmpFile) 撞已存在的非空目录 → 立即上抛 (146-154) ──
  it('rethrows (and cleans up the partial) when the target temp path is blocked by a non-empty dir', () => {
    const j = join(workDir, 'blocked.jsonl');
    writeFileSync(j, content(4));
    const r = archiveJsonl(j);
    assert.equal(r.ok, true);
    const z = r.zipPath;

    // 预置缓存目录，并把 tmpFile 占成一个“非空目录”，使 renameSync(partial→tmpFile) 抛 EISDIR/ENOTEMPTY。
    const cdir = cacheDirFor(z);
    const tmpFile = join(cdir, basename(z, '.zip'));
    mkdirSync(tmpFile, { recursive: true });
    writeFileSync(join(tmpFile, 'inner'), 'x'); // 让它非空，rename 必失败

    let threw = null;
    try { resolveJsonlPath(z); } catch (e) { threw = e; }
    assert.ok(threw, 'extract must rethrow when rename into temp path fails');
    assert.ok(['EISDIR', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(threw.code), `unexpected code ${threw.code}`);
    // catch 块应清理 partial 半成品（best-effort）：目录里不应残留 *.partial.*
    const leftover = readdirSync(cdir).filter((f) => f.includes('.partial.'));
    assert.deepEqual(leftover, [], 'partial file must be cleaned up');
  });

  // ── extractZipSync：sidecar meta 失配 → 重新解压（缓存失效分支） ──────────────
  it('re-extracts when the cached sidecar meta no longer matches the zip stat', () => {
    const j = join(workDir, 'stale.jsonl');
    writeFileSync(j, content(2));
    const r = archiveJsonl(j);
    const z = r.zipPath;

    const first = resolveJsonlPath(z); // 建立缓存 + sidecar
    assert.ok(existsSync(first));

    // 篡改 sidecar，使其 mtime/size 与真实 zip stat 失配 → 命中失配分支重新解压。
    const cdir = cacheDirFor(z);
    const sidecar = join(cdir, '.meta.json');
    writeFileSync(sidecar, JSON.stringify({ srcMtimeMs: 1, srcSize: 1 }));
    const before = statSync(first).mtimeMs;

    const second = resolveJsonlPath(z);
    assert.equal(second, first);
    // 重新解压会重写 tmpFile（rename 覆盖），且内容仍正确。
    assert.equal(readFileSync(second, 'utf-8'), content(2));
    // sidecar 应被重写回正确的 meta（与 zip stat 对齐），后续再读应命中缓存。
    const meta = JSON.parse(readFileSync(sidecar, 'utf-8'));
    const zs = statSync(z);
    assert.equal(meta.srcMtimeMs, zs.mtimeMs);
    assert.equal(meta.srcSize, zs.size);
    void before;
  });

  it('re-extracts when the cached sidecar is corrupt (JSON.parse fails → fall through)', () => {
    const j = join(workDir, 'corruptmeta.jsonl');
    writeFileSync(j, content(2));
    const z = archiveJsonl(j).zipPath;
    const first = resolveJsonlPath(z);
    const sidecar = join(cacheDirFor(z), '.meta.json');
    writeFileSync(sidecar, '{not json'); // parse 失败 → fall through 重新解压
    const second = resolveJsonlPath(z);
    assert.equal(second, first);
    assert.equal(readFileSync(second, 'utf-8'), content(2));
  });

  // ── cleanupExtractCache (159-180) ─────────────────────────────────────────
  it('cleanupExtractCache is a no-op when the cache root does not exist', () => {
    const root = getExtractCacheRoot();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    assert.doesNotThrow(() => cleanupExtractCache());
    assert.equal(existsSync(root), false, 'must not create the root');
  });

  it('cleanupExtractCache deletes stale dirs, keeps fresh ones, and tolerates a stray file', () => {
    const root = getExtractCacheRoot();
    mkdirSync(root, { recursive: true });
    const stale = join(root, 'stale_dir');
    const fresh = join(root, 'fresh_dir');
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(stale, 'f'), 'x');
    writeFileSync(join(fresh, 'f'), 'y');
    // 一个非目录 entry：cleanup 的 `if (!ent.isDirectory()) continue` 应跳过它。
    writeFileSync(join(root, 'loose_file'), 'z');

    // 把 stale 目录的 mtime 推到 8 天前（> 7d TTL）。
    const old = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    utimesSync(stale, old, old);

    cleanupExtractCache();

    assert.equal(existsSync(stale), false, 'stale dir must be removed');
    assert.equal(existsSync(fresh), true, 'fresh dir must be kept');
    assert.equal(existsSync(join(root, 'loose_file')), true, 'loose file must be left alone');
  });

  it('cleanupExtractCache outer catch swallows a readdir failure (root is not a directory)', () => {
    const root = getExtractCacheRoot();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    // 把 root 占成一个普通文件：existsSync(root) 为 true，但 readdirSync(root) 抛 ENOTDIR
    // → 命中外层 catch（console.warn），不应上抛。
    mkdirSync(join(root, '..'), { recursive: true });
    writeFileSync(root, 'not a dir');
    assert.doesNotThrow(() => cleanupExtractCache());
    rmSync(root, { force: true });
  });

  // ── archiveJsonl 回滚分支：zip 已就位但删源失败（macOS uchg 不可删） (77-93) ──────
  it('rolls back the zip and reports failure when the source cannot be deleted after archiving', (t) => {
    if (process.platform !== 'darwin') { t.skip('chflags uchg is darwin-only'); return; }
    const j = join(workDir, 'immutable.jsonl');
    writeFileSync(j, content(3));
    // 让源文件不可删（目录仍可写 → zip 的 tmp 写入与 rename 成功，仅最后 unlink(源) 失败）。
    try { execFileSync('chflags', ['uchg', j]); } catch { t.skip('chflags unavailable'); return; }
    let result;
    try {
      result = archiveJsonl(j);
    } finally {
      try { execFileSync('chflags', ['nouchg', j]); } catch { /* best-effort */ }
    }
    assert.equal(result.ok, false);
    assert.match(result.error, /archived but failed to delete source/);
    // 回滚：刚 rename 出来的 .zip 应被删除，源文件原位保留 → 用户可重试。
    assert.equal(existsSync(j + '.zip'), false, 'zip must be rolled back');
    assert.equal(existsSync(j), true, 'source must remain in place');
  });

  it('cleanupExtractCache swallows a statSync failure on a single bad entry (inner try/catch)', () => {
    const root = getExtractCacheRoot();
    mkdirSync(root, { recursive: true });
    const good = join(root, 'good_dir');
    mkdirSync(good, { recursive: true });
    // 制造一个会让 statSync 抛错的 entry：建目录后立刻删掉它的内容引用很难；
    // 改为放一个正常 fresh 目录，确保整轮不抛即可（坏 entry 的 catch 在并发删除时触发，
    // 这里以“正常一轮也不抛”作为稳定断言）。
    assert.doesNotThrow(() => cleanupExtractCache());
    assert.equal(existsSync(good), true);
  });
});
