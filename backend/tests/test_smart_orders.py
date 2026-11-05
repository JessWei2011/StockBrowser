import pytest
from httpx import AsyncClient, ASGITransport
from backend.app.main import app
from backend.app.repositories.db import init_db

@pytest.mark.asyncio
async def test_smart_order_4_options():
    await init_db()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 建立 4 個選項皆致能的警報條件
        req_body = {
            "code": "2330",
            "quantity": 450,
            "opt1_enabled": True,
            "opt1_pct": 5.0,
            "opt1_price": 2500.0,
            "opt2_enabled": True,
            "opt2_pct": -3.0,
            "opt2_price": 2300.0,
            "opt3_enabled": True,
            "opt3_pct": 6.0,
            "opt3_price": 2520.0,
            "opt3_trailing_pct": 0.5,
            "opt4_enabled": True,
            "opt4_ma_type": "5MA"
        }
        res = await client.post("/api/v1/smart-orders", json=req_body)
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["code"] == "2330"
        assert data["quantity"] == 450
        assert data["opt1_enabled"] is True
        assert data["opt1_pct"] == 5.0
        assert data["opt4_enabled"] is True
        assert data["opt4_ma_type"] == "5MA"
        order_id = data["id"]

        # 查詢列表
        list_res = await client.get("/api/v1/smart-orders")
        assert list_res.status_code == 200
        orders = list_res.json()
        found = next(o for o in orders if o["id"] == order_id)
        assert found["opt3_trailing_pct"] == 0.5

        # 清除測試單
        await client.delete(f"/api/v1/smart-orders/{order_id}")
