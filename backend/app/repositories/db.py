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
        await db.execute("""
        CREATE TABLE IF NOT EXISTS smart_orders (
            id TEXT PRIMARY KEY,
            code TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            quantity INTEGER NOT NULL DEFAULT 100,
            opt1_enabled INTEGER NOT NULL DEFAULT 0,
            opt1_pct REAL,
            opt1_price REAL,
            opt2_enabled INTEGER NOT NULL DEFAULT 0,
            opt2_pct REAL,
            opt2_price REAL,
            opt3_enabled INTEGER NOT NULL DEFAULT 0,
            opt3_pct REAL,
            opt3_price REAL,
            opt3_trailing_pct REAL,
            opt4_enabled INTEGER NOT NULL DEFAULT 0,
            opt4_ma_type TEXT DEFAULT '5MA',
            status TEXT NOT NULL DEFAULT 'PENDING',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            triggered_at TEXT,
            trigger_reason TEXT,
            peak_price REAL
        );
        """)
        # 自動遷移新欄位 (若表已存在)
        for col_def in [
            ("opt1_enabled", "INTEGER DEFAULT 0"),
            ("opt1_pct", "REAL"),
            ("opt1_price", "REAL"),
            ("opt2_enabled", "INTEGER DEFAULT 0"),
            ("opt2_pct", "REAL"),
            ("opt2_price", "REAL"),
            ("opt3_enabled", "INTEGER DEFAULT 0"),
            ("opt3_pct", "REAL"),
            ("opt3_price", "REAL"),
            ("opt3_trailing_pct", "REAL"),
            ("opt4_enabled", "INTEGER DEFAULT 0"),
            ("opt4_ma_type", "TEXT DEFAULT '5MA'"),
        ]:
            try:
                await db.execute(f"ALTER TABLE smart_orders ADD COLUMN {col_def[0]} {col_def[1]}")
            except Exception:
                pass
        await db.execute("""
        CREATE INDEX IF NOT EXISTS idx_smart_orders_status ON smart_orders(status);
        """)
        await db.execute("""
        CREATE TABLE IF NOT EXISTS stock_ai_notes (
            code TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            business TEXT NOT NULL DEFAULT '',
            customers TEXT NOT NULL DEFAULT '',
            ai_relation TEXT NOT NULL DEFAULT '',
            raw_text TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """)
        await db.execute("""
        CREATE TABLE IF NOT EXISTS pocket_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            amount_twd REAL NOT NULL,
            balance_after_twd REAL NOT NULL,
            settlement_date TEXT,
            note TEXT NOT NULL DEFAULT '',
            details_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
        );
        """)
        try:
            await db.execute("ALTER TABLE pocket_ledger ADD COLUMN details_json TEXT NOT NULL DEFAULT '[]'")
        except Exception:
            pass
        await db.execute("""
        CREATE INDEX IF NOT EXISTS idx_pocket_ledger_created ON pocket_ledger(id DESC);
        """)
        await db.execute("""
        CREATE TABLE IF NOT EXISTS pocket_settlements (
            settlement_date TEXT PRIMARY KEY,
            amount_twd REAL NOT NULL DEFAULT 0.0,
            stock_summary TEXT NOT NULL DEFAULT '',
            details_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'PENDING',
            updated_at TEXT NOT NULL
        );
        """)
        await db.execute("""
        CREATE TABLE IF NOT EXISTS pocket_daily_deals (
            deal_uid TEXT PRIMARY KEY,
            trade_date TEXT NOT NULL,
            ordno TEXT NOT NULL DEFAULT '',
            code TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            qty INTEGER NOT NULL,
            price REAL NOT NULL,
            total_price REAL NOT NULL,
            fee INTEGER NOT NULL,
            tax INTEGER NOT NULL,
            net_amount REAL NOT NULL,
            net_amount_wan REAL NOT NULL,
            source TEXT NOT NULL DEFAULT 'deal_event',
            created_at TEXT NOT NULL
        );
        """)
        await db.execute("""
        CREATE INDEX IF NOT EXISTS idx_pocket_daily_deals_date ON pocket_daily_deals(trade_date);
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
            is_sys = bool(g_row["id"] in ("g-vault", "g-wealth", "g-candidate") or g_row["name"] in ("財神庫", "財神金庫", "財神簿", "選手區"))
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
    確保「財神金庫」固定為第 1 個系統群組 (position 0)
    確保「財神簿」固定為第 2 個系統群組 (position 1)
    確保「選手區」固定為第 3 個系統群組 (position 2)
    其餘自選群組從 position 3 開始 (如「大雜燴」等)
    """
    async with get_db_connection() as db:
        ts = now_iso()
        
        # 1. 處理 財神金庫 (g-vault)
        cur_v = await db.execute("SELECT id FROM watchlist_groups WHERE id = 'g-vault' OR name IN ('財神庫', '財神金庫')")
        row_v = await cur_v.fetchone()
        v_id = row_v[0] if row_v else "g-vault"

        # 2. 處理 財神簿 (g-wealth)
        cur_w = await db.execute("SELECT id FROM watchlist_groups WHERE id = 'g-wealth' OR name = '財神簿'")
        row_w = await cur_w.fetchone()
        w_id = row_w[0] if row_w else "g-wealth"

        # 3. 處理 選手區 (g-candidate)
        cur_c = await db.execute("SELECT id FROM watchlist_groups WHERE id = 'g-candidate' OR name = '選手區'")
        row_c = await cur_c.fetchone()
        c_id = row_c[0] if row_c else "g-candidate"

        if row_v:
            await db.execute("UPDATE watchlist_groups SET name = '財神金庫', position = 0, updated_at = ? WHERE id = ?", (ts, v_id))
        else:
            await db.execute(
                "INSERT INTO watchlist_groups (id, name, position, created_at, updated_at) VALUES (?, '財神金庫', 0, ?, ?)",
                (v_id, ts, ts)
            )

        if row_w:
            await db.execute("UPDATE watchlist_groups SET name = '財神簿', position = 1, updated_at = ? WHERE id = ?", (ts, w_id))
        else:
            await db.execute(
                "INSERT INTO watchlist_groups (id, name, position, created_at, updated_at) VALUES (?, '財神簿', 1, ?, ?)",
                (w_id, ts, ts)
            )

        if row_c:
            await db.execute("UPDATE watchlist_groups SET name = '選手區', position = 2, updated_at = ? WHERE id = ?", (ts, c_id))
        else:
            await db.execute(
                "INSERT INTO watchlist_groups (id, name, position, created_at, updated_at) VALUES (?, '選手區', 2, ?, ?)",
                (c_id, ts, ts)
            )

        # 重整其餘群組的連續 position (從 3 開始，大雜燴緊接在選手區右方)
        other_cur = await db.execute(
            "SELECT id FROM watchlist_groups WHERE id NOT IN (?, ?, ?) ORDER BY position ASC, created_at ASC",
            (v_id, w_id, c_id)
        )
        other_rows = await other_cur.fetchall()
        for idx, o_row in enumerate(other_rows, start=3):
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
                "SELECT id FROM watchlist_groups WHERE id NOT IN ('g-vault', 'g-wealth', 'g-candidate') AND name NOT IN ('財神庫', '財神金庫', '財神簿', '選手區')"
            )
            all_custom_rows = await cur.fetchall()
            all_custom_ids = {r[0] for r in all_custom_rows}

            # 2. 依前端傳入順序排序，若有未包含的自選群組則接在後方
            ordered_ids = [gid for gid in group_ids if gid in all_custom_ids]
            remaining_ids = [gid for gid in all_custom_ids if gid not in ordered_ids]
            final_ids = ordered_ids + remaining_ids

            # 系統固定群組: g-vault (財神金庫)=0, g-wealth (財神簿)=1, g-candidate (選手區)=2
            # 其餘自選群組依傳入順序從 position 3 開始編號
            pos = 3
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

async def get_smart_orders(status: Optional[str] = None) -> list[dict]:
    async with get_db_connection() as db:
        if status:
            cur = await db.execute("SELECT * FROM smart_orders WHERE status = ? ORDER BY created_at DESC", (status,))
        else:
            cur = await db.execute("SELECT * FROM smart_orders ORDER BY created_at DESC")
        rows = await cur.fetchall()
        return [dict(r) for r in rows]

async def create_smart_order(order_dict: dict) -> dict:
    async with get_db_connection() as db:
        await db.execute(
            """
            INSERT INTO smart_orders (
                id, code, name, quantity,
                opt1_enabled, opt1_pct, opt1_price,
                opt2_enabled, opt2_pct, opt2_price,
                opt3_enabled, opt3_pct, opt3_price, opt3_trailing_pct,
                opt4_enabled, opt4_ma_type,
                status, created_at, updated_at,
                triggered_at, trigger_reason, peak_price
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                order_dict["id"],
                order_dict["code"],
                order_dict.get("name", ""),
                order_dict.get("quantity", 100),
                1 if order_dict.get("opt1_enabled") else 0,
                order_dict.get("opt1_pct"),
                order_dict.get("opt1_price"),
                1 if order_dict.get("opt2_enabled") else 0,
                order_dict.get("opt2_pct"),
                order_dict.get("opt2_price"),
                1 if order_dict.get("opt3_enabled") else 0,
                order_dict.get("opt3_pct"),
                order_dict.get("opt3_price"),
                order_dict.get("opt3_trailing_pct"),
                1 if order_dict.get("opt4_enabled") else 0,
                order_dict.get("opt4_ma_type", "5MA"),
                order_dict.get("status", "PENDING"),
                order_dict["created_at"],
                order_dict["updated_at"],
                order_dict.get("triggered_at"),
                order_dict.get("trigger_reason"),
                order_dict.get("peak_price"),
            )
        )
        await db.commit()
        return order_dict

async def cancel_smart_order(order_id: str) -> bool:
    async with get_db_connection() as db:
        cur = await db.execute(
            "UPDATE smart_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'PENDING'",
            (now_iso(), order_id)
        )
        await db.commit()
        return cur.rowcount > 0

async def resume_smart_order(order_id: str) -> bool:
    async with get_db_connection() as db:
        cur = await db.execute(
            """
            UPDATE smart_orders
            SET status = 'PENDING',
                triggered_at = NULL,
                trigger_reason = NULL,
                peak_price = NULL,
                updated_at = ?
            WHERE id = ? AND status IN ('CANCELLED', 'TRIGGERED')
            """,
            (now_iso(), order_id)
        )
        await db.commit()
        return cur.rowcount > 0

async def update_smart_order_peak_price(order_id: str, peak_price: float) -> bool:
    async with get_db_connection() as db:
        cur = await db.execute(
            "UPDATE smart_orders SET peak_price = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'",
            (peak_price, now_iso(), order_id)
        )
        await db.commit()
        return cur.rowcount > 0

async def trigger_smart_order(order_id: str, trigger_reason: str, peak_price: Optional[float] = None) -> bool:
    ts = now_iso()
    async with get_db_connection() as db:
        if peak_price is not None:
            cur = await db.execute(
                """
                UPDATE smart_orders
                SET status = 'TRIGGERED',
                    triggered_at = ?,
                    trigger_reason = ?,
                    peak_price = ?,
                    updated_at = ?
                WHERE id = ? AND status = 'PENDING'
                """,
                (ts, trigger_reason, peak_price, ts, order_id)
            )
        else:
            cur = await db.execute(
                """
                UPDATE smart_orders
                SET status = 'TRIGGERED',
                    triggered_at = ?,
                    trigger_reason = ?,
                    updated_at = ?
                WHERE id = ? AND status = 'PENDING'
                """,
                (ts, trigger_reason, ts, order_id)
            )
        await db.commit()
        return cur.rowcount > 0

async def delete_smart_order(order_id: str) -> bool:
    async with get_db_connection() as db:
        cur = await db.execute("DELETE FROM smart_orders WHERE id = ?", (order_id,))
        await db.commit()
        return cur.rowcount > 0

async def get_stock_ai_note(code: str) -> Optional[dict]:
    async with get_db_connection() as db:
        async with db.execute("SELECT * FROM stock_ai_notes WHERE code = ?", (code,)) as cur:
            row = await cur.fetchone()
            if row:
                return dict(row)
            return None

async def get_all_stock_ai_notes() -> dict[str, dict]:
    async with get_db_connection() as db:
        async with db.execute("SELECT * FROM stock_ai_notes") as cur:
            rows = await cur.fetchall()
            return {row["code"]: dict(row) for row in rows}

async def save_stock_ai_note(code: str, name: str, business: str, customers: str, ai_relation: str, raw_text: str = "") -> dict:
    ts = now_iso()
    async with get_db_connection() as db:
        await db.execute("""
        INSERT INTO stock_ai_notes (code, name, business, customers, ai_relation, raw_text, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
            name = CASE WHEN excluded.name != '' THEN excluded.name ELSE stock_ai_notes.name END,
            business = excluded.business,
            customers = excluded.customers,
            ai_relation = excluded.ai_relation,
            raw_text = excluded.raw_text,
            updated_at = excluded.updated_at
        """, (code, name, business, customers, ai_relation, raw_text, ts, ts))
        await db.commit()
    return {
        "code": code,
        "name": name,
        "business": business,
        "customers": customers,
        "ai_relation": ai_relation,
        "raw_text": raw_text,
        "updated_at": ts
    }


async def _ensure_pocket_migrated(db: aiosqlite.Connection) -> Optional[float]:
    """若 pocket_ledger 為空但 app_settings 有舊本金，自動遷移為初始 INIT 紀錄"""
    cur = await db.execute("SELECT balance_after_twd FROM pocket_ledger ORDER BY id DESC LIMIT 1")
    row = await cur.fetchone()
    if row is not None:
        return float(row[0])

    cur_set = await db.execute("SELECT value, updated_at FROM app_settings WHERE key = 'account_capital_wan'")
    set_row = await cur_set.fetchone()
    if set_row and str(set_row[0]).strip() != "":
        cap_twd = round(float(set_row[0]) * 10000.0, 2)
        ts = str(set_row[1] or now_iso())
        await db.execute(
            "INSERT INTO pocket_ledger (event_type, amount_twd, balance_after_twd, settlement_date, note, created_at) "
            "VALUES (?, ?, ?, NULL, ?, ?)",
            ("INIT", cap_twd, cap_twd, "從舊版設定遷移初始本金", ts),
        )
        await db.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES ('account_capital_configured_at', ?, ?) "
            "ON CONFLICT(key) DO NOTHING",
            (ts, ts),
        )
        await db.commit()
        return cap_twd
    return None


async def set_pocket_initial_capital(capital_wan: float, mode: str, today_date: str) -> dict:
    """手動設定/校正口袋本金，並依 mode (before_t0/after_t0) 標記今日交割是否已計入"""
    ts = now_iso()
    cap_twd = round(capital_wan * 10000.0, 2)
    mode_norm = mode if mode in ("before_t0", "after_t0") else "after_t0"
    note = f"手動設定本金 ({'T+0 扣款後' if mode_norm == 'after_t0' else 'T+0 扣款前'})"

    async with get_db_connection() as db:
        await db.execute(
            "INSERT INTO pocket_ledger (event_type, amount_twd, balance_after_twd, settlement_date, note, created_at) "
            "VALUES (?, ?, ?, NULL, ?, ?)",
            ("INIT", cap_twd, cap_twd, note, ts),
        )
        for k, v in [
            ("account_capital_wan", str(capital_wan)),
            ("account_capital_mode", mode_norm),
            ("account_capital_configured_at", ts),
        ]:
            await db.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (k, v, ts),
            )

        if today_date:
            if mode_norm == "after_t0":
                # 今日及以前都已計入此本金，不可重複結轉
                await db.execute(
                    "UPDATE pocket_settlements SET status = 'SETTLED', updated_at = ? WHERE settlement_date <= ?",
                    (ts, today_date),
                )
                await db.execute(
                    "INSERT INTO pocket_settlements (settlement_date, amount_twd, stock_summary, details_json, status, updated_at) "
                    "VALUES (?, 0.0, '', '[]', 'SETTLED', ?) ON CONFLICT(settlement_date) DO NOTHING",
                    (today_date, ts),
                )
            else:
                # 僅今日以前已結清；今日保留 PENDING 讓格子 1 扣除並於隔日結轉
                await db.execute(
                    "UPDATE pocket_settlements SET status = 'SETTLED', updated_at = ? WHERE settlement_date < ?",
                    (ts, today_date),
                )
                await db.execute(
                    "UPDATE pocket_settlements SET status = 'PENDING', updated_at = ? WHERE settlement_date = ?",
                    (ts, today_date),
                )

        await db.commit()
    return {"capitalWan": capital_wan, "capitalMode": mode_norm, "configuredAt": ts}


async def adjust_pocket_capital(delta_wan: float, note: str = "") -> dict:
    """業外存提快捷記帳 (直接寫入 pocket_ledger 流水)"""
    ts = now_iso()
    delta_twd = round(delta_wan * 10000.0, 2)
    async with get_db_connection() as db:
        cur_twd = await _ensure_pocket_migrated(db)
        if cur_twd is None:
            raise ValueError("請先設定起始投資本金後再進行業外存提")
        new_twd = round(cur_twd + delta_twd, 2)
        event_type = "DEPOSIT" if delta_twd >= 0 else "WITHDRAW"
        final_note = note.strip() or (f"業外存入 +{delta_wan:g}萬" if delta_wan >= 0 else f"生活領出 {delta_wan:g}萬")
        await db.execute(
            "INSERT INTO pocket_ledger (event_type, amount_twd, balance_after_twd, settlement_date, note, created_at) "
            "VALUES (?, ?, ?, NULL, ?, ?)",
            (event_type, delta_twd, new_twd, final_note, ts),
        )
        new_wan = round(new_twd / 10000.0, 4)
        await db.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES ('account_capital_wan', ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (str(new_wan), ts),
        )
        await db.commit()
    return {"deltaWan": delta_wan, "balanceAfterWan": new_wan, "updatedAt": ts}


async def sync_and_rollover_pocket_settlements(
    today_date: str,
    live_settlements: list[dict],
) -> dict:
    """同步券商在途交割至本地狀態表，並自動將已過期 (settlement_date < today_date) 之 PENDING 交割款結轉入帳本"""
    import json
    ts = now_iso()
    async with get_db_connection() as db:
        settled_cash_twd = await _ensure_pocket_migrated(db)

        # 1. 將目前取得的 T+0 / T+1 / T+2 寫入或更新至 pocket_settlements
        for s in live_settlements:
            s_date = str(s.get("date") or "").strip()
            if not s_date:
                continue
            amt_twd = float(s.get("amount", 0.0) or 0.0)
            summary = str(s.get("stockSummary") or "")
            details_json = json.dumps(s.get("details") or [], ensure_ascii=False)

            cur = await db.execute(
                "SELECT status FROM pocket_settlements WHERE settlement_date = ?",
                (s_date,),
            )
            existing = await cur.fetchone()
            if existing is None:
                init_status = "PENDING"
                await db.execute(
                    "INSERT INTO pocket_settlements (settlement_date, amount_twd, stock_summary, details_json, status, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (s_date, amt_twd, summary, details_json, init_status, ts),
                )
            else:
                # 若已標記為 SETTLED (例如今日 after_t0)，保持 SETTLED 不重覆扣款，僅更新顯示明細
                await db.execute(
                    "UPDATE pocket_settlements SET amount_twd = ?, stock_summary = ?, details_json = ?, updated_at = ? "
                    "WHERE settlement_date = ?",
                    (amt_twd, summary, details_json, ts, s_date),
                )

        # 2. 自動結轉所有過期 (settlement_date < today_date) 且仍為 PENDING 的交割日
        if today_date:
            cur_pending = await db.execute(
                "SELECT settlement_date, amount_twd, stock_summary, details_json FROM pocket_settlements "
                "WHERE settlement_date < ? AND status = 'PENDING' ORDER BY settlement_date ASC",
                (today_date,),
            )
            pending_rows = await cur_pending.fetchall()
            for row in pending_rows:
                p_date = str(row[0])
                p_amt = float(row[1] or 0.0)
                p_summary = str(row[2] or "")
                p_details_json = str(row[3] or "[]")
                has_details = p_details_json not in ("", "[]")
                if settled_cash_twd is not None and (abs(p_amt) > 0.01 or has_details):
                    settled_cash_twd = round(settled_cash_twd + p_amt, 2)
                    note_label = f"{p_date} 交割自動結轉" + (f" ({p_summary})" if p_summary else "")
                    await db.execute(
                        "INSERT INTO pocket_ledger (event_type, amount_twd, balance_after_twd, settlement_date, note, details_json, created_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        ("SETTLEMENT", p_amt, settled_cash_twd, p_date, note_label, p_details_json, ts),
                    )
                    await db.execute(
                        "INSERT INTO app_settings (key, value, updated_at) VALUES ('account_capital_wan', ?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                        (str(round(settled_cash_twd / 10000.0, 4)), ts),
                    )
                await db.execute(
                    "UPDATE pocket_settlements SET status = 'SETTLED', updated_at = ? WHERE settlement_date = ?",
                    (ts, p_date),
                )

        # 3. 讀取今日 T+0 狀態 (是否已 SETTLED)
        today_settled = False
        if today_date:
            cur_t0 = await db.execute(
                "SELECT status FROM pocket_settlements WHERE settlement_date = ?",
                (today_date,),
            )
            t0_row = await cur_t0.fetchone()
            if t0_row and t0_row[0] == "SETTLED":
                today_settled = True

        # 4. 讀取最近 20 筆帳本流水
        cur_ledger = await db.execute(
            "SELECT id, event_type, amount_twd, balance_after_twd, settlement_date, note, details_json, created_at "
            "FROM pocket_ledger ORDER BY id DESC LIMIT 20"
        )
        ledger_rows = []
        for r in await cur_ledger.fetchall():
            item_dict = dict(r)
            try:
                item_dict["details"] = json.loads(item_dict.pop("details_json", "[]") or "[]")
            except Exception:
                item_dict["details"] = []
            ledger_rows.append(item_dict)

        # 5. 讀取設定時間與模式
        cur_cfg = await db.execute(
            "SELECT key, value FROM app_settings WHERE key IN ('account_capital_mode', 'account_capital_configured_at')"
        )
        cfg_map = {r[0]: r[1] for r in await cur_cfg.fetchall()}

        # 6. 讀取本地儲存的歷史明細 (供 T+0 / T+1 補齊明細)
        cur_hist = await db.execute(
            "SELECT settlement_date, details_json, stock_summary FROM pocket_settlements WHERE settlement_date >= ?",
            (today_date or "1970-01-01",),
        )
        local_details_map = {}
        for r in await cur_hist.fetchall():
            try:
                local_details_map[r[0]] = {
                    "details": json.loads(r[1] or "[]"),
                    "stockSummary": r[2] or "",
                }
            except Exception:
                pass

        await db.commit()

    return {
        "settledCashTwd": settled_cash_twd,
        "todaySettled": today_settled,
        "capitalMode": cfg_map.get("account_capital_mode", "after_t0"),
        "configuredAt": cfg_map.get("account_capital_configured_at", ""),
        "ledger": ledger_rows,
        "localDetailsMap": local_details_map,
    }


async def record_intraday_deal_event(
    trade_date: str,
    deal_uid: str,
    ordno: str,
    code: str,
    name: str,
    action: str,
    qty: int,
    price: float,
    total_price: float,
    fee: int,
    tax: int,
    net_amount: float,
) -> None:
    """即時記錄 Shioaji 盤中成交回報 (以真實零股/整股成交價與股數為準)"""
    ts = now_iso()
    async with get_db_connection() as db:
        await db.execute(
            """
            INSERT INTO pocket_daily_deals (
                deal_uid, trade_date, ordno, code, name, action,
                qty, price, total_price, fee, tax, net_amount, net_amount_wan, source, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deal_event', ?)
            ON CONFLICT(deal_uid) DO NOTHING
            """,
            (
                deal_uid,
                trade_date,
                ordno,
                code,
                name,
                action,
                qty,
                price,
                round(total_price, 2),
                fee,
                tax,
                round(net_amount, 2),
                round(net_amount / 10000.0, 4),
                ts,
            ),
        )
        await db.commit()


async def sync_today_trades_snapshot(trade_date: str, deals: list[dict]) -> None:
    """將 list_trades() 取得的今日真實成交明細同步寫入 pocket_daily_deals (覆蓋同日舊 snapshot)"""
    if not trade_date or not deals:
        return
    ts = now_iso()
    async with get_db_connection() as db:
        await db.execute(
            "DELETE FROM pocket_daily_deals WHERE trade_date = ? AND source = 'list_trades'",
            (trade_date,),
        )
        for idx, d in enumerate(deals):
            ordno = str(d.get("ordno") or "")
            uid = f"{trade_date}_lt_{ordno or idx}_{d.get('code','')}_{d.get('action','')}"
            net_amt = float(d.get("netAmount", 0.0) or 0.0)
            await db.execute(
                """
                INSERT INTO pocket_daily_deals (
                    deal_uid, trade_date, ordno, code, name, action,
                    qty, price, total_price, fee, tax, net_amount, net_amount_wan, source, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'list_trades', ?)
                ON CONFLICT(deal_uid) DO UPDATE SET
                    qty = excluded.qty,
                    price = excluded.price,
                    total_price = excluded.total_price,
                    fee = excluded.fee,
                    tax = excluded.tax,
                    net_amount = excluded.net_amount,
                    net_amount_wan = excluded.net_amount_wan
                """,
                (
                    uid,
                    trade_date,
                    ordno,
                    str(d.get("code") or ""),
                    str(d.get("name") or ""),
                    str(d.get("action") or "Buy"),
                    int(d.get("qty") or 0),
                    float(d.get("price") or 0.0),
                    float(d.get("totalPrice") or 0.0),
                    int(d.get("fee") or 0),
                    int(d.get("tax") or 0),
                    round(net_amt, 2),
                    round(net_amt / 10000.0, 4),
                    ts,
                ),
            )
        await db.commit()


async def get_recorded_deals_by_date(days: int = 10) -> dict[str, list[dict]]:
    """讀取本地紀錄的盤中真實成交明細 (按交易日分組，list_trades 優先於同 ordno 之 deal_event)"""
    from datetime import date, timedelta
    cutoff = (date.today() - timedelta(days=days)).isoformat()
    async with get_db_connection() as db:
        cur = await db.execute(
            """
            SELECT trade_date, ordno, code, name, action, qty, price, total_price, fee, tax, net_amount, net_amount_wan, source
            FROM pocket_daily_deals
            WHERE trade_date >= ?
            ORDER BY created_at ASC
            """,
            (cutoff,),
        )
        rows = await cur.fetchall()

    by_date_raw: dict[str, list[dict]] = {}
    for r in rows:
        by_date_raw.setdefault(r[0], []).append({
            "tradeDate": r[0],
            "ordno": r[1],
            "code": r[2],
            "name": r[3],
            "action": r[4],
            "qty": r[5],
            "price": r[6],
            "totalPrice": r[7],
            "fee": r[8],
            "tax": r[9],
            "netAmount": r[10],
            "netAmountWan": r[11],
            "source": r[12],
        })

    result: dict[str, list[dict]] = {}
    for t_date, items in by_date_raw.items():
        lt_items = [x for x in items if x["source"] == "list_trades"]
        lt_ordnos = {x["ordno"] for x in lt_items if x["ordno"]}
        ev_items = [x for x in items if x["source"] == "deal_event" and (not x["ordno"] or x["ordno"] not in lt_ordnos)]
        combined = lt_items + ev_items
        for x in combined:
            x.pop("source", None)
            x.pop("ordno", None)
            x.pop("tradeDate", None)
        if combined:
            result[t_date] = combined
    return result




