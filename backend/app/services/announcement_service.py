import asyncio
import logging
import time
from datetime import datetime, date, timedelta
from typing import Optional, Any
import urllib.request
import json
import re
import concurrent.futures
import aiosqlite
from bs4 import BeautifulSoup

from backend.app.settings import settings
from backend.app.repositories import db
from backend.app.domain.models import StockAnnouncementItem

logger = logging.getLogger("announcement_service")

def safe_float(val: Any, default: float = 0.0) -> float:
    """安全轉換浮點數，支援千分位逗號與非數值過濾"""
    if val is None or val == "" or val == "-":
        return default
    try:
        return float(str(val).replace(",", "").strip())
    except (ValueError, TypeError):
        return default

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

def calc_revenue_trend(mom: float, yoy: float) -> tuple[str, str]:
    """計算自結月營收之市場習慣用語 (選項 B：四字完整版，如 年月雙增、年增月減 等)"""
    if yoy > 0 and mom > 0:
        return "年月雙增", "年月雙增 (營收動能強勁，同業與旺季雙成長)"
    elif yoy > 0 and mom < 0:
        return "年增月減", "年增月減 (優於去年同期，但較上月回溫放緩)"
    elif yoy < 0 and mom > 0:
        return "年減月增", "年減月增 (較上月回升，但遜於去年同期)"
    elif yoy < 0 and mom < 0:
        return "年月雙減", "年月雙減 (營收動能低迷，雙雙衰退)"
    elif yoy > 0:
        return "年增", "年增 (優於去年同期)"
    elif yoy < 0:
        return "年減", "年減 (遜於去年同期)"
    elif mom > 0:
        return "月增", "月增 (較上月成長)"
    elif mom < 0:
        return "月減", "月減 (較上月下滑)"
    return "", "持平"

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
        """定期自動更新公告：每天 08:30 盤前更新，且在盤中與盤後每 3~15 分鐘自動刷新重大訊息與最新營收"""
        while self._is_running:
            try:
                now = datetime.now()
                # 營收公布高峰期（每月 1 日 ~ 15 日的 12:00 ~ 21:30）每 3 分鐘 (180s) 輪詢；其餘時段每 15 分鐘 (900s)
                is_peak_window = (1 <= now.day <= 15) and (12 <= now.hour <= 21)
                interval = 180 if is_peak_window else 900
                await asyncio.sleep(interval)
                if self._is_running:
                    logger.info(f"Executing periodic announcements refresh ({interval}s interval)...")
                    await self.refresh_all_announcements(reason="scheduled_periodic")
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in announcement schedule loop: {e}", exc_info=True)
                await asyncio.sleep(60)

    @staticmethod
    def _is_expired(cat: str, d_str: str, today: date) -> bool:
        """檢查特定類別公告是否已過期"""
        if not d_str:
            return False
        d_str = str(d_str).strip()
        d_obj = None
        if len(d_str) == 7 and d_str.isdigit():
            try:
                yy = int(d_str[:3]) + 1911
                mm = int(d_str[3:5])
                dd = int(d_str[5:])
                d_obj = date(yy, mm, dd)
            except Exception:
                pass
        elif len(d_str) == 8 and d_str.isdigit():
            try:
                yy = int(d_str[:4])
                mm = int(d_str[4:6])
                dd = int(d_str[6:])
                d_obj = date(yy, mm, dd)
            except Exception:
                pass
        elif len(d_str) >= 10 and d_str[4] == "-" and d_str[7] == "-":
            try:
                d_obj = date.fromisoformat(d_str[:10])
            except Exception:
                pass

        if not d_obj:
            return False

        # 1. 自結營收公告：在該月份之次月營收公布前均保留有效（45 天寬限期，避免換月時空窗）
        if cat == "revenue":
            return (today - d_obj).days > 45

        # 2. 重大訊息：發布超過 3 天過期
        if cat == "news":
            return (today - d_obj).days > 3

        # 3. 法說會與財報公告：召開/發布日過後超過 5 天過期
        if cat in ["briefing", "earnings"]:
            return (today - d_obj).days > 5

        # 4. 除權息預告：除權息基準日過後過期
        if cat == "exdividend":
            return d_obj < today

        return False

    async def load_from_db(self):
        """從 SQLite 資料庫載入快取的公告 (自動剔除已過期的標籤項目，自結營收僅保留當期目標月份)"""
        try:
            today = date.today()
            target_month = 12 if today.month == 1 else today.month - 1
            target_tag_prefix = f"自結{target_month}月"

            async with db.get_db_connection() as conn:
                cursor = await conn.execute(
                    "SELECT id, code, tag, title, date, detail, category, updated_at FROM stock_announcements ORDER BY date DESC, id DESC"
                )
                rows = await cursor.fetchall()
                cache: dict[str, list[dict]] = {}
                expired_ids = []
                for r in rows:
                    cat = r["category"]
                    d_val = r["date"]
                    tag_val = r["tag"] or ""

                    # 依規則：自結營收在 11 月僅保留 10 月自結；舊月份 (9 月或更早) 視為過期直接淘汰
                    if cat == "revenue" and target_tag_prefix not in tag_val:
                        expired_ids.append(r["id"])
                        continue

                    if self._is_expired(cat, d_val, today):
                        expired_ids.append(r["id"])
                        continue

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

                if expired_ids:
                    # 清理 DB 中過期的舊紀錄
                    placeholders = ",".join("?" for _ in expired_ids)
                    await conn.execute(f"DELETE FROM stock_announcements WHERE id IN ({placeholders})", expired_ids)
                    logger.info(f"Cleaned up {len(expired_ids)} expired announcements from DB.")

                self._cache = cache
                logger.info(f"Loaded {len(rows) - len(expired_ids)} active announcements for {len(cache)} stocks from DB.")
        except Exception as e:
            logger.warning(f"Failed to load announcements from DB: {e}")

    async def save_to_db(self, all_items: list[dict]):
        """將最新公告批次存入 SQLite 資料庫 (替換舊資料，使用 executemany 提升百倍寫入效能)"""
        try:
            ts = db.now_iso()
            params = [
                (
                    it["id"],
                    it["code"],
                    it["tag"],
                    it["title"],
                    it.get("date"),
                    it.get("detail", ""),
                    it["category"],
                    ts,
                )
                for it in all_items
            ]
            async with db.get_db_connection() as conn:
                await conn.execute("DELETE FROM stock_announcements")
                await conn.executemany(
                    """
                    INSERT INTO stock_announcements (id, code, tag, title, date, detail, category, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    params,
                )
                await conn.commit()
            logger.info(f"Saved {len(all_items)} announcements to DB.")
        except Exception as e:
            logger.error(f"Failed to save announcements to DB: {e}")

    async def refresh_all_announcements(self, reason: str = "manual") -> dict[str, list[dict]]:
        """全量抓取全市場所有個股的公告：最新每月自結營收、重大訊息、除權息預告、財報/法說會日程、官方季報獲利、注意處置"""
        logger.info(f"Starting announcements refresh across market (reason: {reason})...")
        wanted_codes = await db.get_all_subscribed_codes()
        top_weights = {"2330", "2317", "2454", "2382", "2308", "2881", "2882", "2303", "3231", "3711", "2603", "3008", "2357"}
        wanted_codes = wanted_codes.union(top_weights)

        loop = asyncio.get_running_loop()
        # 1. 抓取注意與處置 (Shioaji + TPEx 雙重備援)
        shioaji_items = await loop.run_in_executor(self._executor, self._fetch_shioaji_notice_punish, wanted_codes)
        tpex_punish_items = await loop.run_in_executor(self._executor, self._fetch_tpex_notice_punish, wanted_codes)
        # 2. 抓取 MOPS 公開資訊觀測站即時每月自結營收 (全市場 2,000+ 上市櫃與 KY 股，含 N-1 月自動回退備援)
        mops_revenue_items = await loop.run_in_executor(self._executor, self._fetch_mops_monthly_revenue)
        # 3. 抓取官方確認之個股法人說明會、業績發表會與財報公告日程 (全市場無遺漏覆蓋)
        official_briefing_items = await loop.run_in_executor(self._executor, self._fetch_official_briefings_and_events)
        # 4. 抓取官方最新申報季報 EPS 與獲利 (TWSE 與 TPEx OpenAPI 權威數據)
        twse_q_items = await loop.run_in_executor(self._executor, self._fetch_twse_quarterly_reports, wanted_codes)
        tpex_q_items = await loop.run_in_executor(self._executor, self._fetch_tpex_quarterly_reports, wanted_codes)
        # 5. 抓取全市場證交所與櫃買中心即時重大訊息 (含法說會、財報決議、盤後自結營收/損益)
        twse_news_items = await loop.run_in_executor(self._executor, self._fetch_twse_material_news)
        tpex_news_items = await loop.run_in_executor(self._executor, self._fetch_tpex_material_news)
        # 6. 抓取證交所與櫃買中心每月最新自結營收彙總 (OpenAPI 備援)
        revenue_items = await loop.run_in_executor(self._executor, self._fetch_twse_monthly_revenue)
        tpex_revenue_items = await loop.run_in_executor(self._executor, self._fetch_tpex_monthly_revenue)
        # 7. 抓取證交所與櫃買中心除權除息預告
        exdiv_items = await loop.run_in_executor(self._executor, self._fetch_twse_exdividend)
        tpex_exdiv_items = await loop.run_in_executor(self._executor, self._fetch_tpex_exdividend)

        # 彙整合併
        combined_by_code: dict[str, list[dict]] = {}
        all_flat: list[dict] = []

        all_sources = [
            shioaji_items,
            tpex_punish_items,
            mops_revenue_items,
            official_briefing_items,
            twse_q_items,
            tpex_q_items,
            twse_news_items,
            tpex_news_items,
            revenue_items,
            tpex_revenue_items,
            exdiv_items,
            tpex_exdiv_items,
        ]

        today = date.today()
        target_month = 12 if today.month == 1 else today.month - 1
        target_revenue_tag = f"自結{target_month}月"

        seen_ids = set()
        for item_list in all_sources:
            for it in item_list:
                it_id = it.get("id")
                if it_id and it_id in seen_ids:
                    continue
                c = it["code"]
                cat = it["category"]

                existing = combined_by_code.setdefault(c, [])
                # 對於自結營收 (revenue)，每檔個股只保留當期最新法定月份 (如 11月只看 10月營收)，杜絕舊月份殘留
                if cat == "revenue":
                    tag_str = it.get("tag", "")
                    title_str = it.get("title", "")
                    if target_revenue_tag not in tag_str and f"{target_month}月" not in title_str:
                        continue

                    rev_idx = next((i for i, x in enumerate(existing) if x.get("category") == "revenue"), None)
                    if rev_idx is not None:
                        # 若已有營收公告，若新項目資訊更完整（如 MOPS 帶 MoM/YoY）或日期更新，則替換
                        if "MoM" in it.get("detail", "") or str(it.get("date", "")) >= str(existing[rev_idx].get("date", "")):
                            existing[rev_idx] = it
                        continue
                    else:
                        existing.append(it)
                elif cat == "earnings":
                    # 若已有官方出表的季報 (包含詳細 EPS 數值或市場評等)，則優先採用或更新
                    earn_idx = next((i for i, x in enumerate(existing) if x.get("category") == "earnings"), None)
                    if earn_idx is not None:
                        # 若新項目帶有市場評等 (如 季年雙增) 或帶有 EPS 數值，則替換
                        if "增" in it.get("tag", "") or "減" in it.get("tag", "") or "轉" in it.get("tag", "") or "EPS" in it.get("title", ""):
                            existing[earn_idx] = it
                        continue
                    existing.append(it)
                else:
                    existing.append(it)

                if it_id:
                    seen_ids.add(it_id)

        # 排序每檔股票的公告：以日期由新到舊 (最新/未來事件優先排序)
        for c, it_list in combined_by_code.items():
            it_list.sort(key=lambda x: str(x.get("date", "")), reverse=True)
            all_flat.extend(it_list)

        self._cache = combined_by_code
        await self.save_to_db(all_flat)
        logger.info(f"Announcements refresh complete. Total {len(all_flat)} items for {len(combined_by_code)} stocks across market.")
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

    def _fetch_twse_material_news(self, wanted_codes: Optional[set[str]] = None) -> list[dict]:
        """從證交所 OpenAPI 撈取全市場上市公司重大訊息 (t187ap04_L)，含盤中/盤後即時自結營收與損益發布"""
        results: list[dict] = []
        today = date.today()
        try:
            url = "https://openapi.twse.com.tw/v1/opendata/t187ap04_L"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("公司代號", "")).strip()
                    if wanted_codes and c not in wanted_codes:
                        continue
                    if not c or not (c.isdigit() or len(c) >= 4):
                        continue

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
                    subj_clean = subj.replace("\r\n", " ")
                    is_briefing = any(k in subj_clean for k in ["法人說明會", "法說會", "業績發表會", "投資人說明會"])
                    is_financial_report = any(k in subj_clean for k in ["董事會通過", "提報董事會", "董事會決議提報"]) and any(k in subj_clean for k in ["財務報告", "財務報表", "季報", "年報"])
                    is_revenue = any(k in subj_clean for k in ["自結合併營收", "合併營收", "月營收", "營業額", "業績資料", "自結損益", "自結盈餘", "自結合併損益", "自結合併淨利"]) or ("營業額" in desc or "當月營收" in desc or "自結合併營收" in desc or "自結合併損益" in desc)

                    # 若為法說會，嘗試從說明欄內提取真正的召開日期與時間
                    meeting_d_obj = None
                    if is_briefing:
                        m_b_date = re.search(r'(?:召開法人說明會之日期|事實發生日)[：:\s]+(?:115|114|2026|2025)[年/.]?(\d{1,2})[月/.](\d{1,2})', desc)
                        if m_b_date:
                            try:
                                bm = int(m_b_date.group(1))
                                bd = int(m_b_date.group(2))
                                meeting_d_obj = date(today.year, bm, bd)
                            except Exception:
                                pass

                    # 篩選重大訊息時效：自結營收保留 45 天，法說會以召開日算（過後5天過期；未開則持續保留），財報保留 30 天，一般重訊保留 3 天
                    if is_revenue:
                        if d_obj and (today - d_obj).days > 45:
                            continue
                    elif is_briefing:
                        target_check_d = meeting_d_obj or d_obj
                        if target_check_d and (today - target_check_d).days > 5:
                            continue
                    elif is_financial_report:
                        if d_obj and (today - d_obj).days > 30:
                            continue
                    else:
                        if d_obj and (today - d_obj).days > 3:
                            continue

                    if is_revenue:
                        m_month = re.search(r'(?:115|2026)?年?(\d{1,2})月份?', subj_clean)
                        if not m_month:
                            m_month = re.search(r'(?:115|2026)?年?(\d{1,2})月份?', desc[:100])
                        # 依選項 A：僅接收當期目標月份 (如 10月) 之自結營收重訊，未明確註明當期月份或舊月 (如 9月) 視為過期直接略過
                        target_m = 12 if today.month == 1 else today.month - 1
                        if not m_month or int(m_month.group(1)) != target_m:
                            continue
                        month_label = f"{target_m}月"
                        tag_str = f"自結{month_label}"
                        cat_str = "revenue"
                    elif is_briefing:
                        if meeting_d_obj:
                            tag_str = f"法說會 {meeting_d_obj.strftime('%m/%d')}"
                            fmt_date = meeting_d_obj.strftime("%Y-%m-%d")
                        else:
                            tag_str = "法說重訊"
                        cat_str = "briefing"
                    elif is_financial_report:
                        m_q = re.search(r'(?:第\s*([1-4一二三四])\s*季|Q([1-4]))', subj_clean + " " + desc[:100])
                        q_str = ""
                        if m_q:
                            q_val = m_q.group(1) or m_q.group(2)
                            q_map = {'一': '1', '二': '2', '三': '3', '四': '4', '1': '1', '2': '2', '3': '3', '4': '4'}
                            q_str = f"Q{q_map.get(q_val, q_val)}"
                        tag_str = f"{q_str}財報" if q_str else "財報重訊"
                        cat_str = "earnings"
                    else:
                        tag_str = "重訊"
                        cat_str = "news"

                    results.append({
                        "id": f"news-{c}-{date_raw}-{time_raw}",
                        "code": c,
                        "tag": tag_str,
                        "title": subj_clean,
                        "date": fmt_date,
                        "detail": desc.replace("\r\n", "\n").strip(),
                        "category": cat_str,
                    })
        except Exception as e:
            logger.warning(f"Error fetching TWSE material news: {e}")
        return results

    def _fetch_tpex_material_news(self, wanted_codes: Optional[set[str]] = None) -> list[dict]:
        """從櫃買中心 TPEx OpenAPI 撈取全市場上櫃公司重大訊息 (mopsfin_t187ap04_O)"""
        results: list[dict] = []
        today = date.today()
        try:
            url = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("SecuritiesCompanyCode", "")).strip()
                    if wanted_codes and c not in wanted_codes:
                        continue
                    if not c or not (c.isdigit() or len(c) >= 4):
                        continue

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
                    subj_clean = subj.replace("\r\n", " ")
                    is_briefing = any(k in subj_clean for k in ["法人說明會", "法說會", "業績發表會", "投資人說明會"])
                    is_financial_report = any(k in subj_clean for k in ["董事會通過", "提報董事會", "董事會決議提報"]) and any(k in subj_clean for k in ["財務報告", "財務報表", "季報", "年報"])
                    is_revenue = any(k in subj_clean for k in ["自結合併營收", "合併營收", "月營收", "營業額", "業績資料", "自結損益", "自結盈餘", "自結合併損益", "自結合併淨利"]) or ("營業額" in desc or "當月營收" in desc or "自結合併營收" in desc or "自結合併損益" in desc)

                    # 若為法說會，嘗試從說明欄內提取真正的召開日期與時間
                    meeting_d_obj = None
                    if is_briefing:
                        m_b_date = re.search(r'(?:召開法人說明會之日期|事實發生日)[：:\s]+(?:115|114|2026|2025)[年/.]?(\d{1,2})[月/.](\d{1,2})', desc)
                        if m_b_date:
                            try:
                                bm = int(m_b_date.group(1))
                                bd = int(m_b_date.group(2))
                                meeting_d_obj = date(today.year, bm, bd)
                            except Exception:
                                pass

                    # 篩選重大訊息時效：自結營收保留 45 天，法說會以召開日算（過後5天過期；未開則持續保留），財報保留 30 天，一般重訊保留 3 天
                    if is_revenue:
                        if d_obj and (today - d_obj).days > 45:
                            continue
                    elif is_briefing:
                        target_check_d = meeting_d_obj or d_obj
                        if target_check_d and (today - target_check_d).days > 5:
                            continue
                    elif is_financial_report:
                        if d_obj and (today - d_obj).days > 30:
                            continue
                    else:
                        if d_obj and (today - d_obj).days > 3:
                            continue

                    if is_revenue:
                        m_month = re.search(r'(?:115|2026)?年?(\d{1,2})月份?', subj_clean)
                        if not m_month:
                            m_month = re.search(r'(?:115|2026)?年?(\d{1,2})月份?', desc[:100])
                        # 依選項 A：僅接收當期目標月份 (如 10月) 之自結營收重訊，未明確註明當期月份或舊月 (如 9月) 視為過期直接略過
                        target_m = 12 if today.month == 1 else today.month - 1
                        if not m_month or int(m_month.group(1)) != target_m:
                            continue
                        month_label = f"{target_m}月"
                        tag_str = f"自結{month_label}"
                        cat_str = "revenue"
                    elif is_briefing:
                        if meeting_d_obj:
                            tag_str = f"法說會 {meeting_d_obj.strftime('%m/%d')}"
                            fmt_date = meeting_d_obj.strftime("%Y-%m-%d")
                        else:
                            tag_str = "法說重訊"
                        cat_str = "briefing"
                    elif is_financial_report:
                        m_q = re.search(r'(?:第\s*([1-4一二三四])\s*季|Q([1-4]))', subj_clean + " " + desc[:100])
                        q_str = ""
                        if m_q:
                            q_val = m_q.group(1) or m_q.group(2)
                            q_map = {'一': '1', '二': '2', '三': '3', '四': '4', '1': '1', '2': '2', '3': '3', '4': '4'}
                            q_str = f"Q{q_map.get(q_val, q_val)}"
                        tag_str = f"{q_str}財報" if q_str else "財報重訊"
                        cat_str = "earnings"
                    else:
                        tag_str = "重訊"
                        cat_str = "news"

                    results.append({
                        "id": f"news-{c}-{date_raw}-{time_raw}",
                        "code": c,
                        "tag": tag_str,
                        "title": subj_clean,
                        "date": fmt_date,
                        "detail": desc.replace("\r\n", "\n").strip(),
                        "category": cat_str,
                    })
        except Exception as e:
            logger.warning(f"Error fetching TPEx material news: {e}")
        return results

    def _fetch_mops_monthly_revenue(self, wanted_codes: Optional[set[str]] = None) -> list[dict]:
        """從 MOPS 公開資訊觀測站抓取全市場最新每月自結營收彙總 (當期目標月 100% 精準無遺漏，絕不混入舊月份)"""
        results: list[dict] = []
        today = date.today()

        # 決定欲查詢之目標年月 (在 11 月時，法定申報營收為 10 月自結；舊月份一律排除)
        if today.month == 1:
            target_year = today.year - 1
            target_month = 12
        else:
            target_year = today.year
            target_month = today.month - 1

        year_roc = target_year - 1911

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }

        def fetch_page(mkt: str, yr: int, mn: int, sub: int):
            u = f"https://mopsov.twse.com.tw/nas/t21/{mkt}/t21sc03_{yr}_{mn}_{sub}.html"
            for attempt in range(3):
                try:
                    rq = urllib.request.Request(u, headers=headers)
                    with urllib.request.urlopen(rq, timeout=8) as rp:
                        return (mkt, yr, mn, sub, rp.read().decode("cp950", errors="ignore"))
                except Exception as e:
                    if attempt == 2:
                        logger.warning(f"Error fetching MOPS monthly revenue for {u}: {e}")
                    time.sleep(0.5)
            return (mkt, yr, mn, sub, None)

        pages_to_fetch = []
        for market in ["sii", "otc"]:
            for sub_type in [0, 1]:  # 0: 國內, 1: 國外第一上市櫃 (KY)
                pages_to_fetch.append((market, year_roc, target_month, sub_type))

        cur_month_stocks: dict[str, dict] = {}

        for market, yr, mn, sub in pages_to_fetch:
            mkt, y, m, s, html = fetch_page(market, yr, mn, sub)
            if not html:
                continue
            soup = BeautifulSoup(html, "html.parser")
            for tr in soup.find_all("tr"):
                tds = [td.get_text(strip=True) for td in tr.find_all("td", recursive=False)]
                if len(tds) >= 10 and tds[0].isdigit():
                    code = tds[0].strip()
                    if wanted_codes and code not in wanted_codes:
                        continue
                    name = tds[1].strip()
                    cur_rev_raw = tds[2].replace(",", "")
                    mom_raw = tds[5].replace(",", "")
                    yoy_raw = tds[6].replace(",", "")
                    memo = tds[10].strip() if len(tds) > 10 else ""
                    try:
                        cur_rev_amount = float(cur_rev_raw) * 1000
                        mom_val = float(mom_raw)
                        yoy_val = float(yoy_raw)
                    except (ValueError, TypeError):
                        continue

                    cur_month_stocks[code] = {
                        "code": code,
                        "name": name,
                        "amount": cur_rev_amount,
                        "mom": mom_val,
                        "yoy": yoy_val,
                        "memo": memo,
                        "month": target_month,
                        "year_roc": year_roc,
                    }
            time.sleep(0.2)

        # 法定申報日 (例如 10 月自結營收於 11 月 10 日前申報完畢)
        target_date_str = f"{today.year}-{today.month:02d}-10"
        month_label = f"{target_month}月"

        for code, info in cur_month_stocks.items():
            mom = info["mom"]
            yoy = info["yoy"]
            trend_label, trend_desc = calc_revenue_trend(mom, yoy)
            tag_str = f"自結{month_label} {trend_label}".strip() if trend_label else f"自結{month_label}"
            title_str = f"最新{month_label}自結營收公告 ({trend_label})" if trend_label else f"最新{month_label}自結營收公告"

            detail_lines = [
                f"{month_label}自結營收: {format_chinese_amount(info['amount'])}",
                f"市場評等: 【{trend_label}】 ({trend_desc})" if trend_label else "",
                f"年增率 (YoY): {'+' if yoy > 0 else ''}{yoy:.2f}% ({'年增' if yoy > 0 else '年減'})",
                f"月增率 (MoM): {'+' if mom > 0 else ''}{mom:.2f}% ({'月增' if mom > 0 else '月減'})",
            ]
            if info["memo"] and info["memo"] != "-":
                detail_lines.append(f"公司說明: {info['memo']}")

            results.append({
                "id": f"rev-{code}-{info['year_roc']}{target_month:02d}",
                "code": code,
                "tag": tag_str,
                "title": title_str,
                "date": target_date_str,
                "detail": "\n".join([x for x in detail_lines if x]),
                "category": "revenue",
            })

        logger.info(f"MOPS monthly revenue fetch complete: {len(results)} stocks parsed for {month_label} across market.")
        return results

    def _fetch_twse_monthly_revenue(self, wanted_codes: Optional[set[str]] = None) -> list[dict]:
        """從證交所 OpenAPI 撈取最新每月自結營收彙總 (t187ap05_L) (嚴格鎖定當期目標月，絕不回退舊月份)"""
        results: list[dict] = []
        today = date.today()
        target_year = today.year - 1 if today.month == 1 else today.year
        target_month = 12 if today.month == 1 else today.month - 1
        year_roc = target_year - 1911
        target_roc_m = f"{year_roc}{target_month:02d}"
        target_date_str = f"{today.year}-{today.month:02d}-10"
        month_label = f"{target_month}月"

        try:
            url = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("公司代號", "")).strip()
                    if wanted_codes and c not in wanted_codes:
                        continue
                    if not c or not (c.isdigit() or len(c) >= 4):
                        continue

                    m_str = str(it.get("資料年月", "")).strip()
                    # 嚴格篩選：只接受當期目標月份 (如 11510)，舊月份 (如 11509) 直接丟棄
                    if m_str != target_roc_m:
                        continue

                    raw_cur = float(it.get("營業收入-當月營收", 0) or 0)
                    cur_amount = raw_cur * 1000
                    mom = float(it.get("營業收入-上月比較增減(%)", 0) or 0)
                    yoy = float(it.get("營業收入-去年同月增減(%)", 0) or 0)
                    trend_label, trend_desc = calc_revenue_trend(mom, yoy)
                    tag_str = f"自結{month_label} {trend_label}".strip() if trend_label else f"自結{month_label}"
                    title_str = f"最新{month_label}自結營收公告 ({trend_label})" if trend_label else f"最新{month_label}自結營收公告"

                    detail_lines = [
                        f"{month_label}自結營收: {format_chinese_amount(cur_amount)}",
                        f"市場評等: 【{trend_label}】 ({trend_desc})" if trend_label else "",
                        f"年增率 (YoY): {'+' if yoy > 0 else ''}{yoy:.2f}% ({'年增' if yoy > 0 else '年減'})",
                        f"月增率 (MoM): {'+' if mom > 0 else ''}{mom:.2f}% ({'月增' if mom > 0 else '月減'})",
                    ]
                    memo = str(it.get("備註", "")).strip()
                    if memo and memo != "-":
                        detail_lines.append(f"公司說明: {memo}")

                    results.append({
                        "id": f"rev-{c}-{m_str}",
                        "code": c,
                        "tag": tag_str,
                        "title": title_str,
                        "date": target_date_str,
                        "detail": "\n".join([x for x in detail_lines if x]),
                        "category": "revenue",
                    })
        except Exception as e:
            logger.warning(f"Error fetching TWSE monthly revenue: {e}")
        return results

    def _fetch_tpex_monthly_revenue(self, wanted_codes: Optional[set[str]] = None) -> list[dict]:
        """從櫃買中心 TPEx OpenAPI 撈取最新每月自結營收彙總 (mopsfin_t187ap05_O) (嚴格鎖定當期目標月)"""
        results: list[dict] = []
        today = date.today()
        target_year = today.year - 1 if today.month == 1 else today.year
        target_month = 12 if today.month == 1 else today.month - 1
        year_roc = target_year - 1911
        target_roc_m = f"{year_roc}{target_month:02d}"
        target_date_str = f"{today.year}-{today.month:02d}-10"
        month_label = f"{target_month}月"

        try:
            url = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("公司代號", "")).strip()
                    if wanted_codes and c not in wanted_codes:
                        continue
                    if not c or not (c.isdigit() or len(c) >= 4):
                        continue

                    m_str = str(it.get("資料年月", "")).strip()
                    # 嚴格篩選：只接受當期目標月份 (如 11510)
                    if m_str != target_roc_m:
                        continue

                    raw_cur = float(it.get("營業收入-當月營收", 0) or 0)
                    cur_amount = raw_cur * 1000
                    mom = float(it.get("營業收入-上月比較增減(%)", 0) or 0)
                    yoy = float(it.get("營業收入-去年同月增減(%)", 0) or 0)
                    trend_label, trend_desc = calc_revenue_trend(mom, yoy)
                    tag_str = f"自結{month_label} {trend_label}".strip() if trend_label else f"自結{month_label}"
                    title_str = f"最新{month_label}自結營收公告 ({trend_label})" if trend_label else f"最新{month_label}自結營收公告"

                    detail_lines = [
                        f"{month_label}自結營收: {format_chinese_amount(cur_amount)}",
                        f"市場評等: 【{trend_label}】 ({trend_desc})" if trend_label else "",
                        f"年增率 (YoY): {'+' if yoy > 0 else ''}{yoy:.2f}% ({'年增' if yoy > 0 else '年減'})",
                        f"月增率 (MoM): {'+' if mom > 0 else ''}{mom:.2f}% ({'月增' if mom > 0 else '月減'})",
                    ]
                    memo = str(it.get("備註", "")).strip()
                    if memo and memo != "-":
                        detail_lines.append(f"公司說明: {memo}")

                    results.append({
                        "id": f"rev-{c}-{m_str}",
                        "code": c,
                        "tag": tag_str,
                        "title": title_str,
                        "date": target_date_str,
                        "detail": "\n".join([x for x in detail_lines if x]),
                        "category": "revenue",
                    })
        except Exception as e:
            logger.warning(f"Error fetching TPEx monthly revenue: {e}")
        return results

    def _fetch_twse_exdividend(self, wanted_codes: Optional[set[str]] = None) -> list[dict]:
        """從證交所 OpenAPI 撈取全市場除權除息預告表（僅保留尚未除權息者，結束當天過後自動移除）"""
        results: list[dict] = []
        today = date.today()
        try:
            url = "https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("Code", "")).strip()
                    if wanted_codes and c not in wanted_codes:
                        continue
                    if not c or not (c.isdigit() or len(c) >= 4):
                        continue

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

    def _fetch_tpex_exdividend(self, wanted_codes: Optional[set[str]] = None) -> list[dict]:
        """從櫃買中心 TPEx OpenAPI 撈取全市場上櫃除權除息預告表 (tpex_exright_prepost)"""
        results: list[dict] = []
        today = date.today()
        try:
            url = "https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=6) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for it in data:
                    c = str(it.get("SecuritiesCompanyCode", "")).strip()
                    if wanted_codes and c not in wanted_codes:
                        continue
                    if not c or not (c.isdigit() or len(c) >= 4):
                        continue

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
                    c_div_num = safe_float(cash_div)
                    s_div_num = safe_float(stock_div)
                    if c_div_num > 0:
                        detail_lines.append(f"每股現金股利: {c_div_num:.4f} 元")
                    elif cash_div and cash_div not in ["0.00000000", "0.00", "0", "0.000000"]:
                        detail_lines.append(f"每股現金股利: {cash_div}")

                    if s_div_num > 0:
                        detail_lines.append(f"每股股票股利: {s_div_num:.4f} 股")
                    elif stock_div and stock_div not in ["0.00000000", "0.00", "0", "0.000000"]:
                        detail_lines.append(f"每股股票股利: {stock_div}")

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

    def _fetch_histock_eps_grid(self, code: str) -> Optional[dict]:
        """從 HiStock 撈取指定個股歷年季度每股盈餘 (EPS) 表格以計算 QoQ 與 YoY 習慣用語"""
        try:
            url = f"https://histock.tw/stock/{urllib.parse.quote(code)}/{urllib.parse.quote('每股盈餘')}"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=3) as r:
                html = r.read().decode("utf-8", errors="ignore")
                table = re.search(r"<table[^>]*>(.*?)</table>", html, re.DOTALL)
                if not table:
                    return None
                rows = re.findall(r"<tr[^>]*>(.*?)</tr>", table.group(1), re.DOTALL)
                headers = []
                grid = {}
                for row in rows:
                    th_td = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.DOTALL)
                    clean = [re.sub(r"<[^>]+>", "", cell).strip() for cell in th_td]
                    if not clean:
                        continue
                    if "季別" in clean[0]:
                        headers = clean[1:]
                    elif clean[0] in ("Q1", "Q2", "Q3", "Q4"):
                        q = clean[0]
                        grid[q] = {headers[i]: clean[i + 1] for i in range(min(len(headers), len(clean) - 1))}
                return grid
        except Exception:
            return None

    def _calc_quarterly_trend(self, grid: Optional[dict], q_str: str, year_str: str = "2026") -> tuple[str, str, Optional[float]]:
        """計算季度財報之市場習慣用語 (選項 B：季年雙增 / 季減年增 / 季增年減 / 季年雙減 / 轉虧為盈)"""
        if not grid:
            return "", "", None
        q_key = f"Q{q_str}" if not str(q_str).startswith("Q") else str(q_str)
        cur_val = grid.get(q_key, {}).get(year_str)
        if not cur_val or cur_val == "-":
            return "", "", None
        try:
            cur = float(cur_val)
        except Exception:
            return "", "", None

        q_order = ["Q1", "Q2", "Q3", "Q4"]
        if q_key not in q_order:
            return "", "", cur
        idx = q_order.index(q_key)
        if idx > 0:
            prev_q_val = grid.get(q_order[idx - 1], {}).get(year_str)
        else:
            prev_q_val = grid.get("Q4", {}).get(str(int(year_str) - 1))

        prev_y_val = grid.get(q_key, {}).get(str(int(year_str) - 1))

        prev_q = float(prev_q_val) if prev_q_val and prev_q_val != "-" else None
        prev_y = float(prev_y_val) if prev_y_val and prev_y_val != "-" else None

        qoq_desc = ""
        yoy_desc = ""
        is_qoq_up = (cur > prev_q) if prev_q is not None else None
        is_yoy_up = (cur > prev_y) if prev_y is not None else None

        if prev_q is not None:
            if prev_q < 0 and cur > 0:
                qoq_desc = "轉虧為盈"
            elif prev_q > 0 and cur < 0:
                qoq_desc = "由盈轉虧"
            elif prev_q != 0:
                qoq_pct = (cur - prev_q) / abs(prev_q) * 100
                qoq_desc = f"季增 {qoq_pct:+.1f}%" if qoq_pct > 0 else f"季減 {abs(qoq_pct):.1f}%"

        if prev_y is not None:
            if prev_y < 0 and cur > 0:
                yoy_desc = "轉虧為盈"
            elif prev_y > 0 and cur < 0:
                yoy_desc = "由盈轉虧"
            elif prev_y != 0:
                yoy_pct = (cur - prev_y) / abs(prev_y) * 100
                yoy_desc = f"年增 {yoy_pct:+.1f}%" if yoy_pct > 0 else f"年減 {abs(yoy_pct):.1f}%"

        trend_tag = ""
        if "轉虧為盈" in (qoq_desc, yoy_desc):
            trend_tag = "轉虧為盈"
        elif "由盈轉虧" in (qoq_desc, yoy_desc):
            trend_tag = "由盈轉虧"
        elif is_qoq_up is True and is_yoy_up is True:
            trend_tag = "季年雙增"
        elif is_qoq_up is False and is_yoy_up is True:
            trend_tag = "季減年增"
        elif is_qoq_up is True and is_yoy_up is False:
            trend_tag = "季增年減"
        elif is_qoq_up is False and is_yoy_up is False:
            trend_tag = "季年雙減"
        elif is_yoy_up is True:
            trend_tag = "年增"
        elif is_yoy_up is False:
            trend_tag = "年減"

        eval_parts = []
        if qoq_desc:
            eval_parts.append(qoq_desc)
        if yoy_desc:
            eval_parts.append(yoy_desc)
        eval_str = ", ".join(eval_parts)

        return trend_tag, eval_str, cur

    def _fetch_twse_quarterly_reports(self, wanted_codes: Optional[set[str]] = None) -> list[dict]:
        """從證交所 OpenAPI (t187ap14_L) 撈取最新官方申報季報 (EPS、營業收入、稅後淨利，含習慣用語評等)"""
        results: list[dict] = []
        today = date.today()
        eps_grids: dict[str, dict] = {}

        try:
            url = "https://openapi.twse.com.tw/v1/opendata/t187ap14_L"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            # 僅針對實際出表且符合 wanted_codes 的個股並行抓取歷史季度 EPS 評等
            matched_codes = {str(it.get("公司代號", "")).strip() for it in data}
            if wanted_codes:
                matched_codes = matched_codes.intersection(wanted_codes)
            if matched_codes:
                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
                    future_map = {ex.submit(self._fetch_histock_eps_grid, c): c for c in matched_codes}
                    for f in concurrent.futures.as_completed(future_map):
                        c = future_map[f]
                        try:
                            res = f.result()
                            if res:
                                eps_grids[c] = res
                        except Exception:
                            pass
            for it in data:
                c = str(it.get("公司代號", "")).strip()
                if wanted_codes and c not in wanted_codes:
                    continue
                if not c or not (c.isdigit() or len(c) >= 4):
                    continue

                date_raw = str(it.get("出表日期", "")).strip()
                d_obj = None
                fmt_date = date_raw
                if len(date_raw) == 7 and date_raw.isdigit():
                    yy = int(date_raw[:3]) + 1911
                    mm = int(date_raw[3:5])
                    dd = int(date_raw[5:])
                    fmt_date = f"{yy}-{mm:02d}-{dd:02d}"
                    d_obj = date(yy, mm, dd)
                if d_obj and (today - d_obj).days > 45:
                    continue

                nm = str(it.get("公司名稱", "")).strip()
                q = str(it.get("季別", "")).strip()
                eps = str(it.get("基本每股盈餘(元)", "")).strip()
                raw_rev = safe_float(it.get("營業收入", 0)) * 1000
                raw_profit = safe_float(it.get("稅後淨利", 0)) * 1000
                raw_op = safe_float(it.get("營業利益", 0)) * 1000

                grid = eps_grids.get(c)
                if not grid and wanted_codes and c in wanted_codes:
                    grid = self._fetch_histock_eps_grid(c)
                    if grid:
                        eps_grids[c] = grid

                trend_tag, eval_str, single_q_eps = self._calc_quarterly_trend(grid, q, str(today.year))
                tag_label = f"Q{q}財報 {trend_tag}".strip() if trend_tag else (f"Q{q}財報" if q else "季報")

                detail_lines = [
                    f"115年第{q}季 (Q{q}) 官方申報財務報告：",
                    f"市場評等: 【{trend_tag}】 ({eval_str})" if trend_tag and eval_str else (f"市場評等: 【{trend_tag}】" if trend_tag else ""),
                    f"單季每股盈餘 (EPS): {single_q_eps:.2f} 元" if single_q_eps is not None else "",
                    f"前三季累計 EPS: {eps} 元" if eps and eps != "--" and q == "3" else (f"基本每股盈餘 (EPS): {eps} 元" if eps and eps != "--" else ""),
                    f"稅後淨利: {format_chinese_amount(raw_profit)}" if raw_profit else "",
                    f"營業收入: {format_chinese_amount(raw_rev)}" if raw_rev else "",
                    f"營業利益: {format_chinese_amount(raw_op)}" if raw_op else "",
                    f"官方申報出表日期: {fmt_date}",
                ]
                detail_txt = "\n".join([x for x in detail_lines if x])
                results.append({
                    "id": f"q-twse-{c}-{date_raw}-Q{q}",
                    "code": c,
                    "tag": tag_label,
                    "title": f"{nm} Q{q} 財務報告 ({trend_tag})" if trend_tag else (f"{nm} Q{q} 財務報告 (EPS {eps}元)" if eps and eps != "--" else f"{nm} Q{q} 財務報告"),
                    "date": fmt_date,
                    "detail": detail_txt,
                    "category": "earnings",
                })
        except Exception as e:
            logger.warning(f"Error fetching TWSE quarterly reports: {e}")
        return results

    def _fetch_tpex_quarterly_reports(self, wanted_codes: Optional[set[str]] = None) -> list[dict]:
        """從櫃買中心 TPEx OpenAPI (mopsfin_t187ap14_O) 撈取最新官方申報季報 (EPS、營業收入、稅後淨利)"""
        results: list[dict] = []
        today = date.today()
        eps_grids: dict[str, dict] = {}

        try:
            url = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap14_O"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            # 僅針對實際出表且符合 wanted_codes 的個股並行抓取歷史季度 EPS 評等
            matched_codes = {str(it.get("SecuritiesCompanyCode", "")).strip() for it in data}
            if wanted_codes:
                matched_codes = matched_codes.intersection(wanted_codes)
            if matched_codes:
                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
                    future_map = {ex.submit(self._fetch_histock_eps_grid, c): c for c in matched_codes}
                    for f in concurrent.futures.as_completed(future_map):
                        c = future_map[f]
                        try:
                            res = f.result()
                            if res:
                                eps_grids[c] = res
                        except Exception:
                            pass
            for it in data:
                c = str(it.get("SecuritiesCompanyCode", "")).strip()
                if wanted_codes and c not in wanted_codes:
                    continue
                if not c or not (c.isdigit() or len(c) >= 4):
                    continue

                date_raw = str(it.get("Date", "")).strip()
                d_obj = None
                fmt_date = date_raw
                if len(date_raw) == 7 and date_raw.isdigit():
                    yy = int(date_raw[:3]) + 1911
                    mm = int(date_raw[3:5])
                    dd = int(date_raw[5:])
                    fmt_date = f"{yy}-{mm:02d}-{dd:02d}"
                    d_obj = date(yy, mm, dd)
                if d_obj and (today - d_obj).days > 45:
                    continue

                nm = str(it.get("CompanyName", "")).strip()
                q = str(it.get("季別", "")).strip()
                eps = str(it.get("基本每股盈餘", "")).strip()
                raw_rev = safe_float(it.get("營業收入", 0)) * 1000
                raw_profit = safe_float(it.get("稅後淨利", 0)) * 1000
                raw_op = safe_float(it.get("營業利益", 0)) * 1000

                grid = eps_grids.get(c)
                if not grid and wanted_codes and c in wanted_codes:
                    grid = self._fetch_histock_eps_grid(c)
                    if grid:
                        eps_grids[c] = grid

                trend_tag, eval_str, single_q_eps = self._calc_quarterly_trend(grid, q, str(today.year))
                tag_label = f"Q{q}財報 {trend_tag}".strip() if trend_tag else (f"Q{q}財報" if q else "季報")

                detail_lines = [
                    f"115年第{q}季 (Q{q}) 官方申報財務報告：",
                    f"市場評等: 【{trend_tag}】 ({eval_str})" if trend_tag and eval_str else (f"市場評等: 【{trend_tag}】" if trend_tag else ""),
                    f"單季每股盈餘 (EPS): {single_q_eps:.2f} 元" if single_q_eps is not None else "",
                    f"前三季累計 EPS: {eps} 元" if eps and eps != "--" and q == "3" else (f"基本每股盈餘 (EPS): {eps} 元" if eps and eps != "--" else ""),
                    f"稅後淨利: {format_chinese_amount(raw_profit)}" if raw_profit else "",
                    f"營業收入: {format_chinese_amount(raw_rev)}" if raw_rev else "",
                    f"營業利益: {format_chinese_amount(raw_op)}" if raw_op else "",
                    f"官方申報出表日期: {fmt_date}",
                ]
                detail_txt = "\n".join([x for x in detail_lines if x])
                results.append({
                    "id": f"q-tpex-{c}-{date_raw}-Q{q}",
                    "code": c,
                    "tag": tag_label,
                    "title": f"{nm} Q{q} 財務報告 ({trend_tag})" if trend_tag else (f"{nm} Q{q} 財務報告 (EPS {eps}元)" if eps and eps != "--" else f"{nm} Q{q} 財務報告"),
                    "date": fmt_date,
                    "detail": detail_txt,
                    "category": "earnings",
                })
        except Exception as e:
            logger.warning(f"Error fetching TPEx quarterly reports: {e}")
        return results

    def _fetch_official_briefings_and_events(self, wanted_codes: Optional[set[str]] = None) -> list[dict]:
        """從台股官方公開申報日程 (HiStock / MOPS) 撈取全市場已確認之法人說明會、業績發表會與財報公告，絕不使用演算法模型推估"""
        results: list[dict] = []
        today = date.today()
        # 覆蓋今天起的近 7 週 (從上週起始點推至未來 6 週，無縫連續覆蓋)
        dates_to_check = [
            today - timedelta(days=7),
            today,
            today + timedelta(days=14),
            today + timedelta(days=28),
            today + timedelta(days=42),
        ]
        seen_ids = set()

        for d in dates_to_check:
            url = f"https://histock.tw/stock/stockskd.aspx?cid=2&t={d.strftime('%Y-%m-%d')}"
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"})
                with urllib.request.urlopen(req, timeout=8) as resp:
                    html = resp.read().decode("utf-8")
                soup = BeautifulSoup(html, "html.parser")
                tbl = soup.find("table", class_="tb-stockskd")
                if not tbl:
                    continue
                for row in tbl.find_all("tr"):
                    th = row.find("th")
                    tds = row.find_all("td")
                    if not th or not tds:
                        continue
                    th_text = th.get_text(strip=True)
                    m_date = re.match(r"(\d{1,2})/(\d{1,2})", th_text)
                    if not m_date:
                        continue
                    month = int(m_date.group(1))
                    day = int(m_date.group(2))

                    ev_year = d.year
                    if d.month == 12 and month == 1:
                        ev_year += 1
                    elif d.month == 1 and month == 12:
                        ev_year -= 1
                    try:
                        ev_date = date(ev_year, month, day)
                    except ValueError:
                        continue

                    # 保留過去 5 天內召開/發布者（供盤後追蹤），以及未來 60 天內已官方申報之法說會與財報公告
                    days_diff = (today - ev_date).days
                    if days_diff > 5 or (ev_date - today).days > 60:
                        continue

                    full_text = " ".join(td.get_text(strip=True) for td in tds)
                    matches = re.finditer(r"(\d{4})\s*([\u4e00-\u9fa5A-Za-z0-9\-\*]+?)(法人說明會|業績發表會|財報公告|法說會)", full_text)
                    for m in matches:
                        c = m.group(1)
                        nm = m.group(2)
                        ev = m.group(3)
                        if wanted_codes and c not in wanted_codes:
                            continue
                        uid = f"official-{c}-{ev_date}-{ev}"
                        if uid in seen_ids:
                            continue
                        seen_ids.add(uid)

                        if "法人說明會" in ev or "業績發表會" in ev or "法說會" in ev:
                            tag_lbl = f"法說會 {ev_date.strftime('%m/%d')}"
                            cat_lbl = "briefing"
                            title_lbl = f"{nm} 法人說明會 ({ev_date.strftime('%m/%d')})"
                            ev_name = "業績發表會" if "業績發表會" in ev else "法人說明會"
                            detail_txt = f"官方公開申報日程: {ev_date.strftime('%Y-%m-%d')}\n公司: {c} {nm}\n事項: 召開{ev_name}"
                        else:
                            tag_lbl = f"財報 {ev_date.strftime('%m/%d')}"
                            cat_lbl = "earnings"
                            title_lbl = f"{nm} 財報公告 ({ev_date.strftime('%m/%d')})"
                            detail_txt = f"官方公開申報日程: {ev_date.strftime('%Y-%m-%d')}\n公司: {c} {nm}\n事項: 董事會提報/通過財務報告"

                        results.append({
                            "id": uid,
                            "code": c,
                            "tag": tag_lbl,
                            "title": title_lbl,
                            "date": ev_date.strftime("%Y-%m-%d"),
                            "detail": detail_txt,
                            "category": cat_lbl,
                        })
            except Exception as e:
                logger.warning(f"Error fetching official briefings from {url}: {e}")

        logger.info(f"Fetched {len(results)} confirmed official briefings/earnings from MOPS schedule.")
        return results

announcement_service = AnnouncementService()
