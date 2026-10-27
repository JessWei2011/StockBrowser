import asyncio
import time
import logging
from backend.app.repositories import db
from backend.app.repositories.db import _LoopBoundLock
from backend.app.services.quote_store import quote_store
from backend.app.services.shioaji_adapter import shioaji_adapter, is_taiwan_market_open
from backend.app.services.market_calendar_service import evaluate_tw_market_status
from backend.app.services.publisher import publisher

logger = logging.getLogger("watchlist_service")

class WatchlistService:
    def __init__(self):
        self.wealth_summary: dict = {
            "totalPnl": 0.0,
            "totalCost": 0.0,
            "totalMarketValue": 0.0,
            "returnPercent": 0.0,
        }
        self._sync_task: asyncio.Task | None = None
        self._sync_dirty: bool = False
        self._sync_lock = _LoopBoundLock()
        self._last_wealth_sync_ts: float = 0.0

    async def sync_wealth_book(self, force: bool = False):
        """從永豐 API 索取真實持股清單，並自動同步至固定分頁『財神庫』與『財神簿』"""
        now_ts = time.time()
        if not force and (now_ts - self._last_wealth_sync_ts < 20.0):
            return
        self._last_wealth_sync_ts = now_ts
        v_id, w_id = await db.ensure_system_wealth_groups()
        position_codes, summary = await shioaji_adapter.async_fetch_stock_positions(timeout=3.0)
        if summary:
            self.wealth_summary = summary

        if position_codes or shioaji_adapter.is_logged_in:
            # 正常連線下：以真實 API 回傳為準 (若全部賣光則為空清單，清空資料庫持股)
            await db.save_stock_positions(shioaji_adapter.stock_positions_detail)
        else:
            # 離線或重啟且尚未連線時，嘗試從 DB 載入快取的持股
            cached_positions = await db.load_stock_positions()
            if cached_positions:
                shioaji_adapter.stock_positions_detail = cached_positions
                position_codes = [p["code"] for p in cached_positions]

        items_data = []
        for code in position_codes:
            info = shioaji_adapter.contracts_cache.get(code)
            name = info["name"] if info else code
            exchange = info["exchange"] if info else "TSE"
            sec_type = info["securityType"] if info else "STOCK"
            items_data.append((code, name, exchange, sec_type))

        await db.sync_group_items(v_id, items_data)
        await db.sync_group_items(w_id, items_data)
        logger.info(f"Successfully synced {len(items_data)} positions to 財神庫 and 財神簿.")

    async def sync_subscriptions(self):
        """讀取資料庫中所有群組的股票聯集，並向 Shioaji 增量同步訂閱（序列化防重入）"""
        async with self._sync_lock:
            wanted_codes = await db.get_all_subscribed_codes()
            current_subscribed = set(shioaji_adapter.subscribed_codes)
            
            to_add = wanted_codes - current_subscribed
            to_remove = current_subscribed - wanted_codes
            
            if to_add:
                logger.info(f"Subscribing to new codes: {to_add}")
                await shioaji_adapter.async_subscribe_codes(to_add, timeout=3.0)
                
            if to_remove:
                logger.info(f"Unsubscribing from obsolete codes: {to_remove}")
                await shioaji_adapter.async_unsubscribe_codes(to_remove, timeout=3.0)

    def _trigger_sync(self):
        """觸發背景訂閱同步；若已有同步正在執行，則標記 dirty，待目前同步完成後自動執行一次 trailing sync"""
        self._sync_dirty = True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return

        if self._sync_task is None or self._sync_task.done() or self._sync_task.get_loop() != loop:
            self._sync_task = loop.create_task(self._coalesced_sync_worker())

    async def _coalesced_sync_worker(self):
        """Coalescing 背景合併同步常式：確保同一時間最多僅一個同步在執行，並於完成後自動補跑 trailing sync"""
        try:
            while self._sync_dirty:
                self._sync_dirty = False
                try:
                    await self.sync_subscriptions()
                except Exception as e:
                    logger.warning(f"Background subscription failed: {e}")
        finally:
            self._sync_task = None

    async def _safe_sync_subscriptions(self):
        """保留方法簽名相容舊有非同步呼叫，觸發合併同步機制"""
        self._trigger_sync()
        try:
            loop = asyncio.get_running_loop()
            if self._sync_task and self._sync_task.get_loop() == loop:
                await asyncio.shield(self._sync_task)
        except RuntimeError:
            pass

    async def get_bootstrap_data(self) -> dict:
        from backend.app.services.announcement_service import announcement_service
        from backend.app.services.stock_chart_service import get_multiple_stocks_ma_summary
        
        # 每次前端載入 / 重新整理時，皆向永豐 API 索取最新持股動態，若有賣出持股立刻同步更新
        try:
            await self.sync_wealth_book()
        except Exception as e:
            logger.warning(f"Error syncing wealth book in bootstrap: {e}")

        groups = await db.get_all_groups()
        server_ver, all_quotes = quote_store.get_all_quotes()
        all_codes = list({it.code for g in groups for it in g.items})
        indicators = await asyncio.to_thread(get_multiple_stocks_ma_summary, all_codes)
        return {
            "groups": [g.model_dump() for g in groups],
            "quotes": {k: v.model_dump() for k, v in all_quotes.items()},
            "announcements": announcement_service.get_all_announcements(),
            "wealthSummary": shioaji_adapter.get_live_wealth_summary(),
            "positions": shioaji_adapter.get_positions_detail(),
            "marketIndices": shioaji_adapter.market_indices,
            "indicators": indicators,
            "serverVersion": server_ver,
            "marketCalendar": evaluate_tw_market_status(),
            "upstream": {
                "connected": shioaji_adapter.is_connected,
                "loggedIn": shioaji_adapter.is_logged_in,
                "lastQuoteTime": shioaji_adapter.last_quote_time,
                "subscribedCount": len(shioaji_adapter.subscribed_codes),
                "maxAllowed": 200,
                "isMarketOpen": is_taiwan_market_open(),
                "marketMode": "auto"
            }
        }

    async def create_group(self, name: str):
        g = await db.create_group(name)
        await publisher.broadcast_watchlist_changed()
        return g

    async def update_group(self, group_id: str, name: str | None = None, position: int | None = None):
        await db.update_group(group_id, name, position)
        await publisher.broadcast_watchlist_changed()

    async def reorder_groups(self, group_ids: list[str]):
        await db.reorder_groups(group_ids)

    async def delete_group(self, group_id: str):
        await db.delete_group(group_id)
        self._trigger_sync()
        await publisher.broadcast_watchlist_changed()

    async def add_item(self, group_id: str, code: str):
        code = code.strip().upper()
        # 驗證代號合法性 (若合約快取已建立，且非空)
        if shioaji_adapter.contracts_cache and code not in shioaji_adapter.contracts_cache:
            raise ValueError(f"查無台股標的「{code}」，請確認股票代號是否正確")

        info = shioaji_adapter.contracts_cache.get(code)
        name = info["name"] if info else code
        exchange = info["exchange"] if info else "TSE"
        sec_type = info["securityType"] if info else "STOCK"
        
        item = await db.add_item_to_group(group_id, code, name, exchange, sec_type)
        # 背景非同步執行訂閱同步，確保 DB 持久化與 API 回傳在 < 50ms 完成
        self._trigger_sync()
        await publisher.broadcast_watchlist_changed()
        return item

    async def remove_item(self, group_id: str, code: str):
        await db.remove_item_from_group(group_id, code)
        self._trigger_sync()
        await publisher.broadcast_watchlist_changed()

    async def reorder_items(self, group_id: str, codes: list[str]):
        await db.reorder_items(group_id, codes)
        await publisher.broadcast_watchlist_changed()

watchlist_service = WatchlistService()
