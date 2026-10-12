#!/bin/bash
# macOS double-click launcher. Copy to the Desktop or run from the clone.
# If this file was copied out of the clone, set PI_DEVOPS_CTL to scripts/pi-devops-ctl.
set -euo pipefail
if [ -n "${PI_DEVOPS_CTL:-}" ]; then
  exec "$PI_DEVOPS_CTL"
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/scripts/pi-devops-ctl"
