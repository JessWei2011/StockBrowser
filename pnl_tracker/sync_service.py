import os
import time
import calendar
from datetime import datetime, date
from pathlib import Path
from typing import Dict, Any, List, Optional
from dotenv import load_dotenv
import shioaji as sj

from .database import save_trades_batch, log_sync, DB_PATH

# 預設載入上層 StockBrowser 的 .env
ENV_PATH = Path(__file__).parent.parent / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)
else:
    load_dotenv()

def get_monthly_ranges(start_date_str: str = "2025-10-01", end_date_str: Optional[str] = None) -> List[tuple]:
    """生成按月分組的 (start_str, end_str) 清單"""
    start_dt = datetime.strptime(start_date_str, "%Y-%m-%d").date()
    end_dt = datetime.strptime(end_date_str, "%Y-%m-%d").date() if end_date_str else date.today()
    
    ranges = []
    curr = date(start_dt.year, start_dt.month, 1)
    
    while curr <= end_dt:
        y = curr.year
        m = curr.month
        last_day = calendar.monthrange(y, m)[1]
        m_start = max(curr, start_dt)
        m_end = min(date(y, m, last_day), end_dt)
        ranges.append((m_start.strftime("%Y-%m-%d"), m_end.strftime("%Y-%m-%d")))
        
        # 下個月第一天
        if m == 12:
            curr = date(y + 1, 1, 1)
        else:
            curr = date(y, m + 1, 1)
            
    return ranges

def sync_from_shioaji(start_date_str: str = "2025-10-01", end_date_str: Optional[str] = None, progress_callback = None) -> Dict[str, Any]:
    """
    連接 Shioaji API，逐月抓取已實現損益明細並寫入 SQLite 資料庫。
    按月批量查詢，不頻繁呼叫 detail，保護券商頻率限制 (5秒25次)，快速又穩定。
    """
    api_key = os.getenv("SJ_API_KEY")
    secret_key = os.getenv("SJ_SECRET_KEY")
    simulation = os.getenv("SJ_SIMULATION", "False").lower() in ("true", "1")
    
    if not api_key or not secret_key:
        raise ValueError("找不到 SJ_API_KEY 或 SJ_SECRET_KEY 環境變數，請確認 .env 設定！")
        
    api = sj.Shioaji(simulation=simulation)
    try:
        if progress_callback:
            progress_callback(5, 100, "正在登入永豐金 Shioaji API...")
            
        api.login(api_key=api_key, secret_key=secret_key)
        
        ca_path = os.getenv("SJ_CA_PATH")
        ca_passwd = os.getenv("SJ_CA_PASSWD")
        person_id = os.getenv("SJ_PERSON_ID")
        if ca_path and os.path.exists(ca_path) and ca_passwd and person_id:
            try:
                api.activate_ca(ca_path=ca_path, ca_passwd=ca_passwd, person_id=person_id)
            except Exception as e:
                print(f"CA 憑證啟用略過或失敗: {e}")

        month_ranges = get_monthly_ranges(start_date_str, end_date_str)
        total_months = len(month_ranges)
        
        all_trades_to_save = []
        total_fetched = 0
        
        for idx, (m_start, m_end) in enumerate(month_ranges):
            month_label = m_start[:7]
            pct = int(10 + (idx / total_months) * 80)
            if progress_callback:
                progress_callback(pct, 100, f"正在爬取 {month_label} 已實現損益明細...")

            try:
                res = api.list_profit_loss(
                    account=api.stock_account,
                    begin_date=m_start,
                    end_date=m_end,
                    unit=sj.Unit.Share,
                    timeout=30000
                )
            except Exception as e:
                print(f"查詢 {month_label} 損益異常: {e}")
                res = []

            if res:
                total_fetched += len(res)
                for item in res:
                    c = None
                    try:
                        c = api.Contracts.Stocks.get(item.code)
                    except:
                        pass
                    name = getattr(c, 'name', item.code) if c else item.code
                    
                    # 使用精確公式計算買進與賣出金額 (免額外呼叫 detail 避免觸發限流)
                    pnl_amount = int(round(item.pnl))
                    if item.pr_ratio != 0:
                        buy_amount = int(round(item.pnl / item.pr_ratio))
                    else:
                        buy_amount = int(round(item.price * item.quantity))
                        
                    sell_amount = buy_amount + pnl_amount
                    return_rate = round(item.pr_ratio * 100, 2)
                    
                    trade_record = {
                        "id": f"{item.date}_{item.seqno}_{item.dseq}_{item.code}",
                        "trade_date": item.date,
                        "month": item.date[:7],
                        "code": item.code,
                        "name": name,
                        "quantity": int(item.quantity),
                        "price": float(item.price),
                        "buy_amount": buy_amount,
                        "sell_amount": sell_amount,
                        "pnl": pnl_amount,
                        "return_rate": return_rate,
                        "seqno": str(item.seqno),
                        "dseq": str(item.dseq),
                        "cond": str(item.cond)
                    }
                    all_trades_to_save.append(trade_record)
                    
            time.sleep(0.2)  # 每月間隔 200ms 保護 API 頻率限制

        # 批次寫入資料庫
        if progress_callback:
            progress_callback(92, 100, f"正在寫入本地資料庫 (共 {len(all_trades_to_save)} 筆)...")
            
        new_count = save_trades_batch(all_trades_to_save)
        
        sync_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        end_str = end_date_str or date.today().strftime("%Y-%m-%d")
        log_sync(
            sync_at=sync_at,
            start_date=start_date_str,
            end_date=end_str,
            fetched_count=total_fetched,
            new_count=new_count,
            status="SUCCESS",
            message=f"已成功同步 {total_months} 個月份，共 {total_fetched} 筆明細"
        )
        
        if progress_callback:
            progress_callback(100, 100, "同步完成！")

        return {
            "status": "success",
            "sync_at": sync_at,
            "start_date": start_date_str,
            "end_date": end_str,
            "total_fetched": total_fetched,
            "new_count": new_count,
            "months_synced": total_months
        }
    except Exception as e:
        sync_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_sync(
            sync_at=sync_at,
            start_date=start_date_str,
            end_date=end_date_str or date.today().strftime("%Y-%m-%d"),
            fetched_count=0,
            new_count=0,
            status="FAILED",
            message=str(e)
        )
        raise e
    finally:
        try:
            api.logout()
        except:
            pass
