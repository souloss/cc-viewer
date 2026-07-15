// SSE event stream + log-registration / resume / turn-end routes (moved verbatim from server.js).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _projectName, getLiveLogSource, isContinuedLaunch } from '../interceptor.js';
import { LOG_DIR } from '../../findcc.js';
import { streamRawEntriesAsync } from '../lib/log-stream.js';
import { migrationStatus } from '../lib/v2/migrate-prompt.js';
import { reportSwallowed } from '../lib/error-report.js';
import { awaitDrainOrClose } from '../lib/sse-backpressure.js';
import { enrichRawIfNeeded } from '../lib/enrich-plan-input.js';
import { validateLogPath } from '../lib/log-management.js';
import { isMainAgentEntry, extractCachedContent } from '../lib/kv-cache-analyzer.js';
import { CONTEXT_WINDOW_FILE, readModelContextSize, buildContextWindowEvent, getContextSizeForModel } from '../lib/context-watcher.js';
import { adaptContextWindow } from '../lib/context-rules.js';

function turnEndNotify(req, res, parsedUrl, isLocal, deps) {
  if (!isLocal) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Loopback only' }));
    return;
  }
  if (req.headers['x-ccviewer-internal'] !== deps.INTERNAL_TOKEN) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid bridge token' }));
    return;
  }
  let body = '';
  let truncated = false;
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 16384) { truncated = true; req.destroy(); }
  });
  req.on('end', () => {
    if (truncated) {
      console.warn('[turn-end-notify] body exceeded 16KB cap — request destroyed');
      return; // socket already closed by destroy()
    }
    let payload = {};
    let badJson = false;
    try { payload = body ? JSON.parse(body) : {}; }
    catch { badJson = true; console.warn('[turn-end-notify] malformed JSON body'); }
    if (badJson) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'malformed JSON body' }));
      return;
    }
    deps.scheduleTurnEndBroadcast(payload.sessionId || null, payload.ts || Date.now(), payload.transcriptPath || null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

// SSE endpoint
// 构造「有新版」徽标的 SSE 帧（pending = {version, source}）。pending 为空返回 null。
// 抽成纯函数便于单测帧格式；events() 在新连接上调用它补推，使版本徽标跨刷新持续显示。
export function sseUpdateBadgeFrame(pending) {
  return pending
    ? `event: update_major_available\ndata: ${JSON.stringify(pending)}\n\n`
    : null;
}

async function events(req, res, parsedUrl, isLocal, deps) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // 注意：不要在此处 clients.push(res)！
  // 必须等 load_end + kv_cache + context_window 全部发送完毕后再加入广播列表，
  // 否则 streamRawEntriesAsync 的 setImmediate yield 间隙会让 watcher 的
  // sendToClients 向该客户端推送 live entry，而 load_end 的 setState 会覆盖这些
  // 已处理的 live entry，导致 对话条目"显示→消失→重现"闪烁。

  // SSE 心跳保活：每 30s 发送 ping 事件，防止连接被 OS/代理/浏览器静默断开
  const pingTimer = setInterval(() => {
    try { res.write('event: ping\ndata: {}\n\n'); } catch {}
  }, 30000);

  // server_config: 给前端推一次性的关键运行时常量，让前端 cooldown / debounce 等
  // 模块常量能跟随 server env 自动对齐（避免「server 改了 env、前端写死」漂移）。
  // 见 server.js 顶部 turnEnd debounce 的 SUNSET-MARKER 注释。
  // write 失败要 warn：之前静默吞会让 env override 漂移到前端硬常量 10s 而无人发觉。
  try {
    res.write(`event: server_config\ndata: ${JSON.stringify({ turnEndDebounceMs: deps.turnEndDebounceMs })}\n\n`);
  } catch (err) {
    console.warn(`[server_config] SSE write failed (turnEndDebounceMs=${deps.turnEndDebounceMs}):`, err && err.message);
  }

  // 补推「有新版」徽标：复用启动检查缓存的结果，让刷新/新标签页连上即恢复徽标。
  // 置于 deps.clients.push(res) 之前 → 新客户端仅得一份，不与一次性广播竞态。
  const updFrame = sseUpdateBadgeFrame(deps.pendingMajorUpdate);
  if (updFrame) res.write(updFrame);

  // 1.7.0 迁移引导（P2）：当前项目仍有未转换的 v1 日志 → 连接即推 migrate_prompt。
  // 是否弹窗由客户端决定（「不再提醒」偏好在客户端；continued=true 时无视 dismissed
  // 再提醒一次——`-c` 续接的对话前半段在旧格式里，不迁移就看不到）。工作区切换后的
  // 提示由 workspaces launch 路由对存量连接广播（本帧只覆盖新连接）。
  try {
    const mig = migrationStatus(LOG_DIR, _projectName || '');
    if (mig.pending) {
      res.write(`event: migrate_prompt\ndata: ${JSON.stringify({ ...mig, continued: isContinuedLaunch() })}\n\n`);
    }
  } catch (e) { reportSwallowed('sse.migrate_prompt', e); }

  // 增量加载参数：移动端带 since/cc/project 请求增量数据
  const sinceParam = parsedUrl.searchParams.get('since');
  const ccParam = parseInt(parsedUrl.searchParams.get('cc'), 10) || 0;
  const projectParam = parsedUrl.searchParams.get('project');
  const projectMatch = !projectParam || projectParam === (_projectName || '');
  const useIncremental = !!(sinceParam && ccParam > 0 && projectMatch && !isNaN(new Date(sinceParam).getTime()));

  // 分页参数：
  // - mobile 首次加载传 ?limit=200
  // - bare desktop 请求（无任何 query 参数）默认套 DEFAULT_EVENTS_LIMIT
  // - 显式 ?limit=0 表示"我要全量"（保留旧行为入口）
  const limitParamRaw = parsedUrl.searchParams.get('limit');
  const limitParamGiven = limitParamRaw !== null;
  const limitParamNum = parseInt(limitParamRaw, 10);
  let effectiveLimit = 0;
  if (!useIncremental) {
    if (limitParamGiven) {
      effectiveLimit = Number.isFinite(limitParamNum) && limitParamNum > 0 ? limitParamNum : 0;
    } else {
      effectiveLimit = deps.DEFAULT_EVENTS_LIMIT;
    }
  }
  const useLimit = effectiveLimit > 0;

  // KV-Cache / context_window 追踪（扫描全量条目，不受 since 过滤影响）
  let latestKvCache = null;
  let latestContextWindow = null;
  let pushedContextWindow = false;
  // 只记忆最后 K 条 mainAgent 候选原始字符串，Pass 1 结束后 newest-first 结构化校验
  // （isMainAgentEntry），最多 parse K 次。旧逻辑在 onScan 里对每条 mainAgent raw 全量
  // JSON.parse —— `-c` 大会话日志里多个数十 MB 的 checkpoint 会让每次 SSE 连接阻塞
  // event loop 数秒（Windows 卡死主因之一）。
  // ring=3 的容错意义：团队会话末尾常有连续 teammate 伪 mainAgent 条目，单记忆位会被
  // 挤掉真实 mainAgent；子串预过滤的理论误伤（键/值恰为 "teammate" 的真实条目）也由
  // 环内更早候选兜底。
  // KEEP IN SYNC: server/lib/v2/adapter.js MAINAGENT_RING_DEPTH — on the v2 path
  // the adapter's mainAgentRing (that depth) wholesale REPLACES this ring, so a
  // mismatch would silently give v1 and v2 sessions different candidate depths.
  const MAINAGENT_SCAN_RING = 3;
  const mainAgentRawRing = [];

  // S6b: the cold-load source is the current v2 session dir when the v2
  // writer is active (adapter stream), else the v1 file.
  const coldLoadResult = await streamRawEntriesAsync(getLiveLogSource(), async (raw) => {
    // 直接发送原始 JSON 字符串，不做 parse/reconstruct/stringify
    // ExitPlanMode V2 空 input 的条目按需补全 plan / planFilePath，其它原样透传
    if (res.destroyed || !res.writable) return;
    const out = enrichRawIfNeeded(raw);
    // SSE data 字段不允许裸换行，去除 pretty-printed JSON 的换行
    // 写入路径整体 try-catch 兜底：连接在 res.write 之间被对端 RST/destroy 时不至于
    // 把 EPIPE 抛穿 async callback；res.on('close'|'error') 已会做 clients 数组清理。
    let drained = true;
    try {
      res.write('event: load_chunk\ndata: [');
      drained = res.write(out.includes('\n') ? out.replace(/\n/g, '') : out);
      res.write(']\n\n');
    } catch {
      return;
    }
    // 写缓冲满则等 drain（或 close/error/超时任一 fulfill），防止浏览器侧 renderer OOM。
    // helper 内部会在 fulfill 时把另外两个监听器从 res 上摘掉，避免 N 次 backpressure
    // 累积出 N 个 stale close/error listener 触发 MaxListenersExceededWarning。
    if (!drained) {
      await awaitDrainOrClose(res, deps.SSE_BACKPRESSURE_TIMEOUT_MS);
    }
  }, {
    since: useIncremental ? sinceParam : undefined,
    limit: useLimit ? effectiveLimit : undefined,
    onScan: (raw) => {
      // 只做子串检测 + 入环，不 parse（巨型 checkpoint 逐条 parse 会阻塞 event loop）。
      // teammate 条目恒带 "teammate" 字段，子串预过滤减少环污染；结构化判定留给
      // Pass 1 结束后的 newest-first 校验（isMainAgentEntry），预过滤误伤由环容错。
      if ((raw.includes('"mainAgent":true') || raw.includes('"mainAgent": true')) &&
          !raw.includes('"teammate"')) {
        mainAgentRawRing.push(raw);
        if (mainAgentRawRing.length > MAINAGENT_SCAN_RING) mainAgentRawRing.shift();
      }
    },
    onReady: ({ totalCount, hasMore, oldestTs }) => {
      // Pass 1 完成、Pass 2 开始前：发送 load_start
      // 增量模式下不显示 loading 遮罩，非增量模式显示进度
      const loadStartData = { total: totalCount, incremental: !!useIncremental };
      // 分页模式下附加 hasMore/oldestTs（增量模式由客户端从缓存自行判断）
      if (useLimit) {
        loadStartData.hasMore = !!hasMore;
        loadStartData.oldestTs = oldestTs || '';
      }
      res.write(`event: load_start\ndata: ${JSON.stringify(loadStartData)}\n\n`);
    },
  });

  res.write(`event: load_end\ndata: {}\n\n`);

  // S10a: v2 sources no longer invoke onScan (the two-pass window never
  // stringifies out-of-window entries) — the adapter returns the newest-main
  // raws as `mainAgentRing` instead. v1 sources still fill the ring via onScan.
  if (Array.isArray(coldLoadResult?.mainAgentRing) && coldLoadResult.mainAgentRing.length > 0) {
    mainAgentRawRing.length = 0;
    mainAgentRawRing.push(...coldLoadResult.mainAgentRing);
  }

  // Pass 1 入环的候选 newest-first 校验 + parse（≤K 次）。kv_cache 与 context_window
  // 各自取"最新一条能提供该值的真实 mainAgent"—— 与旧版逐条覆盖语义等价（环深度内）。
  for (let ri = mainAgentRawRing.length - 1; ri >= 0 && (!latestKvCache || !latestContextWindow); ri--) {
    try {
      const entry = JSON.parse(mainAgentRawRing[ri]);
      if (!isMainAgentEntry(entry)) continue;
      if (!latestKvCache) {
        const cached = extractCachedContent(entry);
        if (cached) latestKvCache = cached;
      }
      if (!latestContextWindow) {
        const usage = entry.response?.body?.usage;
        if (usage) {
          const contextSize = getContextSizeForModel(entry.body?.model);
          const cw = buildContextWindowEvent(usage, contextSize);
          if (cw) latestContextWindow = cw;
        }
      }
    } catch { }
  }

  // 发送最新 MainAgent 的 KV-Cache 和 context_window
  if (latestKvCache) {
    res.write(`event: kv_cache_content\ndata: ${JSON.stringify(latestKvCache)}\n\n`);
  }
  if (latestContextWindow) {
    res.write(`event: context_window\ndata: ${JSON.stringify(latestContextWindow)}\n\n`);
    pushedContextWindow = true;
  }
  // Fallback: no MainAgent in log (e.g. fresh session after -c), read context-window.json
  if (!pushedContextWindow) {
    try {
      const cwRaw = readFileSync(CONTEXT_WINDOW_FILE, 'utf-8');
      const cwFile = JSON.parse(cwRaw);
      if (cwFile?.context_window) {
        // Recalculate with correct context size from model.id
        const { contextSize } = readModelContextSize();
        const cw = cwFile.context_window;
        const inputTokens = cw.total_input_tokens || 0;
        const outputTokens = cw.total_output_tokens || 0;
        const totalTokens = inputTokens + outputTokens;
        // 自适应纠偏:与 buildContextWindowEvent 同源(context-rules.adaptContextWindow),
        // 避免这条 fallback 与已纠偏的主路径产出不一致的血条。
        const effectiveSize = adaptContextWindow(contextSize, inputTokens);
        const usedPct = effectiveSize > 0 ? Math.round((totalTokens / effectiveSize) * 100) : 0;
        const data = { ...cw, context_window_size: effectiveSize, used_percentage: usedPct, remaining_percentage: 100 - usedPct };
        res.write(`event: context_window\ndata: ${JSON.stringify(data)}\n\n`);
      }
    } catch { }
  }

  // 历史数据 + KV-Cache + context_window 全部发送完毕后，才将客户端加入广播列表。
  // 这样 watcher 的 sendToClients 不会在 load 阶段向该客户端推送 live entry。
  deps.clients.push(res);

  // req.on('close') 在某些异常断连时不一定立即触发；res 端 close/error 兜底保证
  // 不会在 clients 数组里留下幽灵 res，防止 sendToClients 后续写入触发慢泄漏。
  const removeFromClients = () => {
    clearInterval(pingTimer);
    const idx = deps.clients.indexOf(res);
    if (idx !== -1) deps.clients.splice(idx, 1);
  };
  req.on('close', removeFromClients);
  res.on('close', removeFromClients);
  res.on('error', removeFromClients);
}

// API endpoint
async function requests(req, res) {
  // 异步流式 JSON 数组输出，不做 reconstruct，发原始条目
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.write('[');
  let first = true;
  await streamRawEntriesAsync(getLiveLogSource(), (raw) => {
    if (!first) res.write(',');
    res.write(enrichRawIfNeeded(raw));
    first = false;
  });
  res.write(']');
  res.end();
}

export const eventsRoutes = [
  { method: 'POST', match: 'exact', path: '/api/turn-end-notify', handler: turnEndNotify },
  { method: 'GET', match: 'exact', path: '/events', handler: events },
  { method: 'GET', match: 'exact', path: '/api/requests', handler: requests },
];
