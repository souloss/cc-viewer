# systemPromptModel.md variables

这个文件只说明 `systemPromptModel.md` 中需要从运行时获取的变量。所有叶子变量都应该返回字符串、数字或空字符串 `""`；获取不到时统一兜底为空字符串。

## 工作区与用户环境

| 变量名称 | 简介 | 示例 |
|---|---|---|
| `${environment.cwd}` | 当前主工作目录。 | `/Users/sky/claude-code` |
| `${environment.originalCwd}` | 进程或会话启动时的原始工作目录。 | `/Users/sky/claude-code` |
| `${environment.home}` | 用户 home 目录，用于解析 `~`。 | `/Users/sky` |
| `${environment.user}` | 当前系统用户名。 | `sky` |
| `${environment.workspaceRoots}` | 当前会话 workspace roots；可渲染为换行字符串。 | `/Users/sky/claude-code` |
| `${environment.path}` | 当前进程 PATH。 | `/opt/homebrew/bin:/usr/bin:/bin` |
| `${environment.lang}` | 当前 locale 或语言环境。 | `zh_CN.UTF-8` |

## 操作系统

| 变量名称 | 简介 | 示例 |
|---|---|---|
| `${os.platform}` | Node.js 识别的平台。 | `darwin` |
| `${os.type}` | 操作系统类型。 | `Darwin` |
| `${os.arch}` | CPU 架构。 | `arm64` |
| `${os.shell}` | 当前 shell。 | `/bin/zsh` |
| `${os.version}` | 操作系统版本描述。 | `Darwin Kernel Version ...` |
| `${os.release}` | 操作系统 release。 | `24.5.0` |
| `${os.hostname}` | 当前主机名。 | `MacBook-Pro.local` |
| `${os.availableParallelism}` | 当前可用并行度。 | `10` |
| `${os.totalMemory}` | 系统总内存，单位 bytes。 | `34359738368` |
| `${os.freeMemory}` | 当前空闲内存，单位 bytes。 | `8589934592` |
| `${os.uptime}` | 系统运行时间，单位 seconds。 | `123456` |

## Node.js 运行时

| 变量名称 | 简介 | 示例 |
|---|---|---|
| `${runtime.nodeVersion}` | 当前 Node.js 版本。 | `v24.14.0` |
| `${runtime.execPath}` | 当前 Node.js 可执行文件路径。 | `/opt/homebrew/bin/node` |
| `${runtime.pid}` | 当前进程 ID。 | `12345` |
| `${runtime.ppid}` | 父进程 ID。 | `1234` |

## 时间

| 变量名称 | 简介 | 示例 |
|---|---|---|
| `${time.current}` | 当前本地时间字符串。 | `Thu Jul 09 2026 18:22:09 GMT+0800 (China Standard Time)` |
| `${time.iso}` | 当前 ISO 时间。 | `2026-07-09T10:22:09.000Z` |
| `${time.date}` | 当前本地日期。 | `2026-07-09` |
| `${time.timezone}` | 当前系统时区。 | `Asia/Shanghai` |

## 权限与沙箱

| 变量名称 | 简介 | 示例 |
|---|---|---|
| `${permissions.mode}` | 当前工具权限模式。 | `default` |
| `${permissions.approvalsReviewer}` | 当前审批策略或 reviewer 模式。 | `auto_review` |
| `${sandbox.mode}` | 文件系统沙箱模式。 | `workspace-write` |
| `${sandbox.networkAccess}` | 网络访问状态。 | `enabled` |
| `${sandbox.writableRoots}` | 沙箱允许写入的目录列表；可渲染为换行字符串。 | `/Users/sky/Documents/Playground` |

## 终端

| 变量名称 | 简介 | 示例 |
|---|---|---|
| `${terminal.term}` | 当前 TERM。 | `xterm-256color` |
| `${terminal.colorTerm}` | 当前 COLORTERM。 | `truecolor` |
| `${terminal.columns}` | 当前终端列数。 | `120` |
| `${terminal.rows}` | 当前终端行数。 | `40` |

## 文件系统

| 变量名称 | 简介 | 示例 |
|---|---|---|
| `${filesystem.tmpdir}` | 系统临时目录。 | `/var/folders/.../T` |
| `${filesystem.pathSeparator}` | 文件路径分隔符。 | `/` |
| `${filesystem.pathDelimiter}` | PATH 条目分隔符。 | `:` |

## 模型

| 变量名称 | 简介 | 示例 |
|---|---|---|
| `${model.name}` | 当前模型名称或 ID。 | `claude-opus-4-6` |
| `${model.knowledgeCutoff}` | 当前模型知识截止时间；该值不能由操作系统推导，需要由外部配置或 override 注入。 | `May 2025` |

## Git

| 变量名称 | 简介 | 示例 |
|---|---|---|
| `${git.isRepository}` | 当前目录是否在 git 仓库中，字符串形式。 | `true` |
| `${git.root}` | git 仓库根目录。 | `/Users/sky/project` |
| `${git.branch}` | 当前 git 分支或 HEAD 短 hash。 | `main` |
| `${git.mainBranch}` | 默认主分支，通常用于 PR 或合并目标。 | `main` |
| `${git.userName}` | 当前 git `user.name`。 | `Sky` |
| `${git.status}` | `git status --short` 的输出。 | `M src/index.ts` |
| `${git.recentCommits}` | 最近提交摘要。 | `abc1234 Fix prompt builder` |
