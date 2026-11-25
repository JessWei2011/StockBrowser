import pytest
from datetime import datetime, timedelta
from unittest.mock import MagicMock
from backend.app.services.shioaji_adapter import ShioajiAdapter, get_market_order_cutoff


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


def test_clear_orders_retains_active_and_filled_orders():
    """測試手動按鈕僅清除已取消單，當日已成交單與進行中掛單皆完整保留"""
    adapter = ShioajiAdapter()
    adapter.api = MagicMock()
    adapter.is_logged_in = True
    adapter.stock_account = MagicMock()

    # Setup 3 trades:
    # 1. Filled order (當日已成交) -> 手動清空按鈕不清除，完整保留
    # 2. Cancelled order (已取消/失敗) -> 手動清空按鈕會清除
    # 3. Submitted order (進行中掛單，active_qty=1000) -> 完整保留
    trade_filled = MockTrade("ord_filled", "2330", "Buy", 1000, "Filled", deal_qty=1000)
    trade_cancelled = MockTrade("ord_cancelled", "2317", "Buy", 1000, "Cancelled", cancel_qty=1000)
    trade_active = MockTrade("ord_active", "2454", "Buy", 1000, "Submitted", deal_qty=0, cancel_qty=0)

    adapter.api.list_trades.return_value = [trade_filled, trade_cancelled, trade_active]

    # Before clear: all 3 orders returned
    orders_before = adapter.fetch_orders()
    assert len(orders_before) == 3
    order_ids_before = {o["id"] for o in orders_before}
    assert order_ids_before == {"ord_filled", "ord_cancelled", "ord_active"}

    # Execute clear_orders(): 僅清除已取消單 (ord_cancelled)
    res = adapter.clear_orders()
    assert res["success"] is True
    assert res["clearedCount"] == 1
    assert "已清空" in res["message"]
    assert "已保留" in res["message"]

    # After clear: Cancelled is cleared, Filled and Active orders are RETAINED!
    orders_after = adapter.fetch_orders()
    assert len(orders_after) == 2
    order_ids_after = {o["id"] for o in orders_after}
    assert order_ids_after == {"ord_filled", "ord_active"}

    # If the active order later gets filled in market:
    trade_active.status.status = "Filled"
    trade_active.status.deal_quantity = 1000
    orders_after_fill = adapter.fetch_orders()
    assert len(orders_after_fill) == 2
    active_now_filled = next(o for o in orders_after_fill if o["id"] == "ord_active")
    assert active_now_filled["status"] == "Filled"

    # User clicks clear_orders again: both filled orders remain intact, nothing newly cleared
    res2 = adapter.clear_orders()
    assert res2["clearedCount"] == 0
    orders_final = adapter.fetch_orders()
    assert len(orders_final) == 2
    assert {o["id"] for o in orders_final} == {"ord_filled", "ord_active"}


def test_market_order_cutoff_logic():
    """測試每日 08:25 開盤前自動清除前一日成交單，且盤後、夜間、清晨與週末皆保留"""
    # 1. 週三 10:30 (盤中) -> 截止點為週三 08:25
    wed_intraday = datetime(2026, 11, 25, 10, 30)
    assert get_market_order_cutoff(wed_intraday) == datetime(2026, 11, 25, 8, 25)

    # 2. 週三 15:30 (收盤後) -> 截止點仍為週三 08:25 (當日成交單不被隱藏，可看當日成交結果)
    wed_afternoon = datetime(2026, 11, 25, 15, 30)
    assert get_market_order_cutoff(wed_afternoon) == datetime(2026, 11, 25, 8, 25)

    # 3. 週三 22:00 (夜間複盤) -> 截止點仍為週三 08:25
    wed_night = datetime(2026, 11, 25, 22, 0)
    assert get_market_order_cutoff(wed_night) == datetime(2026, 11, 25, 8, 25)

    # 4. 週四 07:30 (清晨開盤前) -> 截止點仍為週三 08:25 (開盤前可複盤昨日成交單)
    thu_early = datetime(2026, 11, 26, 7, 30)
    assert get_market_order_cutoff(thu_early) == datetime(2026, 11, 25, 8, 25)

    # 5. 週四 08:25 (開盤前同步界線) -> 截止點切換為週四 08:25 (前日成交單自動清空)
    thu_open = datetime(2026, 11, 26, 8, 25)
    assert get_market_order_cutoff(thu_open) == datetime(2026, 11, 26, 8, 25)

    # 6. 週六 14:00 (週末) -> 截止點為週五 08:25 (保留週五成交結果)
    sat_afternoon = datetime(2026, 11, 28, 14, 0)
    assert get_market_order_cutoff(sat_afternoon) == datetime(2026, 11, 27, 8, 25)

    # 7. 週日 20:00 (週末夜間) -> 截止點為週五 08:25
    sun_night = datetime(2026, 11, 29, 20, 0)
    assert get_market_order_cutoff(sun_night) == datetime(2026, 11, 27, 8, 25)

    # 8. 週一 07:00 (週一開盤前) -> 截止點為週五 08:25 (保留週五成交結果)
    mon_early = datetime(2026, 11, 30, 7, 0)
    assert get_market_order_cutoff(mon_early) == datetime(2026, 11, 27, 8, 25)

    # 9. 週一 08:25 (週一開盤) -> 截止點切換為週一 08:25 (週五成交單自動清空)
    mon_open = datetime(2026, 11, 30, 8, 25)
    assert get_market_order_cutoff(mon_open) == datetime(2026, 11, 30, 8, 25)
