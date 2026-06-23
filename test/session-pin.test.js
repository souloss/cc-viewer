import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Isolate LOG_DIR + workspace mode (skip interceptor log-file init) BEFORE any import that
// loads findcc/interceptor. initForWorkspace() then sets _logDir to our temp project dir.
const tmpDir = mkdtempSync(join(tmpdir(), 'ccv-session-pin-test-'));
process.env.CCV_LOG_DIR = tmpDir;
process.env.CLAUDE_CONFIG_DIR = tmpDir;
process.env.CCV_WORKSPACE_MODE = '1';
process.env.CCV_CLI_MODE = '0';

const { pinFilePath, readPin, writePin, sanitizeInstanceId } = await import('../server/lib/session-pin-store.js');
const { sessionPinRoutes } = await import('../server/routes/session-pin.js');
const { initForWorkspace } = await import('../server/interceptor.js');

after(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

// ─── session-pin-store (pure, parameterized by logDir) ──────────────────────
describe('session-pin-store', () => {
  it('sanitizeInstanceId strips unsafe chars and empties falsy input', () => {
    assert.equal(sanitizeInstanceId('alpha'), 'alpha');
    assert.equal(sanitizeInstanceId('a.b-c_1'), 'a.b-c_1');
    assert.equal(sanitizeInstanceId('../../etc/passwd'), '.._.._etc_passwd');
    assert.equal(sanitizeInstanceId('a/b\\c'), 'a_b_c');
    assert.equal(sanitizeInstanceId(''), '');
    assert.equal(sanitizeInstanceId(null), '');
    assert.equal(sanitizeInstanceId(undefined), '');
  });

  it('pinFilePath uses the shared name without an id, suffixed name with one', () => {
    const d = mkdtempSync(join(tmpdir(), 'ccv-pinpath-'));
    assert.equal(pinFilePath(d, null), join(d, '.session-pin.json'));
    assert.equal(pinFilePath(d, ''), join(d, '.session-pin.json'));
    assert.equal(pinFilePath(d, 'alpha'), join(d, '.session-pin.alpha.json'));
    // unsafe id is sanitized into the filename (no traversal)
    assert.equal(pinFilePath(d, '../x'), join(d, '.session-pin..._x.json'));
    rmSync(d, { recursive: true, force: true });
  });

  it('write → read round-trip; null clears; missing → null', () => {
    const d = mkdtempSync(join(tmpdir(), 'ccv-pin-rt-'));
    assert.equal(readPin(d, null), null);            // nothing written yet
    assert.equal(writePin(d, null, '1717000000000'), true);
    assert.equal(readPin(d, null), '1717000000000');
    // clear
    assert.equal(writePin(d, null, null), true);
    assert.equal(readPin(d, null), null);
    assert.ok(!existsSync(pinFilePath(d, null)), 'file removed on clear');
    rmSync(d, { recursive: true, force: true });
  });

  it('different instance ids resolve to different files (isolation)', () => {
    const d = mkdtempSync(join(tmpdir(), 'ccv-pin-iso-'));
    writePin(d, 'alpha', 'A');
    writePin(d, 'beta', 'B');
    writePin(d, null, 'shared');
    assert.equal(readPin(d, 'alpha'), 'A');
    assert.equal(readPin(d, 'beta'), 'B');
    assert.equal(readPin(d, null), 'shared');
    assert.ok(existsSync(join(d, '.session-pin.alpha.json')));
    assert.ok(existsSync(join(d, '.session-pin.beta.json')));
    assert.ok(existsSync(join(d, '.session-pin.json')));
    rmSync(d, { recursive: true, force: true });
  });

  it('no active project (logDir="") → read null / write no-op', () => {
    assert.equal(readPin('', null), null);
    assert.equal(writePin('', null, 'x'), false);
  });

  it('atomic write leaves valid JSON and no stray .tmp files', () => {
    const d = mkdtempSync(join(tmpdir(), 'ccv-pin-atomic-'));
    writePin(d, null, 'v1');
    writePin(d, null, 'v2');
    const obj = JSON.parse(readFileSync(pinFilePath(d, null), 'utf-8'));
    assert.equal(obj.pinnedSessionId, 'v2');
    assert.ok(!readdirSync(d).some((f) => f.includes('.tmp-')), 'no leftover tmp files');
    rmSync(d, { recursive: true, force: true });
  });

  it('corrupt / wrong-shape file reads back as null (no throw)', () => {
    const d = mkdtempSync(join(tmpdir(), 'ccv-pin-corrupt-'));
    writeFileSync(pinFilePath(d, null), '{not json');
    assert.equal(readPin(d, null), null);
    writeFileSync(pinFilePath(d, null), JSON.stringify({ pinnedSessionId: 123 }));
    assert.equal(readPin(d, null), null); // non-string → null
    rmSync(d, { recursive: true, force: true });
  });
});

// ─── GET/POST /api/session-pin route (real interceptor _logDir via workspace) ─
describe('session-pin route', () => {
  const projectDir = join(tmpDir, 'projA');
  initForWorkspace(projectDir, { forceNew: true }); // sets interceptor _logDir/_projectName
  const logDir = join(tmpDir, 'projA'); // findcc LOG_DIR(=tmpDir)/<projectName=projA>

  const getHandler = sessionPinRoutes.find((r) => r.method === 'GET').handler;
  const postHandler = sessionPinRoutes.find((r) => r.method === 'POST').handler;

  function callGet(deps) {
    let payload = '';
    const res = { writeHead() {}, end(b) { payload = b || ''; } };
    getHandler({}, res, { pathname: '/api/session-pin' }, false, deps);
    return JSON.parse(payload || '{}');
  }
  function callPost(deps, body) {
    return new Promise((resolve) => {
      const req = new EventEmitter();
      let status = 0;
      const res = { writeHead(c) { status = c; }, end(b) { resolve({ status, data: JSON.parse(b || '{}') }); } };
      postHandler(req, res, { pathname: '/api/session-pin' }, false, deps);
      req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
      req.emit('end');
    });
  }

  it('GET returns null pin + the instanceId from deps', () => {
    const out = callGet({ instanceId: 'alpha', clients: [], MAX_POST_BODY: 1 << 20 });
    assert.deepEqual(out, { pinnedSessionId: null, instanceId: 'alpha' });
  });

  it('POST persists, broadcasts session_pin, GET reads it back', async () => {
    const sent = [];
    const clients = [{ write(p) { sent.push(p); return true; } }];
    const deps = { instanceId: 'alpha', clients, MAX_POST_BODY: 1 << 20 };
    const { status, data } = await callPost(deps, { pinnedSessionId: '1717000000001' });
    assert.equal(status, 200);
    assert.equal(data.pinnedSessionId, '1717000000001');
    // broadcast happened with the session_pin event + payload
    assert.equal(sent.length, 1);
    assert.match(sent[0], /event: session_pin/);
    assert.match(sent[0], /1717000000001/);
    // persisted under the instance-scoped file and read back
    assert.equal(readPin(logDir, 'alpha'), '1717000000001');
    assert.deepEqual(callGet(deps), { pinnedSessionId: '1717000000001', instanceId: 'alpha' });
  });

  it('POST null clears the pin', async () => {
    const deps = { instanceId: 'alpha', clients: [], MAX_POST_BODY: 1 << 20 };
    const { status } = await callPost(deps, { pinnedSessionId: null });
    assert.equal(status, 200);
    assert.equal(readPin(logDir, 'alpha'), null);
  });

  it('default key (no instanceId) is isolated from the alpha key', async () => {
    const deps = { instanceId: null, clients: [], MAX_POST_BODY: 1 << 20 };
    await callPost(deps, { pinnedSessionId: 'shared-1' });
    assert.equal(readPin(logDir, null), 'shared-1');
    assert.equal(readPin(logDir, 'alpha'), null); // untouched by the default-key write
  });

  it('POST with malformed JSON → 400', async () => {
    const deps = { instanceId: null, clients: [], MAX_POST_BODY: 1 << 20 };
    const { status } = await callPost(deps, '{bad');
    assert.equal(status, 400);
  });
});

// ─── i18n guard: new cli.* keys must carry all 18 locales ────────────────────
describe('cli --pid i18n keys cover all 18 locales', () => {
  const LOCALES = ['zh', 'en', 'zh-TW', 'ko', 'ja', 'de', 'es', 'fr', 'it', 'da', 'pl', 'ru', 'ar', 'no', 'pt-BR', 'th', 'tr', 'uk'];
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'i18n.js'), 'utf-8');
  function blockOf(key) {
    const start = SRC.indexOf(`"${key}": {`);
    assert.ok(start >= 0, `key ${key} not found in server/i18n.js`);
    const end = SRC.indexOf('\n  }', start);
    assert.ok(end > start, `unterminated block for ${key}`);
    return SRC.slice(start, end);
  }
  for (const key of ['cli.pidInvalid', 'cli.instanceId', 'cli.instanceHistory']) {
    it(`${key} has every locale`, () => {
      const block = blockOf(key);
      for (const loc of LOCALES) assert.match(block, new RegExp(`"${loc}":`), `${key} missing ${loc}`);
    });
  }
});
