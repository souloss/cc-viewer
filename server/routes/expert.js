// Expert settings routes — 读/写「当前工作区」的系统文本 sentinel 文件
// (CC_SYSTEM.md / CC_APPEND_SYSTEM.md)，对应偏好设置 → 专家设置 → 系统文本修改。
// 这两个文件由 pty-manager._spawnClaudeImpl 在启动 claude 时自动注入为
// --system-prompt-file / --append-system-prompt-file（见 server/lib/system-prompt-files.js）。
// 鉴权沿用 dispatch 之前的全局鉴权（与 files-fs 写操作一致，不额外 gate isLocal）。
import { readWorkspaceSystemText, writeWorkspaceSystemText } from '../lib/system-prompt-files.js';

// 当前工作区目录全部由服务端解析（绝不接收客户端路径 → 无遍历面）：
//   运行中/最近一次 claude 的 cwd > CCV_PROJECT_DIR > （仅非工作区模式才回退 process.cwd()）
// 工作区模式下若无活动会话则返回 null —— 避免误写服务器自身目录。
async function resolveDir(deps) {
  let cwd = null;
  try {
    const { getCurrentWorkspace } = await import('../pty-manager.js');
    cwd = getCurrentWorkspace()?.cwd || null;
  } catch { /* pty-manager 不可用时走回退链 */ }
  if (cwd) return cwd;
  if (process.env.CCV_PROJECT_DIR) return process.env.CCV_PROJECT_DIR;
  return deps.isWorkspaceMode ? null : process.cwd();
}

function sendJson(res, code, obj) {
  if (res.headersSent) return;
  try {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  } catch { /* socket 已关闭：忽略 */ }
}

async function getSystemText(req, res, parsedUrl, isLocal, deps) {
  try {
    const dir = await resolveDir(deps);
    const { mode, text } = readWorkspaceSystemText(dir);
    sendJson(res, 200, { dir: dir || null, active: !!dir, mode, text });
  } catch (e) {
    // 原始 fs 错误只落服务端日志，对外返回通用错误码(不外泄绝对路径/系统细节)。
    console.error('[CC Viewer] expert system-text GET failed:', e.message);
    sendJson(res, 500, { error: 'read_failed' });
  }
}

function postSystemText(req, res, parsedUrl, isLocal, deps) {
  let body = '';
  let truncated = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > deps.MAX_POST_BODY) { truncated = true; req.destroy(); }
  });
  req.on('end', async () => {
    if (truncated) return; // 超限已 destroy，socket 关闭，勿再解析/回包(对齐 events.js turnEndNotify)
    try {
      const { mode, text } = JSON.parse(body || '{}');
      const dir = await resolveDir(deps);
      if (!dir) { sendJson(res, 400, { error: 'no_active_workspace' }); return; }
      const result = writeWorkspaceSystemText(
        dir,
        mode === 'override' ? 'override' : 'append',
        typeof text === 'string' ? text : '',
      );
      sendJson(res, 200, { ok: true, dir, ...result });
    } catch (e) {
      // 坏 JSON / 写入失败等：原始错误只落服务端日志，对外返回通用错误码。
      console.error('[CC Viewer] expert system-text POST failed:', e.message);
      sendJson(res, 500, { error: 'write_failed' });
    }
  });
}

export const expertRoutes = [
  { method: 'GET', match: 'exact', path: '/api/expert/system-text', handler: getSystemText },
  { method: 'POST', match: 'exact', path: '/api/expert/system-text', handler: postSystemText },
];
