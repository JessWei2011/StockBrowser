#!/bin/zsh -l
# StockBrowser 一鍵背景啟動腳本
set -e

cd "$(dirname "$0")" || exit 1
PROJECT_DIR="$(pwd)"

echo "=================================================="
echo "    StockBrowser (台股即時看盤系統) 啟動中...      "
echo "=================================================="

# 1. 載入 macOS 環境變數與路徑
if [ -x /usr/libexec/path_helper ]; then
  eval "$(/usr/libexec/path_helper -s)"
fi
[ -f ~/.zprofile ] && source ~/.zprofile
[ -f ~/.zshrc ] && source ~/.zshrc

# 2. 尋找安裝了 fastapi 的正確 Python 3.11+
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
  echo "❌ [錯誤] 找不到已安裝 fastapi/uvicorn 的 Python 3 環境。"
  echo "目前系統 python3: $(which python3 2>/dev/null || echo '未安裝')"
  echo "請確認 Python 3.11 環境已安裝相關套件。"
  read "?按 Enter 鍵關閉視窗..."
  exit 1
fi

echo "✔ 使用 Python: $PYTHON_BIN ($("$PYTHON_BIN" -V))"

# 3. 檢查是否已在運行
PID=$(lsof -tiTCP:8000 -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "✔ StockBrowser 伺服器已在運行中 (PID: $PID)"
  osascript -e 'display notification "StockBrowser 伺服器已在運行中！" with title "StockBrowser"' 2>/dev/null || true
  open "http://localhost:8000"
  sleep 1
  osascript -e 'tell application "System Events" to set visible of process "Terminal" to false' 2>/dev/null || true
  exit 0
fi

# 4. 確保前端已完成編譯
if [ ! -d "frontend/dist" ]; then
  echo "前端尚未編譯，正在進行構建..."
  (cd frontend && npm run build)
fi

# 5. 背景啟動後端
mkdir -p data
nohup "$PYTHON_BIN" -m backend.app.main > data/server.log 2>&1 &
SERVER_PID=$!

echo "伺服器背景程序 PID: $SERVER_PID，正在等待初始化..."

# 6. 等待 port 8000 啟動 (最多等 12 秒)
READY=0
for i in {1..12}; do
  if lsof -tiTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
  echo -n "."
done
echo ""

if [ $READY -eq 1 ]; then
  echo "✔ 伺服器啟動成功！"
  osascript -e 'display notification "StockBrowser 伺服器已在背景成功啟動！" with title "StockBrowser"' 2>/dev/null || true
  open "http://localhost:8000"
  sleep 1
  osascript -e 'tell application "System Events" to set visible of process "Terminal" to false' 2>/dev/null || true
  exit 0
else
  echo ""
  echo "❌ 啟動超時或發生錯誤，最近 20 行日誌 (data/server.log)："
  echo "--------------------------------------------------"
  tail -n 20 data/server.log 2>/dev/null || true
  echo "--------------------------------------------------"
  read "?按 Enter 鍵關閉視窗..."
  exit 1
fi
