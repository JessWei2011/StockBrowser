import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime
from unittest.mock import MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import backend.app.repositories.db as db_mod
from backend.app.services.shioaji_adapter import ShioajiAdapter


class TestPocketLedgerAndSettlements(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmp_dir = tempfile.TemporaryDirectory()
        self._orig_db_path = db_mod.settings.DB_PATH
        db_mod.settings.DB_PATH = Path(self._tmp_dir.name) / "test_pocket.db"
        await db_mod.init_db()

    async def asyncTearDown(self):
        db_mod.settings.DB_PATH = self._orig_db_path
        self._tmp_dir.cleanup()

    async def test_rollover_and_multi_day_skip(self):
        # Day 1 (2026-11-23): 設定本金 100 萬 (T+0 扣款後)
        await db_mod.set_pocket_initial_capital(100.0, "after_t0", "2026-11-23")

        # Day 1 有兩筆未來交割：T+1 (11-24: 0), T+2 (11-25: -30萬)
        res1 = await db_mod.sync_and_rollover_pocket_settlements(
            "2026-11-23",
            [
                {"t": 0, "date": "2026-11-23", "amount": -50000.0, "stockSummary": "舊單"},
                {"t": 1, "date": "2026-11-24", "amount": 0.0, "stockSummary": ""},
                {"t": 2, "date": "2026-11-25", "amount": -300000.0, "stockSummary": "買入 台積電"},
            ],
        )
        # 11-23 因選 after_t0 已標為 SETTLED，所以 settledCashTwd 維持 100 萬
        self.assertEqual(res1["settledCashTwd"], 1000000.0)
        self.assertTrue(res1["todaySettled"])

        # Day 2 (2026-11-24): 買入 20萬 (11-26 交割，含多檔買賣明細)
        sample_details = [
            {"code": "2454", "name": "聯發科", "action": "Buy", "qty": 200, "price": 1200.0, "totalPrice": 240000.0, "fee": 342, "tax": 0, "netAmount": -240342.0, "netAmountWan": -24.0342},
            {"code": "2330", "name": "台積電", "action": "Sell", "qty": 40, "price": 1010.0, "totalPrice": 40400.0, "fee": 57, "tax": 121, "netAmount": 40222.0, "netAmountWan": 4.0222},
        ]
        res2 = await db_mod.sync_and_rollover_pocket_settlements(
            "2026-11-24",
            [
                {"t": 0, "date": "2026-11-24", "amount": 0.0, "stockSummary": ""},
                {"t": 1, "date": "2026-11-25", "amount": -300000.0, "stockSummary": "買入 台積電"},
                {"t": 2, "date": "2026-11-26", "amount": -200000.0, "stockSummary": "買入 聯發科 等 2 檔", "details": sample_details},
            ],
        )
        self.assertEqual(res2["settledCashTwd"], 1000000.0)
        self.assertFalse(res2["todaySettled"])

        # 假設 11-25、11-26 兩天都沒開 App，直到 11-27 才打開！
        # 11-25 (-30萬) 與 11-26 (-20萬) 都應該被自動結轉扣除，現金剩 50 萬
        res_skip = await db_mod.sync_and_rollover_pocket_settlements(
            "2026-11-27",
            [
                {"t": 0, "date": "2026-11-27", "amount": 0.0, "stockSummary": ""},
                {"t": 1, "date": "2026-11-30", "amount": 0.0, "stockSummary": ""},
                {"t": 2, "date": "2026-12-01", "amount": 0.0, "stockSummary": ""},
            ],
        )
        self.assertEqual(res_skip["settledCashTwd"], 500000.0)
        # 應有兩筆 SETTLEMENT 紀錄 + 一筆 INIT，且 11-26 該筆保留完整 2 檔買賣明細
        settlement_entries = [x for x in res_skip["ledger"] if x["event_type"] == "SETTLEMENT"]
        self.assertEqual(len(settlement_entries), 2)
        nov26 = [x for x in settlement_entries if x["settlement_date"] == "2026-11-26"][0]
        self.assertEqual(len(nov26["details"]), 2)
        self.assertEqual(nov26["details"][0]["code"], "2454")
        self.assertEqual(nov26["details"][1]["action"], "Sell")

    async def test_adjust_pocket_capital(self):
        await db_mod.set_pocket_initial_capital(80.0, "after_t0", "2026-11-25")
        adj = await db_mod.adjust_pocket_capital(-10.0, "生活費")
        self.assertEqual(adj["balanceAfterWan"], 70.0)
        adj2 = await db_mod.adjust_pocket_capital(5.0, "獎金存入")
        self.assertEqual(adj2["balanceAfterWan"], 75.0)

    async def test_intraday_deal_recording_and_dedup(self):
        # 模擬盤中即時收到零股買入成交回報 (真實零股價 3580 元，10 股)
        await db_mod.record_intraday_deal_event(
            trade_date="2026-11-25",
            deal_uid="2026-11-25_ev_k1",
            ordno="A001",
            code="3661",
            name="世芯-KY",
            action="Buy",
            qty=10,
            price=3580.0,
            total_price=35800.0,
            fee=51,
            tax=0,
            net_amount=-35851.0,
        )
        # 另一筆整股賣出成交回報
        await db_mod.record_intraday_deal_event(
            trade_date="2026-11-25",
            deal_uid="2026-11-25_ev_k2",
            ordno="A002",
            code="00935",
            name="野村臺灣新科技50",
            action="Sell",
            qty=1000,
            price=44.15,
            total_price=44150.0,
            fee=62,
            tax=44,
            net_amount=44044.0,
        )
        # 模擬 list_trades() 同步 A001 的完整匯總，應取代同 ordno 的 deal_event 而不重複計算
        await db_mod.sync_today_trades_snapshot(
            "2026-11-25",
            [
                {
                    "ordno": "A001",
                    "code": "3661",
                    "name": "世芯-KY",
                    "action": "Buy",
                    "qty": 10,
                    "price": 3580.0,
                    "totalPrice": 35800.0,
                    "fee": 51,
                    "tax": 0,
                    "netAmount": -35851.0,
                }
            ],
        )
        grouped = await db_mod.get_recorded_deals_by_date(days=5)
        self.assertIn("2026-11-25", grouped)
        deals = grouped["2026-11-25"]
        self.assertEqual(len(deals), 2)
        self.assertEqual(deals[0]["price"], 3580.0)
        self.assertEqual(deals[1]["netAmount"], 44044.0)


class TestShioajiPocketCalculations(unittest.TestCase):
    def test_intraday_t2_fallback_and_pending_buy_orders(self):
        adapter = ShioajiAdapter()
        adapter.is_logged_in = True
        adapter.contracts_cache = {
            "2330": {"name": "台積電", "securityType": "STOCK"},
            "2881B": {"name": "富邦金乙特", "securityType": "STOCK"},
        }

        now_dt = datetime.now()
        # 1 張台積電買入成交 (Common -> 1000 股 @ 1000元 = 1,000,000, fee = 1425)
        filled_buy = SimpleNamespace(
            contract=SimpleNamespace(code="2330"),
            order=SimpleNamespace(id="o1", action="Buy", order_lot="Common", quantity=1, price=1000.0),
            status=SimpleNamespace(
                status="Filled",
                deal_quantity=1,
                cancel_quantity=0,
                modified_price=0.0,
                order_datetime=now_dt,
                deals=[SimpleNamespace(price=1000.0, quantity=1)],
            ),
        )
        # 100 股富邦金乙特掛單中買進 (IntradayOdd -> 100 股 @ 60元 = 6000, fee = 8)
        pending_buy = SimpleNamespace(
            contract=SimpleNamespace(code="2881B"),
            order=SimpleNamespace(id="o2", action="Buy", order_lot="IntradayOdd", quantity=100, price=60.0),
            status=SimpleNamespace(
                status="Submitted",
                deal_quantity=0,
                cancel_quantity=0,
                modified_price=0.0,
                order_datetime=now_dt,
                deals=[],
            ),
        )

        mock_api = MagicMock()
        mock_api.stock_account = MagicMock()
        mock_api.list_trades.return_value = [filled_buy, pending_buy]
        # 模擬盤中券商 T=2 尚未結算回傳 0
        mock_api.settlements.return_value = [
            SimpleNamespace(T=0, date="2026-11-25", amount=0.0),
            SimpleNamespace(T=1, date="2026-11-26", amount=0.0),
            SimpleNamespace(T=2, date="2026-11-27", amount=0.0),
        ]
        mock_api.list_positions.return_value = []
        adapter.api = mock_api

        settlements = adapter.fetch_settlements()
        t2 = [s for s in settlements if s["t"] == 2][0]
        # 1,000,000 + 1,425 = -1,001,425
        self.assertEqual(t2["amount"], -1001425.0)
        self.assertEqual(len(t2["details"]), 1)
        self.assertEqual(t2["details"][0]["qty"], 1000)

        pending = adapter.fetch_pending_buy_orders()
        # 100 * 60 + max(1, int(6000 * 0.001425)) = 6000 + 8 = 6008
        self.assertEqual(pending["totalAmountTwd"], 6008.0)
        self.assertEqual(len(pending["details"]), 1)
        self.assertEqual(pending["details"][0]["qty"], 100)


if __name__ == "__main__":
    unittest.main()
