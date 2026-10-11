import asyncio
import logging
import random
from datetime import datetime, timezone, timedelta
from typing import Optional
import shioaji as sj
from backend.app.settings import settings
from backend.app.services.quote_store import quote_store
from backend.app.domain.models import InstrumentSearchResult

logger = logging.getLogger("shioaji_adapter")

def is_taiwan_market_open() -> bool:
    """判斷台股現貨盤中交易時段 (週一至週五 09:00 ~ 13:30)"""
    tz_tw = timezone(timedelta(hours=8))
    now_tw = datetime.now(tz_tw)
    if now_tw.weekday() >= 5:
        return False
    current_minutes = now_tw.hour * 60 + now_tw.minute
    return (9 * 60) <= current_minutes <= (13 * 60 + 30)

def safe_float(val) -> Optional[float]:
    if val is None or val == "" or val == "-":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None

def safe_int(val) -> Optional[int]:
    if val is None or val == "" or val == "-":
        return None
    try:
        return int(val)
    except (ValueError, TypeError):
        return None

class ShioajiAdapter:
    def __init__(self):
        self.api: Optional[sj.Shioaji] = None
        self.is_connected = False
        self.is_logged_in = False
        self.last_quote_time: Optional[str] = None
        self.subscribed_codes: set[str] = set()
        self.contracts_cache: dict[str, dict] = {}
        self._mock_task: Optional[asyncio.Task] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def start(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop
        try:
            logger.info("Initializing Shioaji API client...")
            self.api = sj.Shioaji(simulation=settings.SJ_SIMULATION)
            
            # 登入
            if settings.SJ_API_KEY and settings.SJ_SECRET_KEY:
                accounts = self.api.login(
                    api_key=settings.SJ_API_KEY,
                    secret_key=settings.SJ_SECRET_KEY,
                    subscribe_trade=False
                )
                self.is_logged_in = True
                self.is_connected = True
                logger.info(f"Shioaji login succeeded. Accounts: {len(accounts)}")
                
                # 建立合約快取以供搜尋
                self._build_contracts_cache()
                
                # 設定 Quote callback
                self.api.set_on_quote_stk_v1_callback(self._on_quote_callback)
            else:
                logger.warning("SJ_API_KEY / SJ_SECRET_KEY not set. Running in offline/mock mode.")
        except Exception as e:
            logger.error(f"Failed to connect to Shioaji: {e}", exc_info=True)
            self.is_connected = False
            self.is_logged_in = False

        # 如果開啟非盤中模擬跳動或處於測試模式，啟動輔助跳動背景任務
        if settings.ENABLE_OFFHOURS_MOCK_TICKS:
            self._mock_task = asyncio.create_task(self._mock_ticks_loop())

    def stop(self):
        if self._mock_task:
            self._mock_task.cancel()
        if self.api and self.is_logged_in:
            try:
                self.api.logout()
            except Exception as e:
                logger.warning(f"Error during Shioaji logout: {e}")
        self.is_connected = False
        self.is_logged_in = False

    def _build_contracts_cache(self):
        """讀取 TSE 與 OTC 合約並快取"""
        if not self.api:
            return
        count = 0
        try:
            for exchange_key, view in [("TSE", self.api.Contracts.Stocks.TSE), ("OTC", self.api.Contracts.Stocks.OTC)]:
                for contract in view:
                    sec_type = "ETF" if (contract.category == "00" or contract.code.startswith("00")) else "STOCK"
                    self.contracts_cache[contract.code] = {
                        "code": contract.code,
                        "name": contract.name,
                        "exchange": contract.exchange,
                        "securityType": sec_type,
                        "reference": float(contract.reference) if contract.reference else None,
                        "contract": contract
                    }
                    count += 1
            logger.info(f"Contracts cache built with {count} symbols.")
        except Exception as e:
            logger.error(f"Failed to build contracts cache: {e}", exc_info=True)

    def search_contracts(self, query: str, limit: int = 20) -> list[InstrumentSearchResult]:
        q = query.strip().upper()
        if not q:
            return []
        
        matches = []
        for code, info in self.contracts_cache.items():
            if q == code or q in code or q in info["name"].upper():
                matches.append(
                    InstrumentSearchResult(
                        code=info["code"],
                        name=info["name"],
                        exchange=info["exchange"],
                        securityType=info["securityType"],
                        reference=info["reference"]
                    )
                )
                if len(matches) >= limit:
                    break
        return matches

    def _on_quote_callback(self, quote):
        """由 Solace 執行緒回呼，需輕量無鎖快速合併"""
        try:
            code = getattr(quote, "code", None)
            if not code:
                return

            last_price = safe_float(getattr(quote, "close", None))
            open_price = safe_float(getattr(quote, "open", None))
            high_price = safe_float(getattr(quote, "high", None))
            low_price = safe_float(getattr(quote, "low", None))
            tot_vol = safe_int(getattr(quote, "total_volume", None))
            
            bids = getattr(quote, "bid_price", [])
            asks = getattr(quote, "ask_price", [])
            bid = safe_float(bids[0]) if bids and len(bids) > 0 else None
            ask = safe_float(asks[0]) if asks and len(asks) > 0 else None

            dt = getattr(quote, "datetime", None)
            source_ts = dt.isoformat() if isinstance(dt, datetime) else None
            self.last_quote_time = source_ts or datetime.now(timezone.utc).isoformat()

            quote_store.update_quote(
                code=code,
                last=last_price,
                bid=bid,
                ask=ask,
                open_price=open_price,
                high=high_price,
                low=low_price,
                total_volume=tot_vol,
                source_ts=source_ts,
                data_status="live"
            )
        except Exception as e:
            logger.debug(f"Error parsing quote callback: {e}")

    def subscribe_codes(self, codes: set[str]):
        """增量訂閱新加入的股票"""
        to_add = codes - self.subscribed_codes
        if not to_add:
            return

        if len(self.subscribed_codes) + len(to_add) > 200:
            raise ValueError(f"Exceeds maximum 200 subscriptions (current: {len(self.subscribed_codes)}, requested: +{len(to_add)})")

        for code in to_add:
            info = self.contracts_cache.get(code)
            name = info["name"] if info else ""
            exchange = info["exchange"] if info else "TSE"
            sec_type = info["securityType"] if info else "STOCK"
            ref = info["reference"] if info else None
            
            # 初始化 quote store 記錄
            quote_store.init_or_get_quote(code, name=name, exchange=exchange, security_type=sec_type)
            if ref is not None:
                quote_store.update_quote(code=code, previous_close=ref)

        # 批次取得快照
        self._fetch_snapshots(list(to_add))

        # 呼叫 Shioaji API 訂閱即時行情
        if self.api and self.is_logged_in:
            for code in to_add:
                info = self.contracts_cache.get(code)
                if info and "contract" in info:
                    try:
                        self.api.subscribe(
                            info["contract"],
                            quote_type=sj.QuoteType.Quote,
                            version=sj.QuoteVersion.v1
                        )
                        self.subscribed_codes.add(code)
                        logger.info(f"Subscribed Quote for {code}")
                    except Exception as e:
                        logger.error(f"Failed to subscribe {code}: {e}")
                else:
                    self.subscribed_codes.add(code)
        else:
            for code in to_add:
                self.subscribed_codes.add(code)

    def unsubscribe_codes(self, codes: set[str]):
        """取消訂閱不再使用的股票"""
        for code in codes:
            if code in self.subscribed_codes:
                info = self.contracts_cache.get(code)
                if self.api and self.is_logged_in and info and "contract" in info:
                    try:
                        self.api.unsubscribe(
                            info["contract"],
                            quote_type=sj.QuoteType.Quote,
                            version=sj.QuoteVersion.v1
                        )
                        logger.info(f"Unsubscribed Quote for {code}")
                    except Exception as e:
                        logger.error(f"Failed to unsubscribe {code}: {e}")
                self.subscribed_codes.discard(code)
                quote_store.remove_quote(code)

    def _fetch_snapshots(self, codes: list[str]):
        """透過一次性 snapshot 初始化個股資料"""
        if not self.api or not self.is_logged_in:
            return
        
        contracts_to_snap = []
        for code in codes:
            info = self.contracts_cache.get(code)
            if info and "contract" in info:
                contracts_to_snap.append(info["contract"])

        if not contracts_to_snap:
            return

        try:
            snaps = self.api.snapshots(contracts_to_snap)
            for s in snaps:
                code = str(s.code)
                last_price = safe_float(s.close)
                chg_price = safe_float(s.change_price)
                ref_close = (last_price - chg_price) if (last_price is not None and chg_price is not None) else None
                
                # 如果快取有 reference
                if ref_close is None:
                    info = self.contracts_cache.get(code)
                    if info and info.get("reference"):
                        ref_close = info["reference"]

                ts_str = None
                if getattr(s, "ts", None):
                    try:
                        ts_str = datetime.fromtimestamp(s.ts / 1e9, tz=timezone.utc).isoformat()
                    except Exception:
                        pass

                quote_store.update_quote(
                    code=code,
                    last=last_price,
                    bid=safe_float(s.buy_price),
                    ask=safe_float(s.sell_price),
                    open_price=safe_float(s.open),
                    high=safe_float(s.high),
                    low=safe_float(s.low),
                    total_volume=safe_int(s.total_volume),
                    previous_close=ref_close,
                    source_ts=ts_str,
                    data_status="closed"
                )
            logger.info(f"Loaded snapshots for {len(snaps)} contracts.")
        except Exception as e:
            logger.error(f"Error fetching snapshots: {e}")

    async def _mock_ticks_loop(self):
        """自動模式：僅在週末或盤後產生輔助跳動供測試推播，盤中交易時段自動停止，完全採用永豐即時回呼"""
        logger.info("Mock ticks loop started in AUTO mode.")
        while True:
            try:
                await asyncio.sleep(2.0)
                # 自動判斷：盤中時段不進行任何模擬
                if is_taiwan_market_open():
                    continue
                if not self.subscribed_codes:
                    continue
                # 隨機挑選 1 ~ 3 檔
                chosen_codes = random.sample(list(self.subscribed_codes), min(3, len(self.subscribed_codes)))
                for code in chosen_codes:
                    _, all_q = quote_store.get_all_quotes()
                    curr = all_q.get(code)
                    if not curr or curr.last is None:
                        continue
                    # 決定 tick size
                    p = curr.last
                    tick = 0.05 if p < 50 else (0.1 if p < 100 else (0.5 if p < 500 else 1.0))
                    direction = random.choice([-1, 0, 1])
                    new_last = round(curr.last + direction * tick, 2)
                    new_vol = (curr.totalVolume or 100) + random.randint(1, 20)
                    quote_store.update_quote(
                        code=code,
                        last=new_last,
                        bid=round(new_last - tick, 2),
                        ask=round(new_last + tick, 2),
                        total_volume=new_vol,
                        source_ts=datetime.now(timezone.utc).isoformat(),
                        data_status="live"
                    )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug(f"Error in mock loop: {e}")

shioaji_adapter = ShioajiAdapter()
