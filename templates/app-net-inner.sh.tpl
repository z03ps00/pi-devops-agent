#!/bin/bash
# Template: runs as root inside the AWG netns and a private mount namespace,
# then drops privileges and execs the app.
# Copy next to the other launchers. Replace every <PLACEHOLDER>.
set -euo pipefail

APP_BIN="<APP_BIN>"
RESOLV="<RESOLV_CONF>"
CLIENT_ENV_HELPER="<CLIENT_ENV>"
RUN_UID="<RUN_UID>"
RUN_GID="<RUN_GID>"
RUN_USER="<RUN_USER>"
RUN_HOME="<RUN_HOME>"

[ -x "$APP_BIN" ] || { echo "<app> не установлен: $APP_BIN" >&2; exit 1; }
[ -f "$RESOLV" ] || { echo "нет $RESOLV" >&2; exit 1; }

mount --make-rprivate / 2>/dev/null || true
mount --bind "$RESOLV" /etc/resolv.conf
# Hide the engine socket so the app cannot leave the namespace via --network host.
for sock in /run/docker.sock /var/run/docker.sock; do
  [ -S "$sock" ] && mount --bind /dev/null "$sock" 2>/dev/null || true
done
. "$CLIENT_ENV_HELPER" awg
sysctl -q net.ipv6.conf.all.disable_ipv6=1 || true
sysctl -q net.ipv6.conf.default.disable_ipv6=1 || true
sysctl -q net.ipv4.tcp_mtu_probing=1 || true

exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups env \
  -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  -u ALL_PROXY -u all_proxy \
  HOME="$RUN_HOME" USER="$RUN_USER" LOGNAME="$RUN_USER" \
  PATH="$RUN_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  TERM="${TERM:-xterm-256color}" \
  COLORTERM="${COLORTERM:-truecolor}" \
  LANG="${LANG:-C.UTF-8}" \
  LC_ALL="${LC_ALL:-C.UTF-8}" \
  "$APP_BIN" "$@"
