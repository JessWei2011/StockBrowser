import React, { useId, useMemo } from 'react';

export interface StockTrendSparklineProps {
  open: number | null | undefined;
  high: number | null | undefined;
  low: number | null | undefined;
  last: number | null | undefined;
  previousClose: number | null | undefined;
  width?: number;
  height?: number;
  name?: string;
  code?: string;
  onClick?: () => void;
}

export interface IntradayPoint {
  r: number; // 0.0 ~ 1.0 (相對於台股 09:00~13:30 之進度比例)
  p: number; // 價格
}

// 全域記憶體分時歷史點位 (按日期隔離，盤中實時累積，隔日自動清空重置)
export const stockIntradayStore = new Map<string, { date: string; points: IntradayPoint[] }>();


/** 取得當前台灣市場時間資訊與交易時段進度 (09:00 - 13:30) */
function getTaiwanMarketProgress() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const twNow = new Date(utc + 3600000 * 8);

  const year = twNow.getFullYear();
  const month = String(twNow.getMonth() + 1).padStart(2, '0');
  const day = String(twNow.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  const dayOfWeek = twNow.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  const hour = twNow.getHours();
  const minute = twNow.getMinutes();
  const second = twNow.getSeconds();
  const currentMinutes = hour * 60 + minute + second / 60;

  // 09:00 = 540 分鐘, 13:30 = 810 分鐘, 總計 270 分鐘
  const openMin = 540;
  const closeMin = 810;
  const duration = closeMin - openMin; // 270

  if (isWeekend) {
    return { dateStr, progress: 1.0, isTrading: false, minutesIn: 270 };
  }
  if (currentMinutes < openMin) {
    return { dateStr, progress: 0.0, isTrading: false, minutesIn: 0 };
  }
  if (currentMinutes >= closeMin) {
    return { dateStr, progress: 1.0, isTrading: false, minutesIn: 270 };
  }

  // 盤中交易中：進度介於 0.02 (開盤剛起跑) 到 0.99 之間
  const elapsed = currentMinutes - openMin;
  const progress = Math.max(0.02, Math.min(0.99, elapsed / duration));
  return { dateStr, progress, isTrading: true, minutesIn: Math.floor(elapsed) };
}

export const StockTrendSparkline: React.FC<StockTrendSparklineProps> = ({
  open,
  high,
  low,
  last,
  previousClose,
  width = 56,
  height = 22,
  name,
  code,
  onClick,
}) => {
  const uid = useId().replace(/:/g, '');

  const z = typeof last === 'number' && Number.isFinite(last) && last > 0 ? last : null;
  const y = typeof previousClose === 'number' && Number.isFinite(previousClose) && previousClose > 0
    ? previousClose
    : null;

  const o = typeof open === 'number' && Number.isFinite(open) && open > 0 ? open : (z ?? y);
  const h = typeof high === 'number' && Number.isFinite(high) && high > 0
    ? high
    : (o !== null && z !== null ? Math.max(o, z) : (z ?? y));
  const l = typeof low === 'number' && Number.isFinite(low) && low > 0
    ? low
    : (o !== null && z !== null ? Math.min(o, z) : (z ?? y));

  const { dateStr, progress, isTrading, minutesIn } = getTaiwanMarketProgress();

  // 維護並取得今日盤中累計分時點位 (真實隨時間前進而向右延伸)
  const points = useMemo(() => {
    if (!code || z === null) return [];

    let entry = stockIntradayStore.get(code);
    if (!entry || entry.date !== dateStr) {
      entry = { date: dateStr, points: [] };
      stockIntradayStore.set(code, entry);
    }

    const pts = entry.points;
    const currentR = Math.round(progress * 1000) / 1000;
    const openVal = o ?? z;

    // 若今日此代號尚未記錄任何點位
    if (pts.length === 0) {
      pts.push({ r: 0, p: openVal });
      if (progress > 0.06) {
        // 中途進入（例如盤中 10 點才開啟頁面）：依據已知高低與現價自然插值過渡
        const highVal = h ?? Math.max(openVal, z);
        const lowVal = l ?? Math.min(openVal, z);
        if (highVal !== openVal && highVal !== z) {
          pts.push({ r: Math.round(currentR * 0.35 * 1000) / 1000, p: highVal });
        }
        if (lowVal !== openVal && lowVal !== z && lowVal !== highVal) {
          pts.push({ r: Math.round(currentR * 0.7 * 1000) / 1000, p: lowVal });
        }
      }
      pts.push({ r: currentR, p: z });
    } else {
      // 隨盤中跳價或時間推進實時追加/修正最新點位
      const lastPt = pts[pts.length - 1];
      const timeDelta = currentR - lastPt.r;
      const priceDelta = Math.abs(z - lastPt.p);

      if (timeDelta >= 0.005 || (priceDelta > 0.001 && timeDelta > 0.001)) {
        pts.push({ r: currentR, p: z });
      } else {
        lastPt.p = z;
        lastPt.r = currentR;
      }

      // 控制最大點數不超過 120 點，確保極致輕量
      if (pts.length > 120) {
        const first = pts[0];
        const lastOne = pts[pts.length - 1];
        const downsampled = pts.filter((_, idx) => idx % 2 === 0);
        downsampled[0] = first;
        if (downsampled[downsampled.length - 1] !== lastOne) {
          downsampled.push(lastOne);
        }
        entry.points = downsampled;
      }
    }

    return [...entry.points];
  }, [code, dateStr, progress, z, o, h, l]);

  // 若無充足資料可繪圖
  if ((z === null && y === null) || (points.length === 0 && z === null)) {
    return <span className="stock-sparkline-placeholder">—</span>;
  }

  const W = width;
  const H = height;
  const padTop = 2;
  const padBottom = 2;
  const padLeft = 2;
  const padRight = 2;
  const usableW = W - padLeft - padRight;
  const usableH = H - padTop - padBottom;

  const baselineRef = y !== null ? y : (o ?? z ?? 0);

  // 計算座標極值 (將昨收基準 baselineRef 納入範圍，確保基準線永遠在視圖內)
  let minVal = baselineRef;
  let maxVal = baselineRef;
  for (const pt of points) {
    if (pt.p < minVal) minVal = pt.p;
    if (pt.p > maxVal) maxVal = pt.p;
  }
  if (h !== null && h > maxVal) maxVal = h;
  if (l !== null && l < minVal) minVal = l;

  const span = maxVal - minVal;
  const margin = Math.max(span * 0.1, 0.05);
  const scaleMin = minVal - margin;
  const scaleMax = maxVal + margin;
  const scaleRange = scaleMax - scaleMin || 1;

  const getY = (val: number) => {
    const ratio = (val - scaleMin) / scaleRange;
    return padTop + (1 - ratio) * usableH;
  };

  const baseY = Math.max(padTop, Math.min(H - padBottom, getY(baselineRef)));

  // 將點位的時間進度 r (0~1) 映射到當前畫布 X 座標
  const coords: Array<[number, number]> = points.map((pt) => {
    const cx = padLeft + Math.min(1.0, Math.max(0, pt.r)) * usableW;
    const cy = getY(pt.p);
    return [Math.round(cx * 10) / 10, Math.round(cy * 10) / 10];
  });

  // 確保至少有兩個點能畫出線條
  if (coords.length === 1) {
    coords.push([coords[0][0] + 1, coords[0][1]]);
  }

  // 採用平滑貝茲曲線
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
  const firstX = coords[0][0];
  const lastX = coords[coords.length - 1][0];
  const lastY = coords[coords.length - 1][1];
  const areaD = `${lineD} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;

  const isUp = z !== null && y !== null ? z >= y : (z !== null && o !== null ? z >= o : true);
  const pointColor = isUp ? '#ef4444' : '#10b981';

  const fmt = (num: number) =>
    num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const chg = z !== null && y !== null ? z - y : null;
  const pct = chg !== null && y !== null && y > 0 ? (chg / y) * 100 : null;

  const tooltipLines: string[] = [];
  if (code || name) tooltipLines.push(`${code ? code + ' ' : ''}${name || ''} 今日即時分時走勢`);
  if (z !== null) {
    let priceLine = `現價: ${fmt(z)}`;
    if (chg !== null && pct !== null) {
      priceLine += ` (${chg >= 0 ? '+' : ''}${fmt(chg)}, ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    }
    tooltipLines.push(priceLine);
  }
  if (y !== null) tooltipLines.push(`昨收基準: ${fmt(y)}`);
  tooltipLines.push(`開: ${o !== null ? fmt(o) : '-'} | 高: ${h !== null ? fmt(h) : '-'} | 低: ${l !== null ? fmt(l) : '-'}`);
  if (isTrading) {
    tooltipLines.push(`盤中交易進度: ${minutesIn} 分 / 270 分 (隨行情向右延伸)`);
  } else {
    tooltipLines.push('市場已收盤 (全日走勢)');
  }
  if (onClick) tooltipLines.push('點擊查看放大版當日即時走勢圖');

  return (
    <div
      className={`stock-sparkline-wrap ${onClick ? 'clickable' : ''}`}
      title={tooltipLines.join('\n')}
      onClick={onClick}
    >
      <svg
        className="stock-sparkline-svg"
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        aria-hidden="true"
      >
        <defs>
          {/* 上半部：高於昨收的紅色漸層 */}
          <linearGradient id={`grad-up-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0.05" />
          </linearGradient>

          {/* 下半部：低於昨收的綠色漸層 */}
          <linearGradient id={`grad-down-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.05" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.4" />
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

        {/* 昨收基準水平線 (灰色虛線，貫穿全日 09:00 - 13:30) */}
        <line
          x1="1"
          y1={baseY}
          x2={W - 1}
          y2={baseY}
          stroke="var(--border-color, #64748b)"
          strokeDasharray="2,2"
          strokeWidth="0.8"
          opacity="0.85"
        />

        {/* 基準線上方部分：紅線 + 紅漸層填色 (僅延伸至當前進度 lastX) */}
        <g clipPath={`url(#clip-above-${uid})`}>
          <path d={areaD} fill={`url(#grad-up-${uid})`} />
          <path
            d={lineD}
            fill="none"
            stroke="#ef4444"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* 基準線下方部分：綠線 + 綠漸層填色 (僅延伸至當前進度 lastX) */}
        <g clipPath={`url(#clip-below-${uid})`}>
          <path d={areaD} fill={`url(#grad-down-${uid})`} />
          <path
            d={lineD}
            fill="none"
            stroke="#10b981"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* 最新價格點位小圓點 (座落於最新時間點與現價) */}
        {z !== null && coords.length > 0 && (
          <circle
            cx={lastX}
            cy={lastY}
            r="1.8"
            fill={pointColor}
            stroke="var(--bg-card, #1e293b)"
            strokeWidth="0.8"
          />
        )}
      </svg>
    </div>
  );
};
