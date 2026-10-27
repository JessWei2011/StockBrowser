import asyncio
import json
import logging
from datetime import datetime, timezone
from fastapi import WebSocket
from backend.app.services.quote_store import quote_store, now_iso
from backend.app.services.shioaji_adapter import shioaji_adapter, is_taiwan_market_open

logger = logging.getLogger("publisher")

class BatchPublisher:
    def __init__(self):
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._running = False

    async def register(self, ws: WebSocket):
        async with self._lock:
            self._clients.add(ws)
            logger.info(f"WebSocket client connected. Total clients: {len(self._clients)}")

    async def unregister(self, ws: WebSocket):
        async with self._lock:
            self._clients.discard(ws)
            logger.info(f"WebSocket client disconnected. Total clients: {len(self._clients)}")

    async def broadcast(self, message: dict):
        async with self._lock:
            clients_snapshot = list(self._clients)
        if not clients_snapshot:
            return
        payload = json.dumps(message)

        async def send_to_client(ws: WebSocket):
            try:
                await asyncio.wait_for(ws.send_text(payload), timeout=2.0)
                return None
            except Exception as e:
                logger.debug(f"Failed to send to client: {e}")
                return ws

        dead_results = await asyncio.gather(*(send_to_client(ws) for ws in clients_snapshot))
        dead_clients = {ws for ws in dead_results if ws is not None}
        if dead_clients:
            async with self._lock:
                for dead in dead_clients:
                    self._clients.discard(dead)

    async def broadcast_watchlist_changed(self):
        version = quote_store.get_server_version()
        await self.broadcast({
            "type": "watchlist_changed",
            "serverVersion": version,
            "generatedAt": now_iso()
        })

    async def start(self):
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self):
        logger.info("BatchPublisher 1Hz loop started.")
        while self._running:
            try:
                await asyncio.sleep(1.0)
                # 只有當有 WebSocket 客戶端連線時才取出並清空 dirty 報價，避免客戶端重連前遺失增量
                if not self._clients:
                    continue

                server_ver, dirty_quotes = quote_store.get_dirty_quotes()
                has_dirty_quotes = bool(dirty_quotes)
                has_dirty_indices = getattr(shioaji_adapter, "indices_dirty", False)
                self._heartbeat_counter = getattr(self, "_heartbeat_counter", 0) + 1
                should_send_heartbeat = (self._heartbeat_counter % 5 == 0)

                if has_dirty_quotes or has_dirty_indices or should_send_heartbeat:
                    shioaji_adapter.indices_dirty = False
                    delta_msg = {
                        "type": "quote_delta",
                        "serverVersion": server_ver,
                        "generatedAt": now_iso(),
                        "quotes": [q.model_dump() for q in dirty_quotes] if dirty_quotes else [],
                        "marketIndices": shioaji_adapter.market_indices,
                        "wealthSummary": shioaji_adapter.get_live_wealth_summary(),
                        "upstream": {
                            "connected": shioaji_adapter.is_connected,
                            "loggedIn": shioaji_adapter.is_logged_in,
                            "lastQuoteTime": shioaji_adapter.last_quote_time,
                            "subscribedCount": len(shioaji_adapter.subscribed_codes),
                            "maxAllowed": 200,
                            "isMarketOpen": is_taiwan_market_open(),
                        },
                    }
                    await self.broadcast(delta_msg)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in publisher loop: {e}", exc_info=True)

publisher = BatchPublisher()
