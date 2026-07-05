import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { renameSyncWithRetry } from './file-api.js';
import { join, basename } from 'node:path';

const SUBAGENT_SYSTEM_RE = /(?:command execution|file search|planning) specialist|general-purpose agent|security monitor|performing a web search/i;

// cc_version 2.1.181+：CLI 在 billing header 显式标注子代理（cc_is_subagent=true）；真·主代理省略此字段（从不为 =false）。
// 这类子代理继承完整 "You are Claude Code" prompt + Edit/Bash/Agent 工具，会误中轻量 MainAgent 启发式，故须显式排除。
// 结尾 \b 锚定：仅匹配 `=true`（其后为 `;` / 空白 / 串尾），避免 `=truex` 之类误匹配。
const SUBAGENT_BILLING_RE = /cc_is_subagent=true\b/;
// 同进程 Agent/Task 队友（teammate）：system prompt 注入团队协作标记，但继承完整 "You are Claude Code"
// prompt + Edit/Bash/Task 工具，且不带 --agent-name 进程参数（_isTeammate 认不出），会误中下方 MainAgent
// 启发式 → 流式期间被当 mainAgent 开 live-stream，其 thinking 污染主「最新回复」overlay。须显式排除。
// KEEP IN SYNC: server/lib/kv-cache-analyzer.js + src/utils/contentFilter.js（三处判据必须一致）。
// 两处服务端实现(本文件 + kv-cache-analyzer)由 test/interceptor-core-mainagent.test.js 互校防漂移；
// 前端 contentFilter 那份由 test/content-filter-unit.test.js 单测覆盖。
const TEAMMATE_SYSTEM_RE = /running as an agent in a team|Agent Teammate Communication/i;
// Exported for server/lib/teammate-detect.js (previous-segment backfill filter).
export { TEAMMATE_SYSTEM_RE, SUBAGENT_BILLING_RE };

// Rotation carry-forward: prompt-prefix → teammate-name pairs extracted from a
// mainAgent response body's Agent tool_use blocks. Prefix normalization MUST
// match src/utils/contentFilter.js (trimStart BEFORE slice, length 60) —
// pinned by test/interceptor.test.js parity cases.
export const TEAMMATE_PROMPT_PREFIX_LEN = 60;

export function extractAgentSpawnPairs(responseBody) {
  const pairs = [];
  // The interceptor's stream path can fall back to a raw string body.
  if (!responseBody || typeof responseBody !== 'object') return pairs;
  const content = responseBody.content;
  if (!Array.isArray(content)) return pairs;
  for (const block of content) {
    if (!block || block.type !== 'tool_use' || block.name !== 'Agent') continue;
    const inp = block.input;
    if (!inp || !inp.name || typeof inp.prompt !== 'string') continue;
    const prefix = inp.prompt.trimStart().slice(0, TEAMMATE_PROMPT_PREFIX_LEN);
    if (prefix) pairs.push([prefix, inp.name]);
  }
  return pairs;
}

// Parses the first frame of a log-file head string; returns the entry when it
// is a rotation-context sentinel, else null. Callers pass a BOUNDED head read
// (never a whole segment).
export function parseRotationContextHead(headString) {
  try {
    const frameEnd = headString.indexOf('\n---\n');
    if (frameEnd <= 0) return null;
    const entry = JSON.parse(headString.slice(0, frameEnd));
    return entry && entry.ccvRotationContext ? entry : null;
  } catch {
    return null;
  }
}

export function getSystemText(body) {
  const system = body?.system;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map(s => (s && s.text) || '').join('');
  }
  return '';
}

export function isMainAgentRequest(body) {
  if (!body?.system || !Array.isArray(body?.tools)) return false;

  const sysText = getSystemText(body);
  // 同进程队友 ⇒ 非 MainAgent（与最终重建 isMainAgentEntry 判据对齐，修流式期 teammate thinking 污染主 overlay）。
  if (TEAMMATE_SYSTEM_RE.test(sysText)) return false;
  // cc_is_subagent=true ⇒ 子代理，绝非 MainAgent（cc_version 2.1.181+）。从源头让新日志的 mainAgent 字段为 false。
  if (SUBAGENT_BILLING_RE.test(sysText)) return false;
  if (!sysText.includes('You are Claude Code')) return false;
  if (SUBAGENT_SYSTEM_RE.test(sysText)) return false;

  const isSystemArray = Array.isArray(body.system);
  const hasToolSearch = body.tools.some(t => t.name === 'ToolSearch');

  if (isSystemArray && hasToolSearch) {
    const messages = body.messages || [];
    const firstMsgContent = messages.length > 0 ?
      (typeof messages[0].content === 'string' ? messages[0].content :
        Array.isArray(messages[0].content) ? messages[0].content.map(c => c.text || '').join('') : '') : '';
    if (firstMsgContent.includes('<available-deferred-tools>')) {
      return true;
    }
  }

  // v2.1.81+: 轻量 MainAgent 初始请求工具数可能 < 10，降低阈值兼容
  if (body.tools.length > 5) {
    const hasEdit = body.tools.some(t => t.name === 'Edit');
    const hasShell = body.tools.some(t => t.name === 'Bash' || t.name === 'PowerShell');
    const hasTaskOrAgent = body.tools.some(t => t.name === 'Task' || t.name === 'Agent');
    if (hasEdit && hasShell && hasTaskOrAgent) {
      return true;
    }
  }

  return false;
}

export function isPreflightEntry(entry) {
  if (entry.mainAgent || entry.isHeartbeat || entry.isCountTokens) return false;
  const body = entry.body || {};
  if (Array.isArray(body.tools) && body.tools.length > 0) return false;
  const msgs = body.messages || [];
  if (msgs.length !== 1 || msgs[0].role !== 'user') return false;
  const sysText = typeof body.system === 'string' ? body.system :
    Array.isArray(body.system) ? body.system.map(s => s?.text || '').join('') : '';
  return sysText.includes('Claude Code');
}

export function isAnthropicApiPath(urlStr) {
  try {
    const pathname = new URL(urlStr).pathname;
    // 不锚定起始 —— 兼容代理前缀路径（如 /proxy/group_xxx:8100/v1/messages）。
    // 末尾仍然锚定以避免 /v1/messages/unknown 这类无效后缀误命中。
    return /\/v1\/messages(\/count_tokens|\/batches(\/.*)?)?$/.test(pathname)
      || /^\/api\/eval\/sdk-/.test(pathname);
  } catch {
    return /\/v1\/messages/.test(urlStr);
  }
}

export function assembleStreamMessage(events) {
  let message = null;
  const contentBlocks = [];
  let currentBlockIndex = -1;

  for (const event of events) {
    if (!event || typeof event !== 'object' || !event.type) continue;

    switch (event.type) {
      case 'message_start':
        message = { ...event.message };
        message.content = [];
        break;

      case 'content_block_start':
        currentBlockIndex = event.index;
        contentBlocks[currentBlockIndex] = { ...event.content_block };
        if (contentBlocks[currentBlockIndex].type === 'text') {
          contentBlocks[currentBlockIndex].text = '';
        } else if (contentBlocks[currentBlockIndex].type === 'thinking') {
          contentBlocks[currentBlockIndex].thinking = '';
        }
        break;

      case 'content_block_delta':
        if (event.index >= 0 && contentBlocks[event.index] && event.delta) {
          if (event.delta.type === 'text_delta' && event.delta.text) {
            contentBlocks[event.index].text += event.delta.text;
          } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
            if (typeof contentBlocks[event.index]._inputJson !== 'string') {
              contentBlocks[event.index]._inputJson = '';
            }
            contentBlocks[event.index]._inputJson += event.delta.partial_json;
          } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
            contentBlocks[event.index].thinking += event.delta.thinking;
          } else if (event.delta.type === 'signature_delta' && event.delta.signature) {
            contentBlocks[event.index].signature = event.delta.signature;
          }
        }
        break;

      case 'content_block_stop':
        if (event.index >= 0 && contentBlocks[event.index]) {
          if (contentBlocks[event.index].type === 'tool_use' && typeof contentBlocks[event.index]._inputJson === 'string') {
            try {
              contentBlocks[event.index].input = JSON.parse(contentBlocks[event.index]._inputJson);
            } catch {
              contentBlocks[event.index].input = contentBlocks[event.index]._inputJson;
            }
            delete contentBlocks[event.index]._inputJson;
          }
        }
        break;

      case 'message_delta':
        if (message && event.delta) {
          if (event.delta.stop_reason) {
            message.stop_reason = event.delta.stop_reason;
          }
          if (event.delta.stop_sequence !== undefined) {
            message.stop_sequence = event.delta.stop_sequence;
          }
        }
        if (message && event.usage) {
          message.usage = { ...message.usage, ...event.usage };
        }
        break;

      case 'message_stop':
        break;
    }
  }

  if (message) {
    message.content = contentBlocks.filter(block => block !== undefined);
  }

  return message;
}

/**
 * Incremental stream assembler — mutable state for SSE live streaming.
 *
 * Usage:
 *   const asm = createStreamAssembler();
 *   asm.feed(event);          // consume each SSE event incrementally
 *   const snap = asm.snapshot();  // get current partial message
 *
 * Mirrors assembleStreamMessage but maintains mutable state for O(1) updates
 * rather than O(n) rebuild per call.
 */
export function createStreamAssembler() {
  let message = null;
  const contentBlocks = [];
  let currentBlockIndex = -1;

  return {
    feed(event) {
      if (!event || typeof event !== 'object' || !event.type) return;
      switch (event.type) {
        case 'message_start':
          message = { ...event.message };
          message.content = [];
          break;
        case 'content_block_start':
          currentBlockIndex = event.index;
          contentBlocks[currentBlockIndex] = { ...event.content_block };
          if (contentBlocks[currentBlockIndex].type === 'text') {
            contentBlocks[currentBlockIndex].text = '';
          } else if (contentBlocks[currentBlockIndex].type === 'thinking') {
            contentBlocks[currentBlockIndex].thinking = '';
          }
          break;
        case 'content_block_delta':
          if (event.index >= 0 && contentBlocks[event.index] && event.delta) {
            if (event.delta.type === 'text_delta' && event.delta.text) {
              contentBlocks[event.index].text += event.delta.text;
            } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
              if (typeof contentBlocks[event.index]._inputJson !== 'string') {
                contentBlocks[event.index]._inputJson = '';
              }
              contentBlocks[event.index]._inputJson += event.delta.partial_json;
            } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
              contentBlocks[event.index].thinking += event.delta.thinking;
            } else if (event.delta.type === 'signature_delta' && event.delta.signature) {
              contentBlocks[event.index].signature = event.delta.signature;
            }
          }
          break;
        case 'content_block_stop':
          if (event.index >= 0 && contentBlocks[event.index]) {
            const blk = contentBlocks[event.index];
            if (blk.type === 'tool_use' && typeof blk._inputJson === 'string') {
              try { blk.input = JSON.parse(blk._inputJson); }
              catch { blk.input = blk._inputJson; }
              delete blk._inputJson;
            }
          }
          break;
        case 'message_delta':
          if (message && event.delta) {
            if (event.delta.stop_reason) message.stop_reason = event.delta.stop_reason;
            if (event.delta.stop_sequence !== undefined) message.stop_sequence = event.delta.stop_sequence;
          }
          if (message && event.usage) message.usage = { ...message.usage, ...event.usage };
          break;
      }
    },
    /**
     * Return a snapshot of the current message state.
     * For incomplete tool_use blocks (no content_block_stop yet), input is undefined
     * and _inputJsonPartial carries the raw accumulated string.
     * Deep clones to avoid mutation during live streaming.
     */
    snapshot() {
      if (!message) return null;
      const snapBlocks = [];
      for (let i = 0; i < contentBlocks.length; i++) {
        const b = contentBlocks[i];
        if (!b) continue;
        const clone = { ...b };
        if (b.type === 'tool_use' && typeof b._inputJson === 'string') {
          // Partial JSON - don't parse, expose as raw for UI hint
          clone._inputJsonPartial = b._inputJson;
          clone.input = undefined;
          delete clone._inputJson;
        }
        snapBlocks.push(clone);
      }
      return { ...message, content: snapBlocks };
    },
    hasMessage() { return message !== null; },
  };
}

// 日志文件名前缀【单一来源】：writer（generateNewLogFilePath / initForWorkspace）与 matcher 共用，
// 防止两侧命名漂移。默认 `<project>_`；`--pid` 实例 `<pid>__<project>_`。完整文件名 = `${prefix}${ts}.jsonl`。
export function logFilePrefix(projectName, instanceId) {
  return instanceId ? `${instanceId}__${projectName}_` : `${projectName}_`;
}

// 日志文件名归属判定（实例隔离）。`--pid` 实例文件名为 `<pid>__<project>_<ts>…`，无 pid 为 `<project>_<ts>…`。
//  - instanceId 非空：必须精确以 `<pid>__<project>_` 开头（只认本实例）。
//  - instanceId 空（默认）：以 `<project>_` 开头【且】不含 pid 分隔特征 `__<project>_`。后一条堵住前缀碰撞——
//    若用户把 --pid 取成项目名或 `<项目>_…`（如项目 proj 用 --pid=proj → `proj__proj_…` 也会 startsWith `proj_`），
//    仅靠前缀无法排除；而任何 pid 文件按构造必含 `__<project>_`，无标签文件绝不含（即便项目名自身带 `__`），据此精确排除。
export function logFileMatcher(projectName, instanceId) {
  const p = logFilePrefix(projectName, instanceId);
  if (instanceId) return (f) => f.startsWith(p);
  const pidMark = `__${projectName}_`;
  return (f) => f.startsWith(p) && !f.includes(pidMark);
}

// instanceId 为可选第 3 参（默认 null = 现状）：非空时只在本实例自己的日志里找（多进程隔离），
// 现有 2 参调用方与单测零改动。
export function findRecentLog(dir, projectName, instanceId = null) {
  try {
    const owns = logFileMatcher(projectName, instanceId);
    const files = readdirSync(dir)
      // 排除 *_temp.jsonl：临时文件是未完成的写入态（resume 流程中途产物），
      // 不应被当作"最近完整日志"（否则 _temp 因 sort 排在正式文件之后会被误选）。
      .filter(f => owns(f) && f.endsWith('.jsonl') && !f.endsWith('_temp.jsonl'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    return join(dir, files[0]);
  } catch { }
  return null;
}

// 首启接管（仅 --pid 实例）：本 pid 还没有自己的日志时，把项目里最近的【无标签】日志原子 rename 成
// `<pid>__<project>_<ts>.jsonl`，并入该 pid 血脉（move 而非 copy：不双计入统计）。返回接管后的新路径，或 null。
//
// 这是 best-effort 便利特性，不是核心隔离（核心隔离=各 pid 读自己的日志，不依赖接管）。为不误抢一个仍存活的
// 无 pid 实例（评审标记的 live-writer / 卡在 resume 的窄边角），双重守卫：① 项目里若存在任何无标签 `*_temp.jsonl`
// （某个无 pid 实例正卡在 resume / 在写）→ 放弃；② 无标签日志 mtime 必须早于 freshnessMs(默认 5min)。仍有理论窄缝
// （进程挂起 >5min 且无 temp），属可接受的便利取舍。并发下原子 rename 只一个赢、输者 throw→吞→null（回退全新）。
export function claimUntaggedLog(dir, projectName, instanceId, { freshnessMs = 300000 } = {}) {
  if (!instanceId) return null;
  try {
    const untagged = findRecentLog(dir, projectName, null); // 最近无标签日志（已排除 pid 文件 + temp）
    if (!untagged) return null;
    // ① 存在无标签 temp ⇒ 有无 pid 实例正活动/卡在 resume → 不接管。
    const owns = logFileMatcher(projectName, null);
    const hasUntaggedTemp = readdirSync(dir).some(f => owns(f) && f.endsWith('_temp.jsonl'));
    if (hasUntaggedTemp) return null;
    let st;
    try { st = statSync(untagged); } catch { return null; }
    if (Date.now() - st.mtimeMs < freshnessMs) return null; // ② 可能是活动写者 → 不碰
    const claimed = join(dir, `${instanceId}__${basename(untagged)}`);
    if (existsSync(claimed)) return null;                   // 极端撞名 → 放弃
    renameSyncWithRetry(untagged, claimed);
    return claimed;
  } catch { return null; }
}

export function cleanupTempFiles(dir, projectName, instanceId = null) {
  try {
    const owns = logFileMatcher(projectName, instanceId);
    const tempFiles = readdirSync(dir)
      .filter(f => owns(f) && f.endsWith('_temp.jsonl'));
    for (const f of tempFiles) {
      try {
        const tempPath = join(dir, f);
        const newPath = tempPath.replace('_temp.jsonl', '.jsonl');
        if (existsSync(newPath)) {
          const tempContent = readFileSync(tempPath, 'utf-8');
          if (tempContent.trim()) {
            appendFileSync(newPath, tempContent);
          }
          unlinkSync(tempPath);
        } else {
          // 只有非空 temp 文件才 rename，空文件直接删除
          const sz = statSync(tempPath).size;
          if (sz > 0) {
            renameSyncWithRetry(tempPath, newPath);
          } else {
            unlinkSync(tempPath);
          }
        }
      } catch { }
    }
  } catch { }
}

export function migrateConversationContext(oldFile, newFile) {
  try {
    const content = readFileSync(oldFile, 'utf-8');
    if (!content.trim()) return;

    const parts = content.split('\n---\n').filter(p => p.trim());
    if (parts.length === 0) return;

    let originIndex = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!/"mainAgent"\s*:\s*true/.test(parts[i])) continue;
      try {
        const entry = JSON.parse(parts[i]);
        if (entry.mainAgent) {
          const msgs = entry.body?.messages;
          // Delta storage: 使用 _totalMessageCount（delta 条目）或 msgs.length（旧格式）
          const msgCount = entry._totalMessageCount || (Array.isArray(msgs) ? msgs.length : 0);
          if (msgCount === 1) {
            originIndex = i;
            break;
          }
        }
      } catch { }
    }

    if (originIndex < 0) return;

    let migrationStart = originIndex;
    if (originIndex > 0) {
      try {
        const prevContent = parts[originIndex - 1];
        if (prevContent.trim().startsWith('{')) {
          const prev = JSON.parse(prevContent);
          if (isPreflightEntry(prev)) {
            migrationStart = originIndex - 1;
          }
        }
      } catch { }
    }

    const migratedParts = parts.slice(migrationStart);
    writeFileSync(newFile, migratedParts.join('\n---\n') + '\n---\n');

    const remainingParts = parts.slice(0, migrationStart);
    if (remainingParts.length > 0) {
      writeFileSync(oldFile, remainingParts.join('\n---\n') + '\n---\n');
    } else {
      // 所有内容已迁移到新文件，清空旧文件（不能删除，watcher 需要检测 truncation 来触发轮转）
      writeFileSync(oldFile, '');
    }
  } catch { }
}

/**
 * 计算单条 message 的轻量身份指纹，用于 delta storage 的 in-place last-msg replace 检测。
 * 仅服务端 interceptor 使用 —— 触发 Plan C checkpoint 让客户端拿到 wire 真实内容。
 * 历史上客户端 sessionManager.js 也复用过此算法做 isInPlaceLastMsgReplace 短路，
 * 后被拆除（因 short-circuit 导致 same-ts 多记录被合并）；现单层防御仅靠服务端。
 *
 * 80 字符前缀 + tool_use_id 后 8 字符 + tool_result body 下钻取真实文本（避开 String(array)
 * 塌陷成 "[object Object]" 的 collision 坑）。
 */
export function fingerprintMsg(m) {
  if (!m) return '';
  const c = m.content;
  let snip = '';
  if (Array.isArray(c) && c.length > 0) {
    const f = c[0];
    if (f && typeof f === 'object') {
      if (f.type === 'text') {
        snip = String(f.text || '').slice(0, 80);
      } else if (f.type === 'tool_use') {
        snip = '<tool_use:' + (f.name || '?') + ':' + (f.id || '').slice(-8) + '>';
      } else if (f.type === 'tool_result') {
        let body = '';
        if (typeof f.content === 'string') body = f.content;
        else if (Array.isArray(f.content) && f.content[0]) {
          const cf = f.content[0];
          body = (typeof cf === 'string') ? cf : (cf.text || cf.type || '');
        }
        snip = '<tool_result:' + (f.tool_use_id || '').slice(-8) + ':' + String(body).slice(0, 40) + '>';
      } else {
        snip = '<' + (f.type || '?') + '>';
      }
    }
  } else if (typeof c === 'string') {
    snip = c.slice(0, 80);
  }
  return (m.role || '?') + ':' + snip.replace(/\s+/g, ' ').slice(0, 80);
}

/**
 * Rotate log file when it exceeds maxSize.
 * Creates a new file (no content migration) and appends '\n' to old file
 * to trigger fs.watchFile callback for watcher migration.
 *
 * initialContent (optional) is written INTO the new file at creation time —
 * used for the rotation-context sentinel. It must be baked into creation
 * rather than queued afterwards: the old-file trigger byte below fires the
 * watcher's rotation-follow after a short debounce, and a late-flushing
 * queued write can land between the new file's initial stream read and its
 * lastByteOffset snapshot, in which case it is never delivered to clients.
 *
 * @param {string} currentFile - current log file path
 * @param {string} newFile - new log file path to rotate to
 * @param {number} maxSize - max file size in bytes
 * @param {string} [initialContent] - content the new file is created with
 * @returns {{ rotated: boolean, oldFile?: string, newFile?: string }}
 */
export function rotateLogFile(currentFile, newFile, maxSize, initialContent = '') {
  try {
    if (!existsSync(currentFile)) return { rotated: false };
    const size = statSync(currentFile).size;
    if (size < maxSize) return { rotated: false };
    // 不迁移旧内容，创建新文件（立即创建，避免 watcher 时序窗口）
    try { writeFileSync(newFile, initialContent); } catch { }
    // 触发旧文件 watcher 回调，使其检测到文件变更并切换到新文件
    try { appendFileSync(currentFile, '\n'); } catch { }
    return { rotated: true, oldFile: currentFile, newFile };
  } catch { }
  return { rotated: false };
}

/**
 * 在原始 JSON 字符串上定向替换顶层 "model" 字段的值，避免对巨型 wire body
 * （`-c` 重启后的全量 checkpoint 请求可达数十 MB）做二次 JSON.parse + 全量 re-stringify。
 *
 * 安全性依据：
 * - JSON 字符串值内的引号必然转义为 \"，裸 `"model":"<old>"` 字节序列只能出现在真实结构处；
 * - 候选必须满足成员边界（前一个非空白字符是 `{` 或 `,`）；
 * - 顶层 model 恒存在恒命中 → 嵌套对象若有同值 model 键则候选 ≥2 → 返回 null 由调用方
 *   回退 parse/stringify 旧路径（最坏退化为现状，绝不误改）。
 *
 * @param {string} jsonStr - 原始 wire body（紧凑或带单空格的 JSON 字符串）
 * @param {string} oldModel - 当前顶层 model 值（来自已解析的 body.model）
 * @param {string} newModel - 目标 model 值
 * @returns {string|null} 替换后的字符串；无法唯一定位时返回 null（调用方回退）
 */
export function replaceTopLevelModel(jsonStr, oldModel, newModel) {
  if (typeof jsonStr !== 'string' || typeof oldModel !== 'string' || !oldModel ||
      typeof newModel !== 'string' || !newModel) return null;
  const oldVal = JSON.stringify(oldModel);
  // 覆盖紧凑（JSON.stringify 默认）与冒号后单空格两种序列化形态；其它形态 → 0 候选 → 回退
  const needles = [`"model":${oldVal}`, `"model": ${oldVal}`];
  const candidates = [];
  for (const needle of needles) {
    let idx = jsonStr.indexOf(needle);
    while (idx !== -1) {
      // 成员边界校验：前一个非空白字符必须是 { 或 ,
      let p = idx - 1;
      while (p >= 0 && (jsonStr[p] === ' ' || jsonStr[p] === '\t' || jsonStr[p] === '\n' || jsonStr[p] === '\r')) p--;
      if (p >= 0 && (jsonStr[p] === '{' || jsonStr[p] === ',')) {
        candidates.push({ idx, needle });
      }
      idx = jsonStr.indexOf(needle, idx + 1);
    }
  }
  if (candidates.length !== 1) return null;
  const { idx, needle } = candidates[0];
  const replaced = needle.slice(0, needle.length - oldVal.length) + JSON.stringify(newModel);
  return jsonStr.slice(0, idx) + replaced + jsonStr.slice(idx + needle.length);
}

// proxy profile hot-switch 模型解析：按 request body 里 model 的家族名映射到 profile 的对应字段。
// 家族用**大小写不敏感子串**匹配（/opus/i 等），只认这几个已知家族单词——
// 因此 claude-opus-4-8、未来的 claude-opus-5 等任何版本都命中同一家族，版本升级无需重配。
// 字段直接沿用 Claude Code 的环境变量名以保持一致：
//   ANTHROPIC_MODEL              —— 主模型；body.model 含 "fable" / "mythos" 时映射到它
//   ANTHROPIC_DEFAULT_OPUS_MODEL   —— body.model 含 "opus"
//   ANTHROPIC_DEFAULT_SONNET_MODEL —— 含 "sonnet"
//   ANTHROPIC_DEFAULT_HAIKU_MODEL  —— 含 "haiku"
// 家族字段留空 = 该家族不改写（透传原始 model）。
// 未识别家族（既不是 opus/sonnet/haiku 也不是 fable/mythos）不做兜底替换，原样透传。
// 兼容旧数据：profile 未设任何新字段但有 activeModel（老结构）时，回退为旧的整体替换语义。
// 返回目标模型字符串；无需改写（无目标 / 目标同旧值 / 入参非法 / 未识别家族）时返回 null。
export function resolveProfileModel(oldModel, profile) {
  if (typeof oldModel !== 'string' || !oldModel || !profile || typeof profile !== 'object') return null;
  const opus = typeof profile.ANTHROPIC_DEFAULT_OPUS_MODEL === 'string' ? profile.ANTHROPIC_DEFAULT_OPUS_MODEL.trim() : '';
  const sonnet = typeof profile.ANTHROPIC_DEFAULT_SONNET_MODEL === 'string' ? profile.ANTHROPIC_DEFAULT_SONNET_MODEL.trim() : '';
  const haiku = typeof profile.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'string' ? profile.ANTHROPIC_DEFAULT_HAIKU_MODEL.trim() : '';
  const primary = typeof profile.ANTHROPIC_MODEL === 'string' ? profile.ANTHROPIC_MODEL.trim() : '';
  const hasNew = !!(primary || opus || sonnet || haiku);

  let target = '';
  if (hasNew) {
    if (/opus/i.test(oldModel)) target = opus;
    else if (/sonnet/i.test(oldModel)) target = sonnet;
    else if (/haiku/i.test(oldModel)) target = haiku;
    else if (/fable/i.test(oldModel) || /mythos/i.test(oldModel)) target = primary; // 显式家族 → 主模型
    // 未识别家族：target 保持 ''，下方返回 null（不替换、原样透传）
  } else if (typeof profile.activeModel === 'string') {
    target = profile.activeModel.trim(); // 旧数据整体替换语义
  }

  if (!target || target === oldModel) return null;
  return target;
}

// 旧配置迁移：老 profile 用 { models:[], activeModel } 做整体替换（不分家族，所有请求都换成
// activeModel）。新方案改用 ANTHROPIC_MODEL + 三个家族字段。为**忠实保留**旧的整体替换语义，
// 把 activeModel 填入全部四个模型字段（仅填空缺项，不覆盖用户已设值），这样 opus/sonnet/haiku/
// fable 各家族都仍命中同一模型；用户之后可在 UI 里按需拆分。丢弃遗留的 models / activeModel。
// 幂等：无遗留字段时原样返回、changed=false。纯函数，不落盘；调用方决定是否持久化。
export function migrateProxyProfile(p) {
  if (!p || typeof p !== 'object') return { profile: p, changed: false };
  const hasLegacy = ('activeModel' in p) || ('models' in p);
  if (!hasLegacy) return { profile: p, changed: false };
  const { models: _drop1, activeModel, ...rest } = p;
  const out = { ...rest };
  const am = typeof activeModel === 'string' ? activeModel.trim() : '';
  if (am) {
    // 保留整体替换：四个字段都回填 activeModel（已有值不动）
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
      if (!out[k]) out[k] = am;
    }
  }
  return { profile: out, changed: true };
}

// 迁移整份 profiles 列表；返回 { profiles, changed }（任一 profile 变更即 changed=true）。
export function migrateProxyProfileList(profiles) {
  if (!Array.isArray(profiles)) return { profiles, changed: false };
  let changed = false;
  const migrated = profiles.map(p => {
    const r = migrateProxyProfile(p);
    if (r.changed) changed = true;
    return r.profile;
  });
  return { profiles: migrated, changed };
}

// proxy profile hot-switch 支持强制 output_config.effort（对应 CLAUDE_CODE_EFFORT_LEVEL）。
// 与 replaceTopLevelModel 同源思路：常见路径（body 里没有 output_config）走定向前插，
// 避免对多 MB wire body 做 JSON.parse + 全量 re-stringify（-c 重启后 checkpoint 可达数十 MB）。
//   - 前插：在顶层对象开括号 `{` 之后插入 `"output_config":{"effort":"<v>"}`（后跟逗号，除非对象为空）。
//     顶层永远以 `{` 开头，插入后仍是合法 JSON；且 JSON 重复键"后者胜"，但此路径仅在
//     调用方确认 body 无 output_config 时启用，不会产生重复键。
//   - 合并：body 已有 output_config（罕见，如 CLI 传了 --effort）时回退整体 parse/stringify，
//     把 effort 并入既有对象。此路径 O(n) 但极少触发，可接受。
// effort 值域受限（low/medium/high/xhigh/max），非法值 → null（调用方跳过注入）。
const _VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
export function injectOutputConfigEffort(jsonStr, effort, hasOutputConfig) {
  if (typeof jsonStr !== 'string' || !jsonStr) return null;
  if (typeof effort !== 'string' || !_VALID_EFFORTS.has(effort)) return null;
  if (hasOutputConfig) {
    // 已有 output_config：整体 parse/stringify 合并，保留既有子字段
    try {
      const obj = JSON.parse(jsonStr);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
      if (!obj.output_config || typeof obj.output_config !== 'object' || Array.isArray(obj.output_config)) {
        obj.output_config = {};
      }
      obj.output_config.effort = effort;
      return JSON.stringify(obj);
    } catch { return null; }
  }
  // 无 output_config：定向前插
  const i = jsonStr.indexOf('{');
  if (i === -1) return null;
  // 顶层必须是对象：`{` 之前只允许空白，排除顶层数组（如 `[{...}]`）等把首个 `{` 误当顶层的情形。
  // 与合并路径的 Array.isArray 守卫对称。真实 /v1/messages body 恒为顶层对象。
  if (/\S/.test(jsonStr.slice(0, i))) return null;
  // 探测开括号后的首个非空白字符：若是 `}`（空对象）则不追加逗号，避免尾逗号非法 JSON
  const after = jsonStr.slice(i + 1);
  const m = after.match(/^\s*(\S)/);
  const needsComma = !!(m && m[1] !== '}');
  const insert = `"output_config":{"effort":${JSON.stringify(effort)}}` + (needsComma ? ',' : '');
  return jsonStr.slice(0, i + 1) + insert + jsonStr.slice(i + 1);
}
