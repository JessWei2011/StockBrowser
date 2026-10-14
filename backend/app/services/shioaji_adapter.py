import asyncio
import logging
import os
from pathlib import Path
import random
import re
import urllib.request
import json
from datetime import datetime, date, timezone, timedelta, time
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

def parse_roc_to_date(d_str: str) -> Optional[date]:
    m = re.search(r'(\d{2,3})[/\-.]?(\d{2})[/\-.]?(\d{2})', d_str)
    if m:
        yy, mm, dd = m.groups()
        year = int(yy) + 1911
        return date(year, int(mm), int(dd))
    return None

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
                    # 檢查處置結束日期是否過期
                    end_obj = parse_roc_to_date(parts[1])
                    if end_obj and end_obj < date.today():
                        continue
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
                    # 檢查處置結束日期是否過期
                    end_obj = parse_roc_to_date(parts[1])
                    if end_obj and end_obj < date.today():
                        continue
                else:
                    fmt = period

                level = 2 if ('曾發布處置' in cond or '20分' in cond or '二十分' in cond) else 1

                if code:
                    results[code] = {"period": fmt, "level": level}
    except Exception as e:
        logger.warning(f"Failed to fetch TPEx disposition info: {e}")

    return results

def fetch_closing_odd_lots() -> tuple[dict[str, float], Optional[str]]:
    """向 TWSE 與 TPEx 官方公開管道撈取盤中零股收盤成交價"""
    results: dict[str, float] = {}
    twse_date: Optional[str] = None
    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'}

    # 1. TWSE 上市盤中零股行情 (TWTC7U)
    try:
        url = 'https://www.twse.com.tw/rwd/zh/afterTrading/TWTC7U?response=json'
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            twse_date = str(data.get('date', '')).strip() or None
            rows = data.get('data', [])
            for r in rows:
                if len(r) > 6:
                    code = str(r[0]).strip()
                    price_str = str(r[6]).replace(',', '').strip()
                    try:
                        p = float(price_str)
                        if p > 0:
                            results[code] = p
                    except (ValueError, TypeError):
                        pass
    except Exception as e:
        logger.warning(f"Failed to fetch TWSE odd lots: {e}")

    # 2. TPEx 上櫃盤中零股行情
    try:
        url = 'https://www.tpex.org.tw/openapi/v1/tpex_odd_stock'
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            for item in data:
                code = str(item.get('SecuritiesCompanyCode', '')).strip()
                price_str = str(item.get('Price', '')).replace(',', '').strip()
                try:
                    p = float(price_str)
                    if p > 0:
                        results[code] = p
                except (ValueError, TypeError):
                    pass
    except Exception as e:
        logger.warning(f"Failed to fetch TPEx odd lots: {e}")

    return results, twse_date

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

def calc_position_net_pnl(code: str, price: float, qty: float, cost: float, initial_last: float = 0.0, initial_pnl: float = 0.0) -> float:
    """計算扣除賣出手續費與證券交易稅後之個股淨損益"""
    if initial_last > 0 and abs(price - initial_last) < 1e-4:
        return initial_pnl
    mv = price * qty
    # 證券交易稅: 債券ETF 0%, 股票型ETF 0.1%, 普通現股 0.3%
    if 'B' in code:
        tax = 0.0
    elif code.startswith('00'):
        tax = float(int(mv * 0.001))
    else:
        tax = float(int(mv * 0.003))
    # 賣出手續費: 0.1425%, 最低 1 元
    fee = max(1.0, float(int(mv * 0.001425)))
    net_mv = mv - tax - fee
    return round(net_mv - cost, 2)

def format_index_amount(raw_amount: Optional[float]) -> tuple[Optional[float], Optional[str]]:
    """
    將大盤成交金額轉換為 (以億為單位的浮點數, 格式化文字如 '3,842億')
    台股加權指數每日成交額通常在 1,000 ~ 8,000 億元
    """
    if raw_amount is None or raw_amount <= 0:
        return None, None
    if raw_amount >= 10_000_000_000:
        val_in_yi = raw_amount / 100_000_000.0
    elif raw_amount >= 100_000:
        val_in_yi = raw_amount / 100.0
    elif raw_amount >= 10_000:
        val_in_yi = raw_amount / 100_000.0
    else:
        val_in_yi = raw_amount

    val_in_yi_rounded = round(val_in_yi, 1)
    text = f"{int(round(val_in_yi)):,}億"
    return val_in_yi_rounded, text

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
            "TSE": {"code": "IX0001", "name": "加權指數", "price": 0.0, "change": 0.0, "changePercent": 0.0, "reference": None, "open": None, "high": None, "low": None, "volumeText": None, "volumeAmount": None},
            "OTC": {"code": "IX0043", "name": "櫃買指數", "price": 0.0, "change": 0.0, "changePercent": 0.0, "reference": None, "open": None, "high": None, "low": None, "volumeText": None, "volumeAmount": None},
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
        self._odd_lots_scheduler_task: Optional[asyncio.Task] = None
        self._morning_sync_scheduler_task: Optional[asyncio.Task] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._last_odd_fetch_date: Optional[str] = None
        self._last_morning_sync_date: Optional[str] = None
        self.stock_account: Any = None
        self.ca_activated: bool = False
        self._order_modified_prices: dict[str, float] = {}

    async def _fetch_and_apply_closing_odd_lots(self) -> bool:
        """非同步向 TWSE / TPEx 抓取最新盤後零股行情並更新進 quote_store"""
        try:
            loop = asyncio.get_running_loop()
            odd_data, twse_date = await loop.run_in_executor(None, fetch_closing_odd_lots)
            if odd_data:
                quote_store.update_odd_lot_batch(odd_data)
                logger.info(f"Loaded {len(odd_data)} closing odd lot quotes (TWSE date: {twse_date}) into quote_store.")
                
                tz_tw = timezone(timedelta(hours=8))
                now_tw = datetime.now(tz_tw)
                today_tw = now_tw.strftime("%Y%m%d")
                if twse_date and twse_date == today_tw:
                    self._last_odd_fetch_date = now_tw.strftime("%Y-%m-%d")
                    logger.info(f"Successfully synchronized today's closing odd lots for {self._last_odd_fetch_date}.")
                return True
        except Exception as e:
            logger.warning(f"Error updating closing odd lots: {e}")
        return False

    async def _odd_lots_scheduler_loop(self):
        """盤後自動排程：營業日 13:35 後定期確保抓取今日最新盤後零股行情"""
        logger.info("Odd lots scheduler loop started.")
        while True:
            try:
                await asyncio.sleep(60.0)
                tz_tw = timezone(timedelta(hours=8))
                now_tw = datetime.now(tz_tw)
                today_str = now_tw.strftime("%Y-%m-%d")

                is_weekday = (now_tw.weekday() < 5)
                is_after_market = (now_tw.hour * 60 + now_tw.minute >= 13 * 60 + 35)

                if is_weekday and is_after_market and self._last_odd_fetch_date != today_str:
                    logger.info(f"Triggering scheduled closing odd lots fetch for {today_str}...")
                    await self._fetch_and_apply_closing_odd_lots()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Error in odd lots scheduler loop: {e}")

    def refresh_contracts_and_snapshots(self):
        """重新向 Shioaji 刷新最新合約快取與今日 snapshot (適用於開盤前或跨日自動重載)"""
        if not self.api or not self.is_logged_in:
            return
        try:
            logger.info("Rebuilding contracts cache with latest market data...")
            self._build_contracts_cache()
            if self.subscribed_codes:
                logger.info(f"Refreshing snapshots for {len(self.subscribed_codes)} subscribed codes...")
                self._fetch_snapshots(list(self.subscribed_codes))
            self._init_and_subscribe_indices()
            logger.info("Contracts, snapshots, and indices refreshed successfully.")
        except Exception as e:
            logger.error(f"Failed to refresh contracts and snapshots: {e}", exc_info=True)

    async def _morning_sync_scheduler_loop(self):
        """營業日開盤前自動排程：08:35 ~ 08:50 自動更新今日合約、基準昨收與快照"""
        logger.info("Morning sync scheduler loop started.")
        while True:
            try:
                await asyncio.sleep(30.0)
                tz_tw = timezone(timedelta(hours=8))
                now_tw = datetime.now(tz_tw)
                today_str = now_tw.strftime("%Y-%m-%d")

                is_weekday = (now_tw.weekday() < 5)
                current_minutes = now_tw.hour * 60 + now_tw.minute
                is_morning_window = (8 * 60 + 30 <= current_minutes <= 8 * 60 + 55)

                if is_weekday and is_morning_window and self._last_morning_sync_date != today_str:
                    logger.info(f"Triggering scheduled morning contracts & snapshots refresh for {today_str}...")
                    loop = asyncio.get_running_loop()
                    await loop.run_in_executor(None, self.refresh_contracts_and_snapshots)
                    self._last_morning_sync_date = today_str
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Error in morning sync scheduler loop: {e}")

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
                    subscribe_trade=True
                )
                self.is_logged_in = True
                self.is_connected = True
                logger.info(f"Shioaji login succeeded. Accounts: {len(accounts)}")

                # 鎖定台股證券帳號
                stock_accounts = [
                    acc for acc in accounts
                    if getattr(acc, "account_type", None) == sj.AccountType.Stock
                    or str(getattr(acc, "account_type", "")).lower() == "stock"
                    or getattr(acc, "account_type", None) == "H"
                ]
                self.stock_account = stock_accounts[0] if stock_accounts else (accounts[0] if accounts else None)
                if self.stock_account:
                    logger.info(f"Locked stock trading account: {self.stock_account.broker_id}-{self.stock_account.account_id}")

                # 啟用 CA 交易憑證
                ca_path = settings.SJ_CA_PATH
                if not ca_path or not os.path.exists(ca_path):
                    candidates = [
                        Path(__file__).resolve().parent.parent.parent.parent / "Sinopac.pfx",
                        Path("/Users/jess/Desktop/Python/永豐下單/Sinopac.pfx"),
                    ]
                    for c in candidates:
                        if c.exists():
                            ca_path = str(c)
                            break

                ca_passwd = settings.SJ_CA_PASSWD
                person_id = settings.SJ_PERSON_ID or ca_passwd
                if ca_path and os.path.exists(ca_path) and ca_passwd:
                    try:
                        res = self.api.activate_ca(ca_path=ca_path, ca_passwd=ca_passwd, person_id=person_id)
                        self.ca_activated = bool(res)
                        logger.info(f"Shioaji CA activated successfully: {self.ca_activated} (path: {ca_path})")
                    except Exception as e:
                        logger.warning(f"Failed to activate Shioaji CA: {e}")

                # 建立合約快取以供搜尋
                self._build_contracts_cache()
                
                # 設定 Quote callback (個股與指數) 與 盤中零股 Tick callback
                self.api.set_on_quote_stk_v1_callback(self._on_quote_callback)
                self.api.set_on_quote_idx_v1_callback(self._on_index_quote_callback)
                self.api.set_on_tick_stk_v1_callback(self._on_tick_callback)
                self.api.set_session_down_callback(self._on_session_down)

                # 初始化與訂閱大盤加權指數 (TSE IX0001) 與 櫃買指數 (OTC IX0043)
                self._init_and_subscribe_indices()
            else:
                logger.warning("SJ_API_KEY / SJ_SECRET_KEY not set. Running in offline/mock mode.")
        except Exception as e:
            logger.error(f"Failed to connect to Shioaji: {e}", exc_info=True)
            self.is_connected = False
            self.is_logged_in = False

        # 啟動非同步盤後零股定時排程任務與初次補抓任務
        self._odd_lots_scheduler_task = asyncio.create_task(self._odd_lots_scheduler_loop())
        asyncio.create_task(self._fetch_and_apply_closing_odd_lots())

        # 啟動開盤前自動更新合約與快照排程
        self._morning_sync_scheduler_task = asyncio.create_task(self._morning_sync_scheduler_loop())

        # 如果開啟非盤中模擬跳動或處於測試模式，啟動輔助跳動背景任務
        if settings.ENABLE_OFFHOURS_MOCK_TICKS:
            self._mock_task = asyncio.create_task(self._mock_ticks_loop())

    def _on_session_down(self):
        logger.warning("Shioaji Solace session down event received! Scheduling reconnect...")
        self.is_connected = False
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(
                lambda: asyncio.create_task(self.reconnect())
            )

    async def reconnect(self):
        if getattr(self, "_reconnecting", False):
            return
        self._reconnecting = True
        logger.info("Attempting to reconnect to Shioaji...")
        try:
            try:
                if self.api:
                    self.api.logout()
            except Exception:
                pass
            await asyncio.sleep(2.0)
            self.api = sj.Shioaji(simulation=settings.SJ_SIMULATION)
            accounts = self.api.login(
                api_key=settings.SJ_API_KEY,
                secret_key=settings.SJ_SECRET_KEY,
                subscribe_trade=False
            )
            self.is_logged_in = True
            self.is_connected = True
            logger.info("Shioaji re-login succeeded.")
            
            self.api.set_on_quote_stk_v1_callback(self._on_quote_callback)
            self.api.set_on_quote_idx_v1_callback(self._on_index_quote_callback)
            self.api.set_on_tick_stk_v1_callback(self._on_tick_callback)
            self.api.set_session_down_callback(self._on_session_down)
            
            self._init_and_subscribe_indices()
            
            codes_to_resub = set(self.subscribed_codes)
            self.subscribed_codes.clear()
            self.subscribe_codes(codes_to_resub)
            logger.info(f"Reconnected and successfully resubscribed {len(codes_to_resub)} stocks.")
        except Exception as e:
            logger.error(f"Reconnect failed: {e}", exc_info=True)
            self.is_connected = False
        finally:
            self._reconnecting = False

    def stop(self):
        if self._odd_lots_scheduler_task:
            self._odd_lots_scheduler_task.cancel()
        if self._morning_sync_scheduler_task:
            self._morning_sync_scheduler_task.cancel()
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

            # 若已有訂閱中的股票，同步校正其昨收基準價
            for code in self.subscribed_codes:
                info = self.contracts_cache.get(code)
                if info and info.get("reference"):
                    quote_store.update_quote(code=code, previous_close=info["reference"])
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
            # 優先使用現有已登入的 client，避免重複登入或呼叫 logout 破壞整體 Solace 連線
            api_client = self.api if (self.api and self.is_logged_in) else None
            if not api_client or not getattr(api_client, "stock_account", None):
                logger.warning("Shioaji client not ready for list_positions.")
                return [], {}

            positions = api_client.list_positions(api_client.stock_account, unit=sj.Unit.Share)
            codes = []
            total_cost = 0.0
            total_pnl = 0.0

            self.stock_positions_detail = []
            for p in positions:
                code_str = str(getattr(p, 'code', '')).strip()
                if code_str:
                    codes.append(code_str)
                qty = float(getattr(p, 'quantity', 0) or 0)
                price = float(getattr(p, 'price', 0) or 0)
                pnl = float(getattr(p, 'pnl', 0) or 0)
                last_p = float(getattr(p, 'last_price', 0) or 0)
                cost = price * qty
                total_cost += cost
                total_pnl += pnl
                if code_str:
                    info = self.contracts_cache.get(code_str)
                    s_name = info["name"] if info else code_str
                    s_ex = info["exchange"] if info else "TSE"
                    self.stock_positions_detail.append({
                        "code": code_str,
                        "name": s_name,
                        "exchange": s_ex,
                        "quantity": qty,
                        "cost_price": price,
                        "initial_last": last_p if last_p > 0 else price,
                        "initial_pnl": pnl
                    })

            total_market_val = total_cost + total_pnl
            roi = round((total_pnl / total_cost * 100), 2) if total_cost > 0 else 0.0
            summary = {
                "totalPnl": round(total_pnl, 2),
                "totalCost": round(total_cost, 2),
                "totalMarketValue": round(total_market_val, 2),
                "returnPercent": roi,
            }
            self.cached_wealth_summary = summary
            logger.info(f"Fetched {len(codes)} stock positions from Shioaji. PnL: {summary['totalPnl']}, ROI: {summary['returnPercent']}%")
            return codes, summary
        except Exception as e:
            logger.error(f"Failed to fetch stock positions from Shioaji: {e}", exc_info=True)
            return [], {}

    def get_positions_detail(self) -> list[dict[str, Any]]:
        """回傳當前持股明細 (股票代號、名稱、市場別、剩餘股數、買進成本、初始參考價/損益)"""
        result = []
        for p in self.stock_positions_detail:
            code = p["code"]
            info = self.contracts_cache.get(code)
            name = p.get("name") or (info["name"] if info else code)
            exchange = p.get("exchange") or (info["exchange"] if info else "TSE")
            result.append({
                "code": code,
                "name": name,
                "exchange": exchange,
                "quantity": p.get("quantity", 0.0),
                "costPrice": p.get("cost_price", 0.0),
                "initialLast": p.get("initial_last", p.get("cost_price", 0.0)),
                "initialPnl": p.get("initial_pnl", 0.0),
            })
        return result

    def get_live_wealth_summary(self) -> dict[str, Any]:
        """根據當前即時行情動態計算最新總損益與報酬率（計入賣出手續費與證券交易稅）"""
        if not self.stock_positions_detail:
            return self.cached_wealth_summary

        total_cost = 0.0
        total_pnl = 0.0
        _, quotes = quote_store.get_all_quotes()

        for p in self.stock_positions_detail:
            code = p["code"]
            qty = p["quantity"]
            cost_p = p["cost_price"]
            cost = cost_p * qty
            total_cost += cost

            curr_q = quotes.get(code)
            curr_price = curr_q.last if (curr_q and curr_q.last is not None and curr_q.last > 0) else p.get("initial_last", cost_p)
            
            p_pnl = calc_position_net_pnl(
                code=code,
                price=curr_price,
                qty=qty,
                cost=cost,
                initial_last=float(p.get("initial_last", 0.0) or 0.0),
                initial_pnl=float(p.get("initial_pnl", 0.0) or 0.0)
            )
            total_pnl += p_pnl

        total_market_val = total_cost + total_pnl
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
                    ref_p = safe_float(getattr(s, "reference", None))
                    open_p = safe_float(getattr(s, "open", None))
                    high_p = safe_float(getattr(s, "high", None))
                    low_p = safe_float(getattr(s, "low", None))
                    chg_p = safe_float(getattr(s, "change_price", None))
                    chg_pct = safe_float(getattr(s, "change_rate", None))

                    idx_contract = tse_idx if code == "IX0001" else (otc_idx if code == "IX0043" else None)
                    contract_ref = safe_float(getattr(idx_contract, "reference", None)) if idx_contract else None
                    if (ref_p is None or ref_p <= 0) and contract_ref:
                        ref_p = contract_ref
                    if (ref_p is None or ref_p <= 0) and close_p is not None and chg_p is not None:
                        ref_p = close_p - chg_p
                    
                    if ref_p is not None and ref_p > 0 and close_p is not None:
                        chg_p = close_p - ref_p
                        chg_pct = (chg_p / ref_p) * 100
                    elif chg_p is not None and close_p is not None and chg_pct is None:
                        ref = close_p - chg_p
                        chg_pct = (chg_p / ref) * 100 if ref > 0 else 0.0

                    target_key = "TSE" if code == "IX0001" else ("OTC" if code == "IX0043" else None)
                    if target_key and close_p is not None:
                        self.market_indices[target_key]["price"] = round(close_p, 2)
                        self.market_indices[target_key]["change"] = round(chg_p or 0.0, 2)
                        self.market_indices[target_key]["changePercent"] = round(chg_pct or 0.0, 2)
                        if ref_p and ref_p > 0:
                            self.market_indices[target_key]["reference"] = round(ref_p, 2)
                        if open_p and open_p > 0:
                            self.market_indices[target_key]["open"] = round(open_p, 2)
                        if high_p and high_p > 0:
                            self.market_indices[target_key]["high"] = round(high_p, 2)
                        if low_p and low_p > 0:
                            self.market_indices[target_key]["low"] = round(low_p, 2)
                        raw_amt = safe_float(getattr(s, "total_amount", None)) or safe_float(getattr(s, "amount", None))
                        if raw_amt and raw_amt > 0:
                            amt_val, amt_str = format_index_amount(raw_amt)
                            if amt_str:
                                self.market_indices[target_key]["volumeText"] = amt_str
                                self.market_indices[target_key]["volumeAmount"] = amt_val
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
        """大盤與櫃買指數即時回呼 (Shioaji QuoteIdxV1: 提供 close, reference, open, high, low, amount_sum)"""
        try:
            code = getattr(quote, "code", None)
            close_p = safe_float(getattr(quote, "close", None))
            ref_p = safe_float(getattr(quote, "reference", None))
            open_p = safe_float(getattr(quote, "open", None))
            high_p = safe_float(getattr(quote, "high", None))
            low_p = safe_float(getattr(quote, "low", None))
            chg_p = safe_float(getattr(quote, "change_price", None))
            if chg_p is None:
                chg_p = safe_float(getattr(quote, "change", None))

            target_key = "TSE" if code == "IX0001" else ("OTC" if code == "IX0043" else None)
            if target_key and close_p is not None:
                self.market_indices[target_key]["price"] = round(close_p, 2)
                if open_p and open_p > 0:
                    self.market_indices[target_key]["open"] = round(open_p, 2)
                if high_p and high_p > 0:
                    self.market_indices[target_key]["high"] = round(high_p, 2)
                if low_p and low_p > 0:
                    self.market_indices[target_key]["low"] = round(low_p, 2)

                # 優先使用 QuoteIdxV1 的 reference (昨收) 即時精確計算跌點與跌幅
                stored_ref = self.market_indices[target_key].get("reference")
                effective_ref = ref_p if (ref_p is not None and ref_p > 0) else stored_ref

                if effective_ref is not None and effective_ref > 0:
                    real_chg = close_p - effective_ref
                    real_pct = (real_chg / effective_ref) * 100
                    self.market_indices[target_key]["change"] = round(real_chg, 2)
                    self.market_indices[target_key]["changePercent"] = round(real_pct, 2)
                    self.market_indices[target_key]["reference"] = round(effective_ref, 2)
                elif chg_p is not None:
                    self.market_indices[target_key]["change"] = round(chg_p, 2)
                    ref = close_p - chg_p
                    if ref > 0:
                        self.market_indices[target_key]["changePercent"] = round((chg_p / ref) * 100, 2)
                        self.market_indices[target_key]["reference"] = round(ref, 2)

                raw_amt = safe_float(getattr(quote, "amount_sum", None)) or safe_float(getattr(quote, "amount", None))
                if raw_amt and raw_amt > 0:
                    amt_val, amt_str = format_index_amount(raw_amt)
                    if amt_str:
                        self.market_indices[target_key]["volumeText"] = amt_str
                        self.market_indices[target_key]["volumeAmount"] = amt_val

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
            if last_price is not None and last_price <= 0:
                last_price = None

            open_price = safe_float(getattr(quote, "open", None))
            if open_price is not None and open_price <= 0:
                open_price = None

            high_price = safe_float(getattr(quote, "high", None))
            if high_price is not None and high_price <= 0:
                high_price = None

            low_price = safe_float(getattr(quote, "low", None))
            if low_price is not None and low_price <= 0:
                low_price = None

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

            # 取得即時漲跌與計算昨收參考價 (重要：動態自我校正過期昨收)
            chg_price = safe_float(getattr(quote, "price_chg", None))
            if chg_price is None:
                chg_price = safe_float(getattr(quote, "diff_price", None))

            ref_close = None
            if last_price is not None and chg_price is not None:
                ref_close = round(last_price - chg_price, 2)

            quote_store.update_quote(
                code=code,
                last=last_price,
                bid=bid,
                ask=ask,
                open_price=open_price,
                high=high_price,
                low=low_price,
                total_volume=tot_vol,
                previous_close=ref_close,
                is_simulated=is_sim,
                source_ts=source_ts,
                data_status="live"
            )
        except Exception as e:
            logger.debug(f"Error parsing quote callback: {e}")

    def _on_tick_callback(self, *args):
        """由 Solace 執行緒回呼盤中零股 (TickSTKv1)"""
        try:
            tick = args[-1] if args else None
            if not tick:
                return
            code = getattr(tick, "code", None)
            if not code:
                return

            close_p = safe_float(getattr(tick, "close", None))
            if close_p is not None and close_p > 0:
                dt = getattr(tick, "datetime", None)
                source_ts = dt.isoformat() if isinstance(dt, datetime) else None
                quote_store.update_quote(
                    code=code,
                    odd_lot_last=close_p,
                    odd_lot_source_ts=source_ts
                )
        except Exception as e:
            logger.debug(f"Error parsing odd lot tick callback: {e}")

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

        # 呼叫 Shioaji API 訂閱即時行情 (整股 Quote + 盤中零股 Tick)
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
                        logger.error(f"Failed to subscribe Quote for {code}: {e}")

                    try:
                        self.api.subscribe(
                            info["contract"],
                            quote_type=sj.QuoteType.Tick,
                            version=sj.QuoteVersion.v1,
                            intraday_odd=True
                        )
                        logger.info(f"Subscribed Odd Lot Tick for {code}")
                    except Exception as e:
                        logger.warning(f"Failed to subscribe Odd Lot Tick for {code}: {e}")
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
                        logger.error(f"Failed to unsubscribe Quote for {code}: {e}")

                    try:
                        self.api.unsubscribe(
                            info["contract"],
                            quote_type=sj.QuoteType.Tick,
                            version=sj.QuoteVersion.v1,
                            intraday_odd=True
                        )
                        logger.info(f"Unsubscribed Odd Lot Tick for {code}")
                    except Exception as e:
                        pass
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
                if last_price is not None and last_price <= 0:
                    last_price = None

                open_price = safe_float(s.open)
                if open_price is not None and open_price <= 0:
                    open_price = None

                high_price = safe_float(s.high)
                if high_price is not None and high_price <= 0:
                    high_price = None

                low_price = safe_float(s.low)
                if low_price is not None and low_price <= 0:
                    low_price = None

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
                    open_price=open_price,
                    high=high_price,
                    low=low_price,
                    total_volume=safe_int(s.total_volume),
                    previous_close=ref_close,
                    source_ts=ts_str,
                    data_status="live" if is_taiwan_market_open() else "closed"
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

    def place_order(
        self,
        code: str,
        action: str,
        quantity: int,
        unit: str = "lot",
        price_type: str = "limit",
        price: float = 0.0,
    ) -> dict[str, Any]:
        """送出委託單至永豐金證券"""
        if not self.api or not self.is_logged_in:
            raise RuntimeError("Shioaji 尚未連線或未登入")

        code = code.strip().upper()
        contract = None
        if code in self.contracts_cache:
            contract = self.contracts_cache[code].get("contract")

        if not contract:
            try:
                if hasattr(self.api.Contracts, "Stocks"):
                    contract = getattr(self.api.Contracts.Stocks, "TSE", {}).get(code) or getattr(self.api.Contracts.Stocks, "OTC", {}).get(code)
            except Exception:
                pass

        if not contract:
            try:
                contract = self.api.Contracts.Stocks[code]
            except Exception:
                pass

        if not contract:
            raise ValueError(f"找不到商品代碼 {code} 之證券合約")

        act = sj.Action.Buy if action.lower() == "buy" else sj.Action.Sell
        is_odd = (unit.lower() == "share")
        order_lot = sj.StockOrderLot.IntradayOdd if is_odd else sj.StockOrderLot.Common

        is_mkt = (price_type.lower() == "market")
        p_type = sj.StockPriceType.MKT if is_mkt else sj.StockPriceType.LMT
        order_price = 0.0 if is_mkt else float(price)

        account = getattr(self, "stock_account", None)
        if not account and hasattr(self.api, "stock_account"):
            account = self.api.stock_account

        if not account:
            raise RuntimeError("找不到可用的台股證券帳號！")

        order = self.api.Order(
            action=act,
            price=order_price,
            quantity=int(quantity),
            price_type=p_type,
            order_type=sj.OrderType.ROD,
            order_lot=order_lot,
            order_cond=sj.StockOrderCond.Cash,
            account=account
        )

        logger.info(f"Submitting Shioaji order: code={code}, action={action}, qty={quantity}, unit={unit}, price={order_price}, price_type={price_type}")
        trade = self.api.place_order(contract, order)

        try:
            self.api.update_status(account=account)
        except Exception:
            pass

        status_code = getattr(trade.status, "status_code", "")
        status_str = str(getattr(trade.status, "status", ""))
        op_msg = getattr(trade.status, "msg", "")

        if status_code and status_code != "00":
            return {
                "success": False,
                "orderId": getattr(trade.order, "id", ""),
                "status": status_str,
                "statusCode": status_code,
                "message": op_msg or f"交易所退單 (代碼 {status_code})：集保不足或委託條件不符"
            }

        unit_str = "張" if unit == "lot" else "股"
        price_str = "市價" if is_mkt else f"${order_price}"
        return {
            "success": True,
            "orderId": getattr(trade.order, "id", ""),
            "status": status_str or "Submitted",
            "statusCode": status_code or "00",
            "message": f"委託成功送出！【{trade.order.action} {code}】{quantity}{unit_str} @ {price_str}"
        }

    def fetch_orders(self) -> list[dict[str, Any]]:
        """取得今日所有證券委託單與成交狀態"""
        if not self.api or not self.is_logged_in:
            return []
        account = getattr(self, "stock_account", None)
        if not account and hasattr(self.api, "stock_account"):
            account = self.api.stock_account
        if not account:
            return []
        
        try:
            self.api.update_status(account=account)
        except Exception as e:
            logger.warning(f"Error calling update_status: {e}")

        orders: list[dict[str, Any]] = []
        try:
            trades = self.api.list_trades()
            for t in trades:
                order_id = getattr(t.order, "id", "")
                if not order_id:
                    continue

                code = getattr(t.contract, "code", "")
                name = self.contracts_cache.get(code, {}).get("name", "")
                if not name and hasattr(self.api, "Contracts") and hasattr(self.api.Contracts, "Stocks"):
                    try:
                        c_obj = self.api.Contracts.Stocks.get(code)
                        if c_obj:
                            name = getattr(c_obj, "name", "")
                    except Exception:
                        pass

                action_raw = getattr(t.order, "action", "Buy")
                action_str = getattr(action_raw, "value", str(action_raw)).replace("Action.", "")

                order_lot_raw = getattr(t.order, "order_lot", "Common")
                order_lot_str = getattr(order_lot_raw, "value", str(order_lot_raw)).replace("StockOrderLot.", "")

                price_type_raw = getattr(t.order, "price_type", "LMT")
                price_type_str = getattr(price_type_raw, "value", str(price_type_raw)).replace("StockPriceType.", "").replace("PriceType.", "")

                status_raw = getattr(t.status, "status", "Pending")
                status_str = getattr(status_raw, "value", str(status_raw)).replace("OrderStatus.", "")

                order_dt = getattr(t.status, "order_datetime", None)
                if isinstance(order_dt, datetime):
                    time_str = order_dt.strftime("%H:%M:%S")
                else:
                    time_str = "--:--:--"

                orig_qty = safe_int(getattr(t.order, "quantity", 0)) or 0
                deal_qty = safe_int(getattr(t.status, "deal_quantity", 0)) or 0
                cancel_qty = safe_int(getattr(t.status, "cancel_quantity", 0)) or 0

                is_active = status_str in ("Submitted", "PendingSubmit", "PreSubmitted", "PartFilled")
                active_qty = max(0, orig_qty - cancel_qty - deal_qty) if is_active else 0
                if not is_active and status_str == "Filled":
                    active_qty = 0

                orig_price = safe_float(getattr(t.order, "price", 0.0)) or 0.0
                mod_price = safe_float(getattr(t.status, "modified_price", 0.0)) or 0.0
                if getattr(self, "_order_modified_prices", None) and order_id in self._order_modified_prices:
                    mod_price = self._order_modified_prices[order_id]
                display_price = mod_price if mod_price > 0 else orig_price

                can_cancel = is_active and active_qty > 0
                can_update_price = can_cancel and price_type_str == "LMT"
                can_update_qty = can_cancel and active_qty > 1

                orders.append({
                    "id": order_id,
                    "ordno": getattr(t.order, "ordno", "") or "",
                    "code": code,
                    "name": name or code,
                    "action": action_str,
                    "price": display_price,
                    "originalPrice": orig_price,
                    "modifiedPrice": mod_price,
                    "priceType": price_type_str,
                    "qty": active_qty if is_active else orig_qty,
                    "originalQty": orig_qty,
                    "dealQty": deal_qty,
                    "cancelQty": cancel_qty,
                    "orderLot": order_lot_str,
                    "status": status_str,
                    "statusCode": getattr(t.status, "status_code", "") or "",
                    "msg": getattr(t.status, "msg", "") or "",
                    "time": time_str,
                    "canCancel": can_cancel,
                    "canUpdatePrice": can_update_price,
                    "canUpdateQty": can_update_qty,
                })
        except Exception as e:
            logger.error(f"Error fetching orders from Shioaji: {e}", exc_info=True)

        orders.sort(key=lambda x: x["time"], reverse=True)
        return orders

    def cancel_order(self, order_id: str) -> dict[str, Any]:
        """取消特定委託單"""
        if not self.api or not self.is_logged_in:
            raise RuntimeError("Shioaji 尚未連線或未登入")
        account = getattr(self, "stock_account", None)
        if not account and hasattr(self.api, "stock_account"):
            account = self.api.stock_account
        if not account:
            raise RuntimeError("找不到可用的台股證券帳號！")

        self.api.update_status(account=account)
        trades = self.api.list_trades()
        target_trade = next((t for t in trades if getattr(t.order, "id", "") == order_id), None)
        if not target_trade:
            raise ValueError(f"找不到委託單號 {order_id}")

        code = getattr(target_trade.contract, "code", "")
        name = self.contracts_cache.get(code, {}).get("name", code)
        self.api.cancel_order(trade=target_trade)
        try:
            self.api.update_status(account=account)
        except Exception:
            pass

        return {
            "success": True,
            "orderId": order_id,
            "message": f"已成功送出撤單委託【{code} {name}】"
        }

    def update_order(self, order_id: str, new_price: Optional[float] = None, new_qty: Optional[int] = None) -> dict[str, Any]:
        """修改委託價格或減量"""
        if not self.api or not self.is_logged_in:
            raise RuntimeError("Shioaji 尚未連線或未登入")
        account = getattr(self, "stock_account", None)
        if not account and hasattr(self.api, "stock_account"):
            account = self.api.stock_account
        if not account:
            raise RuntimeError("找不到可用的台股證券帳號！")

        self.api.update_status(account=account)
        trades = self.api.list_trades()
        target_trade = next((t for t in trades if getattr(t.order, "id", "") == order_id), None)
        if not target_trade:
            raise ValueError(f"找不到委託單號 {order_id}")

        order_lot_raw = getattr(target_trade.order, "order_lot", "Common")
        order_lot_str = getattr(order_lot_raw, "value", str(order_lot_raw)).replace("StockOrderLot.", "")

        orig_qty = safe_int(getattr(target_trade.order, "quantity", 0)) or 0
        cancel_qty = safe_int(getattr(target_trade.status, "cancel_quantity", 0)) or 0
        deal_qty = safe_int(getattr(target_trade.status, "deal_quantity", 0)) or 0
        current_active_qty = max(0, orig_qty - cancel_qty - deal_qty)

        code = getattr(target_trade.contract, "code", "")
        name = self.contracts_cache.get(code, {}).get("name", code)

        if not hasattr(self, "_order_modified_prices"):
            self._order_modified_prices = {}

        kwargs = {"trade": target_trade}

        # 1. 處理改量 (依交易所法規只能減少，不能增加)
        if new_qty is not None:
            if new_qty >= current_active_qty:
                raise ValueError(f"改量依法規只能減少！目前剩餘數量為 {current_active_qty}，請輸入小於該值的數量。")
            if new_qty <= 0:
                raise ValueError("修改後數量必須大於 0！若欲全數取消請直接使用「撤單」。")
            qty_to_reduce = current_active_qty - new_qty
            kwargs["qty"] = qty_to_reduce

        # 2. 處理改價
        if new_price is not None:
            if new_price <= 0:
                raise ValueError("委託價格必須大於 0")
            if "Common" in order_lot_str:
                kwargs["price"] = float(new_price)
            else:
                # 零股依法規不可直接改價，執行背景智慧撤單重下
                self.api.cancel_order(trade=target_trade)
                target_qty = new_qty if new_qty is not None else current_active_qty
                contract = None
                if code in self.contracts_cache:
                    contract = self.contracts_cache[code].get("contract")
                if not contract:
                    contract = target_trade.contract
                
                new_order = sj.StockOrder(
                    action=target_trade.order.action,
                    price=float(new_price),
                    quantity=int(target_qty),
                    price_type=sj.StockPriceType.LMT,
                    order_type=sj.OrderType.ROD,
                    order_lot=target_trade.order.order_lot,
                    order_cond=sj.StockOrderCond.Cash,
                    account=account
                )
                new_trade = self.api.place_order(contract, new_order)
                try:
                    self.api.update_status(account=account)
                except Exception:
                    pass
                new_id = getattr(new_trade.order, "id", "")
                self._order_modified_prices[order_id] = float(new_price)
                if new_id:
                    self._order_modified_prices[new_id] = float(new_price)
                return {
                    "success": True,
                    "type": "smart_replace",
                    "orderId": new_id or order_id,
                    "message": f"零股已成功撤單重下：【{code} {name}】改價為 ${new_price}，新單號: {new_id}"
                }

        # 送出直接改單 (整張改價/減量，或零股直接減量)
        if "price" in kwargs or "qty" in kwargs:
            self.api.update_order(**kwargs)
            try:
                self.api.update_status(account=account)
            except Exception:
                pass
            if new_price is not None:
                self._order_modified_prices[order_id] = float(new_price)
            
            changes = []
            if new_price is not None:
                changes.append(f"改價為 ${new_price}")
            if new_qty is not None:
                changes.append(f"數量減少為 {new_qty}")
            return {
                "success": True,
                "orderId": order_id,
                "message": f"委託修改成功：【{code} {name}】" + "，".join(changes)
            }

        raise ValueError("未指定任何修改項目 (請輸入新價格或新數量)")

shioaji_adapter = ShioajiAdapter()

