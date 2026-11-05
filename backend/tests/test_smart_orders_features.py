import pytest
from httpx import AsyncClient, ASGITransport
from backend.app.main import app
from backend.app.repositories.db import init_db

@pytest.mark.asyncio
async def test_smart_order_duplicate_prevention_and_resume():
    await init_db()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        req_body = {
            "code": "2454",
            "quantity": 51,
            "opt1_enabled": True,
            "opt1_pct": 5.0,
            "opt1_price": 4000.0
        }
        # 1. 建立第一筆
        res1 = await client.post("/api/v1/smart-orders", json=req_body)
        assert res1.status_code == 200, res1.text
        order_id = res1.json()["id"]

        # 2. 測試重複防呆：同一檔股票同選項已在 PENDING 中，應被拒絕
        res_dup = await client.post("/api/v1/smart-orders", json=req_body)
        assert res_dup.status_code == 409
        assert "同選項不可重複設定" in res_dup.json()["detail"]

        # 3. 測試不同選項允許並存：同一檔股票新增「選項 4（均線）」應能成功
        req_opt4 = {
            "code": "2454",
            "quantity": 51,
            "opt4_enabled": True,
            "opt4_ma_type": "5MA"
        }
        res_opt4 = await client.post("/api/v1/smart-orders", json=req_opt4)
        assert res_opt4.status_code == 200, res_opt4.text
        order_id_opt4 = res_opt4.json()["id"]

        # 3. 測試暫停盯盤
        cancel_res = await client.post(f"/api/v1/smart-orders/{order_id}/cancel")
        assert cancel_res.status_code == 200

        # 4. 測試「恢復盯盤」功能
        resume_res = await client.post(f"/api/v1/smart-orders/{order_id}/resume")
        assert resume_res.status_code == 200
        
        # 5. 驗證已恢復 PENDING
        list_res = await client.get("/api/v1/smart-orders")
        found = next(o for o in list_res.json() if o["id"] == order_id)
        assert found["status"] == "PENDING"

        # 清除測試單
        await client.delete(f"/api/v1/smart-orders/{order_id}")
        await client.delete(f"/api/v1/smart-orders/{order_id_opt4}")
