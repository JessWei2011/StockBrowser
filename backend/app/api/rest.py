from typing import Optional
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
    AccountBalanceState,
    UpdateCapitalRequest,
    SettlementItem,
    SettlementTradeDetail,
    CalendarMonthResponse,
)
import datetime
from backend.app.repositories.db import get_setting, set_setting, now_iso

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

@router.get("/global-indices")
async def get_global_indices():
    """取得美股與亞股（日韓）國際指數行情與走勢數據"""
    from backend.app.services.yahoo_market_service import yahoo_market_service
    data = yahoo_market_service.get_global_indices()
    # 若快取尚無資料，即時抓取一次
    if not data.get("us") and not data.get("asia"):
        await yahoo_market_service.update_indices_once()
        data = yahoo_market_service.get_global_indices()
    return data

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

@router.get("/calendar", response_model=CalendarMonthResponse)
async def get_calendar_events(
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None)
):
    from backend.app.services.calendar_service import calendar_service
    now = datetime.datetime.now()
    y = year or now.year
    m = month or now.month
    return await calendar_service.get_month_calendar(y, m)

@router.get("/news")
async def get_financial_news(date: Optional[str] = Query(None)):
    """取得台股與重要財經新聞（支援滾動保留最新 5 個交易日，降冪排列）"""
    from backend.app.services.news_service import news_service
    return await news_service.get_news(target_date=date)

@router.post("/news/refresh")
async def refresh_financial_news():
    """手動重新整理新聞 RSS 來源"""
    from backend.app.services.news_service import news_service
    await news_service.refresh_news()
    return await news_service.get_news()

@router.post("/system/refresh")
async def refresh_system_quotes(force_reconnect: bool = False):
    """手動重新校正合約快取、持股庫存與今日快照，若 force_reconnect=True 則強制重設 Shioaji 連線與重新登入"""
    if force_reconnect:
        await shioaji_adapter.reconnect()
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, shioaji_adapter.refresh_contracts_and_snapshots)
    await watchlist_service.sync_wealth_book()
    from backend.app.services.publisher import publisher
    await publisher.broadcast_watchlist_changed()
    return {"status": "ok", "message": "Contracts, snapshots, indices, and positions refreshed", "reconnected": force_reconnect}

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

@router.post("/orders/clear")
async def clear_orders():
    """手動清空今日委託單紀錄"""
    try:
        return shioaji_adapter.clear_orders()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

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

@router.get("/account/balance", response_model=AccountBalanceState)
async def get_account_balance():
    """取得帳戶本金設定與 T+0 / T+1 / T+2 交割試算餘額"""
    try:
        raw_cap = await get_setting("account_capital_wan")
        has_configured = raw_cap is not None and raw_cap.strip() != ""
        base_cap = float(raw_cap) if has_configured else None

        raw_mode = await get_setting("account_capital_mode")
        capital_mode = raw_mode if raw_mode in ("before_t0", "after_t0") else "after_t0"

        settlements_raw = shioaji_adapter.fetch_settlements()
        
        t0_amt = 0.0
        t0_date = ""
        t1_amt = 0.0
        t1_date = ""
        t2_amt = 0.0
        t2_date = ""
        
        items: list[SettlementItem] = []
        for s in settlements_raw:
            t = s.get("t", 0)
            d = s.get("date", "")
            amt = float(s.get("amount", 0.0))
            amt_wan = float(s.get("amountWan", 0.0))
            items.append(SettlementItem(
                t=t,
                date=d,
                amount=amt,
                amountWan=amt_wan
            ))
            if t == 0:
                t0_amt = amt
                t0_date = d
            elif t == 1:
                t1_amt = amt
                t1_date = d
            elif t == 2:
                t2_amt = amt
                t2_date = d

        t0_remaining = None
        t1_remaining = None
        t2_remaining = None

        if has_configured and base_cap is not None:
            # 計算三格餘額 (單位: 萬)
            # 若使用者填的是「T+0 扣款前」：則格子 1 (T+0 餘額) = 起始本金 + 今日交割款
            # 若使用者填的是「T+0 扣款後」：則今日交割款已在填入本金中反映，格子 1 (T+0 餘額) = 起始本金
            if capital_mode == "before_t0":
                t0_remaining = round(base_cap + (t0_amt / 10000.0), 4)
            else:
                t0_remaining = round(base_cap, 4)

            # 格子 2 (T+1): T+0 餘額 + 次日交割款
            t1_remaining = round(t0_remaining + (t1_amt / 10000.0), 4)
            # 格子 3 (T+2): T+1 餘額 + 後天交割款
            t2_remaining = round(t1_remaining + (t2_amt / 10000.0), 4)

        # 取得今日買賣明細並拼裝算式 (a + b - c)
        raw_deals = shioaji_adapter.fetch_today_deals_breakdown()
        t2_trade_details: list[SettlementTradeDetail] = []
        formula_parts = []
        for rd in raw_deals:
            detail_item = SettlementTradeDetail(**rd)
            t2_trade_details.append(detail_item)
            sign = "+" if detail_item.netAmount >= 0 else "-"
            amt_abs_wan = abs(detail_item.netAmountWan)
            stock_label = f"{detail_item.name or detail_item.code}"
            formula_parts.append(f"{sign}{amt_abs_wan:.2f}萬({stock_label})")

        t2_formula_str = " ".join(formula_parts) if formula_parts else ""

        return AccountBalanceState(
            hasConfigured=has_configured,
            baseCapitalWan=round(base_cap, 4) if base_cap is not None else None,
            capitalMode=capital_mode,
            t0Date=t0_date,
            t0Amount=t0_amt,
            t0RemainingWan=t0_remaining,
            t1Date=t1_date,
            t1Amount=t1_amt,
            t1RemainingWan=t1_remaining,
            t2Date=t2_date,
            t2Amount=t2_amt,
            t2RemainingWan=t2_remaining,
            t2Formula=t2_formula_str,
            t2Details=t2_trade_details,
            settlements=items,
            updatedAt=now_iso() if "now_iso" in globals() else ""
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/account/capital")
async def update_account_capital(body: UpdateCapitalRequest):
    """更新帳戶起始投資本金與扣款模式 (單位: 萬)"""
    try:
        await set_setting("account_capital_wan", str(body.capitalWan))
        mode = body.capitalMode if body.capitalMode in ("before_t0", "after_t0") else "after_t0"
        await set_setting("account_capital_mode", mode)
        return {"status": "ok", "capitalWan": body.capitalWan, "capitalMode": mode}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))





