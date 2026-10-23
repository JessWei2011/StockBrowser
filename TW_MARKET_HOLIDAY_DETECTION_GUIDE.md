# 台股開休市與天然災害（颱風假）即時判定指南

> **給 AI Agent 的實作手冊**：本指南說明如何在任何金融或股票專案中，正確判定台股現貨（加權/櫃買）與台指期貨（TXF）的開休市狀態。嚴禁僅以「本機時鐘 09:00~13:30」做單一判定，避免因颱風假、國定假日或臨時封關造成嚴重的狀態誤判。

---

## 1. 核心盲點與多重防護原則 (Defense-in-Depth)

### 常見錯誤
- ❌ 僅判斷 `09:00 <= 當前台北時間 <= 13:30` 且 `週一至週五` 即認為「開盤中」。
- 盲點：遇上台北市政府宣布停止上班（如颱風假）、證交所臨時休市公告、國定連假、除夕春節封關時，畫面仍會錯誤顯示「開盤中」。

### 權威判定架構（4 道防護層）
1. **第一層（重大天然災害/緊急休市）**：即時查詢臺灣證券交易所（TWSE）官方最新新聞公告 API，檢測是否有「集中交易市場休市一天」或「颱風假」公告。
2. **第二層（年度國定假日行事曆）**：快取臺灣證券交易所年度休市行事曆（端午、中秋、國慶、春節封關等）。
3. **第三層（週末與交易時鐘時段）**：週六、週日判定為週末休市；交易日 09:00 前為「未開盤」、13:30 後為「已收盤」。
4. **第四層（官方行情狀態備援）**：讀取 Yahoo Finance 或證交所 MIS 最新成交日標籤；若盤中時間官方回傳 `marketStatus: "close"` 或交易日未推進至當日，權威強制標記休市。

---

## 2. API 資料來源規格

### A. 臺灣證券交易所官方即時新聞（天然災害/颱風假權威來源）
- **URL**: `https://www.twse.com.tw/rwd/zh/news/newsList?response=json`
- **Method**: `GET`
- **Headers**: 需帶一般瀏覽器 `User-Agent`
- **解析重點**:
  - 資料列格式：`[流水號, 標題, 發布日期, ...]`
  - 當台北市宣布放颱風假時，證交所固定發布標準標題：
    `臺灣證券交易所集中交易市場115年10月23日休市一天`（年份為民國年）
  - 比對關鍵字：當日民國日期（如 `115年10月23日`）+ 含有 `休市` 或 `暫停交易`。

### B. 臺灣證券交易所年度休市日表
- **URL**: `https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json`
- **Method**: `GET`
- **解析重點**:
  - 回傳年度所有非開盤交易之國定假日與說明（可快取 24 小時）。

### C. Yahoo 台灣首頁即時市場狀態（備援信號）
- **URL**: `https://tw.stock.yahoo.com/`
- **解析重點**:
  - 解析 HTML 內的 `marketIndexBoard` JSON 區塊。
  - `tw["^TWII"]["quote"]["marketStatus"]`：若值為 `"close"`，代表證交所未開市或已收市。

---

## 3. Python 完整實作範例

以下代碼包含快取、例外容錯與完整狀態判定，可直接封裝為服務或模組：

```python
import datetime
import threading
import time
import requests
from typing import Dict, Tuple, Any

# 快取容器
_TWSE_CLOSURE_CACHE = {"timestamp": 0, "closed": False, "reason": "", "type": ""}
_TWSE_CLOSURE_LOCK = threading.Lock()

_TW_HOLIDAYS_CACHE = {"year": None, "holidays": {}, "timestamp": 0}
_TW_HOLIDAYS_LOCK = threading.Lock()


def check_twse_emergency_closure() -> Tuple[bool, str, str]:
    """檢查證交所最新新聞公告，判定今日是否有天然災害或重大臨時休市（如颱風假）。

    回傳: (is_closed, closed_reason, closed_type)
    """
    now = time.time()
    with _TWSE_CLOSURE_LOCK:
        if now - _TWSE_CLOSURE_CACHE["timestamp"] < 300 and _TWSE_CLOSURE_CACHE["timestamp"] > 0:
            return _TWSE_CLOSURE_CACHE["closed"], _TWSE_CLOSURE_CACHE["reason"], _TWSE_CLOSURE_CACHE["type"]

    today_taipei = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    roc_year = today_taipei.year - 1911
    month = today_taipei.month
    day = today_taipei.day
    date_patterns = [
        f"{roc_year}年{month}月{day}日",
        f"{roc_year}年{month:02d}月{day:02d}日",
        f"{roc_year}/{month}/{day}",
        f"{roc_year}/{month:02d}/{day:02d}",
    ]

    is_closed = False
    reason = ""
    closure_type = ""

    try:
        r = requests.get(
            "https://www.twse.com.tw/rwd/zh/news/newsList?response=json",
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"},
            timeout=5,
        )
        if r.status_code == 200:
            data = r.json().get("data", [])
            for row in data:
                if len(row) >= 2:
                    title = str(row[1])
                    for pat in date_patterns:
                        if pat in title and ("休市" in title or "暫停交易" in title):
                            is_closed = True
                            if "颱風" in title or "風災" in title or "天然災害" in title or "休市一天" in title:
                                reason = "颱風假休市"
                                closure_type = "typhoon"
                            else:
                                reason = "休市中"
                                closure_type = "holiday"
                            break
                    if is_closed:
                        break
    except Exception:
        pass

    with _TWSE_CLOSURE_LOCK:
        _TWSE_CLOSURE_CACHE["timestamp"] = now
        _TWSE_CLOSURE_CACHE["closed"] = is_closed
        _TWSE_CLOSURE_CACHE["reason"] = reason
        _TWSE_CLOSURE_CACHE["type"] = closure_type
    return is_closed, reason, closure_type


def get_tw_annual_holidays() -> Dict[str, str]:
    """取得證交所公告之年度國定假日表（格式 YYYY-MM-DD -> 節日名稱）。"""
    now = time.time()
    current_year = datetime.date.today().year
    with _TW_HOLIDAYS_LOCK:
        if _TW_HOLIDAYS_CACHE["year"] == current_year and now - _TW_HOLIDAYS_CACHE["timestamp"] < 86400:
            return _TW_HOLIDAYS_CACHE["holidays"]

    try:
        r = requests.get(
            "https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json",
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
            timeout=5,
        )
        if r.status_code == 200:
            data = r.json()
            holidays = {}
            for row in data.get("data", []):
                if len(row) >= 2:
                    holidays[str(row[0]).strip()] = str(row[1]).strip()
            with _TW_HOLIDAYS_LOCK:
                _TW_HOLIDAYS_CACHE["year"] = current_year
                _TW_HOLIDAYS_CACHE["holidays"] = holidays
                _TW_HOLIDAYS_CACHE["timestamp"] = now
            return holidays
    except Exception:
        pass

    with _TW_HOLIDAYS_LOCK:
        return _TW_HOLIDAYS_CACHE["holidays"]


def evaluate_tw_market_status(yahoo_market_status: str = None) -> Dict[str, Any]:
    """計算台股現貨當前權威開休市狀態。"""
    today_taipei = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    today_str = today_taipei.strftime("%Y-%m-%d")
    taipei_minutes = today_taipei.hour * 60 + today_taipei.minute
    taipei_weekday = today_taipei.isoweekday()
    is_weekend = taipei_weekday >= 6

    # 1. 第一層：天然災害/颱風假/緊急公告
    is_twse_closed, closure_reason, closure_type = check_twse_emergency_closure()
    if is_twse_closed:
        return {
            "isOpen": False,
            "badgeLabel": closure_reason or "颱風假休市",
            "badgeType": closure_type or "typhoon",
            "reason": "證交所公告天然災害/緊急休市",
        }

    # 2. 第二層：年度國定假日
    holidays = get_tw_annual_holidays()
    if today_str in holidays:
        h_name = holidays.get(today_str, "國定假日")
        return {
            "isOpen": False,
            "badgeLabel": f"{h_name}休市",
            "badgeType": "holiday",
            "reason": f"國定假日休市 ({h_name})",
        }

    # 3. 第三層：週末休市
    if is_weekend:
        return {
            "isOpen": False,
            "badgeLabel": "週末休市",
            "badgeType": "weekend",
            "reason": "週末非交易日",
        }

    # 4. 第四層：盤中時間但行情源標記已關閉 (如臨時停市)
    if yahoo_market_status == "close" and (540 <= taipei_minutes < 810):
        return {
            "isOpen": False,
            "badgeLabel": "休市中",
            "badgeType": "closed",
            "reason": "官方交易所狀態為關閉",
        }

    # 5. 第五層：交易日時段
    if taipei_minutes < 540:
        return {
            "isOpen": False,
            "badgeLabel": "未開盤",
            "badgeType": "closed",
            "reason": "開盤前時段",
        }
    elif taipei_minutes >= 810:
        return {
            "isOpen": False,
            "badgeLabel": "已收盤",
            "badgeType": "closed",
            "reason": "今日盤後收盤",
        }

    # 正常開盤中
    return {
        "isOpen": True,
        "badgeLabel": "開盤中",
        "badgeType": "open",
        "reason": "台股正常盤中交易時段",
    }
```

---

## 4. 前端膠囊標記規範 (UI / CSS)

### 狀態膠囊類型與語義顏色
| `badgeType` | 顯示文字範例 | 視覺語義 | 暗黑模式配色建議 | 淺色模式配色建議 |
|:---|:---|:---|:---|:---|
| `typhoon` | `颱風假休市` | 紅粉高對比警戒 | 背景 `rgba(239,68,68,0.22)`, 文字 `#fda4af`, 邊框 `#f43f5e` | 背景 `#ffe4e6`, 文字 `#e11d48`, 邊框 `#fda4af` |
| `holiday` | `端午節休市` / `國定假日休市` | 節慶暗紅膠囊 | 背景 `rgba(239,68,68,0.16)`, 文字 `#fca5a5`, 邊框 `rgba(239,68,68,0.45)` | 背景 `#fee2e2`, 文字 `#b91c1c`, 邊框 `#fca5a5` |
| `weekend` | `週末休市` | 琥珀黃膠囊 | 背景 `rgba(245,158,11,0.16)`, 文字 `#fcd34d`, 邊框 `rgba(245,158,11,0.45)` | 背景 `#fef3c7`, 文字 `#b45309`, 邊框 `#fcd34d` |
| `closed` | `未開盤` / `已收盤` / `休市中` | 靜態灰藍膠囊 | 背景 `rgba(148,163,184,0.14)`, 文字 `#cbd5e1`, 邊框 `rgba(148,163,184,0.32)` | 背景 `#f1f5f9`, 文字 `#475569`, 邊框 `#cbd5e1` |
| `open` | `開盤中` | 呼吸動效綠色膠囊 | 背景 `rgba(34,197,94,0.16)`, 文字 `#86efac`, 圓點附帶綠光閃爍呼吸動畫 | 背景 `#dcfce7`, 文字 `#15803d`, 邊框 `#86efac` |

### CSS 樣式代碼

```css
.market-pulse-pill-badge {
  display: inline-flex;
  align-items: center;
  gap: 3.5px;
  font-size: 9.5px;
  font-weight: 750;
  line-height: 1;
  padding: 2px 7px;
  border-radius: 999px;
  white-space: nowrap;
  user-select: none;
}

.market-pulse-pill-badge .badge-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

/* 颱風假／重大天然災害休市 */
.market-pulse-pill-badge.typhoon {
  background: rgba(239, 68, 68, 0.22);
  color: #fda4af;
  border: 1px solid rgba(244, 63, 94, 0.6);
}

/* 國定假日休市 */
.market-pulse-pill-badge.holiday {
  background: rgba(239, 68, 68, 0.16);
  color: #fca5a5;
  border: 1px solid rgba(239, 68, 68, 0.45);
}

/* 週末休市 */
.market-pulse-pill-badge.weekend {
  background: rgba(245, 158, 11, 0.16);
  color: #fcd34d;
  border: 1px solid rgba(245, 158, 11, 0.45);
}

/* 常態非盤中時段（未開盤/已收盤） */
.market-pulse-pill-badge.closed {
  background: rgba(148, 163, 184, 0.14);
  color: #cbd5e1;
  border: 1px solid rgba(148, 163, 184, 0.32);
}

/* 開盤中（含小圓點呼吸動畫） */
.market-pulse-pill-badge.open {
  background: rgba(34, 197, 94, 0.16);
  color: #86efac;
  border: 1px solid rgba(34, 197, 94, 0.45);
}

.market-pulse-pill-badge.open .badge-dot {
  animation: market-pulse-breathe 1.2s ease-in-out infinite alternate;
}

@keyframes market-pulse-breathe {
  from { opacity: 0.4; transform: scale(0.85); }
  to { opacity: 1; transform: scale(1.15); }
}
```

---

## 5. 常駐背景服務（Daemon / Launchd / Docker）注意事項

若專案透過 `launchd`（macOS plist）、`systemd`（Linux）或常駐行程（如 `uvicorn` / `python` 背景執行）運行：
1. **快取過期機制**：證交所天然災害新聞快取 TTL 建議設定為 **5 分鐘（300 秒）**，避免當晚宣布停班停課後無法於隔日開盤前即時更新。
2. **重載與重啟**：更動開休市判斷邏輯後，必須重啟常駐行程（如 `kill <pid>` 或 `launchctl kickstart`），避免行程持續載入舊有 Python Bytecode。
3. **客戶端覆寫防範**：前端在與伺服器 API 通訊前，切勿單方面以瀏覽器本機時間將狀態強制改寫為「開盤中」；必須永遠以伺服器回傳之 `isOpen` 與 `badgeLabel` 為最高判定權威。
