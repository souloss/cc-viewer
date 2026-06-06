/**
 * interceptor.js — resolveResumeChoice 内 try 抛错 → 外层 catch 吞掉（234-235）。
 *
 * 进入 resume 态后，把 tempFile 替换成一个目录，使 readFileSync/statSync 等操作抛错
 * （EISDIR），命中 resolveResumeChoice 的 catch 分支（console.error，不上抛）。
 * 单独成进程拿干净 _resumeState（_resumeState 一次性消费）。保护清单：只测不改。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const logDir = mkdtempSync(join(tmpdir(), 'ccv-resume-catch-'));
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
  writeFileSync(join(dir, `${projectName}_20200101_000000.jsonl`), '{"old":1}\n---\n');

  globalThis.fetch = async () => new Response('{}', { status: 200 });
  mod = await import('../server/interceptor.js');
  await mod._initPromise;
  tempFile = mod.LOG_FILE;
  assert.ok(tempFile.endsWith('_temp.jsonl'), '应进入 resume 态');
});

after(() => {
  try { rmSync(logDir, { recursive: true, force: true }); } catch { /* noop */ }
  setTimeout(() => process.exit(0), 30).unref();
});

describe("resolveResumeChoice 'continue' try 抛错 → catch 吞掉", () => {
  it('tempFile 被替换为目录 → readFileSync(tempFile) 抛 EISDIR → catch 不上抛，仍返回结果', () => {
    // 把 tempFile 占成一个目录：'continue' 分支 existsSync(tempFile)=true → readFileSync(tempFile) 抛 EISDIR。
    if (existsSync(tempFile)) { try { unlinkSync(tempFile); } catch { /* maybe already absent */ } }
    mkdirSync(tempFile, { recursive: true });
    // 不应抛出（catch 内只 console.error）
    let r;
    assert.doesNotThrow(() => { r = mod.resolveResumeChoice('continue'); });
    assert.ok(r && typeof r.logFile === 'string', 'catch 后仍正常返回 { logFile }');
  });
});
