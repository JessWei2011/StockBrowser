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
  const changeSign = isUp ? '▲' : isDown ? '▼' : '';

  // 繪製走勢圖幾何數據
  const width = 760;
  const height = 320;
  const padLeft = 14;
  const padRight = 60; // 右側留給匯率標籤
  const padTop = 24;
  const padBottom = 34;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  // 找出今天台北時間 09:00 與 16:00 的 timestamp (以第一個 point 的日期為準)
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

  // 計算價格範圍（包含 prevClose 與所有 points，以及 high/low）
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

  // 對稱或適度留白
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
    // fallback
    if (points.length <= 1) return padLeft + plotWidth / 2;
    return padLeft + (idx / (points.length - 1)) * plotWidth;
  };

  const refY = getY(prevClose);

  // 構造 SVG path 與漸層 Area
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

  // 懸停互動
  const activePoint = hoverIndex !== null && points[hoverIndex] ? points[hoverIndex] : null;
  const activeHoverPrice = activePoint ? activePoint.price : currentPrice;
  const activeHoverDiff = activeHoverPrice - prevClose;
  const activeHoverPct = prevClose > 0 ? (activeHoverDiff / prevClose) * 100 : 0;
  const activeHoverTimeStr = activePoint
    ? new Date(activePoint.time * 1000).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
    : data?.updateTime || '';

  return (
    <div
      className="global-modal-overlay"
      onClick={onClose}
      style={{
        zIndex: 100000,
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
    >
      <div
        className="usdtwd-chart-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '780px',
          maxWidth: '96vw',
          maxHeight: '92vh',
          background: 'var(--bg-card, #131722)',
          borderRadius: '16px',
          padding: '24px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1)',
          border: '1px solid var(--border-color, #2a2e39)',
          color: 'var(--text-primary, #f7fafc)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '28px' }}>💵</span>
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                <h3 style={{ margin: 0, fontSize: '20px', fontWeight: 700, letterSpacing: '0.5px' }}>
                  美元 / 新台幣 (USD/TWD)
                </h3>
                <span
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: '10px',
                    background: 'rgba(56, 189, 248, 0.15)',
                    color: '#38bdf8',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                    fontWeight: 600,
                  }}
                >
                  台北外匯市場即時走勢
                </span>
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '3px' }}>
                數據來源：鉅亨網 (cnyes) 官方即時報價 ｜ 盤中交易時間 09:00 ~ 16:00
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={onRefresh}
              disabled={isLoading}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.18)',
                color: '#e2e8f0',
                borderRadius: '8px',
                padding: '6px 12px',
                fontSize: '12px',
                cursor: isLoading ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                transition: 'all 0.15s ease',
              }}
              title="重新整理即時走勢"
            >
              🔄 {isLoading ? '更新中...' : '重新整理'}
            </button>
            <a
              href="https://invest.cnyes.com/forex/detail/USDTWD/overview"
              target="_blank"
              rel="noreferrer"
              style={{
                background: 'rgba(59, 130, 246, 0.18)',
                border: '1px solid rgba(59, 130, 246, 0.35)',
                color: '#60a5fa',
                borderRadius: '8px',
                padding: '6px 12px',
                fontSize: '12px',
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                fontWeight: 500,
              }}
              title="前往鉅亨網 USD/TWD 詳細分析頁"
            >
              鉅亨網 ↗
            </a>
            <button
              onClick={onClose}
              style={{
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                color: '#94a3b8',
                borderRadius: '8px',
                width: '32px',
                height: '32px',
                fontSize: '16px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: 1,
              }}
              title="關閉"
            >
              ✕
            </button>
          </div>
        </div>

        {/* 核心行情指標儀表板 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(6, 1fr)',
            gap: '12px',
            background: 'rgba(0, 0, 0, 0.35)',
            padding: '14px 18px',
            borderRadius: '10px',
            marginBottom: '14px',
            border: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          <div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>即時匯率</div>
            <div
              style={{
                fontSize: '22px',
                fontWeight: 700,
                color: isUp ? '#ef4444' : isDown ? '#22c55e' : '#f8fafc',
                fontFeatureSettings: "'tnum'",
              }}
            >
              {currentPrice.toFixed(3)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>漲跌</div>
            <div
              style={{
                fontSize: '17px',
                fontWeight: 600,
                color: isUp ? '#ef4444' : isDown ? '#22c55e' : '#f8fafc',
                fontFeatureSettings: "'tnum'",
              }}
            >
              {changeSign} {Math.abs(change).toFixed(3)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>幅度</div>
            <div
              style={{
                fontSize: '17px',
                fontWeight: 600,
                color: isUp ? '#ef4444' : isDown ? '#22c55e' : '#f8fafc',
                fontFeatureSettings: "'tnum'",
              }}
            >
              {changePercent > 0 ? '+' : ''}
              {changePercent.toFixed(2)}%
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>今日最高</div>
            <div style={{ fontSize: '16px', fontWeight: 600, color: '#f87171', fontFeatureSettings: "'tnum'" }}>
              {data?.high ? data.high.toFixed(3) : '--'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>今日最低</div>
            <div style={{ fontSize: '16px', fontWeight: 600, color: '#4ade80', fontFeatureSettings: "'tnum'" }}>
              {data?.low ? data.low.toFixed(3) : '--'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '2px' }}>昨收 (平盤)</div>
            <div style={{ fontSize: '16px', fontWeight: 600, color: '#cbd5e1', fontFeatureSettings: "'tnum'" }}>
              {prevClose.toFixed(3)}
            </div>
          </div>
        </div>

        {/* 懸停動態提示列 */}
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
                時間: <strong style={{ color: '#ffffff' }}>{activeHoverTimeStr}</strong> ｜ 匯率:{' '}
                <strong style={{ color: activeHoverDiff > 0 ? '#ef4444' : activeHoverDiff < 0 ? '#22c55e' : '#f8fafc' }}>
                  {activeHoverPrice.toFixed(3)}
                </strong>{' '}
                ({activeHoverDiff > 0 ? '+' : ''}{activeHoverPct.toFixed(2)}%)
              </span>
            ) : (
              <span style={{ color: '#64748b' }}>💡 滑鼠在走勢圖上移動可檢視分時匯率</span>
            )}
          </div>
          <div style={{ fontSize: '11px', color: '#64748b' }}>
            基準平盤線：{prevClose.toFixed(3)}
          </div>
        </div>

        {/* 走勢圖主體 (SVG 繪製，比照鉅亨網分時走勢規範) */}
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: `${height}px`,
            background: 'rgba(10, 14, 23, 0.7)',
            borderRadius: '10px',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            overflow: 'hidden',
          }}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {points.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>
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
                  <stop offset="0%" stopColor="#ef4444" stopOpacity="0.32" />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity="0.02" />
                </linearGradient>
                <linearGradient id={`gradientDown-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity="0.02" />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity="0.32" />
                </linearGradient>
              </defs>

              {/* 垂直時間格線 (10:00, 11:00, 12:00, 13:00, 14:00, 15:00) */}
              {[10, 11, 12, 13, 14, 15].map((hour) => {
                const ratio = (hour - 9) / 7;
                const gx = padLeft + ratio * plotWidth;
                return (
                  <g key={hour}>
                    <line
                      x1={gx}
                      y1={padTop}
                      x2={gx}
                      y2={padTop + plotHeight}
                      stroke="rgba(255, 255, 255, 0.05)"
                      strokeWidth="1"
                    />
                  </g>
                );
              })}

              {/* 上方頂部與下方底部參考線 */}
              <line
                x1={padLeft}
                y1={padTop}
                x2={padLeft + plotWidth}
                y2={padTop}
                stroke="rgba(255, 255, 255, 0.05)"
                strokeWidth="1"
              />
              <text x={padLeft + plotWidth + 6} y={padTop + 4} fill="#f87171" fontSize="11" fontFamily="sans-serif">
                {symmetricalMax.toFixed(2)}
              </text>

              <line
                x1={padLeft}
                y1={padTop + plotHeight}
                x2={padLeft + plotWidth}
                y2={padTop + plotHeight}
                stroke="rgba(255, 255, 255, 0.05)"
                strokeWidth="1"
              />
              <text
                x={padLeft + plotWidth + 6}
                y={padTop + plotHeight + 4}
                fill="#4ade80"
                fontSize="11"
                fontFamily="sans-serif"
              >
                {symmetricalMin.toFixed(2)}
              </text>

              {/* 昨收基準水平線 (虛線) */}
              <line
                x1={padLeft}
                y1={refY}
                x2={padLeft + plotWidth}
                y2={refY}
                stroke="#64748b"
                strokeWidth="1.2"
                strokeDasharray="4 4"
                opacity="0.85"
              />
              <text x={padLeft + plotWidth + 6} y={refY + 4} fill="#94a3b8" fontSize="11" fontFamily="sans-serif">
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
                stroke={isUp ? '#ef4444' : isDown ? '#22c55e' : '#38bdf8'}
                strokeWidth="2.2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />

              {/* 滑鼠懸停十字線與亮點 */}
              {hoverIndex !== null && points[hoverIndex] && (
                <g>
                  {/* 垂直線 */}
                  <line
                    x1={getX(points[hoverIndex].time, hoverIndex)}
                    y1={padTop}
                    x2={getX(points[hoverIndex].time, hoverIndex)}
                    y2={padTop + plotHeight}
                    stroke="#f1f5f9"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                    opacity="0.7"
                  />
                  {/* 水平線 */}
                  <line
                    x1={padLeft}
                    y1={getY(points[hoverIndex].price)}
                    x2={padLeft + plotWidth}
                    y2={getY(points[hoverIndex].price)}
                    stroke="#f1f5f9"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                    opacity="0.7"
                  />
                  {/* 圓點 */}
                  <circle
                    cx={getX(points[hoverIndex].time, hoverIndex)}
                    cy={getY(points[hoverIndex].price)}
                    r="4.5"
                    fill="#38bdf8"
                    stroke="#ffffff"
                    strokeWidth="2"
                  />
                </g>
              )}
            </svg>
          )}
        </div>

        {/* 底部時間刻度 (比照鉅亨網 09:00 ~ 16:00) */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '11px',
            color: '#94a3b8',
            marginTop: '8px',
            paddingRight: `${padRight}px`,
            paddingLeft: `${padLeft}px`,
            fontFamily: 'sans-serif',
          }}
        >
          <span>09:00</span>
          <span>10:00</span>
          <span>11:00</span>
          <span>12:00</span>
          <span>13:00</span>
          <span>14:00</span>
          <span>15:00</span>
          <span>16:00</span>
        </div>
      </div>
    </div>
  );
};
