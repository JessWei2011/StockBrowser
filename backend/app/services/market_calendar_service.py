import datetime
import threading
import time
import requests
import logging
from typing import Dict, Tuple, Any

logger = logging.getLogger("market_calendar")

# 快取容器
_TWSE_CLOSURE_CACHE = {"timestamp": 0, "closed": False, "reason": "", "type": ""}
_TWSE_CLOSURE_LOCK = threading.Lock()

_TW_HOLIDAYS_CACHE: Dict[str, Any] = {"year": None, "holidays": {}, "timestamp": 0}
_TW_HOLIDAYS_LOCK = threading.Lock()


def check_twse_emergency_closure() -> Tuple[bool, str, str]:
    """檢查證交所最新新聞公告，判定今日是否有天然災害或重大臨時休市（如颱風假）。

    回傳: (is_closed, closed_reason, closed_type)
    """
    now = time.time()
    with _TWSE_CLOSURE_LOCK:
        if now - _TWSE_CLOSURE_CACHE["timestamp"] < 300 and _TWSE_CLOSURE_CACHE["timestamp"] > 0:
            return _TWSE_CLOSURE_CACHE["closed"], _TWSE_CLOSURE_CACHE["reason"], _TWSE_CLOSURE_CACHE["type"]

    today_taipei = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    roc_year = today_taipei.year - 1911
    month = today_taipei.month
    day = today_taipei.day
    date_patterns = [
        f"{roc_year}年{month}月{day}日",
        f"{roc_year}年{month:02d}月{day:02d}日",
        f"{roc_year}/{month}/{day}",
        f"{roc_year}/{month:02d}/{day:02d}",
    ]

    is_closed = False
    reason = ""
    closure_type = ""

    try:
        r = requests.get(
            "https://www.twse.com.tw/rwd/zh/news/newsList?response=json",
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"},
            timeout=5,
        )
        if r.status_code == 200:
            data = r.json().get("data", [])
            for row in data:
                if len(row) >= 2:
                    title = str(row[1])
                    for pat in date_patterns:
                        if pat in title and ("休市" in title or "暫停交易" in title):
                            is_closed = True
                            if "颱風" in title or "風災" in title or "天然災害" in title or "休市一天" in title:
                                reason = "颱風假休市"
                                closure_type = "typhoon"
                            else:
                                reason = "休市中"
                                closure_type = "holiday"
                            break
                    if is_closed:
                        break
    except Exception as e:
        logger.warning(f"Failed to check TWSE emergency closure: {e}")

    with _TWSE_CLOSURE_LOCK:
        _TWSE_CLOSURE_CACHE["timestamp"] = now
        _TWSE_CLOSURE_CACHE["closed"] = is_closed
        _TWSE_CLOSURE_CACHE["reason"] = reason
        _TWSE_CLOSURE_CACHE["type"] = closure_type
    return is_closed, reason, closure_type


def get_tw_annual_holidays() -> Dict[str, str]:
    """取得證交所公告之年度國定假日表（格式 YYYY-MM-DD -> 節日名稱）。"""
    now = time.time()
    today_taipei = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    current_year = today_taipei.year
    with _TW_HOLIDAYS_LOCK:
        if _TW_HOLIDAYS_CACHE["year"] == current_year and now - _TW_HOLIDAYS_CACHE["timestamp"] < 86400:
            return _TW_HOLIDAYS_CACHE["holidays"]

    try:
        r = requests.get(
            "https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json",
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
            timeout=5,
        )
        if r.status_code == 200:
            data = r.json()
            holidays: Dict[str, str] = {}
            for row in data.get("data", []):
                if len(row) >= 2:
                    date_str = str(row[0]).strip()
                    desc = str(row[1]).strip()
                    # 過濾掉開市交易日（例如國曆新年開始交易日、春節後開始交易日等）
                    if "開始交易" in desc:
                        continue
                    holidays[date_str] = desc
            with _TW_HOLIDAYS_LOCK:
                _TW_HOLIDAYS_CACHE["year"] = current_year
                _TW_HOLIDAYS_CACHE["holidays"] = holidays
                _TW_HOLIDAYS_CACHE["timestamp"] = now
            return holidays
    except Exception as e:
        logger.warning(f"Failed to fetch TW annual holidays: {e}")

    with _TW_HOLIDAYS_LOCK:
        return _TW_HOLIDAYS_CACHE["holidays"]


def evaluate_tw_market_status(yahoo_market_status: str | None = None) -> Dict[str, Any]:
    """計算台股現貨當前權威開休市狀態。"""
    today_taipei = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    today_str = today_taipei.strftime("%Y-%m-%d")
    taipei_minutes = today_taipei.hour * 60 + today_taipei.minute
    taipei_weekday = today_taipei.isoweekday()
    is_weekend = taipei_weekday >= 6

    # 1. 第一層：天然災害/颱風假/緊急公告
    is_twse_closed, closure_reason, closure_type = check_twse_emergency_closure()
    if is_twse_closed:
        return {
            "isOpen": False,
            "badgeLabel": closure_reason or "颱風假休市",
            "badgeType": closure_type or "typhoon",
            "reason": "證交所公告天然災害/緊急休市",
        }

    # 2. 第二層：年度國定假日
    holidays = get_tw_annual_holidays()
    if today_str in holidays:
        h_name = holidays.get(today_str, "國定假日")
        # 精簡名稱，如「端午節」、「中秋節」
        display_label = f"{h_name}休市" if not h_name.endswith("休市") else h_name
        return {
            "isOpen": False,
            "badgeLabel": display_label,
            "badgeType": "holiday",
            "reason": f"國定假日休市 ({h_name})",
        }

    # 3. 第三層：週末休市
    if is_weekend:
        return {
            "isOpen": False,
            "badgeLabel": "週末休市",
            "badgeType": "weekend",
            "reason": "週末非交易日",
        }

    # 4. 第四層：盤中時間但行情源標記已關閉 (如臨時停市)
    if yahoo_market_status == "close" and (540 <= taipei_minutes < 810):
        return {
            "isOpen": False,
            "badgeLabel": "休市中",
            "badgeType": "closed",
            "reason": "官方交易所狀態為關閉",
        }

    # 5. 第五層：交易日時段
    if taipei_minutes < 540:
        return {
            "isOpen": False,
            "badgeLabel": "未開盤",
            "badgeType": "closed",
            "reason": "開盤前時段",
        }
    elif taipei_minutes >= 810:
        return {
            "isOpen": False,
            "badgeLabel": "已收盤",
            "badgeType": "closed",
            "reason": "今日盤後收盤",
        }

    # 正常開盤中
    return {
        "isOpen": True,
        "badgeLabel": "開盤中",
        "badgeType": "open",
        "reason": "台股正常盤中交易時段",
    }


def evaluate_txf_market_status(yahoo_market_status: str | None = None) -> Dict[str, Any]:
    """計算台指期貨（全天盤）開休市狀態。"""
    today_taipei = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8)))
    today_str = today_taipei.strftime("%Y-%m-%d")
    taipei_minutes = today_taipei.hour * 60 + today_taipei.minute
    taipei_weekday = today_taipei.isoweekday()

    # 1. 颱風假/重大休市判定：若證交所休市，期交所亦同步休市
    is_twse_closed, closure_reason, closure_type = check_twse_emergency_closure()
    if is_twse_closed:
        return {
            "isOpen": False,
            "badgeLabel": closure_reason or "颱風假休市",
            "badgeType": closure_type or "typhoon",
            "reason": "期交所同步天然災害/緊急休市",
        }

    # 2. 國定假日
    holidays = get_tw_annual_holidays()
    if today_str in holidays:
        h_name = holidays.get(today_str, "國定假日")
        display_label = f"{h_name}休市" if not h_name.endswith("休市") else h_name
        return {
            "isOpen": False,
            "badgeLabel": display_label,
            "badgeType": "holiday",
            "reason": f"國定假日休市 ({h_name})",
        }

    # 3. 週末判定
    # 週日全天休市
    if taipei_weekday == 7:
        return {
            "isOpen": False,
            "badgeLabel": "週末休市",
            "badgeType": "weekend",
            "reason": "週日非交易時段",
        }
    # 週六 05:00 夜盤收盤後至週日休市
    if taipei_weekday == 6 and taipei_minutes >= 300:
        return {
            "isOpen": False,
            "badgeLabel": "週末休市",
            "badgeType": "weekend",
            "reason": "週末非交易時段",
        }
    # 週一 08:45 前未開盤
    if taipei_weekday == 1 and taipei_minutes < 525:
        return {
            "isOpen": False,
            "badgeLabel": "未開盤",
            "badgeType": "closed",
            "reason": "週一早盤前未開盤",
        }

    # 4. 常態時段 (台指全天包含日盤 08:45~13:45 與夜盤 15:00~次日05:00)
    # 日盤：525 <= mins < 825 (08:45 ~ 13:45)
    # 夜盤：mins >= 900 (15:00~) 或 mins < 300 (~05:00)
    # 盤間休息時段：13:45 ~ 15:00 (825 <= mins < 900)
    # 週二至週五晨間盤間休息：05:00 ~ 08:45 (300 <= mins < 525)
    is_open = (525 <= taipei_minutes < 825) or (taipei_minutes >= 900) or (taipei_minutes < 300)

    if is_open:
        return {
            "isOpen": True,
            "badgeLabel": "交易中",
            "badgeType": "open",
            "reason": "台指全天交易時段",
        }
    else:
        return {
            "isOpen": False,
            "badgeLabel": "休市中",
            "badgeType": "closed",
            "reason": "盤間休息時段",
        }
