#!/bin/bash
# Template: launch an application on the host or inside one network profile.
# Copy next to the other launchers named by INDEX.md. Replace every <PLACEHOLDER>.
# <PROFILE_ID> is the id from network.profiles. <CONTAINER> is that profile's container.
set -euo pipefail

PROFILE_ID="<PROFILE_ID>"
CONTAINER="<CONTAINER>"
EXEC_SCRIPT="<NET_EXEC>"
APP_BIN="<APP_BIN>"
CLIENT_ENV_HELPER="<CLIENT_ENV>"
MODE_FILE="<MODE_FILE>"

mkdir -p "$(dirname "$MODE_FILE")"
chmod 700 "$(dirname "$MODE_FILE")"
[ -f "$MODE_FILE" ] || printf '%s\n' "$PROFILE_ID" > "$MODE_FILE"
chmod 600 "$MODE_FILE"

apply_env() {
  if [ -n "${CLIENT_ENV_HELPER:-}" ] && [ -f "$CLIENT_ENV_HELPER" ]; then
    # shellcheck disable=SC1090
    . "$CLIENT_ENV_HELPER" "$1"
  fi
}

[ -x "$APP_BIN" ] || { echo "<app> не установлен: $APP_BIN" >&2; exit 1; }
MODE=$(tr -d '[:space:]' < "$MODE_FILE" 2>/dev/null || printf 'host')
[ -n "$MODE" ] || MODE=host

case "$MODE" in
  host|direct)
    apply_env direct
    exec "$APP_BIN" "$@"
    ;;
  "$PROFILE_ID")
    if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
      echo "Контейнер профиля $PROFILE_ID не запущен. <app> заблокирован (kill switch)." >&2
      exit 1
    fi
    if [ -z "$EXEC_SCRIPT" ] || [ ! -x "$EXEC_SCRIPT" ]; then
      echo "Нет скрипта входа в namespace (network.netExec)." >&2
      exit 1
    fi
    apply_env "$PROFILE_ID"
    exec sudo "$EXEC_SCRIPT" <app> "$@"
    ;;
  *)
    echo "Неизвестный профиль <app>: $MODE (ожидается host или $PROFILE_ID)" >&2
    exit 1
    ;;
esac
