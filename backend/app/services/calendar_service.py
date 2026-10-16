import calendar
import datetime
import logging
import urllib.request
import json
import re
from typing import Optional, Any
import concurrent.futures
import asyncio

from backend.app.domain.models import CalendarEventItem, CalendarMonthResponse
from backend.app.repositories import db
from backend.app.services.announcement_service import announcement_service

logger = logging.getLogger("calendar_service")

# 台灣重要熱門權值與題材股清單 (即使未加入自選亦納入日曆追蹤)
TOP_WEIGHT_STOCKS = [
    {"code": "2330", "name": "台積電"},
    {"code": "2317", "name": "鴻海"},
    {"code": "2454", "name": "聯發科"},
    {"code": "2382", "name": "廣達"},
    {"code": "2308", "name": "台達電"},
    {"code": "2881", "name": "富邦金"},
    {"code": "2882", "name": "國泰金"},
    {"code": "2412", "name": "中華電"},
    {"code": "2303", "name": "聯電"},
    {"code": "2891", "name": "中信金"},
    {"code": "3231", "name": "緯創"},
    {"code": "3711", "name": "日月光投控"},
    {"code": "2603", "name": "長榮"},
    {"code": "3443", "name": "創意"},
    {"code": "3661", "name": "世芯-KY"},
    {"code": "2357", "name": "華碩"},
    {"code": "3008", "name": "大立光"},
    {"code": "2379", "name": "瑞昱"},
    {"code": "2609", "name": "陽明"},
    {"code": "6669", "name": "緯穎"},
]

# 聯準會 FOMC 利率決議公佈日 (台灣時間通常為週四凌晨 02:00 公布利率決議，02:30 鮑爾記者會)
# 格式: (決議公布當天日期 YYYY-MM-DD, 說明, 是否附帶經濟預測點陣圖SEP)
FOMC_SCHEDULE = {
    # 2025
    "2025-01-30": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2025-03-20": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
    "2025-05-08": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2025-06-19": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
    "2025-07-31": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2025-09-18": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
    "2025-11-06": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2025-12-18": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
    # 2026
    "2026-01-29": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2026-03-19": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
    "2026-05-07": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2026-06-18": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
    "2026-07-30": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2026-09-17": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
    "2026-11-05": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2026-12-17": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
    # 2027
    "2027-01-28": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2027-03-18": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
    "2027-05-06": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2027-06-17": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
    "2027-07-29": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2027-09-16": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
    "2027-11-04": ("FOMC 利率決策會議 (凌晨 02:00)", False),
    "2027-12-16": ("FOMC 利率決策與經濟預測點陣圖 (凌晨 02:00)", True),
}

# Jackson Hole 全球央行年會 (每年 8 月下旬，堪薩斯聯準銀行主辦)
JACKSON_HOLE_SCHEDULE = {
    "2025-08-21": "Jackson Hole 全球央行年會 (開幕日)",
    "2025-08-22": "Jackson Hole 全球央行年會 (鮑爾發表專題演說)",
    "2025-08-23": "Jackson Hole 全球央行年會 (閉幕)",
    "2026-08-20": "Jackson Hole 全球央行年會 (開幕日)",
    "2026-08-21": "Jackson Hole 全球央行年會 (鮑爾發表專題演說)",
    "2026-08-22": "Jackson Hole 全球央行年會 (閉幕)",
    "2027-08-26": "Jackson Hole 全球央行年會 (開幕日)",
    "2027-08-27": "Jackson Hole 全球央行年會 (鮑爾演說)",
    "2027-08-28": "Jackson Hole 全球央行年會 (閉幕)",
}

class CalendarService:
    def __init__(self):
        self._cached_ff_events: list[dict] = []
        self._last_ff_fetch: Optional[datetime.datetime] = None
        self._stock_names_cache: dict[str, str] = {}
        self._last_names_fetch: Optional[datetime.datetime] = None

    async def get_all_stock_names(self) -> dict[str, str]:
        """從資料庫與證交所/櫃買中心開放資料取得全台股代號與簡稱對照表 (快取 1 天)"""
        now = datetime.datetime.now()
        if self._stock_names_cache and self._last_names_fetch and (now - self._last_names_fetch).total_seconds() < 86400:
            return self._stock_names_cache

        name_map: dict[str, str] = {s["code"]: s["name"] for s in TOP_WEIGHT_STOCKS}

        # 1. 先從本地 SQLite 資料庫 (自選股與持股) 讀取已有名稱
        try:
            async with db.get_db_connection() as conn:
                cur = await conn.execute("SELECT code, name FROM watchlist_items UNION SELECT code, name FROM stock_positions")
                rows = await cur.fetchall()
                for r in rows:
                    c = str(r["code"]).strip()
                    n = str(r["name"]).strip()
                    if c and n and n != c:
                        name_map[c] = n
        except Exception as e:
            logger.warning(f"Error loading stock names from DB: {e}")

        # 2. 從證交所 OpenAPI 抓取上市股票名稱對照 (t187ap03_L)
        try:
            loop = asyncio.get_running_loop()
            def fetch_twse():
                u = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"
                req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=4) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            twse_data = await loop.run_in_executor(None, fetch_twse)
            for x in twse_data:
                c = str(x.get("公司代號", "")).strip()
                n = str(x.get("公司簡稱") or x.get("公司名稱") or "").strip()
                if c and n and c not in name_map:
                    name_map[c] = n
        except Exception as te:
            logger.warning(f"Error fetching TWSE company directory: {te}")

        # 3. 從櫃買中心 OpenAPI 抓取上櫃股票名稱對照 (mopsfin_t187ap03_O)
        try:
            loop = asyncio.get_running_loop()
            def fetch_tpex():
                u = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O"
                req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=4) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            tpex_data = await loop.run_in_executor(None, fetch_tpex)
            for x in tpex_data:
                c = str(x.get("SecuritiesCompanyCode", "")).strip()
                n = str(x.get("CompanyName") or "").strip().replace("股份有限公司", "")
                if c and n and c not in name_map:
                    name_map[c] = n
        except Exception as oe:
            logger.warning(f"Error fetching TPEx company directory: {oe}")

        self._stock_names_cache = name_map
        self._last_names_fetch = now
        logger.info(f"Loaded {len(name_map)} stock names into directory cache.")
        return name_map

    def calculate_futures_settlements(self, year: int, month: int) -> list[CalendarEventItem]:
        """演算法計算台指期、富台指結算日與美股四巫日"""
        results: list[CalendarEventItem] = []
        cal = calendar.monthcalendar(year, month)

        # 1. 台指期月結算日：當月第三個星期三
        wednesdays = [week[calendar.WEDNESDAY] for week in cal if week[calendar.WEDNESDAY] != 0]
        if len(wednesdays) >= 3:
            tx_day = wednesdays[2]
            tx_date_str = f"{year:04d}-{month:02d}-{tx_day:02d}"
            results.append(CalendarEventItem(
                id=f"tx-settle-{tx_date_str}",
                date=tx_date_str,
                time="13:30",
                type="futures",
                category="tx_settlement",
                title="台指期/選擇權月合約結算日",
                tag="台指結算",
                detail="期交所台指期、小型台指與台指選擇權當月份合約到期結算（13:30 停止交易並進行最後結算價撮合，注意尾盤大盤波動與次月轉倉部位）。",
                impact="High"
            ))

        # 2. 富台指結算日：當月倒數第二個營業日 (週一至週五)
        num_days = calendar.monthrange(year, month)[1]
        weekdays = []
        for d in range(1, num_days + 1):
            dt = datetime.date(year, month, d)
            if dt.weekday() < 5:  # 0~4 為週一至週五
                weekdays.append(dt)
        if len(weekdays) >= 2:
            sgx_date = weekdays[-2]
            sgx_date_str = sgx_date.strftime("%Y-%m-%d")
            results.append(CalendarEventItem(
                id=f"sgx-settle-{sgx_date_str}",
                date=sgx_date_str,
                time="13:50",
                type="futures",
                category="sgx_settlement",
                title="富台指期貨 (SGX) 月結算日",
                tag="富台結算",
                detail="新加坡交易所 (SGX) 富時台灣指數期貨 (FTSE Taiwan Index Futures) 當月合約最後交易暨結算日（13:50 結算，為外資現貨與期貨主要對沖結算指標）。",
                impact="High"
            ))

        # 3. 美股四巫日 (Quadruple Witching)：3、6、9、12 月的第三個星期五
        if month in (3, 6, 9, 12):
            fridays = [week[calendar.FRIDAY] for week in cal if week[calendar.FRIDAY] != 0]
            if len(fridays) >= 3:
                qw_day = fridays[2]
                qw_date_str = f"{year:04d}-{month:02d}-{qw_day:02d}"
                results.append(CalendarEventItem(
                    id=f"quad-witching-{qw_date_str}",
                    date=qw_date_str,
                    time="美東 16:00",
                    type="futures",
                    category="quad_witching",
                    title="美股四巫日 (指數/個股期權同步結算)",
                    tag="四巫日",
                    detail="美股指數期貨、指數選擇權、個股期貨與個股選擇權四大衍生品同步到期結算，美股尾盤歷史成交量龐大且波動劇烈。",
                    impact="High"
                ))

        return results

    def get_macro_fixed_events(self, year: int, month: int) -> list[CalendarEventItem]:
        """取得 FOMC 與 Jackson Hole 等確定日程"""
        results: list[CalendarEventItem] = []
        month_prefix = f"{year:04d}-{month:02d}"

        # FOMC
        for date_str, (desc, has_sep) in FOMC_SCHEDULE.items():
            if date_str.startswith(month_prefix):
                sep_text = " (含經濟預測摘要 SEP 與利率點陣圖 Dot Plot)" if has_sep else ""
                results.append(CalendarEventItem(
                    id=f"fomc-{date_str}",
                    date=date_str,
                    time="02:00",
                    type="macro",
                    category="fomc",
                    title=desc,
                    tag="FOMC 決策",
                    detail=f"美國聯準會利率政策決議{sep_text}，台灣時間凌晨 02:00 公布利率決議聲明稿，02:30 召開主席鮑爾記者會，牽動全球股匯市走向。",
                    impact="High"
                ))

        # Jackson Hole
        for date_str, desc in JACKSON_HOLE_SCHEDULE.items():
            if date_str.startswith(month_prefix):
                results.append(CalendarEventItem(
                    id=f"jh-{date_str}",
                    date=date_str,
                    time="美東白天",
                    type="macro",
                    category="jackson_hole",
                    title=desc,
                    tag="央行年會",
                    detail="堪薩斯聯準銀行主辦之全球央行傑克森洞年會 (Jackson Hole Economic Symposium)，全球主要央行行長與財政官員齊聚發表重要演說。",
                    impact="High"
                ))

        # 美國每季 GDP 初值常態時程 (1, 4, 7, 10月下旬通常發布前一季 GDP Advance)
        gdp_dates = {
            "2026-10-29": "美國第三季 GDP 季增年率初值 (Advance)",
            "2026-07-30": "美國第二季 GDP 季增年率初值 (Advance)",
            "2026-04-30": "美國第一季 GDP 季增年率初值 (Advance)",
            "2026-01-29": "美國前一年度第四季 GDP 初值",
        }
        for d_str, title in gdp_dates.items():
            if d_str.startswith(month_prefix):
                results.append(CalendarEventItem(
                    id=f"gdp-{d_str}",
                    date=d_str,
                    time="20:30",
                    type="macro",
                    category="macro_other",
                    title=title,
                    tag="美國 GDP",
                    detail="美國經濟分析局 (BEA) 公布實質國內生產毛額 (GDP) 季增年化初值，衡量美國整體經濟擴張或衰退步調。",
                    impact="High"
                ))

        return results

    def _fetch_economic_calendar_feed(self) -> list[dict]:
        """抓取免金鑰的高可靠度經濟數據日曆 (快取 1 小時)"""
        now = datetime.datetime.now()
        if self._cached_ff_events and self._last_ff_fetch and (now - self._last_ff_fetch).total_seconds() < 3600:
            return self._cached_ff_events

        try:
            url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
            headers = {"User-Agent": "Mozilla/5.0"}
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                self._cached_ff_events = data
                self._last_ff_fetch = now
                logger.info(f"Fetched {len(data)} economic calendar events.")
                return data
        except Exception as e:
            logger.warning(f"Error fetching economic calendar: {e}")
            return self._cached_ff_events or []

    def get_macro_feed_events(self, year: int, month: int) -> list[CalendarEventItem]:
        """解析美 CPI, PPI, NFP, Retail Sales 等指標"""
        results: list[CalendarEventItem] = []
        feed_items = self._fetch_economic_calendar_feed()
        month_prefix = f"{year:04d}-{month:02d}"

        # 關鍵詞與類別映射
        target_indicators = [
            ("CPI", "cpi", "美 CPI", "消費者物價指數 (CPI)，衡量通膨核心指標。"),
            ("PPI", "ppi", "美 PPI", "生產者物價指數 (PPI)，通膨先行指標。"),
            ("Non-Farm", "nfp", "非農就業", "美國非農就業人口新增與失業率報告，勞動市場關鍵數據。"),
            ("Unemployment Rate", "nfp", "失業率", "美國官方公布之勞動力失業率。"),
            ("Retail Sales", "macro_other", "零售銷售", "美國零售銷售數據，反映美國內需與消費力道強弱。"),
            ("PCE", "macro_other", "核心 PCE", "個人消費支出物價指數 (PCE)，聯準會最偏好之通膨參考指標。"),
            ("Philly Fed", "macro_other", "費城製造", "費城聯邦儲備銀行製造業活動指數。"),
            ("Unemployment Claims", "macro_other", "初領失業", "美國每週初次申請失業救濟金人數。"),
        ]

        seen_keys = set()
        for it in feed_items:
            # 僅看美國 (USD) 且具有 High 或 Medium 影響力
            if it.get("country") != "USD":
                continue
            date_raw = it.get("date", "")
            if not date_raw:
                continue

            # 轉台灣時間日期
            try:
                # 原始格式如 2026-10-14T08:30:00-04:00
                dt_obj = datetime.datetime.fromisoformat(date_raw)
                # 轉為台灣時間 UTC+8
                tw_tz = datetime.timezone(datetime.timedelta(hours=8))
                tw_dt = dt_obj.astimezone(tw_tz)
                tw_date_str = tw_dt.strftime("%Y-%m-%d")
                tw_time_str = tw_dt.strftime("%H:%M")
            except Exception:
                tw_date_str = date_raw[:10]
                tw_time_str = ""

            if not tw_date_str.startswith(month_prefix):
                continue

            title = it.get("title", "")
            forecast = it.get("forecast", "")
            previous = it.get("previous", "")
            impact = it.get("impact", "Medium")

            for kw, cat, tag, base_desc in target_indicators:
                if kw.lower() in title.lower():
                    dedup_key = f"{tw_date_str}-{kw.lower()}"
                    if dedup_key in seen_keys:
                        break
                    seen_keys.add(dedup_key)

                    detail_parts = [base_desc]
                    if forecast:
                        detail_parts.append(f"市場預期值 (Forecast): {forecast}")
                    if previous:
                        detail_parts.append(f"前值 (Previous): {previous}")

                    results.append(CalendarEventItem(
                        id=f"macro-{cat}-{tw_date_str}-{kw}",
                        date=tw_date_str,
                        time=tw_time_str or "20:30",
                        type="macro",
                        category=cat,
                        title=f"{title}",
                        tag=tag,
                        detail="\n".join(detail_parts),
                        forecast=forecast or None,
                        previous=previous or None,
                        impact=impact
                    ))
        # 若即時 Feed 失敗或不在該週，使用美國官方常態規律估計日期做為保底
        if not results:
            # 1. 非農就業 (NFP) 與失業率: 每月第一個星期五 (20:30)
            cal = calendar.monthcalendar(year, month)
            fridays = [week[calendar.FRIDAY] for week in cal if week[calendar.FRIDAY] != 0]
            if fridays:
                first_fri = fridays[0]
                nfp_d_str = f"{year:04d}-{month:02d}-{first_fri:02d}"
                results.append(CalendarEventItem(
                    id=f"macro-est-nfp-{nfp_d_str}",
                    date=nfp_d_str,
                    time="20:30",
                    type="macro",
                    category="nfp",
                    title="美國非農就業人口新增 (NFP) 與官方失業率報告",
                    tag="非農就業",
                    detail="美國勞工統計局 (BLS) 發布當月非農業就業人口變化與失業率，為聯準會評估勞動市場緊俏度與升降息節奏最關鍵的數據。",
                    impact="High"
                ))

            # 2. 美國 CPI (消費者物價指數): 每月中旬 (通常為 10~14 號間的第一個週二或週三 20:30)
            cpi_day = 13
            for d in range(10, 16):
                if d <= calendar.monthrange(year, month)[1]:
                    if datetime.date(year, month, d).weekday() in (calendar.TUESDAY, calendar.WEDNESDAY):
                        cpi_day = d
                        break
            cpi_d_str = f"{year:04d}-{month:02d}-{cpi_day:02d}"
            results.append(CalendarEventItem(
                id=f"macro-est-cpi-{cpi_d_str}",
                date=cpi_d_str,
                time="20:30",
                type="macro",
                category="cpi",
                title="美國消費者物價指數 (CPI) 與核心 CPI 年增率",
                tag="美 CPI",
                detail="美國勞工統計局公布 CPI 與核心 CPI (排除食品與能源)，衡量美國終端消費者通膨變動情況，對美股與美元指數有極大波動影響力。",
                impact="High"
            ))

            # 3. 美國 PPI (生產者物價指數): 通常為 CPI 隔天 (20:30)
            ppi_date = datetime.date(year, month, cpi_day) + datetime.timedelta(days=1)
            ppi_d_str = ppi_date.strftime("%Y-%m-%d")
            if ppi_d_str.startswith(month_prefix):
                results.append(CalendarEventItem(
                    id=f"macro-est-ppi-{ppi_d_str}",
                    date=ppi_d_str,
                    time="20:30",
                    type="macro",
                    category="ppi",
                    title="美國生產者物價指數 (PPI) 與核心 PPI",
                    tag="美 PPI",
                    detail="衡量企業端生產成本與批發價格變動，為消費者物價通膨 (CPI) 之重要先行指標。",
                    impact="High"
                ))

            # 4. 美國核心 PCE 物價指數 (通常於每月最後一個週五 20:30 公布)
            if fridays:
                last_fri = fridays[-1]
                pce_d_str = f"{year:04d}-{month:02d}-{last_fri:02d}"
                results.append(CalendarEventItem(
                    id=f"macro-est-pce-{pce_d_str}",
                    date=pce_d_str,
                    time="20:30",
                    type="macro",
                    category="macro_other",
                    title="美國核心 PCE 個人消費支出物價指數",
                    tag="核心 PCE",
                    detail="美國經濟分析局 (BEA) 公布個人消費支出 (PCE) 物價指數，為聯準會 2% 通膨目標最正式之參考指標。",
                    impact="High"
                ))

        return results

    async def get_stock_events(self, year: int, month: int) -> list[CalendarEventItem]:
        """收集自選股與熱門權值股的法說、自結營收、財報、除權息"""
        results: list[CalendarEventItem] = []
        month_prefix = f"{year:04d}-{month:02d}"

        # 1. 取得使用者自選與持股清單代號
        user_codes = await db.get_all_subscribed_codes()
        top_codes = {s["code"] for s in TOP_WEIGHT_STOCKS}
        all_target_codes = user_codes.union(top_codes)

        # 建立代號與名稱映射 (含全台股對照表、熱門權值股與資料庫持股)
        code_name_map = await self.get_all_stock_names()
        # 補充從 announcements 與 positions 取得的名字
        all_ann = announcement_service.get_all_announcements()

        # 2. 檢索已有 announcements
        for code, items in all_ann.items():
            if code not in all_target_codes:
                continue
            for it in items:
                d = it.get("date", "")
                if not d or not d.startswith(month_prefix):
                    continue

                cat = it.get("category", "")
                tag = it.get("tag", "個股")
                # 排除「注意股票」事件不納入行事曆
                if cat == "attention" or "注意" in tag:
                    continue

                title = it.get("title", "")
                detail = it.get("detail", "")
                raw_name = code_name_map.get(code)
                c_name = raw_name if raw_name and raw_name != code else code
                display_label = f"[{code} {c_name}]" if c_name != code else f"[{code}]"

                results.append(CalendarEventItem(
                    id=f"stk-{it.get('id', f'{code}-{d}')}",
                    date=d,
                    time="14:00" if "法說" in tag or "法說" in title else None,
                    type="stock",
                    category=cat,
                    title=f"{display_label} {title}",
                    tag=tag,
                    code=code,
                    name=c_name,
                    detail=detail,
                    impact="High" if code in top_codes else "Medium"
                ))

        # 3. 自結營收公告常態標記（台股法規：每月 1~10 號各公司陸續公布自結營收）
        # 標記 10 號為「自結營收申報截止日」
        tenth_date = f"{year:04d}-{month:02d}-10"
        results.append(CalendarEventItem(
            id=f"stk-rev-deadline-{tenth_date}",
            date=tenth_date,
            time="全日",
            type="stock",
            category="revenue",
            title="上市櫃公司每月自結營收申報截止日",
            tag="營收截止",
            detail="依主管機關規定，全體上市櫃與興櫃公司須於每月 10 日前完成申報上月營業收入，為台股每月財報自結最重要催化劑。",
            impact="High"
        ))

        return results

    async def get_month_calendar(self, year: int, month: int) -> CalendarMonthResponse:
        """整合同一月份的所有行事曆事件"""
        # 1. 期指結算日 (演算法)
        futures_events = self.calculate_futures_settlements(year, month)

        # 2. 總經固定排程 (FOMC / Jackson Hole / GDP)
        fixed_macro = self.get_macro_fixed_events(year, month)

        # 3. 總經即時 Feed (美 CPI / PPI / NFP / 失業率)
        feed_macro = self.get_macro_feed_events(year, month)

        # 4. 個股事件 (自選 + 熱門權值股)
        stock_events = await self.get_stock_events(year, month)

        all_events = futures_events + fixed_macro + feed_macro + stock_events

        # 依照日期排序
        all_events.sort(key=lambda x: (x.date, x.time or "00:00", x.type))

        return CalendarMonthResponse(
            year=year,
            month=month,
            events=all_events,
            updatedAt=datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )

calendar_service = CalendarService()
