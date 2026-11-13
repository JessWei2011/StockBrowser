import json
import logging
import os
import time
import urllib.request
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from backend.app.services.stock_chart_service import KlineBar, MarginFlowItem

logger = logging.getLogger(__name__)

DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "data"))
CACHE_FILE = os.path.join(DATA_DIR, "margin_quotas_cache.json")
STOCK_CENTER_DIR = "/Users/jess/Desktop/Python/StockCenter"

# 記憶體內快取
_quotas_cache: Optional[dict[str, dict]] = None
_quotas_cache_time: float = 0.0


def fetch_twse_margin_quotas() -> dict[str, dict]:
    """從證交所抓取全部上市股票融資限額、今日融資餘額與使用率"""
    quotas = {}
    try:
        url = "https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&selectType=ALL"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        tables = data.get("tables", [])
        if len(tables) > 1:
            for r in tables[1].get("data", []):
                code = str(r[0]).strip()
                try:
                    lim = int(r[7].replace(",", ""))
                    mb = int(r[6].replace(",", ""))
                    rate = round((mb / lim * 100), 2) if lim > 0 else 0.0
                    quotas[code] = {"limit": lim, "mb": mb, "rate": rate, "market": "TWSE"}
                except Exception:
                    continue
    except Exception as e:
        logger.warning(f"Failed to fetch TWSE margin quotas: {e}")
    return quotas


def fetch_otc_margin_quotas() -> dict[str, dict]:
    """從櫃買中心抓取全部上櫃股票融資限額、今日融資餘額與官方使用率"""
    quotas = {}
    try:
        url = "https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&s=0,asc"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        tables = data.get("tables", [])
        if tables:
            for r in tables[0].get("data", []):
                code = str(r[0]).strip()
                try:
                    lim = int(r[9].replace(",", ""))
                    mb = int(r[6].replace(",", ""))
                    rate = float(r[8].replace(",", ""))
                    quotas[code] = {"limit": lim, "mb": mb, "rate": rate, "market": "TPEx"}
                except Exception:
                    continue
    except Exception as e:
        logger.warning(f"Failed to fetch TPEx margin quotas: {e}")
    return quotas


def get_margin_quotas() -> dict[str, dict]:
    """取得上市+上櫃全部個股融資限額對照表（含磁碟快取，有效期 6 小時）"""
    global _quotas_cache, _quotas_cache_time
    now = time.time()

    # 1. 記憶體快取 (6小時內有效)
    if _quotas_cache and (now - _quotas_cache_time < 21600):
        return _quotas_cache

    # 2. 磁碟快取
    if os.path.exists(CACHE_FILE):
        try:
            mtime = os.path.getmtime(CACHE_FILE)
            if now - mtime < 21600:
                with open(CACHE_FILE, "r", encoding="utf-8") as f:
                    _quotas_cache = json.load(f)
                    _quotas_cache_time = mtime
                    return _quotas_cache
        except Exception as e:
            logger.warning(f"Failed to load margin quotas cache from {CACHE_FILE}: {e}")

    # 3. 現場向官方抓取
    twse_q = fetch_twse_margin_quotas()
    otc_q = fetch_otc_margin_quotas()
    merged = {**twse_q, **otc_q}

    if merged:
        _quotas_cache = merged
        _quotas_cache_time = now
        try:
            os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(merged, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"Failed to write margin quotas cache to {CACHE_FILE}: {e}")
        return merged

    # 若抓取失敗且磁碟檔案存在（即使過期），作為降級備用
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                _quotas_cache = json.load(f)
                return _quotas_cache
        except Exception:
            pass

    return {}


def enrich_margin_data(
    code: str,
    is_otc: bool,
    kline_bars: list,
    margin_items: list,
) -> None:
    """
    為 MarginFlowItem 列表填充融資使用率與融資維持率：
    1. 融資使用率 = (融資餘額 / 融資限額) * 100%
    2. 融資維持率 = (收盤價 / (融資成本 * 融資成數)) * 100%
       融資成數：上市 0.6，上櫃 0.5
    """
    if not margin_items:
        return

    # 1. 取得融資限額
    quotas = get_margin_quotas()
    quota_info = quotas.get(code)
    limit = quota_info.get("limit") if quota_info else None

    # 2. 建立 K 線收盤價速查表
    price_map: dict[str, float] = {}
    for k in kline_bars:
        price_map[k.date] = k.close
        if "/" in k.date:
            parts = k.date.split("/")
            if len(parts) == 2:
                m_str, d_str = parts
                # 兼容 2026-MM-DD
                price_map[f"2026-{m_str.zfill(2)}-{d_str.zfill(2)}"] = k.close

    # 3. 建立融資歷史增減與餘額序列（優先讀取 StockCenter/cache/{code}.json 獲取長達 60~90 天更精確的成本基期）
    mg_history: list[tuple[str, int, int]] = []
    cache_path = os.path.join(STOCK_CENTER_DIR, "cache", f"{code}.json")
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                c_data = json.load(f)
                mg_dict = c_data.get("margin", {})
                for dt in sorted(mg_dict.keys()):
                    mg_history.append((dt, mg_dict[dt]["mb"], mg_dict[dt]["md"]))
        except Exception:
            pass

    # 若無長天期快取，則直接以 margin_items（由舊至新）計算
    if not mg_history:
        for m in reversed(margin_items):
            mg_history.append((m.date, m.margin_balance, m.margin_change))

    # 4. 模擬移動平均融資成本 (Moving Average Margin Cost)
    cost: Optional[float] = None
    cost_map: dict[str, float] = {}
    maint_map: dict[str, float] = {}
    margin_ratio = 0.5 if is_otc else 0.6

    for dt, mb, md in mg_history:
        close = price_map.get(dt) or price_map.get(dt[5:].replace("-", "/"))
        if not close:
            continue
        if cost is None:
            cost = close
        else:
            if md > 0 and mb > 0:
                cost = ((mb - md) * cost + md * close) / mb
            elif mb <= 0:
                cost = close
        cost_map[dt] = round(cost, 2)
        if cost > 0:
            maint_val = round((close / (cost * margin_ratio)) * 100, 2)
            maint_map[dt] = maint_val

    # 5. 回填至各 MarginFlowItem
    for item in margin_items:
        # 限額與使用率
        if limit and limit > 0:
            item.margin_limit = limit
            item.margin_utilization = round((item.margin_balance / limit) * 100, 2)

        # 維持率與融資成本
        c_val = cost_map.get(item.date)
        m_val = maint_map.get(item.date)

        # 若當天找不到，嘗試以 MM/DD 比對
        if m_val is None:
            short_key = item.date[5:].replace("-", "/")
            c_val = cost_map.get(short_key) or c_val
            m_val = maint_map.get(short_key) or m_val

        item.margin_cost = c_val
        item.margin_maintenance = m_val
