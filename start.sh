#!/usr/bin/env bash
set -e

# 切換至專案根目錄
cd "$(dirname "$0")"

echo "=================================================="
echo " Starting StockBrowser (台股即時跨裝置看盤系統) "
echo "=================================================="

# 確保已編譯前端
if [ ! -d "frontend/dist" ]; then
    echo "Frontend build not found, building frontend..."
    (cd frontend && npm run build)
fi

# 啟動 FastAPI 伺服器
echo "Starting backend server on http://0.0.0.0:8000 ..."
python3 -m backend.app.main
