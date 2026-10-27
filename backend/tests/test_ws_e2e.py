import asyncio
import json
import pytest
import websockets
import uvicorn
from multiprocessing import Process
import time
from backend.app.settings import settings
from backend.app.services.quote_store import quote_store

def run_server():
    uvicorn.run("backend.app.main:app", host="127.0.0.1", port=8888, log_level="warning")

@pytest.mark.asyncio
async def test_websocket_e2e_snapshot_and_delta():
    # 啟動測試伺服器進程
    proc = Process(target=run_server, daemon=True)
    proc.start()
    
    # 等待伺服器啟動
    time.sleep(2.0)
    
    uri = "ws://127.0.0.1:8888/ws/quotes"
    ws = None
    for _ in range(20):
        try:
            ws = await websockets.connect(uri)
            break
        except Exception:
            await asyncio.sleep(0.5)

    assert ws is not None, "Failed to connect to test server at ws://127.0.0.1:8888/ws/quotes"
    try:
        # 1. 驗證收到初始 snapshot
        snap_raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
        snap_msg = json.loads(snap_raw)
        assert snap_msg["type"] == "snapshot"
        assert "serverVersion" in snap_msg
        assert "quotes" in snap_msg
        print(f"Successfully received initial snapshot with {len(snap_msg['quotes'])} quotes.")

        # 2. 驗證 ping / pong
        await ws.send(json.dumps({"type": "ping"}))
        pong_raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
        pong_msg = json.loads(pong_raw)
        assert pong_msg["type"] == "pong"
        print("Successfully received pong reply.")

        # 3. 驗證 1Hz delta 廣播
        delta_raw = await asyncio.wait_for(ws.recv(), timeout=6.0)
        delta_msg = json.loads(delta_raw)
        assert delta_msg["type"] in ("quote_delta", "watchlist_changed")
        print(f"Successfully received real-time broadcast: {delta_msg['type']}")
    finally:
        if ws:
            await ws.close()
        proc.terminate()
        proc.join()
