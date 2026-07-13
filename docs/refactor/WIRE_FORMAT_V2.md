# cc-viewer Wire Format v2 协议规范

状态：**草案（S0，待评审）** ｜ 上游计划：`docs/refactor/WIRE_FORMAT_V2_PLAN.md` ｜ 取代对象：`docs/WIRE_FORMAT.md`（v1，定稿后标注 superseded，v1 读取能力长期保留）

本文是 v2 存储的唯一权威定义。实现（S2 起）与本文冲突时，先改本文再改代码。

---

## §1 设计原则

1. **写侧保真，读侧物化**：对话文件存 wire 事件（增量切片 + 控制行），不在写路径做任何 merge/逆锚推断——写侧只做一个廉价判定（前缀延伸测试，与 v1 delta 同级）；一切歧义窗口（v1 §3.1/§3.2）原样落盘为 raw 快照事件，由读侧物化器用共享逆锚模块解决。写侧错误可事后在读侧修复；物化写则一错永久。
2. **journal 是唯一定序轴**：所有顺序问题（v1 §3.7 完成序倒置）收归 journal 的**发起序 seq**；对话文件行佩戴 seq 回指，物理落盘序不承载语义。
3. **append-only + 无 fsync 现实下的写序协议**：blob →（flush）→ conversation 行 → journal 行最后落。**硬保证只有 blob 半边**（journal 行绝不引用不存在的 blob——blob 在 journal 行入队前已持久）；conv 半边是尽力而为的批次分组——多请求同批 drain 时（如冷启动暂存队列冲刷），后一请求的 journal 行可能先于其 conv 行落盘，读侧按 §14 容忍暂缺尾部，属纵深防御而非正确性依赖。崩溃产生的只有孤儿（无引用的 blob/conv 行）与暂缺的 conv 尾。
4. **v2 永不影响 v1**：双写期 v2 任何失败走 `reportSwallowed`，v1 路径零感知。双 kill switch：`CCV_WIRE_V2`（写）/`CCV_WIRE_V2_READ`（读）独立。

## §2 目录布局

```
LOG_DIR/<project>/sessions/<session_id>/
  meta.json          # 创建时原子写（tmp+rename），此后只追加式改写（见 §3）
  journal.jsonl      # 轴心：req/done 两相事件行，append-only（见 §4）
  responses.jsonl    # 每完成请求一行：response body + headers 等大字段（见 §5）
  conversations/<convKey>/e<N>.jsonl   # wire 事件行（见 §6）
  blobs/sha256-<hex16>.json            # tools/system CAS（见 §7）
```

- `<project>`：与 v1 相同的 project 目录名（`basename(cwd)` 清洗后），v1 平铺 `.jsonl` 与 v2 `sessions/` 子目录**共存于同一 project 目录**，双写期互不干扰。
- `<session_id>`：从 `body.metadata.user_id` 解析出的 UUID（§8）；无法解析时的兜底见 §8.3。
- `<convKey>`：`main` ｜ `sub-<tool_use.id 前 12 字符>`（fallback：`sub-fp-<首 user msg 指纹前 12>`）｜ `misc`（countTokens 等无对话归属）。**路径组件白名单 `[a-zA-Z0-9._-]`，超界字符替换为 `_`**（防注入，v1 先例 `interceptor.js:353`）。
- `e<N>`：epoch 文件，N 从 0 起；main 对话在 /clear 边界 N+1（§9.4）；sub/misc 恒为 e0。
- 目录创建：session/conv 首写前 `mkdirSync(recursive)` **同步**执行（异步 mkdir 会输给 write queue 的 microtask drain → ENOENT 被吞）。
- 命名消歧：`workflow-live.js` 的 ultraAgent 运行日志也叫 `journal.jsonl`，位于完全不同的路径体系（session 传输目录），与本格式无关。

## §3 meta.json

创建时一次性原子写入（先写 `meta.json.tmp` 再 rename，v1 rotation sentinel 同款手法，杜绝 watcher 读到半截）：

```jsonc
{
  "wireFormat": 2,
  "sessionId": "a9883ab8-…",
  "project": "cc-viewer",
  "instanceId": "12345",          // CCV_INSTANCE_ID（pid），替代 v1 文件名 <pid>__ 前缀的归属职责
  "pid": 12345,
  "startTs": "2026-07-13T05:15:11.570Z",
  "userIdRaw": "…原始 user_id 字符串…",   // 客户端等值边界检测需要原样回放（§11）
  "userIdEncoding": "json" | "delimited", // §8 双编码
  "ccVersion": "2.1.207",        // 尽力从 system 首块 billing header 提取，可空
  "leader": {                     // 仅 teammate 进程写；用于读侧 re-join（§10）
    "sessionId": "…", "agentName": "cr-product", "teamName": "…"
  },
  "im": { "platform": "…", "id": "…" }   // 仅 IM worker 写（S6b 前 IM 固定 v1，本字段预留）
}
```

后续可追加字段（如 `endTs`）采用整文件重写 + rename，频率极低（session 结束/轮转挂点）。

## §4 journal.jsonl —— 轴心

**两相事件行**（append-only，不改写历史行；读侧按 seq 折叠）：

**req 行**（请求发起时，与 v1 `_seq` 同一同步段内构造并入队——这是 §3.7 防复活的关键）：

```jsonc
{
  "ph": "req",
  "seq": 42,                      // session 内单调，发起序（非完成序）
  "rid": "1783918085_ab12cd34e",  // v1 requestId 原值，跨 journal/conversations/responses 关联键
  "ts": "2026-07-13T05:15:11.570Z", // = v1 entry.timestamp（适配器 ${timestamp}|${url} 键的一半）
  "kind": "main" | "sub" | "teammate" | "heartbeat" | "countTokens" | "misc",
  "conv": "main",                 // convKey；heartbeat 无 conv（省略）
  "epoch": 3,                     // conv 的 epoch 号（无 conv 则省略）
  "url": "https://api.anthropic.com/v1/messages?beta=true",
  "method": "POST",
  "model": "claude-fable-5",
  "isStream": true,
  "headers": { …redacted… },      // v1 同款脱敏后 headers（~1KB，DetailPanel 需要）
  "blobs": { "tools": "sha256-a1b2…", "sys": "sha256-c3d4…" },  // 缺失字段省略
  "msgFrom": 903, "msgTo": 905,   // 本事件对应 wire messages 的 [from,to) 计数（物化完整性校验）
  "evt": "append" | "snapshot" | "ctl",  // 对应 conversation 行类型（§6，replace-tail 等控制行为 ctl）；无 conv 写入则省略
  "boundary": "clear" | "compact" | "replace-tail",  // 触发的边界（可省略）
  "proxy": { "profile": "…", "url": "…" }             // proxyProfile/proxyUrl（可省略）
}
```

**done 行**（响应完成/失败时）：

```jsonc
{
  "ph": "done",
  "seq": 42, "rid": "…",
  "ts": "…完成时刻…", "dur": 5230,
  "status": "ok" | "error" | "capture-failed",
  "http": 200,
  "usage": { "in": 12034, "out": 512, "cr": 11800, "cw": 200 },  // 摘要，全量在 responses.jsonl
  "stop": "end_turn"
}
```

- **placeholder 消灭**：v1 的 inProgress placeholder（全量 body 双写）由 req 行取代——零 body。读到 req-without-done 即在途。
- 崩溃语义：只有 req 无 done = 在途或进程死亡；适配器合成 `inProgress:true` 条目（§11）。
- journal 首行：session 建立时写一行 `{"ph":"meta","wireFormat":2,"sessionId":…}` 自描述哨兵（与 meta.json 冗余，允许 journal 单文件自解释；同 v1 rotation-context 首帧原子性要求，随 meta 创建流程一并落盘）。

## §5 responses.jsonl

每完成请求一行：`{ seq, rid, body: <完整 response body>, headers?: <response headers> }`。

- 流式请求：body = `assembleStreamMessage` 组装结果（v1 同源）；组装失败时 `body: {"assembleError": "...", "head": <前1000字符>}`（对应 v1 :1106/:1191 兜底路径）。
- heartbeat/countTokens：同样落一行（体积小、保真）。
- 不去重：response 与下一请求的回显 messages 理论上重复，但 response 含 usage/stop_reason/id 等独有信息，且"最后一条 response 永远不会被回显"，为保真与实现简单不做交叉引用。此项占比小（v1 实测 response 平均 4–6KB）。

## §6 conversations/<convKey>/e<N>.jsonl —— wire 事件行

每行一个事件，两种类型（由写侧的**唯一判定**——前缀延伸测试——决定）：

```jsonc
// append：wire messages 是上一状态的前缀延伸（≥99% 常态；含 messages 完全不变=空切片，不落行）
{ "seq": 42, "rid": "…", "t": "append", "msgs": [ …新增 message 切片… ] }

// snapshot：前缀延伸不成立（v1 §3.1 plan-mode 短窗口 / §3.2 K 尾重叠 / 非 /clear 收缩 / 任何未知形态）
{ "seq": 43, "rid": "…", "t": "snapshot", "msgs": [ …完整 wire messages… ], "reason": "shrunk|tail-mismatch|first" }
// reason 语义：first=对话首事件/进程重启；shrunk=len<prev（含 §3.1 短窗口——不单列 short-window）；tail-mismatch=len>prev 但前缀断裂（§3.2 等）

// 控制行（不携带 msgs）
{ "seq": 44, "rid": "…", "t": "ctl", "op": "replace-tail", "msg": { …新末位 message… } }   // v1 §3.3 in-place replace
{ "seq": 45, "rid": "…", "t": "ctl", "op": "compact", "keep": 2 }                          // v1 §3.5 /compact continuation 标记
```

- **写侧判定规则（穷尽）**：设 conv 上一状态计数 P、末位指纹 F（进程内存态，进程重启后 P=0）：
  - `len==P && tailFp==F` → 无事件（journal 仍记 req/done，`evt` 省略）
  - `len==P && tailFp!=F && P>0` → `ctl replace-tail`（v1 :802-808 同判定；实现另要求新旧 tailFp 均非空——空 fp 消息退化为 snapshot，安全偏差）
  - `len>P && messages[P-1] 指纹==F` → `append`（切片 `slice(P)`）
  - 其余一切 → `snapshot`（进程重启首请求也是 snapshot，reason=first）；若命中 compact-continuation 判定（S1 共享谓词）附加一行 `ctl compact`
  - **/clear 判定（S1 共享谓词 isPostClearCheckpoint）优先于以上**：关闭当前 epoch，新开 e<N+1>，首事件为 snapshot(reason=first)，journal 记 `boundary:"clear"`
- messages 切片**原样存 wire 内容**（不含 tools/system——那是 body 级字段，已入 blob）；不注入任何 `_` 字段（per-message 时间戳由读侧用 journal ts 赋予，粒度=事件级，与 v1 客户端位置时间戳机制精度等价）。
- **物化算法（读侧，共享物化器）**：按 seq 升序折叠事件流；append 直接拼接；snapshot 用共享逆锚模块（S1 的 findReverseAnchor）与当前物化态求 merge（v1 客户端 sessionMerge 同款语义）；ctl 按 op 应用。物化结果校验 journal msgTo，不符则标记降级（对应 v1 `_reconstructBroken` 的读侧内部态，**不外泄给客户端**）。

## §7 blobs/ —— tools/system CAS

- key = `sha256(JSON.stringify(value))` 十六进制**前 16 字符**（session 内碰撞概率可忽略；短 key 减小 journal 体积）。文件内容 = 原始 JSON 值（tools 数组 / system 值）原样。
- 写入：`writeFileSync(tmp, data); fsyncSync? → rename`——blob 是写序协议中唯一加 flush 屏障的环节（journal 行落盘前其引用目标必须持久）。已存在同 key 文件则跳过（天然幂等）。进程内 hash→已写 缓存避免重复 IO。
- **逐请求归属保证**：blob ref 记录在**每条** journal req 行上；适配器按行回填，物化器不做任何"沿用上一条"推断——这是 v1 `entry-slim.js:237` tools 回归的根因规避。tools-diff UI（ContextTab）是本保证的现成回归探测器。

## §8 user_id 双编码解析（identity.js 规范）

wire 上存在两种编码，**解析器与 S8 转换器必须都支持**：

1. **JSON 编码**（新版 CC）：`JSON.parse(user_id)` 成功 → 取 `.session_id`。
2. **分隔符编码**（旧版，存量 4.2GB 中存在）：形如 `user_<hash>_account_<acct?>_session_<uuid>` → 按 `_session_` 最后一次出现切分取尾段 UUID。
3. **兜底**：两者都失败 / metadata 缺失（heartbeat、countTokens 实测 0% 带 meta）→ 归入**进程当前活跃 session**（进程级缓存最近一次成功解析的 sid）；进程尚无任何 sid（冷启动先来 heartbeat）→ 暂存内存队列，首个带 sid 请求到达后一并落盘；进程整个生命周期无 sid（纯代理无 metadata 流量）→ sid = `noid-<pid>-<startTs>`。
- session_id 语义（实测核实）：每 CC 进程唯一、跨 /clear 稳定、可跨 v1 轮转边界。**/clear 边界不由 sid 判定**，由 §6 的共享谓词判定。

## §9 边界窗口对策总表（v1 WIRE_FORMAT §3 逐条）

| v1 § | 窗口 | v2 对策 |
|---|---|---|
| §3.1 | plan-mode 2-msg 短窗口（故意发） | 写侧落 `snapshot(short-window)`，读侧逆锚物化（共享 findReverseAnchor） |
| §3.2 | K 尾重叠+后段新增（故意发） | 同上：前缀测试不过 → snapshot，读侧解决 |
| §3.3 | SUGGESTION MODE 末位替换 | 写侧同 v1 判定（len==P & fp 变）→ `ctl replace-tail`，携带新末位 msg |
| §3.4 | /clear 首个 checkpoint | 共享谓词判 /clear → 新 epoch 文件，journal `boundary:clear` |
| §3.5 | /compact summary 重建 | 同对话继续：`snapshot` + `ctl compact`（不分叉 epoch） |
| §3.6 | 轮转重叠 race | **消除**——session 目录无尺寸轮转；超长 session 的 journal/conv 文件无上限风险由 S6a 列表侧分页兜底，不切文件 |
| §3.7 | 完成序倒置 | **消除于源头**——seq 发起序赋值；conv 行佩戴 seq；物理序不承载语义。移植 delta-reorder.test.js 不变式到物化器测试 |

## §10 teammate / subAgent / IM 归属

- **teammate**（独立进程、独立 sid）：写**自己的** session 目录，meta.leader 记 leader sid + agentName + teamName（来源：argv `--agent-name` 等，进程内 `_teammateName` 直取，不再依赖 prompt 前缀注册表）。
- **leader 视图 re-join（读侧规范，S4 对比与 S5 适配器共用）**：leader 流 = leader session 的 journal ∪ 所有 `meta.leader.sessionId == leader sid` 的 session journal，按 `ts` 升序合并（跨进程 seq 不可比，tie-break `(sessionId, seq)`）；teammate 条目适配时打 `teammate`/`teamName` 双标——与 v1"teammate 写 leader 文件"的读侧形态逐字段等价。
- **proxy 模式 teammate**（v1 §3.7 L104 已知未解：无 `--agent-name` 标识）：其流量在 leader 进程内被拦截，v2 下自然落 leader session 的对应 conv——沿 v1 现状，本重构不解决，此处显式记录。
- **subAgent**（同进程同 sid）：convKey 用 spawn 时 Agent tool_use 块的 `block.id`（响应 content 中可得，v1 丢弃）；异步竞态窗口内未匹配到 id 时 fallback 首 user msg 指纹。同 prompt 并行 subAgent 因 id 唯一不再碰撞。
- **IM worker**：S6b 前 spawn 时强制 `CCV_WIRE_V2=0`（决策记录：IM 有独立 watcher/resolver 体系，推迟到 S6b 一并接入，避免 S3 范围膨胀）；meta.im 字段预留。

## §11 v2→v1 适配器逐字段映射（客户端契约）

适配器（S5）从 journal+conversations+responses+blobs 合成 v1 形状 raw entry 流，喂入 `log-stream.js` 两 generator 的现有消费链。合成规则：

| v1 entry 字段 | v2 来源 |
|---|---|
| `timestamp` | journal req.ts（**必须原值**——`${timestamp}|${url}` 是客户端去重键） |
| `url` / `method` / `headers` | journal req 同名字段 |
| `project` | meta.project |
| `body.model` | journal req.model |
| `body.system` / `body.tools` | blobs 按该行 ref 回填（逐请求，绝不沿用） |
| `body.messages` | epoch 起点 → 物化全量（合成 checkpoint）；其余 → append 切片（合成 delta）。snapshot/ctl 行 → 物化器先解决，再按"该请求的物化态"输出 checkpoint（含 §3.3：合成 `_isCheckpoint:true`+`_inPlaceReplaceDetected:true` 成对信号） |
| `body.metadata.user_id` | meta.userIdRaw **原样**（客户端等值边界检测依赖） |
| `response` | responses.jsonl 按 seq；req-without-done → 无 response + `inProgress:true` + `requestId:rid` |
| `duration` / `isStream` | journal done.dur / req.isStream |
| `isHeartbeat` / `isCountTokens` | journal kind 映射 |
| `mainAgent` | kind==main → true；teammate 条目按 v1 双标语义（re-join 时依 meta 复原） |
| `teammate` / `teamName` | meta.leader 存在时打标 |
| `_deltaFormat` / `_totalMessageCount` / `_conversationId` / `_isCheckpoint` | 合成 delta envelope：`_deltaFormat:1`、`_totalMessageCount`=物化计数、`_conversationId:'mainAgent'`、epoch 起点/物化重置点 `_isCheckpoint:true` |
| `_seq` / `_seqEpoch` | journal seq / `v2:<sessionId>`（仅 main 非 teammate，同 v1 语义） |
| `_staleReorder` / `_reconstructBroken` | **绝不输出**（v2 源头无倒置；物化降级为内部态） |
| `proxyProfile` / `proxyUrl` | journal req.proxy |
| `ccvRotationContext` 哨兵 | 不再产生（无轮转）；`teammateNames` 等价信息由 re-join 元数据合成同形哨兵，保客户端零改动 |

带宽注：合成 delta envelope（而非逐条全量）使 v2 适配输出 ≈ v1 的 delta 流但**无周期 checkpoint**（epoch 起点才有），冷加载字节数低于 v1。大 epoch 的起点 checkpoint 合成必须流式（不整段驻留内存）。

## §12 寻址与 API 契约

- v2 寻址串：**`v2:<project>/<session_id>`**，用于一切现有 `?file=` 参数位（`/api/local-log`、`/api/download-log`、`/api/entries/page` 等）。`validateLogPath` 增加 v2 分支：剥前缀后 realpath 校验必须落在 `LOG_DIR/<project>/sessions/<session_id>/` 内。
- `listLocalLogs`：v2 目录项 `{file:"v2:<project>/<sid>", kind:"v2", timestamp:meta.startTs, size:目录字节和, turns:journal main-done 计数, preview:首 user msg 截断, instanceId:meta.instanceId, archived:false}`；归属过滤用 meta.instanceId（替代 v1 文件名 pid 前缀）。
- `downloadLog`：`format=rebuilt`（默认）→ 适配器合成 v1 形状 `.jsonl` 流式下载；`format=raw` → session 目录打 zip。
- `workspace-registry.getWorkspaces` 计数：`*.jsonl` glob 之外累加 `sessions/*/journal.jsonl` 的存在与目录尺寸。
- 归档：v2 session 目录整体 zip 为 `<sid>.v2.zip`（读取经 `resolveLogSource` 透明解压，沿 jsonl-archive 缓存机制）；merge 语义对 v2 不适用（session 天然独立），API 对 v2 项返回明确错误。

## §13 写路径时序（S3 接线规范）

请求发起（同步段，与 v1 `_seq` 同点）：解析 sid（§8）→ 确保 session 目录/meta（首见时 mkdirSync+原子 meta）→ 判定 convKey/epoch/事件类型（§6，**用 :773 捕获的原始 messages，先于 :839 的 delta 原地改写**）→ 计算 blob hash → 分配 seq → 入队：blob（如新）→ conv 行 → journal req 行。
响应完成（v1 完成写点）：入队 responses 行 → journal done 行。
一切 v2 步骤包裹 try/catch → `reportSwallowed('v2-write', err)`；任何失败不得中断 v1 流程。ENOSPC 预检：v2 启用时低于阈值（默认 1GB 可用）→ 本次 v2 跳过并 reportSwallowed 一次性告警。
生命周期挂点：`resolveResumeChoice`/`initForWorkspace`/`resetWorkspace` → 关闭当前 v2 session 状态（内存计数清零，目录不动）；`checkAndRotateLogFile` 对 v2 无操作（无轮转）。`_temp.jsonl` 暂存约定：**v2 无等价物**（v1 该机制服务于"resume 时日志文件改名接管"，v2 的 session 目录以 sid 为名、天然无需 claim/改名——决策记录）。

## §14 读侧容错（对应 v1 §5）

- journal 尾行截断：JSON.parse 失败即丢弃该行（pendingTail 思路，v1 同款）。
- journal 行引用的 blob/conv 行暂缺（写序窗口内）：该 entry 暂标不完整，watcher 下一 tick 重试；持续缺失（孤儿引用，理论上仅目录被外部篡改）→ 跳过 + reportSwallowed。
- conv 文件存在而 journal 无对应行（崩溃孤儿）：物化器忽略无 journal 佩戴的 conv 行。
- 两相折叠：同 seq 多条 done（不应发生）取首条；req 缺失而 done 存在（不应发生）丢弃 done。

## §15 体积预算（301MB 参照文件推算）

| 成分 | v1 | v2 |
|---|---|---|
| tools/system 重复 | ~125MB | blob 去重后 <1MB |
| mainAgent 周期 checkpoint | ~113MB | 0（epoch 自足） |
| subAgent 全量+双写 | ~129MB | 增量事件 ~3–6MB |
| placeholder 双写 | （含上） | journal req 行 ~1KB/条 |
| responses | ~5MB | ~5MB |
| journal+meta 开销 | — | ~2–3MB |
| **合计** | **301MB** | **≈12–18MB（4–6%）** |

S4 双写期以实测值替换本表并回填状态表。

## §16 保留期与清理策略

- **双写期**：v1 与 v2 副本并存（v2 增量 ≈ v1 的 4–6%，可接受）；任何工具不得自动删除任一侧。
- **S9 切换后**：v1 存量文件与双写期 v1 副本的清理**由用户显式决策**，工具只提供辅助（`ccv convert` 完成校验后输出"可安全归档/删除"清单，实际删除走既有 UI 的软删回收站路径）；本重构不内置任何自动回收。
- v1 读取能力（`.jsonl`/`.jsonl.zip`）长期保留，未转换的旧文件永远可浏览。
