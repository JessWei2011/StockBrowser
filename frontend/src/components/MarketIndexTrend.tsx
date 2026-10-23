import React, { useId, useMemo } from 'react';
import type { MarketIndexState } from '../types';

interface MarketIndexTrendProps {
  quote: MarketIndexState;
  width?: number;
  height?: number;
}

export const MarketIndexTrend: React.FC<MarketIndexTrendProps> = ({
  quote,
  width = 90,
  height = 32,
}) => {
  const uid = useId().replace(/:/g, '');

  const z = typeof quote.price === 'number' && Number.isFinite(quote.price) && quote.price > 0 ? quote.price : null;
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

  // 整理走勢點位陣列
  const rawPoints = useMemo(() => {
    const list: number[] = [];
    if (Array.isArray(quote.points) && quote.points.length > 0) {
      for (const p of quote.points) {
        if (typeof p === 'number' && Number.isFinite(p) && p > 0) {
          list.push(p);
        }
      }
    }

    // 若無歷史點位，以開高低現合成自然的擬真分時走勢 (避免生硬直線)
    if (list.length === 0) {
      if (o !== null && z !== null) {
        const highVal = h !== null ? h : Math.max(o, z);
        const lowVal = l !== null ? l : Math.min(o, z);
        const keyNodes = [o, highVal, lowVal, z];
        for (let i = 0; i < keyNodes.length - 1; i++) {
          const startVal = keyNodes[i];
          const endVal = keyNodes[i + 1];
          const steps = 6;
          for (let s = 0; s < steps; s++) {
            const progress = s / steps;
            const wave = Math.sin(progress * Math.PI) * (highVal - lowVal) * 0.08;
            const ease = (1 - Math.cos(progress * Math.PI)) / 2;
            list.push(startVal + (endVal - startVal) * ease + wave);
          }
        }
        list.push(z);
      }
    } else if (z !== null) {
      // 確保最後一個點位精準貼齊即時現價
      list[list.length - 1] = z;
    }

    return list;
  }, [quote.points, z, o, h, l]);

  if (y === null || z === null || rawPoints.length < 2) {
    return null;
  }

  const W = width;
  const H = height;
  const padTop = 3;
  const padBottom = 3;
  const usableH = H - padTop - padBottom;

  // 計算座標極值 (將昨收 y 納入範圍，確保基準線永遠在視圖內)
  let minVal = y;
  let maxVal = y;
  for (const pt of rawPoints) {
    if (pt < minVal) minVal = pt;
    if (pt > maxVal) maxVal = pt;
  }

  const span = maxVal - minVal;
  // 上下預留 8% 邊距，避免貼頂/貼底
  const margin = Math.max(span * 0.08, 0.5);
  const scaleMin = minVal - margin;
  const scaleMax = maxVal + margin;
  const scaleRange = scaleMax - scaleMin || 1;

  const getY = (val: number) => {
    const ratio = (val - scaleMin) / scaleRange;
    return padTop + (1 - ratio) * usableH;
  };

  const baseY = Math.max(padTop, Math.min(H - padBottom, getY(y)));
  const totalPts = rawPoints.length;

  // 產生 SVG 折線點座標
  const coords: Array<[number, number]> = rawPoints.map((pt, i) => {
    const x = (i / (totalPts - 1)) * (W - 4) + 2;
    const cy = getY(pt);
    return [Math.round(x * 10) / 10, Math.round(cy * 10) / 10];
  });

  // 採用 Catmull-Rom / Bézier 平滑貝茲曲線，確保線條自然圓潤且不失真
  const buildSmoothPath = (pts: Array<[number, number]>) => {
    if (pts.length < 2) return '';
    if (pts.length === 2) {
      return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]}`;
    }
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    const tension = 0.65;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = i > 0 ? pts[i - 1] : pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = i < pts.length - 2 ? pts[i + 2] : p2;

      const cp1x = Math.round((p1[0] + ((p2[0] - p0[0]) / 6) * tension) * 10) / 10;
      const cp1y = Math.round((p1[1] + ((p2[1] - p0[1]) / 6) * tension) * 10) / 10;
      const cp2x = Math.round((p2[0] - ((p3[0] - p1[0]) / 6) * tension) * 10) / 10;
      const cp2y = Math.round((p2[1] - ((p3[1] - p1[1]) / 6) * tension) * 10) / 10;

      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
    }
    return d;
  };

  const lineD = buildSmoothPath(coords);

  // 封閉面積路徑 (由平滑曲線路徑 + 封閉回基準線 baseY)
  const firstX = coords[0][0];
  const lastX = coords[coords.length - 1][0];
  const lastY = coords[coords.length - 1][1];
  const areaD = `${lineD} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;

  const isUp = z >= y;
  const pointColor = isUp ? '#ff5964' : '#22c55e';

  const fmt = (num: number) =>
    num.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const chg = typeof quote.change === 'number' ? quote.change : z - y;
  const pct = typeof quote.changePercent === 'number' ? quote.changePercent : (chg / y) * 100;

  const tooltip = `${quote.name || quote.code} 當日分時走勢\n現價: ${fmt(z)} (${chg >= 0 ? '+' : ''}${fmt(chg)}, ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)\n昨收基準: ${fmt(y)}\n開盤: ${o !== null ? fmt(o) : '-'}\n最高: ${h !== null ? fmt(h) : '-'}\n最低: ${l !== null ? fmt(l) : '-'}\n累積分時: ${totalPts} 點`;

  return (
    <div className="yahoo-sparkline-widget" title={tooltip}>
      <svg
        className="yahoo-sparkline-svg"
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        aria-hidden="true"
      >
        <defs>
          {/* 上半部：高於昨收的紅色漸層 */}
          <linearGradient id={`grad-up-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff5964" stopOpacity="0.45" />
            <stop offset="90%" stopColor="#ff5964" stopOpacity="0.05" />
          </linearGradient>

          {/* 下半部：低於昨收的綠色漸層 */}
          <linearGradient id={`grad-down-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="10%" stopColor="#22c55e" stopOpacity="0.05" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.45" />
          </linearGradient>

          {/* 基準線上方裁切區 (紅) */}
          <clipPath id={`clip-above-${uid}`}>
            <rect x="0" y="0" width={W} height={baseY} />
          </clipPath>

          {/* 基準線下方裁切區 (綠) */}
          <clipPath id={`clip-below-${uid}`}>
            <rect x="0" y={baseY} width={W} height={H - baseY} />
          </clipPath>
        </defs>

        {/* 昨收基準水平線 (灰色虛線) */}
        <line
          x1="1"
          y1={baseY}
          x2={W - 1}
          y2={baseY}
          stroke="var(--border-color, #94a3b8)"
          strokeDasharray="2.5,2"
          strokeWidth="1"
          opacity="0.8"
        />

        {/* 基準線上方部分：紅線 + 紅漸層填色 */}
        <g clipPath={`url(#clip-above-${uid})`}>
          <path d={areaD} fill={`url(#grad-up-${uid})`} />
          <path
            d={lineD}
            fill="none"
            stroke="#ff5964"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* 基準線下方部分：綠線 + 綠漸層填色 */}
        <g clipPath={`url(#clip-below-${uid})`}>
          <path d={areaD} fill={`url(#grad-down-${uid})`} />
          <path
            d={lineD}
            fill="none"
            stroke="#22c55e"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* 最新價格點位小圓點 */}
        <circle
          cx={lastX}
          cy={lastY}
          r="2.5"
          fill={pointColor}
          stroke="var(--bg-card, #ffffff)"
          strokeWidth="1"
        />
      </svg>
    </div>
  );
};
