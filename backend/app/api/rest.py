from fastapi import APIRouter, HTTPException, Query
from backend.app.services.watchlist_service import watchlist_service
from backend.app.services.shioaji_adapter import shioaji_adapter
from backend.app.services.quote_store import quote_store
from backend.app.settings import settings
from backend.app.domain.models import (
    CreateGroupRequest,
    UpdateGroupRequest,
    AddItemRequest,
    ReorderItemsRequest,
    InstrumentSearchResult,
    PlaceOrderRequest,
    OrderItem,
    UpdateOrderRequest,
)

router = APIRouter(prefix="/api/v1")

@router.get("/health")
async def health_check():
    server_ver = quote_store.get_server_version()
    return {
        "status": "ok",
        "serverVersion": server_ver,
        "shioaji": {
            "connected": shioaji_adapter.is_connected,
            "loggedIn": shioaji_adapter.is_logged_in,
            "lastQuoteTime": shioaji_adapter.last_quote_time,
            "subscribedCount": len(shioaji_adapter.subscribed_codes),
        }
    }

@router.get("/bootstrap")
async def get_bootstrap():
    return await watchlist_service.get_bootstrap_data()

@router.post("/groups")
async def create_group(body: CreateGroupRequest):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Group name cannot be empty")
    group = await watchlist_service.create_group(body.name.strip())
    return group

@router.patch("/groups/{group_id}")
async def update_group(group_id: str, body: UpdateGroupRequest):
    if group_id in ("g-vault", "g-wealth"):
        raise HTTPException(status_code=400, detail="『財神庫』與『財神簿』為系統持股固定分頁，無法更名或移動位置")
    await watchlist_service.update_group(group_id, body.name, body.position)
    return {"status": "ok"}

@router.delete("/groups/{group_id}")
async def delete_group(group_id: str):
    if group_id in ("g-vault", "g-wealth"):
        raise HTTPException(status_code=400, detail="『財神庫』與『財神簿』為系統持股固定分頁，無法刪除")
    await watchlist_service.delete_group(group_id)
    return {"status": "ok"}

@router.post("/groups/{group_id}/items")
async def add_item(group_id: str, body: AddItemRequest):
    if group_id in ("g-vault", "g-wealth"):
        raise HTTPException(status_code=400, detail="『財神庫』與『財神簿』由永豐 API 持股自動同步，無需手動新增")
    code = body.code.strip().upper()
    if not code:
        raise HTTPException(status_code=400, detail="Stock code cannot be empty")
    try:
        item = await watchlist_service.add_item(group_id, code)
        return item
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        if "UNIQUE constraint failed" in str(e):
            raise HTTPException(status_code=409, detail="Stock already exists in this group")
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/groups/{group_id}/items/{code}")
async def remove_item(group_id: str, code: str):
    if group_id in ("g-vault", "g-wealth"):
        raise HTTPException(status_code=400, detail="『財神庫』與『財神簿』由永豐 API 持股自動同步，無法手動刪除")
    await watchlist_service.remove_item(group_id, code)
    return {"status": "ok"}

@router.patch("/groups/{group_id}/items/order")
async def reorder_items(group_id: str, body: ReorderItemsRequest):
    await watchlist_service.reorder_items(group_id, body.codes)
    return {"status": "ok"}

@router.get("/instruments/search", response_model=list[InstrumentSearchResult])
async def search_instruments(q: str = Query("", min_length=1)):
    return shioaji_adapter.search_contracts(q)

@router.get("/announcements")
async def get_announcements():
    from backend.app.services.announcement_service import announcement_service
    return announcement_service.get_all_announcements()

@router.post("/announcements/refresh")
async def refresh_announcements():
    from backend.app.services.announcement_service import announcement_service
    res = await announcement_service.refresh_all_announcements(reason="manual_api")
    return {"status": "ok", "totalStocks": len(res)}

@router.post("/system/refresh")
async def refresh_system_quotes(force_reconnect: bool = False):
    """手動重新校正合約快取與今日快照，若 force_reconnect=True 則強制重設 Shioaji 連線與重新登入"""
    if force_reconnect:
        await shioaji_adapter.reconnect()
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, shioaji_adapter.refresh_contracts_and_snapshots)
    return {"status": "ok", "message": "Contracts, snapshots, and indices refreshed", "reconnected": force_reconnect}

@router.get("/charts/{code}")
async def get_stock_chart(code: str):
    import asyncio
    from backend.app.services.stock_chart_service import parse_stock_report
    # 嘗試從即時記憶體快取中獲取當日即時報價
    live_quote = None
    try:
        from backend.app.services.quote_store import quote_store
        with quote_store._lock:
            quote_obj = quote_store._quotes.get(code)
            if quote_obj:
                live_quote = {
                    "open": quote_obj.open,
                    "high": quote_obj.high,
                    "low": quote_obj.low,
                    "last": quote_obj.last,
                    "totalVolume": quote_obj.totalVolume,
                }
    except Exception:
        pass

    chart_data = await asyncio.to_thread(parse_stock_report, code, live_quote)
    if not chart_data:
        raise HTTPException(status_code=404, detail=f"Stock {code} report not found in StockCenter")
    return chart_data

@router.get("/indicators")
async def get_stock_indicators(codes: str = Query("")):
    import asyncio
    from backend.app.services.stock_chart_service import get_multiple_stocks_ma_summary
    code_list = [c.strip() for c in codes.split(",") if c.strip()]
    if not code_list:
        from backend.app.repositories.db import get_all_groups
        groups = await get_all_groups()
        code_list = list({it.code for g in groups for it in g.items})
    return await asyncio.to_thread(get_multiple_stocks_ma_summary, code_list)

@router.post("/orders/place")
async def place_order(body: PlaceOrderRequest):
    try:
        res = shioaji_adapter.place_order(
            code=body.code,
            action=body.action,
            quantity=body.quantity,
            unit=body.unit,
            price_type=body.price_type,
            price=body.price,
            order_lot=body.order_lot,
        )
        return res
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/orders", response_model=list[OrderItem])
async def get_orders():
    """查詢今日所有證券委託單與成交狀態"""
    return shioaji_adapter.fetch_orders()

@router.post("/orders/{order_id}/cancel")
async def cancel_order(order_id: str):
    """取消特定委託單"""
    try:
        return shioaji_adapter.cancel_order(order_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/orders/{order_id}/update")
async def update_order(order_id: str, body: UpdateOrderRequest):
    """修改委託價格或委託數量(減量)"""
    try:
        return shioaji_adapter.update_order(
            order_id=order_id,
            new_price=body.newPrice,
            new_qty=body.newQty,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))





