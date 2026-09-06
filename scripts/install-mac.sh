#!/bin/zsh
# Install (or refresh) the curator as a launchd agent on this Mac.
# Run it from a terminal after any source change: `scripts/install-mac.sh`.
#
# Why an install dir on the internal disk: macOS lets a launchd-spawned process
# see but not read files on an external volume, so the SSD checkout cannot be
# what launchd runs. The install dir holds the built CLI, production deps, a
# copy of .env, and THE state file; the checkout's .env points at that state so
# manual runs and the schedule agree.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/.local/share/jellyfin-curator"
LABEL="dev.jellyfin-curator.schedule"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
HOUR="${CURATOR_RUN_HOUR:-4}"

cd "$REPO"
[ -f .env ] || { echo ".env missing in $REPO" >&2; exit 1; }
pnpm build
mkdir -p "$APP" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
rsync -a --delete dist/ "$APP/dist/"
cp package.json pnpm-lock.yaml .npmrc "$APP/"
cp scripts/mac-launcher.mjs "$APP/scheduled-run.mjs"
(cd "$APP" && pnpm install --prod --frozen-lockfile --silent)

# .env: everything from the checkout, with state pinned to the install dir.
grep -v '^CURATOR_STATE_PATH=' .env > "$APP/.env"
echo "CURATOR_STATE_PATH=$APP/state.json" >> "$APP/.env"
# The checkout's .env points at the same state so `pnpm curator status` here is truthful.
if grep -q '^CURATOR_STATE_PATH=' .env; then
  sed -i '' "s|^CURATOR_STATE_PATH=.*|CURATOR_STATE_PATH=$APP/state.json|" .env
else
  echo "CURATOR_STATE_PATH=$APP/state.json" >> .env
fi
# State: adopt the checkout's file once; from then on the install dir is its only home.
if [ ! -f "$APP/state.json" ] && [ -f curator-data/state.json ]; then
  mv curator-data/state.json "$APP/state.json"
  echo "moved curator-data/state.json to $APP/state.json"
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$APP/scheduled-run.mjs</string></array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/jellyfin-curator.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/jellyfin-curator.log</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin</string></dict>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed: $APP"
echo "schedule:  daily at $(printf '%02d' "$HOUR"):00 (CURATOR_MIN_DAYS_BETWEEN_RUNS in .env sets the real cadence)"
echo "log:       $HOME/Library/Logs/jellyfin-curator.log"
echo "run now:   launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "remove:    launchctl bootout gui/$(id -u)/$LABEL && rm '$PLIST'"
