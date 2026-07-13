/**
 * wire-v2 S3 — default-OFF gate: without CCV_WIRE_V2=1 the interceptor must
 * behave exactly as before and write NOTHING under sessions/.
 */
import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ████ 数据安全死命令：env 先于动态 import 锁死到临时目录；禁止顶层静态 import 项目模块 ████
process.env.CCV_PROXY_MODE = '1';
process.env.CCV_SYNC_WRITES = '1';
delete process.env.CCV_WIRE_V2; // the point of this file
delete process.env.CCV_WORKSPACE_MODE;
const __isoDir = mkdtempSync(join(tmpdir(), 'ccv-v2off-'));
process.env.CCV_LOG_DIR = __isoDir;
process.env.CLAUDE_CONFIG_DIR = __isoDir;

let mod;

before(async () => {
  globalThis.fetch = async () => new Response('{"content":[],"usage":{}}', { status: 200, headers: { 'content-type': 'application/json' } });
  mod = await import('../server/interceptor.js');
  mod.setupInterceptor();
});

after(() => { setTimeout(() => process.exit(0), 30).unref(); });

it('CCV_WIRE_V2 unset → v2 writer disabled, no sessions/ anywhere, v1 write intact', async () => {
  assert.equal(mod._v2Writer.enabled, false);
  await globalThis.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      system: [{ type: 'text', text: 'You are Claude Code, the official CLI.' }],
      tools: [{ name: 'Edit' }, { name: 'Bash' }, { name: 'Task' }, { name: 'Read' }, { name: 'Write' }, { name: 'Glob' }, { name: 'Grep' }, { name: 'Agent' }, { name: 'WebFetch' }, { name: 'WebSearch' }, { name: 'NotebookEdit' }, { name: 'AskUser' }],
      metadata: { user_id: JSON.stringify({ session_id: '99990000-1111-2222-3333-444455556666' }) },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
  });
  assert.ok(existsSync(mod.LOG_FILE), 'v1 log written');
  assert.ok(readFileSync(mod.LOG_FILE, 'utf-8').includes('hi'), 'v1 entry content present');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? [e.name, ...walk(join(d, e.name))] : [e.name]);
  assert.ok(!walk(__isoDir).includes('sessions'), 'no v2 sessions directory created');
});
