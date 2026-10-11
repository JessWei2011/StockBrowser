import threading
from datetime import datetime, timezone
from typing import Optional
from backend.app.domain.models import QuoteState, DataStatus

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

class QuoteStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._quotes: dict[str, QuoteState] = {}
        self._dirty_codes: set[str] = set()
        self._server_version: int = 0

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
                    dispositionPeriod=disposition_period
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
        bid: Optional[float] = None,
        ask: Optional[float] = None,
        open_price: Optional[float] = None,
        high: Optional[float] = None,
        low: Optional[float] = None,
        total_volume: Optional[int] = None,
        previous_close: Optional[float] = None,
        source_ts: Optional[str] = None,
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
                    revision=0
                )
                self._quotes[code] = current

            # 檢查 source_ts 防回溯
            if source_ts and current.sourceTs and source_ts < current.sourceTs:
                return False

            changed = False

            if name is not None and name != current.name:
                current.name = name
                changed = True
            if exchange is not None and exchange != current.exchange:
                current.exchange = exchange
                changed = True
            if security_type is not None and security_type != current.securityType:
                current.securityType = security_type
                changed = True

            if previous_close is not None and previous_close != current.previousClose:
                current.previousClose = previous_close
                changed = True

            if last is not None and last != current.last:
                current.last = last
                changed = True

            if bid is not None and bid != current.bid:
                current.bid = bid
                changed = True

            if ask is not None and ask != current.ask:
                current.ask = ask
                changed = True

            if open_price is not None and open_price != current.open:
                current.open = open_price
                changed = True

            if high is not None and high != current.high:
                current.high = high
                changed = True

            if low is not None and low != current.low:
                current.low = low
                changed = True

            if total_volume is not None and total_volume != current.totalVolume:
                current.totalVolume = total_volume
                changed = True

            if data_status is not None and data_status != current.dataStatus:
                current.dataStatus = data_status
                changed = True

            # 計算漲跌與漲幅
            if current.last is not None and current.previousClose is not None and current.previousClose > 0:
                new_chg = round(current.last - current.previousClose, 2)
                new_pct = round((new_chg / current.previousClose) * 100, 2)
                if new_chg != current.change:
                    current.change = new_chg
                    changed = True
                if new_pct != current.changePercent:
                    current.changePercent = new_pct
                    changed = True

            if source_ts is not None and source_ts != current.sourceTs:
                current.sourceTs = source_ts
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

    def get_all_quotes(self) -> tuple[int, dict[str, QuoteState]]:
        """取得目前所有快照"""
        with self._lock:
            return self._server_version, {k: v.model_copy() for k, v in self._quotes.items()}

    def get_server_version(self) -> int:
        with self._lock:
            return self._server_version

quote_store = QuoteStore()
