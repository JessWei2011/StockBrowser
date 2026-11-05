import React, { useState, useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { StockChartData, KlineBar } from '../types';
import { fetchStockChart } from '../services/api';

interface GlobalIndexChartModalProps {
  isOpen: boolean;
  onClose: () => void;
  code: string | null;
  name?: string;
  currentPrice?: number | null;
  change?: number | null;
  changePercent?: number | null;
  statusLabel?: string;
  statusClass?: string;
}

export const GlobalIndexChartModal: React.FC<GlobalIndexChartModalProps> = ({
  isOpen,
  onClose,
  code,
  name: propName,
  currentPrice: propPrice,
  change: propChange,
  changePercent: propChangePercent,
  statusLabel,
  statusClass = 'open',
}) => {
  const [data, setData] = useState<StockChartData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 指標開關
  const [showMA, setShowMA] = useState(true);
  const [showBoll, setShowBoll] = useState(false);
  const [activeRange, setActiveRange] = useState<'1Y' | '2Y' | '6M' | '3M'>('1Y');

  const mainChartRef = useRef<HTMLDivElement | null>(null);
  const mainInstanceRef = useRef<echarts.ECharts | null>(null);

  // 載入技術分析 K 線數據（開盤交易時段每 15 秒自動刷新）
  useEffect(() => {
    if (!isOpen || !code) {
      setData(null);
      setError(null);
      return;
    }

    let isMounted = true;
    const load = (isInitial: boolean) => {
      if (isInitial) setLoading(true);
      fetchStockChart(code)
        .then((res: StockChartData) => {
          if (!isMounted) return;
          setData(res);
          if (isInitial) setLoading(false);
        })
        .catch((err: any) => {
          if (!isMounted) return;
          if (isInitial) {
            console.error(`Failed to load index chart for ${code}:`, err);
            setError(err.message || '載入走勢圖失敗');
            setLoading(false);
          }
        });
    };

    load(true);
    const timer = setInterval(() => load(false), 15000);

    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [isOpen, code]);

  // 當外部即時報價更新時，微調最新一根 K 棒
  useEffect(() => {
    if (!data || !data.kline || data.kline.length === 0 || !propPrice || propPrice <= 0) return;
    setData((prev) => {
      if (!prev || !prev.kline || prev.kline.length === 0) return prev;
      const lastIdx = prev.kline.length - 1;
      const lastBar = { ...prev.kline[lastIdx] };
      if (lastBar.close === propPrice) return prev;
      lastBar.close = propPrice;
      lastBar.high = Math.max(lastBar.high, propPrice);
      lastBar.low = Math.min(lastBar.low, propPrice);
      const updatedKline = [...prev.kline];
      updatedKline[lastIdx] = lastBar;
      return { ...prev, kline: updatedKline };
    });
  }, [propPrice]);

  // 快捷切換顯示區間 (2Y=全部, 1Y=年線視野240日, 6M=半年120日, 3M=季線60日)
  const applyRangeZoom = (range: '1Y' | '2Y' | '6M' | '3M', totalBars: number) => {
    setActiveRange(range);
    const chart = mainInstanceRef.current;
    if (!chart || totalBars <= 0) return;

    let targetBars = 240;
    if (range === '2Y') targetBars = totalBars;
    else if (range === '1Y') targetBars = Math.min(240, totalBars);
    else if (range === '6M') targetBars = Math.min(120, totalBars);
    else if (range === '3M') targetBars = Math.min(60, totalBars);

    const startPct = Math.max(0, Math.round(((totalBars - targetBars) / totalBars) * 100));
    chart.dispatchAction({
      type: 'dataZoom',
      start: startPct,
      end: 100,
    });
  };

  // 繪製 ECharts
  useEffect(() => {
    if (!data || !mainChartRef.current || !isOpen) return;

    // 銷毀舊 instance 避免記憶體洩漏
    if (mainInstanceRef.current && !mainInstanceRef.current.isDisposed()) {
      mainInstanceRef.current.dispose();
    }

    const chart = echarts.init(mainChartRef.current);
    mainInstanceRef.current = chart;

    const isDark = document.body.classList.contains('theme-dark') || !document.body.classList.contains('theme-light');
    const upColor = '#ef4444'; // 台股標準紅漲
    const downColor = '#22c55e'; // 台股標準綠跌
    const textColor = isDark ? '#94a3b8' : '#475569';
    const gridBorder = isDark ? '#334155' : '#e2e8f0';

    const kline: KlineBar[] = data.kline || [];
    const totalBars = kline.length;
    const dates = kline.map((k: KlineBar) => k.date);
    // ECharts K線格式: [open, close, lowest, highest]
    const candles = kline.map((k: KlineBar) => [k.open, k.close, k.low, k.high]);

    const ma5 = kline.map((k: KlineBar) => k.ma5 ?? null);
    const ma10 = kline.map((k: KlineBar) => k.ma10 ?? null);
    const ma20 = kline.map((k: KlineBar) => k.ma20 ?? null);
    const ma60 = kline.map((k: KlineBar) => k.ma60 ?? null);
    const ma120 = kline.map((k: KlineBar) => k.ma120 ?? null);
    const ma240 = kline.map((k: KlineBar) => k.ma240 ?? null);

    const bollUp = kline.map((k: KlineBar) => k.boll_up ?? null);
    const bollMid = kline.map((k: KlineBar) => k.boll_mid ?? null);
    const bollDown = kline.map((k: KlineBar) => k.boll_down ?? null);

    // 初始預設視野：年線視角（近 240 根 K 棒，聚焦年線與中長期趨勢）
    const initBars = Math.min(240, totalBars);
    const initStart = Math.max(0, Math.round(((totalBars - initBars) / totalBars) * 100));

    // 系列數據
    const seriesList: any[] = [
      {
        name: '日K線',
        type: 'candlestick',
        data: candles,
        itemStyle: {
          color: upColor,
          color0: downColor,
          borderColor: upColor,
          borderColor0: downColor,
        },
      },
    ];

    if (showMA) {
      seriesList.push(
        {
          name: '5MA',
          type: 'line',
          data: ma5,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.2, color: '#38bdf8' },
        },
        {
          name: '10MA',
          type: 'line',
          data: ma10,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.2, color: '#eab308' },
        },
        {
          name: '20MA',
          type: 'line',
          data: ma20,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#f43f5e' },
        },
        {
          name: '60MA',
          type: 'line',
          data: ma60,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#a855f7' },
        },
        {
          name: '120MA (半年線)',
          type: 'line',
          data: ma120,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#10b981' },
        },
        {
          name: '240MA (年線)',
          type: 'line',
          data: ma240,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#f97316' },
        }
      );
    }

    if (showBoll) {
      seriesList.push(
        {
          name: 'BOLL上軌',
          type: 'line',
          data: bollUp,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, type: 'dashed', color: '#60a5fa' },
        },
        {
          name: 'BOLL中軌',
          type: 'line',
          data: bollMid,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, color: '#93c5fd' },
        },
        {
          name: 'BOLL下軌',
          type: 'line',
          data: bollDown,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, type: 'dashed', color: '#60a5fa' },
        }
      );
    }

    const option: echarts.EChartsOption = {
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'cross',
        },
        backgroundColor: isDark ? 'rgba(15, 23, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)',
        borderColor: isDark ? '#334155' : '#cbd5e1',
        textStyle: { color: isDark ? '#f8fafc' : '#0f172a', fontSize: 12 },
        formatter: (params: any) => {
          if (!Array.isArray(params) || params.length === 0) return '';
          const p0 = params[0];
          const idx = p0.dataIndex;
          const k = kline[idx];
          if (!k) return '';

          const chg = k.close - k.open;
          const chgPct = k.open > 0 ? (chg / k.open) * 100 : 0;
          const isUp = k.close >= k.open;
          const colorHex = isUp ? upColor : downColor;

          let html = `<div style="font-weight:700;margin-bottom:6px;font-size:13px;border-bottom:1px solid ${gridBorder};padding-bottom:4px;">📅 ${k.date} ｜ ${data.name || code}</div>`;
          html += `<div style="color:${colorHex};font-weight:700;font-size:14px;margin-bottom:4px;">收盤: ${k.close.toLocaleString()} (${isUp ? '+' : ''}${chg.toFixed(2)}, ${chgPct.toFixed(2)}%)</div>`;
          html += `<div style="color:${textColor};margin-bottom:4px;">開盤: ${k.open.toLocaleString()} ｜ 最高: ${k.high.toLocaleString()} ｜ 最低: ${k.low.toLocaleString()}</div>`;

          if (k.ma240 || k.ma120 || k.ma60 || k.ma20) {
            html += `<div style="margin-top:6px;padding-top:4px;border-top:1px dashed ${gridBorder};display:flex;flex-direction:column;gap:2px;">`;
            if (k.ma240) html += `<span style="color:#f97316;">◆ 240MA (年線): ${k.ma240.toLocaleString()}</span>`;
            if (k.ma120) html += `<span style="color:#10b981;">◆ 120MA (半年線): ${k.ma120.toLocaleString()}</span>`;
            if (k.ma60) html += `<span style="color:#a855f7;">◆ 60MA (季線): ${k.ma60.toLocaleString()}</span>`;
            if (k.ma20) html += `<span style="color:#f43f5e;">◆ 20MA (月線): ${k.ma20.toLocaleString()}</span>`;
            if (k.ma10) html += `<span style="color:#eab308;">◆ 10MA: ${k.ma10.toLocaleString()}</span>`;
            if (k.ma5) html += `<span style="color:#38bdf8;">◆ 5MA: ${k.ma5.toLocaleString()}</span>`;
            html += `</div>`;
          }

          if (k.boll_up) {
            html += `<div style="color:#60a5fa;margin-top:4px;font-size:11px;">BOLL 上: ${k.boll_up.toLocaleString()} ｜ 中: ${k.boll_mid?.toLocaleString()} ｜ 下: ${k.boll_down?.toLocaleString()}</div>`;
          }

          return html;
        },
      },
      grid: {
        left: '55px',
        right: '40px',
        top: '25px',
        bottom: '50px',
      },
      xAxis: {
        type: 'category',
        data: dates,
        boundaryGap: false,
        axisLine: { lineStyle: { color: gridBorder } },
        axisLabel: {
          color: textColor,
          fontSize: 11,
          formatter: (val: string) => {
            // 如果格式為 YYYY-MM-DD，標籤僅顯示 YY/MM/DD 簡潔格式
            if (val && val.length === 10 && val.includes('-')) {
              return val.substring(2).replace(/-/g, '/');
            }
            return val;
          },
        },
        splitLine: { show: true, lineStyle: { color: isDark ? '#1e293b' : '#f1f5f9' } },
      },
      yAxis: {
        type: 'value',
        scale: true,
        position: 'right',
        axisLine: { show: true, lineStyle: { color: gridBorder } },
        splitLine: { lineStyle: { color: isDark ? '#1e293b' : '#f1f5f9' } },
        axisLabel: {
          color: textColor,
          fontSize: 11,
          formatter: (v: number) => v.toLocaleString(),
        },
      },
      dataZoom: [
        {
          type: 'inside',
          start: initStart,
          end: 100,
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
        },
        {
          type: 'slider',
          start: initStart,
          end: 100,
          bottom: '8px',
          height: '20px',
          borderColor: gridBorder,
          backgroundColor: isDark ? 'rgba(30, 41, 59, 0.5)' : 'rgba(241, 245, 249, 0.8)',
          fillerColor: isDark ? 'rgba(56, 189, 248, 0.2)' : 'rgba(2, 132, 199, 0.2)',
          handleStyle: { color: '#0284c7' },
          textStyle: { color: textColor, fontSize: 10 },
        },
      ],
      series: seriesList,
    };

    chart.setOption(option, true);

    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (chart && !chart.isDisposed()) {
        chart.dispose();
      }
    };
  }, [data, isOpen, showMA, showBoll]);

  // ESC 鍵關閉支援
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const displayPrice = propPrice ?? (data?.kline?.length ? data.kline[data.kline.length - 1].close : null);
  const displayChange = propChange;
  const displayChangePercent = propChangePercent;
  const isUp = typeof displayChange === 'number' && displayChange > 0;
  const isDown = typeof displayChange === 'number' && displayChange < 0;
  const chgColor = isUp ? 'color-up' : isDown ? 'color-down' : 'color-neutral';
  const chgSign = isUp ? '▲' : isDown ? '▼' : '';

  const totalBars = data?.kline?.length || 0;

  return (
    <div className="global-modal-overlay" style={{ zIndex: 100000 }} onClick={onClose}>
      <div
        className="global-index-chart-container"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 頂部 Header */}
        <div className="global-index-chart-header">
          <div className="global-index-chart-header-left">
            <button
              type="button"
              className="global-modal-back-btn"
              onClick={onClose}
              title="返回國際股市一覽"
            >
              <span className="back-arrow">‹</span>
              <span className="back-text">返回</span>
            </button>
            <div className="index-title-info">
              <div className="index-title-row">
                <span className="index-main-name">{propName || data?.name || code}</span>
                <span className="index-symbol-pill">{code}</span>
                <span className={`index-status-pill status-${statusClass}`}>
                  <span className="index-status-dot" />
                  {statusLabel || '大盤指數'}
                </span>
                {data?.isAppendedToday && (
                  <span className="chart-live-badge" title="已將今日開盤即時行情動態拼接至 K 線末端">
                    ● 即時連動中
                  </span>
                )}
              </div>
              {displayPrice !== null && typeof displayPrice === 'number' && (
                <div className="index-price-row">
                  <span className={`index-live-price ${chgColor}`}>
                    {displayPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  {displayChange !== undefined && displayChange !== null && (
                    <span className={`index-live-chg ${chgColor}`}>
                      {chgSign} {Math.abs(displayChange).toFixed(2)}
                      {displayChangePercent !== undefined && displayChangePercent !== null && (
                        <span> ({isUp ? '+' : ''}{displayChangePercent.toFixed(2)}%)</span>
                      )}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="global-index-chart-header-right">
            {/* 區間快速縮放按鈕 */}
            <div className="chart-range-pill-group">
              <button
                type="button"
                className={`range-pill-btn ${activeRange === '1Y' ? 'active' : ''}`}
                onClick={() => applyRangeZoom('1Y', totalBars)}
                title="聚焦近 1 年 (240 交易日) 走勢"
              >
                1年 (240日)
              </button>
              <button
                type="button"
                className={`range-pill-btn ${activeRange === '2Y' ? 'active' : ''}`}
                onClick={() => applyRangeZoom('2Y', totalBars)}
                title="查看完整 2 年 (500 交易日) 全部歷史"
              >
                全部 (2年)
              </button>
              <button
                type="button"
                className={`range-pill-btn ${activeRange === '6M' ? 'active' : ''}`}
                onClick={() => applyRangeZoom('6M', totalBars)}
                title="半年線 (120 交易日)"
              >
                半年 (120日)
              </button>
              <button
                type="button"
                className={`range-pill-btn ${activeRange === '3M' ? 'active' : ''}`}
                onClick={() => applyRangeZoom('3M', totalBars)}
                title="季線 (60 交易日)"
              >
                季線 (60日)
              </button>
            </div>

            {/* 指標切換 */}
            <div className="chart-toggle-group">
              <button
                type="button"
                className={`chart-indicator-toggle ${showMA ? 'active' : ''}`}
                onClick={() => setShowMA((prev) => !prev)}
                title="顯示/隱藏 均線群 (含年線240MA、半年線120MA、季線60MA、月線20MA)"
              >
                MA 均線群
              </button>
              <button
                type="button"
                className={`chart-indicator-toggle ${showBoll ? 'active' : ''}`}
                onClick={() => setShowBoll((prev) => !prev)}
                title="顯示/隱藏 布林通道"
              >
                布林通道
              </button>
            </div>

            <button
              type="button"
              className="global-modal-close"
              onClick={onClose}
              title="關閉技術分析視窗"
            >
              ✕
            </button>
          </div>
        </div>

        {/* 均線顏色標註列 */}
        <div className="index-ma-legend-bar">
          <span className="legend-item legend-ma5">
            <span className="legend-color-box box-ma5" /> 5MA (週)
          </span>
          <span className="legend-item legend-ma10">
            <span className="legend-color-box box-ma10" /> 10MA
          </span>
          <span className="legend-item legend-ma20">
            <span className="legend-color-box box-ma20" /> 20MA (月)
          </span>
          <span className="legend-item legend-ma60">
            <span className="legend-color-box box-ma60" /> 60MA (季)
          </span>
          <span className="legend-item legend-ma120">
            <span className="legend-color-box box-ma120" /> 120MA (半年)
          </span>
          <span className="legend-item legend-ma240">
            <span className="legend-color-box box-ma240" /> 240MA (年線)
          </span>
          <span className="legend-hint">
            💡 支援滑鼠滾輪滾動縮放，或拖拉下方時間軸滑塊調整視野
          </span>
        </div>

        {/* 內容區塊 */}
        <div className="global-index-chart-body">
          {loading && (
            <div className="chart-loading-overlay">
              <span className="chart-loading-spinner" />
              <span className="loading-text">正在讀取大盤歷史 K 線資料...</span>
            </div>
          )}

          {error && !loading && (
            <div className="chart-error-overlay">
              <span className="error-icon">⚠️</span>
              <span className="error-text">{error}</span>
              <button
                type="button"
                className="btn-retry"
                onClick={() => {
                  if (code) {
                    setLoading(true);
                    fetchStockChart(code)
                      .then((res) => {
                        setData(res);
                        setLoading(false);
                      })
                      .catch((e) => {
                        setError(e.message || '重試失敗');
                        setLoading(false);
                      });
                  }
                }}
              >
                重新載入
              </button>
            </div>
          )}

          <div
            className="index-echart-canvas"
            ref={mainChartRef}
            style={{ width: '100%', height: '100%', minHeight: '440px' }}
          />
        </div>

        {/* 底部資訊列 */}
        <div className="global-index-chart-footer">
          <div className="footer-left-info">
            <span>歷史深度: <strong>{totalBars} 根交易日 K 線</strong> (涵蓋 2 年完整週期)</span>
          </div>
          <button
            type="button"
            className="global-modal-bottom-back-btn"
            style={{ width: 'auto', padding: '6px 20px', minHeight: '34px', fontSize: '13px' }}
            onClick={onClose}
          >
            ‹ 返回大盤列表
          </button>
        </div>
      </div>
    </div>
  );
};
