/**
 * interceptor.js — resolveResumeChoice('new') 分支测试（覆盖 220-232, 236-239）。
 *
 * 与 interceptor-resume-continue.test.js 对称：进入 resume 态后选择 'new'，
 * 把 *_temp.jsonl rename 为正式 *.jsonl（非空时），LOG_FILE 指向新文件。
 * 单独成文件（每文件独立进程）以便用一个干净的 _resumeState。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

// ████ 数据安全死命令(2026-06-06 事故:测试五次删用户真实 ~/.claude 数据)████
// ESM 静态 import 会被 hoist,先于本文件任何语句执行 —— 因此【必须】先锁死
// CCV_LOG_DIR / CLAUDE_CONFIG_DIR 到进程私有临时目录,再让项目模块(findcc/interceptor)
// 通过 before() 里的【动态】import 读取这些 env。顺序绝不能反:env→动态 import。
// 严禁把 ../findcc.js / ../server/interceptor.js 改成顶层静态 import。
process.env.CCV_PROXY_MODE = '1';
process.env.CCV_SYNC_WRITES = '1';
delete process.env.CCV_WORKSPACE_MODE;
delete process.env.CCV_IM_PLATFORM;
const __isoDir = mkdtempSync(join(tmpdir(), 'ccv-itcresnew-'));
process.env.CCV_LOG_DIR = __isoDir;
process.env.CLAUDE_CONFIG_DIR = __isoDir;

let mod;
let recentFile;

before(async () => {
  const cwd = process.cwd();
  const projectName = basename(cwd).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const { LOG_DIR } = await import('../findcc.js');
  const dir = join(LOG_DIR, projectName);
  mkdirSync(dir, { recursive: true });
  // 用一个固定的「过去」时间戳，保证与 import 时 generateNewLogFilePath() 的当前秒不撞，
  // 避免 new 分支 rename 目标恰好等于 recentFile。findRecentLog 仅按文件名排序，
  // 目录里只有这一个非 temp 文件时它必被选中。
  const ts = '20200101_000000';
  recentFile = join(dir, `${projectName}_${ts}.jsonl`);
  writeFileSync(recentFile, '{"old":1}\n---\n');

  globalThis.fetch = async () => new Response('{}', { status: 200 });
  mod = await import('../server/interceptor.js');
  await mod._initPromise;
});

after(() => {
  setTimeout(() => process.exit(0), 30).unref();
});

describe('resolveResumeChoice — new 分支', () => {
  it('new（temp 非空）：temp rename 为正式 .jsonl，LOG_FILE 指向它', () => {
    const tempFile = mod.LOG_FILE;
    assert.ok(tempFile.endsWith('_temp.jsonl'));
    writeFileSync(tempFile, '{"fresh":1}\n---\n');

    const result = mod.resolveResumeChoice('new');
    const expectedNew = tempFile.replace('_temp.jsonl', '.jsonl');
    assert.equal(result.logFile, expectedNew);
    assert.equal(mod.LOG_FILE, expectedNew);
    // temp 不再存在；新文件存在且含内容
    assert.equal(existsSync(tempFile), false);
    assert.equal(existsSync(expectedNew), true);
    assert.ok(readFileSync(expectedNew, 'utf-8').includes('{"fresh":1}'));
    // 原 recent 不被触碰（new 不合并）
    assert.equal(readFileSync(recentFile, 'utf-8'), '{"old":1}\n---\n');
  });
});
