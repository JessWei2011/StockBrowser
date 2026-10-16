#!/bin/zsh -l
# 台股已實現損益分析系統 一鍵啟動腳本
set -e

cd "$(dirname "$0")" || exit 1
PROJECT_DIR="$(pwd)"
PORT=8050

echo "=================================================="
echo "    📊 台股已實現損益統計系統 啟動中...           "
echo "=================================================="

# 1. 載入 macOS 環境變數
if [ -x /usr/libexec/path_helper ]; then
  eval "$(/usr/libexec/path_helper -s)"
fi
[ -f ~/.zprofile ] && source ~/.zprofile
[ -f ~/.zshrc ] && source ~/.zshrc

# 2. 尋找可用 Python
PYTHON_BIN=""
for candidate in \
  "$HOME/.local/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3" \
  "/Library/Frameworks/Python.framework/Versions/Current/bin/python3" \
  "/opt/homebrew/bin/python3" \
  "/usr/local/bin/python3" \
  "$(which python3 2>/dev/null)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    if "$candidate" -c "import fastapi, uvicorn" 2>/dev/null; then
      PYTHON_BIN="$candidate"
      break
    fi
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  echo "❌ [錯誤] 找不到已安裝 fastapi/uvicorn 的 Python 環境。"
  read "?按 Enter 鍵關閉..."
  exit 1
fi

# 3. 檢查 Port 8050 是否已被佔用，若有則重啟
OLD_PID=$(lsof -ti :$PORT 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  echo "⚠️ 發現舊進程 (PID: $OLD_PID)，正在重啟..."
  kill -9 $OLD_PID 2>/dev/null || true
  sleep 1
fi

# 4. 背景啟動服務
echo "🚀 正在啟動服務 (Port: $PORT)..."
nohup "$PYTHON_BIN" -m uvicorn pnl_tracker.app:app --host 0.0.0.0 --port $PORT > pnl_tracker/server.log 2>&1 &
SERVER_PID=$!

sleep 1.5

# 5. 自動開啟瀏覽器
echo "🌐 正在開啟瀏覽器: http://localhost:$PORT"
open "http://localhost:$PORT"

echo "=================================================="
echo "✅ 服務已成功在背景運行！"
echo "   網址: http://localhost:$PORT"
echo "   PID:  $SERVER_PID"
echo "   日誌: $PROJECT_DIR/pnl_tracker/server.log"
echo "=================================================="
