// CLIENT-SAFE: no node deps. Imported by src/ — do not add fs/process/node: imports.
//
// 上下文窗口规则唯一事实源(前后端同源):
//   - 服务端:server/lib/context-watcher.js、server/routes/events.js 直接 import
//   - 前端:src/utils/helpers.js thin re-export(经 Vite 跨目录打包,先例见 tools-xml-formatter.js)
// 此前规则散落三处(前端 MODEL_CONTEXT_SIZES / _classifyContextSize、服务端 getContextSizeForModel)
// 且已漂移(服务端不认识 deepseek-v4),收编于此后任何档位变更只改这一个文件。
//
// 关键有意决策:裸 claude-sonnet-4-6(无 [1m] 后缀)按 200K 而非 API 规格表的 1M ——
// 与 Claude Code 选模型的默认行为一致([1m] 是用户显式 opt-in);若实际跑在 1M 模式,
// 由 [1m] 后缀规则或 adaptContextWindow 用量纠偏兜底,血条不会卡死在 100%。

// [Nk]/[Nm] 显式窗口后缀,如 claude-fable-5[1m]、claude-sonnet-4-6[200k]、[500k]。
// 显式 opt-in 优先级最高,胜过一切家族规则。
const SIZE_SUFFIX_RE = /\[(\d+)([km])\]/i;

/**
 * 解析模型名里的 [Nk]/[Nm] 窗口后缀。
 * @param {string} modelName
 * @returns {number|null} 解析出的窗口 token 数,无后缀返回 null
 */
export function parseContextSizeSuffix(modelName) {
  if (!modelName || typeof modelName !== 'string') return null;
  const m = modelName.match(SIZE_SUFFIX_RE);
  if (!m) return null;
  const num = parseInt(m[1], 10);
  return m[2].toLowerCase() === 'm' ? num * 1000000 : num * 1000;
}

// 模型家族 → 窗口档位表(有序,首条命中)。后缀解析在表外先行(见 getModelMaxTokens)。
const MODEL_CONTEXT_SIZES = [
  // haiku 全系 200K,显式置于一切 1M 默认之前(claude-haiku-4-5 等)
  { match: /haiku/i, tokens: 200000 },
  // 旧 Opus 修正:opus-4-0 / opus-4-1 / opus-4-5 实为 200K(opus-4-6 起才 1M)。
  // (?!\d) 防误吞 opus-4-15 这类未来版本号;分隔符兼容连字符/点/空格。
  { match: /opus[ -]?4[-. ][015](?!\d)/i, tokens: 200000 },
  // claude-3-opus(3-opus / opus-3 两种写法)实为 200K
  { match: /3[-.]opus|opus[-.]3/i, tokens: 200000 },
  // 其余 Opus(4-6 起与未来版本)默认 1M
  { match: /opus/i, tokens: 1000000 },
  // mythons 默认 1M(置于 /claude/ 之前,避免被抢成 200K)
  { match: /mythons/i, tokens: 1000000 },
  // fable-5 家族(fable-5 / fable-5.x / fable-5-x)默认 1M,同样须排在 /claude/ 之前
  { match: /fable[ -]5/i, tokens: 1000000 },
  // 有意为之:裸 claude-sonnet-4-6(无 [1m] 后缀)维持 200K,与 Claude Code 选模型的
  // 默认行为一致([1m] 是显式 opt-in);真 1M 场景靠后缀或 adaptContextWindow 纠偏兜底。
  { match: /claude/i, tokens: 200000 },
  { match: /gpt-4o|o1|o3|o4/i, tokens: 128000 },
  { match: /gpt-4/i, tokens: 128000 },
  { match: /gpt-3/i, tokens: 16000 },
  // deepseek-v4 defaults to 1M; placed before generic /deepseek/ so the
  // first-match-wins loop picks it up before falling through to 128K.
  { match: /deepseek-v4/i, tokens: 1000000 },
  { match: /deepseek/i, tokens: 128000 },
];

/**
 * 模型名 → 上下文窗口 token 数。后缀优先,其次家族档位表,默认 200K。
 * @param {string|null|undefined} modelName
 * @returns {number}
 */
export function getModelMaxTokens(modelName) {
  if (!modelName) return 200000;
  const suffix = parseContextSizeSuffix(modelName);
  if (suffix) return suffix;
  for (const entry of MODEL_CONTEXT_SIZES) {
    if (entry.match.test(modelName)) return entry.tokens;
  }
  return 200000;
}

/**
 * 校准二分类:名字 → 1M/200K(血条 calibration 'auto' 路径专用)。
 * 不变量:只返回 1000000 或 200000(resolveCalibrationTokens 依赖此不变量)。
 * 裸 '1m' 子串(无方括号,如 deepseek-v3-1m)→ 1M 的宽松规则仅限本分类器,
 * 刻意不进 getModelMaxTokens(后者面向精确档位)。128K/16K 档归入 200K 桶。
 * @param {string} modelName
 * @returns {1000000|200000}
 */
export function classifyContextWindow(modelName) {
  if (!modelName || typeof modelName !== 'string') return 200000;
  if (modelName.toLowerCase().includes('1m')) return 1000000;
  return getModelMaxTokens(modelName) >= 1000000 ? 1000000 : 200000;
}

/**
 * 血条自适应纠偏:把"分类器判出的上下文窗口"按真实用量修正。
 * 一个真正的 200K 模型,其输入上下文(input + cache_creation + cache_read)物理上不可能
 * 超过 200K —— 超了 API 直接拒收。所以一旦真实输入用量越过 200K 还被判成 200K,必然是
 * model 名识别错了(误判),此时自动升到 1M,免得血条卡死在 100%、百分比与真实进度脱节。
 * 仅做 200K→1M 这一个方向的纠偏;其余判定(1M、各家 200K 真值等)一律原样返回。
 * 注意:usedContextTokens 必须是"输入侧"用量(sumUsageInputTokens,不含 output_tokens),
 * 否则大输出会误触发。
 * @param {number} classifiedTokens classifyContextWindow / getModelMaxTokens 的结果
 * @param {number} usedContextTokens 当前输入上下文实际用量(input + cache_creation + cache_read)
 * @returns {number} 修正后的上下文窗口 token 数(1000000 或原值)
 */
export function adaptContextWindow(classifiedTokens, usedContextTokens) {
  if (classifiedTokens === 200000 && usedContextTokens > 200000) return 1000000;
  return classifiedTokens;
}

/**
 * cache_creation 兼容求和:flat 字段(cache_creation_input_tokens)存在(非 null/undefined,
 * 0 也算存在)直接用;缺失时回落到新版嵌套对象 usage.cache_creation 的各 TTL 分桶求和
 * (ephemeral_5m_input_tokens + ephemeral_1h_input_tokens,未来新增分桶自动计入)。
 * @param {object|null|undefined} usage API usage 对象
 * @returns {number}
 */
export function sumCacheCreationTokens(usage) {
  if (!usage) return 0;
  if (usage.cache_creation_input_tokens != null) return usage.cache_creation_input_tokens || 0;
  const nested = usage.cache_creation;
  if (nested && typeof nested === 'object') {
    let sum = 0;
    for (const v of Object.values(nested)) {
      if (typeof v === 'number' && Number.isFinite(v)) sum += v;
    }
    return sum;
  }
  return 0;
}

/**
 * 输入侧上下文用量(不含 output_tokens)。用于自适应纠偏判定。
 * @param {object|null|undefined} usage
 * @returns {number}
 */
export function sumUsageInputTokens(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) + sumCacheCreationTokens(usage) + (usage.cache_read_input_tokens || 0);
}

/**
 * 血条分子统一口径:输入侧 + 末轮 output_tokens,对齐 Claude Code /context 的
 * "当前上下文占用"语义(末轮回复已进入下一轮上下文)。
 * @param {object|null|undefined} usage
 * @returns {number}
 */
export function sumUsageContextTokens(usage) {
  if (!usage) return 0;
  return sumUsageInputTokens(usage) + (usage.output_tokens || 0);
}
