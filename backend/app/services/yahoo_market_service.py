import asyncio
import json
import logging
import urllib.request
from typing import Any

logger = logging.getLogger("yahoo_market")

class YahooMarketService:
    def __init__(self):
        self._running = False
        self._task: asyncio.Task | None = None
        self._last_fetch_ts: float = 0.0

    def fetch_tw_indices_sync(self) -> dict[str, dict[str, Any]]:
        """向 Yahoo 台灣股市抓取大盤加權與櫃買指數即時行情與當日分時走勢點位"""
        url = "https://tw.stock.yahoo.com/"
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            html = resp.read().decode("utf-8")

        pos = html.find("marketIndexBoard")
        if pos == -1:
            logger.warning("marketIndexBoard not found in Yahoo HTML")
            return {}

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
        tw_data = data.get("tw", {})

        result: dict[str, dict[str, Any]] = {}
        mapping = {
            "^TWII": "TSE",
            "^TWOII": "OTC",
        }

        for sym, key in mapping.items():
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

                price_val = float(quote.get("price") or meta.get("regularMarketPrice") or 0.0)
                ref_val = float(quote.get("previousClose") or meta.get("chartPreviousClose") or 0.0)
                open_val = float(quote.get("openPrice") or 0.0)
                high_val = float(quote.get("dayHighPrice") or 0.0)
                low_val = float(quote.get("dayLowPrice") or 0.0)
                chg_val = float(quote.get("change") or 0.0)
                pct_val = float(quote.get("changePercent") or 0.0)
                turnover_m = quote.get("turnoverM")

                result[key] = {
                    "code": "IX0001" if key == "TSE" else "IX0043",
                    "name": "加權指數" if key == "TSE" else "櫃買指數",
                    "price": price_val,
                    "reference": ref_val,
                    "open": open_val,
                    "high": high_val,
                    "low": low_val,
                    "change": chg_val,
                    "changePercent": pct_val,
                    "turnoverM": turnover_m,
                    "points": valid_pts,
                }

        return result

    async def fetch_tw_indices_async(self) -> dict[str, dict[str, Any]]:
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, self.fetch_tw_indices_sync)
        except Exception as e:
            logger.warning(f"Failed to fetch Yahoo market indices: {e}")
            return {}

    async def update_indices_once(self) -> bool:
        """抓取並更新至 shioaji_adapter.market_indices"""
        from backend.app.services.shioaji_adapter import shioaji_adapter

        data = await self.fetch_tw_indices_async()
        if not data:
            return False

        updated = False
        for key in ["TSE", "OTC"]:
            if key in data and key in shioaji_adapter.market_indices:
                info = data[key]
                target = shioaji_adapter.market_indices[key]

                # 更新走勢點位陣列
                if info.get("points"):
                    target["points"] = info["points"]
                    updated = True

                # 若永豐尚未取得數值，先以 Yahoo 補底
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

                # 若無成交量字串，且 Yahoo 有 turnoverM，則補上格式化成交量
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
        # 啟動時先立即抓取一次初始點位
        try:
            await self.update_indices_once()
            logger.info("Initial Yahoo market indices points loaded.")
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
        """定期背景同步當日走勢折線圖點位 (開盤時段每 30 秒，非開盤時段每 2 分鐘)"""
        logger.info("YahooMarketService background loop started.")
        while self._running:
            try:
                from backend.app.services.shioaji_adapter import is_taiwan_market_open
                interval = 30.0 if is_taiwan_market_open() else 120.0
                await asyncio.sleep(interval)
                await self.update_indices_once()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in YahooMarketService loop: {e}")
                await asyncio.sleep(30.0)

yahoo_market_service = YahooMarketService()
