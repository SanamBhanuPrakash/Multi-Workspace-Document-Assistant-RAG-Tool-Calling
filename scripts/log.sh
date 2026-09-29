#!/usr/bin/env bash
# Append a timestamped entry to PROJECT_LOG.md.
# usage: scripts/log.sh <TYPE> "<message>"
# TYPE: DECISION | DONE | BUG | SECURITY | TEST | DEPLOY | NOTE | AI
set -euo pipefail
cd "$(dirname "$0")/.."
type="${1:?type required}"; shift
printf '%s | %-8s | %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$type" "$*" >> PROJECT_LOG.md
