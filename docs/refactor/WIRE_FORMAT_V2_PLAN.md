# 日志存储架构治理：Wire Format v2（会话化 + 去重）跨 session 分步实施计划

> 本计划经 4 个探索 agent（写入端/读取端/客户端/风险测试）+ 3 个评审 agent（完整性/风险回滚/事实核查）交叉验证，全部 file:line 断言已核实。

## 步骤状态表（每步 commit 时更新本表——仓库是进度真相源）

状态图例：⬜ 未开始 ｜ 🔄 进行中 ｜ ✅ 完成（附日期 + commit）

| 步骤 | 内容 | 状态 | 日期 | commit | 下一步动作备注 |
|---|---|---|---|---|---|
| S-1 | 跨 session 追踪落地（本文档 + 记忆指针） | ✅ | 2026-07-13 | c88d704 | — |
| S0 | 协议定稿 docs/refactor/WIRE_FORMAT_V2.md | ✅ | 2026-07-13 | 0b5a87d | 用户评审通过 |
| S1 | 共享边界+逆锚模块（clearCheckpoint 迁移 + findReverseAnchor 抽取） | 🔄 | 2026-07-13 | | 实际只改 2 个消费方（shell 使 contentFilter/entry-slim/sessionManager 免改，属计划预期内收窄）。评审 P2 backlog：docs/WIRE_FORMAT.md:46/:170、sessionManager.js:552/:555、test/entry-slim.test.js:906、test/session-boundary-parity.test.js:12 的"函数老家"注释应改指 session-boundary.js；WIRE_FORMAT.md §6 维护责任补 canonical home——并入 S2 或 S9 文档轮 |
| S2 | v2 核心库 server/lib/v2/*（纯新增不接线） | ⬜ | | | 依赖 S0 schema 定稿 |
| S3 | 双写接入（writeEntry seam + CCV_WIRE_V2，默认关） | ⬜ | | | 回滚=CCV_WIRE_V2=0 |
| S4 | 一致性校验工具（ccv verify）+ ≥5 活跃日双写验证（人工闸门） | ⬜ | | | 五项方法论逐日记录于此表下方 |
| S5 | v2→v1 适配读层（CCV_WIRE_V2_READ，默认关） | ⬜ | | | 回滚=CCV_WIRE_V2_READ=0 |
| S6a | 列表/管理/寻址切换（listLocalLogs、workspace-registry、download 契约） | ⬜ | | | |
| S6b | live watcher + IM 接入（最高风险，单列） | ⬜ | | | v1 watcher 并行保留 |
| S6c | 统计与残余（stats-worker 重键、死代码退役） | ⬜ | | | |
| S7 | 客户端原生 v2（7a 数据通道 / 7b 复杂度收敛） | ⬜ | | | IndexedDB 新 object store |
| S8 | v1→v2 转换工具（ccv convert，存量 4.2GB，严格只增） | ⬜ | | | 默认 dry-run |
| S9 | v1 写入下线 + 收尾 + 一次性发版 | ⬜ | | | publish 前征询用户 |

**恢复协议**：新 session 开始 → 读记忆 `wire-format-v2-progress.md` 指针 → 读本表找到第一个非 ✅ 步骤 → **先跑上一完成步的 named tests 确认仍绿** → 再开工。步骤内中断：状态记 🔄 + 在"下一步动作备注"写明断点。

### S4 双写验证日志（验证期逐日追加）

（尚未开始）

## Context

cc-viewer 把拦截到的 Claude API 报文写入单一 JSONL（`\n---\n` 分帧，250MB 轮转），实测 4.2GB/16 文件。301MB 典型文件成分：mainAgent 周期 checkpoint 37% + subAgent 无 delta 且双写 43% + mainAgent delta 20%；每条 entry 的 `body.tools`(~125KB)+`body.system`(~12KB) 全量重复（145KB 的 delta 中 126KB 是不变的工具定义）。净信息量 15–25MB，**目标缩减 >90%**。

用户决策：**① 全部完成后一次发版**（中间只 commit main，不 publish 不动版本号）；**② 双写过渡**（v1 写入直至最后一步不动，v2 旁路落盘、真实数据对比验证后才切读端）；**③ 提供 v1→v2 转换工具**。实现跨多 session，进度打标追踪。

## 关键事实（已核实，含评审修正）

**身份与键控**
- session_id 藏在 `body.metadata.user_id`，**有两种编码并存**：新版 CC 是 JSON 字符串 `{device_id,account_uuid,session_id}`；旧版（存量 4.2GB 中存在）是下划线分隔 `user_<hash>_account__session_<uuid>`，`JSON.parse` 会失败。**解析器与转换器必须兼容两种**（先 JSON.parse，失败则按 `_session_` 段切）。
- session_id 每 CC 进程唯一、**跨 /clear 稳定**（实测同 sid 下 90+ 个 /clear checkpoint）→ 两级结构：session（进程）→ conversation epoch（/clear 分段）。`/compact` 不换对话（continuation 判别）。同一 session 实测跨越 v1 轮转边界 → 按 session 分目录天然消灭 §3.6 race。heartbeat/countTokens **无 metadata**（实测 0/332 带 meta）→ 兜底路由到进程当前 sid。
- 边界谓词已存在且客户端安全：`src/utils/clearCheckpoint.js`（自称"无依赖"，已导出 isPostClearCheckpoint/isCompactContinuation/isSessionBoundary），被 sessionManager/sessionMerge/entry-slim/contentFilter 消费；big-drop 公式 4 处副本中 **entry-slim 的 3 处是故意分化的（restore-guard），不得盲目统一**。§3.1/§3.2 窗口目前只靠 `sessionMerge.findReverseAnchor` 解决。
- subAgent spawn 注册表按 prompt 前 60 字符键控（`interceptor-core.js:27-41`），并行同 prompt 会碰撞；Agent tool_use 块的 `block.id` 在响应 content 里存在但被丢弃 → v2 改用 tool_use.id 键控（已核实可行）。
- teammate 独立进程、有自己 session_id，但写 **leader 的日志**（`interceptor.js:349-357`），条目可双标；proxy 模式 teammate 可能无 `teammate` 字段（§3.7 L104 已知未解，本重构不解决，归 leader 流并文档化）。

**写入端**
- 落盘点 = **1 placeholder（:856）+ 5 完成/错误（:1095/:1106/:1191/:1220/:1225）共 6 处**，全部写完全物化 entry → 收敛为 `writeEntry()` seam。**rotation sentinel（:530-537，创建文件时原子落盘）不进 seam**，v2 journal 首帧同样要创建即原子写。
- delta 在 :839 原地改写 `body.messages` 为 slice → v2 tap 用 :773 捕获的 `messages` 局部变量（改写前原始数组）；tools/system 从不被改写（proxy 改写只碰序列化副本），可安全哈希。
- `_seq` 在请求发起同步段赋值（:781-782，`!_isTeammate`）→ journal seq 必须同点赋值，否则复活 §3.7。
- `AsyncWriteQueue` 已按 path 分组 drain、空 path 静默 no-op（保留）；**无 fsync、错误裸吞**（:56/:78，违反 reportSwallowed 约定，v2 修）；append 非阻塞（请求路径零延迟），但同队列有 HOL 排队 → journal 可考虑独立队列实例（P2）。
- 生命周期挂点：`resolveResumeChoice`(:230)/`initForWorkspace`(:410)/`resetWorkspace`(:464)/`checkAndRotateLogFile`(:519)；`_temp.jsonl` 暂存→改名约定（:247/:395，IM watcher 显式排除该后缀）需在 S3 声明 v2 等价物。
- live-stream 是附加投递非磁盘替代 → v2 在完成写点 ingest；stream-progress timestamp 必须 == 最终条目 timestamp。
- 现有 flag 先例：`CCV_DISABLE_DELTA`(:271)、`CCV_DISABLE_TAIL_FP_CHECKPOINT`(:274)。

**读取端（服务器）**
- 主 seam = `log-stream.js` 两 generator（:25/:67），全部流式 endpoint 建立其上，喂同样的"逐条 raw JSON 字符串"即可 ~80% 零改动。
- 旁路读取：`log-watcher._readDelta`(:134, live tail，最高风险)、`stats-worker.parseJsonlFile`(:143)、`logs.readHeadRotationContext`(:213)，以及**死代码退役清单**：`readLogFile`/`readLocalLog`/`migrateConversationContext`（三者零调用方）。
- 计划此前遗漏的消费方（评审补）：**`workspace-registry.getWorkspaces`(:97-107) 按 `*.jsonl` glob 计数**；**IM worker 体系**（`LOG_DIR/IM_<id>/*.jsonl` + `im-log-watcher.js` + `im.js:259 findRecentLog`）；`downloadLog` 的 `format=raw|rebuilt` 契约。
- `delta-reconstructor.js`（CLIENT-SAFE，AppBase.jsx:24 与 ImConversationModal.jsx:8 浏览器端 import）与 `teammate-detect.js` 零改动。无 `_deltaFormat` 的条目被当 checkpoint 透传（:34）——两种 envelope 策略都可行。
- stats-worker 缓存按 size+mtime → v2 按 journal offset 重键。读端 `${timestamp}|${url}` 去重与 blob 去重正交，都保留。
- `workflow-live.js` 已占用 "journal.jsonl" 文件名（ultraAgent 运行日志，不同路径无冲突）——S0 文档做一行消歧。

**客户端**
- delta 重建在浏览器端；冷批量/live SSE 两路径有 parity 测试。适配器逐字段契约：`${timestamp}|${url}` 键、`mainAgent`/`teammate` 双标、`inProgress`、user_id 原样、`_isCheckpoint` /clear 语义、`_inPlaceReplaceDetected` 成对、哨兵条目；绝不发 `_staleReorder`/`_reconstructBroken`。
- tools/system 全量渲染 + 相邻请求 tools-diff（`ContextTab.jsx:378-427`）；`entry-slim.js:237` 历史回归 = blob 层同类风险的现成探测器。intern 池（`_toolsPool`/`_systemPool`）可复用为 ref 解析缓存。按需加载先例：`loadColdSession`/`loadMoreHistory`。
- IndexedDB（移动多标签）是 v1 形状 → S7 用**新 object store** 且受读侧 flag 门控（服务端回滚无法回滚客户端库，F11）。

**约束**
- Node `>=20.14`（排除 node:sqlite，维持纯文件）。测试 `node --test` 两档（test / test:cli=CI）；无 .jsonl golden fixture；本机 stub 首执行 ~3s 慢（flaky 记忆）。`files` 数组：`server/` 已覆盖，新顶层文件须显式加。数据丢失 catch → `reportSwallowed`；i18n 双文件；history.md；English comments；commit/publish 先征询用户。无磁盘空间守卫（grep 0 hits）。

## 核心设计决策（评审 P0 裁决）

1. **【F6 裁决】对话文件存 wire 事件（增量日志），物化放读侧。** 每行 = 一次 API 事件带来的新增 messages 切片或控制行（clear-epoch/compact-continuation/replace-tail），**每行携带发起 seq + requestId**（F8：物理落盘序 ≠ seq 序，读侧凭 seq 还原）。理由：写侧保真（存 wire 原貌，仅 blob 去重），写侧错误可事后在读侧修复；物化写（materialized）会把 reverse-anchor/merge 逼进写路径，一错即永久损坏。**S7 的承诺相应调整**：浏览器端复杂度（重建/逆锚合并/边界启发式）迁移为**一处共享物化器**（服务端/共享模块），从浏览器删除但不从代码库消失；按对话隔离使其大幅简化。
2. **【F7】S1 共享模块除边界谓词外必须包含 `findReverseAnchor`**（§3.1 plan-mode 短窗口、§3.2 K 尾重叠的唯一解法），物化器依赖它。
3. **【F1/F2】写序与目录协议**：`mkdirSync(recursive)` 先于首次 enqueue（异步 mkdir 会输给 microtask drain → ENOENT 被吞）；写序 blob →（fsync blob）→ conversation 行 → journal 行最后落；崩溃只留孤儿 blob，不留悬空引用；读侧容忍暂缺（pendingTail 思路）。**fsync 加在 blob/关键屏障上，不是 journal**。
4. **【F9】双 kill switch**：`CCV_WIRE_V2`（写）与 `CCV_WIRE_V2_READ`（读）独立，读侧默认 v1 直至验证通过；任何时刻可各自回退。
5. **【F15】teammate 归属**：v2 下 teammate 会话进自己的 session 目录，meta 记 leader sid + agentName；**适配器读取时按 leader 视图 re-join**（v1 的 leader 文件含 teammate 条目，S4 对比必须先做同样的 join，否则结构性误报掩盖真 bug）。
6. **【F13/F10】真实数据安全**：findcc.js L1 屏障只在测试上下文生效；生产路径新增独立防护——目录操作白名单（仅允许 session-dir 契约内路径，convKey 组件白名单防注入 F14）、destructive 操作走回收站式软删、转换器**严格只增**（绝不 unlink/改写 v1 树，默认 dry-run，验证期输出到独立根目录）。

## v2 存储格式（S0 定稿骨架）

```
LOG_DIR/<project>/sessions/<session_id>/
  meta.json          # 创建即原子写：project、instanceId(pid)、leaderSid/agentName(teammate)、cc 版本、_wireFormat:2
  journal.jsonl      # 轴心：每 API 事件一行，发起时定 seq：
                     # {seq, requestId, tsReq, tsDone, duration, convKey, epoch, kind(main|sub|teammate|heartbeat|countTokens|misc),
                     #  status(inflight|done|error), url, model, msgFrom, msgTo, blobs:{tools,system}, usage 摘要, boundary?}
  conversations/<convKey>/e<N>.jsonl  # wire 事件行：{seq, requestId, msgs:[新增切片], ctl?}（ctl=replace-tail 等控制行）
  responses/<seq>.json                # response body（S0 决策：独立文件 vs 并入 journal）
  blobs/sha256-<hash>.json            # tools/system CAS（session 内局部）
```
- convKey：`main`；`sub-<tool_use.id 前 12>`（fallback 首 user msg 指纹）；组件白名单过滤。placeholder 不带 body（journal inflight 行）。周期 checkpoint 删除；/clear=新 epoch；/compact=控制行。inflight→done 的 journal 更新策略（追加第二行 vs 改写）S0 定。

## 分步计划

每步完成标准 = 自动化测试绿 + 处于可暂停态。S3 起须声明该步回滚路径。

### S-1 跨 session 追踪落地（计划批准后立即）
- **进度表放仓库**：`docs/refactor/WIRE_FORMAT_V2_PLAN.md`（本计划全文 + 步骤状态表：步骤｜状态 ⬜/🔄/✅｜日期｜commit｜下一步动作），每步 commit 时更新——仓库是真相源（压缩上下文/记忆召回失败时可自恢复）。
- **记忆只存断点指针**：`wire-format-v2-progress.md`（type: project）：一行"resume at S<N>" + 计划文档路径 + 关键 flag 名；加 MEMORY.md 索引。
- **恢复协议**：session 开始 → 读记忆指针 → 读仓库计划状态表 → **先跑上一完成步的 named tests 确认仍绿** → 再开工。

### S0 协议定稿（纯文档）
`docs/refactor/WIRE_FORMAT_V2.md`：完整 schema（含 journal 行、wire 事件行、控制行、meta）、寻址/URL 新契约、v2→v1 适配逐字段映射表、§3.1–§3.7 逐窗口对策（§3.1/§3.2→读侧逆锚物化；§3.3→控制行；§3.4→epoch；§3.5→continuation 控制行；§3.6→消除；§3.7→发起 seq）、写序/fsync/mkdir 协议、双编码 user_id 解析规范、teammate re-join 规则、IM worker 决策（初期 IM 进程 `CCV_WIRE_V2=0` 固定 v1，S6b 一并接入）、`downloadLog` v2 契约（rebuilt=适配器合成 jsonl；raw=session 目录 zip）、与 workflow-live 的 journal.jsonl 消歧、保留期策略（v1 存量与双写副本的清理由用户 S9 后决策）。完成标准：用户评审通过。

### S1 共享边界+逆锚模块（v1 行为零变化）
- `src/utils/clearCheckpoint.js` **移动**（非重写）为共享模块（`server/lib/session-boundary.js`，src 侧留 re-export 壳），沿 delta-reconstructor CLIENT-SAFE 先例；**entry-slim 3 处故意分化的副本保持原样**（只换 import 源，不统一公式）。
- `sessionMerge.findReverseAnchor` 同步抽入共享模块（供未来物化器用），客户端改 import。
- 消费方全覆盖：sessionManager/sessionMerge/entry-slim/contentFilter。
- 测试：现有 parity 测试全绿 + 新增共享模块单测。文件：新 `server/lib/session-boundary.js`；改 4 个 src/utils 消费方；新 `test/session-boundary.test.js`。

### S2 v2 核心库（纯新增，不接线）
- `server/lib/v2/`：`layout.js`（路径契约/白名单/meta 原子创建/mkdirSync 前置）、`blob-store.js`（CAS + fsync 屏障）、`journal.js`（发起序 seq、inflight→done 策略）、`conversation-store.js`（wire 事件行 + seq 佩戴 + 控制行 + epoch 切分）、`identity.js`（**双编码 user_id 解析**、convKey：tool_use.id 优先/指纹 fallback/兜底、teammate meta）、`v2-writer.js`（编排 + 写序协议 + reportSwallowed + 磁盘空间守卫 + AsyncWriteQueue 显式 path 变体）。
- `async-write-queue.js`：加显式 path append 变体（保空 path no-op）；评估 journal 独立队列实例（HOL，P2）。
- 单测：崩溃截断、并发、无 metadata 兜底、同 prompt 并行 subAgent（tool_use.id）、/clear→epoch、/compact→continuation、双编码解析、路径注入拒绝。完成标准：单测全绿，interceptor 零改动。

### S3 双写接入（v1 逻辑不改）
- 6 个落盘点收敛 `writeEntry()`（sentinel 不进 seam）；在 :839 前用 :773 的 `messages` 原始引用喂 v2；`CCV_WIRE_V2=1` 开启（默认关）；v2 失败 `reportSwallowed('v2-write')` 绝不影响 v1；journal seq 与 `_seq` 同一同步段；生命周期挂点接 v2 session 切换；声明 `_temp.jsonl` 的 v2 等价物（v2 无重放暂存需求→明确记录"无需等价物"或设计之）；ENOSPC 前置检查。
- **自动化完成标准（评审 #9）**：内联 fixture 驱动双写测试——断言 v2 目录形状正确、v2 写故障不影响 v1、现有 interceptor 全系测试不动全绿。**soak（本机日常开双写）单独标记为人工闸门，跨到 S4**。
- 回滚：`CCV_WIRE_V2=0`。

### S4 一致性校验工具 + 双写验证期（人工闸门）
- `server/lib/v2/verify.js` + **`ccv verify` CLI 子命令**（cli.js 挂接，npm script 仅是别名——npm 全局用户无源码仓库）。
- **闸门方法论（修 F12 盲区）**：① 会话级块指纹对比（沿用 fp 规则）；② **逐请求 tools/system 字节级对比**（blob 归属回归探测）；③ **live 增量轨迹对比**（对 watcher 喂出的中间态序列 diff，非只比冷态终值）；④ teammate 先做 leader re-join 再比（F15）；⑤ inflight/error 行数核对。
- 捕获一份**脱敏小型真实数据 fixture 提交 test/**（评审 #10），S5/S8 golden 可在新 session/CI 复现。
- 完成标准：连续 ≥5 个活跃日按上述 5 项全零差异；每日结果记入仓库状态表。发现差异只修 v2。

### S5 v2→v1 适配读层
- `server/lib/v2/adapter.js`：journal+conversations+blobs → v1 形状 raw entry 流（epoch 起点合成 checkpoint、其余合成 delta+seq、回填 blob、teammate re-join、合成哨兵；内存有界——大 epoch 的 checkpoint 合成流式化，F16）。
- `jsonl-archive.js` 泛化 `resolveLogSource()`；`log-stream.js` 两 generator 分支；受 `CCV_WIRE_V2_READ` 门控（默认关）。
- golden：S4 fixture 断言两源重建全等。完成标准：**直连 URL 人工验证**（`/api/local-log?file=<v2寻址>` 完整渲染 + tools-diff 抽查）；完整 UI 入口留给 S6a。
- 回滚：`CCV_WIRE_V2_READ=0`。

### S6a 列表/管理/寻址切换
- `listLocalLogs` 输出 session 目录项（新寻址契约、meta 归属过滤替代 pid 文件名前缀、双实例并发测试）；**`workspace-registry.getWorkspaces` v2 计数**（走 sessions/*/meta 或 journal 尺寸）；merge/archive/delete 适配（目录 zip；destructive 走软删回收站 + 白名单）；`downloadLog` 按 S0 契约（rebuilt=适配器合成 jsonl / raw=目录 zip）。
- 完成标准：前端可从列表选中 v2 会话端到端浏览（补齐 S5 的 UI 闭环）。

### S6b live watcher + IM 接入（单独一步，最高风险）
- `log-watcher.js` 新增 v2 增量 tail（watch journal+conv 文件 → 现有 `createIncrementalReconstructor` 等价回调）；v1 watcher 并行保留；gap/rotation 系列测试移植。
- IM 体系接入：`im-log-watcher.js` + `im.js findRecentLog` 的 v2 等价（此前 IM 进程固定 v1 的临时决策在此解除）。
- 完成标准：双写下 live 流式从 v2 源驱动，与 v1 源并跑轨迹一致（S4 ③ 方法复用）。

### S6c 统计与残余
- `stats-worker.js` 读 v2（缓存按 journal offset 重键）；`readHeadRotationContext` → meta/journal；退役死代码（readLogFile/readLocalLog/migrateConversationContext）。

### S7 客户端原生 v2（7a/7b 可拆）
- 7a：v2 数据通道（journal 列表 → 按需 conversation/blob，扩展 loadColdSession/loadMoreHistory；blob 解析复用 intern 池）；session 身份切真实 session_id（重接 getSessionStableId/buildSessionIndex/pin/splitHotCold）；**IndexedDB 新 object store + 读 flag 门控**。
- 7b：v2 路径绕过 entry-slim/sessionMerge（物化收敛到共享物化器；v1 legacy 查看走旧路径，代码分叉不删除）。
- i18n 双文件补 key；两路径 parity 测试迁移全绿。

### S8 v1→v2 转换工具（存量 4.2GB）
- `server/lib/v2/convert.js` + **`ccv convert` 子命令**：复用现有 `reconstructEntries` 物化会话再写 v2 事件流（不重实现 wire 语义）；**双编码 user_id 解析**；**严格只增**（绝不动 v1 树，默认 dry-run，先输出独立根目录校验后再入正式位）；幂等+可续传（文件+offset 进度）；空间断言（≥2×源）；单文件流式、RSS 预算（F16）。
- golden：转换后经适配器重建 == 源文件直读重建（S4 方法论全项）。

### S9 v1 写入下线 + 收尾 + 一次性发版
- `CCV_WIRE_V2`/`CCV_WIRE_V2_READ` 默认开，v1 写停（读能力保留）；legacy 路径标注；README 全语言、history.md、`docs/WIRE_FORMAT.md` 标 superseded；v1 存量/双写副本清理方案交用户决策（F5：不擅自删）。
- 全量 `npm run test:cli` + `npm run build`；**征询用户后** commit/publish（此时才动版本号）。

## 风险与缓解（评审后修订）

| # | 风险 | 缓解 |
|---|---|---|
| 1 | 物化写入把 merge 错误永久化 | 【已裁决】存 wire 事件+读侧物化（F6）；逆锚入共享模块（F7） |
| 2 | journal 记完成序复活 §3.7 | seq 发起时赋值；conversation 行佩戴 seq+requestId（F8）；移植 delta-reorder 不变式 |
| 3 | S4 闸门盲区（tools 归属/live 轨迹/teammate join） | 五项方法论（字节级 blob 比对、轨迹 diff、re-join 后比） |
| 4 | 崩溃悬空引用（无 fsync） | mkdirSync 前置；blob→conv→journal 写序，fsync 加在 blob 屏障（F1/F2） |
| 5 | 读侧无独立回退 | `CCV_WIRE_V2_READ` 双开关（F9） |
| 6 | 真实数据破坏（转换器/删除/合并） | 只增不变式+dry-run+独立根目录；软删回收站；路径白名单；L1 屏障不覆盖生产的事实已知（F10/F13/F14） |
| 7 | teammate 归属结构性误报 | 适配器 leader re-join 规则 S0 定稿（F15）；proxy 模式沿现状文档化 |
| 8 | live tail 移植回归 | S6b 单列、v1 watcher 并行、轨迹对比 |
| 9 | 双写磁盘翻倍+ENOSPC 静默 | 空间守卫+reportSwallowed+写侧开关逃生 |
| 10 | 遗漏消费方静默坏死 | workspace-registry/IM/download 契约已入 S6a/S6b/S0；死代码退役清单 |
| 11 | 转换器 4.2GB 正确性/内存 | 复用现有重建器、幂等续传、流式+RSS 预算、golden 全项 |
| 12 | 跨 session 断点丢失 | 进度表入库为真相源、记忆只存指针、恢复协议先验证上步测试 |

## 验证（整体）

1. 每步自动化测试 + `npm run test:cli` 全绿（含 S4 起的脱敏真实 fixture golden）。
2. S4 五项方法论 ≥5 活跃日零差异（人工闸门，逐日记录入库）。
3. 端到端人工点：冷加载、live 流式、session 切换/pin、tools-diff、/clear 与 /compact 边界、teammate 面板、IM 会话、下载（raw/rebuilt）、合并/归档/删除（软删）、workspace 列表计数、移动端。
4. 体积指标：双写期实测 v2/v1 体积比 ≤10%。
5. S9 前完整回归 + 用户验收后才 publish。
