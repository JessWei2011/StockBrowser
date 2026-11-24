import React, { useState, useEffect, useId, useMemo, useCallback } from 'react';
import type { QuoteState, StockIntradayPoint } from '../types';
import { fetchStockIntraday } from '../services/api';
import { stockIntradayStore } from './StockTrendSparkline';

interface StockTrendModalProps {
  isOpen: boolean;
  onClose: () => void;
  code: string;
  name?: string;
  quote?: QuoteState;
  onSelectStock?: (code: string) => void;
  onOpenOrder?: (code: string) => void;
}

interface ComputedTrendPoint {
  r: number; // 0.0 ~ 1.0 (相對於 09:00 ~ 13:30)
  timeStr: string;
  price: number;
  volume?: number;
}

/** 換算 "HH:MM" 字串為 09:00 ~ 13:30 的進度比例 r (0.0 ~ 1.0) */
function timeToProgress(timeStr: string): number {
  const parts = timeStr.split(':');
  if (parts.length < 2) return 0;
  const hour = parseInt(parts[0], 10);
  const min = parseInt(parts[1], 10);
  const totalMins = hour * 60 + min;
  const openMins = 540; // 09:00
  const closeMins = 810; // 13:30
  const elapsed = totalMins - openMins;
  return Math.max(0.0, Math.min(1.0, elapsed / (closeMins - openMins)));
}

/** 取得當前台灣市場時間進度 */
function getCurrentTwMarketProgress() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const twNow = new Date(utc + 3600000 * 8);

  const hour = twNow.getHours();
  const minute = twNow.getMinutes();
  const currentMinutes = hour * 60 + minute;
  const openMin = 540; // 09:00
  const closeMin = 810; // 13:30

  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (currentMinutes < openMin) return { r: 0.0, isTrading: false, timeStr: '09:00' };
  if (currentMinutes >= closeMin) return { r: 1.0, isTrading: false, timeStr: '13:30' };
  return { r: (currentMinutes - openMin) / (closeMin - openMin), isTrading: true, timeStr };
}

class TrendModalErrorBoundary extends React.Component<
  { children: React.ReactNode; isOpen: boolean; onClose: () => void },
  { hasError: boolean; errorInfo?: string }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, errorInfo: String(error?.message || error) };
  }

  componentDidCatch(error: any, info: any) {
    console.error('[StockTrendModal] Uncaught Render Error:', error, info);
  }

  componentDidUpdate(prevProps: any) {
    if (!prevProps.isOpen && this.props.isOpen && this.state.hasError) {
      this.setState({ hasError: false, errorInfo: undefined });
    }
  }

  render() {
    if (this.state.hasError && this.props.isOpen) {
      return (
        <div className="global-modal-overlay" onClick={this.props.onClose}>
          <div
            className="global-modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '500px', padding: '24px', textAlign: 'center' }}
          >
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
            <h3 style={{ margin: '0 0 8px 0', color: 'var(--text-main, #fff)' }}>走勢圖載入異常</h3>
            <p style={{ color: 'var(--text-muted, #94a3b8)', fontSize: '13px', margin: '0 0 16px 0' }}>
              暫時無法解析當日走勢，看盤核心已為您安全隔離保護。
            </p>
            <button type="button" className="btn-primary" onClick={this.props.onClose}>
              關閉視窗
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const StockTrendModalContent: React.FC<StockTrendModalProps> = ({
  isOpen,
  onClose,
  code,
  name,
  quote,
  onSelectStock,
  onOpenOrder,
}) => {
  const gradientId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [intradayPoints, setIntradayPoints] = useState<StockIntradayPoint[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // 鍵盤 Esc 關閉
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // 載入當日 1m 分時數據
  const loadIntraday = useCallback(async () => {
    if (!code) return;
    setIsLoading(true);
    try {
      const data = await fetchStockIntraday(code);
      if (data && Array.isArray(data.points) && data.points.length > 0) {
        setIntradayPoints(data.points);
      }
    } catch (e) {
      console.warn(`[StockTrendModal] Failed to fetch 1m intraday for ${code}:`, e);
    } finally {
      setIsLoading(false);
    }
  }, [code]);

  useEffect(() => {
    if (isOpen && code) {
      loadIntraday();
    } else {
      setIntradayPoints([]);
      setHoverIndex(null);
    }
  }, [isOpen, code, loadIntraday]);

  // 取得基礎報價數值 (安全型別防護)
  const prevClose =
    typeof quote?.previousClose === 'number' && quote.previousClose > 0
      ? quote.previousClose
      : intradayPoints.length > 0 && typeof intradayPoints[0].price === 'number'
      ? intradayPoints[0].price
      : 100;

  const currentPrice =
    typeof quote?.last === 'number' && quote.last > 0
      ? quote.last
      : intradayPoints.length > 0 && typeof intradayPoints[intradayPoints.length - 1].price === 'number'
      ? intradayPoints[intradayPoints.length - 1].price
      : prevClose;

  const openPrice =
    typeof quote?.open === 'number' && quote.open > 0
      ? quote.open
      : intradayPoints.length > 0 && typeof intradayPoints[0].open === 'number'
      ? intradayPoints[0].open
      : currentPrice;

  const highPrice =
    typeof quote?.high === 'number' && quote.high > 0
      ? quote.high
      : intradayPoints.length > 0
      ? Math.max(...intradayPoints.map((p) => p.high ?? p.price))
      : currentPrice;

  const lowPrice =
    typeof quote?.low === 'number' && quote.low > 0
      ? quote.low
      : intradayPoints.length > 0
      ? Math.min(...intradayPoints.map((p) => p.low ?? p.price))
      : currentPrice;

  const totalVol = quote?.totalVolume;

  const change =
    typeof quote?.change === 'number'
      ? quote.change
      : currentPrice - prevClose;

  const changePercent =
    typeof quote?.changePercent === 'number'
      ? quote.changePercent
      : prevClose > 0
      ? (change / prevClose) * 100
      : 0;

  const isUp = change > 0;
  const isDown = change < 0;
  const colorClass = isUp ? 'color-up' : isDown ? 'color-down' : 'color-neutral';
  const changeSign = isUp ? '▲' : isDown ? '▼' : '';

  const isOtc = ['OTC', 'TWO'].includes((quote?.exchange || '').toUpperCase());

  // 彙整分時數據點位 (Hook 必須永遠在條件 return 之前執行以遵守 React 規則)
  const points: ComputedTrendPoint[] = useMemo(() => {
    if (!isOpen) return [];

    const list: ComputedTrendPoint[] = [];

    if (intradayPoints.length > 0) {
      for (const pt of intradayPoints) {
        const r = timeToProgress(pt.time);
        list.push({
          r,
          timeStr: pt.time,
          price: pt.price,
          volume: pt.volume,
        });
      }

      // 若即時現價與最新點位有差異，追加最新點位
      const twNow = getCurrentTwMarketProgress();
      if (twNow.isTrading && currentPrice > 0) {
        const lastPt = list[list.length - 1];
        if (lastPt && (Math.abs(twNow.r - lastPt.r) > 0.002 || Math.abs(currentPrice - lastPt.price) > 0.01)) {
          list.push({
            r: Math.max(lastPt.r + 0.001, twNow.r),
            timeStr: twNow.timeStr,
            price: currentPrice,
          });
        }
      }
    } else {
      // 若後端 1m 數據尚未返回或離線，使用記憶體中累積的點位
      const stored = stockIntradayStore.get(code)?.points || [];
      if (stored.length > 0) {
        for (const pt of stored) {
          const totalMins = Math.round(pt.r * 270);
          const hh = Math.floor((540 + totalMins) / 60);
          const mm = (540 + totalMins) % 60;
          const timeStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
          list.push({
            r: pt.r,
            timeStr,
            price: pt.p,
          });
        }
      } else {
        // 合成基本的開高低現點位
        const twNow = getCurrentTwMarketProgress();
        const o = openPrice ?? currentPrice;
        list.push({ r: 0.0, timeStr: '09:00', price: o });
        if (twNow.r > 0.05) {
          if (highPrice && highPrice !== o && highPrice !== currentPrice) {
            list.push({ r: twNow.r * 0.35, timeStr: '09:45', price: highPrice });
          }
          if (lowPrice && lowPrice !== o && lowPrice !== currentPrice && lowPrice !== highPrice) {
            list.push({ r: twNow.r * 0.7, timeStr: '11:15', price: lowPrice });
          }
        }
        list.push({ r: Math.max(0.01, twNow.r), timeStr: twNow.timeStr, price: currentPrice });
      }
    }

    return list;
  }, [isOpen, intradayPoints, code, currentPrice, openPrice, highPrice, lowPrice]);

  // 所有 Hooks 執行完畢後方可 return null
  if (!isOpen) return null;


  // 尺寸規格
  const width = 880;
  const height = 370;
  const padLeft = 14;
  const padRight = 68;
  const padTop = 18;
  const pricePlotH = 240;
  const volGap = 16;
  const volPlotH = 60;
  const plotW = width - padLeft - padRight;

  // 計算價格尺度 (以昨收基準為軸心對稱縮放)
  let minP = prevClose;
  let maxP = prevClose;
  for (const pt of points) {
    if (pt.price < minP) minP = pt.price;
    if (pt.price > maxP) maxP = pt.price;
  }
  if (highPrice && highPrice > maxP) maxP = highPrice;
  if (lowPrice && lowPrice < minP) minP = lowPrice;

  const maxDiff = Math.max(Math.abs(maxP - prevClose), Math.abs(minP - prevClose), prevClose * 0.008);
  const scaleMin = prevClose - maxDiff * 1.15;
  const scaleMax = prevClose + maxDiff * 1.15;
  const scaleRange = Math.max(0.001, scaleMax - scaleMin);

  const getPriceY = (val: number) => {
    const ratio = (val - scaleMin) / scaleRange;
    return padTop + pricePlotH - ratio * pricePlotH;
  };

  const baseY = getPriceY(prevClose);

  // 計算成交量尺度
  let maxVol = 1;
  for (const pt of points) {
    if (pt.volume && pt.volume > maxVol) maxVol = pt.volume;
  }

  const volPlotTop = padTop + pricePlotH + volGap;
  const getVolY = (vol: number) => {
    const ratio = Math.min(1.0, vol / maxVol);
    return volPlotTop + volPlotH - ratio * volPlotH;
  };

  // 生成折線路徑
  const coords: Array<[number, number]> = points.map((pt) => {
    const cx = padLeft + pt.r * plotW;
    const cy = getPriceY(pt.price);
    return [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10];
  });

  const firstX = coords.length > 0 ? coords[0][0] : padLeft;
  const lastX = coords.length > 0 ? coords[coords.length - 1][0] : padLeft + plotW;
  const lastY = coords.length > 0 ? coords[coords.length - 1][1] : baseY;

  const lineD = coords.reduce((acc, [x, y], i) => `${acc} ${i === 0 ? 'M' : 'L'} ${x} ${y}`, '');
  const areaD = coords.length > 0 ? `${lineD} L ${lastX} ${baseY} L ${firstX} ${baseY} Z` : '';

  // 懸停點位
  const activeHoverPt = hoverIndex !== null && hoverIndex >= 0 && hoverIndex < points.length ? points[hoverIndex] : null;
  const activeHoverPrice = activeHoverPt ? activeHoverPt.price : currentPrice;
  const activeHoverDiff = activeHoverPrice - prevClose;
  const activeHoverPct = prevClose > 0 ? (activeHoverDiff / prevClose) * 100 : 0;
  const activeHoverX = activeHoverPt ? padLeft + activeHoverPt.r * plotW : lastX;
  const activeHoverY = activeHoverPt ? getPriceY(activeHoverPt.price) : lastY;

  return (
    <div className="global-modal-overlay" onClick={onClose}>
      <div
        className="global-modal-content stock-trend-modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '940px', width: '95%' }}
      >
        {/* 頂部功能與關閉欄 */}
        <div className="global-modal-header">
          <div className="global-modal-title">
            <span className={`exchange-badge ${isOtc ? 'badge-otc' : 'badge-tse'}`} style={{ marginRight: '6px' }}>
              {isOtc ? '櫃' : '市'}
            </span>
            <span style={{ fontSize: '18px', fontWeight: 800 }}>{name || code}</span>
            <span style={{ fontSize: '14px', color: 'var(--text-muted)', marginLeft: '6px' }}>({code})</span>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '8px', fontWeight: 500 }}>
              當日即時分時走勢
            </span>
          </div>

          <div className="global-modal-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {onSelectStock && (
              <button
                type="button"
                className="global-modal-back-btn"
                style={{ fontSize: '12px', padding: '4px 10px' }}
                title="切換至該股歷史日K、布林通道與三大法人籌碼分析抽屜"
                onClick={() => {
                  onClose();
                  onSelectStock(code);
                }}
              >
                📊 日K技術籌碼 ↗
              </button>
            )}

            {onOpenOrder && (
              <button
                type="button"
                className="btn-primary"
                style={{ fontSize: '12px', padding: '4px 10px', height: '28px' }}
                title={`帶入「${name || code}」快速下單`}
                onClick={() => {
                  onClose();
                  onOpenOrder(code);
                }}
              >
                ⚡ 快速下單
              </button>
            )}

            <button
              type="button"
              className={`btn-icon ${isLoading ? 'spinning' : ''}`}
              title="重新整理分時走勢"
              onClick={loadIntraday}
              disabled={isLoading}
            >
              ↻
            </button>

            <button type="button" className="global-modal-close" onClick={onClose} title="關閉視窗 (Esc)">
              ✕
            </button>
          </div>
        </div>

        {/* 內容區塊 */}
        <div style={{ padding: '16px 20px 20px 20px', overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {/* 核心行情指標橫條卡片 */}
        <div className="yahoo-index-card" style={{ marginBottom: '12px', cursor: 'default' }}>
          <div className="yahoo-card-header" style={{ alignItems: 'center' }}>
            <div className="yahoo-card-title-col">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                <span className={`yahoo-card-price ${colorClass}`} style={{ fontSize: '28px', fontWeight: 800 }}>
                  {currentPrice.toFixed(2)}
                </span>
                <span className={`yahoo-card-chg-row ${colorClass}`} style={{ fontSize: '16px', fontWeight: 700 }}>
                  <span>
                    {changeSign}
                    {Math.abs(change).toFixed(2)}
                  </span>
                  <span style={{ marginLeft: '4px' }}>
                    ({changePercent >= 0 ? '+' : ''}
                    {changePercent.toFixed(2)}%)
                  </span>
                </span>
              </div>
            </div>

            <div
              className="yahoo-card-stats-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(5, auto)',
                gap: '16px',
                marginLeft: 'auto',
              }}
            >
              <div className="yahoo-stat-item">
                <span className="yahoo-stat-label">昨收</span>
                <span className="yahoo-stat-val">{prevClose.toFixed(2)}</span>
              </div>
              <div className="yahoo-stat-item">
                <span className="yahoo-stat-label">開盤</span>
                <span className="yahoo-stat-val">{openPrice ? openPrice.toFixed(2) : '—'}</span>
              </div>
              <div className="yahoo-stat-item">
                <span className="yahoo-stat-label">最高</span>
                <span className="yahoo-stat-val color-up">{highPrice ? highPrice.toFixed(2) : '—'}</span>
              </div>
              <div className="yahoo-stat-item">
                <span className="yahoo-stat-label">最低</span>
                <span className="yahoo-stat-val color-down">{lowPrice ? lowPrice.toFixed(2) : '—'}</span>
              </div>
              <div className="yahoo-stat-item">
                <span className="yahoo-stat-label">總量</span>
                <span className="yahoo-stat-val">{totalVol ? totalVol.toLocaleString() : '—'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* 即時提示列 (滑鼠懸停特定時間與價格提示) */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            height: '24px',
            fontSize: '12px',
            marginBottom: '6px',
            padding: '0 4px',
          }}
        >
          <div>
            {activeHoverPt ? (
              <span>
                時間: <strong style={{ color: 'var(--text-main)' }}>{activeHoverPt.timeStr}</strong> ｜ 價格:{' '}
                <strong className={activeHoverDiff > 0 ? 'color-up' : activeHoverDiff < 0 ? 'color-down' : ''}>
                  {activeHoverPrice.toFixed(2)}
                </strong>{' '}
                ({activeHoverDiff >= 0 ? '+' : ''}
                {activeHoverDiff.toFixed(2)}, {activeHoverPct >= 0 ? '+' : ''}
                {activeHoverPct.toFixed(2)}%)
                {activeHoverPt.volume !== undefined && activeHoverPt.volume > 0 && (
                  <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>
                    ｜ 分量: {Math.round(activeHoverPt.volume / 1000)} 張
                  </span>
                )}
              </span>
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>
                💡 滑鼠移至圖表上可檢視全日分時價格與成交量 ｜ 平盤基準線：{prevClose.toFixed(2)}
              </span>
            )}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            台股交易時段：09:00 ~ 13:30 (分時連動)
          </div>
        </div>

        {/* 走勢圖主體容器 */}
        <div
          className="stock-trend-chart-box"
          style={{
            height: `${height}px`,
            position: 'relative',
            background: 'var(--bg-card, #1e293b)',
            borderRadius: '8px',
            border: '1px solid var(--border-color)',
            overflow: 'hidden',
          }}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {points.length === 0 ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'var(--text-muted)',
              }}
            >
              {isLoading ? '載入分時走勢中...' : '暫無即時走勢數據'}
            </div>
          ) : (
            <svg
              width="100%"
              height="100%"
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              style={{ display: 'block', cursor: 'crosshair' }}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const mouseX = ((e.clientX - rect.left) / rect.width) * width;
                const ratio = Math.max(0, Math.min(1, (mouseX - padLeft) / plotW));

                let closestIdx = 0;
                let minDiff = Infinity;
                points.forEach((pt, idx) => {
                  const d = Math.abs(pt.r - ratio);
                  if (d < minDiff) {
                    minDiff = d;
                    closestIdx = idx;
                  }
                });
                setHoverIndex(closestIdx);
              }}
            >
              <defs>
                <linearGradient id={`trendUp-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ef4444" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity="0.02" />
                </linearGradient>
                <linearGradient id={`trendDown-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity="0.02" />
                  <stop offset="100%" stopColor="#10b981" stopOpacity="0.4" />
                </linearGradient>

                <clipPath id={`clipPriceAbove-${gradientId}`}>
                  <rect x="0" y="0" width={width} height={baseY} />
                </clipPath>
                <clipPath id={`clipPriceBelow-${gradientId}`}>
                  <rect x="0" y={baseY} width={width} height={height - baseY} />
                </clipPath>
              </defs>

              {/* 垂直時間網格線 (09:00, 10:00, 11:00, 12:00, 13:00, 13:30) */}
              {[
                { label: '09:00', r: 0.0 },
                { label: '10:00', r: 60 / 270 },
                { label: '11:00', r: 120 / 270 },
                { label: '12:00', r: 180 / 270 },
                { label: '13:00', r: 240 / 270 },
                { label: '13:30', r: 1.0 },
              ].map(({ label, r }) => {
                const gx = padLeft + r * plotW;
                return (
                  <g key={label}>
                    <line
                      x1={gx}
                      y1={padTop}
                      x2={gx}
                      y2={padTop + pricePlotH}
                      stroke="var(--border-color, #334155)"
                      strokeDasharray="2,2"
                      strokeWidth="0.8"
                      opacity="0.6"
                    />
                    <line
                      x1={gx}
                      y1={volPlotTop}
                      x2={gx}
                      y2={volPlotTop + volPlotH}
                      stroke="var(--border-color, #334155)"
                      strokeDasharray="2,2"
                      strokeWidth="0.8"
                      opacity="0.4"
                    />
                    <text
                      x={gx}
                      y={padTop + pricePlotH + 12}
                      textAnchor="middle"
                      fontSize="10"
                      fill="var(--text-muted, #94a3b8)"
                    >
                      {label}
                    </text>
                  </g>
                );
              })}

              {/* 昨收基準線 (水平虛線，貫穿 09:00 ~ 13:30) */}
              <line
                x1={padLeft}
                y1={baseY}
                x2={padLeft + plotW}
                y2={baseY}
                stroke="var(--border-color, #64748b)"
                strokeDasharray="3,3"
                strokeWidth="1"
                opacity="0.85"
              />

              {/* 右側 Y 軸標籤 (昨收、極值與漲跌幅) */}
              <text
                x={padLeft + plotW + 6}
                y={padTop + 10}
                fontSize="10"
                fill="#ef4444"
                textAnchor="start"
                fontWeight="600"
              >
                {scaleMax.toFixed(2)} (+{(((scaleMax - prevClose) / prevClose) * 100).toFixed(2)}%)
              </text>
              <text
                x={padLeft + plotW + 6}
                y={baseY + 3}
                fontSize="10"
                fill="var(--text-muted, #94a3b8)"
                textAnchor="start"
                fontWeight="500"
              >
                {prevClose.toFixed(2)} (0.00%)
              </text>
              <text
                x={padLeft + plotW + 6}
                y={padTop + pricePlotH - 4}
                fontSize="10"
                fill="#10b981"
                textAnchor="start"
                fontWeight="600"
              >
                {scaleMin.toFixed(2)} ({(((scaleMin - prevClose) / prevClose) * 100).toFixed(2)}%)
              </text>

              {/* 價格走勢面積與折線 (基準線上紅色，基準線下綠色) */}
              <g clipPath={`url(#clipPriceAbove-${gradientId})`}>
                <path d={areaD} fill={`url(#trendUp-${gradientId})`} />
                <path d={lineD} fill="none" stroke="#ef4444" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </g>

              <g clipPath={`url(#clipPriceBelow-${gradientId})`}>
                <path d={areaD} fill={`url(#trendDown-${gradientId})`} />
                <path d={lineD} fill="none" stroke="#10b981" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </g>

              {/* 分時成交量長條圖 (柱狀圖) */}
              {points.map((pt, idx) => {
                if (!pt.volume || pt.volume <= 0) return null;
                const bx = padLeft + pt.r * plotW;
                const by = getVolY(pt.volume);
                const bh = volPlotTop + volPlotH - by;
                const prevP = idx > 0 ? points[idx - 1].price : prevClose;
                const isBarUp = pt.price >= prevP;
                const barColor = isBarUp ? 'rgba(239, 68, 68, 0.7)' : 'rgba(16, 185, 129, 0.7)';
                return (
                  <rect
                    key={idx}
                    x={bx - 1}
                    y={by}
                    width={2}
                    height={Math.max(1, bh)}
                    fill={barColor}
                  />
                );
              })}

              {/* 最新價格點位小圓點 */}
              {coords.length > 0 && (
                <circle
                  cx={lastX}
                  cy={lastY}
                  r="3"
                  fill={isUp ? '#ef4444' : isDown ? '#10b981' : '#94a3b8'}
                  stroke="var(--bg-card, #1e293b)"
                  strokeWidth="1.5"
                />
              )}

              {/* 滑鼠懸停十字游標線與標記點 */}
              {activeHoverPt && (
                <g>
                  {/* 垂直十字線 */}
                  <line
                    x1={activeHoverX}
                    y1={padTop}
                    x2={activeHoverX}
                    y2={volPlotTop + volPlotH}
                    stroke="var(--text-main, #ffffff)"
                    strokeDasharray="2,2"
                    strokeWidth="1"
                    opacity="0.8"
                  />
                  {/* 橫向價格十字線 */}
                  <line
                    x1={padLeft}
                    y1={activeHoverY}
                    x2={padLeft + plotW}
                    y2={activeHoverY}
                    stroke="var(--text-main, #ffffff)"
                    strokeDasharray="2,2"
                    strokeWidth="1"
                    opacity="0.8"
                  />
                  {/* 懸停點圓圈 */}
                  <circle
                    cx={activeHoverX}
                    cy={activeHoverY}
                    r="4"
                    fill={activeHoverDiff >= 0 ? '#ef4444' : '#10b981'}
                    stroke="#ffffff"
                    strokeWidth="2"
                  />
                </g>
              )}
            </svg>
          )}
        </div>
        </div>
      </div>
    </div>
  );
};

export const StockTrendModal: React.FC<StockTrendModalProps> = (props) => {
  if (!props.isOpen) return null;
  return (
    <TrendModalErrorBoundary isOpen={props.isOpen} onClose={props.onClose}>
      <StockTrendModalContent {...props} />
    </TrendModalErrorBoundary>
  );
};

