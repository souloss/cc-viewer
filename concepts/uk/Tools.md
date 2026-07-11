# Перелік інструментів Claude Code

Claude Code надає моделі набір вбудованих інструментів через механізм tool_use API Anthropic. Масив `tools` кожного запиту MainAgent містить повні визначення JSON Schema цих інструментів, і модель викликає їх через `tool_use` content block у відповіді.

Нижче наведено категоризований індекс усіх інструментів.

## Система агентів

| Інструмент | Призначення |
|------------|-------------|
| [Agent](Tool-Agent.md) | Запуск підагента (SubAgent) для обробки складних багатокрокових завдань |
| [TaskOutput](Tool-TaskOutput.md) | Отримання виводу фонового завдання |
| [TaskStop](Tool-TaskStop.md) | Зупинка запущеного фонового завдання |
| [TaskCreate](Tool-TaskCreate.md) | Створення запису структурованого списку завдань |
| [TaskGet](Tool-TaskGet.md) | Отримання деталей завдання |
| [TaskUpdate](Tool-TaskUpdate.md) | Оновлення статусу завдання, залежностей тощо |
| [TaskList](Tool-TaskList.md) | Перелік усіх завдань |

## Команда та оркестровка

| Інструмент | Призначення |
|------------|-------------|
| [TeamCreate](Tool-TeamCreate.md) | Створення команди агентів для спільної роботи |
| [TeamDelete](Tool-TeamDelete.md) | Розформування команди агентів |
| [SendMessage](Tool-SendMessage.md) | Відправка повідомлення іншому агенту |
| [Workflow](Tool-Workflow.md) | Запуск детермінованого скрипту багатоагентної оркестровки |
| [Monitor](Tool-Monitor.md) | Потокове передавання подій від тривалого скрипту як сповіщень |

## Операції з файлами

| Інструмент | Призначення |
|------------|-------------|
| [Read](Tool-Read.md) | Читання вмісту файлу (підтримка тексту, зображень, PDF, Jupyter notebook) |
| [Edit](Tool-Edit.md) | Редагування файлу через точну заміну рядків |
| [Write](Tool-Write.md) | Запис або перезапис файлу |
| [NotebookEdit](Tool-NotebookEdit.md) | Редагування комірки Jupyter notebook |

## Пошук

| Інструмент | Призначення |
|------------|-------------|
| [Glob](Tool-Glob.md) | Пошук файлів за шаблоном імені файлу |
| [Grep](Tool-Grep.md) | Пошук вмісту файлів на основі ripgrep |
| [ToolSearch](Tool-ToolSearch.md) | Пошук і завантаження відкладених/MCP інструментів за вимогою |

## Термінал

| Інструмент | Призначення |
|------------|-------------|
| [Bash](Tool-Bash.md) | Виконання shell-команд |

## Web

| Інструмент | Призначення |
|------------|-------------|
| [WebFetch](Tool-WebFetch.md) | Отримання вмісту веб-сторінки та обробка за допомогою AI |
| [WebSearch](Tool-WebSearch.md) | Запит до пошукової системи |
| [Artifact](Tool-Artifact.md) | Публікація файлу HTML/Markdown як розміщеної на claude.ai веб-сторінки |
| [DesignSync](Tool-DesignSync.md) | Синхронізація локальної бібліотеки компонентів з проектом claude.ai design-system |

## Планування та взаємодія

| Інструмент | Призначення |
|------------|-------------|
| [EnterPlanMode](Tool-EnterPlanMode.md) | Вхід у режим планування, проєктування плану реалізації |
| [ExitPlanMode](Tool-ExitPlanMode.md) | Вихід з режиму планування та подання плану на затвердження користувачем |
| [AskUserQuestion](Tool-AskUserQuestion.md) | Запитання користувачу для уточнення або прийняття рішення |
| [ReportFindings](Tool-ReportFindings.md) | Звіт про висновки перевірки коду як типізований список для хост-інтерфейсу |

## Робочі дерева

| Інструмент | Призначення |
|------------|-------------|
| [EnterWorktree](Tool-EnterWorktree.md) | Створення або вхід в ізольоване git робоче дерево для сесії |
| [ExitWorktree](Tool-ExitWorktree.md) | Вихід з сесії робочого дерева, зберігання або видалення його |

## Планування та сповіщення

| Інструмент | Призначення |
|------------|-------------|
| [CronCreate](Tool-CronCreate.md) | Планування підказки на вираз cron (повторювана або одноразова) |
| [CronDelete](Tool-CronDelete.md) | Скасування запланованого завдання cron |
| [CronList](Tool-CronList.md) | Отримання списку запланованих завдань cron |
| [ScheduleWakeup](Tool-ScheduleWakeup.md) | Власний темп ітерацій /loop путём планування наступного пробудження |
| [PushNotification](Tool-PushNotification.md) | Відправка сповіщення на робочий стіл/мобільний пристрій користувачу |
| [RemoteTrigger](Tool-RemoteTrigger.md) | Управління claude.ai remote-trigger підпрограмами |

## Розширення

| Інструмент | Призначення |
|------------|-------------|
| [Skill](Tool-Skill.md) | Виконання навички (slash command) |

## Інтеграція з IDE

| Інструмент | Призначення |
|------------|-------------|
| [getDiagnostics](Tool-getDiagnostics.md) | Отримання діагностичної інформації мови VS Code |
| [executeCode](Tool-executeCode.md) | Виконання коду в Jupyter kernel |
| [LSP](Tool-LSP.md) | Запити мовного сервера (визначення, посилання, символи) |
