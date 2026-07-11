# Claude Code ツール一覧

Claude Code は Anthropic API の tool_use メカニズムを通じてモデルに一連の組み込みツールを提供します。各 MainAgent リクエストの `tools` 配列にこれらのツールの完全な JSON Schema 定義が含まれ、モデルはレスポンス内の `tool_use` content block でそれらを呼び出します。

以下はすべてのツールのカテゴリ別インデックスです。

## Agent システム

| ツール | 用途 |
|--------|------|
| [Agent](Tool-Agent.md) | サブ agent（SubAgent）を起動して複雑なマルチステップタスクを処理 |
| [TaskOutput](Tool-TaskOutput.md) | バックグラウンドタスクの出力を取得 |
| [TaskStop](Tool-TaskStop.md) | 実行中のバックグラウンドタスクを停止 |
| [TaskCreate](Tool-TaskCreate.md) | 構造化タスクリストエントリを作成 |
| [TaskGet](Tool-TaskGet.md) | タスクの詳細を取得 |
| [TaskUpdate](Tool-TaskUpdate.md) | タスクのステータス、依存関係などを更新 |
| [TaskList](Tool-TaskList.md) | すべてのタスクを一覧表示 |

## ファイル操作

| ツール | 用途 |
|--------|------|
| [Read](Tool-Read.md) | ファイル内容を読み取り（テキスト、画像、PDF、Jupyter notebook 対応） |
| [Edit](Tool-Edit.md) | 精確な文字列置換でファイルを編集 |
| [Write](Tool-Write.md) | ファイルの書き込みまたは上書き |
| [NotebookEdit](Tool-NotebookEdit.md) | Jupyter notebook セルの編集 |

## チーム & オーケストレーション

| ツール | 用途 |
|--------|------|
| [TeamCreate](Tool-TeamCreate.md) | 協調作業用の agent チームを作成 |
| [TeamDelete](Tool-TeamDelete.md) | agent チームを解散 |
| [SendMessage](Tool-SendMessage.md) | 別の agent にメッセージを送信 |
| [Workflow](Tool-Workflow.md) | 決定論的なマルチエージェントオーケストレーションスクリプトを実行 |
| [Monitor](Tool-Monitor.md) | 長時間実行スクリプトのイベントを通知としてストリーミング |

## 検索

| ツール | 用途 |
|--------|------|
| [Glob](Tool-Glob.md) | ファイル名パターンマッチングでファイルを検索 |
| [Grep](Tool-Grep.md) | ripgrep ベースのファイル内容検索 |
| [ToolSearch](Tool-ToolSearch.md) | オンデマンドで遅延/MCP ツールを検索してロード |

## ターミナル

| ツール | 用途 |
|--------|------|
| [Bash](Tool-Bash.md) | シェルコマンドの実行 |

## Web

| ツール | 用途 |
|--------|------|
| [WebFetch](Tool-WebFetch.md) | ウェブページの内容を取得し AI で処理 |
| [WebSearch](Tool-WebSearch.md) | 検索エンジンクエリ |
| [Artifact](Tool-Artifact.md) | HTML/Markdown ファイルをホストされた claude.ai ウェブページとして発行 |
| [DesignSync](Tool-DesignSync.md) | ローカルコンポーネントライブラリを claude.ai 設計システムプロジェクトと同期 |

## 計画とインタラクション

| ツール | 用途 |
|--------|------|
| [EnterPlanMode](Tool-EnterPlanMode.md) | 計画モードに入り、実装方針を設計 |
| [ExitPlanMode](Tool-ExitPlanMode.md) | 計画モードを終了し、方針をユーザー承認に提出 |
| [AskUserQuestion](Tool-AskUserQuestion.md) | ユーザーに質問して確認や判断を取得 |
| [ReportFindings](Tool-ReportFindings.md) | コードレビューの発見をホスト UI の型指定リストとして報告 |

## Worktrees

| ツール | 用途 |
|--------|------|
| [EnterWorktree](Tool-EnterWorktree.md) | セッション用の隔離された git worktree を作成または開始 |
| [ExitWorktree](Tool-ExitWorktree.md) | worktree セッションを終了し、保持または削除 |

## スケジューリング & 通知

| ツール | 用途 |
|--------|------|
| [CronCreate](Tool-CronCreate.md) | cron 式でプロンプトをスケジュール (反復または 1 回限り) |
| [CronDelete](Tool-CronDelete.md) | スケジュール済みの cron ジョブをキャンセル |
| [CronList](Tool-CronList.md) | スケジュール済みの cron ジョブを一覧表示 |
| [ScheduleWakeup](Tool-ScheduleWakeup.md) | 次のウェイクアップをスケジュールして /loop イテレーションを自動調整 |
| [PushNotification](Tool-PushNotification.md) | ユーザーにデスクトップ/モバイル通知を送信 |
| [RemoteTrigger](Tool-RemoteTrigger.md) | claude.ai リモートトリガールーチンを管理 |

## 拡張

| ツール | 用途 |
|--------|------|
| [Skill](Tool-Skill.md) | スキル（slash command）の実行 |

## IDE 統合

| ツール | 用途 |
|--------|------|
| [getDiagnostics](Tool-getDiagnostics.md) | VS Code 言語診断情報の取得 |
| [executeCode](Tool-executeCode.md) | Jupyter kernel でコードを実行 |
| [LSP](Tool-LSP.md) | 言語サーバークエリ (定義、参照、シンボル) |
