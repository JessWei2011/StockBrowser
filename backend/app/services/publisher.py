import asyncio
import json
import logging
from datetime import datetime, timezone
from fastapi import WebSocket
from backend.app.services.quote_store import quote_store, now_iso

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
            if not self._clients:
                return
            payload = json.dumps(message)
            dead_clients = set()
            for ws in list(self._clients):
                try:
                    await ws.send_text(payload)
                except Exception as e:
                    logger.debug(f"Failed to send to client: {e}")
                    dead_clients.add(ws)
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
                if dirty_quotes:
                    delta_msg = {
                        "type": "quote_delta",
                        "serverVersion": server_ver,
                        "generatedAt": now_iso(),
                        "quotes": [q.model_dump() for q in dirty_quotes]
                    }
                    await self.broadcast(delta_msg)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in publisher loop: {e}", exc_info=True)

publisher = BatchPublisher()
