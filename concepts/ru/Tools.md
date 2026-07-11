# Обзор инструментов Claude Code

Claude Code предоставляет модели набор встроенных инструментов через механизм tool_use API Anthropic. Массив `tools` в каждом запросе MainAgent содержит полные определения JSON Schema этих инструментов, а модель вызывает их в ответе через блоки content `tool_use`.

Ниже приведён категоризированный индекс всех инструментов.

## Система агентов

| Инструмент | Назначение |
|------|------|
| [Agent](Tool-Agent.md) | Запуск суб-агента (SubAgent) для обработки сложных многоэтапных задач |
| [TaskOutput](Tool-TaskOutput.md) | Получение результата фоновой задачи |
| [TaskStop](Tool-TaskStop.md) | Остановка работающей фоновой задачи |
| [TaskCreate](Tool-TaskCreate.md) | Создание записи в структурированном списке задач |
| [TaskGet](Tool-TaskGet.md) | Получение деталей задачи |
| [TaskUpdate](Tool-TaskUpdate.md) | Обновление статуса задачи, зависимостей и т.д. |
| [TaskList](Tool-TaskList.md) | Отображение списка всех задач |

## Команда и оркестровка

| Инструмент | Назначение |
|------|------|
| [TeamCreate](Tool-TeamCreate.md) | Создание команды агентов для совместной работы |
| [TeamDelete](Tool-TeamDelete.md) | Расформирование команды агентов |
| [SendMessage](Tool-SendMessage.md) | Отправка сообщения другому агенту |
| [Workflow](Tool-Workflow.md) | Запуск детерминированного скрипта многоагентной оркестровки |
| [Monitor](Tool-Monitor.md) | Потоковая передача событий от долго работающего скрипта как уведомлений |

## Операции с файлами

| Инструмент | Назначение |
|------|------|
| [Read](Tool-Read.md) | Чтение содержимого файла (поддержка текста, изображений, PDF, Jupyter notebook) |
| [Edit](Tool-Edit.md) | Редактирование файла через точную замену строк |
| [Write](Tool-Write.md) | Запись или перезапись файла |
| [NotebookEdit](Tool-NotebookEdit.md) | Редактирование ячеек Jupyter notebook |

## Поиск

| Инструмент | Назначение |
|------|------|
| [Glob](Tool-Glob.md) | Поиск файлов по шаблону имени |
| [Grep](Tool-Grep.md) | Поиск по содержимому файлов на основе ripgrep |
| [ToolSearch](Tool-ToolSearch.md) | Поиск и загрузка отложенных/MCP инструментов по требованию |

## Терминал

| Инструмент | Назначение |
|------|------|
| [Bash](Tool-Bash.md) | Выполнение команд shell |

## Web

| Инструмент | Назначение |
|------|------|
| [WebFetch](Tool-WebFetch.md) | Получение содержимого веб-страниц и обработка с помощью AI |
| [WebSearch](Tool-WebSearch.md) | Запросы к поисковой системе |
| [Artifact](Tool-Artifact.md) | Публикация файла HTML/Markdown как размещённой на claude.ai веб-страницы |
| [DesignSync](Tool-DesignSync.md) | Синхронизация локальной библиотеки компонентов с проектом claude.ai design-system |

## Планирование и взаимодействие

| Инструмент | Назначение |
|------|------|
| [EnterPlanMode](Tool-EnterPlanMode.md) | Вход в режим планирования, проектирование плана реализации |
| [ExitPlanMode](Tool-ExitPlanMode.md) | Выход из режима планирования и отправка плана на утверждение пользователю |
| [AskUserQuestion](Tool-AskUserQuestion.md) | Задать вопрос пользователю для уточнения или принятия решения |
| [ReportFindings](Tool-ReportFindings.md) | Сообщение о выводах проверки кода как типизированного списка для хост-интерфейса |

## Рабочие деревья

| Инструмент | Назначение |
|------|------|
| [EnterWorktree](Tool-EnterWorktree.md) | Создание или вход в изолированное git рабочее дерево для сессии |
| [ExitWorktree](Tool-ExitWorktree.md) | Выход из сессии рабочего дерева, сохранение или удаление его |

## Планирование и уведомления

| Инструмент | Назначение |
|------|------|
| [CronCreate](Tool-CronCreate.md) | Планирование подсказки на выражение cron (повторяющееся или одноразовое) |
| [CronDelete](Tool-CronDelete.md) | Отмена запланированного задания cron |
| [CronList](Tool-CronList.md) | Получение списка запланированных заданий cron |
| [ScheduleWakeup](Tool-ScheduleWakeup.md) | Самостоятельный темп итераций /loop путём планирования следующего пробуждения |
| [PushNotification](Tool-PushNotification.md) | Отправка уведомления на рабочий стол/мобильное устройство пользователю |
| [RemoteTrigger](Tool-RemoteTrigger.md) | Управление claude.ai remote-trigger подпрограммами |

## Расширения

| Инструмент | Назначение |
|------|------|
| [Skill](Tool-Skill.md) | Выполнение навыка (slash command) |

## Интеграция с IDE

| Инструмент | Назначение |
|------|------|
| [getDiagnostics](Tool-getDiagnostics.md) | Получение диагностической информации языка из VS Code |
| [executeCode](Tool-executeCode.md) | Выполнение кода в ядре Jupyter |
| [LSP](Tool-LSP.md) | Запросы языкового сервера (определения, ссылки, символы) |
