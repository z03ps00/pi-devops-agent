---
name: agent-memory-infra
description: Operate the shared Cognee and OpenViking stack — health, backup, restore, backfill and the pending queue. Use for memory or knowledge MCP connectivity and dataset tasks.
---

# Память агентов

Два сервиса: короткая память (Cognee) и документы (OpenViking). Адреса — переменные `MEMORY_MCP_URL` и `KNOWLEDGE_MCP_URL`. Значения по умолчанию в коде — localhost; на машине, где сервисы в другом сетевом пространстве, адрес задаёт окружение или заметка лаборатории. Не хардкодь адрес в конфиг агента.

## Операции

Штатные команды из индекса: поднять, статус, smoke, backup, restore, backfill, replay очереди, выключить. Backup перед restore. Очередь `state/agent-memory` пишет воркер, не сам ход агента.

## Запись из сессии

`recorded` — только после проверки чтением. Секрет в запись не попадает: redact до очереди. Анонимная сессия не пишет и на уровне 2 ещё и не читает.

Профиль эмбеддингов и имя датасета — в индексе стека, не в этом скилле.

## Заметка лаборатории

Пути, контейнеры, адреса и порты этой машины в скилл не входят. Блок локальной карты в системном промпте называет каталог `labSkillNotes`. Если там есть файл `agent-memory-infra.md`, прочитай его и следуй ему. Если каталога нет, скажи, что в `devops-local.json` не задан `labSkillNotes`, и не выдумывай путь.
