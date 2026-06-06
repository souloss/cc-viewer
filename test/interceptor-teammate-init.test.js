/**
 * interceptor.js — teammate 子进程 import-time 初始化分支（311-318）。
 *
 * _isTeammate 由 process.argv 含 --agent-name / --parent-session-id 在模块求值期决定，
 * 必须在独立进程里于 import 前注入 argv。此分支只跑 projectName/logDir 派生 + 找 leader 日志，
 * 不生成新文件路径。预置一份 leader 日志使 findRecentLog 命中（覆盖 317-318 的 _leaderLog 赋值）。
 *
 * 独立测试文件 = 独立进程；interceptor.js 在保护清单：只测不改。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

// 独立 LOG_DIR，避免与其它 interceptor 测试共享。
const logDir = mkdtempSync(join(tmpdir(), 'ccv-tm-init-'));
process.env.CCV_LOG_DIR = logDir;
process.env.CCV_PROXY_MODE = '1';      // 跳过自执行 setupInterceptor（teammate 仍会在自执行段被强制 setup，
                                        // 但 CCV_PROXY_MODE+_isTeammate 的组合下顶层条件 `(!CCV_PROXY_MODE || _isTeammate)`
                                        // 为 true → 会 setup；我们只关心 import-time 的 311-318，不驱动 fetch）
process.env.CCV_SYNC_WRITES = '1';
delete process.env.CCV_WORKSPACE_MODE;
delete process.env.CCV_IM_PLATFORM;

// 在一个已知 cwd 下运行，使 _projectName=basename(cwd) 可预测，并预置 leader 日志。
const workCwd = mkdtempSync(join(tmpdir(), 'ccv-tm-proj-'));
const projectName = basename(workCwd).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
const projLogDir = join(logDir, projectName);
mkdirSync(projLogDir, { recursive: true });
// 预置一份「leader」日志，命名匹配 findRecentLog 的 `${projectName}_*.jsonl`
const leaderLog = join(projLogDir, `${projectName}_20260101_000000.jsonl`);
writeFileSync(leaderLog, JSON.stringify({ type: 'leader', a: 1 }) + '\n---\n');

const savedArgv = process.argv.slice();
const savedCwd = process.cwd();

let mod;
before(async () => {
  // 注入 teammate argv + 切到已知 cwd（在 import 之前）。
  process.argv = [process.argv[0], process.argv[1], '--agent-name', 'worker-1', '--team-name', 'fix-stuff'];
  process.chdir(workCwd);
  mod = await import('../server/interceptor.js');
});

after(() => {
  process.argv = savedArgv;
  try { process.chdir(savedCwd); } catch { /* noop */ }
  try { rmSync(logDir, { recursive: true, force: true }); } catch { /* noop */ }
  try { rmSync(workCwd, { recursive: true, force: true }); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 30).unref(); // 顶层 watchFile 阻止退出
});

describe('teammate 子进程 import 初始化', () => {
  it('_isTeammate 路径：projectName/logDir 由 cwd 派生，LOG_FILE 指向已存在的 leader 日志', () => {
    assert.equal(mod._projectName, projectName, '_projectName 应为 basename(cwd) 规范化结果');
    assert.equal(mod._logDir, projLogDir, '_logDir 应为 LOG_DIR/projectName');
    // findRecentLog 命中预置 leader 日志 → _newLogFile=leaderLog → LOG_FILE 指向它
    assert.equal(mod.LOG_FILE, leaderLog, 'teammate 复用 leader 日志，不另建新文件');
  });
});
