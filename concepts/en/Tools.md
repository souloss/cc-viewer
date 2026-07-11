# Claude Code Tools Overview

Claude Code provides a set of built-in tools to the model through the Anthropic API's tool_use mechanism. Each MainAgent request includes the complete JSON Schema definitions of these tools in the `tools` array, and the model invokes them via `tool_use` content blocks in its responses.

Below is a categorized index of all tools.

## Agent System

| Tool | Purpose |
|------|---------|
| [Agent](Tool-Agent.md) | Launch a SubAgent to handle complex multi-step tasks |
| [TaskOutput](Tool-TaskOutput.md) | Get the output of a background task |
| [TaskStop](Tool-TaskStop.md) | Stop a running background task |
| [TaskCreate](Tool-TaskCreate.md) | Create a structured task list entry |
| [TaskGet](Tool-TaskGet.md) | Get task details |
| [TaskUpdate](Tool-TaskUpdate.md) | Update task status, dependencies, etc. |
| [TaskList](Tool-TaskList.md) | List all tasks |

## Team & Orchestration

| Tool | Purpose |
|------|---------|
| [TeamCreate](Tool-TeamCreate.md) | Create an agent team for collaborative work |
| [TeamDelete](Tool-TeamDelete.md) | Disband an agent team |
| [SendMessage](Tool-SendMessage.md) | Send a message to another agent |
| [Workflow](Tool-Workflow.md) | Run a deterministic multi-agent orchestration script |
| [Monitor](Tool-Monitor.md) | Stream events from a long-running script as notifications |

## File Operations

| Tool | Purpose |
|------|---------|
| [Read](Tool-Read.md) | Read file contents (supports text, images, PDF, Jupyter notebook) |
| [Edit](Tool-Edit.md) | Edit files via exact string replacement |
| [Write](Tool-Write.md) | Write to or overwrite files |
| [NotebookEdit](Tool-NotebookEdit.md) | Edit Jupyter notebook cells |

## Search

| Tool | Purpose |
|------|---------|
| [Glob](Tool-Glob.md) | Search files by filename pattern matching |
| [Grep](Tool-Grep.md) | Search file contents based on ripgrep |
| [ToolSearch](Tool-ToolSearch.md) | Search and load deferred/MCP tools on demand |

## Terminal

| Tool | Purpose |
|------|---------|
| [Bash](Tool-Bash.md) | Execute shell commands |

## Web

| Tool | Purpose |
|------|---------|
| [WebFetch](Tool-WebFetch.md) | Fetch web page content and process it with AI |
| [WebSearch](Tool-WebSearch.md) | Search engine queries |
| [Artifact](Tool-Artifact.md) | Publish an HTML/Markdown file as a hosted claude.ai web page |
| [DesignSync](Tool-DesignSync.md) | Sync a local component library with a claude.ai design-system project |

## Planning & Interaction

| Tool | Purpose |
|------|---------|
| [EnterPlanMode](Tool-EnterPlanMode.md) | Enter plan mode to design an implementation plan |
| [ExitPlanMode](Tool-ExitPlanMode.md) | Exit plan mode and submit the plan for user approval |
| [AskUserQuestion](Tool-AskUserQuestion.md) | Ask the user a question for clarification or decisions |
| [ReportFindings](Tool-ReportFindings.md) | Report code-review findings as a typed list for the host UI |

## Worktrees

| Tool | Purpose |
|------|---------|
| [EnterWorktree](Tool-EnterWorktree.md) | Create or enter an isolated git worktree for the session |
| [ExitWorktree](Tool-ExitWorktree.md) | Leave the worktree session, keeping or removing it |

## Scheduling & Notifications

| Tool | Purpose |
|------|---------|
| [CronCreate](Tool-CronCreate.md) | Schedule a prompt on a cron expression (recurring or one-shot) |
| [CronDelete](Tool-CronDelete.md) | Cancel a scheduled cron job |
| [CronList](Tool-CronList.md) | List scheduled cron jobs |
| [ScheduleWakeup](Tool-ScheduleWakeup.md) | Self-pace /loop iterations by scheduling the next wakeup |
| [PushNotification](Tool-PushNotification.md) | Send a desktop/mobile notification to the user |
| [RemoteTrigger](Tool-RemoteTrigger.md) | Manage claude.ai remote-trigger routines |

## Extensions

| Tool | Purpose |
|------|---------|
| [Skill](Tool-Skill.md) | Execute a skill (slash command) |

## IDE Integration

| Tool | Purpose |
|------|---------|
| [getDiagnostics](Tool-getDiagnostics.md) | Get VS Code language diagnostics |
| [executeCode](Tool-executeCode.md) | Execute code in a Jupyter kernel |
| [LSP](Tool-LSP.md) | Language-server queries (definitions, references, symbols) |
