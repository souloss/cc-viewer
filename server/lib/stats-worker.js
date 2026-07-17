// Stats Worker — background thread generating per-project stats JSON.
// wire-v2 (1.7.0): the scan unit is a v2 SESSION DIRECTORY — usage/model come
// from journal req/done lines, previews from main-conversation event slices;
// nothing goes through the adapter (a full replay per tick would be pure
// waste, review P1). Legacy v1 *.jsonl files are no longer counted — their
// numbers return once the user migrates (ccv convert / the migrate prompt).
import { parentPort } from 'node:worker_threads';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { readJsonlTolerant, listSessionIds } from './v2/replay.js';
import { dirSizeSync } from './v2/layout.js';
import { isDiscardableSession } from './v2/session-select.js';
import { reportSwallowed } from './error-report.js';
import {
  INTER_SESSION_TYPES, isSystemText, extractUserTexts, isSuggestionMode,
  collectPromptsFromEvents, sortEpochFiles,
} from './user-prompt-extract.js';

// Prompt/preview extraction moved to the shared server/lib/user-prompt-extract.js
// (also feeds the V2Writer prompts.jsonl cache and the log-list read side).
// Re-exported here so existing importers/tests keep working.
export { INTER_SESSION_TYPES, isSystemText, extractUserTexts };

// 统计 schema 版本号，新增统计字段时递增，强制旧缓存失效重新解析
// v9: v2 session-dir units (files map keyed `sessions/<sid>`), journal-based counts
// v10: per-session `size` = recursive session-dir bytes (was journal-only);
//      `journalSize` carries the incremental-cache key
// v11: discardable sessions (quota-probe orphans) excluded — the bump
//      invalidates pre-discard caches so their probe units can't be reused
//      back into filesStats, which lets the discard check sit AFTER the
//      cache-reuse branch (cache hits skip the journal head scan entirely)
const STATS_VERSION = 11;

/**
 * Parse one v2 session directory into the same stats shape parseJsonlFile
 * produced for a v1 file.
 *
 * Sources (all cheap, content-free except previews):
 * - journal req lines → requestCount, per-model counts, main-turn tracking
 *   inputs (kind/msgTo/epoch/seq);
 * - journal done lines (folded first-wins per §14) → per-model token usage;
 * - conversations/main/e<N>.jsonl event slices → user-prompt previews +
 *   SUGGESTION MODE detection (append slices carry exactly the new messages,
 *   so no prevTextCount bookkeeping is needed; snapshot repeats are absorbed
 *   by the preview dedup set).
 * @param {string} sessionDir absolute session directory
 * @returns {{ models: Object, summary: Object, preview: string[] }}
 */
function parseSessionDir(sessionDir) {
  const models = {};
  let requestCount = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;

  const reqs = new Map(); // seq → req line
  const doneSeqs = new Set();
  for (const line of readJsonlTolerant(join(sessionDir, 'journal.jsonl'))) {
    if (line.ph === 'req') {
      if (reqs.has(line.seq)) continue;
      reqs.set(line.seq, line);
      requestCount++;
      const model = line.model;
      if (model) {
        if (!models[model]) {
          models[model] = { count: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        }
        models[model].count++;
      }
    } else if (line.ph === 'done' && !doneSeqs.has(line.seq)) {
      doneSeqs.add(line.seq);
      const usage = line.usage;
      if (!usage) continue;
      const req = reqs.get(line.seq);
      const model = req && req.model;
      const inp = usage.in || 0;
      const out = usage.out || 0;
      const cacheRead = usage.cr || 0;
      const cacheCreate = usage.cw || 0;
      if (model && models[model]) {
        models[model].input_tokens += inp;
        models[model].output_tokens += out;
        models[model].cache_read_input_tokens += cacheRead;
        models[model].cache_creation_input_tokens += cacheCreate;
      }
      totalInput += inp;
      totalOutput += out;
      totalCacheRead += cacheRead;
      totalCacheCreation += cacheCreate;
    }
  }

  // Main-conversation event slices: previews + suggestion-mode seqs. The
  // fold itself lives in the shared collectPromptsFromEvents; the suggestion
  // seq set is a stats-only concern, gathered in the same pass.
  const suggestionSeqs = new Set();
  const acc = {};
  const mainConvDir = join(sessionDir, 'conversations', 'main');
  if (existsSync(mainConvDir)) {
    let epochFiles = [];
    try {
      epochFiles = sortEpochFiles(readdirSync(mainConvDir));
    } catch { /* unreadable conv dir — counts still stand */ }
    for (const f of epochFiles) {
      const events = readJsonlTolerant(join(mainConvDir, f));
      for (const ev of events) {
        if (Array.isArray(ev.msgs) && ev.msgs.length > 0 && isSuggestionMode(ev.msgs)) suggestionSeqs.add(ev.seq);
      }
      collectPromptsFromEvents(events, acc);
    }
  }
  const preview = acc.out || [];

  // Turn/session tracking over main req lines — the v1 wire-growth formula,
  // driven by journal msgTo counts instead of message arrays.
  let turnCount = 0;
  let maxMsgLen = 0;
  const epochs = new Set();
  const mainSeqs = [...reqs.values()]
    .filter(r => r.kind === 'main' && typeof r.msgTo === 'number')
    .sort((a, b) => a.seq - b.seq);
  for (const r of mainSeqs) {
    if (suggestionSeqs.has(r.seq)) continue;
    if (typeof r.epoch === 'number') epochs.add(r.epoch);
    const len = r.msgTo;
    if (len < maxMsgLen * 0.5 && (maxMsgLen - len) > 4) maxMsgLen = 0; // /clear-style shrink
    if (len > maxMsgLen) {
      maxMsgLen = len;
      turnCount++;
    }
  }

  return {
    models,
    summary: {
      requestCount,
      sessionCount: epochs.size,
      turnCount,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cache_read_input_tokens: totalCacheRead,
      cache_creation_input_tokens: totalCacheCreation,
    },
    preview,
  };
}

/**
 * 为单个项目生成或增量更新统计 JSON
 * @param {string} projectDir 项目日志目录
 * @param {string} projectName 项目名
 * @param {string|null} onlyFile 仅更新此文件（增量），null 表示智能增量
 */
function generateProjectStats(projectDir, projectName, onlyFile) {
  const statsFile = join(projectDir, `${projectName}.json`);

  // 读取已有统计（用于增量更新）
  let existing = null;
  try {
    if (existsSync(statsFile)) {
      existing = JSON.parse(readFileSync(statsFile, 'utf-8'));
    }
  } catch {
    existing = null;
  }

  // Scan units = v2 session dirs. The cache key is the journal's size+mtime:
  // every request/completion appends journal lines, so any change moves it.
  const sessionIds = listSessionIds(projectDir).sort();
  if (sessionIds.length === 0) return;

  const filesStats = {};
  const topModels = {};

  for (const sid of sessionIds) {
    const unitKey = `sessions/${sid}`;
    const journalPath = join(projectDir, 'sessions', sid, 'journal.jsonl');
    let stat;
    try {
      stat = statSync(journalPath);
    } catch {
      continue; // dir without a journal is not a session yet
    }

    // v10: journalSize is the incremental-cache KEY (journal size+mtime moves
    // on every append); `size` is the DISPLAY value = recursive session-dir
    // bytes (folder size), persisted alongside.
    const journalSize = stat.size;
    const lastModified = stat.mtime.toISOString();

    // 增量优化：如果有已有统计且 journal 未变化且 schema 版本一致，直接复用
    if (existing?._v === STATS_VERSION
        && existing?.files?.[unitKey] && existing.files[unitKey].journalSize === journalSize && existing.files[unitKey].lastModified === lastModified) {
      if (!onlyFile || onlyFile !== unitKey) {
        filesStats[unitKey] = existing.files[unitKey];
        if (filesStats[unitKey].models) {
          for (const [model, data] of Object.entries(filesStats[unitKey].models)) {
            if (!topModels[model]) topModels[model] = 0;
            topModels[model] += data.count;
          }
        }
        continue;
      }
    }

    const sessionDir = join(projectDir, 'sessions', sid);
    // Discardable sessions (quota-probe orphans — no main/teammate req, no
    // leader) never count toward stats. Runs only on cache misses: v11+
    // caches are written exclusively by post-discard code, so a cache hit can
    // never resurrect a probe unit (the v10→v11 bump invalidated older ones).
    if (isDiscardableSession(sessionDir)) continue;
    let parsed;
    try {
      parsed = parseSessionDir(sessionDir);
    } catch (err) {
      // One unreadable session must not kill the whole worker (issue #129) —
      // skip its stats and keep counting the healthy ones.
      reportSwallowed('stats-worker.session-parse-failed', new Error(`${sid}: ${err.message}`));
      continue;
    }
    filesStats[unitKey] = {
      models: parsed.models,
      summary: parsed.summary,
      preview: parsed.preview,
      size: dirSizeSync(sessionDir),
      journalSize,
      lastModified,
    };

    for (const [model, data] of Object.entries(parsed.models)) {
      if (!topModels[model]) topModels[model] = 0;
      topModels[model] += data.count;
    }
  }

  // No parsable session yet (dirs without journals) — keep whatever exists.
  if (Object.keys(filesStats).length === 0) return;

  // 计算全局汇总
  let totalRequests = 0;
  let totalSessions = 0;
  let totalTurns = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;

  for (const f of Object.values(filesStats)) {
    totalRequests += f.summary.requestCount;
    totalSessions += f.summary.sessionCount || 0;
    totalTurns += f.summary.turnCount || 0;
    totalInput += f.summary.input_tokens;
    totalOutput += f.summary.output_tokens;
    totalCacheRead += f.summary.cache_read_input_tokens;
    totalCacheCreation += f.summary.cache_creation_input_tokens;
  }

  const stats = {
    _v: STATS_VERSION,
    project: projectName,
    updatedAt: new Date().toISOString(),
    models: topModels,
    files: filesStats,
    summary: {
      requestCount: totalRequests,
      sessionCount: totalSessions,
      turnCount: totalTurns,
      fileCount: Object.keys(filesStats).length,
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cache_read_input_tokens: totalCacheRead,
      cache_creation_input_tokens: totalCacheCreation,
    },
  };

  try {
    writeFileSync(statsFile, JSON.stringify(stats, null, 2));
  } catch (err) {
    parentPort?.postMessage({ type: 'error', message: `Failed to write stats: ${err.message}` });
  }
}

/**
 * 扫描 logDir 下所有项目目录，逐个生成统计
 */
function scanAllProjects(logDir) {
  try {
    const entries = readdirSync(logDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = join(logDir, entry.name);
      generateProjectStats(projectDir, entry.name, null);
    }
    parentPort?.postMessage({ type: 'scan-all-done' });
  } catch (err) {
    parentPort?.postMessage({ type: 'error', message: `scan-all failed: ${err.message}` });
    parentPort?.postMessage({ type: 'scan-all-done' });
  }
}

// Worker 消息处理
parentPort?.on('message', (msg) => {
  switch (msg.type) {
    case 'init': {
      const { logDir, projectName } = msg;
      const projectDir = join(logDir, projectName);
      if (existsSync(projectDir)) {
        generateProjectStats(projectDir, projectName, null);
        parentPort?.postMessage({ type: 'init-done', projectName });
      }
      break;
    }
    case 'update': {
      const { logDir, projectName, logFile } = msg;
      const projectDir = join(logDir, projectName);
      // logFile is a session DIR path from the live feed (v2); the unit key is
      // `sessions/<sid>`. A legacy basename is passed through harmlessly (it
      // just never matches a unit → plain incremental run).
      const onlyUnit = String(logFile || '').includes(`${'/'}sessions${'/'}`) || String(logFile || '').includes(`\\sessions\\`)
        ? `sessions/${basename(logFile)}`
        : basename(logFile || '');
      if (existsSync(projectDir)) {
        generateProjectStats(projectDir, projectName, onlyUnit);
        parentPort?.postMessage({ type: 'update-done', projectName, logFile: onlyUnit });
      }
      break;
    }
    case 'scan-all': {
      const { logDir } = msg;
      scanAllProjects(logDir);
      break;
    }
  }
});
