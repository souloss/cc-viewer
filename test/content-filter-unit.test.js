/**
 * Unit tests for src/utils/contentFilter.js
 *
 * 覆盖目标导出：
 *   getSystemText / isTeammate / isMainAgent / isSkillText
 *   SYNTHETIC_PROMPTS / isSyntheticPromptText / isSystemText
 *   classifyUserContent（重点：teammate / task-notification / command / skill / 二次提取）
 *   extractTeammateName / resolveTeammateNames
 *   isPostClearCheckpoint（re-export 自 clearCheckpoint.js）
 *
 * 该模块带无扩展名 import('./teammateDetector')（Vite 约定），纯 Node 无法直接 import，
 * 必须先注册 _shims loader 再用【动态 import】加载。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import './_shims/register.mjs';

let CF;
before(async () => {
  CF = await import('../src/utils/contentFilter.js');
});

// ─────────────────────────── helpers ───────────────────────────
function mkReq({ system = '', tools = [], teammate, messages = [], mainAgent, response, timestamp } = {}) {
  const req = { body: { system, tools, messages } };
  if (teammate !== undefined) req.teammate = teammate;
  if (mainAgent !== undefined) req.mainAgent = mainAgent;
  if (response !== undefined) req.response = response;
  if (timestamp !== undefined) req.timestamp = timestamp;
  return req;
}

const MAIN_SYSTEM = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
const SDK_SYSTEM = 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.';

// ─────────────────────────── getSystemText ───────────────────────────
describe('getSystemText', () => {
  it('string system 原样返回', () => {
    assert.equal(CF.getSystemText({ system: 'hello world' }), 'hello world');
  });

  it('array system 拼接所有 .text', () => {
    assert.equal(CF.getSystemText({ system: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }), 'abc');
  });

  it('array 中 null / 缺 text 的块跳过（视作空串）', () => {
    assert.equal(CF.getSystemText({ system: [{ text: 'x' }, null, {}, { text: 'y' }] }), 'xy');
  });

  it('无 system / null body → 空串', () => {
    assert.equal(CF.getSystemText({}), '');
    assert.equal(CF.getSystemText(null), '');
    assert.equal(CF.getSystemText(undefined), '');
  });

  it('非 string 非 array 的 system（如对象）→ 空串', () => {
    assert.equal(CF.getSystemText({ system: { text: 'nope' } }), '');
  });
});

// ─────────────────────────── isTeammate ───────────────────────────
describe('isTeammate', () => {
  it('null / undefined → false', () => {
    assert.equal(CF.isTeammate(null), false);
    assert.equal(CF.isTeammate(undefined), false);
  });

  it('interceptor 模式：req.teammate 已存在 → true', () => {
    const req = mkReq({ teammate: 'researcher' });
    assert.equal(CF.isTeammate(req), true);
  });

  it('proxy 模式：system prompt 含 "Agent Teammate Communication" → true', () => {
    const req = mkReq({ system: 'foo\nAgent Teammate Communication\nbar' });
    assert.equal(CF.isTeammate(req), true);
  });

  it('proxy 模式：system prompt 含 "running as an agent in a team" → true', () => {
    const req = mkReq({ system: 'You are running as an agent in a team.' });
    assert.equal(CF.isTeammate(req), true);
  });

  it('native teammate：SDK prompt + SendMessage tool → true 且注入 req.teammate', () => {
    const req = mkReq({
      system: SDK_SYSTEM,
      tools: [{ name: 'Bash' }, { name: 'SendMessage' }],
      messages: [{ role: 'user', content: 'You are CRer2, review the diff' }],
    });
    assert.equal(CF.isTeammate(req), true);
    // isTeammate 命中 native 分支时把名字注入 req.teammate
    assert.equal(req.teammate, 'CRer2');
  });

  it('native teammate 无可解析名字 → req.teammate 注入为 null', () => {
    const req = mkReq({
      system: SDK_SYSTEM,
      tools: [{ name: 'SendMessage' }],
      messages: [{ role: 'user', content: 'just do the thing' }],
    });
    assert.equal(CF.isTeammate(req), true);
    assert.equal(req.teammate, null);
  });

  it('普通 subagent（SDK prompt 但无 SendMessage）→ false', () => {
    const req = mkReq({
      system: SDK_SYSTEM,
      tools: [{ name: 'Bash' }, { name: 'Read' }],
    });
    assert.equal(CF.isTeammate(req), false);
  });

  it('普通 mainAgent system → false', () => {
    const req = mkReq({ system: MAIN_SYSTEM, tools: [{ name: 'Bash' }] });
    assert.equal(CF.isTeammate(req), false);
  });

  it('WeakMap 缓存：同 req 多次调用结果稳定', () => {
    const req = mkReq({ system: 'Agent Teammate Communication' });
    assert.equal(CF.isTeammate(req), true);
    assert.equal(CF.isTeammate(req), true);
  });
});

// ─────────────────────────── isMainAgent ───────────────────────────
describe('isMainAgent', () => {
  it('null → false', () => {
    assert.equal(CF.isMainAgent(null), false);
  });

  it('teammate 请求绝不是 MainAgent', () => {
    const req = mkReq({ teammate: 'researcher', system: MAIN_SYSTEM });
    assert.equal(CF.isMainAgent(req), false);
  });

  it('req.mainAgent 标记 + 非 subagent system → true', () => {
    const req = mkReq({ mainAgent: true, system: MAIN_SYSTEM });
    assert.equal(CF.isMainAgent(req), true);
  });

  it('req.mainAgent 标记但 system 命中 SUBAGENT 正则 → false（旧日志兼容）', () => {
    const req = mkReq({ mainAgent: true, system: 'You are a general-purpose agent for tasks.' });
    assert.equal(CF.isMainAgent(req), false);
  });

  it('无 system / tools 非数组 → false', () => {
    assert.equal(CF.isMainAgent(mkReq({ system: '', tools: [] })), false);
    assert.equal(CF.isMainAgent({ body: { system: MAIN_SYSTEM, tools: null } }), false);
  });

  it('system 不含 "You are Claude Code" → false', () => {
    const req = mkReq({
      system: 'random system text',
      tools: [{ name: 'Edit' }, { name: 'Bash' }, { name: 'Task' }, { name: 't1' }, { name: 't2' }, { name: 't3' }],
    });
    assert.equal(CF.isMainAgent(req), false);
  });

  it('含 "You are Claude Code" 但命中 SUBAGENT 正则 → false', () => {
    const req = mkReq({
      system: MAIN_SYSTEM + ' command execution specialist',
      tools: [{ name: 'Edit' }, { name: 'Bash' }, { name: 'Task' }, { name: 't1' }, { name: 't2' }, { name: 't3' }],
    });
    assert.equal(CF.isMainAgent(req), false);
  });

  it('新架构：system array + ToolSearch + 首条消息含 <available-deferred-tools> → true', () => {
    const req = mkReq({
      system: [{ text: MAIN_SYSTEM }],
      tools: [{ name: 'ToolSearch' }],
      messages: [{ role: 'user', content: 'prelude <available-deferred-tools>...</available-deferred-tools>' }],
    });
    assert.equal(CF.isMainAgent(req), true);
  });

  it('新架构：首条消息 content 为数组，含 deferred-tools → true', () => {
    const req = mkReq({
      system: [{ text: MAIN_SYSTEM }],
      tools: [{ name: 'ToolSearch' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: '<available-deferred-tools>x</available-deferred-tools>' }] }],
    });
    assert.equal(CF.isMainAgent(req), true);
  });

  it('新架构：有 ToolSearch 但首条消息不含 deferred-tools → 回落工具判据', () => {
    // 工具数 <= 5 且无 Edit/Bash/Task 组合 → false
    const req = mkReq({
      system: [{ text: MAIN_SYSTEM }],
      tools: [{ name: 'ToolSearch' }, { name: 'Read' }],
      messages: [{ role: 'user', content: 'no deferred tools here' }],
    });
    assert.equal(CF.isMainAgent(req), false);
  });

  it('新架构：messages 为空时 firstMsgContent 为空串，不命中 deferred', () => {
    const req = mkReq({
      system: [{ text: MAIN_SYSTEM }],
      tools: [{ name: 'ToolSearch' }],
      messages: [],
    });
    assert.equal(CF.isMainAgent(req), false);
  });

  it('旧架构降级：tools>5 且有 Edit+Bash+Task → true', () => {
    const req = mkReq({
      system: MAIN_SYSTEM,
      tools: [{ name: 'Edit' }, { name: 'Bash' }, { name: 'Task' }, { name: 'a' }, { name: 'b' }, { name: 'c' }],
    });
    assert.equal(CF.isMainAgent(req), true);
  });

  it('旧架构降级：PowerShell + Agent 也算（Windows + native agent 工具）', () => {
    const req = mkReq({
      system: MAIN_SYSTEM,
      tools: [{ name: 'Edit' }, { name: 'PowerShell' }, { name: 'Agent' }, { name: 'a' }, { name: 'b' }, { name: 'c' }],
    });
    assert.equal(CF.isMainAgent(req), true);
  });

  it('旧架构：tools>5 但缺少 Edit → false', () => {
    const req = mkReq({
      system: MAIN_SYSTEM,
      tools: [{ name: 'Read' }, { name: 'Bash' }, { name: 'Task' }, { name: 'a' }, { name: 'b' }, { name: 'c' }],
    });
    assert.equal(CF.isMainAgent(req), false);
  });

  it('tools.length <= 5 且无 deferred → false', () => {
    const req = mkReq({
      system: MAIN_SYSTEM,
      tools: [{ name: 'Edit' }, { name: 'Bash' }, { name: 'Task' }],
    });
    assert.equal(CF.isMainAgent(req), false);
  });

  it('WeakMap 缓存：结果稳定', () => {
    const req = mkReq({ mainAgent: true, system: MAIN_SYSTEM });
    assert.equal(CF.isMainAgent(req), true);
    assert.equal(CF.isMainAgent(req), true);
  });
});

// ─────────────────────────── isSkillText ───────────────────────────
describe('isSkillText', () => {
  it('以 "Base directory for this skill:" 起首 → true（含前导空白）', () => {
    assert.equal(CF.isSkillText('  Base directory for this skill: /foo/bar'), true);
  });

  it('大小写不敏感', () => {
    assert.equal(CF.isSkillText('base DIRECTORY for this skill: x'), true);
  });

  it('普通文本 → false', () => {
    assert.equal(CF.isSkillText('hello world'), false);
  });

  it('空/假值 → false', () => {
    assert.equal(CF.isSkillText(''), false);
    assert.equal(CF.isSkillText(null), false);
    assert.equal(CF.isSkillText(undefined), false);
  });
});

// ─────────────────────────── SYNTHETIC_PROMPTS / isSyntheticPromptText ───────────────────────────
describe('isSyntheticPromptText & SYNTHETIC_PROMPTS', () => {
  it('SYNTHETIC_PROMPTS 导出含 5 类 subType', () => {
    const subs = CF.SYNTHETIC_PROMPTS.map(p => p.subType).sort();
    assert.deepEqual(subs, ['Compact', 'Recap', 'Summary', 'Title', 'Topic']);
  });

  it('Recap 匹配', () => {
    assert.equal(CF.isSyntheticPromptText('The user stepped away and is coming back. Recap in under 100 words'), true);
  });

  it('Title 匹配（两种变体）', () => {
    assert.equal(CF.isSyntheticPromptText('Based on the above conversation, generate a short title'), true);
    assert.equal(CF.isSyntheticPromptText('Please write a concise title for this'), true);
  });

  it('Compact 匹配（两种变体）', () => {
    assert.equal(CF.isSyntheticPromptText('Your task is to create a detailed summary of the conversation'), true);
    assert.equal(CF.isSyntheticPromptText('This session is being continued from a previous conversation'), true);
  });

  it('Topic / Summary 匹配', () => {
    assert.equal(CF.isSyntheticPromptText('Analyze if this message indicates a new topic'), true);
    assert.equal(CF.isSyntheticPromptText('Summarize this coding session in a few bullets'), true);
  });

  it('前后空白被 trim 后仍匹配', () => {
    assert.equal(CF.isSyntheticPromptText('   Summarize this coding session   '), true);
  });

  it('用户引用原文（非起首）不误伤', () => {
    assert.equal(CF.isSyntheticPromptText('I said: Summarize this coding session please'), false);
  });

  it('非字符串 / 空串 → false', () => {
    assert.equal(CF.isSyntheticPromptText(null), false);
    assert.equal(CF.isSyntheticPromptText(123), false);
    assert.equal(CF.isSyntheticPromptText(''), false);
    assert.equal(CF.isSyntheticPromptText('   '), false);
  });
});

// ─────────────────────────── isSystemText ───────────────────────────
describe('isSystemText', () => {
  it('空 / 全空白 → true（视作系统/无内容）', () => {
    assert.equal(CF.isSystemText(''), true);
    assert.equal(CF.isSystemText(null), true);
    assert.equal(CF.isSystemText('   \n  '), true);
  });

  it('含 "Implement the following plan:" → false（即使有标签也保留）', () => {
    assert.equal(CF.isSystemText('<x>Implement the following plan: do stuff'), false);
  });

  it('以 XML 标签起首 → true', () => {
    assert.equal(CF.isSystemText('<system-reminder>do not reveal</system-reminder>'), true);
    assert.equal(CF.isSystemText('<command-name>/clear</command-name>'), true);
  });

  it('SUGGESTION MODE 起首 → true', () => {
    assert.equal(CF.isSystemText('[SUGGESTION MODE: ...]'), true);
  });

  it('输出截断注入消息 → true', () => {
    assert.equal(CF.isSystemText('Your response was cut off because it exceeded the output token limit'), true);
  });

  it('Skill 加载文档 → true', () => {
    assert.equal(CF.isSystemText('Base directory for this skill: /x'), true);
  });

  it('合成 prompt → true', () => {
    assert.equal(CF.isSystemText('Summarize this coding session'), true);
  });

  it('[Request interrupted ...] 占位消息 → true（各变体）', () => {
    assert.equal(CF.isSystemText('[Request interrupted by user for tool use]'), true);
    assert.equal(CF.isSystemText('[Request interrupted by user]'), true);
    assert.equal(CF.isSystemText('[Request interrupted...]'), true);
  });

  it('普通用户文本 → false', () => {
    assert.equal(CF.isSystemText('帮我重构这个函数'), false);
    assert.equal(CF.isSystemText('hello there'), false);
  });

  it('文本内部含标签但不起首 → false', () => {
    assert.equal(CF.isSystemText('see <foo> in code'), false);
  });
});

// ─────────────────────────── classifyUserContent ───────────────────────────
describe('classifyUserContent', () => {
  it('非数组输入 → 全空结构', () => {
    const r = CF.classifyUserContent(null);
    assert.deepEqual(r, { commands: [], textBlocks: [], skillBlocks: [], teammateBlocks: [], taskNotificationBlocks: [] });
  });

  it('普通用户文本块保留，系统块过滤', () => {
    const content = [
      { type: 'text', text: '请帮我写测试' },
      { type: 'text', text: '<system-reminder>secret</system-reminder>' },
    ];
    const r = CF.classifyUserContent(content);
    assert.equal(r.textBlocks.length, 1);
    assert.equal(r.textBlocks[0].text, '请帮我写测试');
  });

  it('前提固化:skill 文本(isSkillText)绝不进 textBlocks,skillBlocks 恒为 []', () => {
    // skillBlocks 分离分支被删的前提:isSkillText 与 isSystemText 共用同一正则
    // (/^Base directory for this skill:/i),textBlocks 两条进入路径都要求 !isSystemText,
    // 故 skill 块必先被系统块过滤、旧 filter 恒得 []。本用例把该前提钉死——若未来任一
    // 入口放行了 skill 文本,这里会先红,防止 skill 内容从 ChatView/ImConversationModal
    // 双消费方静默消失(评审 P1 固化项)。
    const skillText = 'Base directory for this skill: /Users/x/.claude/skills/foo';
    const content = [
      { type: 'text', text: skillText },
      { type: 'text', text: `  ${skillText}(前导空白变体)` },
      { type: 'text', text: '正常文本要保留' },
    ];
    const r = CF.classifyUserContent(content);
    assert.deepEqual(r.skillBlocks, [], 'skillBlocks 保持空数组(返回 shape 兼容)');
    assert.equal(r.textBlocks.length, 1, 'skill 文本不得落入 textBlocks');
    assert.equal(r.textBlocks[0].text, '正常文本要保留');
    // 同一前提的根:isSkillText 为真的文本,isSystemText 必为真
    assert.equal(CF.isSkillText(skillText), true);
    assert.equal(CF.isSystemText(skillText), true);
  });

  it('teammate-message：含 content 的普通消息块解析（id/color/summary/content）', () => {
    const content = [{
      type: 'text',
      text: '<teammate-message teammate_id="researcher" color="blue" summary="done">all tasks finished</teammate-message>',
    }];
    const r = CF.classifyUserContent(content);
    assert.equal(r.teammateBlocks.length, 1);
    assert.deepEqual(r.teammateBlocks[0], {
      id: 'researcher', color: 'blue', summary: 'done', content: 'all tasks finished', status: null,
    });
  });

  it('teammate-message：缺 id/color 时使用默认值', () => {
    const content = [{ type: 'text', text: '<teammate-message foo="bar">hi</teammate-message>' }];
    const r = CF.classifyUserContent(content);
    assert.equal(r.teammateBlocks[0].id, 'teammate');
    assert.equal(r.teammateBlocks[0].color, null);
    assert.equal(r.teammateBlocks[0].summary, null);
  });

  it('teammate-message：JSON 生命周期信号 → status bubble（statusFrom 取 from）', () => {
    const content = [{
      type: 'text',
      text: '<teammate-message teammate_id="tester">{"type":"idle","from":"tester"}</teammate-message>',
    }];
    const r = CF.classifyUserContent(content);
    assert.equal(r.teammateBlocks[0].status, 'idle');
    assert.equal(r.teammateBlocks[0].statusFrom, 'tester');
    assert.equal(r.teammateBlocks[0].content, null);
    assert.equal(r.teammateBlocks[0].summary, null);
  });

  it('teammate-message：JSON 无 from 时 statusFrom 回落 tmId', () => {
    const content = [{
      type: 'text',
      text: '<teammate-message teammate_id="abc">{"type":"shutdown"}</teammate-message>',
    }];
    const r = CF.classifyUserContent(content);
    assert.equal(r.teammateBlocks[0].statusFrom, 'abc');
  });

  it('teammate-message：以 { 起首但 JSON 解析失败 → 当作普通 content', () => {
    const content = [{
      type: 'text',
      text: '<teammate-message teammate_id="x">{not valid json</teammate-message>',
    }];
    const r = CF.classifyUserContent(content);
    assert.equal(r.teammateBlocks[0].status, null);
    assert.equal(r.teammateBlocks[0].content, '{not valid json');
  });

  it('teammate-message：JSON 合法但无 type 字段 → 当普通 content', () => {
    const content = [{
      type: 'text',
      text: '<teammate-message teammate_id="x">{"foo":1}</teammate-message>',
    }];
    const r = CF.classifyUserContent(content);
    assert.equal(r.teammateBlocks[0].status, null);
    assert.equal(r.teammateBlocks[0].content, '{"foo":1}');
  });

  it('多个 teammate-message 块全部抽取', () => {
    const content = [{
      type: 'text',
      text: '<teammate-message teammate_id="a">m1</teammate-message> mid <teammate-message teammate_id="b">m2</teammate-message>',
    }];
    const r = CF.classifyUserContent(content);
    assert.equal(r.teammateBlocks.length, 2);
    assert.equal(r.teammateBlocks[0].content, 'm1');
    assert.equal(r.teammateBlocks[1].content, 'm2');
  });

  it('task-notification：完整字段 + usage 解析', () => {
    const content = [{
      type: 'text',
      text: '<task-notification>' +
        '<task-id>t-42</task-id><status>completed</status>' +
        '<summary>built feature</summary><result>all green</result>' +
        '<usage><total_tokens>1234</total_tokens><tool_uses>7</tool_uses><duration_ms>5000</duration_ms></usage>' +
        '</task-notification>',
    }];
    const r = CF.classifyUserContent(content);
    assert.equal(r.taskNotificationBlocks.length, 1);
    const tn = r.taskNotificationBlocks[0];
    assert.equal(tn.taskId, 't-42');
    assert.equal(tn.status, 'completed');
    assert.equal(tn.summary, 'built feature');
    assert.equal(tn.result, 'all green');
    assert.deepEqual(tn.usage, { totalTokens: 1234, toolUses: 7, durationMs: 5000 });
  });

  it('task-notification：无 usage 块 → usage 为 null，缺失字段为 null', () => {
    const content = [{
      type: 'text',
      text: '<task-notification><task-id>t1</task-id></task-notification>',
    }];
    const r = CF.classifyUserContent(content);
    const tn = r.taskNotificationBlocks[0];
    assert.equal(tn.taskId, 't1');
    assert.equal(tn.status, null);
    assert.equal(tn.usage, null);
  });

  it('无 task-notification 时跳过整段扫描（taskNotificationBlocks 空）', () => {
    const r = CF.classifyUserContent([{ type: 'text', text: 'no notifications' }]);
    assert.deepEqual(r.taskNotificationBlocks, []);
  });

  it('command：提取 slash command 名称（自动补 / 前缀）', () => {
    const content = [{
      type: 'text',
      text: '<command-message>running</command-message><command-name>clear</command-name>',
    }];
    const r = CF.classifyUserContent(content);
    assert.deepEqual(r.commands, ['/clear']);
    // command 相关块从 textBlocks 中过滤掉
    assert.equal(r.textBlocks.length, 0);
  });

  it('command：已带 / 前缀不重复添加', () => {
    const content = [{
      type: 'text',
      text: '<command-message>x</command-message><command-name>/compact</command-name>',
    }];
    const r = CF.classifyUserContent(content);
    assert.deepEqual(r.commands, ['/compact']);
  });

  it('skill 块当前被 isSystemText 先行过滤，skillBlocks 始终为空（pin 现状/疑似 bug）', () => {
    // 现状：isSkillText 命中的文本同时被 isSystemText 判为系统文本（contentFilter.js:194），
    // 在第一步 textBlocks 过滤时即被剔除，永远进不了 skillBlocks 分离分支（:317-320）。
    // 第二步二次提取也无法回收（无 XML 标签可剥，剥后仍是系统文本）。
    // → skillBlocks 实质不可达，此处按现状 pin 为空，不修源码。
    const content = [
      { type: 'text', text: 'Base directory for this skill: /skills/foo' },
      { type: 'text', text: '正常用户输入' },
    ];
    const r = CF.classifyUserContent(content);
    assert.deepEqual(r.skillBlocks, []);
    assert.equal(r.textBlocks.length, 1);
    assert.equal(r.textBlocks[0].text, '正常用户输入');
  });

  it('二次提取：system-reminder 包裹的用户输入被回收为 textBlock', () => {
    // /ultraplan 场景：系统标签 + 嵌入用户文本，stripSystemTags 后回收
    const content = [{
      type: 'text',
      text: '<system-reminder>internal directive</system-reminder>真正的用户问题在这里',
    }];
    const r = CF.classifyUserContent(content);
    // 原块被 isSystemText 判系统（以 < 起首）→ 过滤；剥标签后回收
    assert.equal(r.textBlocks.length, 1);
    assert.equal(r.textBlocks[0].text, '真正的用户问题在这里');
  });

  it('二次提取：纯标记 [Request interrupted] 无可剥离内容 → 不误回收', () => {
    const content = [{ type: 'text', text: '[Request interrupted by user]' }];
    const r = CF.classifyUserContent(content);
    assert.equal(r.textBlocks.length, 0);
  });

  it('二次提取：剥标签后仍是系统文本 → 不回收', () => {
    const content = [{
      type: 'text',
      text: '<system-reminder>a</system-reminder><local-command-stdout>b</local-command-stdout>',
    }];
    const r = CF.classifyUserContent(content);
    assert.equal(r.textBlocks.length, 0);
  });

  it('非 text 类型块（image/tool_use）不参与文本分类', () => {
    const content = [
      { type: 'image', source: {} },
      { type: 'text', text: '用户文本' },
    ];
    const r = CF.classifyUserContent(content);
    assert.equal(r.textBlocks.length, 1);
    assert.equal(r.textBlocks[0].text, '用户文本');
  });
});

// ─────────────────────────── extractTeammateName ───────────────────────────
describe('extractTeammateName', () => {
  it('从 SendMessage tool_result 的 routing.sender 提取', () => {
    const body = {
      messages: [{
        content: [{
          type: 'tool_result',
          content: [{ type: 'text', text: JSON.stringify({ routing: { sender: 'researcher' } }) }],
        }],
      }],
    };
    assert.equal(CF.extractTeammateName(body), 'researcher');
  });

  it('tool_result.content 为字符串形式也能解析', () => {
    const body = {
      messages: [{
        content: [{
          type: 'tool_result',
          content: JSON.stringify({ routing: { sender: 'tester' } }),
        }],
      }],
    };
    // content 是字符串 → items = [block]，item.content 字符串被读取
    assert.equal(CF.extractTeammateName(body), 'tester');
  });

  it('从后往前扫描：返回最近一条带 sender 的', () => {
    const mk = (name) => ({
      content: [{
        type: 'tool_result',
        content: [{ type: 'text', text: JSON.stringify({ routing: { sender: name } }) }],
      }],
    });
    const body = { messages: [mk('old'), mk('newer')] };
    assert.equal(CF.extractTeammateName(body), 'newer');
  });

  it('messages 非数组 → null', () => {
    assert.equal(CF.extractTeammateName({ messages: null }), null);
    assert.equal(CF.extractTeammateName({}), null);
    assert.equal(CF.extractTeammateName(null), null);
  });

  it('无 tool_result / 无 sender 字段 → null', () => {
    const body = {
      messages: [{ content: [{ type: 'text', text: 'no sender here' }] }],
    };
    assert.equal(CF.extractTeammateName(body), null);
  });

  it('文本含 "sender" 但非合法 JSON → 跳过返回 null', () => {
    const body = {
      messages: [{
        content: [{ type: 'tool_result', content: [{ type: 'text', text: '"sender" but {broken json' }] }],
      }],
    };
    assert.equal(CF.extractTeammateName(body), null);
  });

  it('content 非数组的消息被跳过', () => {
    const body = {
      messages: [
        { content: 'string content' },
        { content: [{ type: 'tool_result', content: [{ type: 'text', text: JSON.stringify({ routing: { sender: 'X' } }) }] }] },
      ],
    };
    assert.equal(CF.extractTeammateName(body), 'X');
  });
});

// ─────────────────────────── resolveTeammateNames ───────────────────────────
describe('resolveTeammateNames', () => {
  // 构造一个 MainAgent 请求，其 response 含 Agent tool_use，input.name + input.prompt
  function mkMainWithAgentSpawn(name, prompt, timestamp) {
    return {
      mainAgent: true,
      timestamp,
      body: { system: MAIN_SYSTEM, tools: [], messages: [] },
      response: {
        body: {
          content: [
            { type: 'tool_use', name: 'Agent', input: { name, prompt } },
          ],
        },
      },
    };
  }

  // native teammate 首条消息含 <teammate-message> 包装的 spawn prompt
  function mkNativeTeammate(spawnPrompt, timestamp) {
    return {
      timestamp,
      body: {
        system: SDK_SYSTEM,
        tools: [{ name: 'SendMessage' }],
        messages: [{
          role: 'user',
          content: `<teammate-message teammate_id="lead">${spawnPrompt}`,
        }],
      },
    };
  }

  it('非数组 / 空数组：安全 no-op', () => {
    assert.doesNotThrow(() => CF.resolveTeammateNames(null));
    assert.doesNotThrow(() => CF.resolveTeammateNames([]));
  });

  it('将 MainAgent Agent tool_use 的 name 注入到匹配 prompt 的 teammate', () => {
    const PROMPT = 'You are the researcher. Investigate the failing CI pipeline thoroughly and report.';
    const ts = 'session-A-' + Math.random();
    const main = mkMainWithAgentSpawn('researcher', PROMPT, ts);
    const tm = mkNativeTeammate(PROMPT, ts);
    const requests = [main, tm];

    CF.resolveTeammateNames(requests);
    assert.equal(tm.teammate, 'researcher');
  });

  it('raw prompt fallback：native teammate 首条消息无 <teammate-message> 包装时用原始文本匹配', () => {
    const PROMPT = 'You are the builder agent. Implement the new endpoint and write tests for it now.';
    const ts = 'session-raw-' + Math.random();
    const main = mkMainWithAgentSpawn('builder', PROMPT, ts);
    const tm = {
      timestamp: ts,
      body: {
        system: SDK_SYSTEM,
        tools: [{ name: 'SendMessage' }],
        messages: [{ role: 'user', content: PROMPT }],
      },
    };
    CF.resolveTeammateNames([main, tm]);
    assert.equal(tm.teammate, 'builder');
  });

  it('已有 req.teammate 的请求不被覆盖', () => {
    const PROMPT = 'You are the keeper agent. Maintain the registry and keep everything tidy across runs ok.';
    const ts = 'session-keep-' + Math.random();
    const main = mkMainWithAgentSpawn('keeper', PROMPT, ts);
    const tm = mkNativeTeammate(PROMPT, ts);
    tm.teammate = 'preset-name';
    CF.resolveTeammateNames([main, tm]);
    assert.equal(tm.teammate, 'preset-name');
  });

  it('prompt 前缀不匹配 → 不注入', () => {
    const ts = 'session-nomatch-' + Math.random();
    const main = mkMainWithAgentSpawn('researcher', 'A totally different spawn prompt that wont line up at all here.', ts);
    const tm = mkNativeTeammate('Some unrelated teammate first message content goes here for sure yes.', ts);
    CF.resolveTeammateNames([main, tm]);
    assert.equal(tm.teammate, undefined);
  });

  it('registry 为空（无 Agent tool_use）→ 提前返回不注入', () => {
    const ts = 'session-empty-' + Math.random();
    const tm = mkNativeTeammate('You are someone. Do work that is long enough to satisfy the prefix length req.', ts);
    CF.resolveTeammateNames([tm]);
    assert.equal(tm.teammate, undefined);
  });

  it('proxy teammate（TEAMMATE_SYSTEM_RE 命中而非 native）也能被注入', () => {
    const PROMPT = 'You are the analyst agent. Crunch the numbers and surface anomalies in the dataset now.';
    const ts = 'session-proxy-' + Math.random();
    const main = mkMainWithAgentSpawn('analyst', PROMPT, ts);
    const tm = {
      timestamp: ts,
      body: {
        system: 'Agent Teammate Communication',
        tools: [],
        messages: [{ role: 'user', content: `<teammate-message teammate_id="lead">${PROMPT}` }],
      },
    };
    CF.resolveTeammateNames([main, tm]);
    assert.equal(tm.teammate, 'analyst');
  });

  it('session 切换（timestamp 变化）reset registry：旧映射不串台', () => {
    const PROMPT_A = 'You are alpha agent. Long enough prompt content for the prefix to register correctly now.';
    const tsA = 'sess-1-' + Math.random();
    CF.resolveTeammateNames([mkMainWithAgentSpawn('alpha', PROMPT_A, tsA)]);

    // 新 session：首请求 timestamp 改变 → 清空旧 registry
    const tsB = 'sess-2-' + Math.random();
    const tmInB = mkNativeTeammate(PROMPT_A, tsB);
    // session B 没有重新注册 alpha 的 prompt，故无法匹配
    CF.resolveTeammateNames([tmInB]);
    assert.equal(tmInB.teammate, undefined);
  });

  it('首条消息 content 为数组（含 <teammate-message> 文本块）也能提取 spawn prompt', () => {
    const PROMPT = 'You are the scribe agent. Document the API surface fully and keep the notes in sync ok.';
    const ts = 'session-arr-' + Math.random();
    const main = mkMainWithAgentSpawn('scribe', PROMPT, ts);
    const tm = {
      timestamp: ts,
      body: {
        system: SDK_SYSTEM,
        tools: [{ name: 'SendMessage' }],
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: {} },
            { type: 'text', text: `<teammate-message teammate_id="lead">${PROMPT}` },
          ],
        }],
      },
    };
    CF.resolveTeammateNames([main, tm]);
    assert.equal(tm.teammate, 'scribe');
  });

  it('raw prompt fallback：首条消息 content 为数组、无 <teammate-message> 包装也能匹配', () => {
    const PROMPT = 'You are the courier agent. Relay the payloads between services without dropping any of them.';
    const ts = 'session-rawarr-' + Math.random();
    const main = mkMainWithAgentSpawn('courier', PROMPT, ts);
    const tm = {
      timestamp: ts,
      body: {
        system: SDK_SYSTEM,
        tools: [{ name: 'SendMessage' }],
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: PROMPT }],
        }],
      },
    };
    CF.resolveTeammateNames([main, tm]);
    assert.equal(tm.teammate, 'courier');
  });

  it('忽略非 Agent 工具的 tool_use（如 Task）', () => {
    const ts = 'session-task-' + Math.random();
    const PROMPT = 'You are the worker. This prompt is long enough to register as a prefix entry here.';
    const main = {
      mainAgent: true,
      timestamp: ts,
      body: { system: MAIN_SYSTEM, tools: [], messages: [] },
      response: { body: { content: [{ type: 'tool_use', name: 'Task', input: { name: 'worker', prompt: PROMPT } }] } },
    };
    const tm = mkNativeTeammate(PROMPT, ts);
    CF.resolveTeammateNames([main, tm]);
    // Task 不是 Agent → registry 不收录 → 不注入
    assert.equal(tm.teammate, undefined);
  });
});

// ─────────────────────────── isPostClearCheckpoint (re-export) ───────────────────────────
describe('isPostClearCheckpoint (re-export)', () => {
  it('被 contentFilter re-export 且为函数', () => {
    assert.equal(typeof CF.isPostClearCheckpoint, 'function');
  });

  it('真正的 /clear checkpoint → true', () => {
    const entry = {
      _isCheckpoint: true,
      body: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'prefix <command-name>/clear</command-name> suffix' }] },
        ],
      },
    };
    assert.equal(CF.isPostClearCheckpoint(entry, 10), true);
  });

  it('非 checkpoint → false', () => {
    assert.equal(CF.isPostClearCheckpoint({ _isCheckpoint: false, body: { messages: [] } }), false);
  });

  it('消息数未缩短（>= prevMessageCount）→ false', () => {
    const entry = {
      _isCheckpoint: true,
      body: { messages: [{ role: 'user', content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] }] },
    };
    assert.equal(CF.isPostClearCheckpoint(entry, 1), false);
  });
});
