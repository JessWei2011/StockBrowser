import os
from pathlib import Path
from dotenv import load_dotenv

# 載入專案根目錄的 .env
BASE_DIR = Path(__file__).resolve().parent.parent.parent
load_dotenv(BASE_DIR / ".env")

class Settings:
    SJ_API_KEY: str = os.getenv("SJ_API_KEY", "")
    SJ_SECRET_KEY: str = os.getenv("SJ_SECRET_KEY", "")
    SJ_CA_PATH: str = os.getenv("SJ_CA_PATH", "")
    SJ_CA_PASSWD: str = os.getenv("SJ_CA_PASSWD", "")
    SJ_PERSON_ID: str = os.getenv("SJ_PERSON_ID", "")
    SJ_SIMULATION: bool = os.getenv("SJ_SIMULATION", "false").lower() in ("true", "1", "t")
    
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))
    
    DB_PATH: Path = BASE_DIR / os.getenv("DB_PATH", "data/stock_browser.db")
    
    # 支援在收盤或週末期間微幅模擬跳動，方便測試 1Hz 推播及 UI 渲染
    ENABLE_OFFHOURS_MOCK_TICKS: bool = os.getenv("ENABLE_OFFHOURS_MOCK_TICKS", "true").lower() in ("true", "1", "t")

settings = Settings()
