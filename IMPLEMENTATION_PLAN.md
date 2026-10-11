# Mac mini 台股／ETF 跨裝置即時看盤：實作規劃

## 0. 文件目的與決策狀態

本文件是第一版（MVP）的實作規格，對象是後續執行工作的 AI agent 與開發者。目標是建立一個運行於 **Mac mini M4** 的私人網頁看盤系統；Mac 是唯一的行情擷取與狀態權威，透過 Tailscale 讓 Windows 與 iPhone 瀏覽同一份資料。

目前已確認：

- 使用者已有永豐金 Shioaji API 憑證。
- 第一版只做台股現貨與 ETF 的自選清單、即時行情；**不做下單、庫存、委託或成交功能**。
- 首要目標依序為：資料正確、各裝置在 1 秒內同步、低負載／低耗電、介面簡單。
- 僅使用者本人透過 Tailscale 存取。
- 必要欄位：成交價、漲跌、漲幅、最高、最低、總量、昨收、開盤、買價、賣價；不顯示均價。

尚未確認的偏好應以本文「預設值」實作，並保留設定擴充點，不應阻礙 MVP。

## 1. 可行性結論

此設計可行，而且很適合以 Mac mini 作為常駐主機。

- 永豐 Shioaji 提供交易時段內由交易所推送的即時股票行情。MVP 對每個商品使用單一 `Quote` 訂閱；它含成交、開高低、總量、漲跌和五檔買／賣價，足以提供本版所需欄位。這是事件驅動資料源，不必每秒輪詢。[官方股票串流文件](https://sinotrade.github.io/zh/tutor/market_data/streaming/stocks/)
- 由 **一個** Mac 後端統一訂閱每個商品，所有瀏覽器只讀取後端整理後的資料，可避免多裝置重複連永豐、重複耗用資源，也能保證每台裝置看到相同資料版本。
- Tailscale 建立裝置間的私有加密網路；服務不公開到網際網路，Windows/iPhone 只需開啟一個內網網址。即使 direct peer-to-peer 不可用，Tailscale 也可能透過 DERP 中繼，仍可運作但延遲會略增。
- 「即時每秒更新」定義為：行情到達後立刻寫入伺服器記憶體，前端最多每 1 秒收到一次合併後的變更。正常同一 Tailnet 網路下可望低於一秒；不把網路傳輸保證為嚴格 1,000 ms SLA。

## 2. 範圍

### 2.1 MVP 必做

1. 自選群組：建立、重新命名、刪除、排序群組。
2. 自選商品：以股票代號或名稱搜尋、新增、移除、排序；僅允許台股股票與 ETF。
3. 報價表：顯示本文件已確認的欄位，以及資料來源時間與連線狀態。
4. 永豐行情：為目前所有自選商品維護即時成交與五檔中的最佳買／賣價。
5. 一秒合併推播：所有開啟的桌機／手機畫面都接收相同序列版本的更新。
6. 重啟保留：群組、排序與商品清單保存於 SQLite；服務重啟後自動恢復訂閱。
7. 私網存取：只接受 Tailscale 網路的連線；不將 API 憑證或行情上游端點暴露給瀏覽器。
8. 可觀測性：健康檢查、資料最後更新時間、訂閱數、重連次數、結構化日誌。

### 2.2 MVP 明確不做

- 下單與任何交易操作。
- 登入頁、多使用者／角色、雲端帳號同步。
- K 線、技術指標、新聞、警示通知、盤後分析。
- 將完整逐筆 tick 長期存檔。
- 對外網公開、Port Forwarding、Cloudflare Tunnel。

## 3. 成功準則與限制

| 面向 | 可驗收標準 |
| --- | --- |
| 資料一致性 | 任一商品在多個已連線瀏覽器中，最後一次完整資料的 `version` 相同；不同裝置顯示不應由各自向永豐取得。 |
| 更新延遲 | 行情 callback 接收後，伺服器在下一個 1 秒推播週期送出；前端收到後立即渲染。 |
| 正確性 | 每筆畫面資料附 `source_ts`、`received_at`、`market_state`；逾時或離線時顯示「最後更新」而非假裝即時。 |
| 負載 | 空閒時無輪詢；每秒最多一次 WebSocket 批次推播；只推送有變更的商品。 |
| 可用性 | 後端／行情連線中斷時可自動重連並重建訂閱；重新同步前端完整狀態。 |
| 安全性 | 憑證僅位於 Mac 的受限檔案；服務不綁定公網介面；僅 Tailnet 裝置可存取。 |

## 4. 架構

```text
                  永豐 Shioaji 行情串流
                           |
                    Quote callback（單一訂閱／商品）
                           v
    Mac mini M4 ┌──────────────────────────────────────────────┐
                │ Python backend                               │
                │  QuoteAdapter -> QuoteStore (記憶體最新狀態) │
                │                    |                         │
                │              1 Hz BatchPublisher             │
                │                    |                         │
                │ SQLite <-> WatchlistService <-> REST API     │
                │                    |                         │
                │          WebSocket /ws/quotes                │
                └───────────────────┬──────────────────────────┘
                                    Tailscale
                  ┌─────────────────┼──────────────────┐
                  v                 v                  v
             Windows browser   iPhone Safari      Mac browser
             同一 Web UI       同一 Web UI         同一 Web UI
```

### 4.1 技術選型（MVP 固定）

| 層次 | 選擇 | 原因 |
| --- | --- | --- |
| 行情介接 | Python 3.12 + `shioaji` 官方 SDK | 官方支援、可直接接收 callback，避免自行代理券商協定。 |
| API／推播 | FastAPI + Uvicorn + 原生 WebSocket | 單一 Python 程序即可處理 REST、健康檢查和低成本推播；不需 Redis 或訊息佇列。 |
| 狀態 | 記憶體 `QuoteStore` | 最新行情只需保留最新值，讀寫延遲低、無磁碟寫入風暴。 |
| 設定資料 | SQLite（WAL 模式） | 自選清單很小、可攜、無須獨立資料庫服務。 |
| 前端 | TypeScript + React + Vite；原生 CSS | 表格狀態與 WebSocket 容易管理；避免大型元件庫與圖表庫。 |
| 部署 | `launchd` 常駐服務 + Tailscale | 適合 macOS 開機自啟、低維護。 |

不要在 MVP 引入 Docker、Redis、PostgreSQL、Kafka、輪詢型資料刷新或雲端中介服務。它們會增加故障面與常駐資源，沒有解決目前的需求。

### 4.2 訂閱容量與群組切換策略（重要）

官方限制為每個 API 行程最多 **200 個 `api.subscribe()` 訂閱**。MVP 對每一個不重複商品只維持 **一個 `Quote` 訂閱**，而非同時訂閱 `Tick` 與 `BidAsk`；因此可在上限內保有最多 200 檔不重複的台股／ETF 即時資料。所有群組的重複商品只計一次。

- 例：5 個群組、每組 30 檔、且完全不重複 = 150 個訂閱，安全可行。
- 例：7 個群組、每組 30 檔、且完全不重複 = 210 個訂閱，超過限制，系統必須拒絕新增第 201 個不重複商品並提示使用者。
- 介面應固定顯示 `unique subscribed / 200`，群組內同檔重複不增加計數。
- 系統在服務啟動時訂閱所有自選群組的「不重複聯集」，切換群組時**不對永豐重新訂閱、不呼叫 snapshot、也不等待 30 檔新行情**。後端已持有最新快取，直接向該瀏覽器送出該群組約 30 檔的本機快照，再持續以 delta 更新。
- 30 檔輕量 JSON 快照和 DOM 切換在 Mac mini／Tailscale 環境應無可感卡頓；真正可能造成卡頓的是錯誤設計成「切群組才 subscribe／輪詢 30 檔」，MVP 禁止此作法。
- 若未來確實需要超過 200 檔，另做「即時群組上限 200 + 非即時群組顯示快取與明確 stale 標示」的模式；不可暗中取消訂閱而仍標成即時。

官方也要求每個程式行程維持一個已登入連線、盤中使用訂閱而非 snapshot 輪詢；訂閱資料不計入流量。[官方使用限制](https://sinotrade.github.io/zh/tutor/limit/)

### 4.3 為何採用「推播合併」而非前端每秒輪詢

1. Shioaji callback 是即時來源；後端接收時立即覆寫該商品的最新資料並標記 dirty。
2. 固定 1 Hz 發送器取得所有 dirty 商品，依固定順序組成一個 WebSocket `quote_delta` 訊息，然後清除 dirty 標記。
3. 每個前端將 delta 併入自己的快取後才重繪變更的列。
4. 新連線、重新連線或偵測到版本缺口時，後端送完整 `snapshot`。

這讓交易量很大時仍最多每秒對每個客戶端送出一個批次，並維持「最新狀態」而非不必要地傳遞全部 tick。官方文件也明確指出 snapshot 是請求型資料，會消耗頻寬，不應在盤中重複輪詢；盤中應使用訂閱行情。[官方 Snapshot 文件](https://sinotrade.github.io/tutor/market_data/snapshot/)

## 5. 資料模型與正確性規則

### 5.1 SQLite schema

```sql
CREATE TABLE watchlist_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE watchlist_items (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES watchlist_groups(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  exchange TEXT NOT NULL,           -- TSE 或 OTC，從合約資料取得
  security_type TEXT NOT NULL,      -- STOCK 或 ETF（UI 分類；上游仍用 STK）
  position INTEGER NOT NULL,
  UNIQUE(group_id, code)
);
```

### 5.2 記憶體 `QuoteState`

```ts
type QuoteState = {
  code: string;
  last: number | null;
  bid: number | null;               // 最佳買價
  ask: number | null;               // 最佳賣價
  open: number | null;
  high: number | null;
  low: number | null;
  totalVolume: number | null;
  previousClose: number | null;
  change: number | null;            // last - previousClose
  changePercent: number | null;     // change / previousClose * 100
  sourceTs: string | null;          // 交易所／Shioaji 事件時間
  receivedAt: string;               // Mac 收到時間
  dataStatus: 'live' | 'stale' | 'initializing' | 'closed' | 'error';
  revision: number;
};
```

### 5.3 欄位合併規則

- `Quote` 更新：成交價、開高低、總量、來源時間、最佳買價與最佳賣價；以 `sourceTs` 防止較舊事件覆蓋較新事件。`bid_price[0]`／`ask_price[0]` 分別為最佳買／賣價，陣列為空時顯示 `—`。
- `昨收`：每天每商品僅在開盤前／服務啟動／首次加入自選時，經由受限的 snapshot 或正式日資料取得並快取。不可盤中每秒呼叫 snapshot。
- `漲跌`／`漲幅`：只在 `last` 與 `previousClose` 都有效且昨收非 0 時計算；否則顯示 `—`。
- 空值不可補成 `0`；`0` 與尚未收到資料必須被區分。
- 盤後不把舊資料誤標示為 live。交易時段外為 `closed`，若資料來源超過可設定門檻（預設 15 秒）未更新則為 `stale`。

## 6. API 與同步協定

### 6.1 REST（控制面）

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/health` | 程序、資料庫、Shioaji 連線、最後行情時間。 |
| `GET` | `/api/v1/bootstrap` | 群組、商品、完整報價快照、全域版本。 |
| `POST` | `/api/v1/groups` | 建立群組。 |
| `PATCH` | `/api/v1/groups/{id}` | 改名或排序。 |
| `DELETE` | `/api/v1/groups/{id}` | 刪除群組及其商品。 |
| `POST` | `/api/v1/groups/{id}/items` | 以代號新增商品；驗證是可用的台股／ETF 合約。 |
| `PATCH` | `/api/v1/groups/{id}/items/order` | 儲存商品排序。 |
| `DELETE` | `/api/v1/groups/{id}/items/{code}` | 移除商品並依全域參照計數更新訂閱。 |
| `GET` | `/api/v1/instruments/search?q=` | 依本機合約快取搜尋代號／名稱。 |

所有變更操作成功後應立刻寫 SQLite、更新記憶體訂閱集合並廣播 `watchlist_changed`。由於只有一位使用者，不需要複雜衝突解決；仍應附 `updated_at`／ETag，避免快速雙裝置操作覆蓋而無紀錄。

### 6.2 WebSocket（資料面）

- URL：`wss://<mac-tailnet-name>/ws/quotes`（本機開發可為 `ws://`）。
- 連線後伺服器先送 `snapshot`，包含 `serverVersion` 與完整 `QuoteState`。
- 每秒最多送一個 `quote_delta`：`{ type, serverVersion, generatedAt, quotes: QuoteState[] }`。
- 自選清單異動送 `watchlist_changed`，客戶端重新取得 `/bootstrap`。
- 每 25 秒 ping/pong；非正常斷線採指數退避重連（1、2、4、8、15 秒上限）。
- 客戶端發現 `serverVersion` 不連續，忽略之後 delta，重新抓 `/bootstrap` 再連線。

此協定以「快照 + 版本化增量」取代「只靠增量」，因此重連、手機背景休眠與短暫切換 Wi-Fi 都能自動回到正確最新狀態。

## 7. 行情訂閱生命週期

1. 啟動：讀取 SQLite 全部自選，建立 `wanted_codes = unique(all items)`。
2. 登入 Shioaji、載入合約資料並驗證每個商品可用、為每個 code 訂閱一個 `Quote`；訂閱聯集不可超過 200 個。
3. 初始資料：一次性批次取得必要的初始／昨收資料（單次 snapshot 上限與當日配額依 API 文件及帳戶權限實測），之後由串流更新。
4. 加入商品：先驗證合約、取得一次初始資料，再訂閱；回覆 API 前確認訂閱成功或返回清楚錯誤。
5. 移除商品：只有當該 code 不再被任一群組參照時才 unsubscribe，並從記憶體狀態移除。
6. 行情斷線：標記全體 `stale`，依指數退避重新登入／重連，成功後重新訂閱 `wanted_codes`，重新取得一次完整狀態並送 `snapshot`。

Callback 本身必須只做資料驗證、合併與設定 dirty flag；不可在 callback 中做網路 I/O、SQLite 寫入或直接廣播。官方 Quote Manager 範例也建議接收行情的處理保持精簡，並以集合避免重複訂閱。[官方 Quote Manager 指南](https://sinotrade.github.io/tutor/advanced/quote_manager_basic/)

## 8. 前端 UX 規格

### 8.1 Desktop

- 參考 `1.png` 的資訊密度：頂部為群組 tabs／下拉、搜尋加商品與連線狀態；主區為單一可捲動報價表。
- 欄位順序：商品、成交價、漲跌、漲幅、買價、賣價、最高、最低、總量、昨收、開盤。
- 漲為紅、跌為綠、平盤／未知為中性色；不能只依顏色判讀，必須同時有 `▲`／`▼`／`—` 文字。
- 商品欄與操作欄 sticky；表頭 sticky。不要放下單按鈕。
- 顯示「行情正常／最後更新 N 秒前／重連中／盤後」與最後接收時間。

### 8.2 iPhone

- 不強迫將 11 欄壓到窄螢幕：採橫向可捲動表格，商品與成交價固定在左；或將每商品轉為兩行緊湊卡片（實作時二選一，優先可讀性）。
- 頁面不可每秒整頁重繪；只更新有變動的數字節點，避免捲動跳動和額外耗電。
- 當 Safari 進入背景，瀏覽器可能暫停 WebSocket；回到前景必須立即重新抓 bootstrap。

## 9. 安全與部署

### 9.1 憑證與網路

- Shioaji API key、secret、憑證檔案與密碼只存於 Mac：`~/.config/stock-browser/`（目錄 `0700`、檔案 `0600`），不進 Git、不放前端、不印到 log。
- 使用 `.env.example` 只列出變數名稱；真實 `.env` 加入 `.gitignore`。
- 後端預設只綁定 Tailscale IP，或綁 `127.0.0.1` 再由 Tailscale Serve 代理；二者選一並以實際 Tailscale 版本驗證。
- 啟用 Tailscale HTTPS 時使用 TLS WebSocket（`wss`）；若只在 Tailnet HTTP，前端也不得有任何外部第三方資源。
- Tailnet ACL／裝置管理應限制僅此 Mac、Windows 和 iPhone；雖是單人仍不要把服務曝露至公開網路。

### 9.2 macOS 常駐

- 用使用者層級 `LaunchAgent` 讓服務在登入後啟動；設定 `KeepAlive` 與 stdout/stderr 日誌輪替。
- Mac mini 必須避免在交易時段睡眠。採排程方式僅在台股盤前至盤後維持喚醒；其他時段允許正常節能。實際睡眠／喚醒設定需先與使用者確認，因為會影響整台主機電力偏好。
- 將「服務可連」和「上游行情正常」分開：`health` 必須明確回傳兩者。

## 10. 低耗電／低負載設計檢核表

- [ ] 僅一個 Shioaji session，且每個不重複 code 恰一組 `Quote` 訂閱，總數不超過 200。
- [ ] 只訂閱所有群組聯集中的商品；移除最後一個參照時取消訂閱。
- [ ] 不以 HTTP snapshot 做盤中輪詢。
- [ ] WebSocket 每客戶端每秒最多一個 delta，且只包含 dirty codes。
- [ ] 前端僅 patch 變動儲存格；不重建整張表、不執行每秒 API polling。
- [ ] SQLite 僅在自選設定異動時寫入，行情永不逐筆寫盤。
- [ ] 無動畫、圖表、背景影像、第三方字型與 analytics。
- [ ] 沒有客戶端時仍保留必要行情狀態，但不建立推播 payload；可在後續版本評估是否盤中無客戶端自動停訂閱。

## 11. 建議專案結構

```text
StockBrowser/
  backend/
    app/
      main.py                 # FastAPI app / lifespan
      api/                    # REST 與 WebSocket endpoints
      domain/                 # QuoteState、群組／商品模型
      services/
        shioaji_adapter.py    # 登入、合約、訂閱、callback
        quote_store.py        # 記憶體合併、revision、stale 判定
        publisher.py          # 1 Hz delta 批次與客戶端管理
        watchlist_service.py  # SQLite 與訂閱聯集同步
      repositories/           # SQLite access
      settings.py
    tests/
    pyproject.toml
  frontend/
    src/
      api/ websocket/ components/ features/watchlist/
    package.json
  deploy/
    com.user.stock-browser.plist
    stock-browser.env.example
  docs/
  IMPLEMENTATION_PLAN.md
```

## 12. 實作里程碑與驗收

### M0：先決條件與假資料垂直切片

建立後端、前端、SQLite migration、REST、WebSocket 協定和假的 `QuoteAdapter`。可在兩個瀏覽器操作同一自選群組，並每秒同步假行情。

**驗收：** 新增／移除／排序可持久化；重新整理或另一裝置在 1 秒內一致；重連取得完整 snapshot。

### M1：Shioaji 單商品驗證

接上真實 Shioaji，但只用一個已知股票與一個 ETF。確認 macOS 上的登入、合約辨識、`Quote`、初始昨收及開高低總量／最佳買賣價的欄位對應。

**驗收：** 與永豐官方客戶端或可信來源交叉核對，記錄至少 20 個事件；價格、最高／最低、總量、最佳買賣價與來源時間符合預期。任何不明欄位不可直接上 UI。

### M2：完整自選與恢復能力

實作訂閱聯集、初始 snapshot、加入／移除的 unsubscribe、斷線重連、群組本機快照切換與 stale 顯示。

**驗收：** 同商品在多群組只訂閱一次；停止／啟動上游模擬後能回復；資料斷流時 UI 在 15 秒內清楚變為 stale。

### M3：跨裝置與部署

設定 Tailscale、LaunchAgent、健康檢查與操作文件；實測 Windows 和 iPhone。

**驗收：** 三裝置開同一群組，對比 `serverVersion` 一致；iPhone 背景 5 分鐘後回前景能自動恢復；Mac 重啟後服務與自選清單正常。

### M4：一週觀察期

交易日運行至少五日，收集錯誤與連線記錄，再決定是否加入告警、更多群組行為或節能策略微調。

**驗收：** 無憑證洩露、無未偵測行情斷線、無持續 CPU 異常；確認各商品在盤中資料符合預期。

## 13. 測試策略

- 單元測試：漲跌計算、空值、時間排序、`Quote` 合併、dirty batch、版本缺口。
- 整合測試：SQLite 交易、REST 操作後訂閱聯集變化、WebSocket snapshot + delta、重連。
- 合約測試：將錄製的合法 Shioaji payload 去識別化後做 fixture，防止 SDK 欄位變更默默破壞顯示。
- E2E：Playwright 在兩個瀏覽器 context 驗證同一群組變更和一秒內同步。
- 人工盤中測試：用官方來源比對至少股票、ETF、TSE、OTC 四種情況，特別檢查無成交時 `Quote` 的最佳買賣價與「最後成交」時間差。
- 壓力測試：以 50、100、200 個模擬商品驗證推播 coalescing；實際可訂閱上限及帳戶權限需以永豐契約為準。

## 14. 操作與故障處理

| 症狀 | 系統行為 | 使用者處置 |
| --- | --- | --- |
| iPhone／Windows 斷線 | 前端退避重連，成功後 bootstrap | 確認 Tailscale 已連線；重新開啟頁面。 |
| Shioaji 中斷 | UI 顯示 stale／重連中，後端重連重訂閱 | 若長時間未恢復，查看健康頁與後端 log。 |
| Mac 重啟 | LaunchAgent 啟動服務，讀 SQLite 重建訂閱 | 確認 Mac 已登入、Tailscale 與服務健康。 |
| 盤後 | UI 顯示 closed 與最後資料時間 | 正常行為，不視為斷線。 |
| API／憑證失效 | health 顯示 upstream error，log 不輸出秘密 | 在 Mac 更新受限設定檔後重啟服務。 |

## 15. 後續才需決定的產品問題

以下不阻礙 MVP 開工，預設可先採最小行為：

1. 初始建立一個名為「我的自選」的群組；群組數量與每組商品上限在實測永豐訂閱限制前不做人為限制。
2. 使用者偏好 iPhone 採「橫向可捲表格」或「兩行商品卡片」；建議先做橫向表格以最大化與桌面版一致性。
3. 是否要納入盤中零股；MVP 預設整股行情，零股需另確認 Shioaji `intraday_odd` 的展示與合併規則。
4. 是否要顯示收盤後資訊；MVP 保留最後行情但清楚標為盤後。
5. Mac mini 是否可在台股交易時段保持登入與避免睡眠；這是即時性的必要營運條件。

## 16. AI agent 執行守則

1. 先完成 M0，沒有 mock 垂直切片、版本化同步與測試，不得直接堆疊完整 UI。
2. 實作 Shioaji 前，先以當前官方 SDK 文件與帳戶權限確認 API 名稱與欄位；不要依本文件中的示意型別猜測。
3. 不得把 API key、secret、憑證、IP、Tailnet 名稱或錄製的原始資料提交版本控制。
4. 將「行情接收」、「狀態合併」、「推播」、「呈現」保持分離；任何一層都不可自行輪詢行情。
5. 每一筆傳給 UI 的行情都必須有來源時間與狀態；資料不完整時顯示 `—`，不可捏造數值。
6. 在 M1 的人工對帳完成前，不應宣稱行情資料已正確，也不應進行任何交易功能開發。
