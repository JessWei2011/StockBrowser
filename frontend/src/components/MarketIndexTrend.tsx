import React from 'react';
import type { MarketIndexState } from '../types';

interface MarketIndexTrendProps {
  quote: MarketIndexState;
}

export const MarketIndexTrend: React.FC<MarketIndexTrendProps> = ({ quote }) => {
  const z = typeof quote.price === 'number' && Number.isFinite(quote.price) ? quote.price : null;
  const y = typeof quote.reference === 'number' && Number.isFinite(quote.reference) && quote.reference > 0
    ? quote.reference
    : (z !== null && typeof quote.change === 'number' && Number.isFinite(quote.change) ? z - quote.change : null);

  const o = typeof quote.open === 'number' && Number.isFinite(quote.open) && quote.open > 0 ? quote.open : y;
  const h = typeof quote.high === 'number' && Number.isFinite(quote.high) && quote.high > 0
    ? quote.high
    : (y !== null && o !== null && z !== null ? Math.max(y, o, z) : z);
  const l = typeof quote.low === 'number' && Number.isFinite(quote.low) && quote.low > 0
    ? quote.low
    : (y !== null && o !== null && z !== null ? Math.min(y, o, z) : z);

  if (y === null || z === null || o === null || h === null || l === null) {
    return null;
  }

  // 1. 開高走低四種盤勢判定：開盤看昨收(y)，走高走低看今日開盤(o)
  let badgeText = '';
  if (o >= y) {
    badgeText = z >= o ? '開高走高' : '開高走低';
  } else {
    badgeText = z >= o ? '開低走高' : '開低走低';
  }

  // 2. 漲跌顏色：比對目標一律為「昨日收盤價 (y)」
  const isUp = z > y;
  const isDown = z < y;
  const badgeClass = isUp ? 'badge-up' : isDown ? 'badge-down' : 'badge-flat';
  const candleColor = isUp ? '#ff5964' : isDown ? '#4ade80' : '#94a3b8';

  const minVal = Math.min(l, y, o, z);
  const maxVal = Math.max(h, y, o, z);
  const span = maxVal - minVal || 1;
  const pad = span * 0.12;
  const chartMin = minVal - pad;
  const chartMax = maxVal + pad;
  const chartRange = chartMax - chartMin;

  const W = 38;
  const H = 28;
  const scaleY = (val: number) => Math.round((H - 3) - ((val - chartMin) / chartRange) * (H - 6));

  const yY = scaleY(y);
  const yO = scaleY(o);
  const yZ = scaleY(z);
  const yH = scaleY(h);
  const yL = scaleY(l);

  const bodyTop = Math.min(yO, yZ);
  const bodyHeight = Math.max(Math.abs(yZ - yO), 3);

  const fmt = (num: number) => num.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtShort = (num: number) => num.toLocaleString('zh-TW', {
    minimumFractionDigits: num >= 1000 ? 0 : 1,
    maximumFractionDigits: num >= 1000 ? 0 : 1,
  });

  const tooltip = `${quote.name || quote.code} 走勢脈動\n昨收: ${fmt(y)}\n開盤: ${fmt(o)}\n現價: ${fmt(z)}\n最高: ${fmt(h)}\n最低: ${fmt(l)}`;

  return (
    <div className="index-trend-widget" title={tooltip}>
      <span className={`index-trend-badge ${badgeClass}`}>{badgeText}</span>
      <div className="index-trend-body">
        <svg className="index-trend-spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
          {/* 昨收基準水平線 (黃色虛線) */}
          <line
            x1="2"
            y1={yY}
            x2={W - 2}
            y2={yY}
            stroke="#eab308"
            strokeDasharray="2.5,2"
            strokeWidth="1"
            opacity="0.85"
          />

          {/* 最高最低影線 */}
          <line
            x1={W / 2}
            y1={yH}
            x2={W / 2}
            y2={yL}
            stroke={candleColor}
            strokeWidth="1.6"
            strokeLinecap="round"
          />

          {/* K 棒實體 (開盤 ~ 現價) */}
          <rect
            x={(W - 14) / 2}
            y={bodyTop}
            width="14"
            height={bodyHeight}
            rx="1.5"
            fill={candleColor}
            stroke={candleColor}
            strokeWidth="0.5"
          />

          {/* 現價指示圓點 */}
          <circle
            cx={W / 2}
            cy={yZ}
            r="2.5"
            fill="#ffffff"
            stroke={candleColor}
            strokeWidth="1.6"
          />
        </svg>

        <div className="index-trend-labels">
          <div className="index-trend-lbl high" title={`今日最高: ${fmt(h)}`}>
            <span className="lbl-tag">高</span>
            <span className="lbl-val">{fmtShort(h)}</span>
          </div>
          <div className="index-trend-lbl low" title={`今日最低: ${fmt(l)}`}>
            <span className="lbl-tag">低</span>
            <span className="lbl-val">{fmtShort(l)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
