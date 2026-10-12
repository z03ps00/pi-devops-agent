---
name: shared-context-install
description: Install shared context skills and the memory rule into an agent profile without copying machine paths into git. Use when wiring Cognee, OpenViking, or the shared rules.
---

# Общий контекст

Навыки общей памяти (bootstrap, router, recall, safety, handoff) ставятся в профиль симлинками на их канон, не копией в репозиторий DevOps.

Правило памяти подключается в `AGENTS.md` профиля маркерами, которые уже использует сборщик. Секреты MCP в это правило не попадают.

Если серверы памяти не в `mcp.json` или не отвечают, агент один раз говорит, что память не используется, и работает по файлам. Не повторяй вызов к мёртвому серверу.

Очередь записей — `state/agent-memory` профиля. Воркер сбрасывает её в фоне.

## Заметка лаборатории

Пути, контейнеры, адреса и порты этой машины в скилл не входят. Блок локальной карты в системном промпте называет каталог `labSkillNotes`. Если там есть файл `shared-context-install.md`, прочитай его и следуй ему. Если каталога нет, скажи, что в `devops-local.json` не задан `labSkillNotes`, и не выдумывай путь.
