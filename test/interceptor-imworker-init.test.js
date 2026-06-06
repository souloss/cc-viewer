/**
 * interceptor.js — IM worker import-time 初始化分支（_initPromise 内 343-345）。
 *
 * 非 teammate、非 workspace、CCV_IM_PLATFORM 已设、且项目目录存在最近日志时：直接 continue 最近日志
 * （LOG_FILE = recentLog; return），不进入 resume 交互状态。该分支在模块顶层 _initPromise 异步执行，
 * 需在 import 前把 env / 预置日志铺好，并 await mod._initPromise 让它落定。
 *
 * 独立测试文件 = 独立进程；interceptor.js 在保护清单：只测不改。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const logDir = mkdtempSync(join(tmpdir(), 'ccv-imw-init-'));
process.env.CCV_LOG_DIR = logDir;
process.env.CCV_PROXY_MODE = '1';
process.env.CCV_SYNC_WRITES = '1';
delete process.env.CCV_WORKSPACE_MODE;
process.env.CCV_IM_PLATFORM = 'dingtalk'; // IM worker 模式

// 已知 cwd → 可预测 projectName；预置最近日志使 _initPromise 命中 IM-worker continue 分支。
const workCwd = mkdtempSync(join(tmpdir(), 'ccv-imw-proj-'));
const projectName = basename(workCwd).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
const projLogDir = join(logDir, projectName);
mkdirSync(projLogDir, { recursive: true });
const recentLog = join(projLogDir, `${projectName}_20260202_000000.jsonl`);
writeFileSync(recentLog, JSON.stringify({ type: 'prev', a: 1 }) + '\n---\n');

const savedArgv = process.argv.slice();
const savedCwd = process.cwd();

let mod;
before(async () => {
  // 注意：不能含 --agent-name（否则 _isTeammate=true 会走另一条分支，跳过 _initPromise resume 流程）
  process.argv = [process.argv[0], process.argv[1]];
  process.chdir(workCwd);
  mod = await import('../server/interceptor.js');
  await mod._initPromise; // 等异步初始化落定
});

after(() => {
  process.argv = savedArgv;
  delete process.env.CCV_IM_PLATFORM;
  try { process.chdir(savedCwd); } catch { /* noop */ }
  try { rmSync(logDir, { recursive: true, force: true }); } catch { /* noop */ }
  try { rmSync(workCwd, { recursive: true, force: true }); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 30).unref();
});

describe('IM worker import 初始化（continue 最近日志，不进 resume 交互）', () => {
  it('CCV_IM_PLATFORM + 最近日志存在 → LOG_FILE 指向最近日志，_resumeState 为 null', () => {
    assert.equal(mod.LOG_FILE, recentLog, 'IM worker 直接 continue 最近日志');
    assert.equal(mod._resumeState, null, 'IM worker 不进入 resume 交互（_resumeState 保持 null）');
  });
});
