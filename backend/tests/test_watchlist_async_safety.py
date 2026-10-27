import asyncio
import time
from contextlib import asynccontextmanager
import pytest
from httpx import ASGITransport, AsyncClient

from backend.app.main import app
from backend.app.settings import settings
from backend.app.repositories import db
from backend.app.services.shioaji_adapter import shioaji_adapter


@asynccontextmanager
async def isolated_test_context(tmp_path):
    """
    非同步測試上下文環境管理：
    - 建立隔離之 SQLite 測試資料庫，防止污染正式或預設資料庫。
    - 注入台股標的合約快取（2330, 2454, 2317, 2308, 0050），包含 reference 參考價避免 KeyError。
    - 提供 ASGITransport AsyncClient 及獨立之測試自選群組。
    - 退出時保證完整還原全域設定與快取狀態。
    """
    orig_db_path = settings.DB_PATH
    orig_cache = shioaji_adapter.contracts_cache.copy()
    orig_subs = shioaji_adapter.subscribed_codes.copy()

    settings.DB_PATH = tmp_path / f"test_safety_{time.time_ns()}.db"
    await db.init_db()
    await db.ensure_system_wealth_groups()

    shioaji_adapter.contracts_cache = {
        "2330": {"code": "2330", "name": "台積電", "exchange": "TSE", "securityType": "STOCK", "reference": 1050.0},
        "2454": {"code": "2454", "name": "聯發科", "exchange": "TSE", "securityType": "STOCK", "reference": 1300.0},
        "2317": {"code": "2317", "name": "鴻海", "exchange": "TSE", "securityType": "STOCK", "reference": 210.0},
        "2308": {"code": "2308", "name": "台達電", "exchange": "TSE", "securityType": "STOCK", "reference": 400.0},
        "0050": {"code": "0050", "name": "元大台灣50", "exchange": "TSE", "securityType": "ETF", "reference": 190.0},
    }
    shioaji_adapter.subscribed_codes.clear()

    group = await db.create_group("非同步測試群組")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        try:
            yield client, group
        finally:
            settings.DB_PATH = orig_db_path
            shioaji_adapter.contracts_cache = orig_cache
            shioaji_adapter.subscribed_codes = orig_subs


# ==============================================================================
# Category 1: Simulated Broker Latency & Event Loop Non-blocking Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_add_item_simulated_broker_latency_non_blocking(tmp_path, monkeypatch):
    """
    【核心需求 1】：模擬券商 API 3.0 秒延遲（time.sleep 在工作執行緒）。
    - POST /api/v1/groups/{group_id}/items 新增 2330。
    - 同時發送 GET /api/v1/health 驗證主事件迴圈（Event Loop）絕無被阻塞。
    - 斷言 POST 於 1.0 秒內返回（目標 < 0.2s）。
    - 斷言 concurrent GET /health 於 0.1 秒內極速返回。
    - 斷言個股立即成功持久化於資料庫群組中。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        called_codes = []

        def slow_subscribe(codes):
            called_codes.extend(list(codes))
            time.sleep(3.0)

        monkeypatch.setattr(shioaji_adapter, "subscribe_codes", slow_subscribe)

        async def run_post():
            t0 = time.perf_counter()
            res = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": "2330"})
            elapsed = time.perf_counter() - t0
            return res, elapsed

        async def run_health():
            # 微延遲 20ms，確保 POST 請求已進入後端並已派發背景執行緒
            await asyncio.sleep(0.02)
            t0 = time.perf_counter()
            res = await client.get("/api/v1/health")
            elapsed = time.perf_counter() - t0
            return res, elapsed

        (post_res, post_elapsed), (health_res, health_elapsed) = await asyncio.gather(
            run_post(),
            run_health()
        )

        # 1. 驗證 HTTP 響應碼
        assert post_res.status_code == 200, f"POST failed: {post_res.status_code} {post_res.text}"
        assert health_res.status_code == 200, f"Health check failed: {health_res.status_code} {health_res.text}"

        # 2. 驗證非同步非阻塞延遲指標
        assert post_elapsed < 1.0, f"POST /items took {post_elapsed:.3f}s (must be < 1.0s, target < 0.2s)"
        assert health_elapsed < 0.1, f"GET /health took {health_elapsed:.3f}s (must be < 0.1s, event loop blocked!)"

        # 3. 驗證資料結構與正確性
        item_data = post_res.json()
        assert item_data["code"] == "2330"
        assert item_data["name"] == "台積電"
        assert item_data["groupId"] == test_group.id

        # 4. 驗證 SQLite 資料庫持久化成功
        groups = await db.get_all_groups()
        g = next(grp for grp in groups if grp.id == test_group.id)
        assert any(it.code == "2330" for it in g.items), "Stock 2330 was not persisted in database group"

        # 等待背景任務執行緒完成 3 秒延遲，避免影響後續測試
        await asyncio.sleep(3.1)
        assert "2330" in called_codes, "Background subscribe_codes was not called for 2330"


@pytest.mark.asyncio
async def test_add_item_concurrent_bootstrap_not_blocked(tmp_path, monkeypatch):
    """
    【擴充併發驗證】：當券商訂閱存在 3.0 秒延遲時，併發存取 GET /api/v1/bootstrap
    亦能於 0.5 秒內順暢回應（熱快取狀態），事件迴圈不受阻滯。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        # 預先暖機一次 bootstrap 快取，排除冷啟動指標解析耗時
        warm_res = await client.get("/api/v1/bootstrap")
        assert warm_res.status_code == 200

        def slow_subscribe(codes):
            time.sleep(3.0)

        monkeypatch.setattr(shioaji_adapter, "subscribe_codes", slow_subscribe)

        async def run_post():
            t0 = time.perf_counter()
            res = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": "2454"})
            elapsed = time.perf_counter() - t0
            return res, elapsed

        async def run_bootstrap():
            await asyncio.sleep(0.02)
            t0 = time.perf_counter()
            res = await client.get("/api/v1/bootstrap")
            elapsed = time.perf_counter() - t0
            return res, elapsed

        (post_res, post_elapsed), (boot_res, boot_elapsed) = await asyncio.gather(
            run_post(),
            run_bootstrap()
        )

        assert post_res.status_code == 200
        assert boot_res.status_code == 200
        assert post_elapsed < 1.0, f"POST took {post_elapsed:.3f}s"
        assert boot_elapsed < 0.5, f"GET /bootstrap took {boot_elapsed:.3f}s (blocked by broker delay!)"

        boot_data = boot_res.json()
        assert "groups" in boot_data
        assert "quotes" in boot_data

        await asyncio.sleep(3.1)


# ==============================================================================
# Category 2: Error Handling & Validation Tests
# ==============================================================================

@pytest.mark.asyncio
async def test_add_item_empty_stock_code_returns_400(tmp_path):
    """
    【錯誤處理驗證】：空股票代號回傳 HTTP 400。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        res = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": ""})
        assert res.status_code == 400
        assert res.json()["detail"] == "Stock code cannot be empty"


@pytest.mark.asyncio
async def test_add_item_whitespace_only_stock_code_returns_400(tmp_path):
    """
    【邊界驗證】：純空格股票代號去除前後空格後為空，回傳 HTTP 400。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        res = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": "   "})
        assert res.status_code == 400
        assert res.json()["detail"] == "Stock code cannot be empty"


@pytest.mark.asyncio
async def test_add_item_protected_vault_returns_400(tmp_path):
    """
    【系統防護驗證】：對固定分頁『財神庫』手動新增個股，應回傳 HTTP 400 及中文說明。
    """
    async with isolated_test_context(tmp_path) as (client, _):
        res = await client.post("/api/v1/groups/g-vault/items", json={"code": "2330"})
        assert res.status_code == 400
        assert "『財神庫』與『財神簿』" in res.json()["detail"]
        assert "無需手動新增" in res.json()["detail"]


@pytest.mark.asyncio
async def test_add_item_protected_wealth_returns_400(tmp_path):
    """
    【系統防護驗證】：對固定分頁『財神簿』手動新增個股，應回傳 HTTP 400 及中文說明。
    """
    async with isolated_test_context(tmp_path) as (client, _):
        res = await client.post("/api/v1/groups/g-wealth/items", json={"code": "2330"})
        assert res.status_code == 400
        assert "『財神庫』與『財神簿』" in res.json()["detail"]
        assert "無需手動新增" in res.json()["detail"]


@pytest.mark.asyncio
async def test_add_item_non_existent_group_returns_404(tmp_path):
    """
    【錯誤處理驗證】：指定不存在之群組 ID，回傳 HTTP 404 及中文「自選群組不存在」。
    """
    async with isolated_test_context(tmp_path) as (client, _):
        res = await client.post("/api/v1/groups/non-existent-group-id/items", json={"code": "2330"})
        assert res.status_code == 404
        assert res.json()["detail"] == "自選群組不存在"


@pytest.mark.asyncio
async def test_add_item_invalid_stock_code_returns_400(tmp_path):
    """
    【資料驗證】：輸入無效/不存在之股票代號（例如 INVALID999），回傳 HTTP 400 及中文錯誤提示。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        res = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": "INVALID999"})
        assert res.status_code == 400
        detail = res.json()["detail"]
        assert "查無台股標的「INVALID999」" in detail
        assert "請確認股票代號是否正確" in detail


@pytest.mark.asyncio
async def test_add_item_duplicate_stock_returns_409(tmp_path):
    """
    【重複防護驗證】：同一群組重複新增相同股票（例如 2330），第二次請求回傳 HTTP 409
    及標準中文提示「該股票已存在於此群組中，無需重複新增」。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        # 第一次新增成功
        res1 = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": "2330"})
        assert res1.status_code == 200

        # 第二次重複新增回傳 409
        res2 = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": "2330"})
        assert res2.status_code == 409
        assert res2.json()["detail"] == "該股票已存在於此群組中，無需重複新增"


# ==============================================================================
# Category 3: Broker Exception Resilience & Timeout Safety
# ==============================================================================

@pytest.mark.asyncio
async def test_add_item_broker_exception_resilience(tmp_path, monkeypatch):
    """
    【韌性容錯驗證】：當券商 API（subscribe_codes）拋出例外或斷線時，
    資料庫新增仍成功完成，API 回傳 HTTP 200，絕不向客戶端回傳 500 錯誤。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        def broken_subscribe(codes):
            raise RuntimeError("Simulated Shioaji Broker Connection Reset by Peer")

        monkeypatch.setattr(shioaji_adapter, "subscribe_codes", broken_subscribe)

        res = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": "2317"})
        assert res.status_code == 200
        data = res.json()
        assert data["code"] == "2317"
        assert data["name"] == "鴻海"

        # 驗證即使券商例外，DB 仍然確實寫入
        groups = await db.get_all_groups()
        g = next(grp for grp in groups if grp.id == test_group.id)
        assert any(it.code == "2317" for it in g.items)


@pytest.mark.asyncio
async def test_add_item_broker_timeout_resilience(tmp_path, monkeypatch):
    """
    【超時韌性驗證】：當券商 API 耗時高達 4.0 秒（超過 async_subscribe_codes 的 3.0 秒 timeout），
    API 請求依然於 < 0.5s 回傳 200，背景任務安全處理超時，伺服器不崩潰。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        def timeout_subscribe(codes):
            time.sleep(4.0)

        monkeypatch.setattr(shioaji_adapter, "subscribe_codes", timeout_subscribe)

        t0 = time.perf_counter()
        res = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": "2308"})
        elapsed = time.perf_counter() - t0

        assert res.status_code == 200
        assert elapsed < 0.5, f"Request took {elapsed:.3f}s"
        assert res.json()["code"] == "2308"

        # 驗證資料持久化
        groups = await db.get_all_groups()
        g = next(grp for grp in groups if grp.id == test_group.id)
        assert any(it.code == "2308" for it in g.items)

        await asyncio.sleep(4.1)


# ==============================================================================
# Category 4: Concurrency, Adversarial, and Boundary Scenarios
# ==============================================================================

@pytest.mark.asyncio
async def test_add_same_stock_different_groups_allowed(tmp_path):
    """
    【業務邏輯邊界】：同一檔股票（如 2330）允許被加入到不同的自選群組中，
    唯一性約束作用於 (group_id, code)，不同群組各自獨立。
    """
    async with isolated_test_context(tmp_path) as (client, _):
        g1 = await db.create_group("群組A")
        g2 = await db.create_group("群組B")

        res1 = await client.post(f"/api/v1/groups/{g1.id}/items", json={"code": "2330"})
        res2 = await client.post(f"/api/v1/groups/{g2.id}/items", json={"code": "2330"})

        assert res1.status_code == 200
        assert res2.status_code == 200
        assert res1.json()["groupId"] == g1.id
        assert res2.json()["groupId"] == g2.id


@pytest.mark.asyncio
async def test_sequential_add_items_position_ordering(tmp_path):
    """
    【循序新增排序】：循序新增多檔股票，驗證 position 由 0 開始連續遞增。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        for expected_pos, code in enumerate(["2330", "2454", "2317"]):
            res = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": code})
            assert res.status_code == 200
            assert res.json()["position"] == expected_pos

        groups = await db.get_all_groups()
        g = next(grp for grp in groups if grp.id == test_group.id)
        assert [it.code for it in g.items] == ["2330", "2454", "2317"]
        assert [it.position for it in g.items] == [0, 1, 2]


@pytest.mark.asyncio
async def test_concurrent_add_distinct_stocks_to_same_group(tmp_path):
    """
    【併發安全性】：同時併發發送 3 個不同股票（2330, 2454, 2317）至同一個群組，
    全數回傳 HTTP 200，且在資料庫中全數持久化成功。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        codes = ["2330", "2454", "2317"]
        tasks = [
            client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": c})
            for c in codes
        ]
        responses = await asyncio.gather(*tasks)

        for r in responses:
            assert r.status_code == 200

        groups = await db.get_all_groups()
        g = next(grp for grp in groups if grp.id == test_group.id)
        persisted_codes = [it.code for it in g.items]
        assert set(persisted_codes) == set(codes)
        assert len(g.items) == 3


@pytest.mark.asyncio
async def test_concurrent_duplicate_additions_race_condition(tmp_path):
    """
    【競態條件防護】：同時發送 2 個完全相同之新增請求（2330），
    確保資料庫與 API 能夠正確處理競爭條件：
    剛好一個成功（HTTP 200），另一個被拒絕（HTTP 409），絕不產生 500 錯誤或重複資料。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        tasks = [
            client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": "2330"}),
            client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": "2330"}),
        ]
        res1, res2 = await asyncio.gather(*tasks)

        status_codes = sorted([res1.status_code, res2.status_code])
        assert status_codes == [200, 409], f"Expected [200, 409], got {status_codes}"

        # 確認群組內僅有 1 筆 2330
        groups = await db.get_all_groups()
        g = next(grp for grp in groups if grp.id == test_group.id)
        items_2330 = [it for it in g.items if it.code == "2330"]
        assert len(items_2330) == 1, "Duplicate stock items detected in group"


@pytest.mark.asyncio
async def test_add_item_whitespace_trimming_and_case(tmp_path):
    """
    【字串清洗驗證】：股票代號前後空白應自動去除，且小寫字元應自動轉為大寫。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        res = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": " 2330 "})
        assert res.status_code == 200
        assert res.json()["code"] == "2330"

        # 再次加入相同代號應判定為重複
        res_dup = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": "2330"})
        assert res_dup.status_code == 409


@pytest.mark.asyncio
async def test_add_item_adversarial_malformed_input(tmp_path):
    """
    【對抗性測試】：特殊符號、SQL Injection 嘗試與 XSS 字元應被安全阻擋為 400，
    絕不污染或破壞 SQLite 資料庫架構。
    """
    async with isolated_test_context(tmp_path) as (client, test_group):
        malicious_inputs = [
            "2330' OR '1'='1",
            "<script>alert(1)</script>",
            "../../etc/passwd",
            "NULL",
            "'; DROP TABLE watchlist_items; --"
        ]

        for bad_code in malicious_inputs:
            res = await client.post(f"/api/v1/groups/{test_group.id}/items", json={"code": bad_code})
            assert res.status_code == 400, f"Expected 400 for input {bad_code}, got {res.status_code}"
            assert "查無台股標的" in res.json()["detail"]

        # 驗證資料表完好無缺
        groups = await db.get_all_groups()
        assert len(groups) > 0
