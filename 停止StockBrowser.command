#!/usr/bin/env bash
# StockBrowser 一鍵停止腳本
echo "=================================================="
echo "    StockBrowser 伺服器停止中...                   "
echo "=================================================="

PID=$(lsof -tiTCP:8000 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null || true
    echo "✔ 已終止 StockBrowser 程序"
    osascript -e 'display notification "StockBrowser 伺服器已停止！" with title "StockBrowser"' 2>/dev/null || true
else
    echo "StockBrowser 目前未運行。"
    osascript -e 'display notification "StockBrowser 目前未運行" with title "StockBrowser"' 2>/dev/null || true
fi

sleep 1
osascript -e 'tell application "System Events" to set visible of process "Terminal" to false'
exit 0
