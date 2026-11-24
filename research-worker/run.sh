#!/bin/sh
# Scheduler entry point (cron on Linux / launchd on macOS, every 5 minutes). worker.py takes the lock (one run at a
# time), caps each job's time and writes the heartbeat. Runs at low priority. Pause: touch research-worker/PAUSED.
DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"   # cron/launchd start with a minimal PATH
exec nice -n 15 python3 "$DIR/worker.py" "$@"
