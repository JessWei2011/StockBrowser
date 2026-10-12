import pytest
from backend.app.services.quote_store import QuoteStore

def test_quote_store_updates_and_calcs():
    store = QuoteStore()
    store.init_or_get_quote("2330", name="台積電", exchange="TSE")
    
    # 第一次更新昨收與成交價
    updated = store.update_quote(
        code="2330",
        last=1000.0,
        previous_close=990.0,
        source_ts="2026-10-11T09:00:00Z"
    )
    assert updated is True
    
    ver, quotes = store.get_all_quotes()
    q = quotes["2330"]
    assert q.last == 1000.0
    assert q.previousClose == 990.0
    assert q.change == 10.0
    assert q.changePercent == round((10.0 / 990.0) * 100, 2)
    assert q.revision == 1
    
    # 檢查 dirty quotes
    cur_ver, dirty = store.get_dirty_quotes()
    assert len(dirty) == 1
    assert dirty[0].code == "2330"
    
    # 取出後 dirty 應被清空
    _, empty_dirty = store.get_dirty_quotes()
    assert len(empty_dirty) == 0

def test_quote_store_stale_source_ts_rejection():
    store = QuoteStore()
    store.update_quote("2330", last=100.0, source_ts="2026-10-11T09:05:00Z")
    
    # 較舊的時間戳記不應覆蓋
    updated = store.update_quote("2330", last=95.0, source_ts="2026-10-11T09:04:00Z")
    assert updated is False
    
    _, quotes = store.get_all_quotes()
    assert quotes["2330"].last == 100.0

def test_quote_store_null_not_coerced_to_zero():
    store = QuoteStore()
    store.init_or_get_quote("9999")
    _, quotes = store.get_all_quotes()
    q = quotes["9999"]
    assert q.last is None
    assert q.bid is None
    assert q.ask is None
    assert q.change is None

def test_quote_store_odd_lot_caching_and_batch():
    store = QuoteStore()
    # 批次更新零股
    store.update_odd_lot_batch({"2330": 2545.0, "0050": 114.9})
    
    # 之後初始化的個股應直接帶入零股價格
    q_2330 = store.init_or_get_quote("2330", name="台積電")
    assert q_2330.oddLotLast == 2545.0
    
    # 單筆 update_quote 更新零股
    store.update_quote("2330", odd_lot_last=2550.0)
    assert store.get_all_quotes()[1]["2330"].oddLotLast == 2550.0
