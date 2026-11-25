import concurrent.futures
import json
import logging
import math
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from backend.app.domain.models import QuoteState, DataStatus
from backend.app.settings import BASE_DIR

logger = logging.getLogger("quote_store")

def get_twse_tick_size(price: float) -> float:
    if price < 10:
        return 0.01
    elif price < 50:
        return 0.05
    elif price < 100:
        return 0.10
    elif price < 500:
        return 0.50
    elif price < 1000:
        return 1.00
    else:
        return 5.00

def calculate_twse_limits(ref_price: float, security_type: str = "STOCK") -> tuple[Optional[float], Optional[float]]:
    if not ref_price or ref_price <= 0:
        return None, None
    if security_type and security_type.upper() in ("BOND",):
        return None, None
    
    # 漲停價：參考價 * 1.10，未滿升降單位無條件捨去，且不得超過 10%
    raw_up = round(ref_price * 1.10, 6)
    tick_up = get_twse_tick_size(raw_up)
    steps_up = int((raw_up + 1e-7) / tick_up)
    limit_up = round(steps_up * tick_up, 2)
    max_rise = round(ref_price * 0.10, 2)
    if round(limit_up - ref_price, 2) > max_rise + 1e-4:
        limit_up = round((steps_up - 1) * tick_up, 2)

    # 跌停價：參考價 * 0.90，未滿升降單位無條件進位，且跌幅不得超過 10%
    raw_down = round(ref_price * 0.90, 6)
    tick_down = get_twse_tick_size(raw_down)
    steps_down = math.ceil((raw_down - 1e-7) / tick_down)
    limit_down = round(steps_down * tick_down, 2)
    if limit_down < 0.01:
        limit_down = 0.01
    max_drop = round(ref_price * 0.10, 2)
    if round(ref_price - limit_down, 2) > max_drop + 1e-4:
        limit_down = round((steps_down + 1) * tick_down, 2)

    return limit_up, limit_down

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

CACHE_DIR = BASE_DIR / "data"
ODD_CACHE_FILE = CACHE_DIR / "odd_quotes_cache.json"

_disk_writer_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="quote_store_disk_writer"
)

class QuoteStore:
    def __init__(self, cache_file: Optional[Path] = None):
        self._lock = threading.Lock()
        self._quotes: dict[str, QuoteState] = {}
        self._dirty_codes: set[str] = set()
        self._server_version: int = 0
        self._odd_cache: dict[str, float] = {}
        self._cache_file = cache_file or ODD_CACHE_FILE
        self._last_save_future: Optional[concurrent.futures.Future] = None
        self._load_odd_cache()

    def _load_odd_cache(self):
        try:
            if self._cache_file.exists():
                with open(self._cache_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        self._odd_cache = {str(k): float(v) for k, v in data.items() if v is not None}
                        logger.info(f"Loaded {len(self._odd_cache)} odd lot prices from cache.")
        except Exception as e:
            logger.warning(f"Failed to load odd quotes cache: {e}")

    def _save_odd_cache_locked(self):
        """非同步委派背景執行緒寫入硬碟快取，絕不於持有 self._lock 期間執行同步磁碟 I/O"""
        cache_snapshot = dict(self._odd_cache)
        self._last_save_future = _disk_writer_executor.submit(
            self._write_cache_disk, self._cache_file, cache_snapshot
        )

    @staticmethod
    def _write_cache_disk(target_file: Path, data: dict):
        try:
            target_file.parent.mkdir(parents=True, exist_ok=True)
            temp_file = target_file.with_suffix(f".tmp.{threading.get_ident()}")
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(data, f)
            temp_file.replace(target_file)
        except Exception as e:
            logger.warning(f"Failed to save odd quotes cache: {e}")

    def flush_cache(self, timeout: float = 2.0):
        """等待所有已排程的快取寫入完成 (供測試或關閉時同步調用)"""
        fut = getattr(self, "_last_save_future", None)
        if fut:
            try:
                fut.result(timeout=timeout)
            except Exception:
                pass

    def update_odd_lot_batch(self, odd_lots: dict[str, float]):
        with self._lock:
            changed_any = False
            for code, price in odd_lots.items():
                if price is not None and price > 0:
                    self._odd_cache[code] = price
                    if code in self._quotes:
                        curr = self._quotes[code]
                        if curr.oddLotLast != price:
                            curr.oddLotLast = price
                            curr.revision += 1
                            curr.receivedAt = now_iso()
                            self._dirty_codes.add(code)
                            changed_any = True
            if changed_any:
                self._server_version += 1
            self._save_odd_cache_locked()

    def init_or_get_quote(
        self,
        code: str,
        name: str = "",
        exchange: str = "TSE",
        security_type: str = "STOCK",
        is_simulated: bool = False,
        is_attention: bool = False,
        disposition_level: int = 0,
        disposition_period: Optional[str] = None
    ) -> QuoteState:
        with self._lock:
            if code not in self._quotes:
                cached_odd = self._odd_cache.get(code)
                self._quotes[code] = QuoteState(
                    code=code,
                    name=name,
                    exchange=exchange,
                    securityType=security_type,
                    receivedAt=now_iso(),
                    dataStatus="initializing",
                    revision=0,
                    isSimulated=is_simulated,
                    isAttention=is_attention,
                    dispositionLevel=disposition_level,
                    dispositionPeriod=disposition_period,
                    oddLotLast=cached_odd
                )
            return self._quotes[code]

    def remove_quote(self, code: str):
        with self._lock:
            if code in self._quotes:
                del self._quotes[code]
                self._dirty_codes.discard(code)
                self._server_version += 1

    def update_quote(
        self,
        code: str,
        name: Optional[str] = None,
        exchange: Optional[str] = None,
        security_type: Optional[str] = None,
        last: Optional[float] = None,
        odd_lot_last: Optional[float] = None,
        bid: Optional[float] = None,
        ask: Optional[float] = None,
        open_price: Optional[float] = None,
        high: Optional[float] = None,
        low: Optional[float] = None,
        total_volume: Optional[int] = None,
        previous_close: Optional[float] = None,
        limit_up: Optional[float] = None,
        limit_down: Optional[float] = None,
        source_ts: Optional[str] = None,
        odd_lot_source_ts: Optional[str] = None,
        data_status: Optional[DataStatus] = None,
        is_simulated: Optional[bool] = None,
        is_attention: Optional[bool] = None,
        disposition_level: Optional[int] = None,
        disposition_period: Optional[str] = None,
    ) -> bool:
        """
        更新特定個股報價，若有變動則標記 dirty，增加 revision。
        """
        with self._lock:
            current = self._quotes.get(code)
            if not current:
                current = QuoteState(
                    code=code,
                    name=name or "",
                    exchange=exchange or "TSE",
                    securityType=security_type or "STOCK",
                    receivedAt=now_iso(),
                    dataStatus="initializing",
                    revision=0,
                    oddLotLast=self._odd_cache.get(code)
                )
                self._quotes[code] = current

            # 檢查整股防回溯
            round_lot_stale = bool(source_ts and current.sourceTs and source_ts < current.sourceTs)
            # 檢查零股獨立防回溯
            odd_lot_stale = bool(odd_lot_source_ts and current.oddLotSourceTs and odd_lot_source_ts < current.oddLotSourceTs)

            if round_lot_stale and (odd_lot_last is None or odd_lot_stale):
                return False

            changed = False

            if not round_lot_stale:
                if name is not None and name != current.name:
                    current.name = name
                    changed = True
                if exchange is not None and exchange != current.exchange:
                    current.exchange = exchange
                    changed = True
                if security_type is not None and security_type != current.securityType:
                    current.securityType = security_type
                    changed = True

                if previous_close is not None and previous_close > 0 and previous_close != current.previousClose:
                    current.previousClose = previous_close
                    changed = True

                if limit_up is not None and limit_up > 0 and limit_up != current.limitUp:
                    current.limitUp = limit_up
                    changed = True

                if limit_down is not None and limit_down > 0 and limit_down != current.limitDown:
                    current.limitDown = limit_down
                    changed = True

                # 若尚未設定漲跌停價且昨收有效，自動計算台股漲跌停價
                if current.previousClose and current.previousClose > 0:
                    if current.limitUp is None or current.limitDown is None:
                        calc_up, calc_down = calculate_twse_limits(current.previousClose, current.securityType)
                        if current.limitUp is None and calc_up is not None:
                            current.limitUp = calc_up
                            changed = True
                        if current.limitDown is None and calc_down is not None:
                            current.limitDown = calc_down
                            changed = True

                if last is not None and last > 0 and last != current.last:
                    current.last = last
                    changed = True

                if bid is not None and bid != current.bid:
                    current.bid = bid
                    changed = True

                if ask is not None and ask != current.ask:
                    current.ask = ask
                    changed = True

                if open_price is not None and open_price > 0 and open_price != current.open:
                    current.open = open_price
                    changed = True

                if high is not None and high > 0 and high != current.high:
                    current.high = high
                    changed = True

                if low is not None and low > 0 and low != current.low:
                    current.low = low
                    changed = True

                if total_volume is not None and total_volume != current.totalVolume:
                    current.totalVolume = total_volume
                    changed = True

                if data_status is not None and data_status != current.dataStatus:
                    current.dataStatus = data_status
                    changed = True

                if source_ts is not None and source_ts != current.sourceTs:
                    current.sourceTs = source_ts
                    changed = True

            if not odd_lot_stale:
                if odd_lot_last is not None and odd_lot_last > 0 and odd_lot_last != current.oddLotLast:
                    current.oddLotLast = odd_lot_last
                    self._odd_cache[code] = odd_lot_last
                    self._save_odd_cache_locked()
                    changed = True

                if odd_lot_source_ts is not None and odd_lot_source_ts != current.oddLotSourceTs:
                    current.oddLotSourceTs = odd_lot_source_ts
                    changed = True

            # 計算漲跌與漲幅 (只有當昨收與現價皆有效且大於 0 時才計算)
            if current.last is not None and current.last > 0 and current.previousClose is not None and current.previousClose > 0:
                new_chg = round(current.last - current.previousClose, 2)
                new_pct = round((new_chg / current.previousClose) * 100, 2)
                if new_chg != current.change:
                    current.change = new_chg
                    changed = True
                if new_pct != current.changePercent:
                    current.changePercent = new_pct
                    changed = True

            if is_simulated is not None and is_simulated != current.isSimulated:
                current.isSimulated = is_simulated
                changed = True

            if is_attention is not None and is_attention != current.isAttention:
                current.isAttention = is_attention
                changed = True

            if disposition_level is not None and disposition_level != current.dispositionLevel:
                current.dispositionLevel = disposition_level
                changed = True

            if disposition_period is not None and disposition_period != current.dispositionPeriod:
                current.dispositionPeriod = disposition_period
                changed = True

            if changed:
                current.revision += 1
                current.receivedAt = now_iso()
                self._dirty_codes.add(code)
                self._server_version += 1
                return True

            return False

    def get_dirty_quotes(self) -> tuple[int, list[QuoteState]]:
        """取出所有 dirty 的報價並重置 dirty 集合"""
        with self._lock:
            if not self._dirty_codes:
                return self._server_version, []
            dirty_list = [self._quotes[code].model_copy() for code in sorted(self._dirty_codes) if code in self._quotes]
            self._dirty_codes.clear()
            return self._server_version, dirty_list

    def get_quote(self, code: str) -> Optional[QuoteState]:
        """取得單一商品最新報價快照"""
        with self._lock:
            q = self._quotes.get(code)
            return q.model_copy() if q else None

    def get_all_quotes(self) -> tuple[int, dict[str, QuoteState]]:
        """取得目前所有快照"""
        with self._lock:
            return self._server_version, {k: v.model_copy() for k, v in self._quotes.items()}

    def get_server_version(self) -> int:
        with self._lock:
            return self._server_version

quote_store = QuoteStore()
