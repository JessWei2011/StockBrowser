import asyncio
import logging
from datetime import datetime, date, timedelta
from typing import Optional, Any
import urllib.request
import json
import re
import concurrent.futures
import aiosqlite
import yfinance as yf

from backend.app.settings import settings
from backend.app.repositories import db
from backend.app.domain.models import StockAnnouncementItem

logger = logging.getLogger("announcement_service")

def format_chinese_amount(val: Any) -> str:
    """將大數額（千萬、億、兆）轉換為直觀的中文字符單位，避免一堆0難以閱讀"""
    if val is None or val == "":
        return ""
    try:
        num = float(val)
    except (ValueError, TypeError):
        return str(val)

    if abs(num) >= 1_000_000_000_000:  # 兆
        t = num / 1_000_000_000_000
        formatted = f"{t:.2f}".rstrip("0").rstrip(".")
        return f"{formatted} 兆"
    elif abs(num) >= 100_000_000:  # 億
        y = num / 100_000_000
        formatted = f"{y:.2f}".rstrip("0").rstrip(".")
        return f"{formatted} 億"
    elif abs(num) >= 10_000:  # 萬
        w = num / 10_000
        formatted = f"{w:.2f}".rstrip("0").rstrip(".")
        return f"{formatted} 萬"
    else:
        return f"{num:,.2f}".rstrip("0").rstrip(".")

class AnnouncementService:
    def __init__(self):
        # 內存快取: code -> list[dict]
        self._cache: dict[str, list[dict]] = {}
        self._bg_task: Optional[asyncio.Task] = None
        self._is_running = False
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=5)

    def get_announcements_for_code(self, code: str) -> list[dict]:
        return self._cache.get(code, [])

    def get_all_announcements(self) -> dict[str, list[dict]]:
        return self._cache

    async def start(self):
        self._is_running = True
        # 啟動時先從 DB 載入快取
        await self.load_from_db()
        # 啟動非同步抓取工作（不阻塞伺服器啟動）
        asyncio.create_task(self.refresh_all_announcements(reason="startup"))
        # 啟動每日 08:30 自動排程
        self._bg_task = asyncio.create_task(self._schedule_loop())
        logger.info("AnnouncementService started with daily 08:30 scheduler.")

    async def stop(self):
        self._is_running = False
        if self._bg_task and not self._bg_task.done():
            self._bg_task.cancel()
            try:
                await self._bg_task
            except asyncio.CancelledError:
                pass
        self._executor.shutdown(wait=False)
        logger.info("AnnouncementService stopped.")

    async def _schedule_loop(self):
        """每天台灣時間 08:30 準時自動執行一次爬取最新消息"""
        while self._is_running:
            try:
                now = datetime.now()
                # 計算下一個 08:30 的時間點
                target = now.replace(hour=8, minute=30, second=0, microsecond=0)
                if now >= target:
                    target += timedelta(days=1)
                wait_seconds = (target - now).total_seconds()
                logger.info(f"Next announcement refresh scheduled at {target.strftime('%Y-%m-%d %H:%M:%S')} (in {wait_seconds:.1f}s)")
                
                await asyncio.sleep(wait_seconds)
                if self._is_running:
                    logger.info("Executing scheduled pre-market 08:30 announcements refresh...")
                    await self.refresh_all_announcements(reason="scheduled_0830")
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in announcement schedule loop: {e}", exc_info=True)
                await asyncio.sleep(60)

    async def load_from_db(self):
        """從 SQLite 資料庫載入快取的公告"""
        try:
            async with db.get_db_connection() as conn:
                cursor = await conn.execute(
                    "SELECT id, code, tag, title, date, detail, category, updated_at FROM stock_announcements ORDER BY date DESC, id DESC"
                )
                rows = await cursor.fetchall()
                cache: dict[str, list[dict]] = {}
                for r in rows:
                    item = {
                        "id": r["id"],
                        "code": r["code"],
                        "tag": r["tag"],
                        "title": r["title"],
                        "date": r["date"],
                        "detail": r["detail"] or "",
                        "category": r["category"],
                        "updatedAt": r["updated_at"],
                    }
                    cache.setdefault(r["code"], []).append(item)
                self._cache = cache
                logger.info(f"Loaded {len(rows)} announcements for {len(cache)} stocks from DB.")
        except Exception as e:
            logger.warning(f"Failed to load announcements from DB: {e}")

    async def save_to_db(self, all_items: list[dict]):
        """將最新公告批次存入 SQLite 資料庫 (替換舊資料)"""
        try:
            ts = db.now_iso()
            async with db.get_db_connection() as conn:
                await conn.execute("DELETE FROM stock_announcements")
                for it in all_items:
                    await conn.execute(
                        """
                        INSERT INTO stock_announcements (id, code, tag, title, date, detail, category, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            it["id"],
                            it["code"],
                            it["tag"],
                            it["title"],
                            it.get("date"),
                            it.get("detail", ""),
                            it["category"],
                            ts,
                        ),
                    )
                await conn.commit()
            logger.info(f"Saved {len(all_items)} announcements to DB.")
        except Exception as e:
            logger.error(f"Failed to save announcements to DB: {e}")

    async def refresh_all_announcements(self, reason: str = "manual") -> dict[str, list[dict]]:
        """全量抓取所有追蹤個股的公告：注意、處置、重大訊息、除權息預告、財報/法說會日程"""
        logger.info(f"Starting announcements refresh (reason: {reason})...")
        wanted_codes = await db.get_all_subscribed_codes()
        if not wanted_codes:
            logger.info("No subscribed codes in watchlist.")
            return {}

        loop = asyncio.get_running_loop()
        # 1. 抓取注意與處置 (Shioaji + TPEx 雙重備援)
        shioaji_items = await loop.run_in_executor(self._executor, self._fetch_shioaji_notice_punish, wanted_codes)
        tpex_punish_items = await loop.run_in_executor(self._executor, self._fetch_tpex_notice_punish, wanted_codes)
        # 2. 抓取證交所與櫃買中心重大訊息
        twse_news_items = await loop.run_in_executor(self._executor, self._fetch_twse_material_news, wanted_codes)
        tpex_news_items = await loop.run_in_executor(self._executor, self._fetch_tpex_material_news, wanted_codes)
        # 3. 抓取證交所與櫃買中心每月最新自結營收
        revenue_items = await loop.run_in_executor(self._executor, self._fetch_twse_monthly_revenue, wanted_codes)
        tpex_revenue_items = await loop.run_in_executor(self._executor, self._fetch_tpex_monthly_revenue, wanted_codes)
        # 4. 抓取證交所與櫃買中心除權除息預告
        exdiv_items = await loop.run_in_executor(self._executor, self._fetch_twse_exdividend, wanted_codes)
        tpex_exdiv_items = await loop.run_in_executor(self._executor, self._fetch_tpex_exdividend, wanted_codes)
        # 5. 抓取個股財報與行事曆 (yfinance)
        calendar_items = await loop.run_in_executor(self._executor, self._fetch_yfinance_calendar, wanted_codes)

        # 彙整合併
        combined_by_code: dict[str, list[dict]] = {}
        all_flat: list[dict] = []

        all_sources = [
            shioaji_items,
            tpex_punish_items,
            twse_news_items,
            tpex_news_items,
            revenue_items,
            tpex_revenue_items,
            exdiv_items,
            tpex_exdiv_items,
            calendar_items,
        ]

        seen_ids = set()
        for item_list in all_sources:
            for it in item_list:
                it_id = it.get("id")
                if it_id and it_id in seen_ids:
                    continue
                if it_id:
                    seen_ids.add(it_id)
                c = it["code"]
                combined_by_code.setdefault(c, []).append(it)
                all_flat.append(it)

        self._cache = combined_by_code
        await self.save_to_db(all_flat)
        logger.info(f"Announcements refresh complete. Total {len(all_flat)} items for {len(combined_by_code)} stocks.")
        return self._cache

    def _fetch_shioaji_notice_punish(self, wanted_codes: set[str]) -> list[dict]:
        """從永豐 Shioaji 撈取注意股票與處置股票全文（已結束者自動排除）"""
        results: list[dict] = []
        today = date.today()
        try:
            from backend.app.services.shioaji_adapter import shioaji_adapter
            api = getattr(shioaji_adapter, "_api", None)
            if not api or not shioaji_adapter.is_logged_in:
                return results

            # 處置股票
            try:
                p = api.punish()
                if p and "code" in p:
                    codes = p["code"]
                    for idx, c in enumerate(codes):
                        code = str(c).strip()
                        if code in wanted_codes:
                            start_d = p["start_date"][idx] if idx < len(p["start_date"]) else None
                            end_d = p["end_date"][idx] if idx < len(p["end_date"]) else None
                            # 處置結束日小於今天，隔天即過期不顯示
                            if end_d and end_d < today:
                                continue
                            period_str = ""
                            if start_d and end_d:
                                period_str = f"{start_d.strftime('%m/%d')}~{end_d.strftime('%m/%d')}"
                            interval = p["interval"][idx] if idx < len(p["interval"]) else ""
                            desc = p["description"][idx] if idx < len(p["description"]) else ""
                            results.append({
                                "id": f"disp-{code}-{start_d}",
                                "code": code,
                                "tag": f"處置 {period_str}".strip(),
                                "title": f"處置股票 ({interval}撮合)" if interval else "處置股票",
                                "date": str(start_d) if start_d else "",
                                "detail": desc.replace("\r\n", "\n").strip(),
                                "category": "disposition",
                            })
            except Exception as pe:
                logger.warning(f"Error fetching Shioaji punish: {pe}")

            # 注意股票 (注意公告通常為當日有效，超過 3 天未再次列入則視為解除)
            try:
                n = api.notice()
                if n and "code" in n:
                    codes = n["code"]
                    for idx, c in enumerate(codes):
                        code = str(c).strip()
                        if code in wanted_codes:
                            ann_d = n["announced_date"][idx] if idx < len(n["announced_date"]) else None
                            if ann_d and (today - ann_d).days > 3:
                                continue
                            reason = n["reason"][idx] if idx < len(n["reason"]) else ""
                            close_p = n["close"][idx] if idx < len(n["close"]) else None
                            results.append({
                                "id": f"att-{code}-{ann_d}",
                                "code": code,
                                "tag": "注意",
                                "title": f"注意股票 (收盤價: {close_p})" if close_p else "注意股票",
                                "date": str(ann_d) if ann_d else "",
                                "detail": reason.strip(),
                                "category": "attention",
                            })
            except Exception as ne:
                logger.warning(f"Error fetching Shioaji notice: {ne}")

        except Exception as e:
            logger.warning(f"Error in _fetch_shioaji_notice_punish: {e}")
        return results

    def _fetch_tpex_notice_punish(self, wanted_codes: set[str]) -> list[dict]:
        """從櫃買中心 TPEx OpenAPI 撈取上櫃注意與處置股票 (補足與備援)"""
        results: list[dict] = []
        today = date.today()

        # 1. TPEx 處置股票
        try:
            url = "https://www.tpex.org.tw/openapi/v1/tpex_disposal_information"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("SecuritiesCompanyCode", "")).strip()
                    if c in wanted_codes:
                        period_str = str(it.get("DispositionPeriod", "")).strip()
                        end_d = None
                        start_d_str = ""
                        if "~" in period_str:
                            s_part, e_part = period_str.split("~", 1)
                            s_part, e_part = s_part.strip(), e_part.strip()
                            if len(s_part) == 7:
                                start_d_str = f"{int(s_part[3:5])}/{int(s_part[5:])}"
                            if len(e_part) == 7:
                                ey = int(e_part[:3]) + 1911
                                em = int(e_part[3:5])
                                ed = int(e_part[5:])
                                end_d = date(ey, em, ed)
                                end_d_str = f"{em}/{ed}"
                                period_label = f"{start_d_str}~{end_d_str}" if start_d_str else period_str
                            else:
                                period_label = period_str
                        else:
                            period_label = period_str

                        # 結束當天過後不顯示
                        if end_d and end_d < today:
                            continue

                        cond = str(it.get("DisposalCondition", "")).strip()
                        reasons = str(it.get("DispositionReasons", "")).strip()
                        detail_text = cond if cond else reasons

                        results.append({
                            "id": f"disp-{c}-{period_str}",
                            "code": c,
                            "tag": f"處置 {period_label}".strip(),
                            "title": "上櫃處置股票",
                            "date": str(it.get("Date", "")),
                            "detail": detail_text.replace("\r\n", "\n").strip(),
                            "category": "disposition",
                        })
        except Exception as e:
            logger.warning(f"Error fetching TPEx disposal: {e}")

        # 2. TPEx 注意股票
        try:
            url = "https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("SecuritiesCompanyCode", "")).strip()
                    if c in wanted_codes:
                        d_raw = str(it.get("Date", "")).strip()
                        d_obj = None
                        if len(d_raw) == 7:
                            yy = int(d_raw[:3]) + 1911
                            mm = int(d_raw[3:5])
                            dd = int(d_raw[5:])
                            d_obj = date(yy, mm, dd)
                        if d_obj and (today - d_obj).days > 3:
                            continue

                        close_p = it.get("ClosePrice", "")
                        info = str(it.get("TradingInformation", "")).strip()

                        results.append({
                            "id": f"att-{c}-{d_raw}",
                            "code": c,
                            "tag": "注意",
                            "title": f"上櫃注意股票 (收盤價: {close_p})" if close_p else "上櫃注意股票",
                            "date": d_obj.strftime("%Y-%m-%d") if d_obj else d_raw,
                            "detail": info.replace("\r\n", "\n").strip(),
                            "category": "attention",
                        })
        except Exception as e:
            logger.warning(f"Error fetching TPEx warning: {e}")

        return results

    def _fetch_twse_material_news(self, wanted_codes: set[str]) -> list[dict]:
        """從證交所 OpenAPI 撈取最新重大訊息全文 (僅保留 3 日內最新消息)"""
        results: list[dict] = []
        today = date.today()
        try:
            url = "https://openapi.twse.com.tw/v1/opendata/t187ap04_L"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("公司代號", "")).strip()
                    if c in wanted_codes:
                        date_raw = str(it.get("發言日期", "")).strip()
                        time_raw = str(it.get("發言時間", "")).strip()
                        subj = (it.get("主旨 ") or it.get("主旨") or "").strip()
                        desc = it.get("說明", "").strip()
                        fmt_date = date_raw
                        d_obj = None
                        if len(date_raw) == 7:  # 民國 1151011
                            yy = int(date_raw[:3]) + 1911
                            mm = int(date_raw[3:5])
                            dd = int(date_raw[5:])
                            fmt_date = f"{yy}-{mm:02d}-{dd:02d}"
                            d_obj = date(yy, mm, dd)
                        # 重訊僅保留近 3 天內的最新重大訊息
                        if d_obj and (today - d_obj).days > 3:
                            continue

                        results.append({
                            "id": f"news-{c}-{date_raw}-{time_raw}",
                            "code": c,
                            "tag": "重訊",
                            "title": subj.replace("\r\n", " "),
                            "date": fmt_date,
                            "detail": desc.replace("\r\n", "\n").strip(),
                            "category": "news",
                        })
        except Exception as e:
            logger.warning(f"Error fetching TWSE material news: {e}")
        return results

    def _fetch_tpex_material_news(self, wanted_codes: set[str]) -> list[dict]:
        """從櫃買中心 TPEx OpenAPI 撈取上櫃公司重大訊息 (mopsfin_t187ap04_O)"""
        results: list[dict] = []
        today = date.today()
        try:
            url = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("SecuritiesCompanyCode", "")).strip()
                    if c in wanted_codes:
                        date_raw = str(it.get("發言日期", "")).strip()
                        time_raw = str(it.get("發言時間", "")).strip()
                        subj = (it.get("主旨 ") or it.get("主旨") or "").strip()
                        desc = str(it.get("說明", "")).strip()
                        fmt_date = date_raw
                        d_obj = None
                        if len(date_raw) == 7:
                            yy = int(date_raw[:3]) + 1911
                            mm = int(date_raw[3:5])
                            dd = int(date_raw[5:])
                            fmt_date = f"{yy}-{mm:02d}-{dd:02d}"
                            d_obj = date(yy, mm, dd)
                        if d_obj and (today - d_obj).days > 3:
                            continue

                        results.append({
                            "id": f"news-{c}-{date_raw}-{time_raw}",
                            "code": c,
                            "tag": "重訊",
                            "title": subj.replace("\r\n", " "),
                            "date": fmt_date,
                            "detail": desc.replace("\r\n", "\n").strip(),
                            "category": "news",
                        })
        except Exception as e:
            logger.warning(f"Error fetching TPEx material news: {e}")
        return results

    def _fetch_twse_monthly_revenue(self, wanted_codes: set[str]) -> list[dict]:
        """從證交所 OpenAPI 撈取最新每月自結營收彙總 (t187ap05_L)"""
        results: list[dict] = []
        try:
            url = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("公司代號", "")).strip()
                    if c in wanted_codes:
                        m_str = str(it.get("資料年月", "")).strip()
                        raw_cur = float(it.get("營業收入-當月營收", 0) or 0)
                        cur_amount = raw_cur * 1000
                        mom = float(it.get("營業收入-上月比較增減(%)", 0) or 0)
                        yoy = float(it.get("營業收入-去年同月增減(%)", 0) or 0)

                        month_label = ""
                        if len(m_str) >= 5:
                            month_label = f"{int(m_str[-2:])}月"

                        detail_lines = [
                            f"{month_label}自結營收: {format_chinese_amount(cur_amount)}",
                            f"月增率 (MoM): {'+' if mom > 0 else ''}{mom:.2f}%",
                            f"年增率 (YoY): {'+' if yoy > 0 else ''}{yoy:.2f}%",
                        ]
                        memo = str(it.get("備註", "")).strip()
                        if memo and memo != "-":
                            detail_lines.append(f"公司說明: {memo}")

                        results.append({
                            "id": f"rev-{c}-{m_str}",
                            "code": c,
                            "tag": "自結",
                            "title": f"最新{month_label}自結營收公告",
                            "date": str(it.get("出表日期", "")),
                            "detail": "\n".join(detail_lines),
                            "category": "revenue",
                        })
        except Exception as e:
            logger.warning(f"Error fetching TWSE monthly revenue: {e}")
        return results

    def _fetch_tpex_monthly_revenue(self, wanted_codes: set[str]) -> list[dict]:
        """從櫃買中心 TPEx OpenAPI 撈取最新每月自結營收彙總 (mopsfin_t187ap05_O)"""
        results: list[dict] = []
        try:
            url = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("公司代號", "")).strip()
                    if c in wanted_codes:
                        m_str = str(it.get("資料年月", "")).strip()
                        raw_cur = float(it.get("營業收入-當月營收", 0) or 0)
                        cur_amount = raw_cur * 1000
                        mom = float(it.get("營業收入-上月比較增減(%)", 0) or 0)
                        yoy = float(it.get("營業收入-去年同月增減(%)", 0) or 0)

                        month_label = ""
                        if len(m_str) >= 5:
                            month_label = f"{int(m_str[-2:])}月"

                        detail_lines = [
                            f"{month_label}自結營收: {format_chinese_amount(cur_amount)}",
                            f"月增率 (MoM): {'+' if mom > 0 else ''}{mom:.2f}%",
                            f"年增率 (YoY): {'+' if yoy > 0 else ''}{yoy:.2f}%",
                        ]
                        memo = str(it.get("備註", "")).strip()
                        if memo and memo != "-":
                            detail_lines.append(f"公司說明: {memo}")

                        results.append({
                            "id": f"rev-{c}-{m_str}",
                            "code": c,
                            "tag": "自結",
                            "title": f"最新{month_label}自結營收公告",
                            "date": str(it.get("出表日期", "")),
                            "detail": "\n".join(detail_lines),
                            "category": "revenue",
                        })
        except Exception as e:
            logger.warning(f"Error fetching TPEx monthly revenue: {e}")
        return results

    def _fetch_twse_exdividend(self, wanted_codes: set[str]) -> list[dict]:
        """從證交所 OpenAPI 撈取除權除息預告表（僅保留尚未除權息者，結束當天過後自動移除）"""
        results: list[dict] = []
        today = date.today()
        try:
            url = "https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("Code", "")).strip()
                    if c in wanted_codes:
                        date_raw = str(it.get("Date", "")).strip()
                        d_obj = None
                        fmt_date = date_raw
                        tag_label = "除息"
                        if len(date_raw) == 7:
                            yy = int(date_raw[:3]) + 1911
                            mm = int(date_raw[3:5])
                            dd = int(date_raw[5:])
                            d_obj = date(yy, mm, dd)
                            fmt_date = f"{yy}-{mm:02d}-{dd:02d}"
                            ex_type = str(it.get("Exdividend", "息")).strip()
                            tag_type = "除息" if "息" in ex_type else "除權"
                            tag_label = f"{tag_type} {mm}/{dd}"

                        if d_obj and d_obj < today:
                            continue

                        ex_type = str(it.get("Exdividend", "息")).strip()
                        cash_div = str(it.get("CashDividend", "")).strip()
                        stock_div = str(it.get("StockDividendRatio", "")).strip()

                        detail_lines = []
                        if cash_div and cash_div != "0.000000":
                            detail_lines.append(f"每股現金股利: {cash_div} 元")
                        if stock_div and stock_div != "0.000000":
                            detail_lines.append(f"每股股票股利: {stock_div} 股")

                        results.append({
                            "id": f"exdiv-{c}-{date_raw}",
                            "code": c,
                            "tag": tag_label,
                            "title": f"除權除息預告 ({ex_type})",
                            "date": fmt_date,
                            "detail": "\n".join(detail_lines) if detail_lines else "詳見證券交易所除權息公告",
                            "category": "exdividend",
                        })
        except Exception as e:
            logger.warning(f"Error fetching TWSE exdividend: {e}")
        return results

    def _fetch_tpex_exdividend(self, wanted_codes: set[str]) -> list[dict]:
        """從櫃買中心 TPEx OpenAPI 撈取上櫃除權除息預告表 (tpex_exright_prepost)"""
        results: list[dict] = []
        today = date.today()
        try:
            url = "https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("SecuritiesCompanyCode", "")).strip()
                    if c in wanted_codes:
                        date_raw = str(it.get("ExRrightsExDividendDate", "")).strip()
                        d_obj = None
                        fmt_date = date_raw
                        tag_label = "除息"
                        if len(date_raw) == 7:
                            yy = int(date_raw[:3]) + 1911
                            mm = int(date_raw[3:5])
                            dd = int(date_raw[5:])
                            d_obj = date(yy, mm, dd)
                            fmt_date = f"{yy}-{mm:02d}-{dd:02d}"
                            ex_type = str(it.get("ExRrightsExDividend", "除息")).strip()
                            tag_type = "除息" if "息" in ex_type else "除權"
                            tag_label = f"{tag_type} {mm}/{dd}"

                        if d_obj and d_obj < today:
                            continue

                        ex_type = str(it.get("ExRrightsExDividend", "除息")).strip()
                        cash_div = str(it.get("CashDividend", "")).strip()
                        stock_div = str(it.get("StockDividendRatio", "")).strip()

                        detail_lines = []
                        if cash_div and cash_div not in ["0.00000000", "0.00", "0"]:
                            detail_lines.append(f"每股現金股利: {float(cash_div):.4f} 元")
                        if stock_div and stock_div not in ["0.00000000", "0.00", "0"]:
                            detail_lines.append(f"每股股票股利: {float(stock_div):.4f} 股")

                        results.append({
                            "id": f"exdiv-{c}-{date_raw}",
                            "code": c,
                            "tag": tag_label,
                            "title": f"上櫃除權除息預告 ({ex_type})",
                            "date": fmt_date,
                            "detail": "\n".join(detail_lines) if detail_lines else "詳見櫃買中心除權除息公告",
                            "category": "exdividend",
                        })
        except Exception as e:
            logger.warning(f"Error fetching TPEx exdividend: {e}")
        return results

    def _fetch_yfinance_calendar(self, wanted_codes: set[str]) -> list[dict]:
        """透過 yfinance 取得尚未召開之財報公佈日 (Earnings Date)，已過期的自動排除"""
        results: list[dict] = []
        today = date.today()

        def fetch_single(code: str):
            res_items = []
            for suffix in [".TW", ".TWO"]:
                sym = f"{code}{suffix}"
                try:
                    tk = yf.Ticker(sym)
                    cal = tk.calendar
                    if not cal or not isinstance(cal, dict):
                        continue

                    # 1. 財報公布日 (Earnings Date)
                    earnings_dates = cal.get("Earnings Date", [])
                    if earnings_dates:
                        ed = earnings_dates[0]
                        if isinstance(ed, (date, datetime)):
                            d_obj = ed if isinstance(ed, date) else ed.date()
                            # 僅保留「今天或未來」即將公布的財報（0 <= diff_days <= 60），已過期的絕不顯示
                            diff_days = (d_obj - today).days
                            if 0 <= diff_days <= 60:
                                tag_lbl = f"財報 {d_obj.strftime('%m/%d')}"
                                high_rev = cal.get("Revenue High")
                                avg_rev = cal.get("Revenue Average")
                                avg_eps = cal.get("Earnings Average")

                                detail_parts = [
                                    f"預定財報/法說會公告日期: {d_obj.strftime('%Y-%m-%d')}",
                                ]
                                if avg_eps:
                                    eps_str = f"{avg_eps:.2f}" if isinstance(avg_eps, (int, float)) else str(avg_eps)
                                    detail_parts.append(f"預估每股盈餘 (EPS): {eps_str} 元")
                                if avg_rev:
                                    detail_parts.append(f"預估平均營收: {format_chinese_amount(avg_rev)}")
                                elif high_rev:
                                    detail_parts.append(f"預估營收高標: {format_chinese_amount(high_rev)}")
                                res_items.append({
                                    "id": f"earnings-{code}-{d_obj}",
                                    "code": code,
                                    "tag": tag_lbl,
                                    "title": f"財報/法說會預告 ({d_obj.strftime('%m/%d')})",
                                    "date": d_obj.strftime("%Y-%m-%d"),
                                    "detail": "\n".join(detail_parts),
                                    "category": "earnings",
                                })

                    # 如果已找到正確後綴，跳出
                    if res_items:
                        break
                except Exception:
                    continue
            return res_items

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
                future_to_code = {ex.submit(fetch_single, c): c for c in wanted_codes}
                for f in concurrent.futures.as_completed(future_to_code):
                    try:
                        items = f.result()
                        results.extend(items)
                    except Exception:
                        pass
        except Exception as e:
            logger.warning(f"Error in _fetch_yfinance_calendar: {e}")

        return results

announcement_service = AnnouncementService()
