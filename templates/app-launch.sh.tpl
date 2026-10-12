#!/bin/bash
# Template: launch an application inside the AWG network namespace, with an awg/direct switch.
# Copy next to the other launchers named by INDEX.md. Replace every <PLACEHOLDER>.
# <AWG_CONTAINER> is the proxy container from the local map (lab.awgContainer).
set -euo pipefail

AWG_CONTAINER="<AWG_CONTAINER>"
EXEC_SCRIPT="<NET_EXEC>"
APP_BIN="<APP_BIN>"
CLIENT_ENV_HELPER="<CLIENT_ENV>"
MODE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/<app>-vpn"
MODE_FILE="$MODE_DIR/mode"

mkdir -p "$MODE_DIR"
chmod 700 "$MODE_DIR"
[ -f "$MODE_FILE" ] || printf 'awg\n' > "$MODE_FILE"
chmod 600 "$MODE_FILE"

[ -x "$APP_BIN" ] || { echo "<app> не установлен: $APP_BIN" >&2; exit 1; }
MODE=$(tr -d '[:space:]' < "$MODE_FILE" 2>/dev/null || printf 'awg')
[ -n "$MODE" ] || MODE=awg

case "$MODE" in
  direct)
    . "$CLIENT_ENV_HELPER" direct
    exec "$APP_BIN" "$@"
    ;;
  awg)
    if ! docker inspect -f '{{.State.Running}}' "$AWG_CONTAINER" 2>/dev/null | grep -q true; then
      echo "Контейнер AWG не запущен. <app> заблокирован (kill switch)." >&2
      exit 1
    fi
    . "$CLIENT_ENV_HELPER" awg
    exec sudo "$EXEC_SCRIPT" <app> "$@"
    ;;
  *)
    echo "Неизвестный режим <app>: $MODE (ожидается awg или direct)" >&2
    exit 1
    ;;
esac
