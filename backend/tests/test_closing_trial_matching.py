import pytest
from datetime import datetime, timezone, timedelta
from backend.app.services.shioaji_adapter import ShioajiAdapter
from backend.app.services.quote_store import quote_store

class DummyQuote:
    def __init__(self, code, close, dt, simtrade=0):
        self.code = code
        self.close = close
        self.datetime = dt
        self.simtrade = simtrade
        self.open = close
        self.high = close
        self.low = close
        self.total_volume = 100
        self.bid_price = [close]
        self.ask_price = [close]
        self.price_chg = 1.0

class DummyTick:
    def __init__(self, code, close, dt, simtrade=0):
        self.code = code
        self.close = close
        self.datetime = dt
        self.simtrade = simtrade

def test_closing_trial_matching_freeze_and_final_update():
    adapter = ShioajiAdapter()
    tz = timezone(timedelta(hours=8))
    code = "2330"
    
    # 1. 13:24:59 正常盤中成交 1000 元，零股 1001 元
    dt_normal = datetime(2026, 11, 16, 13, 24, 59, tzinfo=tz)
    q_normal = DummyQuote(code=code, close=1000.0, dt=dt_normal, simtrade=0)
    adapter._on_quote_callback(q_normal)
    
    t_normal = DummyTick(code=code, close=1001.0, dt=dt_normal, simtrade=0)
    adapter._on_tick_callback(t_normal)
    
    _, quotes = quote_store.get_all_quotes()
    assert quotes[code].last == 1000.0
    assert quotes[code].oddLotLast == 1001.0

    # 2. 13:26:00 收盤前試撮 (simtrade=1 或 13:25~13:30)，出現假撮合價 1050 元、零股 1060 元
    dt_trial = datetime(2026, 11, 16, 13, 26, 0, tzinfo=tz)
    q_trial = DummyQuote(code=code, close=1050.0, dt=dt_trial, simtrade=1)
    adapter._on_quote_callback(q_trial)

    t_trial = DummyTick(code=code, close=1060.0, dt=dt_trial, simtrade=1)
    adapter._on_tick_callback(t_trial)

    # 價格應停留在 13:25 前之真實價位，不被試撮價格污染
    _, quotes = quote_store.get_all_quotes()
    assert quotes[code].last == 1000.0
    assert quotes[code].oddLotLast == 1001.0

    # 3. 13:31:00 暫緩收盤試撮 (simtrade=1)
    dt_defer = datetime(2026, 11, 16, 13, 31, 0, tzinfo=tz)
    q_defer = DummyQuote(code=code, close=1070.0, dt=dt_defer, simtrade=1)
    adapter._on_quote_callback(q_defer)

    t_defer = DummyTick(code=code, close=1080.0, dt=dt_defer, simtrade=1)
    adapter._on_tick_callback(t_defer)

    _, quotes = quote_store.get_all_quotes()
    assert quotes[code].last == 1000.0
    assert quotes[code].oddLotLast == 1001.0

    # 4. 13:33:00 集合競價正式收盤撮合成交 (simtrade=0)，成交價 1005 元、零股 1004 元
    dt_closing = datetime(2026, 11, 16, 13, 33, 0, tzinfo=tz)
    q_closing = DummyQuote(code=code, close=1005.0, dt=dt_closing, simtrade=0)
    adapter._on_quote_callback(q_closing)

    t_closing = DummyTick(code=code, close=1004.0, dt=dt_closing, simtrade=0)
    adapter._on_tick_callback(t_closing)

    # 正式成交價應立即更新
    _, quotes = quote_store.get_all_quotes()
    assert quotes[code].last == 1005.0
    assert quotes[code].oddLotLast == 1004.0
