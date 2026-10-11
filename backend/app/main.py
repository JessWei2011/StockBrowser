import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from backend.app.settings import settings
from backend.app.repositories.db import init_db
from backend.app.services.shioaji_adapter import shioaji_adapter
from backend.app.services.publisher import publisher
from backend.app.services.watchlist_service import watchlist_service
from backend.app.api.rest import router as rest_router
from backend.app.api.ws import router as ws_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("main")

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting StockBrowser application...")
    # 1. 初始化資料庫與 schema
    await init_db()
    
    # 2. 啟動 Shioaji Adapter
    loop = asyncio.get_running_loop()
    shioaji_adapter.start(loop)
    
    # 3. 同步永豐持股至「財神簿」固定分頁
    await watchlist_service.sync_wealth_book()

    # 4. 同步資料庫內所有群組股票至 Shioaji 訂閱聯集
    await watchlist_service.sync_subscriptions()
    
    # 5. 啟動 1Hz 批次廣播
    await publisher.start()
    
    logger.info("StockBrowser backend initialized and running.")
    yield
    
    logger.info("Shutting down StockBrowser application...")
    await publisher.stop()
    shioaji_adapter.stop()
    logger.info("StockBrowser shutdown complete.")

app = FastAPI(title="StockBrowser", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(rest_router)
app.include_router(ws_router)

# 前端靜態資源掛載 (如果已編譯)
FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file_path = FRONTEND_DIST / full_path
        if file_path.exists() and file_path.is_file():
            return FileResponse(file_path)
        response = FileResponse(FRONTEND_DIST / "index.html")
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.app.main:app", host=settings.HOST, port=settings.PORT, reload=False)
