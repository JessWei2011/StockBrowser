import logging
from backend.app.repositories import db
from backend.app.services.quote_store import quote_store
from backend.app.services.shioaji_adapter import shioaji_adapter, is_taiwan_market_open
from backend.app.services.publisher import publisher

logger = logging.getLogger("watchlist_service")

class WatchlistService:
    async def sync_wealth_book(self):
        """從永豐 API 索取真實持股清單，並自動同步至固定第一個分頁『財神簿』"""
        g_id = await db.ensure_wealth_book_group()
        position_codes = shioaji_adapter.fetch_stock_positions()
        if not position_codes:
            logger.info("No stock positions fetched or Shioaji not connected.")
            return

        items_data = []
        for code in position_codes:
            info = shioaji_adapter.contracts_cache.get(code)
            name = info["name"] if info else code
            exchange = info["exchange"] if info else "TSE"
            sec_type = info["securityType"] if info else "STOCK"
            items_data.append((code, name, exchange, sec_type))

        await db.sync_group_items(g_id, items_data)
        logger.info(f"Successfully synced {len(items_data)} positions to 財神簿.")

    async def sync_subscriptions(self):
        """讀取資料庫中所有群組的股票聯集，並向 Shioaji 增量同步訂閱"""
        wanted_codes = await db.get_all_subscribed_codes()
        current_subscribed = set(shioaji_adapter.subscribed_codes)
        
        to_add = wanted_codes - current_subscribed
        to_remove = current_subscribed - wanted_codes
        
        if to_add:
            logger.info(f"Subscribing to new codes: {to_add}")
            shioaji_adapter.subscribe_codes(to_add)
            
        if to_remove:
            logger.info(f"Unsubscribing from obsolete codes: {to_remove}")
            shioaji_adapter.unsubscribe_codes(to_remove)

    async def get_bootstrap_data(self) -> dict:
        groups = await db.get_all_groups()
        server_ver, all_quotes = quote_store.get_all_quotes()
        return {
            "groups": [g.model_dump() for g in groups],
            "quotes": {k: v.model_dump() for k, v in all_quotes.items()},
            "serverVersion": server_ver,
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

    async def delete_group(self, group_id: str):
        await db.delete_group(group_id)
        await self.sync_subscriptions()
        await publisher.broadcast_watchlist_changed()

    async def add_item(self, group_id: str, code: str):
        # 檢查合約快取
        code = code.strip().upper()
        info = shioaji_adapter.contracts_cache.get(code)
        name = info["name"] if info else code
        exchange = info["exchange"] if info else "TSE"
        sec_type = info["securityType"] if info else "STOCK"
        
        item = await db.add_item_to_group(group_id, code, name, exchange, sec_type)
        await self.sync_subscriptions()
        await publisher.broadcast_watchlist_changed()
        return item

    async def remove_item(self, group_id: str, code: str):
        await db.remove_item_from_group(group_id, code)
        await self.sync_subscriptions()
        await publisher.broadcast_watchlist_changed()

    async def reorder_items(self, group_id: str, codes: list[str]):
        await db.reorder_items(group_id, codes)
        await publisher.broadcast_watchlist_changed()

watchlist_service = WatchlistService()
