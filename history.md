# Changelog

## Unreleased

### Wire v3 (dark-launched behind CCV_WIRE_V3)

- **V3.S1 — on-demand single-entry endpoint `GET /api/v2-entry?file=v2:<project>/<session>&seq=N[&sid=<uuid>]`**: rebuilds one full v1-shape entry (blob-backfilled, plus `prevMain` — the preceding mainAgent entry the detail view's Body Diff/Context tab needs) from the v2 store on demand. Mid-session main deltas are promoted to full replayed state via a new per-member checkpoint mode in the window materializer (client-equivalent to what reconstruction produces on the legacy channel). Accepts both the session dir basename and the bare session UUID (resolved server-side; rename/`-c`-adoption races answer 404 and the client surfaces an error with a Retry action). Response is brotli-compressed under the axis-B negotiation. Registered unconditionally — inert until the flag lands with V3.S3.

- **V3.S2 — request-list metadata rows channel**: with `CCV_WIRE_V3=1`, `/events` additionally emits a `v2_requests` frame (journal-fold rows: seq/timestamp/url/status/duration/usage/model/typeTag/cacheLoss, ~1.3KB each vs full entries) before `load_end`, and the live feed broadcasts one `v2_requests_delta` row per emitted item (with a correction re-send when the next request changes the previous row's Preflight/Plan classification). `typeTag` is computed server-side with the SAME `classifyRequest` the client uses (the `requestType→contentFilter→teammateDetector` chain now carries explicit `.js` extensions so Node can import it — single source, no fork). Three deliberate, test-pinned divergences from the legacy list, all more correct: row membership is the journal fold (a superset including conv-gapped crash-orphans; their detail fetch 404s gracefully), `mainAgent` is kind-derived (same semantics the mainAgentRing pinned), and cacheLoss's `ttl` reason actually fires (the client computed the gap as string-minus-string NaN). Flag read once at startup into `deps.wireV3` and broadcast to clients via `server_config.wireV3`.

- **V3.S3 — flagged frontend: request list from rows + on-demand detail**: when the server announces `wireV3` (via `server_config`), the request list renders from metadata rows (one `_listSource()` seam feeds desktop and mobile; selection-coupled call sites all go through it), cache-loss dots read the server-computed row field, and selecting a row fetches the full entry + its previous mainAgent from `/api/v2-entry` (loading/error/retry states, in-flight abort on rapid switching, 404 surfaces an error with a Retry action on rename races). The IndexedDB entry cache gains a `protocolVersion` record tag instead of a DB_VERSION bump — a bump would wipe every user's cache at upgrade time regardless of the flag, breaking the dark launch. Flag off: byte-for-byte today's behavior.

- **V3.S4/S5 — native chat wire + client assembler (flagged)**: with `CCV_WIRE_V3=1` and a v2 source, the legacy full-entry stream is REPLACED end-to-end — cold loads send raw conv lines (from the last snapshot at-or-before the window start) + responses lines for the window members; the live feed forwards each raw conv/responses line as it lands and suppresses the full-entry broadcast (kv-cache/context side events unchanged). The client's new `v3Assembler` replays these into v1-shape entries (full accumulated messages by shared reference, no tools/system) and feeds the EXISTING ingest pipeline — merge guards, ChatView, team modal, and tool-result maps keep their exact semantics, verified by an oracle test asserting field-level parity between assembled entries and the legacy client-reconstructed stream. Deep consumers (ChatView/AppHeader/Mobile) read the assembled `state.requests` while the list keeps rendering metadata rows. This replaces the originally-designed excerpt frames + parallel chat pipeline (consumer census showed near-full fidelity would be required anyway).

- **V3.S6 — Wire v3 is now the DEFAULT** (`CCV_WIRE_V3=0` is the escape hatch back to the legacy full-entry wire, kept for one release cycle). New spec: `docs/refactor/WIRE_FORMAT_V3.md`. Measured on a real 68MB/3830-request session (tail-1000 cold load): plaintext 176.8MB → 42.5MB (÷4.2 — the remote plain-http path browsers can't brotli on), client JSON parse ÷4.2, live channel per-turn now delta-sized instead of re-broadcasting the full history twice per turn (was 3.7GB/client/session). Under brotli both wires converge near the same entropy floor, so localhost byte totals are similar by design. Retained surfaces: `/api/local-log` (log viewer + IM modal), downloads, `ccv verify`, v1 legacy files — all keep v1-shape output; `entry-slim` stays (idle on the v3 path) since the assembler architecture keeps entries client-side.

- **Loading UX for the v3 wire**: the full-screen loading mask is GONE. Metadata rows arrive in the very first frame, so the request list and on-demand detail are interactive immediately; the chat area shows its own inline Spin (the placeholder ChatView already had) plus a real byte meter — `load_start` carries the exact total of the upcoming v3 frame bytes (payloads are pre-built server-side) and the client renders `received/total MB (n%)` as frames stream in. The legacy wire / v1 files keep the count-up text in the same inline spot.
- **Team code review (6 perspectives) — P0/P1/P2 findings fixed**: `src/utils/` added to the npm `files` array (the server now imports the shared `classifyRequest` chain from there — a published package would have crashed on boot; CI cannot catch this); v3 client state (rows/assembler/live-dedup) now resets on EVERY baseline reset (workspace switch, full_reload, fresh cold frame) — previously a workspace switch left the old project's rows in the list with 404 details, and reconnecting tabs grew memory unboundedly; live v3 frames arriving during the chunked cold assembly are buffered and replayed after it (a live delta could advance the shared channel pointer mid-assembly and corrupt cold entries); incremental reconnects (`?since=`) now send a since-scoped delta window instead of re-transmitting the whole session (the mobile reconnect regression); the legacy/escape-hatch cold load shows a loading state instead of flashing the onboarding guide; `readV2NativeCold` yields to the event loop and the whole v3 cold read is single-flighted per window (reconnect storms coalesce); cold kv/context fallback depth restored to 3 mains (legacy scan-ring parity); `server_config` carries a build stamp and stale tabs self-reload across server upgrades; teammate sessions: fixed a crash in the v3 cold read (`findTeammateSessionDirs` items are `{dir}` objects) and rows now carry the v1 `teammate` contract (agentName string) — both caught by the new teammate fixture tests; `handleToggleViewMode` routed through the list-source seam; classification catches report via `reportSwallowed`; dead loading-overlay CSS removed.

- **Main-thread freeze during v3 cold load fixed** (the "silent loading" symptom): native frames are now split at ~512KB — a multi-MB single SSE event forced one giant synchronous `JSON.parse` that blocked paint and rAF, so neither the spinner nor the meter could render; small frames are macrotask boundaries the browser paints between. The client's window assembly is likewise chunked with main-thread yields (live entries arriving during the async window are gated into the existing pipeline buffer, drained at commit).

### Wire compression (server→client transport)

- **SSE and streaming JSON responses are now brotli-compressed** when the client offers `Accept-Encoding: br` (every modern browser does): `/events`, `/api/local-log` (per-event flush — frames still arrive immediately) and `/api/requests` (whole-stream). Measured on a real 68MB/3830-request session: cold load 168.5MB → 8.1MB (20.8x), live channel 3.7GB → 46MB (80x) per client. Downloads and static assets are intentionally unchanged.
- Implementation: new `server/lib/wire-compress.js` is the single encoding seam (brotli q9, 16MB window, flush coalesced per macrotask; whole-stream responses like `/api/requests` skip per-event flush for a better ratio); ALL SSE writes — including log-watcher broadcasts, workspace reload, and the update badge — route through its `sseWrite` so no plaintext byte can leak into a compressed stream. Backpressure watches whichever stream applies the pressure (the encoder's input buffer on compressed paths, the socket otherwise — `awaitWireDrain`), `br;q=0` is honored as a refusal, `Vary: Accept-Encoding` is emitted on both negotiation outcomes, and the per-connection encoder is destroyed on close and on dead-client eviction.
- Negotiation is **br|identity only** (no gzip tier: its 32KB window cannot dedup the repeated multi-KB tools/system blocks — measured 1.8-3x vs brotli's 20-80x). Clients that do not offer `br` (curl, tests) get byte-identical plaintext, unchanged from before.
- Escape hatches: `CCV_WIRE_COMPRESSION=off` disables negotiation; `CCV_BROTLI_QUALITY=<1-11>` overrides the quality (default 9).

## 1.7.0 (2026-07-16)

> 1.7.0 is a major release. Its core is a **breaking change of the log storage: the v1 single-file JSONL is replaced end-to-end by the v2 per-session folder format**. Entries below are grouped by theme; per-commit detail lives in git history.

### Core breaking upgrade: log storage v1 → v2 (Wire Format v2)

- **What it is**: every session now lives in its own folder `sessions/<yyyymmddhhmmss>_<uuid>/` (journal metadata lines + incremental conversation events + responses + content-addressed blobs), replacing the single per-project `.jsonl` file. v2 is the ONLY write format; every v1 write path is retired.
- **Why it pays off**:
  - **Size**: content-addressed dedup of repeated tools/system payloads + incremental conversation events shrink a migrated archive by ~80% in real-data runs.
  - **Memory/stability**: reads are memory-bounded end-to-end (two-pass windowed synthesis + streaming) — loading a big session drops the server heap from ~1.5GB to ~0.2GB, eliminating the OOM crashes.
  - **Per-session capabilities**: soft-delete (sessions move to a recycle folder, restorable — nothing is ever physically unlinked), per-session migration verify (a bad session is quarantined into `sessions-quarantine/` instead of sinking the whole batch), lossless per-session ZIP download/upload, and timestamp-prefixed folder names that sort chronologically right in the file system.
  - **Liveness**: the live channel pushes incremental journal/conversation appends; cold load falls back to the newest renderable session, so startup/refresh no longer shows a blank panel.
- **How to upgrade**: on the first launch after upgrading, a migration prompt appears whenever the project still has unmigrated v1 logs — click "Migrate now". You can also trigger it from Log Management → "View legacy (v1) logs", or via the CLI: `ccv convert <project>` / `ccv convert --all`. Conversion and verification show live progress; the task is resident server-side and resumes after interruption. **v1 files are never deleted automatically** — they stay on disk after migration, so the run can always be repeated. A `-c` continuation whose earlier half still lives in v1 re-prompts for migration.
- **Removed together with the storage switch (also breaking)**: the multi-instance concept (`--pid`/`CCV_INSTANCE_ID`), the Merge Logs / Archive Logs features (including `.jsonl.zip` read support), the "only show current session" preference (now the only live-view mode), and the three experimental v2 switches in the logs modal. Session size is now the recursive folder size (the old journal-only figure undercounted ~12x).

### Migration experience

- One-click v1→v2 migration with three entry points — logs-modal button, startup prompt, `ccv convert` CLI — resumable across restarts.
- Golden verify is per-session and non-blocking (one bad session no longer aborts the batch); the verify phase shows live progress "verifying data (x/n) · m entries scanned…" in all 18 languages.
- Logs modal gains a v2/v1 dual view: opens on the v2 session list; while legacy v1 files remain on disk, a "View legacy (v1) logs" link offers list/view/download/migrate/soft-delete.

### Fixes and improvements

- `ccv -c` no longer mints a blank new session: a continuation launch adopts the previous main session's folder (Claude CLI 2.1.210 hands a fresh session_id on every -c); `--fork-session` and explicit `-r` intentionally keep their own session.
- Cold-load activation gate (requires a COMPLETED main turn) + fallback picker excluding the in-flight current session remove the residual startup/refresh blank flash; restart-continuation epoch regression and live event-ordering false alarms fixed.
- Log-list overview is now the session's full user-prompt set, statically cached per session (`prompts.jsonl` side file, including the suggestion-probe replace-tail case).
- IM status chips poll only while the platform is configured: a never-configured platform sends one probe then goes silent (fixes the constant 4-platforms × 5s request stream on fresh installs); transient probe failures keep polling (self-heal); in-app config changes re-arm via an event.
- README refreshed in all languages; `docs/WIRE_FORMAT.md` marked superseded by the v2 spec.

## 1.6.301 ~ 1.6.348 Version Summary

> Condensed summary of versions 1.6.301 ~ 1.6.348 (2026-06-06 ~ 2026-07-13). Full per-version detail lives in git history.

### 1.6.345 ~ 1.6.348 (2026-07-11 ~ 07-13) — system-prompt injection hardening, IM stability

- **Model-entry injection matches the ACTIVE configuration** (`spawn-model-resolver.js`) instead of past usage; tiered boot fallback + four guard layers so no system-prompt-pipeline failure can crash or block a spawn; `${...}` template variables actually rendered at spawn; skipped-injection no longer logs a false diagnostic.
- **Test-isolation data barriers L1c/L1d** in findcc.js: under a test context an explicit `CCV_LOG_DIR`/`CLAUDE_CONFIG_DIR` is honored only when it points at a safe location — unit tests can no longer touch real user data.
- **IM**: conversation-record drawer gains an inline Start button for dead workers (+ six-role review hardening); bridge status no longer shows a stale "Connected" after network loss.
- Chat: MainAgent identity no longer flashes to the generic avatar at a session boundary with carried-over history; mid-conversation system rows relabeled "Append System Prompt" (18 locales); concept docs added for Artifact/DesignSync/RemoteTrigger; search-highlight recolored to the inline-code scheme.

### 1.6.341 ~ 1.6.344 (2026-07-08 ~ 07-10) — search/replace across files, Edit System Prompt maturation, CLI 2.1.201 wire shapes

- **Search across files** (VS Code-style activity-bar view) and **Replace across files** with inline before/after previews; the replace batch yields to the event loop every 64 files; multi-role review hardening.
- **Edit System Prompt**: moved into the hamburger menu, shared blurred mask, dictionary presets wired in (builder relocated to `server/lib/create_system_prompt.js`), a fifth kimi-k2.7-code global preset, per-model preset differentiation, parameter-docs popup localized into all 18 locales.
- Adapted to Claude Code CLI 2.1.201 wire shapes (`mid-conversation-system` beta) that broke post-plan-approval rendering; AgentTeam/UltraPlan enabled by default at launch; `readClaudeProjectModel` normalizes cwd (realpath/symlink/trailing-slash) before matching `~/.claude.json`.

### 1.6.336 ~ 1.6.340 (2026-07-04 ~ 07-06) — teammate avatars, ChatView decomposition, error-reporting convention

- **All 17 teammate role avatars redesigned** as colored historical-figure bust portraits with one-shot draw-in animation (+ a Marvel alternate set); animation loads only for recent rows on refresh.
- **Swallowed-catch reporting convention established** (`reportSwallowed(tag, err)`, greppable `[ccv:<tag>]`, per-tag dedup cap); all 15 `!important` declarations removed from FileContentView; 12+ hardcoded UI strings localized (18 locales); four phantom devDependencies declared.
- ChatView decomposition first tranche (4,144 → 3,699 lines, behavior-preserving, unit-tested) + the crash it briefly introduced fixed; log-rotation no longer loses teammates from the Conversation view; identity fallbacks self-heal after refresh; AskUserQuestion eternal-empty and hollow-popup cases fixed; UltraPlan rainbow shimmer on toolbar/chat-input buttons; unified `--font-mono`/`--font-ui` app-wide.

### 1.6.331 ~ 1.6.335 (2026-07-02 ~ 07-04) — model-specific system prompts, fast/CLI test tiers, session anchoring

- **Model-specific System Prompts**: tabbed Edit System Prompt modal, per-model `<NAME>_SYSTEM.md`/`<NAME>_APPEND_SYSTEM.md` in global + workspace scopes with precedence, `GET/POST /api/expert/model-prompts`; six hamburger feature modals get the blurred overlay mask.
- **Test tiers**: default `npm run test` becomes the fast in-process unit tier (~20-38s, was ~198s); 24 CLI/server-integration files gated behind `CCV_TEST_CLI=1`; L7 guard blocks real claude-binary discovery under tests.
- "Only current session" anchoring fixed (newest-activity pin, shared `isSessionBoundary` predicate across batch and live, no stale upper bound); AskUserQuestion streaming-assembly blank popup fixed; animated proxy-pipeline SVG embedded in all READMEs.

### 1.6.318 ~ 1.6.330 (2026-06-18 ~ 06-30) — IM deep work (AI cards, skills, personas), system-text editing debut, multi-instance isolation, terminal UX

- **IM AI-card token streaming** on DingTalk (flowStatus labels), Feishu (CardKit) and WeCom, behind an opt-in `aiCard` switch; built-in `manage-ccv-projects` skill injected per worker; persona preset per UI language (`server/imPreset/<lang>.md`); persona file moved from `CLAUDE.md` to `CC_APPEND_SYSTEM.md` injected via `--append-system-prompt-file` (harder to bypass, auto-migrated).
- **System-text editing debut** (Expert settings): write the workspace's `CC_SYSTEM.md` (override) / `CC_APPEND_SYSTEM.md` (append), auto-injected as claude flags at launch; later widened with markdown preview.
- **Multi-instance isolation** (`--pid`, per-instance logs/session pin/instance registry — later removed wholesale in 1.7.0) and per-project preference forks for shared-server (LAN) use.
- Relative-path dist build (one artifact serves root and `CCV_BASE_PATH` sub-path reverse proxies); terminal Ctrl+C/V copy-paste on Win/Linux; in-band reset preserves scrollback; `cc_is_subagent` main-agent exclusion; skill permanent-delete + duplicate badges; Context tab tools-diff highlighting; multi-source IP geo fallback; scrollback restored via `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`; teammate thinking no longer leaks into the main live overlay.

### 1.6.301 ~ 1.6.317 (2026-06-06 ~ 06-18) — Windows root-cause batch, terminal-garble eradication, Workflow visualization, context-bar alignment

- **Windows batch**: startup error 193 (.exe-only resolution), ConPTY output-flood coalescer (~1.9MB/s cap, DEC 2026-balanced), /plugins permanent page freeze root-caused to catastrophic regex backtracking (rewritten as a linear line parser), Ctrl+C three-layer exit defense, CJK IME offset, CI pinned/upgraded around the VS2026 image roll.
- **Terminal garble eradicated** in three passes: anchor-scan safe slicing (`ansi-safe-slice.js`) shared by all three write paths, batch-boundary carry of half sequences, in-band reset replacing `terminal.reset()`, truncation-snapshot realign — plus an end-to-end pipeline oracle test (nine scenarios, zero-fragment invariant); WebGL renderer re-enabled on macOS desktop behind a longtask capability gate.
- **Workflow/UltraCode visualization suite**: inline chat panel (phases + per-agent rows), list/Gantt timeline toggle, always-on live HUD above the input, activity-bar Workflow area, read-only `/api/workflow-journal`, phase column parsed from script `meta.phases`.
- Context bar aligned with Claude Code `/context` raw-occupancy math (dropped the ÷0.835 mapping) and recognizes fable-5 (1M window); Context tab raw-JSON view; four-pointed-star quick-settings menus (permission/plan auto-approve, AgentTeam); sticky-bottom scroll opt-out during streaming; `_seq`/`_seqEpoch` four-layer defense against duplicated mainAgent renders; IM record popup updates live via fs.watch; image-upload in-flight guard; usage pill no longer stuck off; base-path sub-path routing fixed.

## 1.6.251 ~ 1.6.300 版本汇总 (1.6.251 ~ 1.6.300 Version Summary)

> 以下为 1.6.251 ~ 1.6.300 所有版本的功能/修复摘要，详细变更记录已归档至 git 历史。
> Below is a condensed summary of versions 1.6.251 ~ 1.6.300. Full per-version detail lives in git history.

### 1.6.296 ~ 1.6.300 (2026-06-05 ~ 2026-06-06) — Windows 性能根治批、测试覆盖率 72%→96%、测试隔离守卫体系、移动端尾部优先加载

- **Windows 性能根治批**（1.6.296）：interceptor 热路径 appendFileSync 改异步写入队列（消除每请求 50-300ms 事件循环阻塞）；Atomics.wait 阻塞锁改异步文件锁；UV_THREADPOOL_SIZE=16；日志监听 watchFile 500ms 轮询迁移 fs.watch 事件驱动（同目录共享 watcher + 80ms 防抖 + 5s 安全网）；日志读取路径全面 fs.promises 异步化；JSONL 分割阈值 300MB→150MB；CCV_SYNC_WRITES=1 回退开关
- **测试覆盖率 72%→96%**（1.6.299）：新增/补强约 100 个测试文件（server 路由 / interceptor / sdk-manager / cli / WS/PTY / src/utils 全量）；test/_shims ESM loader 让 node:test 直接导入 Vite 风格前端模块；根治并行测试 flake（跨进程端口窗隔离、固定 sleep 改条件轮询）；test 脚本统一 --test-timeout=120000 + --test-force-exit
- **测试隔离守卫体系**（1.6.300）：findcc.js LOG_DIR/configDir 双铁闸（测试态强制进程私有临时目录）、测试态拒绝真实 spawn IM worker / registry 请求，单测从机制上无法触碰真实 ~/.claude 与外网；新增静态扫描守卫（env 隔离 / spawn 注入 / fetch 还原纪律）；24 个测试文件端口隔离改造；50+ branch-*.test.js 定向补强，全量 6402 测试 0 失败
- **启动期配置备份**（1.6.300）：preferences/profile/workspaces 每次启动自动备份到数据目录外（滚动保留 10 份）
- **移动端历史日志尾部优先加载**（1.6.298）：服务端 readTailEntries() 仅读文件末尾 2-8MB 跳过全文件扫描，旧条目按需分页
- **终端渲染稳定性**（1.6.298）：PTY 输出批次启用 DEC 2026 同步渲染消除中间帧闪烁；WebGL longtask 自动降级 DOM 渲染器（30s 内 3 次 >200ms，7 天后重试）
- **Windows 冷启动 Chrome tab 崩溃修复**（1.6.298-299）：桌面端首屏 SSE 1000→400 条 + idle 超时 2s→5s + requestIdleCallback 延迟连接 + 重连指数退避（2s→32s）+ ?since= 增量重连

### 1.6.293 ~ 1.6.294 (2026-06-02 ~ 2026-06-03) — IM 多平台独立 worker 体系、Windows 桌面版体验批、长任务页面卡死根治、Plan 自动审批

- **IM 接入重构为「每平台一个独立常驻 ccv worker 进程」**（1.6.293）：工作目录 ~/.claude/cc-viewer/IM_<id>/、绑 127.0.0.1、skip-permissions 全自动运行，主 ccv 不再注入当前会话（消除排队/上下文污染）；reconcile 自动拉起、im.lock 防多处接入、PreToolUse 在 bypass 前硬拦截危险操作；端口段 7050 起与主池不重叠
- **IM 多平台桥接**（1.6.293）：钉钉桥接重构为通用编排核心 im-bridge-core + 平台适配器，新增飞书/Lark（长连接）、企业微信（智能机器人）、Discord（Gateway）三平台；描述符驱动设置面板
- **IM 体验完善**（1.6.294-296）：即时确认（飞书/Discord 可更新卡片）、排队位置告知、turn_end 去抖 10s→200ms + Stop hook/idle 轮询双保险；对话记录按发送者显示真实姓名+头像；每 IM 独立 CLAUDE.md「模型性格定义」编辑与 SKILL 管理；配置失焦自动保存 + 启动/停止按钮；连接状态徽标以真实进程状态为准
- **Windows 桌面版体验批**（1.6.294）：自定义标题栏（logo/菜单/tabs 合一行，titleBarOverlay 保留原生按钮与 Snap Layouts）；启动白屏修复、窗口状态持久化、右键菜单补齐、AppUserModelId 对齐；主进程防阻塞加固（diag 日志异步队列、打包版 console 静默、审批级联去抖）；child_process 全量 windowsHide
- **Web 桌面端长任务页面卡死根治**（1.6.294）：桌面端复用移动端渲染窗口裁剪（默认只渲染最近 400 条，更早按需展开）——原先全量渲染 DOM 致 reconcile/layout 随条目数线性增长打满主线程；SSE backpressure 容忍 5s→30s 消除误判剔除→重连重放风暴
- **ConPTY 输出洪泛防护**（1.6.294）：前端写队列积压超 2MB 丢最旧并提示；服务端按 ws.bufferedAmount 停发 + data-resync 快照对齐 + 60s 死连接判定
- **「Plan 自动审批」首发**（1.6.294）：偏好新增下拉（关/3s/5s/10s/立即），CLI(PTY) 模式下计划倒计时自动批准、可取消转手动；原「自动审批」更名「权限自动审批」
- **UI 杂项**（1.6.293）：汉堡菜单「钉住」生成常驻快捷方式；主题切换简化为太阳/月亮图标按钮；用户 Prompt 导航加时间列与 Session 分隔线；「仅展示当前会话」偏好；源码裸控制字节转义 + pretest 守卫；Electron iPad 设备预览模式（500px 收窄 + header 控件迁原生 tab bar）

### 1.6.283 ~ 1.6.288 (2026-05-29 ~ 2026-06-01) — 显示缩放体系演进、套餐用量 pill、SDK 停止语义、流式性能

- **「显示大小」三步演进**：CSS zoom 预设选择器 50%-200% + Cmd/Ctrl +/- 快捷键（1.6.285）→ 根容器高度链修复留缝（1.6.287）→ 弃用 CSS zoom 改 Electron 原生 webFrame.setZoomFactor、纯浏览器交还原生缩放（1.6.288，规避 Chromium 128 CSS zoom 坐标空间分裂）
- **套餐用量 pill**（1.6.283）：footer 新增 Claude 订阅（OAuth）5 小时/周窗口使用率展示，数据取自 anthropic-ratelimit-unified-* 响应头，纯前端实现；hover 详情血条化；低调灰收敛配色
- **代理转发两项根治**（1.6.283）：Node 26 起 global dispatcher 不再共享——EnvHttpProxyAgent 显式作为 fetch dispatcher 传入；上游强制 accept-encoding: identity 根治网关剥 content-encoding 头致 CLI 收到压缩字节报 malformed response
- **SDK 停止语义修复**（1.6.286）：「停止」真正 halt 在途待发（清服务端 _messageQueue + 客户端 _pendingFlushQueue）；停止按钮按模式分流（SDK close query 保会话 / PTY focus-in 再 ESC 修失焦吞 ESC）；点击乐观即时切非运行态
- **流式吸底帧率节流**（1.6.286）：StickyBottomController 平滑追随按 33ms（~30fps）门控与显示器刷新率解耦，流式期 layout/paint 负载降 ~4×；移动端 Virtuoso followOutput smooth→auto 消除每帧平滑滚动动画（1.6.283）
- **UltraPlan 专家体系**（1.6.283）：「管理专家」弹窗统一管理内置+自定义（显隐开关/拖拽排序/落 preferences）；「预设专家」ultraAgents/*.json 随包发布 + 编辑器「载入模版」；title/description JSON 协议层内联本地化
- **杂项**：同请求多 thinking 块合并单折叠框（1.6.284）；LSP/Workflow 概念帮助文档 18 语言（1.6.283）；用户消息裸路径上传图片渲染（1.6.283）；opus-4 家族/mythons 1M 上下文判定 + 血条自适应纠偏（200K 判定但输入越窗自动升 1M）（1.6.282）；IM 弹窗 Chrome tab 风格（1.6.282）；默认登录密码规则简化 AB1234 形态（1.6.282）

### 1.6.274 ~ 1.6.281 (2026-05-24 ~ 2026-05-29) — 密码登录认证、钉钉桥接首发、server.js 路由拆分、components 目录重组、终端刷新演进

- **密码登录认证体系**（1.6.276）：远程未授权访问弹密码页（Set-Cookie SameSite=Strict），本机永远免密 admin；全局 + 项目级覆盖两层持久化（base64 混淆、0600、/api/preferences 剥离）；CLI --usePassword 启动即开启；鉴权收敛纯函数 decideAuth() HTTP/WS 共用（补上 WS 缺失鉴权）；登录限流 60s/20 次
- **钉钉 Stream 双向桥接首发**（1.6.277）：仅填 AppKey/AppSecret 无需公网；消息注入会话 + turn_end 读 transcript 回干净 markdown（分块+令牌桶限流）；/stop 中断、ack+LRU 去重、忙时排队、staffId 白名单、审计日志；多角色 review 修复批（状态脱敏、CR 消毒、队列封顶、语言跟随 UI 配置）
- **server.js 路由拆分**（1.6.275）：5467→1791 行，84 路由 if-chain 按功能域拆 14 个 server/routes/* 模块 + 有序首匹配 dispatcher，deps 单例注入，纯搬移零行为变更
- **components 目录重组**（1.6.274）：扁平目录按功能域分 10 个子目录（chat/terminal/git/files/viewers/approval/settings/mobile/dashboard/common）；AppHeader.module.css 1507 行按归属拆分；五个对话展示偏好单一真相源收口 SettingsContext；askFlowController 从 ChatView 抽离（4777→3990 行）
- **终端「刷新」按钮三步演进**：高度抖动驱动 xterm 重建（1.6.277）→ 连击逐级加强 L1/L2/L3 + 60s 后台预防性触发（1.6.280）→ 改 xterm 官方 escape hatch（clearTextureAtlas/fit/WebglAddon reload，保 cols/rows/滚动位置）（1.6.281）
- **审批档位简化 +「免审批」**（1.6.278）：删 15/20/30/60s 保留 3/5/10；新增免审批（AUTO_APPROVE_INSTANT=-1）在请求到达处直接放行（hook 回 allow / pty 直选允许），含 prompt 签名时窗去重与 ws 断连回落
- **本机明文查看凭据**（1.6.278）：127.0.0.1 admin 可查看代理 API Key / 钉钉 AppSecret 明文，远程仍脱敏；IM 来源消息显示平台图标（⟦im:dingtalk⟧ 标记）
- **UltraPlan 自定义专家编辑器**（1.6.279-280）：双栏布局（左使用文档右表单）、预填 system-reminder 外壳骨架、左栏可折叠、打开编辑器不再关闭背后面板（rc-trigger capture-mousedown 守卫）
- **杂项**：Homebrew bump 改 reusable workflow 链式调用修漏 bump（1.6.279）；「new」版本徽标 SSE 补推跨刷新持久（1.6.277）；代理 content-length 剥离修模型覆盖 profile 卡死（1.6.277）；血条 Popover 内打开明细 Modal 不再消失（1.6.277）；项目中心密码管理模型（1.6.277）；per-project 别名（1.6.272）

### 1.6.251 ~ 1.6.273 (2026-05-10 ~ 2026-05-20) — ask 无超时体系、语音包、Windows 适配批、服务端收纳 server/、日志压缩归档

- **ask 体系大修**（1.6.263/270）：GUI AskUserQuestion 实质无超时与 TUI 对齐（先 60min+倒计时，后彻底无超时）；ask-store 持久化 + server 重启恢复 UI；ask-bridge 短轮询协议（POST 返 askId + GET 25s wait + 404 重建）；web 端取消 + 输入框打字打断（SDK sentinel deny / Hook cancelled 分支）；十余项 race/边界修复（first-write-wins、单 lock consume、pruneStale、晚到 ack 关 modal 等）；注入 hook 加 24h timeout 防 Claude Code 10min 强制中断
- **语音包体系**（1.6.264/268/271）：4 类生命周期事件绑定音频（plan 审批/ask/超时预警/turn 结束），内置 Pixel Buddy chiptune + 用户上传（magic bytes/Range 206/深合并 reconcile）；新增三国 sanguo 内置包（zh 新用户默认）；turn-end Stop hook + 10s trailing debounce 双保险；「审批提示音」与「语音包」合并单开关
- **服务端代码收纳 server/**（1.6.273）：根目录只留 cli.js/findcc.js + 一行 re-export shim；注入改 bare specifier（cc-viewer/interceptor.js）与物理路径解耦 + LEGACY 升级路径；stale hooks 主动 purge；--uninstall 清理 managed hooks；node-pty pnpm hoist 修复；_paths.js 集中路径常量；ask-store 跨进程锁加 PID 校验（1.6.273）
- **Windows 适配批 1/2**（1.6.257-258，Issue #84）：路径校验 + '/' 改 + sep、startsWith('/')→isAbsolute、CRLF split、保留名守卫、symlink 拒绝防 TOCTOU、renameSyncWithRetry、git restore per-file mutex、上传目录平台分支
- **日志压缩归档**（1.6.267）：.jsonl 批量压 .jsonl.zip，查看/下载/合并/统计透明支持（tmpdir 解压缓存 + Zip Slip 防护 + 启动清理）；合并上限前后端统一 400MB
- **血条 auto 校准**（1.6.273）：启动期回落 ~/.claude.json lastModelUsage 推断偏好 model，解决 haiku init ping 错显 200K；/clear lock 多条解锁兜底（1.6.267/269）
- **文件/Git 面板**（1.6.251/255/256）：GitChanges 新增「本地未推送 commit」折叠区（哨兵字符 + hex 校验防注入）；自动刷新机制重写（监听 tool_result 双阶段、覆盖 subAgent/teammate）；文件夹折叠/目录展开/scroll 位置按项目持久化；electron 35→42 消 17 个 high CVE（1.6.256）
- **对话渲染**（1.6.262/266）：web_search 结果卡片化 + 分组容器；工具结果 base64/url 图片渲染（白名单+降级）；SubAgent 末轮工具结果跨请求补偿；多 text 块 synthesis 合并 markdown
- **杂项**：sessionMerge 反向锚点对齐根治复制翻车残余 + WIRE_FORMAT.md 单一真理源（1.6.253）；doubled-history Plan C eager update 补竞态漏检（1.6.251）；zstd accept-encoding 剥离（1.6.252）；移动端三 Modal 改抽屉 + 清理 !important（1.6.261）；图片查看器触控板 pinch 灵敏度修复（1.6.260）；zsh 不 source ~/.zshrc 修复、symlink 目录展开（1.6.269）；UltraPlan modal 拖拽手柄（1.6.273）；内置 slash 命令本地化标签、雪山白主题深底用户气泡（1.6.270）；侧栏 popover 视口贴顶（1.6.254）

## 1.6.200 ~ 1.6.250 版本汇总 (1.6.200 ~ 1.6.250 Version Summary)

> 以下为 1.6.200 ~ 1.6.250 所有版本的功能/修复摘要，详细变更记录已归档至 git 历史。
> Below is a condensed summary of versions 1.6.200 ~ 1.6.250. Full per-version detail lives in git history.

### 1.6.240 ~ 1.6.250 (2026-05-05 ~ 2026-05-12) — Doubled-history 根治、Sticky Bottom 重构、Assistant 时间戳精准化、AskUserQuestion 多路复用、Mobile/iPad 全面对齐

- **Doubled-history 根治三层防御**：
  - 上游（Plan C，interceptor.js）`_lastTailFp` + `_sameLenInPlaceReplace` 强制 checkpoint，根治 in-place last-msg replace 时 delta=[]'丢失"末位换内容"信息
  - 客户端 `applyInPlaceLastMsgReplace(prevSessions, entry, ...)` helper：命中 `_inPlaceReplaceDetected:true` 信号时构造新 lastSession（前 N-1 引用复用 + 末位用新 entry 末位），applied=true 跳过 sessionMerge
  - `revert` 老 Layer 2 客户端短路（既无收益又有副作用，整段拆掉）
- **流式吸底 StickyBottomController 抽离**：~330 行独立 utility 收敛全部 sticky 状态、引用计数 lock、双 rAF 缓动、ResizeObserver、scrollTop 写入；修 4 个设计缺陷 + 2 个 P0（NaN 死循环 + Set 而非 Array 防 O(n²) 内存泄漏）；36 case 单测 + 集成测覆盖；ChatView -149 行净减
- **Assistant 时间戳精准化**：`_generatedTs` 新字段表"消息生成时刻"（保留 `_timestamp` 作 carrier ts），让 bubble 显示时间不再晚一拍；同时修双向映射 msg↔request（`resolveBubbleProducerTs` helper + tsItemMap + 蓝框 highlight 三点对齐）；slimmed-iter 漏赋补丁
- **AskUserQuestion 系列**：
  - 多并发改 Map 多路复用（pendingAskHooks Map + 50 cap + 5min/entry timer + id 寻址 ws answer），抄齐 perm-hook 形态
  - schema 校验失败渲染层红色徽章 `❌ 此提问被 CLI 拒绝` + `<details>` 展开原始 `<tool_use_error>InputValidationError…`；提交失败 toast 升级为 antd `Modal.warning` 含技术码
  - `options[].description` 可选化 + 抽 `askOptionDesc.js` helper 收 5 处内联
- **PC 端血条迁出 AppHeader**：终端开启时挂在 TerminalPanel 工具栏中段，终端关闭时挂在 ChatInputBar 底部；popover placement bottomLeft→topRight；ReactDOM.createPortal + slot ref 实现 DOM 外移 + 数据所有权留 AppHeader
- **校准下拉简化**：7 个具体型号 → `auto` / `1M` / `200K` 三档；AUTO 按 lastMainAgent 自检测（含 `1m` 子串 + `opus-4-7` 大小写不敏感）；老用户 localStorage 显式迁移
- **antd themeConfig 改 Object.freeze 常量**：消除每次 render 字面量重建导致的 useToken 全局 cache miss；Performance trace 实测 antd R 函数 5344ms→260ms (−95%)、GC 6242ms→703ms (−89%)、长任务清零，根治"长时间卡死 + 滚动掉帧"
- **Tool result 内存优化**：通用化 Read intern pool 默认覆盖所有 tool_result（Bash/Grep/MCP/Task）；raw payload `tool_result` content 也走 readResultPool 共享；实测 hitRate 97.6% / 估算回收 36-92MB raw payload 重复
- **Skill import 上传**：`/api/skills/import` 接口 + Mobile cache popover 抽屉「添加/管理」入口；前端三入口（文件夹 / .zip / SKILL.md），多层安全（Zip Slip / Symlink / Zip Bomb 双层 / Unicode NFKC / TOCTOU 修复）
- **CLAUDE.md 入口分区**：cache popover "持久记忆"上方新增 CLAUDE.md 候选清单；`/api/claude-md` 路径白名单 + sha1 id + 512KB cap + isReadAllowed fd-based read（闭 TOCTOU）
- **持久记忆 popover "刷新"按钮**：主动拉 `/api/project-memory` + `message.success/error` 反馈；seq 防 stale + 连点守卫 + workspace 切换复位
- **macOS 粘贴图片上传 403 修复**（PR #81）：darwin 平台 `/private/tmp/cc-viewer-uploads` 显式加 allowlist + mkdir 后 bumpWorkspacesVersion 刷 root 缓存
- **移动端偏好与 PC 对齐**：「仅窗口失焦时通知」/「日志设置」分组 / 18 语言语言选择器；ProcessModal kill 确认 / ProxyModal 删除确认 / PluginModal 子 modal 全部受控 Modal 替代 `Modal.confirm`
- **Modal 抽独立组件**：插件管理 / CCV 进程管理 / 代理热切换 → `{Plugin,Process,Proxy}Modal.jsx` PC+mobile 共用，AppHeader.jsx 净减 ~390 行
- **流式 spinner Claude 官方 SVG**：8 个 sprite-sheet（thinking/waiting/tickle/orbiting/writing/shimmer/entrance/exit）用 SMIL `<animate calcMode="discrete">` 逐帧滚；ImageViewer 同步支持 SMIL 动画 SVG（svgSanitize 集中 hook 防 event handler 注入）
- **AskUserQuestion 渲染层兜底**：`isInputValidationError` 标记 + 抽 `AskValidationBadge.jsx`；ask-bridge / `/api/ask-hook` 双端 normalize options[].description 缺失补 ""
- **AppHeader 入口压缩**：抽 `CachePopoverContent.jsx` + `MemoryDetailModal.jsx` 给 AppHeader 与 Mobile 共用；删 ~290 行模板代码
- **多视角 5-agent review 体系成熟**：每个非平凡改动配 3-5 reviewer（需求/防御/架构/质量/性能-安全），P0 强制采纳 + P1 选择性采纳；累计本区间触发 10+ 轮 UltraReview
- **测试覆盖**：1568 → 1739 用例累计；新增 `applyInPlaceLastMsgReplace`、`sticky-bottom-controller`、`refresh-plan-approval-cache`、`memoryLinkParser`、`skills-import`、`svg-sanitize`、`api-claude-md`、`server-ask-hook-map` 等多个独立单测文件

### 1.6.220 ~ 1.6.239 (2026-05-01 ~ 2026-05-05) — 全局审批 Modal、ExitPlanMode V2、Homebrew 分发、sessionMerge 内容感知、Scratch 终端、MdxEditor、Terminal 性能

- **Scratch 终端上线**（1.6.219-220）：多 tab + PTY 隔离 + 拖拽复序 + focus border 结构化预留；主/小 terminal 双双引入 `.terminalHost` / `.scratchHost` 包装层根治 xterm 渲染溢出
- **Electron tab 栏**：60px 圆角矩形重设计 + 多 tab 打包黑屏修复 + TerminalPanel 高度溢出根治
- **MdxEditor 体系成熟**：
  - 文件浏览器 markdown 改用 MDXEditor (GUI WYSIWYG)（1.6.213）
  - 解析失败自动降级到旧 marked + popupContainer 10px strip 修复（1.6.217）
  - light 白底 + 保存按钮高亮（1.6.214）
  - inline code 去背景 / 内边距（1.6.216）
  - 工具栏 tooltip 18 语全译（之前仅中文，~375 条新翻译；`<MDXEditor key={lang}>` 强制重挂载实现切语言即时生效）（1.6.230）
  - Ctrl+S/Cmd+S 保存快捷键（1.6.230）
- **sessionMerge 内容感知合并**（1.6.223）：根治 Plan Mode 上下文压缩窗口下 ExitPlanMode plan 内容丢失；新算法以 `newMessages[0]` 为锚点从末尾反向扫 + 多块连续 fp 等价校验（text/thinking 加固为 `length + first32 + last32`），三分支收口到单一 `findReverseAnchor` 主路径；流式热路径零分配
- **全局审批 Modal + ExitPlanMode V2**（1.6.224）：文件型 plan + LR/messages 双卡去重 + 5 视角 Code Review 后采纳 P0/P1（bell 持久重开 / plan-file LAN token / null-byte 防御 / ownPending 信息流）；适配 Claude Code 2.x ExitPlanMode V2 文件型 plan
- **卡片审批状态修复**（1.6.229）：ExitPlanMode/AskUserQuestion 答完不切状态——`_sessionItemCache` 失效仅看 msgsLen 导致 cached React Element 持有过期 prop；抽 `refreshPlanApprovalCache.js` / `refreshAskAnswerCache.js` helper 走 cloneElement zero-alloc 快路径
- **Homebrew 分发渠道**（1.6.225）：tap repo `weiesky/homebrew-cc-viewer` + 自动 `bump-homebrew.yml` workflow 开 PR；updater 检测 brew 安装自动跳过 npm 自更新；根治 nvm 用户切 Node 版本后 ccv "消失"问题
- **Assistant 消息时间戳旁显示 [X.XK] 上下文 token 总量**（1.6.222）+ UltraReview P1/P2 采纳
- **AskUserQuestion 双行选项卡片**（1.6.231）：从单行 `dot + label — desc` 重排为双行 `dot + flex-column(label, desc)`；1.8× 大图标 + preview 自适应（≤750px column-reverse）+ aria-radio role 键盘可达 + "Other" 输入框去蓝
- **iPad 全局审批 Modal 接通**（1.6.231）：Mobile.jsx 包 `<ApprovalModal>`（仅 `isPad &&` 启用），ChatView 接 `onPendingAsk` / `onPendingPtyPlan` / `ownTabId` / `projectName` 4 个之前缺失的 prop；mobile inline 卡片路径零回归
- **lastPendingPlanId 算法重写**（1.6.228）：从扫全量 messages 改为反向扫到最后一条非空 assistant message 只在该 message 内查 ExitPlanMode/AskUserQuestion；根治历史 plan/ask 永远 pending 误弹 modal 的 bug
- **LAN 移动端 403 修复 + DNS rebinding 守护**（1.6.227-228）：默认 allowlist 改 `[loopback] ∪ getAllLocalIps()`，与"手机扫码编程"核心场景兼容；CCV_ALLOWED_HOSTS 显式设时完全沿用用户值
- **QR Popover 一点就关修复**（1.6.228）：trigger `['hover','focus']` → `['click']` + 受控 open state + 内部 stopPropagation，移动端 tap 扫码稳定可用
- **单 ws 合并方案 D**（1.6.226-227）：两条 `/ws/terminal` 长连接合并为单条；`input-sequential-done` 跨发送方 race 修复；ask 提交回归（B' ChatView 重新接收 `data` 类型）修复
- **偏好开关 + IPC**（1.6.226）：偏好面板 3 个 Switch 点击无响应修复；「仅窗口失焦时通知」偏好接通 electron 通知逻辑（原 P2 未实现项）
- **统一文件访问策略**（1.6.227）：放开项目外文件读取 + DNS rebinding 守护双件
- **Terminal 写缓冲 O(n²) 修复**（1.6.232）：抽 `terminalWriteQueue.js`（string[] queue + offset 指针 + 周期压缩）替代原 `slice(CHUNK_SIZE)`；UTF-16 surrogate pair 边界回退 + try/catch 回滚 + drain dispose；trace 实测 `_flushWrite` 794ms→<100ms、主线程 idle 从 0.5%→16%
- **cssVar 回退**（1.6.232）：实测对比 trace 显示 antd cssVar:true 是性能**负优化**——cssinjs +170%、flattenToken +1426%、GC +56%、dropped frames +64%；getter 注释明确警告未来不要再开
- **热路径 Tooltip 原生化**（1.6.232）：3 处高频列表（TeamSessionPanel gantt 钻石 / RequestList cache-loss dot）从 antd Tooltip 改原生 `<span title="...">`；冷路径保留
- **持久记忆 popover**（1.6.232）：解析 `~/.claude/projects/<encoded>/memory/MEMORY.md` 入口 + 链接打开明细；`/api/project-memory` 路径白名单 + 512KB cap + 跨 scheme 严格白名单（仅 `#anchor` + 单段 `.md` basename）
- **header 血条 popover 抽组件 + 三端接通**（1.6.233）：抽 `CachePopoverContent.jsx`；iPad 走 click trigger Popover、手机走 `mobileCachePanelOverlay` CSS 抽屉（`transform: translateX(-100%)→0` + zoom 0.6）；chip tooltip 在手机改全屏 Modal 解决 zoom:0.6 偏移
- **memoryLinkParser 白名单**（1.6.233）：discriminated union `{open|allow|reject}` + 白名单（任何 scheme 一律 reject，仅放行 `#anchor` 与单段 `.md` basename），44 case 单测
- **load more history 兜底**（1.6.231）：`_oldestTs` 防御 guard 防 `before=null` 拼出 400 请求；失败 toast 反馈 + 18 语言 i18n
- **UltraPlan 模板瘦身**（1.6.233）：codeExpert 4 项瘦身（删二次 AskUserQuestion / 量化"spawn 2-3 review agents" / P0+P1 选择性采纳 / git diff 判空 / `git rev-parse --show-toplevel`）；researchExpert 加 AskUserQuestion Pre-requisite；同步 18 个 `concepts/<lang>/UltraPlan.md`

### 1.6.200 ~ 1.6.219 (2026-04-23 ~ 2026-04-28) — Scratch 终端基建、Per-message 模型头像、Windows ESM 全适配、MDXEditor 引入、Proxy Profile 隔离、deepseek 1M、history 归档

- **Scratch 终端首版**（1.6.219）：独立多 tab + PTY 隔离 + 拖拽复序 + focus border 结构化预留（为 1.6.220+ 完善铺路）
- **工具栏快捷按钮 paste 块**（1.6.218）：紧贴 `\r` 拆分修复（窗口失焦也能立即提交，避免 tab 切换后 paste 残留）
- **MdxEditor 引入文件浏览器**（1.6.213）：`.md` 文件 GUI WYSIWYG 编辑替代之前的纯 markdown 预览；保留 Code 模式切换；移动端 zoom:0.6 适配
- **MdxEditor 解析失败自动降级**（1.6.217）：marked fallback 兜底 + Force GUI Edit 锁解除 + 1-frame 红横幅闪烁抑制
- **代码浏览器字体收敛 12px**（1.6.216）+ AskUserQuestion "Other" Enter 提交修复 + MdxEditor inline code 去背景内边距
- **History 1.6.0 ~ 1.6.199 压缩归档**（1.6.216）：旧版本详细变更归档至 git 历史，本文件保留 1.6.200+ 详情 + 1.6.0~1.6.199 5 个时间段摘要分组（180~199 / 160~179 / 130~159 / 100~129 / 50~99 / 1~49）
- **README 多语言重构**（1.6.216）：17 个 docs/README.\*.md（zh/zh-TW/en/ko/ja/de/es/fr/it/da/pl/ru/ar/no/pt-BR/th/tr/uk）结构对齐主 README，截图统一
- **/clear 触发 Header 血条乐观重置**（1.6.214）：触发 /clear 后 Header 上下文血条立即乐观重置到低位
- **/clear 后首条 user 输入错位修复**（1.6.212）：ChatView 中错位渲染问题修复 + 数据统计入口从 Header 顶部 Tag 迁移到左侧 navSidebar
- **Per-message 模型头像 1v1 严格匹配**（1.6.211）：消除历史消息被最新 model 污染——`getModelInfo` Map memo + `modelNameByReqIdx` carry-over + `resolveModelInfo(ts)` 闭包，多模型会话头像精准
- **模型名解析改 response 优先**（1.6.210）：避免请求阶段 model 字段不准；新增 deepseek-v4 1M 上下文识别
- **KV-Cache-Text 复制路径**（1.6.209）：用 on-model XML 形态 + formatter 抽到 lib/；SubAgent KV-Cache-Text 复用同一路径
- **Windows 用户插件加载 ESM 修复**（1.6.208）：1.6.207 的 ESM 适配漏掉了用户插件路径
- **Windows ESM 全量适配**（1.6.207）：动态 `import()` 在 Windows 用 `pathToFileURL` 包绝对路径（防 `file://${path}` 模板拼接错误）；PATH 分隔符 `:` → 平台感知 `;`；多个 `require.resolve` 兼容
- **PR #70 post-review hardening**（1.6.206）：plugin 加载路径多项防御强化
- **部署后陈旧 chunk 自愈**（1.6.215）：server cache + lazy reload 修复"点 .md 文件偶现 Failed to load module script / Failed to fetch dynamically imported module"
- **Proxy Profile per-workspace 隔离**（1.6.200）：拆两层存储——`~/.claude/cc-viewer/profile.json` 仅 profiles 列表（全局共享，watchFile 跨进程 CRUD），`<projectDir>/active-profile.json` 仅 `{activeId}` 独占 workspace；多 workspace 热切换互不覆盖
- **AppHeader 主题切换 pill-style button**（1.6.200）：从 antd Switch 改为 56×30 原生 button + `role="switch"` + `aria-checked` + 太阳/月亮 SVG 切换；QR 码入口与 themeToggle / compactBtn 同高 30px 对齐
- **CountryFlag 组件抽出**（1.6.200）：从 AppHeader 右侧 18px emoji 迁到 footer 左下；字号 13px + `AbortSignal.timeout(5000)` 防悬挂；ipinfo.io 失败隐藏
- **a11y 键盘可达**（1.6.200）：QR + CountryFlag `<button>` 包裹 + `:focus-visible` 轮廓；Popover trigger 改 `['hover','focus']` Tab 聚焦即展开
- **热切换诊断日志去 apiKey 明文**（1.6.200）：`CCV_DEBUG_HOTSWITCH` 分支只输出 `authSet/xApiKeySet/matchedAuthKey/matchedXApiKey` key 名，不输出任何 key 片段（审计工具 sk- 模式不再误报）
- **Auth 替换纯函数抽取**（1.6.200）：抽 `_replaceProxyAuthHeaders`（内部，不 export），`toLowerCase()` 匹配任意大小写 `authorization` / `x-api-key`，两者都不存在时强制植入 `x-api-key`
- **测试覆盖**：1100+ → 1568 用例累计（含 `proxy-profile-isolation.test.js` 228 行 + `proxy.test.js` 11 用例 + `synthetic-classification.test.js` 9 用例）

## 1.6.0 ~ 1.6.199 版本汇总 (1.6.0 ~ 1.6.199 Version Summary)

> 以下为 1.6.0 ~ 1.6.199 所有版本的功能/修复摘要，详细变更记录已归档至 git 历史。
> Below is a condensed summary of versions 1.6.0 ~ 1.6.199. Full per-version detail lives in git history.

### 1.6.180 ~ 1.6.199 (2026-04-20 ~ 2026-04-23) — Synthetic 请求识别、Skill 管理、UltraPlan 强化、xterm 兼容修复

- RequestList 新增 `Synthetic` 类型识别 Claude Code 合成调用（Recap/Title/Compact/Topic/Summary 5 类白名单 + `tagMuted` 弱化样式）
- AppHeader 工具弹层接入「已载入 Skill」分组 + Skill 管理 Modal：CRUD 切换 user/project skill 启用态，4 色徽章 + 响应式 width，写入 `~/.claude/skills` / `<project>/.claude/skills`
- FileExplorer 支持批量文件夹拖入保留目录结构（`webkitGetAsEntry` 递归 + 深度上限 32 + 1000 文件二次确认 + 并发 3 + `wx` 独占写防 TOCTOU）
- Team 会话面板状态收敛：`endReason` 四值 + `team-runtime.js` fs 探测 + `POST /api/team-status`，消除永久 `⏱` 中间态
- UltraPlan：`+` 按钮迁出 header 改 `.variantRow`，许愿机弹层补图片缩略点击放大 + × 二次确认 + hover 蓝框 + 22×22 触控
- 撤回 `CLAUDE_CODE_NO_FLICKER=1` 默认注入（销毁 scrollback 副作用），保留 `CLAUDE_CODE_DISABLE_MOUSE=1` 保住文本选中
- 终端 Shift+Enter 换行改走 `\x1b\r` 对齐 Claude Code 2.x 官方约定，配合 `preventDefault + stopPropagation` 关闭 textarea 默认 LF 路径
- 图片上传 2000px 防线修复：删除字节回退 + 去掉 `RESIZABLE_TYPES` 白名单 + HEIC/AVIF/GIF/BMP 一律转 JPEG
- xterm.js 6.0.0 `requestMode` TDZ 修复：`vite.config.js` 切到 `terser` + `mangle: false`（Vite 顶层 esbuild 不传 build minify 阶段）
- iOS 权限面板坐标修复：用 `visualViewport.height` 替代 `window.innerHeight`（iOS Safari 忽略 `interactive-widget=resizes-content`）
- CustomUltraplanEditModal mobile 双 modal 堆叠修复：`zIndex={1200}` + 父 UltraPlan 自动关闭，编辑期间单 modal
- 接收陈旧消息修复 + 测试增强：1024 → 1180 绿用例累计

### 1.6.160 ~ 1.6.179 (2026-04-15 ~ 2026-04-20) — SSE 流式打字机、claude --thinking-display 兼容、CLAUDE_CONFIG_DIR 全链路、麦克风语音、模型头像稳定

- SSE 实时打字机覆盖：MainAgent 流式 chunk 通过 `/api/stream-chunk` POST → SSE `stream-progress` 事件 → ChatView Last Response 位 inline `▌` cursor，rAF 合批 + `React.startTransition`
- 流式渲染性能：增量 markdown `splitFrozenTail` 仅重渲尾段 + `_mdCache` LRU + Vendor chunk split（`vendor-codemirror` / `vendor-antd` 等 8 组），app chunk 3.2MB → 827KB
- 发送按钮 spinner 主线程提升修复：拆 HTML div 显式像素尺寸 + `will-change: transform` 让 Blink 提升 compositor 层
- `claude --thinking-display` 反应式回滚：`pty-manager.js` 维护 `_thinkingDisplayRejectedPaths: Set`，crash 时按 `outputBuffer` 匹配未知 option 自动重试无 flag，替代版本号探测
- `CLAUDE_CONFIG_DIR` 6 处真实运行时路径迁移（Electron theme watcher / findcc / ensure-hooks / preferences API / TerminalPanel agentTeam tooltip），新 `tc()` i18n wrapper 注入 `{configDir}` 占位
- ccv 启动 claude 默认带 `--thinking-display summarized`（Opus 4.7 thinking 默认关闭后兼容）
- Custom UltraPlan Expert：用户自定义专家模板，CRUD + `+` 按钮 + 跨组件 `ccv-presets-changed` 同步
- ChatInputBar 麦克风语音输入：`webkitSpeechRecognition` BCP47 自动跟 UI 语言，IME-safe，HTTPS/secure context 检测，`interimPreview` 绝对定位浮在 textarea 底部
- ChatView 头像稳定 3 重修复：`getModelInfo` Map memo + `modelNameByReqIdx` carry-over + `resolveModelInfo(ts)` 闭包，多模型会话 per-message 头像准确
- iPad 模式响应式扩展（`?ipad=1`）：iOS Safari 走 `transform:scale` 非虚拟化路径绕开 `minimumLogicalFontSize` 9px 钳制
- Claude logo 流式 wave 动画 + 单色 logo 浅色主题 `currentColor` 修复（GLM/Kimi/MiniMax）
- `ccv` Claude Code 2.x 兼容：扫描 `bin/claude.exe` + 平台 optional dep `@anthropic-ai/claude-code-darwin-arm64`，老 npm hook 自愈到 native hook
- 多 repo Git 支持、iPad 拖拽上传、移动端文件浏览器三层体验补齐
- ToolApprovalPanel 锚定到输入条顶边（`position: absolute; bottom: 100%`），手机端通过 `--chat-input-bar-height` CSS var 跟随
- 测试覆盖：964 → 998 绿用例累计

### 1.6.130 ~ 1.6.159 (2026-04-09 ~ 2026-04-15) — 多 Tab Electron、浅色主题、SDK 集成、自动审批、Workspace 模式、UltraPlan 体系

- Electron 多 Tab 架构：BaseWindow + WebContentsView，每 Tab 独立 fork() 子进程（proxy/server/PTY 隔离），Cmd+T/W/1-9 快捷键，常规启动/免审启动双按钮
- 浅色主题（雪山白）全套：`[data-theme]` + ~50 语义 token + 31 组件 CSS 变量化 + Antd ConfigProvider/CodeMirror/xterm 主题适配
- Agent SDK 集成：`lib/sdk-adapter.js`/`sdk-manager.js` 跑 Claude 不走 PTY，SDK plan/AskUserQuestion/canUseTool 走 WebSocket
- 工具审批面板：Bash/Write/Edit/NotebookEdit 走 PreToolUse hook bridge → web UI 审批，多设备同步 `*-resolved` 广播 + 队列 `+N queued` 徽章
- 自动审批倒计时：按模型族（Claude/OpenAI 3s、Gemini/DeepSeek/Qwen 5s、GLM/Kimi/MiniMax 10s），off/3/5/10/15/20/30/60s 可配
- Workspace 模式登录页 + Electron 多项目切换 + auto add `-c` 续会
- UltraPlan 体系完工：代码专家/调研专家 pill 切换，`+` 自定义专家，许愿机 modal/popover 双入口，文件/图片上传，`<system-reminder>` 自动包裹 + scoped instruction 限制扩散
- Markdown 操作条：复制/导出 .md/保存为图片（html2canvas）/保存到项目，hover 触发 + 节流 + actionBar 移到气泡外右侧 column 布局
- 移动端革新：底部 hamburger 菜单 + 文件浏览器 overlay + Git Diff 全屏 + iPad pad-mode 两栏 + 上下文血条铺到手机
- Markdown action bar 收纳复制按钮进下载菜单（避免覆盖 + 132 行 i18n 新 key）
- 多 repo Git 探测（项目根 + 一级子目录）+ 图片预览 + 行数 `+N -M` 徽章（含 untracked 文件）
- 主题快切（雪山白/曜石黑）+ Claude Code `/theme` PTY 命令同步 + 终端自动 focus 反馈
- File Explorer 拖拽移动 + 系统拖入导入（`/api/import-file` + 自动展开 hover 500ms）
- ImageLightbox：滚轮缩放 / 双击切换 fit / 拖拽 / iOS 安全区，对话/diff/markdown 多入口接入
- 自定义用户名/头像 CLI（`--user-name` / `--user-avatar`，本地 png/jpg/gif/webp ≤2MB 或 http URL）
- macOS 代码签名/公证（entitlements + notarize 脚本，超时降级为跳过保 CI 60min 内）
- Mermaid 渲染 + DOMPurify svg profile + 主题切换重渲

### 1.6.100 ~ 1.6.129 (2026-04-05 ~ 2026-04-09) — 自动审批基建、流式打字机预备、Mobile 增量加载、CSS 颜色统一

- 简化工具显示模式：默认折叠工具调用为紧凑 tag，Edit/Write/Agent/TaskCreate/EnterPlanMode/ExitPlanMode/AskUserQuestion 保留全展示，hover popover/click popover
- 终端 Shift+Enter 换行 + Ctrl+C 双击拦截 + bracketed paste 单块粘贴
- AskUserQuestion `PreToolUse` hook bridge：`/api/ask-hook` 长轮询 + WebSocket 路由，结构化答案绕开 PTY 模拟，超时 30s 自动恢复
- Tool 审批面板首版（Bash/Edit/Write/NotebookEdit）：黄色虚线动画边框，键盘 Tab/Esc 友好，focus 自动恢复
- 移动端 SSE 增量加载：初始 200 条，按 100 条 batch 请求 `/api/entries/page`，session 级冷热分片（8 热 + IndexedDB 冷）
- LRU cache 系列：`renderMarkdown` 1024 / `highlight` 512 / `renderAssistantText` 512，session 级增量 `buildAllItems`
- 流式 spinner / streaming border / loading pet pixel 动画
- iOS 移动版面板互换：聊天主、终端 overlay（Safari 兼容）
- 体感小修补：`mobileVirtuoso` Footer 不重渲（context prop） / 超 240 条 → 0 → race / `_processEntries` 4 pass 合并 / `setState` rAF 节流（500/s → 60/s）
- CSS 颜色 203 → 102（-49%）：rgba/rgb/named 统一 hex，灰/蓝/红/绿/黄合并，inline style 抽到 module
- ToolApprovalPanel 进入聊天区域（`position: absolute` 相对 `messageListWrap`），自动 focus Allow，Esc 拒绝
- Multi-device perm/plan/ask 广播 `*-resolved` + ask-hook 跨设备同步
- 全局设置日志目录：runtime `setLogDir()` + preferences UI + GlobalSettings concept doc 18 语言
- WebFetch/WebSearch 加入 `APPROVAL_TOOLS`，git/npm guard 合并到 perm-bridge 消除 Bash matcher 冲突
- 终端 pending 文件 tag 条 + 多设备同步 + Enter 自动注入路径 + git checkout `??` 改 `git clean -fd`
- KV-Cache popover 重构 builtin/MCP 分组 + ConceptHelp 接入
- File Explorer 右键菜单 7 项（reveal/copy path/rename/delete/new file/new dir/open terminal）+ Git Changes 右键 hover actions
- ipinfo.io 国旗 + 5s timeout 失败隐藏；`/api/import-file` 从 OS 拖文件进项目目录

### 1.6.50 ~ 1.6.99 (2026-03-28 ~ 2026-04-05) — Plan/Dangerous 审批、AskUserQuestion 多问、文件浏览器右键、PTY 镜像

- Plan 审批 GUI（ExitPlanMode）：内容预览 + Approve/Edit/Reject 按钮；危险操作（Bash/Edit/Write）琥珀色审批卡 Allow/Deny；权限拒绝红色 `Denied` 徽章
- AskUserQuestion 多问支持：multi-select Other 通过 → + Enter 提交；isMultiQuestion 标记尾问；PTY ↑↓ delay strategy 让 inquirer 重渲
- AppBase 拆分 Mobile/PC entry：动态 import code splitting，`AppBase.jsx` 共享 + `App.jsx`/`Mobile.jsx` 子类
- 文件浏览器：内联 rename（双击/F2）、可点击聊天文件路径跳转 + 自动展开目录树、文件/文件夹右键菜单、删除/`reveal in explorer`/`copy path`/`new file`/`new folder`
- markdown preview toggle for `.md` files + DOMPurify 全链路
- 多设备审批/计划/问答同步 + perm-bridge 白名单反转（只 Bash/Edit/Write/NotebookEdit 走审批）+ 32 单测
- Image Lightbox：PC 滚轮+拖拽+双击；移动端 pinch+拖拽+点击关闭；iOS safe-area
- Native teammate detection：`Agent` 工具子代理改名 `Teammate`，hook context 自动提取名字 + 颜色哈希
- 流式状态 SSE 全链路（`stream-progress`）：聊天输入条 SVG 流光边框 + Virtuoso footer spinner + 5 层渐变
- 终端剪贴板图片粘贴 + Retina 降采样 + 多设备同步 image-upload-notify
- chat textarea image paste + 文件 chip 预览 + 延迟路径注入（send 时拼接而非贴入 textarea）
- iOS Safari 移动布局：`mobileCLIBody` flex 方向修复，键盘安全
- macOS 系统头像 fallback、文件资源管理器集成（`/api/reveal-file`/`/api/open-terminal`/`/api/create-dir`/`/api/create-file`/`/api/delete-file`/`/api/rename-file`/`/api/import-file`）
- TerminalPanel chat 镜像：`pendingImages` 双向同步，textarea 不污染、send 时注入
- /api/file-raw 路径穿越 + 符号链接保护（realpathSync containment）

### 1.6.0 ~ 1.6.49 (2026-03-18 ~ 2026-03-28) — 增量重构、Teammate 显示、KV-Cache 缓存内容、SSE 心跳

- ChatView 增量重构：`buildToolResultMap` WeakMap O(1) + `buildAllItems` 单 pass + `appendCacheLossMap` append-only + Last Response 独立 state（消除 middle-insertion reflow）
- `_reqScanCache` 拆独立计数器，`isTeammate` WeakMap，`extractTeammateName` per-request cache
- Teammate 显示优化：`Teammate: name(model)` 格式 + 专属 team 图标 + per-name HSL 哈希着色 + 真实姓名从 SendMessage `routing.sender` 提取
- AskQuestionForm 抽组件 + multi-select 本地 state 隔离消除父级 re-render
- `ptyChunkBuilder.js` 纯函数生成 PTY 序列；`writeToPtySequential()` 服务端写队列；`input-sequential` WS 类型
- Mermaid 图表渲染（lazy-loaded ~460KB）+ DOMPurify svg profile + 主题适配
- Proxy Hot-Switch：`fs.watchFile` 动态切换 API URL/Auth/Model 不重启 Claude Code，profile.json 0o600
- 大 JSONL 文件 OOM 修复：服务端不再 reconstruct delta，原始 SSE 推送，前端本地 reconstruct；分块 1MB 读
- 移动端 SSE 增量首版（`since` filter + Map dedup）+ react-virtuoso 虚拟列表（24000 → 2000 DOM 节点）
- 上下文血条：`readModelContextSize()` 解析 `[1m]` 后缀，`watchContextWindow` polling 移除避免跨进程数据污染
- 国家国旗（ipinfo.io）+ drag-drop 文件上传
- SSE heartbeat 30s + 客户端 45s 自动重连（最多 10 次）
- `/api/local-log` 独立 SSE 流隔离 CLI mode + checkpoint 对齐分页
- KV-Cache popover：仅展示 `cache_control` 内容块、tools/system/messages 三段折叠、SubAgent KV-Cache-Text
- File Explorer 内联 rename、点击文件路径跳转、自动展开目录、auto-refresh on Edit/Write 检测
- AskUserQuestion `ensureAskHook` PreToolUse hook 自动注入 `~/.claude/settings.json`，xterm Ctrl+C 双击拦截 i18n toast
- TeamModal hook order violation 修复（早 return 移到 hooks 之后）
- 浅色样式诸多过渡：sticky bottom 按钮位移、虚线动画、xterm 主题, light theme palette 修补

---

## Pre-1.6 版本汇总 (Pre-1.6 Version Summary)

> 以下为 1.6.0 之前所有版本的功能摘要，详细变更记录已归档。
> Below is a condensed summary of all versions prior to 1.6.0.

### 1.5.x (2026-03-08 ~ 2026-03-17) — 上下文血条、CodeMirror 编辑器、交互式审批

- 上下文血条：「当前项目」tag 替换为 context usage 血条（绿/黄/红），statusLine wrapper 脚本捕获 `used_percentage` 推送 SSE；`getModelMaxTokens()` 模型上下文窗口映射；KV-Cache user prompt 点击跳转 + `scrollend` 动画时机 (1.5.24/26/45)
- AskUserQuestion 交互式：聊天面板内渲染 Radio/Checkbox + 提交按钮，支持单选/多选/Other 自定义输入/Markdown preview；已回答自动切换静态卡片；多问题串行 PTY 提交 (1.5.21/39/41/43)
- Plan approval UI：ExitPlanMode 卡片审批/拒绝/反馈按钮，内置默认选项 fallback 无需等 PTY 侦测 (1.5.37/39)
- CodeMirror 6 编辑器：FileContentView 从 highlight.js 迁移到 CodeMirror，支持编辑保存（Ctrl+S + `/api/file-content`）、minimap、自定义 gutter；GitDiff 点击路径跳转对应行 (1.5.3/11/16/22)
- `$EDITOR` / `$VISUAL` 拦截：Claude 编辑请求在 FileContentView 打开，保存关闭继续；服务端 editorSessions Map + WebSocket 广播 (1.5.14)
- CCV 进程管理：列出 7008-7099 端口所有实例，PID/port/命令/启动时间展示，UI 停止闲置进程；`GET /api/ccv-processes` + `POST /kill` 带安全校验 (1.5.12)
- CLI 透传改造：`ccv` 成为 claude drop-in 替换，参数直传；`ccv -logger` 独立安装 hook；`-v/-h/--version/--help` 绕过 hook；`--d` = `--dangerously-skip-permissions`；注入 Claude PID 到 `onNewEntry` (1.5.19/23/25)
- 移动端性能与体验：IndexedDB 本地缓存 + 7 天过期；消息列表分页 (末尾 240/300 + load more)；SSE 增量加载 (`since/cc` metadata) ；User Prompt 查看器 + 导出；长 bash 自动折叠；stick-to-bottom 按钮 2x 尺寸；display 设置进 mobile menu (1.5.0/5/8/10)
- iOS 专项：终端从 WebGL 降级 Canvas 解决严重卡顿；`visualViewport` + fixed positioning 修复键盘顶起导航栏；`interactive-widget=resizes-content` viewport meta；scrollback iOS=200 / Android=1000 / Desktop=3000；虚拟按键栏 touchstart preventDefault + 按键后 blur，消除按键误触发虚拟键盘 (1.5.7/17)
- Terminal 增强：文件上传按钮（PC 工具栏 + chat input）50MB 限制 + 唯一文件名；bracketed paste (`\x1b[200~`) 阻止多行粘贴误触发 submit；`ultrathink` 按钮；大写入分 32KB 跨帧避免主线程阻塞；outputBuffer ANSI 安全截断 (1.5.4/15/31/42)
- Log 管理：下载/批量删除日志（`/api/download-log`、`/api/delete-logs`）；Log 列表 List→Table 可排序；JSONL 紧凑格式 + MAX_LOG_SIZE 200MB→150MB + 合并 API 300MB 上限；Preview 列 Popover（hover/click）带 stats-worker v6→v8 缓存失效 (1.5.1/5/18/37/40)
- Git/File 联动：Claude 写操作后（Write/Edit/Bash/NotebookEdit）自动刷新 FileExplorer 和 GitChanges；Git U 状态绿标替换 `??`；侧边栏文件夹/Git 按钮改 toggle (1.5.22/27/29)
- 插件 API：`httpsOptions` hook (waterfall) 替换硬编码 HTTPS cert；`serverStarted` hook 新增 `url/ip/token`；`/api/local-url` 尊重实际协议；`proxy-errors.js` / `proxy-env.js` 移入 lib/ (1.5.21/32)
- 修复与回归：`watchLogFile()` 初始化 `lastSize` 修复重启重复广播；`proxy-errors.js` 补进 npm files array；`installShellHook` 内容比对替换过期 hook；SSE clients 数组 mutate-in-place 修复断连后失联；`claude -v/-h` 正确透传；QR popover 自适应宽度；DiffView 固定 gutter + 背景全宽；ConceptHelp dark-theme 修复 (1.5.2/6/9/20/30/34)
- 测试与覆盖率：覆盖率 line 68.98%→71.23%、branch 69.17%→72.81%；新增 `test/git-diff / log-watcher / findcc / context-watcher / upload-api / proxy-errors / updater / stats-worker` 系列单测；`npm run test:coverage` 脚本 (1.5.29/31)

### 1.4.x (2026-03-02 ~ 2026-03-07) — CLI 模式与终端集成

- CLI 模式 (`ccv -c`)：内置 PTY 终端直接运行 Claude，支持 npm/nvm 安装路径自动检测
- 分屏布局：终端 + 对话双面板，可拖拽调整比例
- 文件浏览器：树形目录、文件内容预览、minimap、支持 dot files 和 gitignore 灰显
- Git 集成：变更文件列表、统一 diff 视图（双行号）、diff minimap
- 工作区管理：多工作区切换、SSE 状态同步
- 插件系统：动态加载/卸载、启用/禁用状态管理
- 自动更新器：版本检测与自动升级
- 终端优化：WebGL 渲染 + context loss 恢复、Unicode11 CJK 支持、WebLinks、scrollback 扩容、PTY 输出批量合并
- SSE 分块加载：大日志文件分 50 条 chunk 传输，带进度指示
- 安全：LAN 移动端 token 鉴权修复
- 卸载命令 (`ccv --uninstall`)：完整清理 hooks 和配置

### 1.3.x (2026-02-28 ~ 2026-03-02) — 移动端适配与国际化

- 移动端响应式：虚拟按键栏、触摸滚动惯性、固定列宽自适应字号
- 国际化 (i18n)：支持 18 种语言（中/英/日/韩/法/德/西/葡/俄/阿/印/泰/越/土/意/荷/波/瑞典）
- 代理模式 (proxy)：拦截 Claude API 流量并记录
- 设置面板：主题、语言、显示选项等可视化配置
- 对话模式增强：thinking block 折叠/展开、工具调用结果渲染优化
- 安全：访问 token 认证、CORS 配置

### 1.2.x (2026-02-25 ~ 2026-02-27) — 对话模式

- Chat 模式：将原始 API 请求/响应重组为对话视图
- Markdown 渲染：代码高亮 (highlight.js)、表格、列表
- Thinking blocks：可折叠的模型思考过程展示
- 工具调用结果：结构化渲染 tool_use / tool_result
- 搜索功能：全文搜索对话内容
- 智能自动滚动：仅在用户位于底部时自动跟随

### 1.1.x (2026-02-25) — 数据统计面板

- Dashboard：请求统计、模型用量图表、token 消耗分析
- 缓存重建分析：按原因分类统计（TTL、system/tools/model 变更、消息截断/修改）

### 1.0.x (2026-02-24 ~ 2026-02-25) — 请求查看器

- Request/Response 详情查看器：原始请求体、响应体、流式组装
- 缓存重建分析：精确识别 system prompt / tools / model 变更原因
- Body Diff：JSON/Text 视图切换、复制按钮
- 双向模式同步：Chat ↔ Raw 模式跳转定位
- Claude Code 工具参考文档（22 个内置工具）

### 0.0.1 (2026-02-17) — 初始版本

- 拦截并记录 Claude API 请求/响应

