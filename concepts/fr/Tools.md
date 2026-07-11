# Vue d'ensemble des outils Claude Code

Claude Code fournit au modèle un ensemble d'outils intégrés via le mécanisme tool_use de l'API Anthropic. Chaque requête MainAgent inclut les définitions complètes en JSON Schema de ces outils dans le tableau `tools`, et le modèle les invoque via des content blocks `tool_use` dans la réponse.

Voici l'index classifié de tous les outils.

## Système d'Agents

| Outil | Utilité |
|-------|---------|
| [Agent](Tool-Agent.md) | Lancer un sous-agent (SubAgent) pour gérer des tâches complexes multi-étapes |
| [TaskOutput](Tool-TaskOutput.md) | Obtenir la sortie des tâches en arrière-plan |
| [TaskStop](Tool-TaskStop.md) | Arrêter une tâche en arrière-plan en cours d'exécution |
| [TaskCreate](Tool-TaskCreate.md) | Créer une entrée dans la liste de tâches structurée |
| [TaskGet](Tool-TaskGet.md) | Obtenir les détails d'une tâche |
| [TaskUpdate](Tool-TaskUpdate.md) | Mettre à jour le statut, les dépendances, etc. d'une tâche |
| [TaskList](Tool-TaskList.md) | Lister toutes les tâches |

## Team & Orchestration

| Outil | Utilité |
|-------|---------|
| [TeamCreate](Tool-TeamCreate.md) | Créer une équipe d'agents pour un travail collaboratif |
| [TeamDelete](Tool-TeamDelete.md) | Dissoudre une équipe d'agents |
| [SendMessage](Tool-SendMessage.md) | Envoyer un message à un autre agent |
| [Workflow](Tool-Workflow.md) | Exécuter un script d'orchestration multi-agents déterministe |
| [Monitor](Tool-Monitor.md) | Diffuser des événements d'un script de longue durée en tant que notifications |

## Opérations sur les fichiers

| Outil | Utilité |
|-------|---------|
| [Read](Tool-Read.md) | Lire le contenu de fichiers (supporte texte, images, PDF, Jupyter notebook) |
| [Edit](Tool-Edit.md) | Éditer des fichiers par remplacement exact de chaînes |
| [Write](Tool-Write.md) | Écrire ou écraser des fichiers |
| [NotebookEdit](Tool-NotebookEdit.md) | Éditer des cellules de Jupyter notebook |

## Recherche

| Outil | Utilité |
|-------|---------|
| [Glob](Tool-Glob.md) | Rechercher des fichiers par correspondance de motifs de noms |
| [Grep](Tool-Grep.md) | Recherche de contenu de fichiers basée sur ripgrep |
| [ToolSearch](Tool-ToolSearch.md) | Chercher et charger des outils différés/MCP à la demande |

## Terminal

| Outil | Utilité |
|-------|---------|
| [Bash](Tool-Bash.md) | Exécuter des commandes shell |

## Web

| Outil | Utilité |
|-------|---------|
| [WebFetch](Tool-WebFetch.md) | Récupérer du contenu web et le traiter avec l'IA |
| [WebSearch](Tool-WebSearch.md) | Requêtes sur les moteurs de recherche |
| [Artifact](Tool-Artifact.md) | Publier un fichier HTML/Markdown en tant que page web hébergée sur claude.ai |
| [DesignSync](Tool-DesignSync.md) | Synchroniser une bibliothèque de composants locale avec un projet de système de conception claude.ai |

## Planification et interaction

| Outil | Utilité |
|-------|---------|
| [EnterPlanMode](Tool-EnterPlanMode.md) | Entrer en mode planification pour concevoir un plan d'implémentation |
| [ExitPlanMode](Tool-ExitPlanMode.md) | Quitter le mode planification et soumettre le plan pour approbation de l'utilisateur |
| [AskUserQuestion](Tool-AskUserQuestion.md) | Poser des questions à l'utilisateur pour obtenir des clarifications ou des décisions |
| [ReportFindings](Tool-ReportFindings.md) | Signaler les résultats de la révision du code en tant que liste typée pour l'interface utilisateur hôte |

## Worktrees

| Outil | Utilité |
|-------|---------|
| [EnterWorktree](Tool-EnterWorktree.md) | Créer ou entrer dans un worktree git isolé pour la session |
| [ExitWorktree](Tool-ExitWorktree.md) | Quitter la session worktree, en la conservant ou en la supprimant |

## Planification et Notifications

| Outil | Utilité |
|-------|---------|
| [CronCreate](Tool-CronCreate.md) | Planifier une demande sur une expression cron (récurrente ou unique) |
| [CronDelete](Tool-CronDelete.md) | Annuler une tâche cron planifiée |
| [CronList](Tool-CronList.md) | Lister les tâches cron planifiées |
| [ScheduleWakeup](Tool-ScheduleWakeup.md) | Auto-rythme les itérations /loop en planifiant le prochain réveil |
| [PushNotification](Tool-PushNotification.md) | Envoyer une notification de bureau/mobile à l'utilisateur |
| [RemoteTrigger](Tool-RemoteTrigger.md) | Gérer les routines de déclenchement à distance de claude.ai |

## Extensions

| Outil | Utilité |
|-------|---------|
| [Skill](Tool-Skill.md) | Exécuter une compétence (slash command) |

## Intégration IDE

| Outil | Utilité |
|-------|---------|
| [getDiagnostics](Tool-getDiagnostics.md) | Obtenir les informations de diagnostic du langage de VS Code |
| [executeCode](Tool-executeCode.md) | Exécuter du code dans le kernel Jupyter |
| [LSP](Tool-LSP.md) | Requêtes du serveur de langage (définitions, références, symboles) |
