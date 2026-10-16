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

@pytest.mark.asyncio
async def test_vault_and_wealth_protection():
    await db.init_db()
    await db.ensure_system_wealth_groups()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. 驗證 g-vault 與 g-wealth 的順序與屬性
        b_res = await client.get("/api/v1/bootstrap")
        assert b_res.status_code == 200
        groups = b_res.json()["groups"]
        assert len(groups) >= 2
        assert groups[0]["id"] == "g-vault"
        assert groups[0]["name"] == "財神庫"
        assert groups[0]["isSystemGroup"] is True
        assert groups[1]["id"] == "g-wealth"
        assert groups[1]["name"] == "財神簿"
        assert groups[1]["isSystemGroup"] is True

        # 2. 驗證無法更名或移動
        patch_v = await client.patch("/api/v1/groups/g-vault", json={"name": "新名稱"})
        assert patch_v.status_code == 400

        patch_w = await client.patch("/api/v1/groups/g-wealth", json={"name": "新名稱"})
        assert patch_w.status_code == 400

        # 3. 驗證無法刪除
        del_v = await client.delete("/api/v1/groups/g-vault")
        assert del_v.status_code == 400

        del_w = await client.delete("/api/v1/groups/g-wealth")
        assert del_w.status_code == 400

@pytest.mark.asyncio
async def test_orders_and_clear_orders():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 測試取得委託清單
        res = await client.get("/api/v1/orders")
        assert res.status_code == 200
        assert isinstance(res.json(), list)

        # 測試手動清空委託單歷史紀錄
        clear_res = await client.post("/api/v1/orders/clear")
        assert clear_res.status_code == 200
        data = clear_res.json()
        assert data["success"] is True
        assert "今日委託單紀錄已清空" in data["message"]
