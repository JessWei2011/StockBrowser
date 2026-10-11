#!/usr/bin/env bash
# StockBrowser 一鍵停止腳本
echo "=================================================="
echo "    StockBrowser 伺服器停止中...                   "
echo "=================================================="

PID=$(lsof -ti :8000 2>/dev/null || true)
if [ -n "$PID" ]; then
    kill -9 $PID
    echo "✔ 已終止 StockBrowser 程序 (PID: $PID)"
    osascript -e 'display notification "StockBrowser 伺服器已停止！" with title "StockBrowser"'
else
    echo "StockBrowser 目前未運行。"
    osascript -e 'display notification "StockBrowser 目前未運行" with title "StockBrowser"'
fi

sleep 1
osascript -e 'tell application "System Events" to set visible of process "Terminal" to false'
exit 0
