#!/bin/bash

PROJECT_DIR="/home/ubuntu/repos/canvas_timeline"
PORT=3000
LOG_FILE="$PROJECT_DIR/server_monitor.log"

# Check if the port is in use
if ! lsof -i :$PORT > /dev/null; then
    echo "$(date): Server is down on port $PORT. Restarting..." >> "$LOG_FILE"
    cd "$PROJECT_DIR" || exit
    # Start the server in the background and redirect output to a log
    nohup npm run dev -- --host 0.0.0.0 > "$PROJECT_DIR/vite.log" 2>&1 &
    echo "$(date): Server started." >> "$LOG_FILE"
else
    # echo "$(date): Server is up." >> "$LOG_FILE"
    :
fi
