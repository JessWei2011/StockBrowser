import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from backend.app.services.shioaji_adapter import ShioajiAdapter


@pytest.mark.asyncio
async def test_order_deal_callback_broadcast():
    adapter = ShioajiAdapter()
    adapter.api = MagicMock()
    adapter.is_logged_in = True
    adapter.contracts_cache = {"3661": {"name": "世芯-KY"}}

    mock_publisher = MagicMock()
    mock_publisher.broadcast_order_deal = AsyncMock()

    deal_event = {
        "code": "3661",
        "action": "Buy",
        "price": 3580.0,
        "quantity": 10,
        "order_lot": "IntradayOdd",
        "trade_id": "T12345",
        "ordno": "X0H5T",
        "seqno": "001",
        "ts": 1764039300.0,
    }

    with patch("backend.app.services.publisher.publisher", mock_publisher):
        # 1. 觸發成交事件
        adapter._handle_deal_event(deal_event)

        # 2. 驗證重複事件不重複觸發 (Deduplication)
        adapter._handle_deal_event(deal_event)

    # 驗證 deal_key 存在於已通知集合
    deal_key = "T12345_X0H5T_001_3661_10_3580.0"
    assert deal_key in adapter._notified_deal_keys


@pytest.mark.asyncio
async def test_publisher_broadcast_order_deal_schema():
    from backend.app.services.publisher import BatchPublisher
    pub = BatchPublisher()
    mock_ws = AsyncMock()
    await pub.register(mock_ws)

    deal_data = {
        "code": "2454",
        "name": "聯發科",
        "action": "Sell",
        "price": 3650.0,
        "quantity": 30,
        "orderLot": "IntradayOdd",
        "unit": "股",
        "time": "10:36:50",
        "ordno": "X0G89",
    }

    await pub.broadcast_order_deal(deal_data)

    assert mock_ws.send_text.called
    call_arg = mock_ws.send_text.call_args[0][0]
    import json
    msg = json.loads(call_arg)
    assert msg["type"] == "order_deal"
    assert msg["data"]["code"] == "2454"
    assert msg["data"]["name"] == "聯發科"
    assert msg["data"]["action"] == "Sell"
    assert msg["data"]["price"] == 3650.0
    assert msg["data"]["quantity"] == 30
