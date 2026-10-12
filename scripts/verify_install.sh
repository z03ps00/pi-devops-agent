#!/bin/bash
# Verify that devops-context skills are installed (usually as symlinks) into a target skills dir.
# Usage: verify_install.sh --target <skills-directory>
set -uo pipefail

CANON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/skills"
TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: verify_install.sh --target <skills-directory>"
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TARGET" ] || { echo "Missing --target" >&2; exit 2; }
[ -d "$TARGET" ] || { echo "Target not found: $TARGET" >&2; exit 1; }

CORE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/expected-skills.txt"
fail=0
count=0
while IFS= read -r name; do
  [ -n "$name" ] || continue
  count=$((count + 1))
  dst="$TARGET/$name"
  if [ ! -e "$dst" ]; then
    printf 'FAIL  %-24s отсутствует\n' "$name"; fail=$((fail + 1)); continue
  fi
  if [ ! -f "$dst/SKILL.md" ]; then
    printf 'FAIL  %-24s нет SKILL.md\n' "$name"; fail=$((fail + 1)); continue
  fi
  if ! grep -q '^name:' "$dst/SKILL.md" 2>/dev/null; then
    printf 'WARN  %-24s SKILL.md без name\n' "$name"; fail=$((fail + 1)); continue
  fi
  printf 'OK    %-24s\n' "$name"
done < "$CORE_FILE"

for src in "$CANON_DIR"/*/; do
  name="$(basename "$src")"
  grep -qx "$name" "$CORE_FILE" && continue
  if [ -e "$TARGET/$name/SKILL.md" ]; then
    printf 'OK    %-24s optional\n' "$name"
  else
    printf 'SKIP  %-24s optional, не установлен\n' "$name"
  fi
done

echo "---"
if [ "$fail" -eq 0 ]; then
  echo "OK: $count/$count скиллов установлены в $TARGET"
  exit 0
else
  echo "FAIL: $fail проблем из $count"
  exit 1
fi
