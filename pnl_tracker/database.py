import sqlite3
import os
from pathlib import Path
from typing import List, Dict, Any, Optional

DB_PATH = Path(__file__).parent / "data" / "pnl.db"

def get_connection(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn

def init_db(db_path: Path = DB_PATH):
    conn = get_connection(db_path)
    cur = conn.cursor()
    
    # 建立單筆交易明細表
    cur.execute("""
    CREATE TABLE IF NOT EXISTS realized_trades (
        id TEXT PRIMARY KEY,
        trade_date TEXT NOT NULL,
        month TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        price REAL NOT NULL,
        buy_amount INTEGER NOT NULL,
        sell_amount INTEGER NOT NULL,
        pnl INTEGER NOT NULL,
        return_rate REAL NOT NULL,
        seqno TEXT,
        dseq TEXT,
        cond TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    """)
    
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trades_date ON realized_trades(trade_date);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trades_month ON realized_trades(month);")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_trades_code ON realized_trades(code);")

    # 建立同步記錄表
    cur.execute("""
    CREATE TABLE IF NOT EXISTS sync_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_at TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        fetched_count INTEGER NOT NULL,
        new_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        message TEXT
    );
    """)

    # 建立每月損益 View
    cur.execute("DROP VIEW IF EXISTS v_monthly_pnl;")
    cur.execute("""
    CREATE VIEW v_monthly_pnl AS
    SELECT 
        month,
        COUNT(*) AS trade_count,
        SUM(quantity) AS total_shares,
        SUM(buy_amount) AS total_buy_amount,
        SUM(sell_amount) AS total_sell_amount,
        SUM(pnl) AS total_pnl,
        ROUND(SUM(pnl) * 100.0 / NULLIF(SUM(buy_amount), 0), 2) AS return_rate,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS win_count,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) AS loss_count,
        ROUND(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) AS win_rate
    FROM realized_trades
    GROUP BY month
    ORDER BY month DESC;
    """)

    # 建立總結損益 View
    cur.execute("DROP VIEW IF EXISTS v_total_summary_pnl;")
    cur.execute("""
    CREATE VIEW v_total_summary_pnl AS
    SELECT 
        COUNT(*) AS total_trades,
        IFNULL(SUM(quantity), 0) AS total_shares,
        IFNULL(SUM(buy_amount), 0) AS cumulative_buy_amount,
        IFNULL(SUM(sell_amount), 0) AS cumulative_sell_amount,
        IFNULL(SUM(pnl), 0) AS cumulative_pnl,
        ROUND(IFNULL(SUM(pnl), 0) * 100.0 / NULLIF(SUM(buy_amount), 0), 2) AS cumulative_return_rate,
        IFNULL(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS total_win_count,
        IFNULL(SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END), 0) AS total_loss_count,
        ROUND(IFNULL(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) * 100.0 / NULLIF(COUNT(*), 0), 2) AS overall_win_rate
    FROM realized_trades;
    """)

    conn.commit()
    conn.close()

def save_trades_batch(trades: List[Dict[str, Any]], db_path: Path = DB_PATH) -> int:
    """批次儲存交易明細，回傳新增筆數"""
    if not trades:
        return 0
    conn = get_connection(db_path)
    cur = conn.cursor()
    new_count = 0
    
    for t in trades:
        cur.execute("""
        INSERT INTO realized_trades (
            id, trade_date, month, code, name, quantity, price, 
            buy_amount, sell_amount, pnl, return_rate, seqno, dseq, cond
        ) VALUES (
            :id, :trade_date, :month, :code, :name, :quantity, :price,
            :buy_amount, :sell_amount, :pnl, :return_rate, :seqno, :dseq, :cond
        )
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            quantity = excluded.quantity,
            price = excluded.price,
            buy_amount = excluded.buy_amount,
            sell_amount = excluded.sell_amount,
            pnl = excluded.pnl,
            return_rate = excluded.return_rate;
        """, t)
        if cur.rowcount == 1:
            new_count += 1
            
    conn.commit()
    conn.close()
    return new_count

def log_sync(sync_at: str, start_date: str, end_date: str, fetched_count: int, new_count: int, status: str, message: str = "", db_path: Path = DB_PATH):
    conn = get_connection(db_path)
    cur = conn.cursor()
    cur.execute("""
    INSERT INTO sync_logs (sync_at, start_date, end_date, fetched_count, new_count, status, message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (sync_at, start_date, end_date, fetched_count, new_count, status, message))
    conn.commit()
    conn.close()

def get_monthly_summary(db_path: Path = DB_PATH) -> List[Dict[str, Any]]:
    conn = get_connection(db_path)
    cur = conn.cursor()
    cur.execute("SELECT * FROM v_monthly_pnl ORDER BY month DESC;")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def get_total_summary(db_path: Path = DB_PATH) -> Dict[str, Any]:
    conn = get_connection(db_path)
    cur = conn.cursor()
    cur.execute("SELECT * FROM v_total_summary_pnl;")
    row = cur.fetchone()
    summary = dict(row) if row else {}
    
    # 補充：最大獲利單筆與最大虧損單筆
    cur.execute("SELECT name, code, trade_date, pnl, return_rate FROM realized_trades ORDER BY pnl DESC LIMIT 1;")
    best = cur.fetchone()
    cur.execute("SELECT name, code, trade_date, pnl, return_rate FROM realized_trades ORDER BY pnl ASC LIMIT 1;")
    worst = cur.fetchone()
    
    summary["best_trade"] = dict(best) if best else None
    summary["worst_trade"] = dict(worst) if worst else None
    
    # 最近一次同步時間
    cur.execute("SELECT sync_at, status, fetched_count FROM sync_logs ORDER BY id DESC LIMIT 1;")
    last_sync = cur.fetchone()
    summary["last_sync"] = dict(last_sync) if last_sync else None
    
    conn.close()
    return summary

def get_trades(month: Optional[str] = None, limit: int = 1000, db_path: Path = DB_PATH) -> List[Dict[str, Any]]:
    conn = get_connection(db_path)
    cur = conn.cursor()
    if month:
        cur.execute("SELECT * FROM realized_trades WHERE month = ? ORDER BY trade_date DESC, id DESC LIMIT ?", (month, limit))
    else:
        cur.execute("SELECT * FROM realized_trades ORDER BY trade_date DESC, id DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows
