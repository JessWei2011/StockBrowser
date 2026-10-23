import asyncio
import datetime
import html
import logging
import re
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Optional
import aiosqlite
import requests

from backend.app.repositories.db import get_db_connection

logger = logging.getLogger("news_service")

# 支援的主要新聞來源
RSS_FEEDS = [
    {
        "source": "Yahoo股市",
        "url": "https://tw.stock.yahoo.com/rss?category=tw-market",
        "type": "yahoo"
    },
    {
        "source": "工商時報",
        "url": "https://www.ctee.com.tw/rss_web/livenews/ctee",
        "type": "ctee"
    }
]

def clean_html(raw_html: str) -> str:
    """去除 HTML 標籤並還原跳脫字元"""
    if not raw_html:
        return ""
    text = re.sub(r'<[^>]+>', '', raw_html)
    return html.unescape(text).strip()

class NewsService:
    def __init__(self):
        self._cache: Dict[str, Any] = {"dates": [], "by_date": {}, "timestamp": 0}
        self._lock = asyncio.Lock()

    async def init_table(self):
        """建立新聞快取資料表，自動滾動保留最新 5 個有新聞的交易日"""
        async with get_db_connection() as db:
            await db.execute("""
            CREATE TABLE IF NOT EXISTS financial_news (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                title TEXT NOT NULL,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                detail TEXT,
                link TEXT,
                created_at TEXT NOT NULL
            );
            """)
            await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_financial_news_date ON financial_news(date DESC);
            """)
            await db.commit()

    def _fetch_rss_sync(self) -> List[Dict[str, Any]]:
        """同步抓取 RSS 來源"""
        tz_tw = datetime.timezone(datetime.timedelta(hours=8))
        items: List[Dict[str, Any]] = []

        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)"
        }

        for feed in RSS_FEEDS:
            try:
                r = requests.get(feed["url"], headers=headers, timeout=6)
                if r.status_code != 200:
                    continue
                root = ET.fromstring(r.content)
                for it in root.findall(".//item"):
                    title_elem = it.find("title")
                    pubdate_elem = it.find("pubDate")
                    desc_elem = it.find("description")
                    link_elem = it.find("link")

                    raw_title = title_elem.text.strip() if title_elem is not None and title_elem.text else ""
                    if not raw_title:
                        continue
                    clean_title = clean_html(raw_title)

                    raw_desc = desc_elem.text.strip() if desc_elem is not None and desc_elem.text else ""
                    clean_desc = clean_html(raw_desc)

                    link = link_elem.text.strip() if link_elem is not None and link_elem.text else ""

                    date_str = ""
                    time_str = ""
                    if pubdate_elem is not None and pubdate_elem.text:
                        raw_date = pubdate_elem.text.strip()
                        try:
                            dt = parsedate_to_datetime(raw_date).astimezone(tz_tw)
                            date_str = dt.strftime("%Y-%m-%d")
                            time_str = dt.strftime("%H:%M")
                        except Exception:
                            # 部分 ISO 格式處理
                            try:
                                dt = datetime.datetime.fromisoformat(raw_date.replace("Z", "+00:00")).astimezone(tz_tw)
                                date_str = dt.strftime("%Y-%m-%d")
                                time_str = dt.strftime("%H:%M")
                            except Exception:
                                pass

                    if not date_str:
                        now_tw = datetime.datetime.now(tz_tw)
                        date_str = now_tw.strftime("%Y-%m-%d")
                        time_str = now_tw.strftime("%H:%M")

                    # 以連結或標題 hash 作為唯一鍵
                    import hashlib
                    unique_id = hashlib.md5(f"{clean_title}_{date_str}_{feed['source']}".encode()).hexdigest()

                    items.append({
                        "id": unique_id,
                        "source": feed["source"],
                        "title": clean_title,
                        "date": date_str,
                        "time": time_str,
                        "detail": clean_desc,
                        "link": link
                    })
            except Exception as e:
                logger.warning(f"Failed to fetch RSS from {feed['source']}: {e}")

        return items

    async def refresh_news(self) -> None:
        """更新新聞，儲存至 SQLite，並滾動保留最新 5 個日期"""
        await self.init_table()
        loop = asyncio.get_running_loop()
        new_items = await loop.run_in_executor(None, self._fetch_rss_sync)

        if not new_items:
            return

        now_iso = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat()

        async with get_db_connection() as db:
            for it in new_items:
                await db.execute("""
                INSERT INTO financial_news (id, source, title, date, time, detail, link, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    detail = excluded.detail,
                    link = excluded.link
                """, (it["id"], it["source"], it["title"], it["date"], it["time"], it["detail"], it["link"], now_iso))
            await db.commit()

            # 滾動保留最新 5 個日期 (降冪前 5 日)，刪除更早以前的歷史新聞
            cursor = await db.execute("SELECT DISTINCT date FROM financial_news ORDER BY date DESC LIMIT 5")
            rows = await cursor.fetchall()
            valid_dates = [r[0] for r in rows]

            if valid_dates:
                placeholders = ",".join(["?"] * len(valid_dates))
                await db.execute(f"DELETE FROM financial_news WHERE date NOT IN ({placeholders})", valid_dates)
                await db.commit()

    async def get_news(self, target_date: Optional[str] = None) -> Dict[str, Any]:
        """取得 5 天內的財經新聞。若無資料或快取過期 (> 10 分鐘) 則先更新"""
        await self.init_table()

        async with get_db_connection() as db:
            cursor = await db.execute("SELECT COUNT(*) FROM financial_news")
            row = await cursor.fetchone()
            count = row[0] if row else 0

        # 若無資料，立即抓取一次
        if count == 0:
            await self.refresh_news()

        async with get_db_connection() as db:
            # 取得保留的最新日期清單 (降冪)
            cursor = await db.execute("SELECT DISTINCT date FROM financial_news ORDER BY date DESC LIMIT 5")
            rows = await cursor.fetchall()
            available_dates = [r[0] for r in rows]

            active_date = target_date if target_date and target_date in available_dates else (available_dates[0] if available_dates else "")

            news_list: List[Dict[str, Any]] = []
            if active_date:
                cursor = await db.execute("""
                SELECT id, source, title, date, time, detail, link
                FROM financial_news
                WHERE date = ?
                ORDER BY time DESC, id DESC
                """, (active_date,))
                news_rows = await cursor.fetchall()
                for nr in news_rows:
                    news_list.append({
                        "id": nr["id"],
                        "source": nr["source"],
                        "title": nr["title"],
                        "date": nr["date"],
                        "time": nr["time"],
                        "detail": nr["detail"],
                        "link": nr["link"]
                    })

        return {
            "dates": available_dates,
            "selectedDate": active_date,
            "totalCount": len(news_list),
            "news": news_list
        }

news_service = NewsService()
