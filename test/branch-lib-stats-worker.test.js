// 分支覆盖测试: server/lib/stats-worker.js
//
// stats-worker.js 在生产中作为 Worker thread 运行,唯一入口是 parentPort?.on('message')。
// 既有 test/stats-worker.test.js 走真实 Worker thread —— 但 worker 子线程的 *分支* 覆盖
// 数据无法可靠合并回主进程(line 99% 而 branch 仅 ~66%,artifact)。
//
// 本文件改为【主进程内】驱动:用一个 module loader 把 node:worker_threads 重定向到 shim,
// 使 parentPort 在主线程非 null,从而 import 期注册的 message 处理器可在进程内直接触发,
// 分支覆盖得以真实计入。所有 I/O 用私有 tmpdir 隔离,不依赖共享端口/目录。
import { register } from 'node:module';

// ── 安装 worker_threads shim loader(必须在 import 目标模块之前) ──
const shimSrc = `
  import { EventEmitter } from 'node:events';
  const port = new EventEmitter();
  port.postMessage = (m) => { (globalThis.__SW_MSGS ||= []).push(m); };
  export const parentPort = port;
  export const Worker = class {};
  export const isMainThread = true;
  export const workerData = null;
  globalThis.__SW_PORT = port;
`;
const shimUrl = 'data:text/javascript,' + encodeURIComponent(shimSrc);
const resolverSrc = `
  export async function resolve(spec, ctx, next) {
    if (spec === 'node:worker_threads' || spec === 'worker_threads') {
      return { url: ${JSON.stringify(shimUrl)}, shortCircuit: true };
    }
    return next(spec, ctx);
  }
`;
register('data:text/javascript,' + encodeURIComponent(resolverSrc));

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 进程级私有 TMPDIR:避免与并行测试争用共享临时目录。
const PRIVATE_TMP = join(tmpdir(), `ccv-branch-sw-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(PRIVATE_TMP, { recursive: true });
process.env.TMPDIR = PRIVATE_TMP;

// 触发 import 期 parentPort?.on 注册;目标模块无导出,仅为副作用加载。
before(async () => {
  globalThis.__SW_MSGS = [];
  await import('../server/lib/stats-worker.js');
  assert.ok(globalThis.__SW_PORT, 'shim parentPort 应已就绪');
});

let workRoot;
beforeEach(() => {
  workRoot = join(PRIVATE_TMP, `t-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workRoot, { recursive: true });
});
afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

function jsonlEntry(obj) { return JSON.stringify(obj); }
function buildJsonlContent(entries) { return entries.map(jsonlEntry).join('\n---\n'); }

/** 同步触发 message 处理器并返回该次调用产生的消息列表(处理器内全部同步执行)。 */
function dispatch(msg) {
  globalThis.__SW_MSGS = [];
  globalThis.__SW_PORT.emit('message', msg);
  return globalThis.__SW_MSGS;
}

function readStats(logDir, projectName) {
  return JSON.parse(readFileSync(join(logDir, projectName, `${projectName}.json`), 'utf-8'));
}

// ─── init: 基础解析 / model+usage / 各类 usage 字段分支 ───

describe('stats-worker 分支: init 解析 model 与 usage 字段', () => {
  it('解析 model 与各 usage 字段,覆盖 input/output/cache 累加分支', () => {
    const projectName = 'p-basic';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    const content = buildJsonlContent([
      // 完整 usage(含 cache_read 与 cache_creation)
      { body: { model: 'mA' }, response: { body: { model: 'mA', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } } } },
      // 仅 cache_creation(无 cache_read)→ cacheRead 三元取 0 分支
      { body: { model: 'mA' }, response: { body: { model: 'mA', usage: { output_tokens: 5, cache_creation_input_tokens: 7 } } } },
      // 无 usage → 跳过累加(usage falsy 分支)
      { body: { model: 'mB' }, response: { body: { model: 'mB' } } },
      // 仅 body.model,无 response → model 取自 body.model 分支
      { body: { model: 'mB' } },
    ]);
    writeFileSync(join(projectDir, 's.jsonl'), content);

    const msgs = dispatch({ type: 'init', logDir: workRoot, projectName });
    assert.ok(msgs.some(m => m.type === 'init-done'));
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.requestCount, 4);
    assert.equal(stats.summary.input_tokens, 100);
    assert.equal(stats.summary.output_tokens, 55);
    assert.equal(stats.summary.cache_creation_input_tokens, 17);
    assert.equal(stats.models['mA'], 2);
    assert.equal(stats.models['mB'], 2);
  });

  it('model 取自 response.body.model(body 无 model)', () => {
    const projectName = 'p-resp-model';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent([
      { body: {}, response: { body: { model: 'fromResp', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.models['fromResp'], 1);
  });

  it('无 model 的条目仍计 requestCount 但不进 models (continue 分支)', () => {
    const projectName = 'p-no-model';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent([
      { body: {}, response: { body: { usage: { input_tokens: 9, output_tokens: 9 } } } },
      { body: { model: 'ok' }, response: { body: { model: 'ok', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.requestCount, 2);
    assert.equal(stats.models['ok'], 1);
    assert.equal(Object.keys(stats.models).length, 1);
  });

  it('cacheRead 三元各分支:仅 cache_read / 仅 cache_creation / 两者皆无', () => {
    const projectName = 'p-cacheternary';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent([
      // 仅 cache_read 有值(A 真)→ cacheRead = cache_read
      { body: { model: 'm' }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 11 } } } },
      // cache_read=0(A 假)但 cache_creation 有值(B 真)→ 三元真分支但内层 (cache_read||0)=0
      { body: { model: 'm' }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 22 } } } },
      // 两者皆无(A假 B假)→ 三元假分支 cacheRead=0
      { body: { model: 'm' }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.cache_read_input_tokens, 11);
    assert.equal(stats.summary.cache_creation_input_tokens, 22);
  });

  it('空 JSONL 文件返回零统计 (content.trim() 为空分支)', () => {
    const projectName = 'p-empty';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'e.jsonl'), '   \n  ');
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.requestCount, 0);
    assert.equal(stats.summary.input_tokens, 0);
  });

  it('坏 JSON 条目被 catch 跳过,好条目计入 (JSON.parse 抛错分支)', () => {
    const projectName = 'p-bad-entry';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'm.jsonl'),
      'not json\n---\n' + jsonlEntry({ body: { model: 'ok' }, response: { body: { model: 'ok', usage: { input_tokens: 2, output_tokens: 1 } } } }));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.requestCount, 1);
  });
});

// ─── 文本提取 / isSystemText / stripSystemTags / extractUserTexts 分支 ───

describe('stats-worker 分支: 用户文本提取与系统文本过滤', () => {
  function runWithUserMsgs(projectName, messagesList) {
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    const entries = messagesList.map(messages => ({
      mainAgent: true,
      body: { model: 'm', messages },
      response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } },
    }));
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent(entries));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    return Object.values(stats.files)[0].preview;
  }

  it('string content:剥离系统标签后保留用户文本,纯标签条目被跳过', () => {
    const preview = runWithUserMsgs('sx-string', [
      [{ role: 'user', content: '<system-reminder>secret</system-reminder>hello world' }],
      [{ role: 'user', content: '<system-reminder>only system</system-reminder>' }],
    ]);
    assert.deepEqual(preview, ['hello world']);
  });

  it('isSystemText:空文本/纯空白/尖括号开头/各系统前缀均判为系统文本', () => {
    const preview = runWithUserMsgs('sx-systext', [
      [{ role: 'user', content: '' }],                                   // !text
      [{ role: 'user', content: '    ' }],                               // trim 后空
      [{ role: 'user', content: '<foo bar>payload</foo>' }],            // 尖括号开头(标签后接空白)→ isSystemText 命中 ^<tag[\\s]
      [{ role: 'user', content: '<bar>tagged</bar>' }],                 // 尖括号开头(标签后直接 >)→ 命中 ^<tag[>] 另一字符类分支
      [{ role: 'user', content: '[SUGGESTION MODE: x]' }],              // SUGGESTION 前缀
      [{ role: 'user', content: 'Your response was cut off because it exceeded the output token limit now' }],
      [{ role: 'user', content: 'Base directory for this skill: /tmp' }],
      [{ role: 'user', content: 'genuine user text' }],                 // 真实文本
    ]);
    assert.deepEqual(preview, ['genuine user text']);
  });

  it('包含 plan 的文本不被系统文本过滤,但 Implement-the-following-plan 开头被显式跳过', () => {
    const preview = runWithUserMsgs('sx-plan', [
      // 含 "Implement the following plan:" 但不在开头 → isSystemText 返回 false(保留)
      [{ role: 'user', content: 'Please do this. Implement the following plan: step1' }],
      // 以 "Implement the following plan:" 开头 → 显式 continue 跳过
      [{ role: 'user', content: 'Implement the following plan: do everything' }],
    ]);
    assert.deepEqual(preview, ['Please do this. Implement the following plan: step1']);
  });

  it('array content:跳过非 text 块、系统文本块、command-message 块', () => {
    const preview = runWithUserMsgs('sx-array', [
      [{ role: 'user', content: [
        { type: 'tool_result', content: 'ignored' },                   // 非 text → continue
        { type: 'text', text: '   ' },                                  // 空白 → continue
        { type: 'text', text: '<system-reminder>sys</system-reminder>' }, // isSystemText → continue
        { type: 'text', text: 'real array text' },                      // 保留
      ] }],
    ]);
    assert.deepEqual(preview, ['real array text']);
  });

  it('array content 含 command-message:跳过 command-message 块,保留普通块 (line 55 命中分支)', () => {
    const preview = runWithUserMsgs('sx-cmd', [
      [{ role: 'user', content: [
        // 文本不以 < 开头(非系统文本)但内嵌 <command-message> → 通过 isSystemText,
        // 在 line 55 因 hasCommand && 命中正则被跳过(覆盖 branch 34)。
        { type: 'text', text: 'cmd wrapper <command-message>/foo</command-message> tail' },
        { type: 'text', text: 'argument text' },                            // 普通文本保留
      ] }],
    ]);
    assert.deepEqual(preview, ['argument text']);
  });

  it('array content text 块缺少 text 字段 → (b.text||"") 取空串分支 (line 49/53 b.text 兜底)', () => {
    const preview = runWithUserMsgs('sx-notext-field', [
      [{ role: 'user', content: [
        // type=text 但无 text 字段:line 49 some 回调 (b.text||'') 取空串;
        //               line 53/54 (b.text||'').trim() 为空 → continue。
        { type: 'text' },
        { type: 'text', text: 'has text' },
      ] }],
    ]);
    assert.deepEqual(preview, ['has text']);
  });

  it('array content 含以 Implement-the-following-plan 开头的 text 块被跳过', () => {
    const preview = runWithUserMsgs('sx-array-plan', [
      [{ role: 'user', content: [
        { type: 'text', text: 'Implement the following plan: x' }, // 跳过
        { type: 'text', text: 'kept' },
      ] }],
    ]);
    assert.deepEqual(preview, ['kept']);
  });

  it('array content 全部为系统/命令文本 → userParts 为空,不 push (userParts.length===0 分支)', () => {
    const preview = runWithUserMsgs('sx-array-empty', [
      [{ role: 'user', content: [
        { type: 'text', text: '<system-reminder>all sys</system-reminder>' },
      ] }],
      [{ role: 'user', content: [{ type: 'text', text: 'finally real' }] }],
    ]);
    assert.deepEqual(preview, ['finally real']);
  });

  it('非 user 角色消息被跳过 (msg.role !== user 分支)', () => {
    const preview = runWithUserMsgs('sx-roles', [
      [
        { role: 'assistant', content: 'assistant text ignored' },
        { role: 'user', content: 'user kept' },
      ],
    ]);
    assert.deepEqual(preview, ['user kept']);
  });
});

// ─── isSuggestionMode 各分支 ───

describe('stats-worker 分支: isSuggestionMode', () => {
  function turnCountFor(messagesList) {
    const projectName = 'sg-' + Math.random().toString(36).slice(2);
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    const entries = messagesList.map((messages, i) => ({
      mainAgent: true,
      _totalMessageCount: messages.length,
      body: { model: 'm', messages },
      response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } },
    }));
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent(entries));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    return readStats(workRoot, projectName).summary.turnCount;
  }

  it('array content 含 SUGGESTION MODE 文本 → 跳过,不计 turn', () => {
    const tc = turnCountFor([
      [{ role: 'user', content: 'q1' }],
      [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a' }, { role: 'user', content: [{ type: 'text', text: '[SUGGESTION MODE: next]' }] }],
    ]);
    assert.equal(tc, 1, '只有第一条计 turn');
  });

  it('array content 末条 text 块缺 text 字段 → (b.text||"") 取空串后非 suggestion (line 76 兜底)', () => {
    // 最后一条 user 的 content 数组里 text 块无 text 字段:
    // isSuggestionMode 的 some 回调走 (b.text||'').trim() 空串分支 → 非 suggestion → 计 turn。
    const tc = turnCountFor([
      [{ role: 'user', content: [{ type: 'text' }] }],
    ]);
    assert.equal(tc, 1);
  });

  it('string content 含 SUGGESTION MODE → 跳过', () => {
    const tc = turnCountFor([
      [{ role: 'user', content: 'q1' }],
      [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a' }, { role: 'user', content: '[SUGGESTION MODE: predict]' }],
    ]);
    assert.equal(tc, 1);
  });

  it('messages 为空数组 → isSuggestionMode false(length===0 分支),但 mainAgent 需 Array 非空才进统计', () => {
    // body.messages = [] → Array.isArray 为真但 length 0;进入逻辑后 last 为 undefined
    // isSuggestionMode([]) 直接 length===0 返回 false。len=0 不 > maxMsgLen(0) → 非新轮,不计 turn。
    const tc = turnCountFor([[]]);
    assert.equal(tc, 0);
  });

  it('最后一条非 user 角色 → isSuggestionMode false (last.role !== user 分支)', () => {
    const tc = turnCountFor([
      [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'tail assistant' }],
    ]);
    assert.equal(tc, 1, '非 suggestion → 正常计 turn');
  });

  it('最后一条 user content 既非数组也非字符串 → 末尾 return false (line 79)', () => {
    const tc = turnCountFor([
      [{ role: 'user', content: 12345 }],
    ]);
    assert.equal(tc, 1);
  });
});

// ─── 会话/轮次统计 + /clear 重置 + delta 格式 + 同轮去重 ───

describe('stats-worker 分支: 会话轮次统计与去重', () => {
  it('多轮会话:新轮次递增 turnCount,len===1 计 sessionCount', () => {
    const projectName = 'turns';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent([
      { mainAgent: true, body: { model: 'm', messages: [{ role: 'user', content: 't1' }] }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
      { mainAgent: true, body: { model: 'm', messages: [{ role: 'user', content: 't1' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 't2' }] }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.turnCount, 2);
    assert.equal(stats.summary.sessionCount, 1);
    assert.deepEqual(Object.values(stats.files)[0].preview, ['t1', 't2']);
  });

  it('messages 大幅缩减(/clear)触发 maxMsgLen/prevTextCount 重置 (lines 119-122)', () => {
    const projectName = 'clear';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    const longMsgs = [];
    for (let i = 0; i < 11; i++) { longMsgs.push({ role: 'user', content: `u${i}` }); longMsgs.push({ role: 'assistant', content: `a${i}` }); }
    const shortMsgs = [{ role: 'user', content: 'after clear' }];
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent([
      { mainAgent: true, _totalMessageCount: 22, body: { model: 'm', messages: longMsgs }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
      { mainAgent: true, _totalMessageCount: 1, body: { model: 'm', messages: shortMsgs }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    // 第一条 len=22 → turn; 第二条 /clear len=1 触发重置后 len>maxMsgLen(0) → 也计 turn
    assert.equal(stats.summary.turnCount, 2);
    assert.equal(stats.summary.sessionCount, 1);
  });

  it('新会话 len===1 但未触发 shrink(上一会话也短)→ 重置基线分支 (lines 130-135)', () => {
    const projectName = 'newsess';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent([
      // 会话1: len=1
      { mainAgent: true, body: { model: 'm', messages: [{ role: 'user', content: 'first' }] }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
      // 会话2: 又一个 len=1(sessionCount>0),isNewTurn=false(1 不 > maxMsgLen=1),进入 len===1 && !isNewTurn 重置分支
      { mainAgent: true, body: { model: 'm', messages: [{ role: 'user', content: 'second session' }] }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.sessionCount, 2);
    assert.deepEqual(Object.values(stats.files)[0].preview, ['first', 'second session']);
  });

  it('delta 格式条目从 0 收集 (_deltaFormat → textStart=0)', () => {
    const projectName = 'delta';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent([
      { mainAgent: true, _deltaFormat: true, _totalMessageCount: 1, body: { model: 'm', messages: [{ role: 'user', content: 'delta prompt' }] }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.deepEqual(Object.values(stats.files)[0].preview, ['delta prompt']);
  });

  it('同轮重复请求 sig 相同且非新轮次 → 跳过收集 (lines 141-142)', () => {
    const projectName = 'dedup';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    const same = [{ role: 'user', content: 'alpha' }, { role: 'assistant', content: 'r' }, { role: 'user', content: 'beta' }];
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent([
      { mainAgent: true, body: { model: 'm', messages: same }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
      { mainAgent: true, body: { model: 'm', messages: same }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    // 第一条新轮采集 alpha/beta;第二条同签名非新轮被跳过
    assert.deepEqual(Object.values(stats.files)[0].preview, ['alpha', 'beta']);
    assert.equal(stats.summary.turnCount, 1);
  });

  it('preview 去重:相同文本只保留首次 (seenPreview Set 分支)', () => {
    const projectName = 'preview-dedup';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    // 两个独立新会话(len=1)文本相同 → 各自被收集,但末尾 uniquePreview 去重
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent([
      { mainAgent: true, body: { model: 'm', messages: [{ role: 'user', content: 'dup text' }] }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
      { mainAgent: true, body: { model: 'm', messages: [{ role: 'user', content: 'dup text' }] }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.deepEqual(Object.values(stats.files)[0].preview, ['dup text']);
  });

  it('mainAgent 但 body.messages 非数组 → 不进会话逻辑 (Array.isArray 为假分支)', () => {
    const projectName = 'no-msgs';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent([
      { mainAgent: true, body: { model: 'm' }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.turnCount, 0);
    assert.equal(stats.summary.requestCount, 1);
  });

  it('flat 文本被换行折叠并截断到 100 字符 (preview slice 分支)', () => {
    const projectName = 'longtext';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    const long = 'line1\nline2\r\n' + 'x'.repeat(200);
    writeFileSync(join(projectDir, 's.jsonl'), buildJsonlContent([
      { mainAgent: true, body: { model: 'm', messages: [{ role: 'user', content: long }] }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const p = Object.values(readStats(workRoot, projectName).files)[0].preview[0];
    assert.equal(p.length, 100);
    assert.ok(!/[\r\n]/.test(p));
  });
});

// ─── generateProjectStats: 读已有 stats / 增量复用 / 提前 return ───

describe('stats-worker 分支: 增量与已有缓存', () => {
  it('已有 stats JSON 损坏 → JSON.parse catch → existing=null (lines 231-233)', () => {
    const projectName = 'corrupt-cache';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'log.jsonl'), buildJsonlContent([
      { body: { model: 'x' }, response: { body: { model: 'x', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    writeFileSync(join(projectDir, `${projectName}.json`), 'INVALID{{{');
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.requestCount, 1);
  });

  it('update 增量:未变化文件从缓存复用(汇总 topModels),仅重解指定文件 (lines 263-277)', () => {
    const projectName = 'incr';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'file1.jsonl'), buildJsonlContent([
      { body: { model: 'm1' }, response: { body: { model: 'm1', usage: { input_tokens: 10, output_tokens: 5 } } } },
    ]));
    writeFileSync(join(projectDir, 'file2.jsonl'), buildJsonlContent([
      { body: { model: 'm2' }, response: { body: { model: 'm2', usage: { input_tokens: 20, output_tokens: 10 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    // 仅更新 file2:file1 走 existing 缓存复用分支(onlyFile !== f)
    const msgs = dispatch({ type: 'update', logDir: workRoot, projectName, logFile: join(projectDir, 'file2.jsonl') });
    assert.ok(msgs.some(m => m.type === 'update-done'));
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.fileCount, 2);
    assert.equal(stats.models['m1'], 1);
    assert.equal(stats.models['m2'], 1);
  });

  it('update 指定的正是缓存命中文件 → 强制重解 (onlyFile === f 分支)', () => {
    const projectName = 'incr-self';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'only.jsonl'), buildJsonlContent([
      { body: { model: 'm1' }, response: { body: { model: 'm1', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    // 文件大小/mtime 未变,但 onlyFile === 'only.jsonl' → 不复用,强制重解
    const msgs = dispatch({ type: 'update', logDir: workRoot, projectName, logFile: join(projectDir, 'only.jsonl') });
    assert.ok(msgs.some(m => m.type === 'update-done'));
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.requestCount, 1);
  });

  it('复用的缓存文件无 models 字段 → 跳过汇总 (filesStats[f].models 为假分支)', () => {
    const projectName = 'cache-nomodels';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'a.jsonl'), buildJsonlContent([
      { body: { model: 'm1' }, response: { body: { model: 'm1', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    writeFileSync(join(projectDir, 'b.jsonl'), buildJsonlContent([
      { body: { model: 'm2' }, response: { body: { model: 'm2', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    // 手动篡改已有 stats:把 a.jsonl 的 models 删掉,再 update b → a 复用且无 models
    const sf = join(projectDir, `${projectName}.json`);
    const cur = JSON.parse(readFileSync(sf, 'utf-8'));
    delete cur.files['a.jsonl'].models;
    writeFileSync(sf, JSON.stringify(cur, null, 2));
    const msgs = dispatch({ type: 'update', logDir: workRoot, projectName, logFile: join(projectDir, 'b.jsonl') });
    assert.ok(msgs.some(m => m.type === 'update-done'));
    const stats = readStats(workRoot, projectName);
    assert.ok(stats.summary.fileCount >= 2);
  });

  it('projectDir 为文件 → readdirSync 抛错直接 return,不写 stats (lines 241-243)', () => {
    const projectName = 'notdir';
    writeFileSync(join(workRoot, projectName), 'i am a file');
    const msgs = dispatch({ type: 'init', logDir: workRoot, projectName });
    // existsSync(projectDir) 为真 → 进 generateProjectStats → readdir 抛错 → return
    // 既然 generateProjectStats 提前 return,init 处理器随后仍 postMessage init-done
    assert.ok(msgs.some(m => m.type === 'init-done'));
    assert.equal(existsSync(join(workRoot, `${projectName}.json`)), false);
  });

  it('无任何 JSONL 文件 → jsonlFiles.length===0 提前 return', () => {
    const projectName = 'no-jsonl';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'readme.txt'), 'nothing here');
    const msgs = dispatch({ type: 'init', logDir: workRoot, projectName });
    assert.ok(msgs.some(m => m.type === 'init-done'));
    assert.equal(existsSync(join(projectDir, `${projectName}.json`)), false);
  });

  it('断链 .jsonl 被 readdir 列出但 statSync 抛错 → continue 跳过 (lines 255-257)', () => {
    const projectName = 'dangling';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    symlinkSync(join(projectDir, 'ghost.jsonl'), join(projectDir, 'broken.jsonl'));
    writeFileSync(join(projectDir, 'real.jsonl'), buildJsonlContent([
      { body: { model: 'r' }, response: { body: { model: 'r', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    dispatch({ type: 'init', logDir: workRoot, projectName });
    const stats = readStats(workRoot, projectName);
    assert.equal(stats.summary.requestCount, 1);
    assert.equal(stats.files['broken.jsonl'], undefined);
    assert.equal(stats.summary.fileCount, 2);
  });

  it('writeFileSync 抛错(statsFile 被目录占用)→ 发 error 消息 (lines 335-337)', () => {
    const projectName = 'writefail';
    const projectDir = join(workRoot, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'log.jsonl'), buildJsonlContent([
      { body: { model: 'm' }, response: { body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]));
    mkdirSync(join(projectDir, `${projectName}.json`), { recursive: true });
    const msgs = dispatch({ type: 'init', logDir: workRoot, projectName });
    const err = msgs.find(m => m.type === 'error');
    assert.ok(err, '应收到写失败 error 消息');
    assert.match(err.message, /Failed to write stats/);
  });
});

// ─── scan-all / 消息分发 ───

describe('stats-worker 分支: scan-all 与消息分发', () => {
  it('scan-all 遍历目录,跳过非目录条目,逐项生成 stats', () => {
    for (const name of ['pa', 'pb']) {
      const d = join(workRoot, name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'l.jsonl'), buildJsonlContent([
        { body: { model: 'x' }, response: { body: { model: 'x', usage: { input_tokens: 1, output_tokens: 1 } } } },
      ]));
    }
    writeFileSync(join(workRoot, 'loose.txt'), 'not a dir'); // 非目录 → 跳过
    const msgs = dispatch({ type: 'scan-all', logDir: workRoot });
    assert.ok(msgs.some(m => m.type === 'scan-all-done'));
    for (const name of ['pa', 'pb']) {
      assert.ok(existsSync(join(workRoot, name, `${name}.json`)));
    }
  });

  it('scan-all logDir 为文件 → readdir 抛错 → 发 error 后仍发 scan-all-done (lines 352-355)', () => {
    const fake = join(workRoot, 'fake-logroot');
    writeFileSync(fake, 'a file, not a dir');
    const msgs = dispatch({ type: 'scan-all', logDir: fake });
    const err = msgs.find(m => m.type === 'error');
    assert.ok(err);
    assert.match(err.message, /scan-all failed/);
    assert.ok(msgs.some(m => m.type === 'scan-all-done'));
  });

  it('init 指向不存在的 projectDir → existsSync 为假,不发 init-done', () => {
    const msgs = dispatch({ type: 'init', logDir: workRoot, projectName: 'ghost-project' });
    assert.equal(msgs.some(m => m.type === 'init-done'), false);
  });

  it('update 指向不存在的 projectDir → existsSync 为假,不发 update-done', () => {
    const msgs = dispatch({ type: 'update', logDir: workRoot, projectName: 'ghost', logFile: join(workRoot, 'ghost', 'x.jsonl') });
    assert.equal(msgs.some(m => m.type === 'update-done'), false);
  });

  it('未知消息类型 → switch 无匹配 case,无副作用', () => {
    const msgs = dispatch({ type: 'totally-unknown' });
    assert.equal(msgs.length, 0);
  });
});
