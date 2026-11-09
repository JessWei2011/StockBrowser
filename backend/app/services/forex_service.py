import asyncio
import logging
import time
from typing import Any
import requests

logger = logging.getLogger("forex_service")


class ForexService:
    def __init__(self):
        self._cached_data: dict[str, Any] | None = None
        self._last_update_ts: float = 0.0
        self._cache_ttl_seconds: float = 15.0  # 15秒快取，避免過度呼叫
        self._lock = asyncio.Lock()

    def _fetch_from_cnyes(self) -> dict[str, Any] | None:
        """從鉅亨網 API 獲取 USD/TWD 即時報價與當日分時走勢"""
        url = "https://ws.api.cnyes.com/ws/api/v1/charting/history?symbol=FX:USDTWD:FOREX&resolution=1&quote=1"
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Origin": "https://invest.cnyes.com",
            "Referer": "https://invest.cnyes.com/forex/detail/USDTWD/overview",
        }
        try:
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code != 200:
                logger.warning(f"[Forex] cnyes responded with status {resp.status_code}")
                return None

            res_json = resp.json()
            data = res_json.get("data")
            if not data or not isinstance(data, dict):
                return None

            quote = data.get("quote", {})
            price = quote.get("6")
            if price is None:
                return None

            price = round(float(price), 4)
            change = float(quote.get("11", 0.0) or 0.0)
            change_pct = float(quote.get("56", 0.0) or 0.0)
            high = float(quote.get("12", price) or price)
            low = float(quote.get("13", price) or price)
            prev_close = float(quote.get("21", price) or price)
            open_price = float(quote.get("19", prev_close) or prev_close)

            # cnyes 回傳時間為倒序 (新 -> 舊)，需反轉為時間正序 (舊 -> 新)
            raw_t = data.get("t", [])
            raw_c = data.get("c", [])
            points = []
            for t, c in zip(reversed(raw_t), reversed(raw_c)):
                if c is not None:
                    points.append({"time": int(t), "price": round(float(c), 4)})

            return {
                "symbol": "USD/TWD",
                "name": "美元/台幣",
                "price": price,
                "change": round(change, 4),
                "changePercent": round(change_pct, 2),
                "high": round(high, 4),
                "low": round(low, 4),
                "open": round(open_price, 4),
                "prevClose": round(prev_close, 4),
                "points": points,
                "source": "cnyes",
                "updateTime": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
        except Exception as e:
            logger.warning(f"[Forex] Error fetching from cnyes: {e}")
            return None

    def _fetch_from_yahoo(self) -> dict[str, Any] | None:
        """備援來源：從 Yahoo Finance 獲取 TWD=X 走勢"""
        url = "https://query1.finance.yahoo.com/v8/finance/chart/TWD=X?interval=5m&range=1d"
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }
        try:
            resp = requests.get(url, headers=headers, timeout=5)
            if resp.status_code != 200:
                return None

            res_json = resp.json()
            result = res_json.get("chart", {}).get("result", [])
            if not result:
                return None

            meta = result[0].get("meta", {})
            indicators = result[0].get("indicators", {}).get("quote", [{}])[0]
            timestamps = result[0].get("timestamp", [])
            closes = indicators.get("close", [])

            price = round(float(meta.get("regularMarketPrice", 0.0)), 4)
            prev_close = round(float(meta.get("previousClose", price)), 4)
            change = round(price - prev_close, 4)
            change_pct = round((change / prev_close) * 100, 2) if prev_close else 0.0

            points = []
            for t, c in zip(timestamps, closes):
                if c is not None:
                    points.append({"time": int(t), "price": round(float(c), 4)})

            high = round(float(meta.get("regularMarketDayHigh", price)), 4)
            low = round(float(meta.get("regularMarketDayLow", price)), 4)
            open_price = round(float(meta.get("regularMarketOpen", price)), 4)

            return {
                "symbol": "USD/TWD",
                "name": "美元/台幣",
                "price": price,
                "change": change,
                "changePercent": change_pct,
                "high": high,
                "low": low,
                "open": open_price,
                "prevClose": prev_close,
                "points": points,
                "source": "yahoo",
                "updateTime": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
        except Exception as e:
            logger.warning(f"[Forex] Error fetching from Yahoo: {e}")
            return None

    async def get_usd_twd(self, force_refresh: bool = False) -> dict[str, Any]:
        """非同步取得 USD/TWD 匯率與分時走勢（帶快取防抖）"""
        now = time.time()
        if (
            not force_refresh
            and self._cached_data
            and (now - self._last_update_ts < self._cache_ttl_seconds)
        ):
            return self._cached_data

        async with self._lock:
            # 雙重檢查鎖
            if (
                not force_refresh
                and self._cached_data
                and (time.time() - self._last_update_ts < self._cache_ttl_seconds)
            ):
                return self._cached_data

            loop = asyncio.get_event_loop()
            # 優先呼叫 cnyes
            data = await loop.run_in_executor(None, self._fetch_from_cnyes)
            if not data:
                # 失敗時降級呼叫 Yahoo
                logger.info("[Forex] Falling back to Yahoo Finance for TWD=X")
                data = await loop.run_in_executor(None, self._fetch_from_yahoo)

            if data:
                self._cached_data = data
                self._last_update_ts = time.time()
                return data

            # 若兩者皆失敗且已有快取，回傳舊快取
            if self._cached_data:
                return self._cached_data

            # 萬一連舊快取都沒有，回傳預設結構
            return {
                "symbol": "USD/TWD",
                "name": "美元/台幣",
                "price": 32.85,
                "change": 0.0,
                "changePercent": 0.0,
                "high": 32.85,
                "low": 32.85,
                "open": 32.85,
                "prevClose": 32.85,
                "points": [],
                "source": "empty",
                "updateTime": time.strftime("%Y-%m-%d %H:%M:%S"),
            }


forex_service = ForexService()
