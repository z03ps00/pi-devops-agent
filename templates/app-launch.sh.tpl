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
MODE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/<app>-vpn"
MODE_FILE="$MODE_DIR/mode"

mkdir -p "$MODE_DIR"
chmod 700 "$MODE_DIR"
[ -f "$MODE_FILE" ] || printf 'host\n' > "$MODE_FILE"
chmod 600 "$MODE_FILE"

[ -x "$APP_BIN" ] || { echo "<app> не установлен: $APP_BIN" >&2; exit 1; }
MODE=$(tr -d '[:space:]' < "$MODE_FILE" 2>/dev/null || printf 'host')
[ -n "$MODE" ] || MODE=host

case "$MODE" in
  host|direct)
    . "$CLIENT_ENV_HELPER" direct
    exec "$APP_BIN" "$@"
    ;;
  "$PROFILE_ID")
    if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
      echo "Контейнер профиля $PROFILE_ID не запущен. <app> заблокирован (kill switch)." >&2
      exit 1
    fi
    . "$CLIENT_ENV_HELPER" "$PROFILE_ID"
    exec sudo "$EXEC_SCRIPT" <app> "$@"
    ;;
  *)
    echo "Неизвестный профиль <app>: $MODE (ожидается host или $PROFILE_ID)" >&2
    exit 1
    ;;
esac
