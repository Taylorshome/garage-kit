#!/bin/sh
# Install the research worker schedule on this computer (every 5 minutes).
#   macOS: a launchd agent (~/Library/LaunchAgents/com.garage.research-worker.plist)
#   Linux / Raspberry Pi: a crontab line
# Usage: research-worker/install.sh [--uninstall]
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL=com.garage.research-worker
if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  if [ "$1" = "--uninstall" ]; then rm -f "$PLIST"; echo "removed $LABEL"; exit 0; fi
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DIR/run.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/garage-research.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/garage-research.log</string>
</dict></plist>
PL
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "installed launchd agent $LABEL (log: ~/Library/Logs/garage-research.log)"
else
  LINE="*/5 * * * * $DIR/run.sh >> $DIR/worker.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v "$DIR/run.sh" ; [ "$1" = "--uninstall" ] || echo "$LINE" ) | crontab -
  [ "$1" = "--uninstall" ] && echo "removed the cron line" || echo "installed cron: $LINE"
fi
