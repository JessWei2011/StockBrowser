import aiosqlite
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from backend.app.settings import settings
from backend.app.domain.models import WatchlistGroup, WatchlistItem

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

@asynccontextmanager
async def get_db_connection():
    settings.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(settings.DB_PATH) as db:
        await db.execute("PRAGMA journal_mode = WAL;")
        await db.execute("PRAGMA foreign_keys = ON;")
        db.row_factory = aiosqlite.Row
        yield db

async def init_db():
    async with get_db_connection() as db:
        await db.execute("""
        CREATE TABLE IF NOT EXISTS watchlist_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            position INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """)
        await db.execute("""
        CREATE TABLE IF NOT EXISTS watchlist_items (
            id TEXT PRIMARY KEY,
            group_id TEXT NOT NULL REFERENCES watchlist_groups(id) ON DELETE CASCADE,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            exchange TEXT NOT NULL,
            security_type TEXT NOT NULL,
            position INTEGER NOT NULL,
            UNIQUE(group_id, code)
        );
        """)
        await db.execute("""
        CREATE TABLE IF NOT EXISTS stock_positions (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            quantity REAL NOT NULL,
            cost_price REAL NOT NULL,
            initial_last REAL,
            initial_pnl REAL,
            updated_at TEXT NOT NULL
        );
        """)
        await db.commit()

        # 檢查是否需要預設種子資料
        cursor = await db.execute("SELECT COUNT(*) FROM watchlist_groups")
        row = await cursor.fetchone()
        if row and row[0] == 0:
            await seed_default_data(db)

async def seed_default_data(db: aiosqlite.Connection):
    ts = now_iso()
    # 建立參考 1.png 之群組
    groups_seed = [
        ("g-treasure", "尋找寶物", 0, [
            ("1326", "台化", "TSE", "STOCK"),
            ("3014", "聯陽", "TSE", "STOCK"),
            ("3545", "敦泰", "TSE", "STOCK"),
            ("3529", "力旺", "OTC", "STOCK"),
            ("2059", "川湖", "TSE", "STOCK"),
            ("8227", "巨有科技", "OTC", "STOCK"),
            ("6182", "合晶", "OTC", "STOCK"),
            ("3532", "台勝科", "TSE", "STOCK"),
            ("5483", "中美晶", "OTC", "STOCK"),
            ("6488", "環球晶", "OTC", "STOCK"),
        ]),
        ("g-etf", "ETF", 1, [
            ("0050", "元大台灣50", "TSE", "ETF"),
            ("0056", "元大高股息", "TSE", "ETF"),
            ("00878", "國泰永續高股息", "TSE", "ETF"),
            ("00919", "群益台灣精選高息", "TSE", "ETF"),
            ("00929", "復華台灣科技優息", "TSE", "ETF"),
        ]),
        ("g-semic", "權值半導體", 2, [
            ("2330", "台積電", "TSE", "STOCK"),
            ("2454", "聯發科", "TSE", "STOCK"),
            ("2317", "鴻海", "TSE", "STOCK"),
            ("2308", "台達電", "TSE", "STOCK"),
            ("2382", "廣達", "TSE", "STOCK"),
        ]),
        ("g-cpo", "CPO光通訊", 3, [
            ("3450", "聯鈞", "TSE", "STOCK"),
            ("4977", "眾達-KY", "TSE", "STOCK"),
            ("3363", "上詮", "OTC", "STOCK"),
            ("6451", "訊芯-KY", "TSE", "STOCK"),
        ]),
    ]

    for g_id, g_name, g_pos, items in groups_seed:
        await db.execute(
            "INSERT INTO watchlist_groups (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (g_id, g_name, g_pos, ts, ts)
        )
        for i_pos, (code, name, exchange, sec_type) in enumerate(items):
            i_id = f"item-{g_id}-{code}"
            await db.execute(
                "INSERT INTO watchlist_items (id, group_id, code, name, exchange, security_type, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (i_id, g_id, code, name, exchange, sec_type, i_pos)
            )
    await db.commit()

async def get_all_groups() -> list[WatchlistGroup]:
    async with get_db_connection() as db:
        groups_cur = await db.execute("SELECT id, name, position, created_at, updated_at FROM watchlist_groups ORDER BY position ASC, created_at ASC")
        group_rows = await groups_cur.fetchall()
        
        result = []
        for g_row in group_rows:
            items_cur = await db.execute(
                "SELECT id, group_id, code, name, exchange, security_type, position FROM watchlist_items WHERE group_id = ? ORDER BY position ASC",
                (g_row["id"],)
            )
            item_rows = await items_cur.fetchall()
            items = [
                WatchlistItem(
                    id=i["id"],
                    groupId=i["group_id"],
                    code=i["code"],
                    name=i["name"],
                    exchange=i["exchange"],
                    securityType=i["security_type"],
                    position=i["position"]
                ) for i in item_rows
            ]
            is_sys = bool(g_row["id"] in ("g-vault", "g-wealth") or g_row["name"] in ("財神庫", "財神簿"))
            result.append(
                WatchlistGroup(
                    id=g_row["id"],
                    name=g_row["name"],
                    position=g_row["position"],
                    createdAt=g_row["created_at"],
                    updatedAt=g_row["updated_at"],
                    isSystemGroup=is_sys,
                    items=items
                )
            )
        return result

async def ensure_system_wealth_groups() -> tuple[str, str]:
    """
    確保「財神庫」固定為第 1 個系統群組 (position 0)
    確保「財神簿」固定為第 2 個系統群組 (position 1)
    其餘自選群組從 position 2 開始
    """
    async with get_db_connection() as db:
        ts = now_iso()
        
        # 1. 處理 財神庫 (g-vault)
        cur_v = await db.execute("SELECT id FROM watchlist_groups WHERE id = 'g-vault' OR name = '財神庫'")
        row_v = await cur_v.fetchone()
        v_id = row_v[0] if row_v else "g-vault"

        # 2. 處理 財神簿 (g-wealth)
        cur_w = await db.execute("SELECT id FROM watchlist_groups WHERE id = 'g-wealth' OR name = '財神簿'")
        row_w = await cur_w.fetchone()
        w_id = row_w[0] if row_w else "g-wealth"

        if row_v:
            await db.execute("UPDATE watchlist_groups SET name = '財神庫', position = 0, updated_at = ? WHERE id = ?", (ts, v_id))
        else:
            await db.execute(
                "INSERT INTO watchlist_groups (id, name, position, created_at, updated_at) VALUES (?, '財神庫', 0, ?, ?)",
                (v_id, ts, ts)
            )

        if row_w:
            await db.execute("UPDATE watchlist_groups SET name = '財神簿', position = 1, updated_at = ? WHERE id = ?", (ts, w_id))
        else:
            await db.execute(
                "INSERT INTO watchlist_groups (id, name, position, created_at, updated_at) VALUES (?, '財神簿', 1, ?, ?)",
                (w_id, ts, ts)
            )

        # 重整其餘群組的連續 position (從 2 開始)
        other_cur = await db.execute(
            "SELECT id FROM watchlist_groups WHERE id NOT IN (?, ?) ORDER BY position ASC, created_at ASC",
            (v_id, w_id)
        )
        other_rows = await other_cur.fetchall()
        for idx, o_row in enumerate(other_rows, start=2):
            await db.execute("UPDATE watchlist_groups SET position = ? WHERE id = ?", (idx, o_row["id"]))

        await db.commit()
        return v_id, w_id

async def ensure_wealth_book_group() -> str:
    _, w_id = await ensure_system_wealth_groups()
    return w_id

async def save_stock_positions(positions: list[dict]):
    """持久化持股明細至 SQLite，確保即使 Shioaji 重啟或離線仍能呈現持股未實現損益"""
    async with get_db_connection() as db:
        await db.execute("DELETE FROM stock_positions")
        ts = now_iso()
        for p in positions:
            await db.execute(
                """INSERT OR REPLACE INTO stock_positions 
                (code, name, quantity, cost_price, initial_last, initial_pnl, updated_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    p["code"],
                    p.get("name", p["code"]),
                    float(p.get("quantity", 0) or 0),
                    float(p.get("cost_price", 0) or 0),
                    float(p.get("initial_last", 0) or 0) if p.get("initial_last") is not None else None,
                    float(p.get("initial_pnl", 0) or 0) if p.get("initial_pnl") is not None else None,
                    ts
                )
            )
        await db.commit()

async def load_stock_positions() -> list[dict]:
    """從 SQLite 載入快取的持股明細"""
    async with get_db_connection() as db:
        cur = await db.execute("SELECT code, name, quantity, cost_price, initial_last, initial_pnl FROM stock_positions ORDER BY code ASC")
        rows = await cur.fetchall()
        return [
            {
                "code": r["code"],
                "name": r["name"],
                "quantity": float(r["quantity"]),
                "cost_price": float(r["cost_price"]),
                "initial_last": float(r["initial_last"]) if r["initial_last"] is not None else None,
                "initial_pnl": float(r["initial_pnl"]) if r["initial_pnl"] is not None else None,
            }
            for r in rows
        ]

async def sync_group_items(group_id: str, items_data: list[tuple[str, str, str, str]]):
    """將指定群組的持股項目完全同步為 items_data: [(code, name, exchange, security_type), ...]"""
    async with get_db_connection() as db:
        await db.execute("DELETE FROM watchlist_items WHERE group_id = ?", (group_id,))
        for idx, (code, name, exchange, sec_type) in enumerate(items_data):
            i_id = str(uuid.uuid4())
            await db.execute(
                "INSERT INTO watchlist_items (id, group_id, code, name, exchange, security_type, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (i_id, group_id, code, name, exchange, sec_type, idx)
            )
        await db.execute("UPDATE watchlist_groups SET updated_at = ? WHERE id = ?", (now_iso(), group_id))
        await db.commit()

async def get_all_subscribed_codes() -> set[str]:
    async with get_db_connection() as db:
        cur = await db.execute("SELECT DISTINCT code FROM watchlist_items")
        rows = await cur.fetchall()
        return {r["code"] for r in rows}

async def create_group(name: str) -> WatchlistGroup:
    async with get_db_connection() as db:
        cur = await db.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM watchlist_groups")
        row = await cur.fetchone()
        next_pos = row[0] if row else 0
        g_id = str(uuid.uuid4())
        ts = now_iso()
        await db.execute(
            "INSERT INTO watchlist_groups (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (g_id, name, next_pos, ts, ts)
        )
        await db.commit()
        return WatchlistGroup(id=g_id, name=name, position=next_pos, createdAt=ts, updatedAt=ts, items=[])

async def update_group(group_id: str, name: str | None = None, position: int | None = None):
    async with get_db_connection() as db:
        ts = now_iso()
        if name is not None and position is not None:
            await db.execute("UPDATE watchlist_groups SET name = ?, position = ?, updated_at = ? WHERE id = ?", (name, position, ts, group_id))
        elif name is not None:
            await db.execute("UPDATE watchlist_groups SET name = ?, updated_at = ? WHERE id = ?", (name, ts, group_id))
        elif position is not None:
            await db.execute("UPDATE watchlist_groups SET position = ?, updated_at = ? WHERE id = ?", (position, ts, group_id))
        await db.commit()

async def delete_group(group_id: str):
    async with get_db_connection() as db:
        await db.execute("DELETE FROM watchlist_groups WHERE id = ?", (group_id,))
        await db.commit()

async def add_item_to_group(group_id: str, code: str, name: str, exchange: str, security_type: str) -> WatchlistItem:
    async with get_db_connection() as db:
        cur = await db.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM watchlist_items WHERE group_id = ?", (group_id,))
        row = await cur.fetchone()
        next_pos = row[0] if row else 0
        i_id = str(uuid.uuid4())
        await db.execute(
            "INSERT INTO watchlist_items (id, group_id, code, name, exchange, security_type, position) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (i_id, group_id, code, name, exchange, security_type, next_pos)
        )
        await db.execute("UPDATE watchlist_groups SET updated_at = ? WHERE id = ?", (now_iso(), group_id))
        await db.commit()
        return WatchlistItem(
            id=i_id,
            groupId=group_id,
            code=code,
            name=name,
            exchange=exchange,
            securityType=security_type,
            position=next_pos
        )

async def remove_item_from_group(group_id: str, code: str):
    async with get_db_connection() as db:
        await db.execute("DELETE FROM watchlist_items WHERE group_id = ? AND code = ?", (group_id, code))
        await db.execute("UPDATE watchlist_groups SET updated_at = ? WHERE id = ?", (now_iso(), group_id))
        await db.commit()

async def reorder_items(group_id: str, codes: list[str]):
    async with get_db_connection() as db:
        for idx, code in enumerate(codes):
            await db.execute(
                "UPDATE watchlist_items SET position = ? WHERE group_id = ? AND code = ?",
                (idx, group_id, code)
            )
        await db.execute("UPDATE watchlist_groups SET updated_at = ? WHERE id = ?", (now_iso(), group_id))
        await db.commit()
