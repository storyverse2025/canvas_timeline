#!/bin/bash
# Fallback watchdog for the canvas_timeline dev server.
#
# The real supervisor is systemd `canvas-timeline.service` (pnpm dev → vite :8080 + claude bridge).
# This script used to probe port 3000 with `lsof` — but :3000 is root's nginx, invisible to the
# ubuntu user's lsof, so it decided "down" every minute and started another `npm run dev`.
# From cron that piled up 129 copies (~60 GB) within two hours of boot (2026-09-13).
#
# Now it only acts when BOTH the systemd service is inactive AND nothing answers on :8080,
# and it never starts a second copy while one is already running.

PROJECT_DIR="/data/repos/canvas_timeline"
PORT=8080
LOG_FILE="$PROJECT_DIR/server_monitor.log"

if systemctl is-active --quiet canvas-timeline.service 2>/dev/null; then
    exit 0
fi

# Vite serves HTTPS unless DEV_HTTPS=0; accept any HTTP answer on either scheme.
if curl -sk -o /dev/null --max-time 5 "https://127.0.0.1:$PORT/" || curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/"; then
    exit 0
fi

if pgrep -f "$PROJECT_DIR/node_modules/.bin/../.pnpm/concurrently" > /dev/null; then
    echo "$(date): :$PORT not answering but a dev server process exists; not starting another." >> "$LOG_FILE"
    exit 0
fi

echo "$(date): systemd service inactive and :$PORT down. Starting dev server..." >> "$LOG_FILE"
cd "$PROJECT_DIR" || exit 1
nohup npm run dev > "$PROJECT_DIR/vite.log" 2>&1 &
echo "$(date): Server started." >> "$LOG_FILE"
