/**
 * interceptor.js — proxy profile / workspace / resume / delta-storage 路径测试。
 *
 * 覆盖目标（setupInterceptor + 模块级状态机）：
 *   - _loadProxyProfile / getActiveProfileId / setActiveProfileForWorkspace（workspace + profile.json 双写）
 *   - proxy 请求改写：URL origin 替换（含 /v1 路径去重）、x-api-key / authorization 注入、
 *     以及 model 改写路径的**当前工作区行为**（见下方 BUG pin）
 *   - initForWorkspace（复用最近日志 / 新建）、resetWorkspace
 *   - resolveResumeChoice（continue / new 两分支）
 *   - delta storage：首条 mainAgent → checkpoint；append → delta 切片；in-place 末位替换 → 强制 checkpoint
 *
 * 同 interceptor-fetch.test.js：CCV_PROXY_MODE=1 跳过自执行；手动 setupInterceptor()；
 * CCV_SYNC_WRITES=1 同步写盘便于断言。profile.json 写到 mod.PROFILE_PATH（与模块内常量一致）。
 *
 * === BUG pin（当前工作区行为，不改源码，仅锁定）===
 * interceptor.js L789 `body?.model` 中的 `body` 在 L554 是 `if/try` 块级作用域变量，
 * 到 L789（proxy 改写段）已离开作用域 → ReferenceError，被 L812 `catch {}` 吞掉。
 * 后果：当 _activeProfile.activeModel 被设置时，整个 proxy 改写 try 块在 model 段抛出，
 * 导致 (a) 上游 body 的 model **不会**被替换；(b) requestEntry.proxyProfile / proxyUrl
 * **不会**被写入（赋值在 catch 之后未执行）。本文件按此现状断言。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

// ████ 数据安全死命令(2026-06-06 事故:测试五次删用户真实 ~/.claude 数据)████
// ESM 静态 import 会被 hoist,先于本文件任何语句执行 —— 因此【必须】先锁死
// CCV_LOG_DIR / CLAUDE_CONFIG_DIR 到进程私有临时目录,再让项目模块(interceptor)
// 通过 before() 里的【动态】import 读取这些 env。顺序绝不能反:env→动态 import。
// 严禁把 ../server/interceptor.js 改成顶层静态 import。
process.env.CCV_PROXY_MODE = '1';
process.env.CCV_SYNC_WRITES = '1';
delete process.env.CCV_WORKSPACE_MODE;
const __isoDir = mkdtempSync(join(tmpdir(), 'ccv-itcprof-'));
process.env.CCV_LOG_DIR = __isoDir;
process.env.CLAUDE_CONFIG_DIR = __isoDir;

let mod;
let nextResponse;
let lastFetchArgs;

function readEntriesOf(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n---\n').filter(p => p.trim()).map(p => JSON.parse(p));
}
function lastCompletedOf(file) {
  const e = readEntriesOf(file);
  for (let i = e.length - 1; i >= 0; i--) if (!e[i].inProgress) return e[i];
  return null;
}

function writeProfile(json) {
  mkdirSync(dirname(mod.PROFILE_PATH), { recursive: true });
  writeFileSync(mod.PROFILE_PATH, JSON.stringify(json));
}

// workspace active-profile.json 优先级最高（_readWorkspaceActiveId）。setActiveProfileForWorkspace
// 用例会写它；清掉后才能让 profile.json.active 单独决定 _activeProfile。
function clearWorkspaceActive() {
  if (!mod._logDir) return;
  try { rmSync(join(mod._logDir, 'active-profile.json'), { force: true }); } catch {}
}

function makeMainAgentTools() {
  return [
    { name: 'Edit' }, { name: 'Bash' }, { name: 'Task' }, { name: 'Read' },
    { name: 'Write' }, { name: 'Glob' }, { name: 'Grep' }, { name: 'Agent' },
    { name: 'WebFetch' }, { name: 'WebSearch' }, { name: 'NotebookEdit' }, { name: 'AskUser' },
  ];
}
function mainBody(messages, extra = {}) {
  return {
    system: [{ type: 'text', text: 'You are Claude Code, official CLI.' }],
    tools: makeMainAgentTools(),
    messages,
    model: 'claude-x',
    ...extra,
  };
}
async function postJson(url, body, headers = { 'x-api-key': 'kk' }) {
  nextResponse = () => new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  return globalThis.fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

before(async () => {
  globalThis.fetch = async (url, opts) => {
    lastFetchArgs = [url, opts];
    return nextResponse ? nextResponse(url, opts) : new Response('{}', { status: 200 });
  };
  mod = await import('../server/interceptor.js');
  mod.setupInterceptor();
});

after(() => {
  // 清理我们写入的 profile.json，避免污染同 LOG_DIR 其他用例（虽然 LOG_DIR 是 per-pid 临时目录）
  try { rmSync(mod.PROFILE_PATH, { force: true }); } catch {}
  mod.setLivePort(null);
  setTimeout(() => process.exit(0), 30).unref();
});

describe('proxy profile 加载与查询', () => {
  it('_loadProxyProfile：active 指向非 max profile → _activeProfile 被设', () => {
    writeProfile({ active: 'p1', profiles: [
      { id: 'max', name: 'Default' },
      { id: 'p1', name: 'ProxyOne', baseURL: 'https://proxy.example.com/v1', apiKey: 'sk-proxy' },
    ] });
    mod._loadProxyProfile();
    assert.equal(mod._activeProfile.name, 'ProxyOne');
    assert.equal(mod.getActiveProfileId(), 'p1');
  });

  it('_loadProxyProfile：active === max → _activeProfile 为 null（Default 不算 profile）', () => {
    writeProfile({ active: 'max', profiles: [{ id: 'max', name: 'Default' }, { id: 'p1', name: 'P1', baseURL: 'x' }] });
    mod._loadProxyProfile();
    assert.equal(mod._activeProfile, null);
    assert.equal(mod.getActiveProfileId(), 'max');
  });

  it('_loadProxyProfile：文件损坏 / 不存在 → _activeProfile 安全降级为 null', () => {
    writeFileSync(mod.PROFILE_PATH, '{ not valid json');
    mod._loadProxyProfile();
    assert.equal(mod._activeProfile, null);
    // getActiveProfileId 读不到合法 json → 回落 'max'
    assert.equal(mod.getActiveProfileId(), 'max');
  });
});

describe('setActiveProfileForWorkspace 双写', () => {
  it('普通模式下 _logDir 已初始化 → workspace 文件 + profile.json 都写成功', () => {
    writeProfile({ active: 'max', profiles: [{ id: 'max', name: 'Default' }, { id: 'p2', name: 'P2', baseURL: 'https://b.example.com' }] });
    const result = mod.setActiveProfileForWorkspace('p2');
    assert.equal(result.workspace, true, 'workspace override 落盘');
    assert.equal(result.profile, true, 'profile.json.active 落盘');
    // 切换后 _activeProfile 立即刷新为 P2
    assert.equal(mod._activeProfile.name, 'P2');
    assert.equal(mod.getActiveProfileId(), 'p2');
  });

  it('非法 activeId（非字符串）规范化为 max', () => {
    const result = mod.setActiveProfileForWorkspace(null);
    assert.equal(result.workspace, true);
    assert.equal(mod.getActiveProfileId(), 'max');
    assert.equal(mod._activeProfile, null);
  });
});

describe('proxy 请求改写（通过真实 fetch hook）', () => {
  before(() => clearWorkspaceActive());

  it('URL origin 替换 + /v1 路径去重；x-api-key / authorization 同时注入', async () => {
    writeProfile({ active: 'p1', profiles: [
      { id: 'p1', name: 'ProxyOne', baseURL: 'https://gw.example.com/v1', apiKey: 'sk-injected' },
    ] });
    mod._loadProxyProfile();
    await postJson('https://api.anthropic.com/v1/messages?beta=1',
      { model: 'mm', messages: [] },
      { 'x-api-key': 'orig-key', authorization: 'Bearer orig' });
    // 上游收到改写后的 URL（/v1 去重，保留 query）
    assert.equal(lastFetchArgs[0], 'https://gw.example.com/v1/messages?beta=1');
    // 两种鉴权都被替换
    assert.equal(lastFetchArgs[1].headers['x-api-key'], 'sk-injected');
    assert.equal(lastFetchArgs[1].headers['authorization'], 'Bearer sk-injected');
    // 日志记录 proxyProfile / proxyUrl（无 activeModel，model 段不触发 BUG）
    const entry = lastCompletedOf(mod.LOG_FILE);
    assert.equal(entry.proxyProfile, 'ProxyOne');
    assert.equal(entry.proxyUrl, 'https://gw.example.com/v1/messages?beta=1');
  });

  it('baseURL 无路径前缀 → 直接拼接原始 pathname', async () => {
    writeProfile({ active: 'p1', profiles: [
      { id: 'p1', name: 'Bare', baseURL: 'https://bare.example.com', apiKey: 'sk-bare' },
    ] });
    mod._loadProxyProfile();
    await postJson('https://api.anthropic.com/v1/messages', { model: 'mm', messages: [] });
    assert.equal(lastFetchArgs[0], 'https://bare.example.com/v1/messages');
  });

  it('无 authorization / x-api-key 时强制植入 x-api-key', async () => {
    writeProfile({ active: 'p1', profiles: [
      { id: 'p1', name: 'Force', baseURL: 'https://f.example.com', apiKey: 'sk-force' },
    ] });
    mod._loadProxyProfile();
    // headers 里只有一个无关 header
    nextResponse = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    await globalThis.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mm', messages: [] }),
    });
    assert.equal(lastFetchArgs[1].headers['x-api-key'], 'sk-force');
  });

  it('BUG pin：activeModel 设置时 model 段抛 ReferenceError(body) → model 不替换 + proxyProfile 未记录', async () => {
    writeProfile({ active: 'p1', profiles: [
      { id: 'p1', name: 'WithModel', baseURL: 'https://m.example.com', apiKey: 'sk-m', activeModel: 'TARGET-MODEL' },
    ] });
    mod._loadProxyProfile();
    await postJson('https://api.anthropic.com/v1/messages', { model: 'claude-x', messages: [] });
    // URL 仍被改写（URL 段在 model 段之前执行，未受影响）
    assert.equal(lastFetchArgs[0], 'https://m.example.com/v1/messages');
    // 但 model 未被替换为 TARGET-MODEL（model 段抛错）
    const upstreamBody = JSON.parse(lastFetchArgs[1].body);
    assert.equal(upstreamBody.model, 'claude-x', 'BUG: model 未替换（body 越界引用抛错）');
    // proxyProfile / proxyUrl 赋值在 catch 之后，未执行
    const entry = lastCompletedOf(mod.LOG_FILE);
    assert.equal(entry.proxyProfile, undefined, 'BUG: proxyProfile 因抛错未记录');
    assert.equal(entry.proxyUrl, undefined, 'BUG: proxyUrl 因抛错未记录');
  });

  it('恢复：清掉 activeProfile 后请求不再改写', async () => {
    writeProfile({ active: 'max', profiles: [{ id: 'max', name: 'Default' }] });
    mod._loadProxyProfile();
    assert.equal(mod._activeProfile, null);
    await postJson('https://api.anthropic.com/v1/messages', { model: 'claude-x', messages: [] });
    assert.equal(lastFetchArgs[0], 'https://api.anthropic.com/v1/messages', 'origin 未改');
  });
});

describe('delta storage（mainAgent 增量写盘）', () => {
  // 这些用例依赖模块级 _lastMessagesCount/_lastTailFp 状态；它们在本文件内按执行顺序累积。
  // 为避免与前面 proxy 用例里发出的 mainAgent? 请求耦合，这里只用一组连续 mainAgent 请求，
  // 断言相对关系（首条 checkpoint / append→delta / in-place→checkpoint），不假设绝对计数。
  let logFile;
  before(() => { logFile = mod.LOG_FILE; });

  it('首条 mainAgent（_lastMessagesCount 可能非 0，但内容延续）→ 至少能写出 _deltaFormat=1 entry', async () => {
    await postJson('https://api.anthropic.com/v1/messages', mainBody([{ role: 'user', content: 'm1' }]));
    const entry = lastCompletedOf(logFile);
    assert.equal(entry.mainAgent, true);
    assert.equal(entry._deltaFormat, 1);
    assert.equal(entry._conversationId, 'mainAgent');
    assert.equal(typeof entry._isCheckpoint, 'boolean');
    assert.equal(typeof entry._totalMessageCount, 'number');
  });

  it('append（长度增大且延续）→ delta 切片（body.messages 只含新增部分）', async () => {
    // 建立 base
    const base = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    await postJson('https://api.anthropic.com/v1/messages', mainBody(base));
    const baseEntry = lastCompletedOf(logFile);
    const baseTotal = baseEntry._totalMessageCount;
    // append 一条
    const grown = [...base, { role: 'user', content: 'c' }];
    await postJson('https://api.anthropic.com/v1/messages', mainBody(grown));
    const entry = lastCompletedOf(logFile);
    assert.equal(entry._totalMessageCount, baseTotal + 1);
    if (!entry._isCheckpoint) {
      // delta 路径：body.messages 是切片，长度 < 总数
      assert.ok(Array.isArray(entry.body.messages));
      assert.ok(entry.body.messages.length <= 1, 'delta 只含新增 message');
      assert.equal(entry.body.messages[entry.body.messages.length - 1].content, 'c');
    } else {
      // 若恰逢周期 checkpoint，则是完整 messages
      assert.equal(entry.body.messages.length, baseTotal + 1);
    }
  });

  it('messages 缩短（/clear 语义）→ 强制 checkpoint（完整 messages）', async () => {
    // 先建立较长 base
    const longConv = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `x${i}` }));
    await postJson('https://api.anthropic.com/v1/messages', mainBody(longConv));
    // 缩短到 1 条
    await postJson('https://api.anthropic.com/v1/messages', mainBody([{ role: 'user', content: 'fresh' }]));
    const entry = lastCompletedOf(logFile);
    assert.equal(entry._isCheckpoint, true);
    assert.equal(entry._totalMessageCount, 1);
    assert.equal(entry.body.messages.length, 1);
    assert.equal(entry.body.messages[0].content, 'fresh');
  });

  it('in-place 末位替换（长度同、末位内容不同）→ 强制 checkpoint + _inPlaceReplaceDetected', async () => {
    const base = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'orig-answer' }];
    await postJson('https://api.anthropic.com/v1/messages', mainBody(base)); // checkpoint(缩短前一条触发) 或 delta
    // 末位原地替换：长度仍 2，末位 content 改变
    const replaced = [{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'totally different answer text' }];
    await postJson('https://api.anthropic.com/v1/messages', mainBody(replaced));
    const entry = lastCompletedOf(logFile);
    assert.equal(entry._isCheckpoint, true);
    assert.equal(entry._inPlaceReplaceDetected, true);
    assert.equal(entry._totalMessageCount, 2);
  });
});

describe('initForWorkspace / resetWorkspace', () => {
  it('initForWorkspace 新建：目录无历史日志 → resumed=false，新文件路径', () => {
    const projectPath = join(mod._logDir || process.cwd(), '..', 'ws-fresh-' + Date.now());
    const r = mod.initForWorkspace(projectPath, { forceNew: true });
    assert.equal(r.resumed, false);
    assert.equal(r.projectName, basename(projectPath).replace(/[^a-zA-Z0-9_\-\.]/g, '_'));
    assert.ok(r.filePath.endsWith('.jsonl'));
    assert.equal(mod.LOG_FILE, r.filePath);
  });

  it('initForWorkspace 复用：同名目录存在 1 小时内日志 → resumed=true', () => {
    // 第一次创建并写入一条日志
    const projectPath = join(mod._logDir || process.cwd(), '..', 'ws-reuse-' + Date.now());
    const r1 = mod.initForWorkspace(projectPath, { forceNew: true });
    writeFileSync(r1.filePath, '{"a":1}\n---\n');
    // 第二次（forceNew=false）应复用最近日志
    const r2 = mod.initForWorkspace(projectPath, { forceNew: false });
    assert.equal(r2.resumed, true);
    assert.equal(r2.filePath, r1.filePath);
  });

  it('resetWorkspace 清空工作区上下文', () => {
    mod.resetWorkspace();
    assert.equal(mod._projectName, '');
    assert.equal(mod._logDir, '');
    assert.equal(mod.LOG_FILE, '');
  });
});

describe('resolveResumeChoice', () => {
  it('无 _resumeState 时返回 undefined（早退）', () => {
    // 当前模块未进入 resume 交互态（_resumeState 为 null）
    const r = mod.resolveResumeChoice('continue');
    assert.equal(r, undefined);
  });
});
