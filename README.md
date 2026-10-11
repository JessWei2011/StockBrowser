# StockBrowser (台股即時跨裝置看盤系統)

專為 Mac mini M4 本地部署設計之私有、高效、即時台股／ETF 行情監控系統，支援 Tailscale 內網多裝置跨端連線（電腦端完整表格與手機端扁平化兩行卡片）。

---

## 🌟 核心特點

1. **雙模態自適應佈局**：
   * **電腦端**：完整滑動表格（含固定商品名稱代號欄位、HTML5 拖曳自選排序、上移/下移控制項）。
   * **手機端**：瑞士風格扁平化兩行卡片（Flat Design），標籤水平齊平，數字高低波浪錯位，杜絕破萬股價文字重疊。
2. **標準台股色彩規範**：
   * 紅漲、綠跌、平盤灰；漲跌停支援高對比徽章。
   * 成交價、漲跌額幅、最高與最低（錨定昨收）嚴格遵循台股慣例；開盤與昨收維持中性參考色，總量採用高辨識度青藍色。
3. **即時行情與合約管理**：
   * 整合永豐金證券 Shioaji API，自動快取 TSE / OTC 逾 2,700 檔合約。
   * 動態聯集計算（總訂閱量 $\le 200$ 檔），零重複訂閱。
   * AUTO 智慧模式：台股盤中（09:00~13:30）全真實即時回呼；非盤中時段自動啟動微幅模擬跳動供功能驗證。
4. **低延遲 1Hz 批次廣播**：
   * FastAPI + WebSocket 批次聚合推播（Coalescing Batch Publisher）。
   * 前端增量補丁（Delta Merge）與變更微黃閃爍提示。
5. **連線狀態呼吸燈**：
   * 頂部與底部狀態指示燈升級為平滑翡翠綠 CSS 呼吸燈動態，即時反應用戶端與券商連線心跳。
6. **日間／夜間模式**：
   * 內建高對比深色夜間模式，設定狀態自動儲存於瀏覽器 LocalStorage。

---

## 🏗️ 系統架構

```
StockBrowser/
├── backend/                  # FastAPI 後端
│   ├── app/
│   │   ├── api/              # REST API 與 WebSocket 路由
│   │   ├── domain/           # Pydantic 資料模型
│   │   ├── repositories/     # SQLite WAL 模式自選持久化
│   │   ├── services/         # Shioaji 適配器、QuoteStore、Publisher
│   │   └── main.py           # 服務入口與 SPA 靜態託管
│   └── tests/                # Pytest 單元與整合測試
├── frontend/                 # React 19 + TypeScript + Vite 前端
│   └── src/
│       ├── components/       # QuoteTable, CompactCardList, Header, GroupTabs
│       ├── services/         # REST API 與 WebSocket 客戶端
│       └── App.tsx / App.css # 核心元件與扁平化樣式
├── deploy/                   # 部署配置範本
├── start.sh                  # 一鍵啟動腳本
└── .env                      # 憑證與環境變數 (需自行配置)
```

---

## 🚀 快速啟動

### 1. 配置環境變數
在專案根目錄建立 `.env` 檔案（可參考 `deploy/stock-browser.env.example`）：
```env
SJ_API_KEY=your_shioaji_api_key
SJ_SECRET_KEY=your_shioaji_secret_key
SJ_SIMULATION=false
HOST=0.0.0.0
PORT=8000
DB_PATH=data/stock_browser.db
ENABLE_OFFHOURS_MOCK_TICKS=true
```

### 2. 安裝依賴
```bash
# 後端 Python 依賴
pip install -r <(echo "shioaji fastapi uvicorn websockets aiosqlite pydantic python-dotenv pytest pytest-asyncio")

# 前端 Node 依賴
cd frontend && npm install && cd ..
```

### 3. 一鍵啟動
```bash
./start.sh
```
啟動後即可透過瀏覽器連線：
* 本機訪問：`http://localhost:8000`
* 區域網路 / Tailscale 訪問：`http://<Your-IP>:8000`
