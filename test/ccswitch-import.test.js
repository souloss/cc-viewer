// Pure function + integration tests for ccswitch-import.
// mapProviderToProfile / mergeImportedProfiles are pure-function unit tests;
// readCcSwitchProviders runs integration verification against the real local cc-switch.db (run if present, skip otherwise).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  mapProviderToProfile,
  mergeImportedProfiles,
  findCcSwitchDbPath,
  _candidateDbPathsForTest,
  readCcSwitchProviders,
  discoverCcSwitchProviders,
} from '../server/lib/ccswitch-import.js';

describe('mapProviderToProfile', () => {
  it('完整 claude 供应商映射所有字段', () => {
    const row = {
      id: 'abc-123',
      app_type: 'claude',
      name: '讯飞',
      is_current: 1,
      settings_config: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://maas.example.com',
          ANTHROPIC_AUTH_TOKEN: 'sk-token-xxx',
          ANTHROPIC_MODEL: 'astron-code',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-m',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-m',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-m',
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'should-be-ignored', // the _NAME variant must be ignored
        },
      }),
    };
    const p = mapProviderToProfile(row);
    assert.equal(p.id, 'ccs_abc-123');
    assert.equal(p.name, '讯飞');
    assert.equal(p.baseURL, 'https://maas.example.com');
    assert.equal(p.apiKey, 'sk-token-xxx');
    assert.equal(p.ANTHROPIC_MODEL, 'astron-code');
    assert.equal(p.ANTHROPIC_DEFAULT_OPUS_MODEL, 'opus-m');
    assert.equal(p.ANTHROPIC_DEFAULT_SONNET_MODEL, 'sonnet-m');
    assert.equal(p.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'haiku-m');
    assert.equal(p.source, 'cc-switch');
    // the _NAME variant must not leak into any field
    assert.equal(JSON.stringify(p).includes('_NAME'), false);
    assert.equal(JSON.stringify(p).includes('should-be-ignored'), false);
  });

  it('app_type 非 claude 返回 null', () => {
    const row = {
      id: 'x', app_type: 'codex', name: 'codex-prov',
      settings_config: JSON.stringify({ env: { OPENAI_API_KEY: 'sk' } }),
    };
    assert.equal(mapProviderToProfile(row), null);
  });

  it('settings_config 无 env 字段返回 null（如 Claude Official 只有配置无凭证）', () => {
    const row = {
      id: 'official', app_type: 'claude', name: 'Claude Official',
      settings_config: JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' } }),
    };
    assert.equal(mapProviderToProfile(row), null);
  });

  it('settings_config 非 JSON 返回 null', () => {
    const row = { id: 'bad', app_type: 'claude', name: 'Bad', settings_config: 'not json{' };
    assert.equal(mapProviderToProfile(row), null);
  });

  it('settings_config 为 null 返回 null', () => {
    const row = { id: 'n', app_type: 'claude', name: 'N', settings_config: null };
    assert.equal(mapProviderToProfile(row), null);
  });

  it('缺 baseURL 返回 null（只有 token 不够）', () => {
    const row = {
      id: 't', app_type: 'claude', name: 'T',
      settings_config: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk' } }),
    };
    assert.equal(mapProviderToProfile(row), null);
  });

  it('ANTHROPIC_API_KEY 也能映射到 apiKey', () => {
    const row = {
      id: 'k', app_type: 'claude', name: 'K',
      settings_config: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_API_KEY: 'sk-key' } }),
    };
    const p = mapProviderToProfile(row);
    assert.equal(p.apiKey, 'sk-key');
  });

  it('ANTHROPIC_AUTH_TOKEN 优先于 ANTHROPIC_API_KEY', () => {
    const row = {
      id: 'both', app_type: 'claude', name: 'Both',
      settings_config: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://x',
          ANTHROPIC_AUTH_TOKEN: 'token-val',
          ANTHROPIC_API_KEY: 'key-val',
        },
      }),
    };
    const p = mapProviderToProfile(row);
    assert.equal(p.apiKey, 'token-val');
  });

  it('CLAUDE_CODE_EFFORT_LEVEL 映射到 effort（不丢失）', () => {
    // cc-switch's "通用配置" effort toggle writes CLAUDE_CODE_EFFORT_LEVEL="max".
    // cc-viewer's profile model supports an effort field (the request layer injects
    // profile.effort as output_config.effort at send time). The import must map this
    // env var → effort, otherwise a user who set effort in cc-switch silently loses it.
    const row = {
      id: 'eff', app_type: 'claude', name: 'EffortProv',
      settings_config: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://x',
          ANTHROPIC_AUTH_TOKEN: 'tok',
          CLAUDE_CODE_EFFORT_LEVEL: 'max',
        },
      }),
    };
    const p = mapProviderToProfile(row);
    assert.equal(p.effort, 'max');
  });

  it('无 CLAUDE_CODE_EFFORT_LEVEL 时 effort 为空串（不误注入）', () => {
    const row = {
      id: 'noeff', app_type: 'claude', name: 'NoEffort',
      settings_config: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://x', ANTHROPIC_AUTH_TOKEN: 'tok' },
      }),
    };
    const p = mapProviderToProfile(row);
    assert.equal(p.effort, '');
  });
});

describe('mergeImportedProfiles', () => {
  it('更新已有 ccs_ + 保留用户自建 proxy_ + 追加新 ccs_', () => {
    const existing = [
      { id: 'max', name: 'Default' },
      { id: 'proxy_mine', name: '我的', baseURL: 'https://mine', apiKey: 'k1' },
      { id: 'ccs_old', name: '旧讯飞', baseURL: 'https://old', apiKey: 'old-key' },
    ];
    const imported = [
      { id: 'ccs_old', name: '新讯飞', baseURL: 'https://new', apiKey: 'new-key', source: 'cc-switch' },
      { id: 'ccs_new', name: '新供应商', baseURL: 'https://newp', apiKey: 'k2', source: 'cc-switch' },
    ];
    const r = mergeImportedProfiles(existing, imported);
    // max stays at the front
    assert.equal(r.profiles[0].id, 'max');
    // user-created profile is preserved unchanged
    const mine = r.profiles.find(p => p.id === 'proxy_mine');
    assert.deepEqual(mine, { id: 'proxy_mine', name: '我的', baseURL: 'https://mine', apiKey: 'k1' });
    // ccs_old is updated with new data
    const old = r.profiles.find(p => p.id === 'ccs_old');
    assert.equal(old.baseURL, 'https://new');
    assert.equal(old.apiKey, 'new-key');
    // ccs_new is appended
    const neu = r.profiles.find(p => p.id === 'ccs_new');
    assert.ok(neu);
    assert.equal(r.imported, 1);
    assert.equal(r.updated, 1);
  });

  it('cc-switch 侧删除的 ccs_ 从列表移除（不保留过期凭证）', () => {
    const existing = [
      { id: 'max', name: 'Default' },
      { id: 'ccs_deleted', name: '已删', baseURL: 'https://d', apiKey: 'dk' },
      { id: 'proxy_keep', name: '保留', baseURL: 'https://k', apiKey: 'kk' },
    ];
    const imported = []; // cc-switch side now has none
    const r = mergeImportedProfiles(existing, imported);
    assert.equal(r.profiles.find(p => p.id === 'ccs_deleted'), undefined);
    assert.ok(r.profiles.find(p => p.id === 'proxy_keep'));
    assert.ok(r.profiles.find(p => p.id === 'max'));
  });

  it('空 existing + 首次导入', () => {
    const imported = [
      { id: 'ccs_a', name: 'A', baseURL: 'https://a', apiKey: 'ka', source: 'cc-switch' },
    ];
    const r = mergeImportedProfiles([], imported);
    assert.equal(r.profiles.length, 1);
    assert.equal(r.imported, 1);
    assert.equal(r.updated, 0);
  });

  it('空 imported 不影响 existing', () => {
    const existing = [
      { id: 'max', name: 'Default' },
      { id: 'proxy_x', name: 'X', baseURL: 'https://x', apiKey: 'k' },
    ];
    const r = mergeImportedProfiles(existing, []);
    assert.equal(r.profiles.length, 2);
    assert.equal(r.imported, 0);
    assert.equal(r.updated, 0);
  });
});

describe('findCcSwitchDbPath', () => {
  it('本机有 db 则返回路径，无则返回 null', () => {
    const p = findCcSwitchDbPath();
    const expected = `${homedir()}/.cc-switch/cc-switch.db`;
    if (existsSync(expected)) {
      assert.equal(p, expected);
    } else {
      assert.equal(p, null);
    }
  });

  it('~/.cc-switch/cc-switch.db 优先于 legacy 平台路径（stale 文件不遮蔽真实 db）', () => {
    // cc-switch hardcodes ~/.cc-switch/cc-switch.db on ALL platforms. A stale/empty leftover
    // file at a legacy platform-specific probe path must NOT shadow the real db. Override
    // HOME to a temp dir so homedir() (which respects HOME on linux) resolves there, then lay
    // out both a legacy-path file and the real ~/.cc-switch/cc-switch.db and assert the real
    // one wins. Restores HOME in finally so other tests are unaffected.
    const realHome = process.env.HOME;
    const tmp = mkdtempSync(join(tmpdir(), 'ccv-ccswitch-prio-'));
    process.env.HOME = tmp;
    try {
      // legacy linux path cc-switch never writes to (only matters if probed first)
      const stale = join(tmp, '.local', 'share', 'cc-switch');
      mkdirSync(stale, { recursive: true });
      writeFileSync(join(stale, 'cc-switch.db'), 'stale leftover');
      // the real db cc-switch actually uses
      const realDir = join(tmp, '.cc-switch');
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, 'cc-switch.db'), 'real');
      const got = findCcSwitchDbPath();
      assert.equal(got, join(realDir, 'cc-switch.db'));
    } finally {
      process.env.HOME = realHome;
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});

// Cross-platform priority: cc-switch hardcodes ~/.cc-switch/cc-switch.db on ALL platforms.
// These unit tests inject platform/home/env so the win32 + darwin branches can be exercised
// on any host (the runtime tests above only cover the linux branch's behavior).
describe('_candidateDbPathsForTest (cross-platform priority)', () => {
  const home = '/home/me';

  it('win32: ~/.cc-switch/cc-switch.db 优先于 %APPDATA% / %LOCALAPPDATA%', () => {
    const paths = _candidateDbPathsForTest({
      plat: 'win32', home,
      env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    });
    // [0] is the primary ~/.cc-switch path on every platform
    assert.equal(paths[0], '/home/me/.cc-switch/cc-switch.db');
    // the AppData paths must come AFTER, never first (so a stale leftover can't shadow)
    assert.ok(!paths.slice(1).includes(paths[0]), 'primary must not be duplicated later');
    assert.ok(paths.length >= 3);
  });

  it('darwin: ~/.cc-switch/cc-switch.db 优先于 Library/Application Support/*', () => {
    const paths = _candidateDbPathsForTest({ plat: 'darwin', home });
    assert.equal(paths[0], '/home/me/.cc-switch/cc-switch.db');
    assert.ok(paths.slice(1).some(p => p.includes('Library/Application Support')));
    assert.ok(!paths.slice(1).includes(paths[0]));
  });

  it('linux: ~/.cc-switch/cc-switch.db 优先，且 legacy 路径在其后', () => {
    const paths = _candidateDbPathsForTest({ plat: 'linux', home, env: {} });
    assert.equal(paths[0], '/home/me/.cc-switch/cc-switch.db');
    assert.ok(paths[paths.length - 1].includes('.local/share/cc-switch'));
  });

  it('win32: USERPROFILE/APPDATA 缺省时回退到 home 下 AppData（home 为任意值都成立）', () => {
    // The primary path is <home>/.cc-switch/cc-switch.db for ANY home value — we do NOT hardcode
    // a real username (that would couple the test to one machine). home is an opaque base dir.
    // Assert on path *structure*, not exact separators: path.join uses the host separator,
    // so on a linux test host the Windows-style backslashes mix with '/'. The logic is what matters.
    const winHome = 'C:\\Users\\anybody';
    const paths = _candidateDbPathsForTest({ plat: 'win32', home: winHome, env: {} });
    assert.ok(paths[0].startsWith(winHome), `primary should be under home, got ${paths[0]}`);
    assert.ok(paths[0].includes('.cc-switch'), `primary should target .cc-switch, got ${paths[0]}`);
    // APPDATA/LOCALAPPDATA unset → fallbacks resolve under <home>\AppData\...
    assert.ok(paths[1].includes('AppData'), `fallback should be under AppData, got ${paths[1]}`);
    assert.ok(paths[2].includes('AppData'));
  });
});

// Integration test: real local cc-switch.db (run only if a *valid* one is present).
// A bare existsSync is not enough — the dev machine may carry a cc-switch.db-shaped
// file (e.g. a different schema, no providers table). The guard below opens it
// read-only with node:sqlite (when available) and confirms the providers table exists.
// Missing file / no node:sqlite / open error / no providers table → skip, not fail.
const realDb = `${homedir()}/.cc-switch/cc-switch.db`;
function hasValidCcSwitchDb() {
  if (!existsSync(realDb)) return false;
  try {
    // node:sqlite ships as ESM; load it synchronously via createRequire so the
    // describe({ skip }) guard stays synchronous. Unavailable on older Node → skip.
    const req = createRequire(import.meta.url);
    let DatabaseSync;
    try { ({ DatabaseSync } = req('node:sqlite')); }
    catch { return false; }
    if (!DatabaseSync) return false;
    const db = new DatabaseSync(realDb, { readOnly: true });
    try {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'").get();
      return !!row;
    } finally {
      try { db.close(); } catch { /* best effort */ }
    }
  } catch {
    return false;
  }
}
const hasRealDb = hasValidCcSwitchDb();
describe('readCcSwitchProviders (integration)', { skip: !hasRealDb }, () => {
  it('从真实 db 读出 claude 供应商并正确映射', async () => {
    const { profiles, error } = await readCcSwitchProviders(realDb);
    assert.equal(error, null);
    assert.ok(Array.isArray(profiles));
    // local machine has at least 1 claude provider (iFlyTek)
    if (profiles.length > 0) {
      const p = profiles[0];
      assert.ok(p.id.startsWith('ccs_'));
      assert.ok(p.baseURL);
      assert.ok(p.apiKey);
      assert.equal(p.source, 'cc-switch');
    }
  });

  it('只读模式不锁定 db（cc-switch 运行时也可读）', async () => {
    // read twice in a row to verify no SQLITE_BUSY error
    const r1 = await readCcSwitchProviders(realDb);
    const r2 = await readCcSwitchProviders(realDb);
    assert.equal(r1.error, null);
    assert.equal(r2.error, null);
  });
});

describe('discoverCcSwitchProviders (integration)', { skip: !hasRealDb }, () => {
  it('完整链路：探测 + 读取', async () => {
    const r = await discoverCcSwitchProviders();
    assert.ok(r.dbPath);
    assert.equal(r.error, null);
    assert.ok(Array.isArray(r.profiles));
  });
});

// Error-surfacing tests: verify readCcSwitchProviders reports the REAL cause when the DB is
// unreadable, rather than masking every failure behind "providers table not found".
// A non-SQLite / corrupt file opens read-only (the open does not validate content), then the
// sqlite_master query throws — that throw must surface, not be swallowed into a misleading
// "providers table not found". These run on any temp dir and need no real cc-switch install.
const hasSqlite = (() => {
  try {
    const req = createRequire(import.meta.url);
    return !!req('node:sqlite').DatabaseSync;
  } catch { return false; }
})();

describe('readCcSwitchProviders (error surfacing)', { skip: !hasSqlite }, () => {
  let tmpDir;
  before(() => { tmpDir = mkdtempSync(join(tmpdir(), 'ccv-ccswitch-err-')); });
  after(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('非 SQLite 文件不报 "providers table not found"，而是暴露真实错误', async () => {
    // A bytes-file that is clearly not a SQLite database. Opens read-only, then the
    // sqlite_master query throws "file is not a database" — that real cause must surface.
    const dbPath = join(tmpDir, 'cc-switch.db');
    writeFileSync(dbPath, 'not a sqlite database at all');
    const { profiles, error } = await readCcSwitchProviders(dbPath);
    assert.deepEqual(profiles, []);
    assert.ok(error, 'error should be set');
    // The masked bug returned exactly 'providers table not found'; the fix must surface the
    // real cause instead (the underlying SQLite "not a database" message, via 'query failed:').
    assert.notEqual(error, 'providers table not found');
    assert.ok(/database|query failed|file/i.test(error), `error should expose real cause, got: ${error}`);
  });

  it('有效 SQLite 库但无 providers 表 → 报 "providers table not found in <path>"', async () => {
    // A valid SQLite DB that simply does not have a providers table (genuine schema mismatch).
    // This must still report "providers table not found" — and now names the resolved path so
    // the user can tell which file was opened (e.g. a stale leftover vs. the real cc-switch db).
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const dbPath = join(tmpDir, 'empty.db');
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE other (id TEXT)'); // valid db, no providers table
    db.close();
    const { profiles, error } = await readCcSwitchProviders(dbPath);
    assert.deepEqual(profiles, []);
    assert.ok(error.includes('providers table not found'), `got: ${error}`);
    assert.ok(error.includes(dbPath), `error should name the resolved db path, got: ${error}`);
  });
});
