import asyncio
import logging
import random
import re
import urllib.request
import json
from datetime import datetime, timezone, timedelta, time
from typing import Optional, Any
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

def is_taiwan_trial_matching() -> bool:
    """判斷目前是否處於台股試撮時段 (盤中營業日 08:30~09:00 開盤前試撮 或 13:25~13:30 收盤前試撮)"""
    tz_tw = timezone(timedelta(hours=8))
    now_tw = datetime.now(tz_tw)
    if now_tw.weekday() >= 5:
        return False
    t = now_tw.time()
    # 08:30 ~ 09:00 開盤前試撮
    if time(8, 30) <= t < time(9, 0):
        return True
    # 13:25 ~ 13:30 收盤前試撮
    if time(13, 25) <= t < time(13, 30):
        return True
    return False

def is_taiwan_trading_or_trial_day_hours() -> bool:
    """判斷是否處於台股營業日之交易或試撮時段 (週一至週五 08:30 ~ 13:35，此期間嚴禁執行任何盤後模擬)"""
    tz_tw = timezone(timedelta(hours=8))
    now_tw = datetime.now(tz_tw)
    if now_tw.weekday() >= 5:
        return False
    current_minutes = now_tw.hour * 60 + now_tw.minute
    return (8 * 60 + 30) <= current_minutes <= (13 * 60 + 35)

def parse_roc_date(d_str: str) -> str:
    m = re.search(r'(\d{2,3})[/\-.]?(\d{2})[/\-.]?(\d{2})', d_str)
    if m:
        _, mm, dd = m.groups()
        return f"{mm}/{dd}"
    return d_str

def fetch_disposition_periods() -> dict[str, dict[str, Any]]:
    """向 TWSE (上市) 與 TPEx (上櫃) 官方公開 Open API 撈取公告之處置起訖日期表與處置等級"""
    results: dict[str, dict[str, Any]] = {}
    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}

    # 1. TWSE 上市處置資訊
    try:
        url = 'https://openapi.twse.com.tw/v1/announcement/punish'
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            for item in data:
                code = str(item.get('Code', '')).strip()
                period = str(item.get('DispositionPeriod', '')).strip()
                measures = str(item.get('DispositionMeasures', '')).strip()
                detail = str(item.get('Detail', '')).strip()

                parts = re.split(r'[～~～至\-]+', period)
                if len(parts) >= 2:
                    start_d = parse_roc_date(parts[0])
                    end_d = parse_roc_date(parts[1])
                    fmt = f"{start_d}~{end_d}"
                else:
                    fmt = period

                level = 1
                if '第二次' in measures or '第二' in measures or '20分' in detail or '二十分' in detail:
                    level = 2
                elif '第三次' in measures or '第三' in measures:
                    level = 3

                if code:
                    results[code] = {"period": fmt, "level": level}
    except Exception as e:
        logger.warning(f"Failed to fetch TWSE disposition info: {e}")

    # 2. TPEx 上櫃處置資訊
    try:
        url = 'https://www.tpex.org.tw/openapi/v1/tpex_disposal_information'
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            for item in data:
                code = str(item.get('SecuritiesCompanyCode', '')).strip()
                period = str(item.get('DispositionPeriod', '')).strip()
                cond = str(item.get('DisposalCondition', '')).strip()

                parts = re.split(r'[～~～至\-]+', period)
                if len(parts) >= 2:
                    start_d = parse_roc_date(parts[0])
                    end_d = parse_roc_date(parts[1])
                    fmt = f"{start_d}~{end_d}"
                else:
                    fmt = period

                level = 2 if ('曾發布處置' in cond or '20分' in cond or '二十分' in cond) else 1

                if code:
                    results[code] = {"period": fmt, "level": level}
    except Exception as e:
        logger.warning(f"Failed to fetch TPEx disposition info: {e}")

    return results

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
        self.disposition_dates_cache: dict[str, dict[str, Any]] = {}
        self.market_indices: dict[str, dict[str, Any]] = {
            "TSE": {"code": "IX0001", "name": "加權指數", "price": 0.0, "change": 0.0, "changePercent": 0.0},
            "OTC": {"code": "IX0043", "name": "櫃買指數", "price": 0.0, "change": 0.0, "changePercent": 0.0},
        }
        self.indices_dirty = False
        self.stock_positions_detail: list[dict[str, Any]] = []
        self.cached_wealth_summary: dict[str, Any] = {
            "totalPnl": 0.0,
            "totalCost": 0.0,
            "totalMarketValue": 0.0,
            "returnPercent": 0.0,
        }
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
                
                # 設定 Quote callback (個股與指數)
                self.api.set_on_quote_stk_v1_callback(self._on_quote_callback)
                self.api.set_on_quote_idx_v1_callback(self._on_index_quote_callback)

                # 初始化與訂閱大盤加權指數 (TSE IX0001) 與 櫃買指數 (OTC IX0043)
                self._init_and_subscribe_indices()
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
        """讀取 TSE 與 OTC 合約並快取，同時更新證交所/櫃買處置公告快取"""
        if not self.api:
            return
        
        # 抓取官方處置公告區間與等級快取
        self.disposition_dates_cache = fetch_disposition_periods()
        logger.info(f"Loaded disposition periods cache for {len(self.disposition_dates_cache)} stocks.")

        count = 0
        try:
            for exchange_key, view in [("TSE", self.api.Contracts.Stocks.TSE), ("OTC", self.api.Contracts.Stocks.OTC)]:
                for contract in view:
                    sec_type = "ETF" if (contract.category == "00" or contract.code.startswith("00")) else "STOCK"
                    
                    is_att = bool(getattr(contract, "attention_flag", False))
                    disp_level = int(getattr(contract, "disposition_level", 0) or 0)
                    
                    disp_info = self.disposition_dates_cache.get(contract.code)
                    disp_period = disp_info["period"] if disp_info else None
                    if disp_info and disp_info.get("level"):
                        disp_level = max(disp_level, disp_info["level"])

                    self.contracts_cache[contract.code] = {
                        "code": contract.code,
                        "name": contract.name,
                        "exchange": contract.exchange,
                        "securityType": sec_type,
                        "reference": float(contract.reference) if contract.reference else None,
                        "isAttention": is_att,
                        "dispositionLevel": disp_level,
                        "dispositionPeriod": disp_period,
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
                        reference=info["reference"],
                        isAttention=info.get("isAttention", False),
                        dispositionLevel=info.get("dispositionLevel", 0),
                        dispositionPeriod=info.get("dispositionPeriod")
                    )
                )
                if len(matches) >= limit:
                    break
        return matches

    def fetch_stock_positions(self) -> tuple[list[str], dict[str, Any]]:
        """從永豐證券 API 取得真實帳戶持股代號清單與持股損益匯總"""
        if not settings.SJ_API_KEY or not settings.SJ_SECRET_KEY:
            return [], {}
        
        try:
            # 建立真實連線實例讀取庫存 (持股資料隸屬真實環境帳號)
            real_api = sj.Shioaji(simulation=False)
            real_api.login(
                api_key=settings.SJ_API_KEY,
                secret_key=settings.SJ_SECRET_KEY,
                subscribe_trade=False
            )
            positions = real_api.list_positions(real_api.stock_account, unit=sj.Unit.Share)
            codes = []
            total_cost = 0.0
            total_pnl = 0.0
            total_market_val = 0.0

            self.stock_positions_detail = []
            for p in positions:
                code_str = str(getattr(p, 'code', '')).strip()
                if code_str:
                    codes.append(code_str)
                qty = float(getattr(p, 'quantity', 0) or 0)
                price = float(getattr(p, 'price', 0) or 0)
                pnl = float(getattr(p, 'pnl', 0) or 0)
                last_p = float(getattr(p, 'last_price', 0) or 0)
                total_cost += price * qty
                total_pnl += pnl
                total_market_val += last_p * qty
                if code_str:
                    self.stock_positions_detail.append({
                        "code": code_str,
                        "quantity": qty,
                        "cost_price": price,
                        "initial_last": last_p if last_p > 0 else price
                    })

            roi = round((total_pnl / total_cost * 100), 2) if total_cost > 0 else 0.0
            summary = {
                "totalPnl": round(total_pnl, 2),
                "totalCost": round(total_cost, 2),
                "totalMarketValue": round(total_market_val, 2),
                "returnPercent": roi,
            }
            self.cached_wealth_summary = summary

            try:
                real_api.logout()
            except Exception:
                pass
            logger.info(f"Fetched {len(codes)} stock positions from Shioaji. PnL: {summary['totalPnl']}, ROI: {summary['returnPercent']}%")
            return codes, summary
        except Exception as e:
            logger.error(f"Failed to fetch stock positions from Shioaji: {e}", exc_info=True)
            return [], {}

    def get_live_wealth_summary(self) -> dict[str, Any]:
        """根據當前即時行情動態計算最新總損益與報酬率"""
        if not self.stock_positions_detail:
            return self.cached_wealth_summary

        total_cost = 0.0
        total_market_val = 0.0
        _, quotes = quote_store.get_all_quotes()

        for p in self.stock_positions_detail:
            code = p["code"]
            qty = p["quantity"]
            cost_p = p["cost_price"]
            total_cost += cost_p * qty

            curr_q = quotes.get(code)
            curr_price = curr_q.last if (curr_q and curr_q.last is not None) else p.get("initial_last", cost_p)
            total_market_val += curr_price * qty

        total_pnl = total_market_val - total_cost
        roi = round((total_pnl / total_cost * 100), 2) if total_cost > 0 else 0.0
        live_summary = {
            "totalPnl": round(total_pnl, 2),
            "totalCost": round(total_cost, 2),
            "totalMarketValue": round(total_market_val, 2),
            "returnPercent": roi,
        }
        self.cached_wealth_summary = live_summary
        return live_summary

    def _init_and_subscribe_indices(self):
        """初始化並訂閱大盤加權指數 (TSE IX0001) 與 櫃買指數 (OTC IX0043)"""
        if not self.api:
            return
        
        try:
            contracts_to_snap = []
            tse_idx = self.api.Contracts.Indexs.TSE.get("IX0001")
            otc_idx = self.api.Contracts.Indexs.OTC.get("IX0043")
            if tse_idx:
                contracts_to_snap.append(tse_idx)
            if otc_idx:
                contracts_to_snap.append(otc_idx)

            if contracts_to_snap:
                snaps = self.api.snapshots(contracts_to_snap)
                for s in snaps:
                    code = str(getattr(s, "code", ""))
                    close_p = safe_float(getattr(s, "close", None))
                    chg_p = safe_float(getattr(s, "change_price", None))
                    chg_pct = safe_float(getattr(s, "change_rate", None))
                    target_key = "TSE" if code == "IX0001" else ("OTC" if code == "IX0043" else None)
                    if target_key and close_p is not None:
                        self.market_indices[target_key]["price"] = round(close_p, 2)
                        self.market_indices[target_key]["change"] = round(chg_p or 0.0, 2)
                        self.market_indices[target_key]["changePercent"] = round(chg_pct or 0.0, 2)
                logger.info(f"Initialized market indices snapshots: {self.market_indices}")

            # 訂閱指數即時行情
            if tse_idx:
                try:
                    self.api.subscribe(tse_idx, quote_type=sj.QuoteType.Quote, version=sj.QuoteVersion.v1)
                    logger.info("Subscribed index Quote for TSE (IX0001)")
                except Exception as e:
                    logger.warning(f"Failed to subscribe TSE index quote: {e}")
            if otc_idx:
                try:
                    self.api.subscribe(otc_idx, quote_type=sj.QuoteType.Quote, version=sj.QuoteVersion.v1)
                    logger.info("Subscribed index Quote for OTC (IX0043)")
                except Exception as e:
                    logger.warning(f"Failed to subscribe OTC index quote: {e}")
        except Exception as e:
            logger.error(f"Error in _init_and_subscribe_indices: {e}", exc_info=True)

    def _on_index_quote_callback(self, quote):
        """大盤與櫃買指數即時回呼"""
        try:
            code = getattr(quote, "code", None)
            close_p = safe_float(getattr(quote, "close", None))
            chg_p = safe_float(getattr(quote, "change_price", None))
            if chg_p is None:
                chg_p = safe_float(getattr(quote, "change", None))
            target_key = "TSE" if code == "IX0001" else ("OTC" if code == "IX0043" else None)
            if target_key and close_p is not None:
                self.market_indices[target_key]["price"] = round(close_p, 2)
                if chg_p is not None:
                    self.market_indices[target_key]["change"] = round(chg_p, 2)
                    ref = close_p - chg_p
                    if ref > 0:
                        self.market_indices[target_key]["changePercent"] = round((chg_p / ref) * 100, 2)
                self.indices_dirty = True
        except Exception as e:
            logger.debug(f"Error parsing index quote callback: {e}")

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

            # 試撮判定：Shioaji simtrade 旗標 (1: 試撮) 或當前台股試撮時段
            simtrade_flag = getattr(quote, "simtrade", 0)
            is_sim = bool(simtrade_flag == 1 or is_taiwan_trial_matching())

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
                is_simulated=is_sim,
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
            is_att = info.get("isAttention", False) if info else False
            disp_lvl = info.get("dispositionLevel", 0) if info else 0
            disp_period = info.get("dispositionPeriod") if info else None
            
            # 初始化 quote store 記錄
            quote_store.init_or_get_quote(
                code,
                name=name,
                exchange=exchange,
                security_type=sec_type,
                is_attention=is_att,
                disposition_level=disp_lvl,
                disposition_period=disp_period
            )
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
        """自動模式：僅在週末或非營業時段產生輔助跳動，營業日盤中與試撮時段嚴格自動停止"""
        logger.info("Mock ticks loop started in AUTO mode.")
        while True:
            try:
                await asyncio.sleep(2.0)
                # 營業日時段 (08:30~13:35) 絕對不進行任何模擬
                if is_taiwan_trading_or_trial_day_hours():
                    continue
                # 非模擬模式且未明確強制開啟盤後跳動時不模擬
                if not settings.SJ_SIMULATION and not settings.ENABLE_OFFHOURS_MOCK_TICKS:
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
                        is_simulated=is_taiwan_trial_matching(),
                        source_ts=datetime.now(timezone.utc).isoformat(),
                        data_status="live"
                    )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug(f"Error in mock loop: {e}")

shioaji_adapter = ShioajiAdapter()
