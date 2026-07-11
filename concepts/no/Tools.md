# Oversikt over Claude Code-verktøy

Claude Code tilbyr en samling innebygde verktøy til modellen via tool_use-mekanismen i Anthropic API. `tools`-arrayen i hver MainAgent-forespørsel inneholder komplette JSON Schema-definisjoner for disse verktøyene, og modellen kaller dem i responsen via `tool_use` content blocks.

Nedenfor er en kategorisert indeks over alle verktøy.

## Agent-system

| Verktøy | Formål |
|---------|--------|
| [Agent](Tool-Agent.md) | Starte en sub-agent (SubAgent) for å håndtere komplekse flerstegsoppgaver |
| [TaskOutput](Tool-TaskOutput.md) | Hente utdata fra bakgrunnsoppgaver |
| [TaskStop](Tool-TaskStop.md) | Stoppe en kjørende bakgrunnsoppgave |
| [TaskCreate](Tool-TaskCreate.md) | Opprette et strukturert oppgavelisteelement |
| [TaskGet](Tool-TaskGet.md) | Hente oppgavedetaljer |
| [TaskUpdate](Tool-TaskUpdate.md) | Oppdatere oppgavestatus, avhengigheter osv. |
| [TaskList](Tool-TaskList.md) | Liste alle oppgaver |

## Team og orkestrering

| Verktøy | Formål |
|---------|--------|
| [TeamCreate](Tool-TeamCreate.md) | Opprette et agentteam for samarbeidsarbeid |
| [TeamDelete](Tool-TeamDelete.md) | Oppløse et agentteam |
| [SendMessage](Tool-SendMessage.md) | Sende en melding til en annen agent |
| [Workflow](Tool-Workflow.md) | Kjør en deterministisk multi-agent orkestreringsscript |
| [Monitor](Tool-Monitor.md) | Streame hendelser fra et langvarig script som varsler |

## Filoperasjoner

| Verktøy | Formål |
|---------|--------|
| [Read](Tool-Read.md) | Lese filinnhold (støtter tekst, bilder, PDF, Jupyter notebook) |
| [Edit](Tool-Edit.md) | Redigere filer via nøyaktig strengerstatning |
| [Write](Tool-Write.md) | Skrive eller overskrive filer |
| [NotebookEdit](Tool-NotebookEdit.md) | Redigere Jupyter notebook-celler |

## Søk

| Verktøy | Formål |
|---------|--------|
| [Glob](Tool-Glob.md) | Søke etter filer med filnavnmønstermatching |
| [Grep](Tool-Grep.md) | Innholdssøk i filer basert på ripgrep |
| [ToolSearch](Tool-ToolSearch.md) | Søke og laste inn utsatte/MCP-verktøy etter behov |

## Terminal

| Verktøy | Formål |
|---------|--------|
| [Bash](Tool-Bash.md) | Kjøre shell-kommandoer |

## Web

| Verktøy | Formål |
|---------|--------|
| [WebFetch](Tool-WebFetch.md) | Hente nettsidens innhold og behandle det med AI |
| [WebSearch](Tool-WebSearch.md) | Søkemotorforespørsler |
| [Artifact](Tool-Artifact.md) | Publiser en HTML/Markdown-fil som en hostet claude.ai-webside |
| [DesignSync](Tool-DesignSync.md) | Synkroniser et lokalt komponentbibliotek med et claude.ai design-system prosjekt |

## Planlegging og interaksjon

| Verktøy | Formål |
|---------|--------|
| [EnterPlanMode](Tool-EnterPlanMode.md) | Gå inn i planleggingsmodus for å designe implementeringsplan |
| [ExitPlanMode](Tool-ExitPlanMode.md) | Gå ut av planleggingsmodus og sende planen til brukergodkjenning |
| [AskUserQuestion](Tool-AskUserQuestion.md) | Stille spørsmål til brukeren for avklaring eller beslutninger |
| [ReportFindings](Tool-ReportFindings.md) | Rapporter kodegjennomgangsfunn som en typet liste til vert-brukergrensesnittet |

## Arbeidstrær

| Verktøy | Formål |
|---------|--------|
| [EnterWorktree](Tool-EnterWorktree.md) | Opprette eller gå inn i isolert git worktree for sessionen |
| [ExitWorktree](Tool-ExitWorktree.md) | Forlate worktree-sessionen, behold eller fjern den |

## Planlegging og varsler

| Verktøy | Formål |
|---------|--------|
| [CronCreate](Tool-CronCreate.md) | Planlegg en prompt på et cron-uttrykk (gjentatt eller engangs) |
| [CronDelete](Tool-CronDelete.md) | Avbryt planlagte cron-jobb |
| [CronList](Tool-CronList.md) | List planlagte cron-jobb |
| [ScheduleWakeup](Tool-ScheduleWakeup.md) | Selvpace /loop iterasjoner ved å planlegge neste oppvåkning |
| [PushNotification](Tool-PushNotification.md) | Send skrivebord/mobil varsling til brukeren |
| [RemoteTrigger](Tool-RemoteTrigger.md) | Administrer claude.ai remote-trigger rutiner |

## Utvidelser

| Verktøy | Formål |
|---------|--------|
| [Skill](Tool-Skill.md) | Kjøre ferdigheter (slash command) |

## IDE-integrasjon

| Verktøy | Formål |
|---------|--------|
| [getDiagnostics](Tool-getDiagnostics.md) | Hente språkdiagnostikk fra VS Code |
| [executeCode](Tool-executeCode.md) | Kjøre kode i Jupyter kernel |
| [LSP](Tool-LSP.md) | Språkserver-spørringer (definisjoner, referanser, symboler) |
