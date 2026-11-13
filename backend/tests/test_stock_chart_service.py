import pytest
from datetime import datetime, date
from backend.app.services.stock_chart_service import (
    KlineBar,
    is_report_stale,
    get_latest_market_cutoff,
    recalculate_indicators,
    backfill_missing_kline_bars,
)

def test_cutoff_calculation():
    cutoff = get_latest_market_cutoff()
    assert isinstance(cutoff, datetime)
    assert cutoff.hour == 15
    assert cutoff.minute == 0

def test_recalculate_indicators():
    # 建立 25 根連續測試 K 棒
    bars = []
    for i in range(25):
        bars.append(KlineBar(
            date=f"01/{i+1:02d}",
            open=100.0 + i,
            high=105.0 + i,
            low=95.0 + i,
            close=100.0 + i,
            volume=1000.0,
        ))

    recalculate_indicators(bars)

    # 檢查第 5 根 (index 4) 的 MA5
    # closes: 100, 101, 102, 103, 104 -> 平均 = 102.0
    assert bars[4].ma5 == 102.0

    # 檢查第 10 根 (index 9) 的 MA10
    # closes 100..109 -> 平均 = 104.5
    assert bars[9].ma10 == 104.5

    # 檢查第 20 根 (index 19) 的 MA20 與布林通道
    # closes 100..119 -> 平均 = 109.5
    assert bars[19].ma20 == 109.5
    assert bars[19].boll_mid == 109.5
    assert bars[19].boll_up is not None and bars[19].boll_up > bars[19].boll_mid
    assert bars[19].boll_down is not None and bars[19].boll_down < bars[19].boll_mid

def test_gap_fill_preserves_continuous_dates():
    # 模擬缺少後續交易日的 K 棒
    bars = [
        KlineBar(date="11/02", open=2550.0, high=2575.0, low=2550.0, close=2550.0, volume=20000.0),
        KlineBar(date="11/03", open=2510.0, high=2550.0, low=2510.0, close=2540.0, volume=20000.0),
    ]

    # 對 2330 進行回補測試
    backfill_missing_kline_bars("2330", bars)

    dates = [b.date for b in bars]
    # 必須包含後續連續交易日且依序排列
    assert len(dates) > 2
    assert dates[0] == "11/02"
    assert dates[1] == "11/03"
    assert dates[2] > dates[1]

def test_backfill_skips_zero_volume_holiday_bars():
    # 測試對 2330 進行回補時，休市日（如 10/23 颱風假 Volume=0）不得被作為 K 棒回補
    bars = [
        KlineBar(date="10/21", open=2425.0, high=2435.0, low=2400.0, close=2420.0, volume=22322.0),
        KlineBar(date="10/22", open=2435.0, high=2435.0, low=2385.0, close=2385.0, volume=22930.0),
    ]
    backfill_missing_kline_bars("2330", bars)
    dates = [b.date for b in bars]
    assert "10/23" not in dates, "10/23 為休市日且成交量為 0，嚴禁畫入 K 線圖"
