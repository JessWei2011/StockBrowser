import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from backend.app.services.publisher import publisher
from backend.app.services.quote_store import quote_store, now_iso

logger = logging.getLogger("ws")
router = APIRouter()

@router.websocket("/ws/quotes")
async def quotes_websocket(websocket: WebSocket):
    await websocket.accept()
    await publisher.register(websocket)
    
    # 建立連線後立即發送完整 snapshot
    server_ver, all_quotes = quote_store.get_all_quotes()
    snapshot_msg = {
        "type": "snapshot",
        "serverVersion": server_ver,
        "generatedAt": now_iso(),
        "quotes": [q.model_dump() for q in all_quotes.values()]
    }
    await websocket.send_text(json.dumps(snapshot_msg))

    try:
        while True:
            # 等待客戶端心跳或訊息
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    await websocket.send_text(json.dumps({"type": "pong", "ts": now_iso()}))
            except Exception:
                pass
    except WebSocketDisconnect:
        logger.info("Client disconnected normally.")
    except Exception as e:
        logger.warning(f"WebSocket client error: {e}")
    finally:
        await publisher.unregister(websocket)
