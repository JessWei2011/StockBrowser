import pytest
from datetime import datetime
from unittest.mock import MagicMock
from backend.app.services.shioaji_adapter import ShioajiAdapter


class MockTrade:
    def __init__(self, order_id, code, action, qty, status, deal_qty=0, cancel_qty=0, order_dt=None):
        self.order = MagicMock()
        self.order.id = order_id
        self.order.code = code
        self.order.action = action
        self.order.quantity = qty
        self.order.price = 100.0
        self.order.price_type = "LMT"
        self.order.order_lot = "Common"
        self.order.ordno = "00001"

        self.contract = MagicMock()
        self.contract.code = code

        self.status = MagicMock()
        self.status.status = status
        self.status.deal_quantity = deal_qty
        self.status.cancel_quantity = cancel_qty
        self.status.order_datetime = order_dt or datetime.now()
        self.status.modified_price = 0.0
        self.status.status_code = ""
        self.status.msg = ""


def test_clear_orders_retains_active_orders():
    adapter = ShioajiAdapter()
    adapter.api = MagicMock()
    adapter.is_logged_in = True
    adapter.stock_account = MagicMock()

    # Setup 3 trades:
    # 1. Filled order (already executed) -> should be cleared
    # 2. Cancelled order (user cancelled) -> should be cleared
    # 3. Submitted order (pending in market, active_qty=1000) -> MUST BE RETAINED!
    trade_filled = MockTrade("ord_filled", "2330", "Buy", 1000, "Filled", deal_qty=1000)
    trade_cancelled = MockTrade("ord_cancelled", "2317", "Buy", 1000, "Cancelled", cancel_qty=1000)
    trade_active = MockTrade("ord_active", "2454", "Buy", 1000, "Submitted", deal_qty=0, cancel_qty=0)

    adapter.api.list_trades.return_value = [trade_filled, trade_cancelled, trade_active]

    # Before clear: all 3 orders returned
    orders_before = adapter.fetch_orders()
    assert len(orders_before) == 3
    order_ids_before = {o["id"] for o in orders_before}
    assert order_ids_before == {"ord_filled", "ord_cancelled", "ord_active"}

    # Execute clear_orders()
    res = adapter.clear_orders()
    assert res["success"] is True
    assert res["clearedCount"] == 2
    assert "今日委託單紀錄已清空" in res["message"]

    # After clear: Filled & Cancelled orders are cleared, Active order is RETAINED!
    orders_after = adapter.fetch_orders()
    assert len(orders_after) == 1
    assert orders_after[0]["id"] == "ord_active"
    assert orders_after[0]["canCancel"] is True
    assert orders_after[0]["qty"] == 1000

    # If the active order later gets filled in market:
    trade_active.status.status = "Filled"
    trade_active.status.deal_quantity = 1000
    orders_after_fill = adapter.fetch_orders()
    # It was not cleared before, so user sees it as Filled!
    assert len(orders_after_fill) == 1
    assert orders_after_fill[0]["id"] == "ord_active"
    assert orders_after_fill[0]["status"] == "Filled"

    # User clicks clear_orders again: now ord_active is cleared as well
    res2 = adapter.clear_orders()
    assert res2["clearedCount"] == 1
    orders_final = adapter.fetch_orders()
    assert len(orders_final) == 0
