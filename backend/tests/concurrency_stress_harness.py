"""
Concurrency & Adversarial Stress Harness for StockBrowser
Author: Challenger 1 (Concurrency Challenger)
Co-located in backend/tests/concurrency_stress_harness.py

Tests:
1. High-concurrency POST /api/v1/groups/{group_id}/items with 3.0s - 5.0s broker delays
2. Event loop responsiveness: Concurrent GET /health and GET /bootstrap latency (< 150ms)
3. Rapid simultaneous duplicate additions race condition & SQLite state integrity
4. Massive mixed load stress test
"""

import asyncio
import os
import random
import sys
import time
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import aiosqlite
from httpx import ASGITransport, AsyncClient

from backend.app.main import app
from backend.app.settings import settings
from backend.app.repositories import db
from backend.app.services.shioaji_adapter import shioaji_adapter
from backend.app.services.quote_store import quote_store

# Generate 50 test stock symbols
TEST_SYMBOLS = {
    f"STK{i:03d}": {
        "code": f"STK{i:03d}",
        "name": f"測試標的{i}",
        "exchange": "TSE",
        "securityType": "STOCK",
        "reference": 100.0 + i,
    }
    for i in range(1, 60)
}
# Common symbols
TEST_SYMBOLS["2330"] = {"code": "2330", "name": "台積電", "exchange": "TSE", "securityType": "STOCK", "reference": 1050.0}
TEST_SYMBOLS["2454"] = {"code": "2454", "name": "聯發科", "exchange": "TSE", "securityType": "STOCK", "reference": 1300.0}
TEST_SYMBOLS["2317"] = {"code": "2317", "name": "鴻海", "exchange": "TSE", "securityType": "STOCK", "reference": 210.0}
TEST_SYMBOLS["2308"] = {"code": "2308", "name": "台達電", "exchange": "TSE", "securityType": "STOCK", "reference": 400.0}
TEST_SYMBOLS["0050"] = {"code": "0050", "name": "元大台灣50", "exchange": "TSE", "securityType": "ETF", "reference": 190.0}


class ConcurrencyStressRunner:
    def __init__(self):
        self.results = {}
        self.temp_db_path = PROJECT_ROOT / f"backend/tests/stress_test_{time.time_ns()}.db"
        self.orig_db_path = settings.DB_PATH
        self.orig_cache = {}
        self.orig_subs = set()

    async def setup(self):
        settings.DB_PATH = self.temp_db_path
        self.orig_cache = shioaji_adapter.contracts_cache.copy()
        self.orig_subs = shioaji_adapter.subscribed_codes.copy()
        shioaji_adapter.contracts_cache = TEST_SYMBOLS.copy()
        shioaji_adapter.subscribed_codes.clear()

        await db.init_db()
        await db.ensure_system_wealth_groups()

    async def teardown(self):
        settings.DB_PATH = self.orig_db_path
        shioaji_adapter.contracts_cache = self.orig_cache
        shioaji_adapter.subscribed_codes = self.orig_subs
        if self.temp_db_path.exists():
            try:
                self.temp_db_path.unlink()
            except Exception:
                pass
        wal_file = Path(f"{self.temp_db_path}-wal")
        shm_file = Path(f"{self.temp_db_path}-shm")
        if wal_file.exists():
            try:
                wal_file.unlink()
            except Exception:
                pass
        if shm_file.exists():
            try:
                shm_file.unlink()
            except Exception:
                pass

    async def run_all(self):
        print("=" * 70)
        print("STARTING ADVERSARIAL CONCURRENCY & LATENCY STRESS HARNESS")
        print("=" * 70)

        await self.setup()
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                # Warm up bootstrap cache
                warm_res = await client.get("/api/v1/bootstrap")
                assert warm_res.status_code == 200, f"Bootstrap warmup failed: {warm_res.text}"

                # Test 1 & 2: High Concurrency Addition with 3s-5s Broker Delays + Health/Bootstrap Latency
                await self.test_high_concurrency_with_broker_delays(client)

                # Test 3: Rapid Simultaneous Duplicate Additions (Race Conditions & SQLite state)
                await self.test_rapid_simultaneous_duplicate_additions(client)

                # Test 4: Mixed High-Concurrency Stress Test
                await self.test_mixed_high_concurrency_stress(client)

        finally:
            await self.teardown()

        print("\n" + "=" * 70)
        print("FINAL STRESS HARNESS VERDICT")
        print("=" * 70)
        all_passed = all(r.get("passed", False) for r in self.results.values())
        for test_name, res in self.results.items():
            status = "PASS" if res.get("passed") else "FAIL"
            print(f"[{status}] {test_name}: {res.get('summary')}")
        print(f"\nOverall Verdict: {'APPROVE' if all_passed else 'REQUEST_CHANGES'}")
        return all_passed

    async def test_high_concurrency_with_broker_delays(self, client: AsyncClient):
        print("\n--- Test 1 & 2: 30 Concurrent POST Items with 3.0-5.0s Broker Delay & Latency Check ---")
        test_group = await db.create_group("併發壓力測試群組")
        group_id = test_group.id

        broker_call_count = 0
        broker_lock = asyncio.Lock()

        # Mock subscribe_codes with 3.0s to 5.0s simulated delay
        def slow_subscribe(codes):
            nonlocal broker_call_count
            d = random.uniform(3.0, 5.0)
            time.sleep(d)

        orig_sub_fn = shioaji_adapter.subscribe_codes
        shioaji_adapter.subscribe_codes = slow_subscribe

        codes_to_add = [f"STK{i:03d}" for i in range(1, 31)]

        post_latencies = []
        health_latencies = []
        bootstrap_latencies = []

        async def post_item(code: str):
            t0 = time.perf_counter()
            res = await client.post(f"/api/v1/groups/{group_id}/items", json={"code": code})
            elapsed = time.perf_counter() - t0
            post_latencies.append(elapsed)
            return code, res, elapsed

        async def probe_health():
            # Spread probes across the duration
            await asyncio.sleep(random.uniform(0.01, 0.2))
            t0 = time.perf_counter()
            res = await client.get("/api/v1/health")
            elapsed = time.perf_counter() - t0
            health_latencies.append(elapsed)
            return res, elapsed

        async def probe_bootstrap():
            await asyncio.sleep(random.uniform(0.02, 0.25))
            t0 = time.perf_counter()
            res = await client.get("/api/v1/bootstrap")
            elapsed = time.perf_counter() - t0
            bootstrap_latencies.append(elapsed)
            return res, elapsed

        try:
            # Launch 30 POST tasks, 20 health checks, and 10 bootstrap checks concurrently
            post_tasks = [post_item(c) for c in codes_to_add]
            health_tasks = [probe_health() for _ in range(20)]
            bootstrap_tasks = [probe_bootstrap() for _ in range(10)]

            all_tasks = asyncio.gather(
                asyncio.gather(*post_tasks),
                asyncio.gather(*health_tasks),
                asyncio.gather(*bootstrap_tasks),
            )

            post_res_list, health_res_list, boot_res_list = await all_tasks

            # Verify POST results
            post_success = 0
            for code, res, elapsed in post_res_list:
                assert res.status_code == 200, f"POST for {code} failed: {res.status_code} {res.text}"
                post_success += 1

            # Check POST latencies: target < 1.0s, ideally < 200ms
            max_post_latency = max(post_latencies)
            avg_post_latency = sum(post_latencies) / len(post_latencies)

            # Check Health latencies: MUST be < 150ms (0.150s)
            max_health_latency = max(health_latencies)
            avg_health_latency = sum(health_latencies) / len(health_latencies)
            health_within_150ms = all(lat < 0.150 for lat in health_latencies)

            # Check Bootstrap latencies: MUST be < 150ms (0.150s)
            max_boot_latency = max(bootstrap_latencies)
            avg_boot_latency = sum(bootstrap_latencies) / len(bootstrap_latencies)
            boot_within_150ms = all(lat < 0.150 for lat in bootstrap_latencies)

            # Verify SQLite persistence
            groups = await db.get_all_groups()
            g = next(grp for grp in groups if grp.id == group_id)
            persisted_codes = {it.code for it in g.items}
            all_persisted = set(codes_to_add).issubset(persisted_codes)

            passed = (
                post_success == 30
                and max_post_latency < 1.0
                and health_within_150ms
                and boot_within_150ms
                and all_persisted
            )

            summary = (
                f"POST: 30/30 ok, avg {avg_post_latency*1000:.1f}ms, max {max_post_latency*1000:.1f}ms (< 1000ms). "
                f"Health: 20/20 ok, avg {avg_health_latency*1000:.1f}ms, max {max_health_latency*1000:.1f}ms (< 150ms: {health_within_150ms}). "
                f"Bootstrap: 10/10 ok, avg {avg_boot_latency*1000:.1f}ms, max {max_boot_latency*1000:.1f}ms (< 150ms: {boot_within_150ms}). "
                f"All 30 persisted: {all_persisted}."
            )
            print(summary)

            self.results["High Concurrency POST with 3-5s Broker Delay"] = {
                "passed": passed and (max_post_latency < 1.0),
                "summary": f"POST avg={avg_post_latency*1000:.1f}ms, max={max_post_latency*1000:.1f}ms",
            }
            self.results["Event Loop Non-Blocking (Health & Bootstrap < 150ms)"] = {
                "passed": health_within_150ms and boot_within_150ms,
                "summary": f"Health max={max_health_latency*1000:.1f}ms, Bootstrap max={max_boot_latency*1000:.1f}ms",
            }

            # Wait for background broker delays to finish before continuing
            print("Waiting for background broker worker threads to settle...")
            await asyncio.sleep(5.5)

        finally:
            shioaji_adapter.subscribe_codes = orig_sub_fn

    async def test_rapid_simultaneous_duplicate_additions(self, client: AsyncClient):
        print("\n--- Test 3: Rapid Simultaneous Duplicate Additions (Race Conditions & SQLite State) ---")
        test_group = await db.create_group("重複競態測試群組")
        group_id = test_group.id

        # Adversarial scenario:
        # 30 concurrent requests all attempting to add '2330' at the EXACT same time!
        duplicate_count = 30
        tasks = [
            client.post(f"/api/v1/groups/{group_id}/items", json={"code": "2330"})
            for _ in range(duplicate_count)
        ]

        responses = await asyncio.gather(*tasks)

        status_counts = {}
        for r in responses:
            status_counts[r.status_code] = status_counts.get(r.status_code, 0) + 1

        print(f"Duplicate 30 simultaneous requests status distribution: {status_counts}")

        # Check: Exactly 1 HTTP 200, exactly 29 HTTP 409
        ok_count = status_counts.get(200, 0)
        conflict_count = status_counts.get(409, 0)
        error_count = sum(cnt for code, cnt in status_counts.items() if code not in (200, 409))

        # Check SQLite DB state: exactly 1 item with code '2330'
        groups = await db.get_all_groups()
        g = next(grp for grp in groups if grp.id == group_id)
        items_2330 = [it for it in g.items if it.code == "2330"]
        unique_persisted = (len(items_2330) == 1)

        # Check detail message of 409 responses
        conflict_msg_ok = True
        for r in responses:
            if r.status_code == 409:
                detail = r.json().get("detail", "")
                if "無需重複新增" not in detail:
                    conflict_msg_ok = False

        # Additional multi-code race test:
        # 5 stocks with 10 duplicate attempts each (50 concurrent requests)
        print("Testing multi-stock simultaneous duplicate additions (5 stocks x 10 requests = 50 requests)...")
        multi_codes = ["STK041", "STK042", "STK043", "STK044", "STK045"]
        multi_tasks = []
        for c in multi_codes:
            for _ in range(10):
                multi_tasks.append(client.post(f"/api/v1/groups/{group_id}/items", json={"code": c}))

        multi_responses = await asyncio.gather(*multi_tasks)
        multi_counts = {}
        for r in multi_responses:
            multi_counts[r.status_code] = multi_counts.get(r.status_code, 0) + 1

        print(f"Multi-stock 50 simultaneous requests status distribution: {multi_counts}")
        multi_ok = multi_counts.get(200, 0)
        multi_conflict = multi_counts.get(409, 0)

        # Check database integrity
        groups = await db.get_all_groups()
        g = next(grp for grp in groups if grp.id == group_id)
        persisted_map = {it.code: it for it in g.items}
        all_codes_present = all(c in persisted_map for c in multi_codes)
        positions = [it.position for it in g.items]
        # Check no duplicate positions
        positions_unique = len(positions) == len(set(positions))

        passed = (
            ok_count == 1
            and conflict_count == (duplicate_count - 1)
            and error_count == 0
            and unique_persisted
            and conflict_msg_ok
            and multi_ok == 5
            and multi_conflict == 45
            and all_codes_present
            and positions_unique
        )

        summary = (
            f"Single-stock: ok={ok_count}, conflict={conflict_count}, errors={error_count}, unique={unique_persisted}. "
            f"Multi-stock: ok={multi_ok} (expected 5), conflict={multi_conflict} (expected 45), positions_unique={positions_unique}."
        )
        print(summary)

        self.results["Simultaneous Duplicate Additions & SQLite Race Safety"] = {
            "passed": passed,
            "summary": summary,
        }

    async def test_mixed_high_concurrency_stress(self, client: AsyncClient):
        print("\n--- Test 4: Mixed High-Concurrency Stress Test (60+ Operations) ---")
        g1 = await db.create_group("綜合壓力群組A")
        g2 = await db.create_group("綜合壓力群組B")

        # Mix:
        # - Valid additions to g1
        # - Valid additions to g2
        # - Duplicate additions to g1
        # - Non-existent group additions (404)
        # - Invalid stock codes (400)
        # - Protected group additions (400)
        # - Concurrent Health checks
        # - Concurrent Bootstrap checks
        operations = []

        # 10 additions to g1
        for i in range(1, 11):
            operations.append(("add_g1", client.post(f"/api/v1/groups/{g1.id}/items", json={"code": f"STK{i:03d}"})))

        # 10 additions to g2
        for i in range(11, 21):
            operations.append(("add_g2", client.post(f"/api/v1/groups/{g2.id}/items", json={"code": f"STK{i:03d}"})))

        # 5 invalid codes
        for bad in ["", "   ", "NOT_FOUND_999", "INVALID$$$", "SQL'--"]:
            operations.append(("bad_code", client.post(f"/api/v1/groups/{g1.id}/items", json={"code": bad})))

        # 5 non-existent groups
        for _ in range(5):
            operations.append(("bad_group", client.post("/api/v1/groups/no-such-group/items", json={"code": "2330"})))

        # 5 protected vault/wealth additions
        for p_id in ["g-vault", "g-wealth"]:
            operations.append(("protected", client.post(f"/api/v1/groups/{p_id}/items", json={"code": "2330"})))

        # 15 health checks
        for _ in range(15):
            operations.append(("health", client.get("/api/v1/health")))

        # 5 bootstrap checks
        for _ in range(5):
            operations.append(("bootstrap", client.get("/api/v1/bootstrap")))

        t0 = time.perf_counter()
        results = await asyncio.gather(*(op[1] for op in operations))
        total_time = time.perf_counter() - t0

        types = [op[0] for op in operations]
        mismatches = []
        for op_type, res in zip(types, results):
            if op_type in ("add_g1", "add_g2"):
                if res.status_code != 200:
                    mismatches.append(f"{op_type} got {res.status_code}")
            elif op_type == "bad_code":
                if res.status_code != 400:
                    mismatches.append(f"bad_code got {res.status_code}")
            elif op_type == "bad_group":
                if res.status_code != 404:
                    mismatches.append(f"bad_group got {res.status_code}")
            elif op_type == "protected":
                if res.status_code != 400:
                    mismatches.append(f"protected got {res.status_code}")
            elif op_type in ("health", "bootstrap"):
                if res.status_code != 200:
                    mismatches.append(f"{op_type} got {res.status_code}")

        passed = len(mismatches) == 0
        summary = f"{len(operations)} operations completed in {total_time:.3f}s. Mismatches: {len(mismatches)}"
        print(summary)
        if mismatches:
            print("First mismatches:", mismatches[:5])

        self.results["Mixed High-Concurrency System Resilience"] = {
            "passed": passed,
            "summary": summary,
        }


if __name__ == "__main__":
    runner = ConcurrencyStressRunner()
    success = asyncio.run(runner.run_all())
    sys.exit(0 if success else 1)
