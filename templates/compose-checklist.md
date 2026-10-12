# Compose edit checklist

Перед сохранением правки `docker-compose*.yml`:

1. Прочитать текущий файл и менять минимально.
2. Если меняется `command`, `entrypoint` или `healthcheck`: развернуть YAML-фолдинг в итоговую строку, прогнать `sh -n` и вынести сложную логику в отдельный `.sh`.
3. Сервис с `network_mode: container:<name>` не может иметь `ports`, `extra_hosts` и `dns`. DNS — монтированием `/etc/resolv.conf`.
4. Третий compose-файл передавать явно или через `COMPOSE_FILE`. Имя файла писать полностью (`docker-compose.mounts.yml`).
5. Для остановки предпочти `stop`, если общая сеть должна сохраниться. `down` снимает сеть.
6. После правки: `docker compose config`, затем recreate, если он нужен.
7. Обновить `INDEX.md` и локальный `index.md` в том же изменении.
8. Проверить свежим выводом (`docker ps`, health), не по памяти.
