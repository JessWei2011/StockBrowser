#!/bin/zsh -l
PORT=8050
PID=$(lsof -ti :$PORT 2>/dev/null || true)
if [ -n "$PID" ]; then
  kill -9 $PID
  echo "✅ 已停止損益分析系統 (Port $PORT, PID: $PID)"
else
  echo "ℹ️ 損益分析系統未在運行中。"
fi
