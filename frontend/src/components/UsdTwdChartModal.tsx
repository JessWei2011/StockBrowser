import React, { useState } from 'react';
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
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!isOpen) return null;

  const points = data?.points || [];
  const prevClose = data?.prevClose || (points.length > 0 ? points[0].price : 32.5);
  const currentPrice = data?.price || (points.length > 0 ? points[points.length - 1].price : prevClose);
  const change = data?.change ?? (currentPrice - prevClose);
  const changePercent = data?.changePercent ?? (prevClose > 0 ? ((change / prevClose) * 100) : 0);

  const isUp = change > 0;
  const isDown = change < 0;
  const changeSign = isUp ? '▲' : isDown ? '▼' : '';

  // 繪製走勢圖幾何數據
  const width = 640;
  const height = 260;
  const padLeft = 10;
  const padRight = 55; // 留給右側數值標籤
  const padTop = 20;
  const padBottom = 30;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

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

  // 上下留 10% 緩衝
  const diff = Math.max(maxP - minP, 0.05);
  minP -= diff * 0.1;
  maxP += diff * 0.1;

  const getY = (val: number) => {
    if (maxP === minP) return padTop + plotHeight / 2;
    return padTop + plotHeight - ((val - minP) / (maxP - minP)) * plotHeight;
  };

  const getX = (idx: number, total: number) => {
    if (total <= 1) return padLeft + plotWidth / 2;
    return padLeft + (idx / (total - 1)) * plotWidth;
  };

  const refY = getY(prevClose);

  // 構造 SVG path
  let pathD = '';
  if (points.length > 0) {
    points.forEach((p, i) => {
      const x = getX(i, points.length);
      const y = getY(p.price);
      if (i === 0) pathD += `M ${x.toFixed(1)},${y.toFixed(1)}`;
      else pathD += ` L ${x.toFixed(1)},${y.toFixed(1)}`;
    });
  }

  // 懸停點資訊
  const activePoint = hoverIndex !== null && points[hoverIndex] ? points[hoverIndex] : null;
  const activeHoverPrice = activePoint ? activePoint.price : currentPrice;
  const activeHoverDiff = activeHoverPrice - prevClose;
  const activeHoverPct = prevClose > 0 ? (activeHoverDiff / prevClose) * 100 : 0;
  const activeHoverTimeStr = activePoint
    ? new Date(activePoint.time * 1000).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })
    : data?.updateTime || '';

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1200 }}>
      <div
        className="modal-container usdtwd-chart-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '680px',
          maxWidth: '95vw',
          background: 'var(--bg-card, #1a202c)',
          borderRadius: '12px',
          padding: '20px 24px',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
          border: '1px solid var(--border-color, #2d3748)',
          color: 'var(--text-primary, #f7fafc)',
        }}
      >
        {/* Modal Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '24px' }}>💵</span>
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>USD/TWD 美元/台幣</h3>
                <span style={{ fontSize: '12px', color: '#a0aec0' }}>台北外匯市場即時走勢</span>
              </div>
              <div style={{ fontSize: '11px', color: '#718096', marginTop: '2px' }}>
                來源：鉅亨網 (cnyes) 官方即時連線 ｜ 更新時間：{data?.updateTime || '--'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={onRefresh}
              disabled={isLoading}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: '#e2e8f0',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '12px',
                cursor: isLoading ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
              title="重新整理即時報價"
            >
              🔄 {isLoading ? '更新中...' : '重新整理'}
            </button>
            <a
              href="https://invest.cnyes.com/forex/detail/USDTWD/overview"
              target="_blank"
              rel="noreferrer"
              style={{
                background: 'rgba(59, 130, 246, 0.15)',
                border: '1px solid rgba(59, 130, 246, 0.3)',
                color: '#60a5fa',
                borderRadius: '6px',
                padding: '4px 10px',
                fontSize: '12px',
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
              title="前往鉅亨網 USD/TWD 詳細分析頁"
            >
              鉅亨網 ↗
            </a>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: '#a0aec0',
                fontSize: '20px',
                cursor: 'pointer',
                padding: '0 4px',
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* 核心即時數值看板 */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
            gap: '10px',
            background: 'rgba(0, 0, 0, 0.25)',
            padding: '12px 16px',
            borderRadius: '8px',
            marginBottom: '16px',
            border: '1px solid rgba(255, 255, 255, 0.05)',
          }}
        >
          <div>
            <div style={{ fontSize: '11px', color: '#a0aec0' }}>即時匯率</div>
            <div
              style={{
                fontSize: '20px',
                fontWeight: 700,
                color: isUp ? '#ef4444' : isDown ? '#22c55e' : '#e2e8f0',
              }}
            >
              {currentPrice.toFixed(3)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#a0aec0' }}>漲跌</div>
            <div
              style={{
                fontSize: '16px',
                fontWeight: 600,
                color: isUp ? '#ef4444' : isDown ? '#22c55e' : '#e2e8f0',
              }}
            >
              {changeSign} {Math.abs(change).toFixed(3)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#a0aec0' }}>漲跌幅</div>
            <div
              style={{
                fontSize: '16px',
                fontWeight: 600,
                color: isUp ? '#ef4444' : isDown ? '#22c55e' : '#e2e8f0',
              }}
            >
              {changePercent > 0 ? '+' : ''}
              {changePercent.toFixed(2)}%
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#a0aec0' }}>今日最高</div>
            <div style={{ fontSize: '15px', fontWeight: 500, color: '#f87171' }}>
              {data?.high ? data.high.toFixed(3) : '--'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#a0aec0' }}>今日最低</div>
            <div style={{ fontSize: '15px', fontWeight: 500, color: '#4ade80' }}>
              {data?.low ? data.low.toFixed(3) : '--'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '11px', color: '#a0aec0' }}>昨收 (平盤)</div>
            <div style={{ fontSize: '15px', fontWeight: 500, color: '#cbd5e1' }}>
              {prevClose.toFixed(3)}
            </div>
          </div>
        </div>

        {/* 懸停互動狀態提示 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '22px', fontSize: '12px', marginBottom: '4px', padding: '0 4px' }}>
          <div style={{ color: '#94a3b8' }}>
            {hoverIndex !== null ? (
              <span>
                時間: <strong style={{ color: '#f1f5f9' }}>{activeHoverTimeStr}</strong> ｜ 匯率:{' '}
                <strong style={{ color: activeHoverDiff > 0 ? '#ef4444' : activeHoverDiff < 0 ? '#22c55e' : '#e2e8f0' }}>
                  {activeHoverPrice.toFixed(3)}
                </strong>{' '}
                ({activeHoverDiff > 0 ? '+' : ''}{activeHoverPct.toFixed(2)}%)
              </span>
            ) : (
              <span>💡 滑鼠在圖表上移動可檢視分時細節</span>
            )}
          </div>
          <div style={{ fontSize: '11px', color: '#64748b' }}>
            基準線：昨收 {prevClose.toFixed(3)}
          </div>
        </div>

        {/* SVG 即時分時走勢圖 */}
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: `${height}px`,
            background: 'rgba(15, 23, 42, 0.6)',
            borderRadius: '8px',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            overflow: 'hidden',
          }}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {points.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#64748b' }}>
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
                const ratio = Math.max(0, Math.min(1, (mouseX - padLeft) / plotWidth));
                const idx = Math.round(ratio * (points.length - 1));
                setHoverIndex(idx);
              }}
            >
              <defs>
                <linearGradient id="forexGradientUp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ef4444" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity="0.0" />
                </linearGradient>
                <linearGradient id="forexGradientDown" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity="0.0" />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity="0.28" />
                </linearGradient>
              </defs>

              {/* 昨收參考基準線 (虛線) */}
              <line
                x1={padLeft}
                y1={refY}
                x2={padLeft + plotWidth}
                y2={refY}
                stroke="#64748b"
                strokeWidth="1"
                strokeDasharray="4 4"
                opacity="0.8"
              />
              <text
                x={padLeft + plotWidth + 6}
                y={refY + 4}
                fill="#94a3b8"
                fontSize="10"
                fontFamily="sans-serif"
              >
                {prevClose.toFixed(2)}
              </text>

              {/* 最高與最低參考水平格線 */}
              <line
                x1={padLeft}
                y1={padTop}
                x2={padLeft + plotWidth}
                y2={padTop}
                stroke="rgba(255, 255, 255, 0.05)"
                strokeWidth="1"
              />
              <text
                x={padLeft + plotWidth + 6}
                y={padTop + 4}
                fill="#f87171"
                fontSize="10"
                fontFamily="sans-serif"
              >
                {maxP.toFixed(2)}
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
                fontSize="10"
                fontFamily="sans-serif"
              >
                {minP.toFixed(2)}
              </text>

              {/* 走勢折線 */}
              <path
                d={pathD}
                fill="none"
                stroke={isUp ? '#ef4444' : isDown ? '#22c55e' : '#38bdf8'}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />

              {/* 滑鼠懸停十字線與圓點 */}
              {hoverIndex !== null && points[hoverIndex] && (
                <g>
                  {/* 垂直指示線 */}
                  <line
                    x1={getX(hoverIndex, points.length)}
                    y1={padTop}
                    x2={getX(hoverIndex, points.length)}
                    y2={padTop + plotHeight}
                    stroke="#e2e8f0"
                    strokeWidth="1"
                    strokeDasharray="2 2"
                    opacity="0.75"
                  />
                  {/* 水平指示線 */}
                  <line
                    x1={padLeft}
                    y1={getY(points[hoverIndex].price)}
                    x2={padLeft + plotWidth}
                    y2={getY(points[hoverIndex].price)}
                    stroke="#e2e8f0"
                    strokeWidth="1"
                    strokeDasharray="2 2"
                    opacity="0.75"
                  />
                  {/* 圓點 */}
                  <circle
                    cx={getX(hoverIndex, points.length)}
                    cy={getY(points[hoverIndex].price)}
                    r="4"
                    fill="#38bdf8"
                    stroke="#ffffff"
                    strokeWidth="2"
                  />
                </g>
              )}
            </svg>
          )}
        </div>

        {/* 底部時間標籤 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '11px',
            color: '#64748b',
            marginTop: '6px',
            paddingRight: `${padRight}px`,
            paddingLeft: `${padLeft}px`,
          }}
        >
          <span>09:00 開盤</span>
          <span>12:00</span>
          <span>16:00 收盤</span>
        </div>
      </div>
    </div>
  );
};
