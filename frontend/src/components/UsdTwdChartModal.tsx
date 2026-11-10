import React, { useState, useId } from 'react';
import type { ForexRateResponse } from '../types';

interface UsdTwdChartModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: ForexRateResponse | null;
  isLoading: boolean;
  onRefresh: () => void;
}

export const UsdTwdChartModal: React.FC<UsdTwdChartModalProps> = ({
  isOpen,
  onClose,
  data,
  isLoading,
  onRefresh,
}) => {
  const gradientId = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!isOpen) return null;

  const points = data?.points || [];
  const prevClose = data?.prevClose || (points.length > 0 ? points[0].price : 32.5);
  const currentPrice = data?.price || (points.length > 0 ? points[points.length - 1].price : prevClose);
  const change = data?.change ?? (currentPrice - prevClose);
  const changePercent = data?.changePercent ?? (prevClose > 0 ? (change / prevClose) * 100 : 0);

  const isUp = change > 0;
  const isDown = change < 0;
  const colorClass = isUp ? 'color-up' : isDown ? 'color-down' : 'color-neutral';
  const changeSign = isUp ? '▲' : isDown ? '▼' : '';

  // 判斷台北外匯市場交易狀態 (09:00 ~ 16:00)
  const now = new Date();
  const twDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = twDate.getDay();
  const mins = twDate.getHours() * 60 + twDate.getMinutes();
  const isTradingDay = day >= 1 && day <= 5;
  const isMarketOpen = isTradingDay && mins >= 540 && mins < 960; // 09:00 ~ 16:00
  const marketStatus = isMarketOpen ? 'open' : day === 0 || day === 6 ? 'weekend' : 'closed';
  const marketLabel = isMarketOpen ? '外匯交易中' : day === 0 || day === 6 ? '週末休市' : '已收盤';

  // 走勢圖尺寸與邊界
  const width = 900;
  const height = 360;
  const padLeft = 16;
  const padRight = 64;
  const padTop = 26;
  const padBottom = 38;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  // 09:00 ~ 16:00 全日時間軸計算
  let dayStartTs = 0;
  let dayEndTs = 0;
  if (points.length > 0) {
    const firstDate = new Date(points[0].time * 1000);
    const start = new Date(firstDate);
    start.setHours(9, 0, 0, 0);
    const end = new Date(firstDate);
    end.setHours(16, 0, 0, 0);
    dayStartTs = Math.floor(start.getTime() / 1000);
    dayEndTs = Math.floor(end.getTime() / 1000);
  }

  let minP = prevClose;
  let maxP = prevClose;
  if (points.length > 0) {
    for (const p of points) {
      if (p.price < minP) minP = p.price;
      if (p.price > maxP) maxP = p.price;
    }
  }
  if (data?.high && data.high > maxP) maxP = data.high;
  if (data?.low && data.low < minP) minP = data.low;

  const maxDiff = Math.max(Math.abs(maxP - prevClose), Math.abs(minP - prevClose), 0.05);
  const symmetricalMin = prevClose - maxDiff * 1.15;
  const symmetricalMax = prevClose + maxDiff * 1.15;

  const getY = (val: number) => {
    return padTop + plotHeight - ((val - symmetricalMin) / (symmetricalMax - symmetricalMin)) * plotHeight;
  };

  const getX = (time: number, idx: number) => {
    if (dayStartTs > 0 && dayEndTs > dayStartTs) {
      const clamped = Math.max(dayStartTs, Math.min(dayEndTs, time));
      const ratio = (clamped - dayStartTs) / (dayEndTs - dayStartTs);
      return padLeft + ratio * plotWidth;
    }
    if (points.length <= 1) return padLeft + plotWidth / 2;
    return padLeft + (idx / (points.length - 1)) * plotWidth;
  };

  const refY = getY(prevClose);

  let linePath = '';
  let areaPath = '';
  if (points.length > 0) {
    points.forEach((p, i) => {
      const x = getX(p.time, i);
      const y = getY(p.price);
      if (i === 0) {
        linePath += `M ${x.toFixed(1)},${y.toFixed(1)}`;
      } else {
        linePath += ` L ${x.toFixed(1)},${y.toFixed(1)}`;
      }
    });

    const firstX = getX(points[0].time, 0);
    const lastX = getX(points[points.length - 1].time, points.length - 1);
    areaPath = `${linePath} L ${lastX.toFixed(1)},${refY.toFixed(1)} L ${firstX.toFixed(1)},${refY.toFixed(1)} Z`;
  }

  const activePoint = hoverIndex !== null && points[hoverIndex] ? points[hoverIndex] : null;
  const activeHoverPrice = activePoint ? activePoint.price : currentPrice;
  const activeHoverDiff = activeHoverPrice - prevClose;
  const activeHoverPct = prevClose > 0 ? (activeHoverDiff / prevClose) * 100 : 0;
  const activeHoverTimeStr = activePoint
    ? new Date(activePoint.time * 1000).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
    : data?.updateTime || '';

  return (
    <div className="global-modal-overlay" onClick={onClose}>
      <div
        className="global-modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(980px, 94vw)', maxHeight: '90vh' }}
      >
        {/* 頂部標題列 (與美股亞股一致) */}
        <div className="global-modal-header">
          <div className="global-modal-header-left">
            <button className="global-modal-back-btn" onClick={onClose} title="返回我的自選看盤">
              <span className="back-arrow">‹</span>
              <span className="back-text">返回</span>
            </button>
            <div className="global-modal-title-group">
              <h2 className="global-modal-title">
                <span className="global-modal-icon">💵</span> 美元 / 新台幣 (USD/TWD)
              </h2>
              <span className="global-modal-subtitle">
                {data?.updateTime ? `數據來源：鉅亨網 (cnyes) ｜ 最後同步: ${data.updateTime}` : '即時同步中'}
              </span>
            </div>
          </div>

          <div className="global-modal-actions">
            <a
              href="https://invest.cnyes.com/forex/detail/USDTWD/overview"
              target="_blank"
              rel="noreferrer"
              className="global-modal-back-btn"
              style={{ textDecoration: 'none', padding: '4px 10px', fontSize: '12px' }}
              title="前往鉅亨網 USD/TWD 官方分析頁"
            >
              <span>鉅亨網 ↗</span>
            </a>
            <button
              className={`btn-icon ${isLoading ? 'spinning' : ''}`}
              title="重新整理行情"
              onClick={onRefresh}
              disabled={isLoading}
            >
              ↻
            </button>
            <button className="global-modal-close" onClick={onClose} title="關閉視窗">
              ✕
            </button>
          </div>
        </div>

        {/* 交易時段與時鐘提示列 (與美股亞股一致) */}
        <div className="global-modal-time-banner">
          <span className="time-banner-icon">🕒</span>
          <span className="time-banner-text">
            台北外匯時段：09:00 ~ 16:00 (平日連續交易) ｜ 現貨即時基準匯率
          </span>
          <span className={`tab-market-badge ${marketStatus}`} style={{ marginLeft: 'auto' }}>
            <span className="tab-status-dot" />
            {marketLabel}
          </span>
        </div>

        {/* 內容區塊 */}
        <div style={{ padding: '16px 0 6px 0', overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {/* Yahoo 風格核心資訊卡片 */}
          <div className="yahoo-index-card status-open" style={{ marginBottom: '14px', cursor: 'default' }}>
            <div className="yahoo-card-header">
              <div className="yahoo-card-title-col">
                <div className="yahoo-card-name-row">
                  <span className="yahoo-card-name" style={{ fontSize: '17px', fontWeight: 800 }}>
                    美元 / 台幣 即時行情
                  </span>
                  <span className="yahoo-card-code">USD/TWD</span>
                  <span className={`tab-market-badge ${marketStatus}`}>
                    <span className="tab-status-dot" />
                    {marketLabel}
                  </span>
                </div>
                <div className="yahoo-card-meta-row" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  <span>幣別：新台幣 (TWD)</span>
                  <span>•</span>
                  <span>單位：1 美元</span>
                </div>
              </div>

              <div className="yahoo-card-price-col" style={{ textAlign: 'right' }}>
                <div
                  className={`yahoo-card-price ${colorClass}`}
                  style={{ fontSize: '26px', fontWeight: 800, fontFeatureSettings: "'tnum'" }}
                >
                  {currentPrice.toFixed(3)}
                </div>
                <div
                  className={`yahoo-card-chg-row ${colorClass}`}
                  style={{ fontSize: '14px', fontWeight: 700, fontFeatureSettings: "'tnum'" }}
                >
                  <span className="yahoo-card-chg-val">
                    {changeSign}
                    {Math.abs(change).toFixed(3)}
                  </span>
                  <span className="yahoo-card-chg-pct">
                    ({changePercent > 0 ? '+' : ''}
                    {changePercent.toFixed(2)}%)
                  </span>
                </div>
              </div>
            </div>

            {/* 關鍵統計指標欄 (開盤 / 最高 / 最低 / 昨收) */}
            <div
              className="yahoo-card-stats-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '10px',
                paddingTop: '10px',
                borderTop: '1px solid var(--border-color)',
                marginTop: '6px',
              }}
            >
              <div className="yahoo-stat-item">
                <span className="yahoo-stat-label">今日開盤</span>
                <span className="yahoo-stat-val" style={{ fontWeight: 700 }}>
                  {data?.open ? data.open.toFixed(3) : '--'}
                </span>
              </div>
              <div className="yahoo-stat-item">
                <span className="yahoo-stat-label">今日最高</span>
                <span className="yahoo-stat-val color-up" style={{ fontWeight: 700 }}>
                  {data?.high ? data.high.toFixed(3) : '--'}
                </span>
              </div>
              <div className="yahoo-stat-item">
                <span className="yahoo-stat-label">今日最低</span>
                <span className="yahoo-stat-val color-down" style={{ fontWeight: 700 }}>
                  {data?.low ? data.low.toFixed(3) : '--'}
                </span>
              </div>
              <div className="yahoo-stat-item">
                <span className="yahoo-stat-label">昨日收盤 (平盤)</span>
                <span className="yahoo-stat-val" style={{ fontWeight: 700 }}>
                  {prevClose.toFixed(3)}
                </span>
              </div>
            </div>
          </div>

          {/* 走勢圖頂部動態數據提示 */}
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
              {hoverIndex !== null ? (
                <span>
                  時間: <strong style={{ color: 'var(--text-main)' }}>{activeHoverTimeStr}</strong> ｜ 匯率:{' '}
                  <strong className={activeHoverDiff > 0 ? 'color-up' : activeHoverDiff < 0 ? 'color-down' : ''}>
                    {activeHoverPrice.toFixed(3)}
                  </strong>{' '}
                  ({activeHoverDiff > 0 ? '+' : ''}
                  {activeHoverPct.toFixed(2)}%)
                </span>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>💡 滑鼠在圖表上移動可檢視分時匯率</span>
              )}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              平盤基準線：{prevClose.toFixed(3)}
            </div>
          </div>

          {/* 走勢圖主體 (SVG 繪製，採用系統統一深色/淺色主題與高質感漸層) */}
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: `${height}px`,
              background: 'var(--bg-surface, rgba(15, 23, 42, 0.45))',
              borderRadius: '12px',
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
                {isLoading ? '載入今日即時走勢中...' : '暫無即時走勢數據'}
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
                  if (dayStartTs > 0 && dayEndTs > dayStartTs) {
                    const targetTs = dayStartTs + ((mouseX - padLeft) / plotWidth) * (dayEndTs - dayStartTs);
                    let closestIdx = 0;
                    let minDiff = Infinity;
                    points.forEach((p, idx) => {
                      const d = Math.abs(p.time - targetTs);
                      if (d < minDiff) {
                        minDiff = d;
                        closestIdx = idx;
                      }
                    });
                    setHoverIndex(closestIdx);
                  } else {
                    const ratio = Math.max(0, Math.min(1, (mouseX - padLeft) / plotWidth));
                    const idx = Math.round(ratio * (points.length - 1));
                    setHoverIndex(idx);
                  }
                }}
              >
                <defs>
                  <linearGradient id={`gradientUp-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ef4444" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#ef4444" stopOpacity="0.0" />
                  </linearGradient>
                  <linearGradient id={`gradientDown-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22c55e" stopOpacity="0.0" />
                    <stop offset="100%" stopColor="#22c55e" stopOpacity="0.35" />
                  </linearGradient>
                </defs>

                {/* 垂直時間格線 (10:00, 11:00, 12:00, 13:00, 14:00, 15:00) */}
                {[10, 11, 12, 13, 14, 15].map((hour) => {
                  const ratio = (hour - 9) / 7;
                  const gx = padLeft + ratio * plotWidth;
                  return (
                    <line
                      key={hour}
                      x1={gx}
                      y1={padTop}
                      x2={gx}
                      y2={padTop + plotHeight}
                      stroke="var(--border-color)"
                      strokeWidth="1"
                      strokeDasharray="2 4"
                      opacity="0.5"
                    />
                  );
                })}

                {/* 上方最高與下方最低參考格線 */}
                <line
                  x1={padLeft}
                  y1={padTop}
                  x2={padLeft + plotWidth}
                  y2={padTop}
                  stroke="var(--border-color)"
                  strokeWidth="1"
                  opacity="0.3"
                />
                <text
                  x={padLeft + plotWidth + 6}
                  y={padTop + 4}
                  fill="var(--color-up, #ef4444)"
                  fontSize="11"
                  fontFamily="sans-serif"
                  fontWeight="600"
                >
                  {symmetricalMax.toFixed(2)}
                </text>

                <line
                  x1={padLeft}
                  y1={padTop + plotHeight}
                  x2={padLeft + plotWidth}
                  y2={padTop + plotHeight}
                  stroke="var(--border-color)"
                  strokeWidth="1"
                  opacity="0.3"
                />
                <text
                  x={padLeft + plotWidth + 6}
                  y={padTop + plotHeight + 4}
                  fill="var(--color-down, #22c55e)"
                  fontSize="11"
                  fontFamily="sans-serif"
                  fontWeight="600"
                >
                  {symmetricalMin.toFixed(2)}
                </text>

                {/* 昨收平盤基準線 (虛線) */}
                <line
                  x1={padLeft}
                  y1={refY}
                  x2={padLeft + plotWidth}
                  y2={refY}
                  stroke="var(--text-muted)"
                  strokeWidth="1.2"
                  strokeDasharray="4 4"
                  opacity="0.8"
                />
                <text
                  x={padLeft + plotWidth + 6}
                  y={refY + 4}
                  fill="var(--text-muted)"
                  fontSize="11"
                  fontFamily="sans-serif"
                  fontWeight="600"
                >
                  {prevClose.toFixed(2)}
                </text>

                {/* 漸層填滿 Area */}
                {areaPath && (
                  <path
                    d={areaPath}
                    fill={isUp ? `url(#gradientUp-${gradientId})` : `url(#gradientDown-${gradientId})`}
                  />
                )}

                {/* 走勢折線 */}
                <path
                  d={linePath}
                  fill="none"
                  stroke={isUp ? 'var(--color-up, #ef4444)' : isDown ? 'var(--color-down, #22c55e)' : 'var(--color-primary, #38bdf8)'}
                  strokeWidth="2.4"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />

                {/* 滑鼠懸停十字線與亮點 */}
                {hoverIndex !== null && points[hoverIndex] && (
                  <g>
                    <line
                      x1={getX(points[hoverIndex].time, hoverIndex)}
                      y1={padTop}
                      x2={getX(points[hoverIndex].time, hoverIndex)}
                      y2={padTop + plotHeight}
                      stroke="var(--text-main)"
                      strokeWidth="1"
                      strokeDasharray="3 3"
                      opacity="0.75"
                    />
                    <line
                      x1={padLeft}
                      y1={getY(points[hoverIndex].price)}
                      x2={padLeft + plotWidth}
                      y2={getY(points[hoverIndex].price)}
                      stroke="var(--text-main)"
                      strokeWidth="1"
                      strokeDasharray="3 3"
                      opacity="0.75"
                    />
                    <circle
                      cx={getX(points[hoverIndex].time, hoverIndex)}
                      cy={getY(points[hoverIndex].price)}
                      r="4.5"
                      fill="var(--color-primary, #38bdf8)"
                      stroke="#ffffff"
                      strokeWidth="2"
                    />
                  </g>
                )}
              </svg>
            )}
          </div>

          {/* 底部時間刻度 (09:00 ~ 16:00) */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '11px',
              color: 'var(--text-muted)',
              marginTop: '8px',
              paddingRight: `${padRight}px`,
              paddingLeft: `${padLeft}px`,
              fontFamily: 'sans-serif',
              fontWeight: 600,
            }}
          >
            <span>09:00 開盤</span>
            <span>10:00</span>
            <span>11:00</span>
            <span>12:00</span>
            <span>13:00</span>
            <span>14:00</span>
            <span>15:00</span>
            <span>16:00 收盤</span>
          </div>
        </div>
      </div>
    </div>
  );
};
