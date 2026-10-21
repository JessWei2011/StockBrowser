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

# 全球與台灣年度重大科技與產業展覽行事曆
MAJOR_EXHIBITIONS = [
    {
        "id": "ces",
        "name": "CES 國際消費性電子展",
        "tag": "🎪 CES電子展",
        "venue": "美國拉斯維加斯會展中心 (LVCC)",
        "theme": "AI PC、AI 終端裝置、智慧車載與座艙、人形機器人、智慧家庭",
        "stocks": "聯發科(2454)、華碩(2357)、廣達(2382)、微星(2377)、技嘉(2376)、台達電(2308)",
        "schedules": [
            ("2025-01-07", "2025-01-10"),
            ("2026-01-06", "2026-01-09"),
            ("2027-01-05", "2027-01-08"),
        ],
    },
    {
        "id": "tgs",
        "name": "台北國際電玩展 (Taipei Game Show)",
        "tag": "🎪 台北電玩展",
        "venue": "台北南港展覽館 1 館",
        "theme": "電競硬體設備、遊戲主機、元宇宙 XR 沉浸裝置、AI 遊戲開發應用",
        "stocks": "微星(2377)、技嘉(2376)、華碩(2357)、智冠(5478)、鈊象(3293)",
        "schedules": [
            ("2025-01-23", "2025-01-26"),
            ("2026-01-22", "2026-01-25"),
            ("2027-01-21", "2027-01-24"),
        ],
    },
    {
        "id": "mwc",
        "name": "MWC 世界行動通訊大會",
        "tag": "🎪 MWC通訊展",
        "venue": "西班牙巴塞隆納 Fira Gran Via",
        "theme": "5G-Advanced、6G 前瞻網路、Wi-Fi 7、低軌衛星直連通訊 (NTN)、邊緣 AI 伺服器",
        "stocks": "聯發科(2454)、中磊(5388)、智邦(2345)、啟碁(6285)、智易(3596)、聯茂(6213)",
        "schedules": [
            ("2025-03-03", "2025-03-06"),
            ("2026-03-02", "2026-03-05"),
            ("2027-03-01", "2027-03-04"),
        ],
    },
    {
        "id": "gtc",
        "name": "NVIDIA GTC 全球 AI 開發者大會",
        "tag": "🎪 NVIDIA GTC",
        "venue": "美國加州聖荷西會展中心",
        "theme": "次世代 GPU 運算架構、人形機器人 Project GR00T、AI 超級運算、NVLink、液冷散熱技術",
        "stocks": "台積電(2330)、鴻海(2317)、廣達(2382)、緯穎(6669)、奇鋐(3017)、雙鴻(3324)、所羅門(2359)、川湖(2059)",
        "schedules": [
            ("2025-03-17", "2025-03-21"),
            ("2026-03-16", "2026-03-19"),
            ("2027-03-15", "2027-03-18"),
        ],
    },
    {
        "id": "touch-taiwan",
        "name": "Touch Taiwan 系列展 (智慧顯示展 / 智慧製造展)",
        "tag": "🎪 Touch Taiwan",
        "venue": "台北南港展覽館 1 館 4 樓",
        "theme": "MicroLED 次世代顯示、矽光子 (CPO)、面板級扇出型封裝 (FOPLP)、彩色電子紙、車用智慧座艙顯示",
        "stocks": "友達(2409)、群創(3481)、富采(3714)、元太(8069)、惠特(6706)、由田(3455)、群翊(6664)",
        "schedules": [
            ("2025-04-16", "2025-04-18"),
            ("2026-04-08", "2026-04-10"),
            ("2027-04-14", "2027-04-16"),
        ],
    },
    {
        "id": "computex",
        "name": "COMPUTEX 台北國際電腦展 (InnoVEX)",
        "tag": "🎪 COMPUTEX",
        "venue": "台北南港展覽館 1 館 & 2 館",
        "theme": "AI 伺服器旗艦平台、AI 算力叢集、液冷與浸沒式散熱、AI PC/邊緣運算、高頻高速傳輸",
        "stocks": "台積電(2330)、鴻海(2317)、廣達(2382)、緯創(3231)、華碩(2357)、技嘉(2376)、奇鋐(3017)、雙鴻(3324)、台達電(2308)",
        "schedules": [
            ("2025-05-20", "2025-05-23"),
            ("2026-06-02", "2026-06-05"),
            ("2027-06-01", "2027-06-04"),
        ],
    },
    {
        "id": "robot-tairos",
        "name": "台北國際自動化工業大展 & 台灣機器人與智慧自動化展 (TAIROS)",
        "tag": "🎪 機器人展",
        "venue": "台北南港展覽館 1 館 & 2 館",
        "theme": "具身智能人形機器人、AI 視覺引導、協作型機械手臂、精密減速機/滾珠螺桿、智慧工廠 AMR",
        "stocks": "所羅門(2359)、廣明(6188)、上銀(2049)、亞德客-KY(1590)、研華(2395)、新漢(8234)、凌華(6166)、大銀微系統(4576)",
        "schedules": [
            ("2025-08-20", "2025-08-23"),
            ("2026-08-19", "2026-08-22"),
            ("2027-08-18", "2027-08-21"),
        ],
    },
    {
        "id": "semicon",
        "name": "SEMICON Taiwan 國際半導體展",
        "tag": "🎪 半導體展",
        "venue": "台北南港展覽館 1 館 & 2 館",
        "theme": "埃米世代先進製程 (A16/2nm)、CoWoS/SoIC 3D 先進封裝、矽光子 (SiPh/CPO) 聯盟、半導體設備與材料自主化",
        "stocks": "台積電(2330)、日月光投控(3711)、弘塑(3131)、辛耘(3583)、萬潤(6187)、均豪(5443)、穎崴(6515)、旺矽(6223)、聯亞(3081)",
        "schedules": [
            ("2025-09-03", "2025-09-05"),
            ("2026-09-02", "2026-09-04"),
            ("2027-09-01", "2027-09-03"),
        ],
    },
    {
        "id": "tadte-aerospace",
        "name": "台北國際航太暨國防工業展 (TADTE)",
        "tag": "🎪 航太國防展",
        "venue": "台北南港展覽館 1 館",
        "theme": "軍民通用無人機防禦、國防航太裝備、低軌衛星載具通訊、高階複合材料",
        "stocks": "漢翔(2634)、雷虎(8033)、事欣科(4916)、全訊(5222)、邑錡(7402)、寶一(8222)、亞航(2630)",
        "schedules": [
            ("2025-09-18", "2025-09-20"),
            ("2027-09-16", "2027-09-18"),
        ],
    },
    {
        "id": "tpca-show",
        "name": "TPCA Show 台灣電路板產業國際展",
        "tag": "🎪 TPCA電路板展",
        "venue": "台北南港展覽館 1 館",
        "theme": "先進封裝載板 (ABF/BT)、高頻高速銅箔基板 (CCL)、高多層伺服器 PCB、高密度互連 (HDI)",
        "stocks": "欣興(3037)、景碩(3189)、南電(8046)、台光電(2383)、台燿(6274)、聯茂(6213)、金像電(2368)",
        "schedules": [
            ("2025-10-22", "2025-10-24"),
            ("2026-10-20", "2026-10-22"),
            ("2027-10-19", "2027-10-21"),
        ],
    },
    {
        "id": "energy-taiwan",
        "name": "Energy Taiwan 台灣國際智慧能源週 & Net-Zero Taiwan 淨零永續展",
        "tag": "🎪 綠能淨零展",
        "venue": "台北南港展覽館 1 館 & 2 館",
        "theme": "離岸風電水下基礎、太陽光電模組、大容量儲能系統、智慧電網與高壓重電變壓器、氫能科技",
        "stocks": "華城(1519)、士電(1503)、中興電(1513)、亞力(1514)、森崴能源(6806)、雲豹能源(6869)、世紀鋼(9958)",
        "schedules": [
            ("2025-10-29", "2025-10-31"),
            ("2026-10-14", "2026-10-16"),
            ("2027-10-27", "2027-10-29"),
        ],
    },
    {
        "id": "tasti-space",
        "name": "TASTI 台灣太空國際年會暨太空產業展",
        "tag": "🎪 太空科技展",
        "venue": "高雄展覽館 / 大台南會展中心 (TASA 官方巡迴主辦)",
        "theme": "國家太空科技計畫、低軌道通訊衛星酬載、B5G/6G 太空星系、相位陣列地面接收天線、太空級零組件驗證",
        "stocks": "昇達科(3491)、華通(2313)、金寶(2312)、台揚(2314)、元晶(6443)、事欣科(4916)、耀登(3138)",
        "schedules": [
            ("2025-10-27", "2025-10-30"),
            ("2026-11-08", "2026-11-10"),
            ("2027-10-25", "2027-10-28"),
        ],
    },
    {
        "id": "healthcare-expo",
        "name": "Healthcare+ Expo 台灣醫療科技展",
        "tag": "🎪 醫療科技展",
        "venue": "台北南港展覽館 1 館",
        "theme": "醫療生成式 AI 輔助、智慧醫院遠距照護、微創手術機器人、精準基因療法、再生醫療 CDMO",
        "stocks": "佳世達(2352)、研華(2395)、廣達(2382)、保瑞(6472)、美時(1795)、長聖(6712)",
        "schedules": [
            ("2025-12-04", "2025-12-07"),
            ("2026-12-03", "2026-12-06"),
            ("2027-12-02", "2027-12-05"),
        ],
    },
]

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
                raw_tag = it.get("tag", "個股")
                # 排除「注意股票」事件不納入行事曆
                if cat == "attention" or "注意" in raw_tag:
                    continue

                title = it.get("title", "")
                detail = it.get("detail", "")
                raw_name = code_name_map.get(code)
                c_name = raw_name if raw_name and raw_name != code else code
                display_label = f"[{code} {c_name}]" if c_name != code else f"[{code}]"
                target_name = c_name if c_name else code

                # 標籤與標題依使用者要求：標示明確目標 (如「致茂 財報」、「台積電 除息」)，日期已在月曆格中，不需重複
                if cat == "earnings" or "財報" in raw_tag or "財報" in title:
                    event_tag = f"{target_name} 財報"
                    event_title = f"{display_label} 財報/法說會公告"
                elif cat == "exdividend" or "除息" in raw_tag or "除權" in raw_tag:
                    ex_type = "息" if "息" in raw_tag else "權" if "權" in raw_tag else "權息"
                    event_tag = f"{target_name} 除{ex_type}"
                    event_title = f"{display_label} 除權除息預告 ({ex_type})"
                elif cat == "briefing" or "法說" in raw_tag or "法說" in title:
                    event_tag = f"{target_name} 法說"
                    event_title = f"{display_label} 法人說明會"
                elif cat == "revenue" or "自結" in raw_tag or "營收" in raw_tag:
                    event_tag = f"{target_name} 營收"
                    event_title = f"{display_label} 自結營收公告"
                elif cat == "disposition" or "處置" in raw_tag:
                    event_tag = f"{target_name} 處置"
                    event_title = f"{display_label} 處置股票列管"
                else:
                    cleaned_tag = re.sub(r'[\s(]*\d{1,2}/\d{1,2}[)]*', '', raw_tag).strip()
                    event_tag = f"{target_name} {cleaned_tag}" if cleaned_tag else f"{target_name} 個股"
                    cleaned_title = re.sub(r'[\s(]*\d{1,2}/\d{1,2}[)]*', '', title).strip()
                    event_title = f"{display_label} {cleaned_title}" if cleaned_title else f"{display_label} 重大事件"

                results.append(CalendarEventItem(
                    id=f"stk-{it.get('id', f'{code}-{d}')}",
                    date=d,
                    time="14:00" if "法說" in raw_tag or "法說" in title else None,
                    type="stock",
                    category=cat,
                    title=event_title,
                    tag=event_tag,
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

    def get_exhibition_events(self, year: int, month: int) -> list[CalendarEventItem]:
        """產出當月份的各大科技與產業展覽行事曆事件 (Touch Taiwan、機器人展、太空展、SEMICON、COMPUTEX等)"""
        results: list[CalendarEventItem] = []

        for exh in MAJOR_EXHIBITIONS:
            for s_date, e_date in exh.get("schedules", []):
                try:
                    s_dt = datetime.date.fromisoformat(s_date)
                    e_dt = datetime.date.fromisoformat(e_date)
                except ValueError:
                    continue

                cur = s_dt
                total_days = (e_dt - s_dt).days + 1
                while cur <= e_dt:
                    if cur.year == year and cur.month == month:
                        d_str = cur.strftime("%Y-%m-%d")
                        if cur == s_dt:
                            status_str = "開展首日"
                        elif cur == e_dt:
                            status_str = "閉幕日"
                        else:
                            day_idx = (cur - s_dt).days + 1
                            status_str = f"展期第 {day_idx}/{total_days} 天"

                        results.append(CalendarEventItem(
                            id=f"exh-{exh['id']}-{d_str}",
                            date=d_str,
                            time="全日",
                            type="exhibition",
                            category="exhibition",
                            title=f"【{status_str}】{exh['name']}",
                            tag=exh["tag"],
                            detail=(
                                f"📍 展出地點：{exh['venue']}\n"
                                f"📅 展會日程：{s_date} ~ {e_date} (每日 10:00~17:00)\n"
                                f"🎯 核心題材：{exh['theme']}\n"
                                f"💡 關鍵概念股：{exh['stocks']}"
                            ),
                            impact="High"
                        ))
                    cur += datetime.timedelta(days=1)

        return results

    async def get_month_calendar(self, year: int, month: int) -> CalendarMonthResponse:
        """整合同一月份的所有行事曆事件"""
        # 1. 期指結算日 (演算法)
        futures_events = self.calculate_futures_settlements(year, month)

        # 2. 總經固定排程 (FOMC / Jackson Hole / GDP)
        fixed_macro = self.get_macro_fixed_events(year, month)

        # 3. 總經即時 Feed (美 CPI / PPI / NFP / 失業率)
        feed_macro = self.get_macro_feed_events(year, month)

        # 4. 產業大展 (Touch Taiwan / 機器人展 / 太空展 / COMPUTEX / SEMICON 等)
        exhibition_events = self.get_exhibition_events(year, month)

        # 5. 個股事件 (自選 + 熱門權值股)
        stock_events = await self.get_stock_events(year, month)

        all_events = futures_events + fixed_macro + feed_macro + exhibition_events + stock_events

        # 依照日期與類型優先級排序 (期貨 > 總經 > 產業大展 > 個股)
        type_priority = {"futures": 0, "macro": 1, "exhibition": 2, "stock": 3}
        all_events.sort(key=lambda x: (x.date, type_priority.get(x.type, 9), x.time or "99:99"))

        return CalendarMonthResponse(
            year=year,
            month=month,
            events=all_events,
            updatedAt=datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        )

calendar_service = CalendarService()
