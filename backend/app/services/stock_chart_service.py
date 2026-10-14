import glob
import logging
import os
import re
import time
from datetime import datetime, date, timedelta
from typing import Optional
from bs4 import BeautifulSoup
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# StockCenter 根目錄與檔案夾路徑
STOCK_CENTER_DIR = "/Users/jess/Desktop/Python/StockCenter"
STOCK_CENTER_REPORTS_DIR = os.path.join(STOCK_CENTER_DIR, "reports")
STOCK_CENTER_STATE_FILE = os.path.join(STOCK_CENTER_DIR, "reports_state.json")

_last_generation_attempt: dict[str, float] = {}

def get_latest_market_cutoff() -> datetime:
    """
    計算市場最新已結算交易日的盤後時間點（基準點定為該日 15:00）。
    - 平日（週一至週五）15:30 之後：當日已收盤，基準點為今天 15:00。
    - 平日 15:30 之前：尚未產生當日完整盤後，基準點為前一交易日 15:00（若今天是週一則為上週五 15:00）。
    - 週末（週六、週日）：基準點為週五 15:00。
    """
    now = datetime.now()
    weekday = now.weekday()  # 0: Mon, ..., 4: Fri, 5: Sat, 6: Sun

    if weekday in (5, 6):  # 週六或週日
        days_back = 1 if weekday == 5 else 2
        ref_date = (now - timedelta(days=days_back)).date()
    elif weekday == 0:  # 週一
        if now.hour > 15 or (now.hour == 15 and now.minute >= 30):
            ref_date = now.date()
        else:
            ref_date = (now - timedelta(days=3)).date()
    else:  # 週二至週五
        if now.hour > 15 or (now.hour == 15 and now.minute >= 30):
            ref_date = now.date()
        else:
            ref_date = (now - timedelta(days=1)).date()

    return datetime(ref_date.year, ref_date.month, ref_date.day, 15, 0, 0)

def is_report_stale(filepath: str) -> bool:
    """判斷報告檔案是否早於最近應結算的交易日基準點"""
    if not os.path.exists(filepath):
        return True
    try:
        mtime = datetime.fromtimestamp(os.path.getmtime(filepath))
        cutoff = get_latest_market_cutoff()
        return mtime < cutoff
    except Exception as e:
        logger.warning(f"Error checking report mtime for {filepath}: {e}")
        return False

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

def recalculate_indicators(kline_bars: list[KlineBar]):
    """重新計算所有 K 棒的 MA5, MA10, MA20, MA60 及布林通道指標"""
    closes = [b.close for b in kline_bars]
    for idx, b in enumerate(kline_bars):
        if idx >= 4:
            b.ma5 = round(sum(closes[idx-4:idx+1]) / 5, 2)
        if idx >= 9:
            b.ma10 = round(sum(closes[idx-9:idx+1]) / 10, 2)
        if idx >= 19:
            sub = closes[idx-19:idx+1]
            avg = sum(sub) / 20.0
            b.ma20 = round(avg, 2)
            var = sum((x - avg) ** 2 for x in sub) / 20.0
            std = var ** 0.5
            b.boll_mid = round(avg, 2)
            b.boll_up = round(avg + 2 * std, 2)
            b.boll_down = round(avg - 2 * std, 2)
        if idx >= 59:
            b.ma60 = round(sum(closes[idx-59:idx+1]) / 60, 2)

def backfill_missing_kline_bars(code: str, kline_bars: list[KlineBar]) -> list[KlineBar]:
    """
    若 HTML 報告歷史 K 線與今天之間存在缺漏交易日（例如 StockCenter 暫停或未及時爬取），
    利用 yfinance 快速回補缺漏的真實交易日 K 線，確保日期序列完整連續不跳天。
    """
    if not kline_bars:
        return kline_bars

    existing_dates = {b.date for b in kline_bars}
    today_date = date.today()
    today_label = today_date.strftime("%m/%d")
    last_date_str = kline_bars[-1].date

    try:
        import yfinance as yf
        hist = None
        for suffix in [".TW", ".TWO"]:
            try:
                hist = yf.Ticker(f"{code}{suffix}").history(period="10d")
                if hist is not None and not hist.empty:
                    break
            except Exception:
                continue

        if hist is not None and not hist.empty:
            # 找出 hist 中對應 last_date_str 的位置，只回補該日期之後且在今日之前的交易日
            matching_indices = [i for i, ts in enumerate(hist.index) if ts.strftime("%m/%d") == last_date_str]
            start_pos = (matching_indices[-1] + 1) if matching_indices else 0
            sub_hist = hist.iloc[start_pos:]

            added_any = False
            for ts, row in sub_hist.iterrows():
                bar_date = ts.strftime("%m/%d")
                # 不回補今天（今天由即時報價處理）且尚未存在於歷史清單中
                if bar_date not in existing_dates and bar_date != today_label:
                    close_p = float(row["Close"])
                    if close_p > 0:
                        vol = round(float(row["Volume"]) / 1000.0, 1)
                        new_bar = KlineBar(
                            date=bar_date,
                            open=float(row["Open"]),
                            high=float(row["High"]),
                            low=float(row["Low"]),
                            close=close_p,
                            volume=vol,
                        )
                        kline_bars.append(new_bar)
                        existing_dates.add(bar_date)
                        added_any = True

            if added_any:
                recalculate_indicators(kline_bars)
    except Exception as e:
        logger.warning(f"Failed to backfill missing bars via yfinance for {code}: {e}")

    return kline_bars

def parse_stock_report(
    code: str,
    live_quote: Optional[dict] = None,
    auto_generate: bool = True,
    backfill: bool = True
) -> Optional[StockAnalysisChartData]:
    """解析 StockCenter 既有的 HTML 分析報告，若過期或無報告則連動 StockCenter 現場生成並持久化存檔"""
    if is_etf_or_bond(code):
        logger.info(f"Stock {code} is ETF or Bond, skipping chart report.")
        return None

    filepath = find_stock_report_path(code)
    is_stale = is_report_stale(filepath) if (filepath and os.path.exists(filepath)) else True

    if auto_generate and (not filepath or not os.path.exists(filepath) or is_stale):
        now_ts = time.time()
        last_attempt = _last_generation_attempt.get(code, 0)
        # 5 分鐘冷卻防連環重複呼叫
        if now_ts - last_attempt > 300:
            _last_generation_attempt[code] = now_ts
            reason = "not found" if not filepath else "stale"
            logger.info(f"Report for stock {code} is {reason}. Triggering on-demand generation via StockCenter...")
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

    # 執行缺日補齊與均線/布林指標全面計算
    if backfill:
        backfill_missing_kline_bars(code, kline_bars)
    recalculate_indicators(kline_bars)

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

    # 6. 即時動態拼接與更新：交易時段有即時行情時，動態更新或追加今日即時 K 棒
    is_appended = False
    today_date = date.today()
    is_weekday = today_date.weekday() < 5
    now_hour = datetime.now().hour

    if live_quote and kline_bars and is_weekday and now_hour >= 9:
        today_label = today_date.strftime("%m/%d")
        last_date_str = kline_bars[-1].date

        cur_open = live_quote.get("open") or live_quote.get("last")
        cur_close = live_quote.get("last")
        cur_high = live_quote.get("high") or cur_close
        cur_low = live_quote.get("low") or cur_close
        cur_vol = float(live_quote.get("totalVolume") or 0)

        if cur_open and cur_close and cur_open > 0 and cur_close > 0:
            if last_date_str == today_label:
                # 今日 K 棒已存在（例如 StockCenter 今日已產生過或 yfinance 已有），更新其現價與極值
                last_bar = kline_bars[-1]
                if not last_bar.open or last_bar.open <= 0:
                    last_bar.open = cur_open
                last_bar.high = max(last_bar.high, cur_high)
                last_bar.low = min(last_bar.low, cur_low)
                last_bar.close = cur_close
                if cur_vol > 0:
                    last_bar.volume = cur_vol
                recalculate_indicators(kline_bars)
                is_appended = True
            else:
                # 今日尚未在 K 線中，追加今日即時 K 棒
                today_bar = KlineBar(
                    date=today_label,
                    open=cur_open,
                    high=cur_high,
                    low=cur_low,
                    close=cur_close,
                    volume=cur_vol,
                )
                kline_bars.append(today_bar)
                recalculate_indicators(kline_bars)
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

_ma_cache: dict[str, tuple[float, dict]] = {}

def get_stock_ma_summary(code: str) -> Optional[dict]:
    """獲取個股 MA5, MA10, MA20 與近 19 日收盤價快取，供即時均線指標比對 (快取 60 秒)"""
    if is_etf_or_bond(code):
        return None
    now_ts = time.time()
    if code in _ma_cache:
        cached_ts, cached_val = _ma_cache[code]
        if now_ts - cached_ts < 60:
            return cached_val

    chart_data = parse_stock_report(code, auto_generate=False, backfill=False)
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
    _ma_cache[code] = (now_ts, summary)
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

