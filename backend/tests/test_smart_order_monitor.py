import pytest
from unittest.mock import AsyncMock, patch
from httpx import AsyncClient, ASGITransport

from backend.app.main import app
from backend.app.repositories.db import init_db, get_smart_orders
from backend.app.services.smart_order_service import evaluate_smart_order


def test_evaluate_opt1_high_price():
    order = {
        "id": "so-test-1",
        "code": "2330",
        "opt1_enabled": True,
        "opt1_price": 1050.0,
    }
    triggered, opt, reason, _ = evaluate_smart_order(order, 1045.0)
    assert triggered is False

    triggered, opt, reason, _ = evaluate_smart_order(order, 1050.0)
    assert triggered is True
    assert opt == "opt1"
    assert "突破高價門檻" in (reason or "")


def test_evaluate_opt2_low_price():
    order = {
        "id": "so-test-2",
        "code": "2330",
        "opt2_enabled": True,
        "opt2_price": 980.0,
    }
    triggered, opt, reason, _ = evaluate_smart_order(order, 985.0)
    assert triggered is False

    triggered, opt, reason, _ = evaluate_smart_order(order, 980.0)
    assert triggered is True
    assert opt == "opt2"
    assert "跌破防守門檻" in (reason or "")


def test_evaluate_opt3_trailing_high_and_pullback():
    order = {
        "id": "so-test-3",
        "code": "2330",
        "opt3_enabled": True,
        "opt3_price": 1000.0,
        "opt3_trailing_pct": 1.0,
        "peak_price": None,
    }
    # 1. 尚未達啟動門檻 1000
    triggered, _, _, new_peak = evaluate_smart_order(order, 995.0)
    assert triggered is False
    assert new_peak is None

    # 2. 突破啟動門檻 1000 -> 開始記錄最高價 peak_price
    triggered, _, _, new_peak = evaluate_smart_order(order, 1005.0)
    assert triggered is False
    assert new_peak == 1005.0
    order["peak_price"] = new_peak

    # 3. 繼續創高至 1020 -> 更新 peak_price
    triggered, _, _, new_peak = evaluate_smart_order(order, 1020.0)
    assert triggered is False
    assert new_peak == 1020.0
    order["peak_price"] = new_peak

    # 4. 小幅拉回至 1015 (回落 ~0.49% < 1.0%) -> 不觸發
    triggered, _, _, _ = evaluate_smart_order(order, 1015.0)
    assert triggered is False

    # 5. 回落 1.0% (1020 * 0.99 = 1009.8) -> 觸發停利通知
    triggered, opt, reason, peak = evaluate_smart_order(order, 1009.5)
    assert triggered is True
    assert opt == "opt3"
    assert peak == 1020.0
    assert "回落 1.0%" in (reason or "")


def test_evaluate_opt4_ma_breakdown():
    order = {
        "id": "so-test-4",
        "code": "2330",
        "opt4_enabled": True,
        "opt4_ma_type": "5MA",
    }
    # 前 4 日收盤皆為 100 -> 若現價 100，5MA=100 (未跌破)；若現價 95，5MA=(400+95)/5=99 (95 < 99 跌破)
    ma_summary = {"recentCloses": [100.0, 100.0, 100.0, 100.0], "ma5": 100.0}

    triggered, _, _, _ = evaluate_smart_order(order, 100.0, ma_summary=ma_summary)
    assert triggered is False

    triggered, opt, reason, _ = evaluate_smart_order(order, 95.0, ma_summary=ma_summary)
    assert triggered is True
    assert opt == "opt4"
    assert "跌破 5MA" in (reason or "")


@pytest.mark.asyncio
async def test_simulate_smart_order_end_to_end():
    await init_db()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. 建立一筆測試智慧單 (代碼 9999 避免影響真實持股)
        create_res = await client.post("/api/v1/smart-orders", json={
            "code": "9999",
            "quantity": 123,
            "opt1_enabled": True,
            "opt1_pct": 5.0,
            "opt1_price": 500.0,
            "opt2_enabled": False,
            "opt3_enabled": False,
            "opt4_enabled": False,
        })
        assert create_res.status_code == 200, create_res.text
        order_id = create_res.json()["id"]

        try:
            with patch(
                "backend.app.services.publisher.publisher.broadcast_smart_order_triggered",
                new_callable=AsyncMock,
            ) as mock_broadcast:
                # 2. 模擬未達標價格 (490 < 500)
                sim_miss = await client.post("/api/v1/smart-orders/simulate", json={
                    "order_id": order_id,
                    "price": 490.0,
                })
                assert sim_miss.status_code == 200
                assert sim_miss.json()["triggered"] is False
                mock_broadcast.assert_not_called()

                # 3. 模擬達標價格 (505 >= 500) -> 應觸發並廣播 Toast
                sim_hit = await client.post("/api/v1/smart-orders/simulate", json={
                    "order_id": order_id,
                    "price": 505.0,
                })
                assert sim_hit.status_code == 200
                hit_data = sim_hit.json()
                assert hit_data["triggered"] is True
                assert hit_data["alert"]["orderId"] == order_id
                assert hit_data["alert"]["code"] == "9999"
                assert hit_data["alert"]["quantity"] == 123
                assert hit_data["alert"]["price"] == 505.0

                mock_broadcast.assert_awaited_once()
                broadcast_payload = mock_broadcast.call_args[0][0]
                assert broadcast_payload["orderId"] == order_id

                # 4. 確認資料庫狀態已更新為 TRIGGERED
                orders = await get_smart_orders()
                updated = next(o for o in orders if o["id"] == order_id)
                assert updated["status"] == "TRIGGERED"
                assert updated["trigger_reason"] is not None
                assert updated["triggered_at"] is not None
        finally:
            await client.delete(f"/api/v1/smart-orders/{order_id}")
