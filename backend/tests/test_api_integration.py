import pytest
from httpx import ASGITransport, AsyncClient
from backend.app.main import app
from backend.app.repositories import db

@pytest.mark.asyncio
async def test_api_health():
    await db.init_db()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get("/api/v1/health")
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ok"
        assert "serverVersion" in data
        assert "shioaji" in data

@pytest.mark.asyncio
async def test_api_bootstrap_and_spa():
    await db.init_db()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 測試 Bootstrap
        res = await client.get("/api/v1/bootstrap")
        assert res.status_code == 200
        data = res.json()
        assert "groups" in data
        assert "quotes" in data
        assert "serverVersion" in data
        assert len(data["groups"]) > 0

        # 測試首頁靜態網頁載入
        spa_res = await client.get("/")
        assert spa_res.status_code == 200
        assert "<div id=\"root\"></div>" in spa_res.text or "vite" in spa_res.text.lower()
