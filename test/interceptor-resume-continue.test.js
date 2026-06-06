/**
 * interceptor.js — resolveResumeChoice('continue') 分支测试（覆盖 206-219, 236-239）。
 *
 * 模块初始化时若 _logDir 下存在 1 小时内的最近日志，_initPromise 会进入 resume 交互态：
 * LOG_FILE 切到 *_temp.jsonl，_resumeState 记录 { recentFile, tempFile }。
 * 调 resolveResumeChoice('continue') → 把 temp 内容追加回 recent，删 temp，LOG_FILE=recent。
 *
 * 关键：必须在 import('../server/interceptor.js') 之前，在 cwd 派生的项目日志目录里预置一个
 * 最近日志文件，触发 resume 流程。单独成文件（node:test 每文件独立进程），避免 _resumeState
 * 一次性消费与其他用例耦合。
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
const __isoDir = mkdtempSync(join(tmpdir(), 'ccv-itcresume-'));
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
  // 固定「过去」时间戳；findRecentLog 仅按文件名排序，目录里只有这一个非 temp 文件时必被选中。
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

describe('resolveResumeChoice — continue 分支', () => {
  it('进入 resume 态：LOG_FILE 指向 *_temp.jsonl，_resumeState 已设', () => {
    assert.ok(mod._resumeState, '_resumeState 应被设置');
    assert.ok(mod.LOG_FILE.endsWith('_temp.jsonl'), 'LOG_FILE 应是 temp 文件');
    assert.equal(mod._resumeState.recentFile, recentFile);
  });

  it('continue：temp 内容追加回 recent，temp 删除，LOG_FILE=recent', () => {
    const tempFile = mod.LOG_FILE;
    writeFileSync(tempFile, '{"new":2}\n---\n');

    const result = mod.resolveResumeChoice('continue');
    assert.equal(result.logFile, recentFile);
    assert.equal(mod.LOG_FILE, recentFile);
    // temp 已删
    assert.equal(existsSync(tempFile), false);
    // recent 现含旧 + 新内容
    const merged = readFileSync(recentFile, 'utf-8');
    assert.ok(merged.includes('{"old":1}'));
    assert.ok(merged.includes('{"new":2}'));
  });

  it('再次调用：_resumeState 已消费为 null → 早退 undefined', () => {
    assert.equal(mod.resolveResumeChoice('continue'), undefined);
  });
});
