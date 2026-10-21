#!/bin/zsh -l
# StockBrowser launchd 背景執行包裝腳本
cd "/Users/jess/Desktop/Python/StockBrowser" || exit 1

if [ -x /usr/libexec/path_helper ]; then
  eval "$(/usr/libexec/path_helper -s)"
fi
[ -f ~/.zprofile ] && source ~/.zprofile
[ -f ~/.zshrc ] && source ~/.zshrc

export PATH="/Users/jess/.local/bin:$PATH"

mkdir -p /Users/jess/Desktop/Python/StockBrowser/data

# 啟動後端 FastAPI server
exec /Users/jess/.local/bin/python3 -m backend.app.main
