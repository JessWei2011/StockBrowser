import glob
import os
import re
from datetime import datetime, date
from typing import Optional
from bs4 import BeautifulSoup
from pydantic import BaseModel
import logging

logger = logging.getLogger(__name__)

# StockCenter 根目錄與檔案夾路徑
STOCK_CENTER_DIR = "/Users/jess/Desktop/Python/StockCenter"
STOCK_CENTER_REPORTS_DIR = os.path.join(STOCK_CENTER_DIR, "reports")
STOCK_CENTER_STATE_FILE = os.path.join(STOCK_CENTER_DIR, "reports_state.json")

def is_etf_or_bond(code: str) -> bool:
    """判定是否為 ETF 或債券標的（以 00 開頭）"""
    return code.startswith("00")

def revive_if_tombstone(code: str):
    """若個股在 StockCenter 狀態檔中被標記為刪除墓碑 (deletedAt)，將其設為 None 以允許重新生成"""
    if not os.path.exists(STOCK_CENTER_STATE_FILE):
        return
    try:
        import json
        with open(STOCK_CENTER_STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        stocks = data.get("stocks", {})
        if code in stocks and stocks[code].get("deletedAt") is not None:
            logger.info(f"Reviving tombstone stock {code} in {STOCK_CENTER_STATE_FILE}")
            stocks[code]["deletedAt"] = None
            now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%fZ")
            stocks[code]["updatedAt"] = now_iso
            with open(STOCK_CENTER_STATE_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.error(f"Failed to revive tombstone stock {code}: {e}")

def generate_stock_report_via_stockcenter(code: str) -> bool:
    """連動 StockCenter 執行 stock_report_generator.py 生成新個股 HTML 報告並持久化存檔"""
    if not os.path.isdir(STOCK_CENTER_DIR):
        logger.error(f"StockCenter directory not found: {STOCK_CENTER_DIR}")
        return False

    revive_if_tombstone(code)

    logger.info(f"Triggering StockCenter to generate report for {code}...")
    try:
        import subprocess, sys
        res = subprocess.run(
            [sys.executable, "stock_report_generator.py", code],
            cwd=STOCK_CENTER_DIR,
            capture_output=True,
            text=True,
            timeout=120
        )
        if res.returncode == 0:
            logger.info(f"StockCenter successfully generated and saved report for {code}!")
            return True
        else:
            logger.error(f"StockCenter generator returned error ({res.returncode}): {res.stderr or res.stdout}")
            return False
    except subprocess.TimeoutExpired:
        logger.error(f"StockCenter generator timed out for {code}")
        return False
    except Exception as e:
        logger.error(f"Exception while generating report for {code}: {e}")
        return False

class KlineBar(BaseModel):
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float
    ma5: Optional[float] = None
    ma10: Optional[float] = None
    ma20: Optional[float] = None
    ma60: Optional[float] = None
    boll_up: Optional[float] = None
    boll_mid: Optional[float] = None
    boll_down: Optional[float] = None
    rsi: Optional[float] = None
    macd_hist: Optional[float] = None
    k: Optional[float] = None
    d: Optional[float] = None

class InstitutionalFlowItem(BaseModel):
    date: str
    foreign: int
    trust: int
    dealer: int
    total: int

class MarginFlowItem(BaseModel):
    date: str
    margin_balance: int
    margin_change: int
    short_balance: int
    short_change: int

class HolderFlowItem(BaseModel):
    date: str
    over400_pct: float
    over600_pct: float
    over800_pct: float
    over1000_pct: float
    retail_pct: float
    total_holders: int

class StockAnalysisChartData(BaseModel):
    code: str
    name: str
    title: str
    lastUpdate: str
    kline: list[KlineBar]
    institutional: list[InstitutionalFlowItem]
    margin: list[MarginFlowItem]
    holders: list[HolderFlowItem]
    isAppendedToday: bool = False

def find_stock_report_path(code: str) -> Optional[str]:
    """於 StockCenter/reports 中依據代碼搜尋對應的 HTML 報告"""
    if not os.path.isdir(STOCK_CENTER_REPORTS_DIR):
        return None
    matches = glob.glob(os.path.join(STOCK_CENTER_REPORTS_DIR, "**", f"{code}_*.html"), recursive=True)
    if matches:
        return matches[0]
    return None

def parse_stock_report(code: str, live_quote: Optional[dict] = None) -> Optional[StockAnalysisChartData]:
    """解析 StockCenter 既有的 HTML 分析報告，若無則連動 StockCenter 現場生成並持久化存檔"""
    if is_etf_or_bond(code):
        logger.info(f"Stock {code} is ETF or Bond, skipping chart report.")
        return None

    filepath = find_stock_report_path(code)
    if not filepath or not os.path.exists(filepath):
        logger.info(f"Report for stock {code} not found in {STOCK_CENTER_REPORTS_DIR}. Triggering on-demand generation via StockCenter...")
        success = generate_stock_report_via_stockcenter(code)
        if success:
            filepath = find_stock_report_path(code)

    if not filepath or not os.path.exists(filepath):
        logger.warning(f"Report for stock {code} could not be found or generated in {STOCK_CENTER_REPORTS_DIR}")
        return None

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            html = f.read()
    except Exception as e:
        logger.error(f"Failed to read report {filepath}: {e}")
        return None

    soup = BeautifulSoup(html, "html.parser")

    # 1. 解析標題 (如 "3231 緯創 台股分析")
    h1 = soup.find("h1")
    title_text = h1.get_text(strip=True) if h1 else f"{code} 技術分析"
    m_name = re.search(r"\d+\s+([^\s]+)", title_text)
    stock_name = m_name.group(1) if m_name else code

    sub = soup.find("div", class_="sub")
    last_update = sub.get_text(strip=True).replace("產生時間：", "") if sub else ""

    tables = soup.find_all("table")

    # 2. 解析近 180 日 K 線
    kline_bars: list[KlineBar] = []
    for t in tables:
        headers = [th.get_text(strip=True) for th in t.find_all("th")]
        if "MA5" in headers and ("BOLL上" in headers or "收" in headers):
            rows = t.find_all("tr")[1:]
            for r in rows:
                cols = [td.get_text(strip=True) for td in r.find_all("td")]
                if len(cols) >= 6:
                    vol_str = cols[5].replace("張", "").replace(",", "")
                    try:
                        vol = float(vol_str)
                    except ValueError:
                        vol = 0.0

                    def safe_float(val: str) -> Optional[float]:
                        if not val or val == "-":
                            return None
                        try:
                            return float(val.replace(",", ""))
                        except ValueError:
                            return None

                    kline_bars.append(KlineBar(
                        date=cols[0],
                        open=float(cols[1]),
                        high=float(cols[2]),
                        low=float(cols[3]),
                        close=float(cols[4]),
                        volume=vol,
                        ma5=safe_float(cols[6]) if len(cols) > 6 else None,
                        rsi=safe_float(cols[7]) if len(cols) > 7 else None,
                        macd_hist=safe_float(cols[8]) if len(cols) > 8 else None,
                        k=safe_float(cols[9]) if len(cols) > 9 else None,
                        d=safe_float(cols[10]) if len(cols) > 10 else None,
                        boll_up=safe_float(cols[11]) if len(cols) > 11 else None,
                        boll_mid=safe_float(cols[12]) if len(cols) > 12 else None,
                        boll_down=safe_float(cols[13]) if len(cols) > 13 else None,
                    ))
            break

    # 計算補充均線 MA10, MA20, MA60 (若未在表內)
    close_prices = [b.close for b in kline_bars]
    for idx, b in enumerate(kline_bars):
        if idx >= 9:
            b.ma10 = round(sum(close_prices[idx-9:idx+1]) / 10, 2)
        if idx >= 19:
            b.ma20 = round(sum(close_prices[idx-19:idx+1]) / 20, 2)
        if idx >= 59:
            b.ma60 = round(sum(close_prices[idx-59:idx+1]) / 60, 2)

    # 3. 解析三大法人 (近 20 日)
    institutional_data: list[InstitutionalFlowItem] = []
    for t in tables:
        headers = [th.get_text(strip=True) for th in t.find_all("th")]
        if "外資" in headers and "投信" in headers and "自營" in headers:
            rows = t.find_all("tr")[1:]
            for r in rows:
                cols = [td.get_text(strip=True) for td in r.find_all("td")]
                if len(cols) >= 5 and "累計" not in cols[0]:
                    try:
                        institutional_data.append(InstitutionalFlowItem(
                            date=cols[0],
                            foreign=int(cols[1].replace("+", "").replace(",", "")),
                            trust=int(cols[2].replace("+", "").replace(",", "")),
                            dealer=int(cols[3].replace("+", "").replace(",", "")),
                            total=int(cols[4].replace("+", "").replace(",", ""))
                        ))
                    except Exception:
                        pass
            break

    # 4. 解析融資融券 (近 20 日)
    margin_data: list[MarginFlowItem] = []
    for t in tables:
        headers = [th.get_text(strip=True) for th in t.find_all("th")]
        if "融資餘額" in headers and "融券餘額" in headers:
            rows = t.find_all("tr")[1:]
            for r in rows:
                cols = [td.get_text(strip=True) for td in r.find_all("td")]
                if len(cols) >= 5 and re.match(r"^\d{4}-\d{2}-\d{2}$", cols[0]):
                    try:
                        margin_data.append(MarginFlowItem(
                            date=cols[0],
                            margin_balance=int(cols[1].replace(",", "")),
                            margin_change=int(cols[2].replace("+", "").replace(",", "")),
                            short_balance=int(cols[3].replace(",", "")),
                            short_change=int(cols[4].replace("+", "").replace(",", ""))
                        ))
                    except Exception:
                        pass
            break

    # 5. 解析大戶持股比例 (集保近 8 週)
    holders_data: list[HolderFlowItem] = []
    for t in tables:
        headers = [th.get_text(strip=True) for th in t.find_all("th")]
        if "400張以上" in headers and "1000張以上" in headers:
            rows = t.find_all("tr")[1:]
            for r in rows:
                cols = [td.get_text(strip=True) for td in r.find_all("td")]
                if len(cols) >= 6 and re.match(r"^\d{4}-\d{2}-\d{2}$", cols[0]):
                    try:
                        holders_data.append(HolderFlowItem(
                            date=cols[0],
                            over400_pct=float(cols[1].replace("%", "")),
                            over600_pct=float(cols[2].replace("%", "")),
                            over800_pct=float(cols[3].replace("%", "")),
                            over1000_pct=float(cols[4].replace("%", "")),
                            retail_pct=float(cols[5].replace("%", "")),
                            total_holders=int(cols[6].replace(",", "")) if len(cols) > 6 else 0
                        ))
                    except Exception:
                        pass
            # 排序讓日期由舊到新 (左舊右新)
            holders_data.sort(key=lambda x: x.date)
            break

    # 6. 即時動態拼接：如果有提供今日即時報價，且最後一根不是今天，動態追加最後一根即時 K 棒
    is_appended = False
    if live_quote and kline_bars:
        last_date_str = kline_bars[-1].date
        today_date = date.today()
        today_label = today_date.strftime("%m/%d")

        # 只要歷史最新一筆不是今天，且今日報價有有效開盤價與成交價
        cur_open = live_quote.get("open") or live_quote.get("last")
        cur_close = live_quote.get("last")
        cur_high = live_quote.get("high") or cur_close
        cur_low = live_quote.get("low") or cur_close
        cur_vol = float(live_quote.get("totalVolume") or 0)

        if cur_open and cur_close and cur_open > 0 and cur_close > 0:
            if last_date_str != today_label:
                # 動態估算今日 MA5 / MA10 / MA20
                all_closes = [b.close for b in kline_bars] + [cur_close]
                new_ma5 = round(sum(all_closes[-5:]) / 5, 2) if len(all_closes) >= 5 else None
                new_ma10 = round(sum(all_closes[-10:]) / 10, 2) if len(all_closes) >= 10 else None
                new_ma20 = round(sum(all_closes[-20:]) / 20, 2) if len(all_closes) >= 20 else None
                new_ma60 = round(sum(all_closes[-60:]) / 60, 2) if len(all_closes) >= 60 else None

                # 動態布林估算 (基於20日均線與標準差)
                boll_u, boll_m, boll_d = None, None, None
                if len(all_closes) >= 20:
                    sub_c = all_closes[-20:]
                    avg = sum(sub_c) / 20
                    var = sum((x - avg) ** 2 for x in sub_c) / 20
                    std = var ** 0.5
                    boll_m = round(avg, 2)
                    boll_u = round(avg + 2 * std, 2)
                    boll_d = round(avg - 2 * std, 2)

                today_bar = KlineBar(
                    date=today_label,
                    open=cur_open,
                    high=cur_high,
                    low=cur_low,
                    close=cur_close,
                    volume=cur_vol,
                    ma5=new_ma5,
                    ma10=new_ma10,
                    ma20=new_ma20,
                    ma60=new_ma60,
                    boll_up=boll_u,
                    boll_mid=boll_m,
                    boll_down=boll_d,
                )
                kline_bars.append(today_bar)
                is_appended = True
            else:
                # 若最後一筆正是今天，更新其最新最高、最低、收盤與成交量
                last_bar = kline_bars[-1]
                last_bar.high = max(last_bar.high, cur_high)
                last_bar.low = min(last_bar.low, cur_low)
                last_bar.close = cur_close
                last_bar.volume = cur_vol
                is_appended = True

    return StockAnalysisChartData(
        code=code,
        name=stock_name,
        title=title_text,
        lastUpdate=last_update,
        kline=kline_bars,
        institutional=institutional_data,
        margin=margin_data,
        holders=holders_data,
        isAppendedToday=is_appended,
    )

_ma_cache: dict[str, dict] = {}

def get_stock_ma_summary(code: str) -> Optional[dict]:
    """獲取個股 MA5, MA10, MA20 與近 19 日收盤價快取，供即時均線指標比對"""
    if is_etf_or_bond(code):
        return None
    if code in _ma_cache:
        return _ma_cache[code]

    chart_data = parse_stock_report(code)
    if not chart_data or not chart_data.kline:
        return None

    bars = chart_data.kline
    last_bar = bars[-1]
    recent_closes = [b.close for b in bars[-19:]]

    summary = {
        "code": code,
        "name": chart_data.name,
        "ma5": last_bar.ma5,
        "ma10": last_bar.ma10,
        "ma20": last_bar.ma20,
        "lastClose": last_bar.close,
        "recentCloses": recent_closes,
    }
    _ma_cache[code] = summary
    return summary

def get_multiple_stocks_ma_summary(codes: list[str]) -> dict[str, dict]:
    """批次獲取多檔股票 MA 指標"""
    res = {}
    for c in codes:
        if is_etf_or_bond(c):
            continue
        try:
            s = get_stock_ma_summary(c)
            if s:
                res[c] = s
        except Exception as e:
            logger.warning(f"Failed to get MA summary for {c}: {e}")
    return res

