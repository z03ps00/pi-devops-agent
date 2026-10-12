---
name: compose-guard
description: Safely edit Compose files — folded scalars, shell syntax, network_mode limits, extra compose files, and stop versus down. Use before saving a compose change or when a container fails after one.
---

# Compose Guard

Правка `docker-compose*.yml` без поломки сети и без секретов в файле.

## Перед записью

1. Прочитай текущий файл. Меняй минимально.
2. Для `command`, `entrypoint` и `healthcheck` разверни YAML-фолдинг (`>-`, `|`) в итоговую строку и проверь её через `sh -n` или `dash -n`. Сложную логику вынеси в отдельный `.sh` рядом с проектом.
3. Сервис с `network_mode: container:<name>` не может иметь `ports`, `extra_hosts` и `dns`. DNS в таком режиме — монтированием `/etc/resolv.conf`.
4. Compose не подхватывает третий файл сам. Имя закрепи в `COMPOSE_FILE` или передавай явно. Не пиши голое `mounts.yml`, если файл называется `docker-compose.mounts.yml`.
5. Для остановки предпочти `stop`, не `down`, если общая сеть должна пережить правку. `down` снимает сеть и тома, которые в команде не исключены.
6. Проверь `docker compose config` до recreate.
7. Не ставь тег `latest` на сервис, который уже закреплён дайджестом или версией. Не добавляй `privileged` и монтирование сокета движка без явной просьбы.
8. Обнови `INDEX.md` и локальный `index.md` в том же изменении и проверь живой `docker ps` или health.

Секреты — в файле, который не коммитится, или в переменных. В репозиторий попадает только пример без значений.

## Заметка лаборатории

Пути, контейнеры, адреса и порты этой машины в скилл не входят. Блок локальной карты в системном промпте называет каталог `labSkillNotes`. Если там есть файл `compose-guard.md`, прочитай его и следуй ему. Если каталога нет, скажи, что в `devops-local.json` не задан `labSkillNotes`, и не выдумывай путь.
