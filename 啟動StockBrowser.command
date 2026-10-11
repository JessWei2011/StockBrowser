#!/usr/bin/env bash
# StockBrowser 一鍵背景啟動腳本
PROJECT_DIR="/Users/jess/Desktop/Python/StockBrowser"
cd "$PROJECT_DIR"

echo "=================================================="
echo "    StockBrowser (台股即時看盤系統) 背景啟動中...  "
echo "=================================================="

# 檢查是否已在運行
PID=$(lsof -ti :8000 2>/dev/null || true)
if [ -n "$PID" ]; then
    echo "✔ StockBrowser 伺服器已在運行中 (PID: $PID)"
    osascript -e 'display notification "StockBrowser 伺服器已在運行中！" with title "StockBrowser"'
    open "http://localhost:8000"
    sleep 1
    osascript -e 'tell application "System Events" to set visible of process "Terminal" to false'
    exit 0
fi

# 確保已編譯前端
if [ ! -d "frontend/dist" ]; then
    echo "前端尚未編譯，正在進行構建..."
    (cd frontend && npm run build)
fi

# 背景啟動後端
mkdir -p data
nohup python3 -m backend.app.main > data/server.log 2>&1 &
SERVER_PID=$!

echo "伺服器背景程序 PID: $SERVER_PID，正在等待初始化..."

# 等待 port 8000 啟動 (最多等 10 秒)
READY=0
for i in {1..10}; do
    if lsof -ti :8000 >/dev/null 2>&1; then
        READY=1
        break
    fi
    sleep 1
done

if [ $READY -eq 1 ]; then
    echo "✔ 伺服器啟動成功！"
    osascript -e 'display notification "StockBrowser 伺服器已在背景成功啟動！" with title "StockBrowser"'
    open "http://localhost:8000"
else
    echo "⚠ 啟動超時或發生錯誤，請檢查 data/server.log"
    osascript -e 'display notification "伺服器啟動超時，請檢查日誌" with title "StockBrowser"'
fi

# 延遲 1 秒後將 Terminal 收到背景隱藏
sleep 1
osascript -e 'tell application "System Events" to set visible of process "Terminal" to false'
exit 0
