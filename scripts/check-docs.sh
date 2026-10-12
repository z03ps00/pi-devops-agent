#!/bin/bash
# Live documentation check. Roots and regression patterns come from the local map.
# Without devops-local.json the check skips and exits 0.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/check-docs.mjs" "$@"
