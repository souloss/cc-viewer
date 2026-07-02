// AskUserQuestion options[].description is schema-optional; centralize fallback
// so AskQuestionForm and ChatMessage recap stay aligned.

export function optionAriaLabel(opt) {
  if (!opt || opt.label == null) return '';
  return opt.description
    ? `${opt.label}: ${opt.description}`
    : String(opt.label);
}

export function hasOptionDescription(opt) {
  return Boolean(opt && opt.description);
}

// 选出 AskUserQuestion 交互卡片实际要渲染的 questions。
//
// 弹窗 body 由内联 tool_use 块（从日志流重建）portal 进 modal askSlot 填充，而不是直接读
// pendingAsk.questions（WS ask-hook-pending 下发、server 端已完整解析的权威副本）。streaming
// 期间大 payload（如多问题）会有一段窗口：modal 已经因 hook 弹起，但流式重建出的块 input 尚未
// 到 content_block_stop、还是未解析的部分 JSON 字符串 → 派生 questions 为空 → 弹窗空白（用户
// 只能去终端里拒绝，这正是 2026-07-02 多问题 ask 被拒的根因）。
//
// 兜底：仅当这是「当前 pending 的那条 ask」(toolId === lastPendingAskId) 且权威 questions 更完整
// （streamed 为空 / 更短）时，用权威副本。历史里已解析完整的块 toolId 不等于 lastPendingAskId，
// 或权威副本不更长时，一律沿用 streamed —— 不改历史视图行为，零回归。
export function resolveAskQuestions(streamedQuestions, toolId, lastPendingAskId, pendingAsk) {
  const streamed = Array.isArray(streamedQuestions) ? streamedQuestions : [];
  if (!pendingAsk || toolId == null || pendingAsk.id !== toolId || toolId !== lastPendingAskId) {
    return streamed;
  }
  const authoritative = Array.isArray(pendingAsk.questions) ? pendingAsk.questions : [];
  return authoritative.length > streamed.length ? authoritative : streamed;
}
