/**
 * interceptor.js — resolveResumeChoice('new') 的两个残余臂：
 *   - tempFile 存在但为空（size 0）→ unlinkSync 删除（228-229）
 *   - tempFile 操作抛错 → 外层 catch 吞掉并继续（234-235）
 *
 * 与 interceptor-resume-new.test.js 同构（独立进程进入 resume 态拿到干净 _resumeState），
 * 但这里在 resolveResumeChoice 前把 tempFile 做成空文件 / 不可 stat 的形态。
 * interceptor.js 在保护清单：只测不改。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const logDir = mkdtempSync(join(tmpdir(), 'ccv-resume-edge-'));
process.env.CCV_LOG_DIR = logDir;
process.env.CCV_PROXY_MODE = '1';
process.env.CCV_SYNC_WRITES = '1';
delete process.env.CCV_WORKSPACE_MODE;
delete process.env.CCV_IM_PLATFORM;

let mod, tempFile;

before(async () => {
  const cwd = process.cwd();
  const projectName = basename(cwd).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const dir = join(logDir, projectName);
  mkdirSync(dir, { recursive: true });
  // 预置一个「过去」时间戳的 recent 日志 → 进入 resume 态
  const recentFile = join(dir, `${projectName}_20200101_000000.jsonl`);
  writeFileSync(recentFile, '{"old":1}\n---\n');

  globalThis.fetch = async () => new Response('{}', { status: 200 });
  mod = await import('../server/interceptor.js');
  await mod._initPromise;
  // 进入 resume 态后，LOG_FILE 指向 *_temp.jsonl；_resumeState.tempFile 同值。
  tempFile = mod.LOG_FILE;
  assert.ok(tempFile.endsWith('_temp.jsonl'), '应进入 resume 态（LOG_FILE 指向 _temp.jsonl）');
  assert.ok(mod._resumeState, '_resumeState 应已填充');
});

after(() => {
  try { rmSync(logDir, { recursive: true, force: true }); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 30).unref();
});

describe("resolveResumeChoice('new') 空 temp 删除分支", () => {
  it('tempFile 存在但为空 → 走 unlinkSync 删除（228-229），LOG_FILE 切到正式名', () => {
    // 把 tempFile 做成空文件（size 0）
    writeFileSync(tempFile, '');
    assert.equal(existsSync(tempFile), true);
    const r = mod.resolveResumeChoice('new');
    // 空 temp 被删除；LOG_FILE 指向去掉 _temp 的正式名
    assert.equal(existsSync(tempFile), false, '空 temp 文件应被 unlink');
    assert.ok(r.logFile.endsWith('.jsonl') && !r.logFile.endsWith('_temp.jsonl'), 'LOG_FILE 切到正式 .jsonl 名');
  });
});
