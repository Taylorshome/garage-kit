#!/bin/sh
# Daily health check entry point for cron/launchd (see health-check.py).
DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
exec nice -n 15 python3 "$DIR/health-check.py" "$@"
