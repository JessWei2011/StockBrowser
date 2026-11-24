import React, { useState, useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { StockChartData, KlineBar } from '../types';
import { fetchStockChart } from '../services/api';

interface PriceBadgeItem {
  key: string;
  tag: string;
  val: number;
  color: string;
  text: string;
  isBold?: boolean;
  rawY?: number;
}

const BUFFER_DAYS = 30; // 擴充未來留白緩衝槽位，讓最新當天 K 棒置於約 2/3 處或置中
const MIN_VISIBLE_BARS = 6; // 最小可放大檢視根數

/**
 * 依據欲呈現之真實 K 棒數量與未來留白緩衝槽位，計算錨定於最新 K 棒的 dataZoom 範圍
 * 讓當天最新 K 棒置於視窗約 2/3 處 (約 64%~66% 位置，右側保留約 34%~36% 視野空間，方便觀察近期走勢)
 */
function calcZoomFromVisibleBars(visibleBars: number, realTotal: number, bufferDays = BUFFER_DAYS) {
  const totalSlots = realTotal + bufferDays;
  const lastRealIndex = realTotal - 1;

  // 當可視根數 <= 60 根時，精準保持當日 K 棒在視窗 2/3 處 (約 65%)；極度放大時往中央微幅置中 (~58%)；縮小至全年時平滑回貼
  let targetRatio = 0.65;
  if (visibleBars <= 25) {
    targetRatio = 0.58 + (visibleBars / 25) * 0.07;
  } else if (visibleBars > 60) {
    const p = Math.min(1, (visibleBars - 60) / Math.max(1, realTotal - 60));
    targetRatio = 0.65 + p * 0.35;
  }

  const totalVisibleSlots = visibleBars / targetRatio;
  const rightBufferSlots = Math.min(bufferDays, Math.round(totalVisibleSlots * (1 - targetRatio)));
  const endIndex = Math.min(totalSlots - 1, lastRealIndex + rightBufferSlots);
  const startIndex = Math.max(0, Math.round(endIndex - totalVisibleSlots));
  const start = Math.max(0, (startIndex / (totalSlots - 1)) * 100);
  const end = Math.min(100, (endIndex / (totalSlots - 1)) * 100);
  return { start, end };
}

/**
 * 右側 Y 軸彩色防重疊數值膠囊標籤 (與個股 K 線風格一致)
 * 標示最新收盤/現價、MA 均線群 (5/10/20/60/120/240) 與 BOLL (上/下軌)
 */
function updateRightPriceBadges(
  chart: echarts.ECharts | null,
  dom: HTMLDivElement | null,
  kline: KlineBar[],
  currentPrice?: number | null,
  showMA = true,
  showBoll = false,
) {
  if (!chart || chart.isDisposed() || !dom || !kline || kline.length === 0) return;

  let container = dom.querySelector<HTMLDivElement>('.echart-right-price-badges');
  if (!container) {
    container = document.createElement('div');
    container.className = 'echart-right-price-badges';
    dom.appendChild(container);
  }

  const lastIdx = kline.length - 1;
  const lastK = kline[lastIdx];
  const prevK = lastIdx > 0 ? kline[lastIdx - 1] : lastK;

  const closePrice = currentPrice && currentPrice > 0 ? currentPrice : lastK.close;
  const prevClose = prevK.close || lastK.open;
  const isUp = closePrice >= prevClose;
  const priceColor = isUp ? '#ef4444' : '#22c55e';

  const formatPriceText = (v: number) => {
    if (v >= 1000) return v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return v.toFixed(2);
  };

  const items: PriceBadgeItem[] = [];

  // 1. 現價 (收盤價)
  items.push({
    key: 'close',
    tag: '現',
    val: closePrice,
    color: priceColor,
    text: formatPriceText(closePrice),
    isBold: true,
  });

  // 2. 均線系列
  if (showMA) {
    if (lastK.ma5 != null) {
      items.push({ key: 'ma5', tag: '5', val: lastK.ma5, color: '#38bdf8', text: formatPriceText(lastK.ma5) });
    }
    if (lastK.ma10 != null) {
      items.push({ key: 'ma10', tag: '10', val: lastK.ma10, color: '#eab308', text: formatPriceText(lastK.ma10) });
    }
    if (lastK.ma20 != null) {
      items.push({ key: 'ma20', tag: '20', val: lastK.ma20, color: '#f43f5e', text: formatPriceText(lastK.ma20) });
    }
    if (lastK.ma60 != null) {
      items.push({ key: 'ma60', tag: '60', val: lastK.ma60, color: '#a855f7', text: formatPriceText(lastK.ma60) });
    }
    if (lastK.ma120 != null) {
      items.push({ key: 'ma120', tag: '120', val: lastK.ma120, color: '#10b981', text: formatPriceText(lastK.ma120) });
    }
    if (lastK.ma240 != null) {
      items.push({ key: 'ma240', tag: '240', val: lastK.ma240, color: '#f97316', text: formatPriceText(lastK.ma240) });
    }
  }

  // 3. 布林通道
  if (showBoll) {
    if (lastK.boll_up != null) {
      items.push({ key: 'boll_up', tag: 'UB', val: lastK.boll_up, color: '#60a5fa', text: formatPriceText(lastK.boll_up) });
    }
    if (lastK.boll_down != null) {
      items.push({ key: 'boll_down', tag: 'LB', val: lastK.boll_down, color: '#60a5fa', text: formatPriceText(lastK.boll_down) });
    }
  }

  // 計算在主圖 Y 軸 (gridIndex 0) 的實際像素座標
  const validItems: PriceBadgeItem[] = [];
  items.forEach((it) => {
    try {
      const pixel = chart.convertToPixel({ yAxisIndex: 0 }, it.val);
      if (pixel != null && !isNaN(pixel)) {
        it.rawY = pixel;
        validItems.push(it);
      }
    } catch (_) {}
  });

  if (validItems.length === 0) {
    container.innerHTML = '';
    return;
  }

  // 主圖 Y 軸顯示邊界範圍 (top: 25px, height: 56%)
  const domHeight = dom.clientHeight || 450;
  const minY = 28;
  const maxY = Math.round(25 + domHeight * 0.56 - 10);

  // 依 Y 座標從小到大排列 (即價格由高到低)
  validItems.sort((a, b) => (a.rawY ?? 0) - (b.rawY ?? 0));

  // 防重疊演算法 (Two-pass Relaxation with boundary clamping)
  const minGap = 19;
  const count = validItems.length;
  const adjustedY = validItems.map((it) => it.rawY ?? 0);

  for (let i = 1; i < count; i++) {
    if (adjustedY[i] < adjustedY[i - 1] + minGap) {
      adjustedY[i] = adjustedY[i - 1] + minGap;
    }
  }

  if (adjustedY[count - 1] > maxY) {
    adjustedY[count - 1] = maxY;
    for (let i = count - 2; i >= 0; i--) {
      if (adjustedY[i] > adjustedY[i + 1] - minGap) {
        adjustedY[i] = adjustedY[i + 1] - minGap;
      }
    }
  }

  if (adjustedY[0] < minY) {
    adjustedY[0] = minY;
    for (let i = 1; i < count; i++) {
      if (adjustedY[i] < adjustedY[i - 1] + minGap) {
        adjustedY[i] = adjustedY[i - 1] + minGap;
      }
    }
  }

  let html = '';
  for (let i = 0; i < count; i++) {
    const it = validItems[i];
    const y = adjustedY[i];
    const topPx = Math.round(y - 9);
    const tagHtml = it.tag ? `<span class="badge-tag">${it.tag}</span>` : '';
    const fontWeight = it.isBold ? '800' : '700';

    html += `<div class="echart-price-badge-item" style="top:${topPx}px; background-color:${it.color}; font-weight:${fontWeight};">` +
      tagHtml +
      `<span class="badge-text">${it.text}</span>` +
      `</div>`;
  }

  container.innerHTML = html;
}

/**
 * 確保 KD(9, 3, 3) 數據齊全
 * 若後端已提供則優先採用；若無（例如大盤指數或後端舊快取），即時由開高低收進行標準平滑計算
 */
function getCalculatedKD(kline: KlineBar[]) {
  const count = kline.length;
  const kVals: (number | null)[] = new Array(count).fill(null);
  const dVals: (number | null)[] = new Array(count).fill(null);

  const validBackendK = kline.filter((b) => b.k != null && !isNaN(b.k));
  if (validBackendK.length > count * 0.7) {
    for (let i = 0; i < count; i++) {
      kVals[i] = kline[i].k ?? null;
      dVals[i] = kline[i].d ?? null;
    }
    return { kVals, dVals };
  }

  let k = 50.0;
  let d = 50.0;
  for (let i = 0; i < count; i++) {
    const start = Math.max(0, i - 8);
    let subHigh = kline[start].high;
    let subLow = kline[start].low;
    for (let j = start + 1; j <= i; j++) {
      if (kline[j].high > subHigh) subHigh = kline[j].high;
      if (kline[j].low < subLow) subLow = kline[j].low;
    }
    const close = kline[i].close;
    let rsv = 50.0;
    if (subHigh > subLow) {
      rsv = ((close - subLow) / (subHigh - subLow)) * 100.0;
      rsv = Math.max(0, Math.min(100, rsv));
    }
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;

    if (i >= 8) {
      kVals[i] = Math.round(k * 10) / 10;
      dVals[i] = Math.round(d * 10) / 10;
    }
  }

  return { kVals, dVals };
}

/**
 * 確保 RSI(6) 與 RSI(12) 數據齊全
 */
function getCalculatedRSI(kline: KlineBar[]) {
  const count = kline.length;
  const rsi6Vals: (number | null)[] = new Array(count).fill(null);
  const rsi12Vals: (number | null)[] = new Array(count).fill(null);

  const validBackendRsi = kline.filter((b) => b.rsi6 != null && !isNaN(b.rsi6));
  if (validBackendRsi.length > count * 0.7) {
    for (let i = 0; i < count; i++) {
      rsi6Vals[i] = kline[i].rsi6 ?? null;
      rsi12Vals[i] = kline[i].rsi12 ?? null;
    }
    return { rsi6Vals, rsi12Vals };
  }

  if (count >= 2) {
    const calcWilder = (period: number) => {
      const res: (number | null)[] = new Array(count).fill(null);
      if (count < period + 1) return res;

      let sumGain = 0;
      let sumLoss = 0;
      for (let i = 1; i <= period; i++) {
        const diff = kline[i].close - kline[i - 1].close;
        if (diff > 0) sumGain += diff;
        else sumLoss -= diff;
      }
      let avgGain = sumGain / period;
      let avgLoss = sumLoss / period;
      res[period] = avgLoss === 0 ? 100 : Math.round((100 - (100 / (1 + avgGain / avgLoss))) * 10) / 10;

      for (let i = period + 1; i < count; i++) {
        const diff = kline[i].close - kline[i - 1].close;
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        res[i] = avgLoss === 0 ? 100 : Math.round((100 - (100 / (1 + avgGain / avgLoss))) * 10) / 10;
      }
      return res;
    };

    const r6 = calcWilder(6);
    const r12 = calcWilder(12);
    for (let i = 0; i < count; i++) {
      rsi6Vals[i] = r6[i];
      rsi12Vals[i] = r12[i];
    }
  }

  return { rsi6Vals, rsi12Vals };
}

/** 計算標準 MACD(12, 26, 9) 指標 (快線 DIF, 慢線 DEM, 柱狀 OSC) */
function getCalculatedMACD(kline: KlineBar[]) {
  const n = kline.length;
  const difVals: (number | null)[] = new Array(n).fill(null);
  const demVals: (number | null)[] = new Array(n).fill(null);
  const oscVals: (number | null)[] = new Array(n).fill(null);

  const hasBackend = kline.filter((k) => k.macd_dif != null).length > n * 0.7;
  if (hasBackend) {
    kline.forEach((k, i) => {
      difVals[i] = k.macd_dif ?? null;
      demVals[i] = k.macd_dem ?? null;
      oscVals[i] = k.macd_hist ?? null;
    });
    return { difVals, demVals, oscVals };
  }

  if (n < 2) return { difVals, demVals, oscVals };
  let ema12 = kline[0].close;
  let ema26 = kline[0].close;
  const a12 = 2.0 / 13.0;
  const a26 = 2.0 / 27.0;
  const a9 = 2.0 / 10.0;
  const tempDif: number[] = [];

  for (let i = 0; i < n; i++) {
    const c = kline[i].close;
    ema12 = c * a12 + ema12 * (1.0 - a12);
    ema26 = c * a26 + ema26 * (1.0 - a26);
    tempDif.push(ema12 - ema26);
  }

  let dem = tempDif[0];
  for (let i = 0; i < n; i++) {
    const d = tempDif[i];
    dem = d * a9 + dem * (1.0 - a9);
    difVals[i] = Math.round(d * 100) / 100;
    demVals[i] = Math.round(dem * 100) / 100;
    oscVals[i] = Math.round((d - dem) * 100) / 100;
  }
  return { difVals, demVals, oscVals };
}

/** 計算標準 DMI(14) 趨向指標 (+DI, -DI, ADX) */
function getCalculatedDMI(kline: KlineBar[], period = 14) {
  const n = kline.length;
  const pdiVals: (number | null)[] = new Array(n).fill(null);
  const ndiVals: (number | null)[] = new Array(n).fill(null);
  const adxVals: (number | null)[] = new Array(n).fill(null);

  const hasBackend = kline.filter((k) => k.dmi_pdi != null).length > n * 0.7;
  if (hasBackend) {
    kline.forEach((k, i) => {
      pdiVals[i] = k.dmi_pdi ?? null;
      ndiVals[i] = k.dmi_ndi ?? null;
      adxVals[i] = k.dmi_adx ?? null;
    });
    return { pdiVals, ndiVals, adxVals };
  }

  if (n < period + 1) return { pdiVals, ndiVals, adxVals };
  const trList = [0];
  const pdmList = [0];
  const ndmList = [0];

  for (let i = 1; i < n; i++) {
    const h = kline[i].high;
    const l = kline[i].low;
    const prevH = kline[i - 1].high;
    const prevL = kline[i - 1].low;
    const prevC = kline[i - 1].close;

    const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
    const up = h - prevH;
    const down = prevL - l;

    trList.push(tr);
    pdmList.push(up > down && up > 0 ? up : 0);
    ndmList.push(down > up && down > 0 ? down : 0);
  }

  let tr14 = trList.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let pdm14 = pdmList.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let ndm14 = ndmList.slice(1, period + 1).reduce((a, b) => a + b, 0);

  const dx: (number | null)[] = new Array(n).fill(null);

  pdiVals[period] = tr14 > 0 ? Math.round((pdm14 / tr14) * 10000) / 100 : 0;
  ndiVals[period] = tr14 > 0 ? Math.round((ndm14 / tr14) * 10000) / 100 : 0;
  const s0 = (pdiVals[period] || 0) + (ndiVals[period] || 0);
  dx[period] = s0 > 0 ? Math.round((Math.abs((pdiVals[period] || 0) - (ndiVals[period] || 0)) / s0) * 10000) / 100 : 0;

  for (let i = period + 1; i < n; i++) {
    tr14 = tr14 - tr14 / period + trList[i];
    pdm14 = pdm14 - pdm14 / period + pdmList[i];
    ndm14 = ndm14 - ndm14 / period + ndmList[i];

    const p = tr14 > 0 ? Math.round((pdm14 / tr14) * 10000) / 100 : 0;
    const nd = tr14 > 0 ? Math.round((ndm14 / tr14) * 10000) / 100 : 0;
    pdiVals[i] = p;
    ndiVals[i] = nd;
    const s = p + nd;
    dx[i] = s > 0 ? Math.round((Math.abs(p - nd) / s) * 10000) / 100 : 0;
  }

  const firstAdxIdx = period * 2 - 1;
  if (n > firstAdxIdx) {
    const validDx = dx.slice(period, firstAdxIdx + 1).filter((x): x is number => x != null);
    if (validDx.length === period) {
      let currAdx = validDx.reduce((a, b) => a + b, 0) / period;
      adxVals[firstAdxIdx] = Math.round(currAdx * 100) / 100;
      for (let i = firstAdxIdx + 1; i < n; i++) {
        currAdx = (currAdx * (period - 1) + (dx[i] ?? 0)) / period;
        adxVals[i] = Math.round(currAdx * 100) / 100;
      }
    }
  }

  return { pdiVals, ndiVals, adxVals };
}

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
  theme?: 'light' | 'dark';
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
  theme,
}) => {
  const [data, setData] = useState<StockChartData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 指標開關
  const [showMA, setShowMA] = useState(true);
  const [showBoll, setShowBoll] = useState(false);
  const [activeRange, setActiveRange] = useState<'1Y' | '2Y' | '6M' | '3M'>('3M');
  const [subIndicator, setSubIndicator] = useState<'vol' | 'kd' | 'macd' | 'rsi' | 'dmi'>('vol');

  const mainChartRef = useRef<HTMLDivElement | null>(null);
  const mainInstanceRef = useRef<echarts.ECharts | null>(null);
  const zoomRangeRef = useRef<{ start: number; end: number } | null>(null);

  // 載入技術分析 K 線數據（開盤交易時段每 15 秒自動刷新）
  useEffect(() => {
    if (!isOpen || !code) {
      setData(null);
      setError(null);
      zoomRangeRef.current = null;
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

  // 快捷切換顯示區間 (3M=季線60日置於2/3處, 6M=半年120日, 1Y=年線視野240日, 2Y=全部歷史)
  const applyRangeZoom = (range: '1Y' | '2Y' | '6M' | '3M', totalBars: number) => {
    setActiveRange(range);
    const chart = mainInstanceRef.current;
    if (!chart || totalBars <= 0) return;

    if (range === '2Y') {
      chart.dispatchAction({
        type: 'dataZoom',
        start: 0,
        end: 100,
      });
      zoomRangeRef.current = { start: 0, end: 100 };
      return;
    }

    let targetBars = 60;
    if (range === '1Y') targetBars = Math.min(240, totalBars);
    else if (range === '6M') targetBars = Math.min(120, totalBars);
    else if (range === '3M') targetBars = Math.min(60, totalBars);

    const { start, end } = calcZoomFromVisibleBars(targetBars, totalBars, BUFFER_DAYS);
    chart.dispatchAction({
      type: 'dataZoom',
      start,
      end,
    });
    zoomRangeRef.current = { start, end };
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

    const isDark = (theme ?? document.documentElement.getAttribute('data-theme')) === 'dark';
    const upColor = '#ef4444'; // 台股標準紅漲
    const downColor = '#22c55e'; // 台股標準綠跌
    const textColor = isDark ? '#94a3b8' : '#475569';
    // 日期軸基礎線、邊界與縱橫格線全面採用淺灰色/半透明柔和色，避免深黑暗色線條覆蓋遮蔽 K 棒上下影線
    const gridBorder = isDark ? 'rgba(148, 163, 184, 0.28)' : '#cbd5e1';
    const dateBaseLine = isDark ? 'rgba(148, 163, 184, 0.35)' : '#cbd5e1'; // 日期基礎軸線 (淺灰色)
    const gridSplitLine = isDark ? 'rgba(148, 163, 184, 0.15)' : '#e2e8f0'; // 日期縱向格線 (柔和淺灰色)

    const kline: KlineBar[] = data.kline || [];
    const totalBars = kline.length;
    // 擴充 X 軸日期並增加 BUFFER_DAYS 根留白緩衝槽位，讓最新當天 K 棒置於 2/3 處或置中
    const expandedDates = kline.map((k: KlineBar) => k.date).concat(new Array(BUFFER_DAYS).fill(''));
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

    // 檢查是否有歷史成交量/額資料
    const hasVolumeData = kline.some((k: KlineBar) => (k.volume ?? 0) > 0);
    // 是否顯示副圖 (成交量/額、KD、MACD、RSI 或 DMI)
    const hasSubChart = (subIndicator === 'vol' && hasVolumeData) || ['kd', 'macd', 'rsi', 'dmi'].includes(subIndicator);
    // 是否為台股市場（加權或櫃買），單位為億元；其他市場若有量則以量為單位
    const isTwMarket = code === 'IX0001' || code === 'IX0043' || code === 'TSE' || code === 'OTC' || code === '^TWII' || code === 'MKT01' || code === 'MKT02';
    const volumeUnitLabel = isTwMarket ? '億元' : '量';

    const volumes = kline.map((k: KlineBar) => {
      const vol = k.volume ?? 0;
      const isUp = k.close >= k.open;
      return {
        value: vol,
        itemStyle: {
          color: isUp ? upColor : downColor,
        },
      };
    });

    // 初始預設視野：錨定當天最新 K 棒於視窗 2/3 處 (預設呈現近 60 根季線視野，類似個股技術圖)
    const initBars = Math.min(60, totalBars);
    const calculatedInit = calcZoomFromVisibleBars(initBars, totalBars, BUFFER_DAYS);
    const initStart = zoomRangeRef.current?.start ?? calculatedInit.start;
    const initEnd = zoomRangeRef.current?.end ?? calculatedInit.end;

    // 系列數據
    const seriesList: any[] = [
      {
        name: '日K線',
        type: 'candlestick',
        data: candles,
        xAxisIndex: 0,
        yAxisIndex: 0,
        z: 3, // 確保 K 棒實體與上下影線圖層置於背景格線與軸線之上，清晰無任何遮蔽
        barMaxWidth: 42,
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
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.2, color: '#38bdf8' },
        },
        {
          name: '10MA',
          type: 'line',
          data: ma10,
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.2, color: '#eab308' },
        },
        {
          name: '20MA',
          type: 'line',
          data: ma20,
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#f43f5e' },
        },
        {
          name: '60MA',
          type: 'line',
          data: ma60,
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#a855f7' },
        },
        {
          name: '120MA (半年線)',
          type: 'line',
          data: ma120,
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.5, color: '#10b981' },
        },
        {
          name: '240MA (年線)',
          type: 'line',
          data: ma240,
          xAxisIndex: 0,
          yAxisIndex: 0,
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
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, type: 'dashed', color: '#60a5fa' },
        },
        {
          name: 'BOLL中軌',
          type: 'line',
          data: bollMid,
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, color: '#93c5fd' },
        },
        {
          name: 'BOLL下軌',
          type: 'line',
          data: bollDown,
          xAxisIndex: 0,
          yAxisIndex: 0,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, type: 'dashed', color: '#60a5fa' },
        }
      );
    }

    // 取得/計算副圖 KD、RSI、MACD 與 DMI 指標數值 (確保大盤指數與任何缺漏 K 棒均有完整數值)
    const { kVals, dVals } = getCalculatedKD(kline);
    const { rsi6Vals, rsi12Vals } = getCalculatedRSI(kline);
    const { difVals, demVals, oscVals } = getCalculatedMACD(kline);
    const { pdiVals, ndiVals, adxVals } = getCalculatedDMI(kline);

    // 副圖系列
    if (subIndicator === 'vol' && hasVolumeData) {
      seriesList.push({
        name: isTwMarket ? '成交額' : '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumes,
        barMaxWidth: 35,
      });
    } else if (subIndicator === 'kd') {
      const kOver80 = kVals.map((v) => (v != null ? (v > 80 ? v : 80) : null));
      const kUnder20 = kVals.map((v) => (v != null ? (v < 20 ? v : 20) : null));

      seriesList.push(
        // 超買區 (>80) 塗紅填充
        {
          name: 'KD-Over80',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: kOver80,
          smooth: true,
          showSymbol: false,
          lineStyle: { opacity: 0 },
          areaStyle: {
            origin: 80,
            color: 'rgba(239, 68, 68, 0.4)',
          },
          silent: true,
          tooltip: { show: false },
          z: 1,
        },
        // 超賣區 (<20) 塗綠填充
        {
          name: 'KD-Under20',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: kUnder20,
          smooth: true,
          showSymbol: false,
          lineStyle: { opacity: 0 },
          areaStyle: {
            origin: 20,
            color: 'rgba(16, 185, 129, 0.4)',
          },
          silent: true,
          tooltip: { show: false },
          z: 1,
        },
        {
          name: 'K(9)',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: kVals,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#0ea5e9', width: 1.8 },
          markLine: {
            symbol: 'none',
            silent: true,
            data: [
              { yAxis: 80, lineStyle: { color: '#ef4444', type: 'dashed', width: 0.8 }, label: { formatter: '超買 80', position: 'insideStartTop', fontSize: 9, color: '#ef4444' } },
              { yAxis: 20, lineStyle: { color: '#10b981', type: 'dashed', width: 0.8 }, label: { formatter: '超賣 20', position: 'insideStartBottom', fontSize: 9, color: '#10b981' } },
            ],
          },
          z: 2,
        },
        {
          name: 'D(9)',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: dVals,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#f97316', width: 1.8 },
          z: 2,
        }
      );
    } else if (subIndicator === 'macd') {
      seriesList.push(
        {
          name: 'OSC (柱狀)',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: oscVals.map((v) => (v != null ? {
            value: v,
            itemStyle: { color: v >= 0 ? '#ef4444' : '#10b981' },
          } : null)),
          barMaxWidth: 6,
          markLine: {
            symbol: 'none',
            silent: true,
            data: [
              { yAxis: 0, lineStyle: { color: isDark ? '#475569' : '#cbd5e1', type: 'dashed', width: 0.8 }, label: { formatter: '0軸', position: 'insideStartTop', fontSize: 9, color: textColor } },
            ],
          },
        },
        {
          name: 'DIF (快線)',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: difVals,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#2962FF', width: 1.8 },
        },
        {
          name: 'MACD (慢線)',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: demVals,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#FF6D00', width: 1.8 },
        }
      );
    } else if (subIndicator === 'rsi') {
      const rsi6Over80 = rsi6Vals.map((v) => (v != null ? (v > 80 ? v : 80) : null));
      const rsi6Under20 = rsi6Vals.map((v) => (v != null ? (v < 20 ? v : 20) : null));

      seriesList.push(
        // 超買區 (>80) 塗紅填充
        {
          name: 'RSI-Over80',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: rsi6Over80,
          smooth: true,
          showSymbol: false,
          lineStyle: { opacity: 0 },
          areaStyle: {
            origin: 80,
            color: 'rgba(239, 68, 68, 0.4)',
          },
          silent: true,
          tooltip: { show: false },
          z: 1,
        },
        // 超賣區 (<20) 塗綠填充
        {
          name: 'RSI-Under20',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: rsi6Under20,
          smooth: true,
          showSymbol: false,
          lineStyle: { opacity: 0 },
          areaStyle: {
            origin: 20,
            color: 'rgba(16, 185, 129, 0.4)',
          },
          silent: true,
          tooltip: { show: false },
          z: 1,
        },
        {
          name: 'RSI(6)',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: rsi6Vals,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#0ea5e9', width: 1.8 },
          markLine: {
            symbol: 'none',
            silent: true,
            data: [
              { yAxis: 80, lineStyle: { color: '#ef4444', type: 'dashed', width: 0.8 }, label: { formatter: '超買 80', position: 'insideStartTop', fontSize: 9, color: '#ef4444' } },
              { yAxis: 50, lineStyle: { color: '#64748b', type: 'dotted', width: 0.8 }, label: { formatter: '50', position: 'insideStartTop', fontSize: 9, color: '#64748b' } },
              { yAxis: 20, lineStyle: { color: '#10b981', type: 'dashed', width: 0.8 }, label: { formatter: '超賣 20', position: 'insideStartBottom', fontSize: 9, color: '#10b981' } },
            ],
          },
          z: 2,
        },
        {
          name: 'RSI(12)',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: rsi12Vals,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#f97316', width: 1.8 },
          z: 2,
        }
      );
    } else if (subIndicator === 'dmi') {
      seriesList.push(
        {
          name: '+DI (多方)',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: pdiVals,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#2962FF', width: 1.8 },
          markLine: {
            symbol: 'none',
            silent: true,
            data: [
              { yAxis: 20, lineStyle: { color: isDark ? '#475569' : '#cbd5e1', type: 'dashed', width: 0.8 }, label: { formatter: '20', position: 'insideStartTop', fontSize: 9, color: textColor } },
              { yAxis: 40, lineStyle: { color: isDark ? '#475569' : '#cbd5e1', type: 'dashed', width: 0.8 }, label: { formatter: '40', position: 'insideStartTop', fontSize: 9, color: textColor } },
            ],
          },
        },
        {
          name: '-DI (空方)',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: ndiVals,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#FF6D00', width: 1.8 },
        },
        {
          name: 'ADX (趨勢強度)',
          type: 'line',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: adxVals,
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#E040FB', width: 1.8 },
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
          if (idx >= totalBars) return '';
          const k = kline[idx];
          if (!k) return '';

          const chg = k.close - k.open;
          const chgPct = k.open > 0 ? (chg / k.open) * 100 : 0;
          const isUp = k.close >= k.open;
          const colorHex = isUp ? upColor : downColor;

          let html = `<div style="font-weight:700;margin-bottom:4px;">${k.date} ｜ ${data.name || code}</div>`;
          html += `<div style="color:${colorHex};font-weight:700;font-size:13px;margin-bottom:2px;">收盤: ${k.close.toLocaleString()} (${isUp ? '+' : ''}${chg.toFixed(2)}, ${chgPct.toFixed(2)}%)</div>`;
          html += `<div>開盤: ${k.open.toLocaleString()} ｜ 最高: ${k.high.toLocaleString()} ｜ 最低: ${k.low.toLocaleString()}</div>`;
          if (subIndicator === 'vol' && hasVolumeData && (k.volume ?? 0) > 0) {
            html += `<div style="color:${textColor};font-weight:600;margin-top:2px;">${isTwMarket ? '成交額' : '成交量'}: ${k.volume?.toLocaleString()} ${volumeUnitLabel}</div>`;
          } else if (subIndicator === 'kd') {
            const kVal = kVals[idx] ?? k.k;
            const dVal = dVals[idx] ?? k.d;
            const kStr = kVal != null ? kVal.toFixed(1) : '-';
            const dStr = dVal != null ? dVal.toFixed(1) : '-';
            html += `<div style="margin-top:3px;font-weight:600;"><span style="color:#0ea5e9;">◆ K(9): ${kStr}</span> ｜ <span style="color:#f97316;">◆ D(9): ${dStr}</span></div>`;
          } else if (subIndicator === 'macd') {
            const dif = difVals[idx];
            const dem = demVals[idx];
            const osc = oscVals[idx];
            const difStr = dif != null ? dif.toFixed(2) : '-';
            const demStr = dem != null ? dem.toFixed(2) : '-';
            const oscStr = osc != null ? (osc >= 0 ? `+${osc.toFixed(2)}` : osc.toFixed(2)) : '-';
            const oscColor = (osc ?? 0) >= 0 ? '#ef4444' : '#10b981';
            html += `<div style="margin-top:3px;font-weight:600;"><span style="color:#2962FF;">◆ DIF (快線): ${difStr}</span> ｜ <span style="color:#FF6D00;">◆ MACD (慢線): ${demStr}</span> ｜ <span style="color:${oscColor};">◆ OSC (柱狀): ${oscStr}</span></div>`;
          } else if (subIndicator === 'rsi') {
            const r6Val = rsi6Vals[idx] ?? k.rsi6;
            const r12Val = rsi12Vals[idx] ?? k.rsi12;
            const r6Str = r6Val != null ? r6Val.toFixed(1) : '-';
            const r12Str = r12Val != null ? r12Val.toFixed(1) : '-';
            html += `<div style="margin-top:3px;font-weight:600;"><span style="color:#0ea5e9;">◆ RSI(6): ${r6Str}</span> ｜ <span style="color:#f97316;">◆ RSI(12): ${r12Str}</span></div>`;
          } else if (subIndicator === 'dmi') {
            const pdi = pdiVals[idx];
            const ndi = ndiVals[idx];
            const adx = adxVals[idx];
            const pdiStr = pdi != null ? pdi.toFixed(2) : '-';
            const ndiStr = ndi != null ? ndi.toFixed(2) : '-';
            const adxStr = adx != null ? adx.toFixed(2) : '-';
            html += `<div style="margin-top:3px;font-weight:600;"><span style="color:#2962FF;">◆ +DI: ${pdiStr}</span> ｜ <span style="color:#FF6D00;">◆ -DI: ${ndiStr}</span> ｜ <span style="color:#E040FB;">◆ ADX: ${adxStr}</span></div>`;
          }
          return html;
        },
      },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
      },
      grid: hasSubChart
        ? [
            { left: '45px', right: '78px', top: '25px', height: '56%' }, // 主圖 (K線，右側留 78px 供膠囊對齊)
            { left: '45px', right: '78px', top: '69%', height: '20%' }, // 副圖 (成交量/額、KD 或 RSI)
          ]
        : [
            { left: '45px', right: '78px', top: '25px', bottom: '50px' },
          ],
      xAxis: hasSubChart
        ? [
            {
              type: 'category',
              data: expandedDates,
              gridIndex: 0,
              boundaryGap: false,
              axisLine: { lineStyle: { color: dateBaseLine } },
              axisLabel: { show: false },
              splitLine: { show: true, lineStyle: { color: gridSplitLine } },
            },
            {
              type: 'category',
              data: expandedDates,
              gridIndex: 1,
              boundaryGap: false,
              axisLine: { lineStyle: { color: dateBaseLine } },
              axisLabel: {
                color: textColor,
                fontSize: 11,
                formatter: (val: string) => {
                  if (!val) return '';
                  if (val.length === 10 && val.includes('-')) {
                    return val.substring(2).replace(/-/g, '/');
                  }
                  return val;
                },
              },
              splitLine: { show: true, lineStyle: { color: gridSplitLine } },
            },
          ]
        : [
            {
              type: 'category',
              data: expandedDates,
              boundaryGap: false,
              axisLine: { lineStyle: { color: dateBaseLine } },
              axisLabel: {
                color: textColor,
                fontSize: 11,
                formatter: (val: string) => {
                  if (!val) return '';
                  if (val.length === 10 && val.includes('-')) {
                    return val.substring(2).replace(/-/g, '/');
                  }
                  return val;
                },
              },
              splitLine: { show: true, lineStyle: { color: gridSplitLine } },
            },
          ],
      yAxis: hasSubChart
        ? [
            {
              type: 'value',
              scale: true,
              gridIndex: 0,
              position: 'right',
              axisLine: { show: true, lineStyle: { color: gridBorder } },
              splitLine: { lineStyle: { color: gridSplitLine } },
              axisLabel: {
                color: textColor,
                fontSize: 11,
                formatter: (v: number) => v.toLocaleString(),
              },
            },
            subIndicator === 'vol'
              ? {
                  type: 'value',
                  scale: true,
                  gridIndex: 1,
                  position: 'right',
                  splitNumber: 2,
                  axisLine: { show: true, lineStyle: { color: gridBorder } },
                  splitLine: { show: false },
                  axisLabel: {
                    color: textColor,
                    fontSize: 10,
                    formatter: (v: number) => (isTwMarket ? `${Math.round(v)}億` : `${v}`),
                  },
                }
              : subIndicator === 'macd'
              ? {
                  type: 'value',
                  scale: true,
                  gridIndex: 1,
                  position: 'right',
                  splitNumber: 3,
                  axisLine: { show: true, lineStyle: { color: gridBorder } },
                  splitLine: { lineStyle: { color: gridSplitLine } },
                  axisLabel: {
                    color: textColor,
                    fontSize: 10,
                  },
                }
              : {
                  type: 'value',
                  min: 0,
                  max: 100,
                  gridIndex: 1,
                  position: 'right',
                  splitNumber: 2,
                  axisLine: { show: true, lineStyle: { color: gridBorder } },
                  splitLine: { lineStyle: { color: gridSplitLine } },
                  axisLabel: {
                    color: textColor,
                    fontSize: 10,
                  },
                },
          ]
        : [
            {
              type: 'value',
              scale: true,
              position: 'right',
              axisLine: { show: true, lineStyle: { color: gridBorder } },
              splitLine: { lineStyle: { color: gridSplitLine } },
              axisLabel: {
                color: textColor,
                fontSize: 11,
                formatter: (v: number) => v.toLocaleString(),
              },
            },
          ],
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: hasSubChart ? [0, 1] : [0],
          start: initStart,
          end: initEnd,
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
          minSpan: (MIN_VISIBLE_BARS / (totalBars + BUFFER_DAYS)) * 100,
          maxSpan: 100,
        },
        {
          type: 'slider',
          xAxisIndex: hasSubChart ? [0, 1] : [0],
          start: initStart,
          end: initEnd,
          minSpan: (MIN_VISIBLE_BARS / (totalBars + BUFFER_DAYS)) * 100,
          maxSpan: 100,
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

    const dom = mainChartRef.current;
    let badgeRafId: number | null = null;
    const scheduleRefreshBadges = () => {
      if (badgeRafId !== null) return;
      badgeRafId = requestAnimationFrame(() => {
        badgeRafId = null;
        if (mainInstanceRef.current && !mainInstanceRef.current.isDisposed()) {
          updateRightPriceBadges(mainInstanceRef.current, dom, kline, propPrice, showMA, showBoll);
        }
      });
    };
    scheduleRefreshBadges();
    const badgeTimer = setTimeout(scheduleRefreshBadges, 80);

    // 監聽使用者的縮放/平移操作，將當前視角記錄在 ref 中並節流更新右側膠囊位置
    const handleDataZoom = (e: any) => {
      let start: number | undefined;
      let end: number | undefined;
      if (e.batch && e.batch.length > 0) {
        start = e.batch[0].start;
        end = e.batch[0].end;
      } else if (e.start !== undefined && e.end !== undefined) {
        start = e.start;
        end = e.end;
      }
      if (start !== undefined && end !== undefined) {
        zoomRangeRef.current = { start, end };
      }
      scheduleRefreshBadges();
    };
    chart.on('datazoom', handleDataZoom);

    const handleResize = () => {
      chart.resize();
      scheduleRefreshBadges();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      clearTimeout(badgeTimer);
      if (badgeRafId !== null) {
        cancelAnimationFrame(badgeRafId);
      }
      window.removeEventListener('resize', handleResize);
      chart.off('datazoom', handleDataZoom);
      if (chart && !chart.isDisposed()) {
        chart.dispose();
      }
    };
  }, [data, isOpen, showMA, showBoll, subIndicator, theme]);

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
                  <span
                    className="chart-live-badge-dot"
                    title="即時連動中 (已將今日開盤即時行情動態拼接至 K 線末端)"
                    aria-label="即時連動中"
                  />
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
                className={`range-pill-btn ${activeRange === '3M' ? 'active' : ''}`}
                onClick={() => applyRangeZoom('3M', totalBars)}
                title="季線視野 (近 60 交易日，當日 K 棒置於 2/3 處)"
              >
                季線 (60日)
              </button>
              <button
                type="button"
                className={`range-pill-btn ${activeRange === '6M' ? 'active' : ''}`}
                onClick={() => applyRangeZoom('6M', totalBars)}
                title="半年線視野 (120 交易日)"
              >
                半年 (120日)
              </button>
              <button
                type="button"
                className={`range-pill-btn ${activeRange === '1Y' ? 'active' : ''}`}
                onClick={() => applyRangeZoom('1Y', totalBars)}
                title="年線視野 (240 交易日)"
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

            {/* 副圖指標切換 (成交額/量、KD、MACD、RSI、DMI) */}
            <div className="chart-toggle-group">
              <button
                type="button"
                className={`chart-indicator-toggle ${subIndicator === 'vol' ? 'active' : ''}`}
                onClick={() => setSubIndicator('vol')}
                title="副圖顯示 成交額/量"
              >
                {code === 'IX0001' || code === 'IX0043' || code === 'TSE' || code === 'OTC' ? '成交額' : '成交量'}
              </button>
              <button
                type="button"
                className={`chart-indicator-toggle ${subIndicator === 'kd' ? 'active' : ''}`}
                onClick={() => setSubIndicator('kd')}
                title="副圖顯示 KD 隨機指標（含 >80 超買塗紅、<20 超賣塗綠）"
              >
                KD 指標
              </button>
              <button
                type="button"
                className={`chart-indicator-toggle ${subIndicator === 'macd' ? 'active' : ''}`}
                onClick={() => setSubIndicator('macd')}
                title="副圖顯示 MACD(12, 26, 9) 指標 (DIF 藍、MACD 橘、OSC 柱狀)"
              >
                MACD 指標
              </button>
              <button
                type="button"
                className={`chart-indicator-toggle ${subIndicator === 'rsi' ? 'active' : ''}`}
                onClick={() => setSubIndicator('rsi')}
                title="副圖顯示 RSI(6) 與 RSI(12) 相對強弱指標（含 >80 超買塗紅、<20 超賣塗綠）"
              >
                RSI 指標
              </button>
              <button
                type="button"
                className={`chart-indicator-toggle ${subIndicator === 'dmi' ? 'active' : ''}`}
                onClick={() => setSubIndicator('dmi')}
                title="副圖顯示 DMI(14) 趨向指標 (+DI 藍、-DI 橘、ADX 紫)"
              >
                DMI 趨向
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
          {subIndicator === 'kd' && (
            <span className="legend-item legend-sub-kd" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: '10px', borderLeft: '1px solid rgba(148, 163, 184, 0.3)', paddingLeft: '10px' }}>
              <span style={{ color: '#0ea5e9', fontWeight: 700 }}>◆ K(9)</span>
              <span style={{ color: '#f97316', fontWeight: 700, marginLeft: '6px' }}>◆ D(9)</span>
              <span style={{ color: '#ef4444', fontSize: '11px', marginLeft: '6px' }}>■ &gt;80超買</span>
              <span style={{ color: '#10b981', fontSize: '11px', marginLeft: '3px' }}>■ &lt;20超賣</span>
            </span>
          )}
          {subIndicator === 'macd' && (
            <span className="legend-item legend-sub-macd" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: '10px', borderLeft: '1px solid rgba(148, 163, 184, 0.3)', paddingLeft: '10px' }}>
              <span style={{ color: '#2962FF', fontWeight: 700 }}>◆ DIF (快線)</span>
              <span style={{ color: '#FF6D00', fontWeight: 700, marginLeft: '6px' }}>◆ MACD (慢線)</span>
              <span style={{ color: '#ef4444', fontSize: '11px', marginLeft: '6px' }}>■ OSC柱狀</span>
            </span>
          )}
          {subIndicator === 'rsi' && (
            <span className="legend-item legend-sub-rsi" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: '10px', borderLeft: '1px solid rgba(148, 163, 184, 0.3)', paddingLeft: '10px' }}>
              <span style={{ color: '#0ea5e9', fontWeight: 700 }}>◆ RSI(6)</span>
              <span style={{ color: '#f97316', fontWeight: 700, marginLeft: '6px' }}>◆ RSI(12)</span>
              <span style={{ color: '#ef4444', fontSize: '11px', marginLeft: '6px' }}>■ &gt;80超買</span>
              <span style={{ color: '#10b981', fontSize: '11px', marginLeft: '3px' }}>■ &lt;20超賣</span>
            </span>
          )}
          {subIndicator === 'dmi' && (
            <span className="legend-item legend-sub-dmi" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: '10px', borderLeft: '1px solid rgba(148, 163, 184, 0.3)', paddingLeft: '10px' }}>
              <span style={{ color: '#2962FF', fontWeight: 700 }}>◆ +DI (多方)</span>
              <span style={{ color: '#FF6D00', fontWeight: 700, marginLeft: '6px' }}>◆ -DI (空方)</span>
              <span style={{ color: '#E040FB', fontWeight: 700, marginLeft: '6px' }}>◆ ADX (強度)</span>
            </span>
          )}
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
            style={{ width: '100%', height: '100%', minHeight: '440px', position: 'relative' }}
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
