from fastapi import APIRouter, HTTPException, Query
from backend.app.services.watchlist_service import watchlist_service
from backend.app.services.shioaji_adapter import shioaji_adapter
from backend.app.services.quote_store import quote_store
from backend.app.domain.models import (
    CreateGroupRequest,
    UpdateGroupRequest,
    AddItemRequest,
    ReorderItemsRequest,
    InstrumentSearchResult
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
    await watchlist_service.update_group(group_id, body.name, body.position)
    return {"status": "ok"}

@router.delete("/groups/{group_id}")
async def delete_group(group_id: str):
    await watchlist_service.delete_group(group_id)
    return {"status": "ok"}

@router.post("/groups/{group_id}/items")
async def add_item(group_id: str, body: AddItemRequest):
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
    await watchlist_service.remove_item(group_id, code)
    return {"status": "ok"}

@router.patch("/groups/{group_id}/items/order")
async def reorder_items(group_id: str, body: ReorderItemsRequest):
    await watchlist_service.reorder_items(group_id, body.codes)
    return {"status": "ok"}

@router.get("/instruments/search", response_model=list[InstrumentSearchResult])
async def search_instruments(q: str = Query("", min_length=1)):
    return shioaji_adapter.search_contracts(q)
