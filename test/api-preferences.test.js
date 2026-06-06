import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Isolate LOG_DIR before any findcc-loading import (same pattern as api-proxy-profiles.test.js).
const tmpDir = mkdtempSync(join(tmpdir(), 'ccv-api-preferences-test-'));
process.env.CCV_LOG_DIR = tmpDir;
process.env.CLAUDE_CONFIG_DIR = tmpDir;
process.env.CCV_WORKSPACE_MODE = '1';
process.env.CCV_CLI_MODE = '0';

const prefsFile = join(tmpDir, 'preferences.json');
const deps = { getPrefsFile: () => prefsFile, MAX_POST_BODY: 1024 * 1024 };

/** 同步调用 GET handler，返回解析后的回包 */
function getPrefs(handler) {
  let payload = '';
  const res = { writeHead() {}, end(b) { payload = b || ''; } };
  handler({}, res, { pathname: '/api/preferences' }, /* isLocal */ true, deps);
  return JSON.parse(payload);
}

/** 调用 POST handler（req 是流式 EventEmitter），resolve 为 { status, data } */
function postPrefs(handler, body) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    let status = 0;
    const res = {
      writeHead(code) { status = code; },
      end(b) { resolve({ status, data: JSON.parse(b || '{}') }); },
    };
    handler(req, res, { pathname: '/api/preferences' }, /* isLocal */ true, deps);
    req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    req.emit('end');
  });
}

// resumeAutoChoice 出厂默认"继承"是虚拟默认：键缺失时仅注入 API 回包，绝不落盘；
// 显式关闭持久化的是 null（键存在），必须原样返回 —— 这是区分"新用户"与"显式关闭"的唯一依据。
describe('/api/preferences resumeAutoChoice virtual default', { concurrency: false }, () => {
  let getHandler, postHandler;

  before(async () => {
    const { preferencesRoutes } = await import('../server/routes/preferences.js');
    getHandler = preferencesRoutes.find((r) => r.path === '/api/preferences' && r.method === 'GET').handler;
    postHandler = preferencesRoutes.find((r) => r.path === '/api/preferences' && r.method === 'POST').handler;
    assert.ok(getHandler && postHandler, 'preferences routes must exist');
  });

  after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  beforeEach(() => { if (existsSync(prefsFile)) unlinkSync(prefsFile); });

  it('GET injects "continue" when key is missing (new user gets factory default)', () => {
    const data = getPrefs(getHandler);
    assert.equal(data.resumeAutoChoice, 'continue');
  });

  it('GET does not create or modify the prefs file (default is virtual, never persisted)', () => {
    getPrefs(getHandler);
    assert.equal(existsSync(prefsFile), false, 'GET must not write preferences.json');
  });

  it('GET preserves explicit null (user toggled the switch off)', () => {
    writeFileSync(prefsFile, JSON.stringify({ resumeAutoChoice: null }));
    const data = getPrefs(getHandler);
    assert.ok('resumeAutoChoice' in data, 'key must be present');
    assert.equal(data.resumeAutoChoice, null);
  });

  it('GET preserves explicit "new"', () => {
    writeFileSync(prefsFile, JSON.stringify({ resumeAutoChoice: 'new' }));
    const data = getPrefs(getHandler);
    assert.equal(data.resumeAutoChoice, 'new');
  });

  it('GET falls back to default on corrupted prefs file', () => {
    writeFileSync(prefsFile, '{not valid json');
    const data = getPrefs(getHandler);
    assert.equal(data.resumeAutoChoice, 'continue');
  });

  it('POST echoes the default but never persists it to disk', async () => {
    const { status, data } = await postPrefs(postHandler, { lang: 'en' });
    assert.equal(status, 200);
    assert.equal(data.lang, 'en');
    assert.equal(data.resumeAutoChoice, 'continue', 'POST echo must match GET shape');
    const written = JSON.parse(readFileSync(prefsFile, 'utf-8'));
    assert.equal('resumeAutoChoice' in written, false, 'virtual default must not be written to disk');
  });

  it('POST persists explicit null and a later GET returns it (toggle-off round trip)', async () => {
    const { status } = await postPrefs(postHandler, { resumeAutoChoice: null });
    assert.equal(status, 200);
    const written = JSON.parse(readFileSync(prefsFile, 'utf-8'));
    assert.ok('resumeAutoChoice' in written, 'explicit null must be persisted with the key present');
    assert.equal(written.resumeAutoChoice, null);
    assert.equal(getPrefs(getHandler).resumeAutoChoice, null, 'GET must not override explicit off');
  });
});
