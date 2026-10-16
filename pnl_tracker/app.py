import csv
import io
import os
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, BackgroundTasks, HTTPException, Query
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .database import (
    init_db,
    get_monthly_summary,
    get_total_summary,
    get_trades,
    DB_PATH
)
from .sync_service import sync_from_shioaji

# 初始化資料庫
init_db()

app = FastAPI(title="PnL Tracker", description="台股已實現損益統計系統")

# 狀態管理
class SyncStatus:
    is_syncing: bool = False
    progress: int = 0
    message: str = "就緒"
    last_error: Optional[str] = None

sync_state = SyncStatus()

STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return HTMLResponse(content=index_file.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>PnL Tracker 載入中...</h1>")

@app.get("/api/summary")
async def api_summary():
    """取得整體歷史總結績效"""
    return get_total_summary()

@app.get("/api/monthly")
async def api_monthly():
    """取得每月份損益與績效統計"""
    return get_monthly_summary()

@app.get("/api/trades")
async def api_trades(month: Optional[str] = Query(None), limit: int = Query(1000)):
    """取得單筆交易明細（可依月份篩選）"""
    return get_trades(month=month, limit=limit)

@app.get("/api/sync/status")
async def api_sync_status():
    """取得目前同步進度"""
    return {
        "is_syncing": sync_state.is_syncing,
        "progress": sync_state.progress,
        "message": sync_state.message,
        "last_error": sync_state.last_error
    }

def run_sync_task(start_date: str):
    global sync_state
    sync_state.is_syncing = True
    sync_state.progress = 5
    sync_state.message = "正在啟動同步..."
    sync_state.last_error = None
    
    def on_progress(p, total, msg):
        sync_state.progress = p
        sync_state.message = msg

    try:
        res = sync_from_shioaji(start_date_str=start_date, progress_callback=on_progress)
        sync_state.progress = 100
        sync_state.message = f"同步成功！共獲取 {res.get('total_fetched', 0)} 筆紀錄。"
    except Exception as e:
        sync_state.last_error = str(e)
        sync_state.message = f"同步失敗: {e}"
    finally:
        sync_state.is_syncing = False

class SyncRequest(BaseModel):
    start_date: str = "2025-10-01"

@app.post("/api/sync")
async def api_trigger_sync(req: SyncRequest, background_tasks: BackgroundTasks):
    """一鍵觸發從 Shioaji 爬取資料"""
    if sync_state.is_syncing:
        raise HTTPException(status_code=400, detail="目前已有同步任務正在執行中，請稍候！")
        
    background_tasks.add_task(run_sync_task, req.start_date)
    return {"status": "started", "message": "已開始在後台從 Shioaji API 同步資料"}

@app.get("/api/export_csv")
async def api_export_csv():
    """匯出所有交易明細為 CSV（含 UTF-8 BOM 避免 Excel 亂碼）"""
    trades = get_trades(limit=50000)
    output = io.StringIO()
    # 寫入 UTF-8 BOM
    output.write('\ufeff')
    writer = csv.writer(output)
    
    headers = ["成交日期", "股票代號", "股票名稱", "成交股數", "成交價格", "買進成本", "賣出金額", "損益試算", "報酬率(%)", "交易單號"]
    writer.writerow(headers)
    
    for t in trades:
        writer.writerow([
            t.get("trade_date"),
            t.get("code"),
            t.get("name"),
            t.get("quantity"),
            t.get("price"),
            t.get("buy_amount"),
            t.get("sell_amount"),
            t.get("pnl"),
            t.get("return_rate"),
            t.get("id")
        ])
        
    output.seek(0)
    return StreamingResponse(
        io.BytesIO(output.getvalue().encode('utf-8-sig')),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=realized_trades.csv"}
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("pnl_tracker.app:app", host="0.0.0.0", port=8050, reload=False)
