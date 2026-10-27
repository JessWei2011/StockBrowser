import asyncio
import aiosqlite
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from backend.app.settings import settings
from backend.app.domain.models import WatchlistGroup, WatchlistItem

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

class _LoopBoundLock:
    """自動適配當前執行事件迴圈之非同步鎖，防止跨測試或多迴圈生命週期造成 'bound to a different event loop'"""
    def __init__(self):
        self._locks: dict[asyncio.AbstractEventLoop, asyncio.Lock] = {}

    def _get_lock(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        lock = self._locks.get(loop)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[loop] = lock
        return lock

    async def acquire(self) -> bool:
        return await self._get_lock().acquire()

    def release(self):
        return self._get_lock().release()

    def locked(self) -> bool:
        try:
            return self._get_lock().locked()
        except RuntimeError:
            return False

    async def __aenter__(self):
        await self.acquire()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        self.release()

_item_pos_lock = _LoopBoundLock()
_group_pos_lock = _LoopBoundLock()

@asynccontextmanager
async def get_db_connection():
    settings.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(settings.DB_PATH, timeout=10.0) as db:
        await db.execute("PRAGMA journal_mode = WAL;")
        await db.execute("PRAGMA busy_timeout = 5000;")
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
        await db.execute("""
        CREATE TABLE IF NOT EXISTS stock_announcements (
            id TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            tag TEXT NOT NULL,
            title TEXT NOT NULL,
            date TEXT,
            detail TEXT,
            category TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """)
        await db.execute("""
        CREATE INDEX IF NOT EXISTS idx_announcements_code ON stock_announcements(code);
        """)
        await db.execute("""
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
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

def is_dimmed_asset(code: str, sec_type: str = "") -> bool:
    """判斷是否為長期持有/暗色標的 (ETF、債券、虎航 6757)"""
    c = (code or "").upper()
    s = (sec_type or "").upper()
    return c.startswith("00") or "B" in c or s in ("ETF", "BOND") or c == "6757"

async def sync_group_items(group_id: str, items_data: list[tuple[str, str, str, str]]):
    """
    將指定群組的持股項目同步為 items_data: [(code, name, exchange, security_type), ...]
    【重點】：完整保留使用者已排定的自訂排序 (position)，絕不在同步或重啟時被覆蓋重設！
    - 若已有使用者自訂排序：依照既有 position 排序，新進股票接續在後。
    - 若為首次初始化或尚無排序：將一般個股置於上方，ETF、債券、虎航自動排至最下方。
    """
    async with _item_pos_lock:
        async with get_db_connection() as db:
            cur = await db.execute(
                "SELECT id, code, position FROM watchlist_items WHERE group_id = ?",
                (group_id,)
            )
            existing_rows = await cur.fetchall()
            existing_map = {r["code"]: (r["id"], r["position"]) for r in existing_rows}
            incoming_codes = {item[0] for item in items_data}

            # 1. 移除已不再持有的股票
            for code in set(existing_map.keys()) - incoming_codes:
                await db.execute(
                    "DELETE FROM watchlist_items WHERE group_id = ? AND code = ?",
                    (group_id, code)
                )

            # 2. 計算排序權重 (有自訂排序者優先保留；新標的一般股在前、ETF/債券/虎航在後)
            def sort_key(item_tuple):
                code, name, exchange, sec_type = item_tuple
                if code in existing_map:
                    return (0, existing_map[code][1], code)
                dimmed = is_dimmed_asset(code, sec_type)
                # 次排序：普通股 (0), ETF (1), 債券 (2), 虎航 (3)
                sub_tier = 0
                if code == "6757":
                    sub_tier = 3
                elif "B" in code.upper() or sec_type.upper() == "BOND":
                    sub_tier = 2
                elif code.startswith("00") or sec_type.upper() == "ETF":
                    sub_tier = 1
                return (1, sub_tier, code)

            sorted_items = sorted(items_data, key=sort_key)

            # 3. 更新既有項目或插入新項目，連續正規化 position (0, 1, 2, ...)
            ts = now_iso()
            for idx, (code, name, exchange, sec_type) in enumerate(sorted_items):
                if code in existing_map:
                    await db.execute(
                        """UPDATE watchlist_items 
                        SET name = ?, exchange = ?, security_type = ?, position = ? 
                        WHERE group_id = ? AND code = ?""",
                        (name, exchange, sec_type, idx, group_id, code)
                    )
                else:
                    new_id = str(uuid.uuid4())
                    await db.execute(
                        """INSERT INTO watchlist_items 
                        (id, group_id, code, name, exchange, security_type, position) 
                        VALUES (?, ?, ?, ?, ?, ?, ?)""",
                        (new_id, group_id, code, name, exchange, sec_type, idx)
                    )

            await db.execute("UPDATE watchlist_groups SET updated_at = ? WHERE id = ?", (ts, group_id))
            await db.commit()

async def get_all_subscribed_codes() -> set[str]:
    async with get_db_connection() as db:
        cur = await db.execute("SELECT DISTINCT code FROM watchlist_items")
        rows = await cur.fetchall()
        return {r["code"] for r in rows}

async def create_group(name: str) -> WatchlistGroup:
    async with _group_pos_lock:
        async with get_db_connection() as db:
            g_id = str(uuid.uuid4())
            ts = now_iso()
            cur = await db.execute(
                """INSERT INTO watchlist_groups (id, name, position, created_at, updated_at)
                VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM watchlist_groups), ?, ?)
                RETURNING position""",
                (g_id, name, ts, ts)
            )
            row = await cur.fetchone()
            next_pos = row[0] if row else 0
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

async def reorder_groups(group_ids: list[str]):
    async with _group_pos_lock:
        async with get_db_connection() as db:
            ts = now_iso()
            # 1. 取得所有非系統自選群組 ID
            cur = await db.execute(
                "SELECT id FROM watchlist_groups WHERE id NOT IN ('g-vault', 'g-wealth') AND name NOT IN ('財神庫', '財神簿')"
            )
            all_custom_rows = await cur.fetchall()
            all_custom_ids = {r[0] for r in all_custom_rows}

            # 2. 依前端傳入順序排序，若有未包含的自選群組則接在後方
            ordered_ids = [gid for gid in group_ids if gid in all_custom_ids]
            remaining_ids = [gid for gid in all_custom_ids if gid not in ordered_ids]
            final_ids = ordered_ids + remaining_ids

            # 系統固定群組: g-vault (財神庫)=0, g-wealth (財神簿)=1
            # 其餘自選群組依傳入順序從 position 2 開始編號
            pos = 2
            for gid in final_ids:
                await db.execute("UPDATE watchlist_groups SET position = ?, updated_at = ? WHERE id = ?", (pos, ts, gid))
                pos += 1
            await db.commit()

async def delete_group(group_id: str):
    async with get_db_connection() as db:
        await db.execute("DELETE FROM watchlist_groups WHERE id = ?", (group_id,))
        await db.commit()

async def add_item_to_group(group_id: str, code: str, name: str, exchange: str, security_type: str) -> WatchlistItem:
    async with _item_pos_lock:
        async with get_db_connection() as db:
            # 1. 檢查群組是否存在
            cur_g = await db.execute("SELECT id FROM watchlist_groups WHERE id = ?", (group_id,))
            if not await cur_g.fetchone():
                raise KeyError(f"自選群組不存在 (ID: {group_id})")

            # 2. 檢查是否重複加入
            cur_exist = await db.execute("SELECT id FROM watchlist_items WHERE group_id = ? AND code = ?", (group_id, code))
            if await cur_exist.fetchone():
                raise ValueError(f"該股票 ({code}) 已存在於此群組中，無需重複新增")

            i_id = str(uuid.uuid4())
            cur = await db.execute(
                """INSERT INTO watchlist_items (id, group_id, code, name, exchange, security_type, position)
                VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM watchlist_items WHERE group_id = ?))
                RETURNING position""",
                (i_id, group_id, code, name, exchange, security_type, group_id)
            )
            row = await cur.fetchone()
            next_pos = row[0] if row else 0
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
    async with _item_pos_lock:
        async with get_db_connection() as db:
            await db.execute("DELETE FROM watchlist_items WHERE group_id = ? AND code = ?", (group_id, code))
            await db.execute("UPDATE watchlist_groups SET updated_at = ? WHERE id = ?", (now_iso(), group_id))
            await db.commit()

async def reorder_items(group_id: str, codes: list[str]):
    async with _item_pos_lock:
        async with get_db_connection() as db:
            target_group_ids = [group_id]
            if group_id in ("g-vault", "g-wealth"):
                target_group_ids = ["g-vault", "g-wealth"]

            ts = now_iso()
            for gid in target_group_ids:
                for idx, code in enumerate(codes):
                    await db.execute(
                        "UPDATE watchlist_items SET position = ? WHERE group_id = ? AND code = ?",
                        (idx, gid, code)
                    )
                await db.execute("UPDATE watchlist_groups SET updated_at = ? WHERE id = ?", (ts, gid))
            await db.commit()

async def get_setting(key: str) -> Optional[str]:
    async with get_db_connection() as db:
        cur = await db.execute("SELECT value FROM app_settings WHERE key = ?", (key,))
        row = await cur.fetchone()
        return row[0] if row else None

async def set_setting(key: str, value: str):
    async with get_db_connection() as db:
        await db.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, value, now_iso())
        )
        await db.commit()
