import asyncio
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

from backend.app.repositories.db import (
    get_smart_orders,
    trigger_smart_order,
    update_smart_order_peak_price,
)
from backend.app.services.publisher import publisher
from backend.app.services.quote_store import quote_store
from backend.app.services.shioaji_adapter import is_taiwan_market_open
from backend.app.services.stock_chart_service import get_stock_ma_summary

logger = logging.getLogger("smart_order_service")


def _resolve_target_price(
    price_val: Optional[float],
    pct_val: Optional[float],
    prev_close: Optional[float],
    is_down: bool = False,
) -> Optional[float]:
    if price_val is not None and float(price_val) > 0:
        return float(price_val)
    if pct_val is not None and prev_close is not None and prev_close > 0:
        pct = float(pct_val)
        if is_down:
            return round(prev_close * (1.0 - abs(pct) / 100.0), 2)
        return round(prev_close * (1.0 + pct / 100.0), 2)
    return None


def _compute_intraday_ma(ma_type: str, current_price: float, ma_summary: Optional[dict]) -> Optional[float]:
    if not ma_summary or current_price <= 0:
        return None
    recent = ma_summary.get("recentCloses") or []
    mt = (ma_type or "5MA").upper()
    if mt == "5MA":
        if len(recent) >= 4:
            return round((sum(recent[-4:]) + current_price) / 5.0, 2)
        return ma_summary.get("ma5")
    if mt == "10MA":
        if len(recent) >= 9:
            return round((sum(recent[-9:]) + current_price) / 10.0, 2)
        return ma_summary.get("ma10")
    if mt == "20MA":
        if len(recent) >= 19:
            return round((sum(recent[-19:]) + current_price) / 20.0, 2)
        return ma_summary.get("ma20")
    return None


def evaluate_smart_order(
    order: dict,
    current_price: float,
    prev_close: Optional[float] = None,
    ma_summary: Optional[dict] = None,
) -> tuple[bool, Optional[str], Optional[str], Optional[float]]:
    """
    評估單筆智慧預約單是否符合 4 大觸發條件之一。
    回傳: (triggered, opt_type, trigger_reason, new_peak_price)
    """
    if current_price is None or current_price <= 0:
        return False, None, None, None

    new_peak: Optional[float] = None

    # 選項 3：衝高回落追蹤 (先更新或檢查高點，確保突破門檻後能記錄 peak_price)
    if order.get("opt3_enabled"):
        activate_target = _resolve_target_price(
            order.get("opt3_price"), order.get("opt3_pct"), prev_close, is_down=False
        )
        trailing_pct = float(order.get("opt3_trailing_pct") or 0.5)
        peak = order.get("peak_price")

        if peak is None:
            if activate_target is not None and current_price >= activate_target:
                new_peak = current_price
        else:
            peak_f = float(peak)
            if current_price > peak_f:
                new_peak = current_price
            else:
                drawback_limit = peak_f * (1.0 - trailing_pct / 100.0)
                if current_price <= drawback_limit:
                    reason = f"高點 ${peak_f:.2f} 回落 {trailing_pct:.1f}% 至 ${current_price:.2f}"
                    return True, "opt3", reason, peak_f

    # 選項 1：現價高於 N% 或 M 元
    if order.get("opt1_enabled"):
        target = _resolve_target_price(
            order.get("opt1_price"), order.get("opt1_pct"), prev_close, is_down=False
        )
        if target is not None and current_price >= target:
            reason = f"現價 ${current_price:.2f} 突破高價門檻 ${target:.2f}"
            return True, "opt1", reason, new_peak

    # 選項 2：現價低於 N% 或 M 元
    if order.get("opt2_enabled"):
        target = _resolve_target_price(
            order.get("opt2_price"), order.get("opt2_pct"), prev_close, is_down=True
        )
        if target is not None and current_price <= target:
            reason = f"現價 ${current_price:.2f} 跌破防守門檻 ${target:.2f}"
            return True, "opt2", reason, new_peak

    # 選項 4：現價跌破均線 (5MA / 10MA / 20MA)
    if order.get("opt4_enabled"):
        ma_type = (order.get("opt4_ma_type") or "5MA").upper()
        ma_val = _compute_intraday_ma(ma_type, current_price, ma_summary)
        if ma_val is not None and ma_val > 0 and current_price < ma_val:
            reason = f"現價 ${current_price:.2f} 跌破 {ma_type} (${ma_val:.2f})"
            return True, "opt4", reason, new_peak

    return False, None, None, new_peak


class SmartOrderService:
    def __init__(self):
        self._running = False
        self._task: Optional[asyncio.Task] = None

    async def start(self):
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("SmartOrderService background monitor started.")

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("SmartOrderService stopped.")

    async def process_order_tick(
        self,
        order: dict,
        current_price: float,
        prev_close: Optional[float] = None,
        stock_name: Optional[str] = None,
        ma_summary: Optional[dict] = None,
    ) -> dict:
        triggered, opt_type, reason, new_peak = evaluate_smart_order(
            order, current_price, prev_close=prev_close, ma_summary=ma_summary
        )

        if not triggered:
            if new_peak is not None:
                await update_smart_order_peak_price(order["id"], new_peak)
            return {"triggered": False, "peak_price": new_peak}

        ok = await trigger_smart_order(order["id"], reason or "條件已達標", peak_price=new_peak)
        if not ok:
            return {"triggered": False, "peak_price": new_peak}

        tw_time = datetime.now(timezone(timedelta(hours=8))).strftime("%H:%M:%S")
        alert_payload = {
            "orderId": order["id"],
            "code": order["code"],
            "name": stock_name or order.get("name") or order["code"],
            "quantity": int(order.get("quantity") or 100),
            "price": round(float(current_price), 2),
            "triggerReason": reason or "條件已達標",
            "optType": opt_type,
            "time": tw_time,
        }
        logger.info(f"Smart order triggered, broadcasting toast: {alert_payload}")
        await publisher.broadcast_smart_order_triggered(alert_payload)
        return {"triggered": True, "alert": alert_payload}

    async def _loop(self):
        while self._running:
            try:
                await asyncio.sleep(1.0)
                if not is_taiwan_market_open():
                    continue

                pending_orders = await get_smart_orders(status="PENDING")
                if not pending_orders:
                    continue

                for order in pending_orders:
                    code = order.get("code")
                    if not code:
                        continue
                    q = quote_store.get_quote(code)
                    if not q or not q.last or q.last <= 0:
                        continue

                    ma_summary = None
                    if order.get("opt4_enabled"):
                        ma_summary = await asyncio.to_thread(get_stock_ma_summary, code)

                    await self.process_order_tick(
                        order=order,
                        current_price=float(q.last),
                        prev_close=float(q.previousClose) if q.previousClose else None,
                        stock_name=q.name or order.get("name"),
                        ma_summary=ma_summary,
                    )
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in SmartOrderService loop: {e}", exc_info=True)


smart_order_service = SmartOrderService()
