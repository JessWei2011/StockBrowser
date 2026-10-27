# Original User Request

## 2026-10-26T16:39:10Z

全面檢核並修復 StockBrowser（台股即時監控系統）之後端與前端程式碼邏輯 BUG，特別徹底解決「新增個股流程時常無回應、介面卡死或後端事件迴圈遭阻塞」之關鍵缺陷，確保系統操作順暢與高穩定性。

Working directory: /Users/jess/Desktop/Python/StockBrowser
Integrity mode: development

## Requirements

### R1. 修復新增個股無回應與阻塞問題
徹底排查並修復新增個股（Add Watchlist Item）流程中的所有阻塞瓶頸。
- 確保後端在執行個股查詢、合約快照（Snapshot）、行情訂閱（Quote/Tick Subscription）及自選同步時，絕不阻塞 FastAPI 的 asyncio 主事件迴圈（Event Loop），即使外部券商 API 延遲或網路瞬斷，API 亦能在合理逾時限制內快速響應。
- 前端在新增個股時須具備樂觀更新（Optimistic UI）或即時狀態反饋，避免因後續重新載入整體 bootstrap 資料過重而造成介面無回應或按鈕永久卡在「新增中...」。
- 完善例外捕捉與錯誤提示機制，當代號不存在、重複加入或連線異常時，提供使用者清晰友善的反饋並正確重設按鈕狀態。

### R2. 全專案非同步調度與操作邏輯安全檢視
全面檢視前後端資料流與操作邏輯，修正現存與潛在的架構與程式碼 BUG：
- 審查所有 REST API 路由與 WebSocket 廣播處理常式，消除任何在 async 函式中直接執行耗時同步 I/O 或券商 API 呼叫的阻塞程式碼（例如持股同步、MA 運算、合約檢索等）。
- 檢驗自選股群組增刪改、排序、WebSocket 重連與資料快取（QuoteStore、SQLite 持久化）的競態條件（Race Conditions）與資料一致性。
- 檢驗前端連線狀態重連、記憶體洩漏（未清理之 Timer、EventListener 或 WebSocket 監聽器）及邊界情況（如無網路、市場開休市切換、空資料集）。

### R3. 自動化測試與回歸驗證
確保所有修正具備客觀的測試驗證手段：
- 現有後端測試套件（`pytest backend/tests`）全數通過且無報錯。
- 為「新增個股」與「非同步非阻塞機制」補充專屬單元/整合測試，驗證在模擬券商延遲情境下 API 依然能正常且快速返回。
- 前端 TypeScript 編譯與打包（`npm run build`）順暢無警告與錯誤。

## Acceptance Criteria

### 功能性與無卡頓驗證
- [ ] 在後端運行時調用新增個股 API（POST `/api/groups/{group_id}/items`），請求能立即於 1 秒內回傳，不再因 Shioaji 同步操作導致事件迴圈停頓。
- [ ] 前端點擊「新增個股」或按 Enter 送出後，介面能立即反應；若加入成功自選清單即刻呈現新項目，若失敗能跳出明確原因並恢復可操作狀態，按鈕絕不發生卡死在「新增中...」的情況。
- [ ] 模擬外部券商 API 呼叫延遲（例如 3 秒以上延遲或超時）的情境下，後端其他路由（如 `/api/bootstrap`、WebSocket 廣播等）依然能正常處理請求而不受阻斷。

### 程式碼品質與穩定性驗證
- [ ] 執行 `PYTHONPATH=. pytest backend/tests`，現有及新增的測試用例全數通過（100% Pass）。
- [ ] 進入 `frontend` 目錄執行 `npm run build`，TypeScript 型別檢查與 Vite 打包完全成功，無編譯錯誤。
- [ ] 程式碼中所有涉及 Shioaji 或耗時計算的呼叫均經由非同步執行緒池（`asyncio.to_thread` 或專屬執行緒 Worker）隔離，保護主 asyncio 事件迴圈。
