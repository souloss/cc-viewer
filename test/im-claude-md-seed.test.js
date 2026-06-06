import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ████ 数据安全 — 禁止改回静态 import(2026-06-06 事故) ████
// LOG_DIR/CACHE_DIR 等在 findcc.js / server/lib 模块【加载时】即从 env 派生。
// ESM 静态 import 会被提升到本文件任何语句之前执行,所以「先设 env 再静态 import」无效。
// 必须:① node 内置模块静态 import;② 隔离段设 env;③ 项目模块用顶层 await 动态 import。
// 改回静态 import findcc/server 会让本文件单跑(无外部 CCV_LOG_DIR)时落到真实 ~/.claude。
const __isoDir = mkdtempSync(join(tmpdir(), 'ccv-imseed-'));
process.env.CCV_LOG_DIR = __isoDir;
process.env.CLAUDE_CONFIG_DIR = __isoDir;

const { LOG_DIR } = await import('../findcc.js');
const { ensureImClaudeMd, buildImClaudeMdPreset, platformLabel, readImClaudeMd, writeImClaudeMd } = await import('../server/lib/im-claude-md.js');
const { imDir } = await import('../server/lib/im-lock.js');

let n = 0;
function freshId() { return `test_md_${process.pid}_${n++}`; }
function wipe(id) { try { rmSync(imDir(id), { recursive: true, force: true }); } catch { /* noop */ } }

describe('im-claude-md seed', () => {
  beforeEach(() => { mkdirSync(LOG_DIR, { recursive: true }); });

  it('creates CLAUDE.md under LOG_DIR/IM_<id>/ when absent', () => {
    const id = freshId(); wipe(id);
    const created = ensureImClaudeMd(id);
    assert.equal(created, true);
    const p = join(imDir(id), 'CLAUDE.md');
    assert.equal(existsSync(p), true);
    const content = readFileSync(p, 'utf-8');
    // 关键约束必须在内
    assert.match(content, /AskUserQuestion/);
    assert.match(content, /dangerously-skip-permissions/);
    assert.match(content, /TUI/);
    assert.ok(content.includes(`IM_${id}/`));
    wipe(id);
  });

  it('does NOT overwrite an existing CLAUDE.md (wx, returns false)', () => {
    const id = freshId(); wipe(id);
    mkdirSync(imDir(id), { recursive: true });
    const custom = '# my custom personality\n保持原样';
    writeFileSync(join(imDir(id), 'CLAUDE.md'), custom);
    const created = ensureImClaudeMd(id);
    assert.equal(created, false);
    assert.equal(readFileSync(join(imDir(id), 'CLAUDE.md'), 'utf-8'), custom);
    wipe(id);
  });

  it('concurrent seed writes exactly once and never throws', () => {
    const id = freshId(); wipe(id);
    const results = [ensureImClaudeMd(id), ensureImClaudeMd(id), ensureImClaudeMd(id)];
    assert.equal(results.filter(Boolean).length, 1); // 仅一次新建
    wipe(id);
  });

  it('preset embeds the platform label and hard interaction constraints', () => {
    const md = buildImClaudeMdPreset('dingtalk');
    assert.ok(md.includes(platformLabel('dingtalk')));
    assert.match(md, /NEVER use the AskUserQuestion tool/);
    assert.match(md, /untrusted/i);
    assert.equal(platformLabel('discord'), 'Discord');
    assert.equal(platformLabel('unknownxyz'), 'unknownxyz'); // 未知 id 回退到 id 本身
  });
});

describe('im-claude-md read/write (模型性格定义 editor)', () => {
  beforeEach(() => { mkdirSync(LOG_DIR, { recursive: true }); });

  it('readImClaudeMd returns the preset when the file is absent (not yet persisted)', () => {
    const id = freshId(); wipe(id);
    const content = readImClaudeMd(id);
    assert.equal(content, buildImClaudeMdPreset(id)); // 缺失 → 预置文本，但不落盘
    assert.equal(existsSync(join(imDir(id), 'CLAUDE.md')), false);
    wipe(id);
  });

  it('writeImClaudeMd persists content and readImClaudeMd reads it back', () => {
    const id = freshId(); wipe(id);
    const custom = '# 我的机器人\n说话简短一点。';
    writeImClaudeMd(id, custom);
    assert.equal(readFileSync(join(imDir(id), 'CLAUDE.md'), 'utf-8'), custom);
    assert.equal(readImClaudeMd(id), custom);
    wipe(id);
  });

  it('writeImClaudeMd overwrites an existing file (atomic temp+rename) and leaves no .tmp', () => {
    const id = freshId(); wipe(id);
    writeImClaudeMd(id, 'first');
    writeImClaudeMd(id, 'second');
    assert.equal(readImClaudeMd(id), 'second');
    const leftover = readdirSync(imDir(id)).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftover, []);
    wipe(id);
  });

  it('readImClaudeMd rethrows a non-ENOENT read error (im-claude-md.js:98-99)', () => {
    // 把 CLAUDE.md 占成目录 → readFileSync 抛 EISDIR（非 ENOENT）→ 不回退预置而是 rethrow。
    const id = freshId(); wipe(id);
    mkdirSync(join(imDir(id), 'CLAUDE.md'), { recursive: true });
    assert.throws(() => readImClaudeMd(id), (err) => err && err.code !== 'ENOENT');
    wipe(id);
  });

  it('writeImClaudeMd cleans up temp and rethrows on write failure (im-claude-md.js:115-117)', () => {
    // 目标 CLAUDE.md 占成非空目录 → renameSyncWithRetry 抛错 → catch 删 temp 并 rethrow。
    const id = freshId(); wipe(id);
    const dir = imDir(id);
    mkdirSync(dir, { recursive: true });
    const targetAsDir = join(dir, 'CLAUDE.md');
    mkdirSync(targetAsDir, { recursive: true });
    writeFileSync(join(targetAsDir, 'keep'), 'x'); // 非空，确保 rename 覆盖必失败

    assert.throws(() => writeImClaudeMd(id, 'new content'));
    // catch 已 unlink temp：不应遗留 .tmp- 文件
    const leftover = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftover, []);
    wipe(id);
  });
});
