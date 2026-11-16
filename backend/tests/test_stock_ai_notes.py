import pytest
from httpx import AsyncClient, ASGITransport
from backend.app.main import app

@pytest.mark.asyncio
async def test_stock_ai_notes_crud():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        # 1. 取得已快取的個股 AI 筆記 (2383 台光電)
        resp = await ac.get("/api/v1/stocks/2383/ai-note")
        assert resp.status_code == 200
        data = resp.json()
        assert data["code"] == "2383"
        assert "台光電" in data["name"] or "無鹵素" in data["business"] or "CCL" in data["business"]
        assert "business" in data
        assert "customers" in data
        assert "ai_relation" in data

        # 2. 測試手動編輯自訂筆記
        update_payload = {
            "business": "全球高階CCL銅箔基板龍頭，主攻M8/M9/M10材料。",
            "customers": "廣達、緯穎、鴻海、美超微等伺服器ODM及北美四大CSP。",
            "ai_relation": "獨家或主力供應GB200/B200等AI GPU加速卡與高階交換機超低損耗基板。",
            "name": "台光電"
        }
        put_resp = await ac.put("/api/v1/stocks/2383/ai-note", json=update_payload)
        assert put_resp.status_code == 200
        updated_data = put_resp.json()
        assert updated_data["business"] == update_payload["business"]
        assert updated_data["customers"] == update_payload["customers"]
        assert updated_data["ai_relation"] == update_payload["ai_relation"]

        # 3. 測試批次取得所有筆記清單
        list_resp = await ac.get("/api/v1/stocks/ai-notes")
        assert list_resp.status_code == 200
        all_notes = list_resp.json()
        assert "2383" in all_notes
        assert all_notes["2383"]["business"] == update_payload["business"]
