import asyncio
import json
import logging
import requests
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

logger = logging.getLogger("yahoo_market")

GLOBAL_NAMES = {
    "^DJI": ("道瓊指數", "Dow Jones"),
    "^IXIC": ("那斯達克", "NASDAQ"),
    "^GSPC": ("標普500", "S&P 500"),
    "^SOX": ("費城半導體", "PHLX Semiconductor"),
    "^N225": ("日經225", "Nikkei 225"),
    "^KS11": ("南韓KOSPI", "KOSPI"),
}


def evaluate_market_session(
    symbol: str,
    meta: dict[str, Any] | None = None,
    quote: dict[str, Any] | None = None,
) -> tuple[str, str, str]:
    """依據時區、開盤時間與 Yahoo meta 判定全球指數即時開休市狀態。

    回傳: (market_status, status_label, trading_hours)
    """
    meta = meta or {}
    quote = quote or {}
    now_ts = datetime.now(timezone.utc).timestamp()

    if symbol in ("^DJI", "^IXIC", "^GSPC", "^SOX"):
        try:
            tz = ZoneInfo("America/New_York")
        except Exception:
            tz = timezone.utc
        dt = datetime.now(tz)
        is_dst = dt.tzname() == "EDT"
        tw_hours = "台北 21:30~04:00 (夏令)" if is_dst else "台北 22:30~05:00 (冬令)"
        hours_desc = f"{tw_hours} ｜ 美東 09:30~16:00"

        # 優先讀取 Yahoo currentTradingPeriod 精確判斷（可自動對應休市假期）
        curr = meta.get("currentTradingPeriod", {})
        reg = curr.get("regular", {})
        pre = curr.get("pre", {})
        post = curr.get("post", {})
        if reg.get("start") and reg.get("end") and reg["start"] < reg["end"]:
            if reg["start"] <= now_ts < reg["end"]:
                return "open", "盤中交易", hours_desc
            if pre.get("start") and pre.get("end") and pre["start"] <= now_ts < pre["end"]:
                return "pre", "盤前交易", hours_desc
            if post.get("start") and post.get("end") and post["start"] <= now_ts < post["end"]:
                return "post", "盤後交易", hours_desc

        if dt.weekday() >= 5:
            return "weekend", "週末休市", hours_desc

        mins = dt.hour * 60 + dt.minute
        if 4 * 60 <= mins < 9 * 60 + 30:
            return "pre", "盤前交易", hours_desc
        elif 9 * 60 + 30 <= mins < 16 * 60:
            return "open", "盤中交易", hours_desc
        elif 16 * 60 <= mins < 20 * 60:
            return "post", "盤後交易", hours_desc
        elif mins >= 16 * 60:
            return "closed", "已收盤", hours_desc
        else:
            return "closed", "未開盤", hours_desc

    elif symbol == "^N225":
        try:
            tz = ZoneInfo("Asia/Tokyo")
        except Exception:
            tz = timezone.utc
        dt = datetime.now(tz)
        hours_desc = "台北 08:00~14:30 (10:30~11:30午休) ｜ 東京 09:00~15:30"

        if dt.weekday() >= 5:
            return "weekend", "週末休市", hours_desc

        mins = dt.hour * 60 + dt.minute
        if mins < 9 * 60:
            return "closed", "未開盤", hours_desc
        elif 9 * 60 <= mins < 11 * 60 + 30:
            return "open", "早盤交易", hours_desc
        elif 11 * 60 + 30 <= mins < 12 * 60 + 30:
            return "lunch", "午間休市", hours_desc
        elif 12 * 60 + 30 <= mins < 15 * 60 + 30:
            return "open", "午盤交易", hours_desc
        else:
            return "closed", "已收盤", hours_desc

    elif symbol == "^KS11":
        try:
            tz = ZoneInfo("Asia/Seoul")
        except Exception:
            tz = timezone.utc
        dt = datetime.now(tz)
        hours_desc = "台北 08:00~14:30 (全日無午休) ｜ 首爾 09:00~15:30"

        if dt.weekday() >= 5:
            return "weekend", "週末休市", hours_desc

        mins = dt.hour * 60 + dt.minute
        if mins < 9 * 60:
            return "closed", "未開盤", hours_desc
        elif 9 * 60 <= mins < 15 * 60 + 30:
            return "open", "盤中交易", hours_desc
        else:
            return "closed", "已收盤", hours_desc

    return "closed", "休市中", ""

class YahooMarketService:
    def __init__(self):
        self._running = False
        self._task: asyncio.Task | None = None
        self._last_fetch_ts: float = 0.0
        self._global_indices: dict[str, Any] = {
            "us": [],
            "asia": [],
            "updatedAt": "",
        }

    def fetch_all_indices_sync(self) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
        """向 Yahoo 台灣股市抓取台股（加權、櫃買）與國際股市（美股、亞股日韓）即時行情與分時點位"""
        url = "https://tw.stock.yahoo.com/"
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        }
        try:
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code != 200:
                logger.warning(f"Yahoo market fetch returned HTTP status {resp.status_code}")
                return {}, self._global_indices
            html = resp.text
        except Exception as e:
            logger.warning(f"Yahoo market requests.get failed: {e}")
            return {}, self._global_indices

        pos = html.find("marketIndexBoard")
        if pos == -1:
            logger.warning("marketIndexBoard not found in Yahoo HTML")
            return {}, self._global_indices

        colon_pos = html.find(":", pos)
        brace_pos = html.find("{", colon_pos)
        raw = html[brace_pos:]
        braces = 0
        end_idx = 0
        in_escape = False
        in_str = False
        for i, ch in enumerate(raw):
            if ch == "\\" and not in_escape:
                in_escape = True
                continue
            if ch == '"' and not in_escape:
                in_str = not in_str
            elif not in_str:
                if ch == "{":
                    braces += 1
                elif ch == "}":
                    braces -= 1
                    if braces == 0:
                        end_idx = i + 1
                        break
            in_escape = False

        clean_json = raw[:end_idx].replace('\\"', '"').replace("\\\\", "\\")
        data = json.loads(clean_json)

        # 1. 解析台股 (加權與櫃買)
        tw_data = data.get("tw", {})
        tw_result: dict[str, dict[str, Any]] = {}
        tw_mapping = {"^TWII": "TSE", "^TWOII": "OTC"}

        for sym, key in tw_mapping.items():
            if sym in tw_data:
                idx = tw_data[sym]
                meta = idx.get("meta", {})
                quote = idx.get("quote", {})
                quotes_list = idx.get("indicators", {}).get("quote", [{}])[0]
                closes = quotes_list.get("close", [])
                valid_pts = [
                    round(float(c), 2)
                    for c in closes
                    if c is not None and isinstance(c, (int, float))
                ]

                tw_result[key] = {
                    "code": "IX0001" if key == "TSE" else "IX0043",
                    "name": "加權指數" if key == "TSE" else "櫃買指數",
                    "price": float(quote.get("price") or meta.get("regularMarketPrice") or 0.0),
                    "reference": float(quote.get("previousClose") or meta.get("chartPreviousClose") or 0.0),
                    "open": float(quote.get("openPrice") or 0.0),
                    "high": float(quote.get("dayHighPrice") or 0.0),
                    "low": float(quote.get("dayLowPrice") or 0.0),
                    "change": float(quote.get("change") or 0.0),
                    "changePercent": float(quote.get("changePercent") or 0.0),
                    "turnoverM": quote.get("turnoverM"),
                    "points": valid_pts,
                    "marketStatus": quote.get("marketStatus"),
                }

        # 1.1 解析台指期近一 (WTX& / 台指近（全）)
        try:
            pos_txf = html.find("台指期近一")
            while pos_txf != -1:
                q_pos = html.find("quote", pos_txf)
                if q_pos != -1 and q_pos - pos_txf < 150:
                    brace_pos = html.find("{", q_pos)
                    raw_txf = html[brace_pos:]
                    braces = 0
                    end_idx = 0
                    in_escape = False
                    in_str = False
                    for i, ch in enumerate(raw_txf):
                        if ch == "\\" and not in_escape:
                            in_escape = True
                            continue
                        if ch == '"' and not in_escape:
                            in_str = not in_str
                        elif not in_str:
                            if ch == "{":
                                braces += 1
                            elif ch == "}":
                                braces -= 1
                                if braces == 0:
                                    end_idx = i + 1
                                    break
                        in_escape = False
                    clean_json = raw_txf[:end_idx].replace('\\"', '"').replace("\\\\", "\\")
                    q_data = json.loads(clean_json)

                    def get_num(field: str) -> float:
                        v = q_data.get(field)
                        if isinstance(v, dict):
                            raw_val = v.get("raw")
                            return float(raw_val) if raw_val is not None else 0.0
                        if isinstance(v, (int, float)):
                            return float(v)
                        if isinstance(v, str):
                            try:
                                return float(v.replace(",", ""))
                            except Exception:
                                return 0.0
                        return 0.0

                    vol_raw = q_data.get("volume")
                    try:
                        vol = int(str(vol_raw).replace(",", ""))
                    except Exception:
                        vol = 0

                    price = get_num("price")
                    if price > 0:
                        tw_result["TXF"] = {
                            "code": "WTX&",
                            "name": "台指近（全）",
                            "price": price,
                            "reference": get_num("previousClose"),
                            "open": get_num("openPrice"),
                            "high": get_num("dayHighPrice"),
                            "low": get_num("dayLowPrice"),
                            "change": get_num("change"),
                            "changePercent": get_num("changePercent"),
                            "volume": vol,
                            "volumeText": f"{vol:,} 口",
                            "points": [],
                            "marketStatus": q_data.get("marketStatus"),
                        }
                    break
                pos_txf = html.find("台指期近一", pos_txf + 1)
        except Exception as e:
            logger.warning(f"Error parsing TXF from Yahoo HTML: {e}")

        # 2. 解析美股 (道瓊、那斯達克、標普500、費半)
        us_data = data.get("us", {})
        us_list: list[dict[str, Any]] = []
        for sym in ["^DJI", "^IXIC", "^GSPC", "^SOX"]:
            if sym in us_data:
                idx = us_data[sym]
                meta = idx.get("meta", {})
                quote = idx.get("quote", {})
                quotes_list = idx.get("indicators", {}).get("quote", [{}])[0]
                closes = quotes_list.get("close", [])
                valid_pts = [
                    round(float(c), 2)
                    for c in closes
                    if c is not None and isinstance(c, (int, float))
                ]
                zh_name, en_name = GLOBAL_NAMES.get(sym, (meta.get("name") or sym, sym))
                m_status, m_label, m_hours = evaluate_market_session(sym, meta, quote)
                us_list.append({
                    "symbol": sym,
                    "name": zh_name,
                    "englishName": en_name,
                    "price": float(quote.get("price") or meta.get("regularMarketPrice") or 0.0),
                    "reference": float(quote.get("previousClose") or meta.get("chartPreviousClose") or 0.0),
                    "open": float(quote.get("openPrice") or 0.0),
                    "high": float(quote.get("dayHighPrice") or 0.0),
                    "low": float(quote.get("dayLowPrice") or 0.0),
                    "change": float(quote.get("change") or 0.0),
                    "changePercent": float(quote.get("changePercent") or 0.0),
                    "points": valid_pts,
                    "marketStatus": m_status,
                    "statusLabel": m_label,
                    "tradingHours": m_hours,
                })

        # 3. 解析亞股（日經225、南韓KOSPI）
        asia_data = data.get("asia", {})
        asia_list: list[dict[str, Any]] = []
        for sym in ["^N225", "^KS11"]:
            if sym in asia_data:
                idx = asia_data[sym]
                meta = idx.get("meta", {})
                quote = idx.get("quote", {})
                quotes_list = idx.get("indicators", {}).get("quote", [{}])[0]
                closes = quotes_list.get("close", [])
                valid_pts = [
                    round(float(c), 2)
                    for c in closes
                    if c is not None and isinstance(c, (int, float))
                ]
                zh_name, en_name = GLOBAL_NAMES.get(sym, (meta.get("name") or sym, sym))
                m_status, m_label, m_hours = evaluate_market_session(sym, meta, quote)
                asia_list.append({
                    "symbol": sym,
                    "name": zh_name,
                    "englishName": en_name,
                    "price": float(quote.get("price") or meta.get("regularMarketPrice") or 0.0),
                    "reference": float(quote.get("previousClose") or meta.get("chartPreviousClose") or 0.0),
                    "open": float(quote.get("openPrice") or 0.0),
                    "high": float(quote.get("dayHighPrice") or 0.0),
                    "low": float(quote.get("dayLowPrice") or 0.0),
                    "change": float(quote.get("change") or 0.0),
                    "changePercent": float(quote.get("changePercent") or 0.0),
                    "points": valid_pts,
                    "marketStatus": m_status,
                    "statusLabel": m_label,
                    "tradingHours": m_hours,
                })

        now_iso_str = datetime.now(timezone.utc).isoformat()
        us_open = any(item.get("marketStatus") == "open" for item in us_list)
        us_pre = any(item.get("marketStatus") == "pre" for item in us_list)
        us_post = any(item.get("marketStatus") == "post" for item in us_list)
        us_weekend = all(item.get("marketStatus") == "weekend" for item in us_list) if us_list else False
        us_summary_label = (
            "盤中交易" if us_open else (
                "盤前交易" if us_pre else (
                    "盤後交易" if us_post else (
                        "週末休市" if us_weekend else "已收盤"
                    )
                )
            )
        )

        asia_open = any(item.get("marketStatus") == "open" for item in asia_list)
        asia_lunch = any(item.get("marketStatus") == "lunch" for item in asia_list)
        asia_weekend = all(item.get("marketStatus") == "weekend" for item in asia_list) if asia_list else False
        asia_summary_label = (
            "日韓盤中" if all(item.get("marketStatus") == "open" for item in asia_list) else (
                "盤中交易" if asia_open else (
                    "午間休市" if asia_lunch else (
                        "週末休市" if asia_weekend else "已收盤"
                    )
                )
            )
        )

        global_result = {
            "tw": tw_result,
            "us": us_list,
            "asia": asia_list,
            "updatedAt": now_iso_str,
            "marketSummary": {
                "us": {
                    "isOpen": us_open,
                    "status": "open" if us_open else ("pre" if us_pre else ("post" if us_post else ("weekend" if us_weekend else "closed"))),
                    "label": us_summary_label,
                    "hours": "台北 21:30~04:00 (夏令) / 22:30~05:00 (冬令)",
                },
                "asia": {
                    "isOpen": asia_open,
                    "status": "open" if asia_open else ("lunch" if asia_lunch else ("weekend" if asia_weekend else "closed")),
                    "label": asia_summary_label,
                    "hours": "日股 08:00~14:30 (10:30~11:30午休) ｜ 韓股 08:00~14:30",
                },
            },
        }

        return tw_result, global_result

    def get_global_indices(self) -> dict[str, Any]:
        """取得快取的國際指數（包含台股三大指數、美股四大指數、亞股日韓）"""
        res = dict(self._global_indices)
        from backend.app.services.shioaji_adapter import shioaji_adapter
        # 優先合併 Shioaji 即時的台股三大指數，若無則保留 Yahoo 抓取之 tw
        shioaji_tw = {k: v for k, v in shioaji_adapter.market_indices.items() if v.get("price") and v["price"] > 0}
        res["tw"] = shioaji_tw or res.get("tw") or {}
        return res

    async def fetch_all_indices_async(self) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, self.fetch_all_indices_sync)
        except Exception as e:
            logger.warning(f"Failed to fetch Yahoo market indices: {e}")
            return {}, self._global_indices

    async def update_indices_once(self) -> bool:
        """抓取並更新至 shioaji_adapter.market_indices 與 self._global_indices"""
        from backend.app.services.shioaji_adapter import shioaji_adapter

        tw_data, global_data = await self.fetch_all_indices_async()
        if global_data.get("us") or global_data.get("asia"):
            if tw_data:
                global_data["tw"] = tw_data
            self._global_indices = global_data

        if not tw_data:
            return False

        updated = False
        for key in ["TSE", "OTC", "TXF"]:
            if key in tw_data and key in shioaji_adapter.market_indices:
                info = tw_data[key]
                target = shioaji_adapter.market_indices[key]
                if "marketStatus" in info:
                    target["marketStatus"] = info["marketStatus"]

                if key == "TXF":
                    target["price"] = info["price"]
                    target["change"] = info["change"]
                    target["changePercent"] = info["changePercent"]
                    if info.get("reference"):
                        target["reference"] = info["reference"]
                    if info.get("open"):
                        target["open"] = info["open"]
                    if info.get("high"):
                        target["high"] = info["high"]
                    if info.get("low"):
                        target["low"] = info["low"]
                    if info.get("volumeText"):
                        target["volumeText"] = info["volumeText"]
                    if info.get("volume"):
                        target["volumeAmount"] = info["volume"]

                    pts = target.setdefault("points", [])
                    if not pts:
                        o = target.get("open") or target["price"]
                        h = target.get("high") or target["price"]
                        l = target.get("low") or target["price"]
                        p = target["price"]
                        if p >= o:
                            seed = [o, (o + l) / 2, l, (l + h) / 2, h, (h + p) / 2, p]
                        else:
                            seed = [o, (o + h) / 2, h, (h + l) / 2, l, (l + p) / 2, p]
                        target["points"] = [round(x, 2) for x in seed if x > 0]
                    elif pts[-1] != target["price"]:
                        pts.append(round(target["price"], 2))
                        if len(pts) > 500:
                            target["points"] = pts[-500:]
                    updated = True
                else:
                    if info.get("points"):
                        target["points"] = info["points"]
                        updated = True

                    if not target.get("price") or target["price"] == 0.0:
                        target["price"] = info["price"]
                        target["change"] = info["change"]
                        target["changePercent"] = info["changePercent"]
                        if info.get("reference"):
                            target["reference"] = info["reference"]
                        if info.get("open"):
                            target["open"] = info["open"]
                        if info.get("high"):
                            target["high"] = info["high"]
                        if info.get("low"):
                            target["low"] = info["low"]
                        updated = True

                    if not target.get("volumeText") and info.get("turnoverM"):
                        try:
                            amt_raw = float(info["turnoverM"]) * 100_000_000
                            target["volumeText"] = f"{round(float(info['turnoverM']) / 100.0, 2):,.2f} 億"
                            target["volumeAmount"] = amt_raw
                            updated = True
                        except Exception:
                            pass

        if updated:
            shioaji_adapter.indices_dirty = True
        return updated

    async def start(self):
        if self._running:
            return
        self._running = True
        try:
            await self.update_indices_once()
            logger.info("Initial Yahoo market & global indices loaded.")
        except Exception as e:
            logger.warning(f"Error loading initial Yahoo indices: {e}")

        self._task = asyncio.create_task(self._loop())

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self):
        """定期背景同步當日走勢折線圖點位 (交易時段每 30 秒，週末或離峰空檔每 2 分鐘)"""
        logger.info("YahooMarketService background loop started.")
        while self._running:
            try:
                # 判斷是否處於交易時段 (台股現貨 08:30~13:45 或 夜盤期貨/歐美股市 15:00~翌日 05:00)
                from datetime import timedelta
                now_tw = datetime.now(timezone(timedelta(hours=8)))
                weekday = now_tw.weekday()
                hm = now_tw.hour * 60 + now_tw.minute
                # 週六 05:00 後至週一 08:30 前完全休市
                is_weekend = (weekday == 5 and hm >= 5 * 60) or (weekday == 6) or (weekday == 0 and hm < 8 * 60 + 30)
                # 平日換盤空檔 (05:00~08:30, 13:45~14:50)
                is_break = (5 * 60 <= hm < 8 * 60 + 30) or (13 * 60 + 45 <= hm < 14 * 60 + 50)
                interval = 120.0 if (is_weekend or is_break) else 30.0

                await asyncio.sleep(interval)
                await self.update_indices_once()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in YahooMarketService loop: {e}")
                await asyncio.sleep(30.0)

yahoo_market_service = YahooMarketService()
