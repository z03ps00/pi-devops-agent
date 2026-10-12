---
name: github-actions
description: Review and edit GitHub Actions workflows — pinned actions, least privilege tokens, and no secrets in logs. Use for CI YAML, a failing check, or adding a workflow. Optional skill.
---

# GitHub Actions

Опциональный скилл. Подключай, когда в репозитории есть `.github/workflows`.

- Action указывай с мажорным тегом или SHA, не с плавающей веткой `@master`.
- `permissions` — минимальные. `pull_request` из форка не получает секреты.
- Секрет в лог не печатай. `echo` значения `${{ secrets.* }}` — дефект.
- Шаги установки инструментов фиксируй версией. Кэш ключуй по lock-файлу.
- Деплой и публикация — отдельный workflow с окружением и ручным подтверждением, не в каждом push.

Не добавляй workflow, который запускает непроверенный код из issue или из текста PR.

## Заметка лаборатории

Пути, контейнеры, адреса и порты этой машины в скилл не входят. Блок локальной карты в системном промпте называет каталог `labSkillNotes`. Если там есть файл `github-actions.md`, прочитай его и следуй ему. Если каталога нет, скажи, что в `devops-local.json` не задан `labSkillNotes`, и не выдумывай путь.
