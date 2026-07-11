# Oversigt over Claude Code-værktøjer

Claude Code giver modellen et sæt indbyggede værktøjer via Anthropic API'ens tool_use-mekanisme. `tools`-arrayet i hver MainAgent-request indeholder de komplette JSON Schema-definitioner for disse værktøjer, og modellen kalder dem via `tool_use` content blocks i svaret.

Nedenfor er det kategoriserede indeks over alle værktøjer.

## Agent-system

| Værktøj | Formål |
|------|------|
| [Agent](Tool-Agent.md) | Start en sub-agent (SubAgent) til at håndtere komplekse flertrinsopgaver |
| [TaskOutput](Tool-TaskOutput.md) | Hent output fra en baggrundsopgave |
| [TaskStop](Tool-TaskStop.md) | Stop en kørende baggrundsopgave |
| [TaskCreate](Tool-TaskCreate.md) | Opret en struktureret opgavelistepost |
| [TaskGet](Tool-TaskGet.md) | Hent opgavedetaljer |
| [TaskUpdate](Tool-TaskUpdate.md) | Opdater opgavestatus, afhængigheder osv. |
| [TaskList](Tool-TaskList.md) | List alle opgaver |

## Team og orkestrering

| Værktøj | Formål |
|------|------|
| [TeamCreate](Tool-TeamCreate.md) | Opret et agentur for samarbejdende arbejde |
| [TeamDelete](Tool-TeamDelete.md) | Opløs et agentur |
| [SendMessage](Tool-SendMessage.md) | Send en besked til en anden agent |
| [Workflow](Tool-Workflow.md) | Kør et deterministisk multi-agent orkestreringsscript |
| [Monitor](Tool-Monitor.md) | Stream hændelser fra et langvarigt script som notifikationer |

## Filoperationer

| Værktøj | Formål |
|------|------|
| [Read](Tool-Read.md) | Læs filindhold (understøtter tekst, billeder, PDF, Jupyter notebook) |
| [Edit](Tool-Edit.md) | Rediger fil via præcis strengerstatning |
| [Write](Tool-Write.md) | Skriv eller overskriv en fil |
| [NotebookEdit](Tool-NotebookEdit.md) | Rediger Jupyter notebook-celler |

## Søgning

| Værktøj | Formål |
|------|------|
| [Glob](Tool-Glob.md) | Søg filer efter filnavnsmønster |
| [Grep](Tool-Grep.md) | Søg i filindhold baseret på ripgrep |
| [ToolSearch](Tool-ToolSearch.md) | Søg og indlæs udskudte/MCP-værktøjer på anmodning |

## Terminal

| Værktøj | Formål |
|------|------|
| [Bash](Tool-Bash.md) | Udfør shell-kommandoer |

## Web

| Værktøj | Formål |
|------|------|
| [WebFetch](Tool-WebFetch.md) | Hent webindhold og behandl det med AI |
| [WebSearch](Tool-WebSearch.md) | Søgemaskineforespørgsel |
| [Artifact](Tool-Artifact.md) | Publicer en HTML/Markdown-fil som en hostnet claude.ai-webside |
| [DesignSync](Tool-DesignSync.md) | Synkronisér et lokalt komponentbibliotek med et claude.ai design-system projekt |

## Planlægning og interaktion

| Værktøj | Formål |
|------|------|
| [EnterPlanMode](Tool-EnterPlanMode.md) | Gå ind i planlægningstilstand for at designe en implementeringsplan |
| [ExitPlanMode](Tool-ExitPlanMode.md) | Forlad planlægningstilstand og indsend planen til brugerens godkendelse |
| [AskUserQuestion](Tool-AskUserQuestion.md) | Stil spørgsmål til brugeren for at få afklaring eller beslutninger |
| [ReportFindings](Tool-ReportFindings.md) | Rapportér kodegennnemsynsfund som en typet liste til værts-brugerfladen |

## Worktrees

| Værktøj | Formål |
|------|------|
| [EnterWorktree](Tool-EnterWorktree.md) | Opret eller gå ind i en isoleret git worktree til sessionens varighed |
| [ExitWorktree](Tool-ExitWorktree.md) | Forlad worktree-sessionen, bevar eller fjern den |

## Tidplanering og notifikationer

| Værktøj | Formål |
|------|------|
| [CronCreate](Tool-CronCreate.md) | Planæg en prompt på et cron-udtryk (tilbagekommen eller engangsburger) |
| [CronDelete](Tool-CronDelete.md) | Annuller et planlagt cron-job |
| [CronList](Tool-CronList.md) | List planlagte cron-jobs |
| [ScheduleWakeup](Tool-ScheduleWakeup.md) | Selvstændigt tidspunkt /loop iterationer ved at planlægge næste vågning |
| [PushNotification](Tool-PushNotification.md) | Send en desktop/mobil-notifikation til brugeren |
| [RemoteTrigger](Tool-RemoteTrigger.md) | Administrer claude.ai remote-trigger rutiner |

## Udvidelser

| Værktøj | Formål |
|------|------|
| [Skill](Tool-Skill.md) | Udfør en skill (slash command) |

## IDE-integration

| Værktøj | Formål |
|------|------|
| [getDiagnostics](Tool-getDiagnostics.md) | Hent sprogdiagnostik fra VS Code |
| [executeCode](Tool-executeCode.md) | Udfør kode i Jupyter-kernen |
| [LSP](Tool-LSP.md) | Sprogsserver-forespørgsler (definitioner, referencer, symboler) |
