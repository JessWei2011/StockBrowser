import React, { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import type { StockChartData, KlineBar } from '../types';
import { fetchStockChart } from '../services/api';

interface StockChartDrawerProps {
  code: string | null;
  isOpen: boolean;
  onClose: () => void;
  theme: 'dark' | 'light';
  currentPrice?: number | null;
  changePercent?: number | null;
}

type TabKey = 'chips' | 'margin' | 'holders';

const BUFFER_DAYS = 20;
const MIN_VISIBLE_BARS = 4; // 允許放大至僅 4 根 K 棒，細看型態與巨大 K 棒細節

/**
 * 依據欲呈現之真實 K 棒數量與未來留白緩衝槽位，計算錨定於最新 K 棒的 dataZoom 範圍
 * 放大時最新 K 棒漸進置中至約 62%~65%（右側留約 35%~38% 視野空間）；縮小時慢慢往右回復至 100%
 */
function calcZoomFromVisibleBars(visibleBars: number, realTotal: number, bufferDays = BUFFER_DAYS) {
  const totalSlots = realTotal + bufferDays;
  const lastRealIndex = realTotal - 1;
  const minBars = MIN_VISIBLE_BARS;
  const maxBars = realTotal;
  const zoomProgress = Math.max(0, Math.min(1, (maxBars - visibleBars) / Math.max(1, maxBars - minBars)));
  // 當縮到最小 (看全部) 時：1.0 (最右邊界)
  // 當放大到最大時：0.64 (約 64% 中偏右位置，右側留 36% 充足視野)
  const targetRatio = 1.0 - zoomProgress * 0.36;
  const totalVisibleSlots = visibleBars / targetRatio;
  const rightBufferSlots = Math.round(totalVisibleSlots * (1 - targetRatio));
  const endIndex = Math.min(totalSlots - 1, lastRealIndex + rightBufferSlots);
  const startIndex = Math.max(0, Math.round(endIndex - totalVisibleSlots));
  const start = Math.max(0, (startIndex / (totalSlots - 1)) * 100);
  const end = Math.min(100, (endIndex / (totalSlots - 1)) * 100);
  return { start, end };
}

interface PriceBadgeItem {
  key: string;
  tag: string;
  val: number;
  color: string;
  text: string;
  isBold?: boolean;
  rawY?: number;
}

/**
 * TradingView / StockCenter 風格右側 Y 軸防重疊彩色數值膠囊標籤 (Price Scale Badges)
 * 標示最新現價/收盤價 (紅漲/綠跌)、MA (5/10/20/60) 及 BOLL (上/下軌)，上下排列且防數值重疊
 */
function updateRightPriceBadges(
  chart: echarts.ECharts | null,
  dom: HTMLDivElement | null,
  kline: KlineBar[],
  currentPrice?: number | null,
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
  const priceColor = isUp ? '#ef4444' : '#10b981';

  const formatPriceText = (v: number) => {
    if (v >= 1000) return v.toFixed(1);
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
  if (lastK.ma5 != null) {
    items.push({ key: 'ma5', tag: '5', val: lastK.ma5, color: '#eab308', text: formatPriceText(lastK.ma5) });
  }
  if (lastK.ma10 != null) {
    items.push({ key: 'ma10', tag: '10', val: lastK.ma10, color: '#38bdf8', text: formatPriceText(lastK.ma10) });
  }
  if (lastK.ma20 != null) {
    items.push({ key: 'ma20', tag: '20', val: lastK.ma20, color: '#c084fc', text: formatPriceText(lastK.ma20) });
  }
  if (lastK.ma60 != null) {
    items.push({ key: 'ma60', tag: '60', val: lastK.ma60, color: '#94a3b8', text: formatPriceText(lastK.ma60) });
  }

  // 3. 布林通道
  if (lastK.boll_up != null) {
    items.push({ key: 'boll_up', tag: 'UB', val: lastK.boll_up, color: '#60a5fa', text: formatPriceText(lastK.boll_up) });
  }
  if (lastK.boll_down != null) {
    items.push({ key: 'boll_down', tag: 'LB', val: lastK.boll_down, color: '#60a5fa', text: formatPriceText(lastK.boll_down) });
  }

  // 計算在主圖 Y 軸的實際像素座標
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

  // 主圖 Y 軸顯示邊界範圍 (top: 30px, height: 55%)
  const domHeight = dom.clientHeight || 450;
  const minY = 34;
  const maxY = Math.round(30 + domHeight * 0.55 - 12);

  // 依 Y 座標從小到大排列 (即價格由高到低)
  validItems.sort((a, b) => (a.rawY ?? 0) - (b.rawY ?? 0));

  // 防重疊演算法 (Two-pass Relaxation with boundary clamping)
  const minGap = 19;
  const count = validItems.length;
  const adjustedY = validItems.map((it) => it.rawY ?? 0);

  // 第一階段：由上至下依序推開
  for (let i = 1; i < count; i++) {
    if (adjustedY[i] < adjustedY[i - 1] + minGap) {
      adjustedY[i] = adjustedY[i - 1] + minGap;
    }
  }

  // 第二階段：若底部超出 maxY，由下至上回推
  if (adjustedY[count - 1] > maxY) {
    adjustedY[count - 1] = maxY;
    for (let i = count - 2; i >= 0; i--) {
      if (adjustedY[i] > adjustedY[i + 1] - minGap) {
        adjustedY[i] = adjustedY[i + 1] - minGap;
      }
    }
  }

  // 第三階段：若頂部被推擠出 minY，再次由上至下修正
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

export const StockChartDrawer: React.FC<StockChartDrawerProps> = ({
  code,
  isOpen,
  onClose,
  theme,
  currentPrice,
  changePercent,
}) => {
  const [data, setData] = useState<StockChartData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('chips');

  const mainChartRef = useRef<HTMLDivElement | null>(null);
  const subChartRef = useRef<HTMLDivElement | null>(null);
  const mainInstanceRef = useRef<echarts.ECharts | null>(null);
  const subInstanceRef = useRef<echarts.ECharts | null>(null);
  const visibleBarsRef = useRef<number>(60);

  // 當抽屜關閉或 code 變更時，徹底銷毀 ECharts instance 以釋放記憶體與 DOM 關聯
  useEffect(() => {
    if (!isOpen) {
      if (mainInstanceRef.current && !mainInstanceRef.current.isDisposed()) {
        mainInstanceRef.current.dispose();
      }
      if (subInstanceRef.current && !subInstanceRef.current.isDisposed()) {
        subInstanceRef.current.dispose();
      }
      mainInstanceRef.current = null;
      subInstanceRef.current = null;
      setData(null);
      setError(null);
    }
  }, [isOpen]);

  // 1. 載入資料
  useEffect(() => {
    if (!isOpen || !code) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    fetchStockChart(code)
      .then((res: StockChartData) => {
        if (!isMounted) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        setError(err.message || '無本檔股票歷史分析資料 (StockCenter)');
        setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [code, isOpen]);

  // 2. 主圖 (K線 + MA均線 + 布林通道 + 成交量 Vol + VMA)
  useEffect(() => {
    if (!data || !mainChartRef.current || !isOpen) return;

    if (mainInstanceRef.current && mainInstanceRef.current.isDisposed()) {
      mainInstanceRef.current = null;
    }
    if (!mainInstanceRef.current) {
      mainInstanceRef.current = echarts.init(mainChartRef.current);
    }
    const chart = mainInstanceRef.current;

    const isDark = theme === 'dark';
    const textColor = isDark ? '#94a3b8' : '#64748b';
    const gridBorder = isDark ? '#334155' : '#e2e8f0';
    const upColor = '#ef4444'; // 紅漲
    const downColor = '#10b981'; // 綠跌

    const realTotal = data.kline.length;
    // 擴充 X 軸日期並增加 35 根未來緩衝留白槽位，以實現放大置中與右側邊界舒適視野
    const expandedDates = data.kline.map((k) => k.date).concat(new Array(BUFFER_DAYS).fill(''));

    // ECharts K線格式: [open, close, lowest, highest]
    const candles = data.kline.map((k) => [k.open, k.close, k.low, k.high]);
    const volumes = data.kline.map((k) => ({
      value: k.volume,
      itemStyle: {
        color: k.close >= k.open ? upColor : downColor,
      },
    }));

    const ma5 = data.kline.map((k) => k.ma5 ?? null);
    const ma10 = data.kline.map((k) => k.ma10 ?? null);
    const ma20 = data.kline.map((k) => k.ma20 ?? null);
    const ma60 = data.kline.map((k) => k.ma60 ?? null);

    const bollUp = data.kline.map((k) => k.boll_up ?? null);
    const bollMid = data.kline.map((k) => k.boll_mid ?? null);
    const bollDown = data.kline.map((k) => k.boll_down ?? null);

    // 計算預設顯示範圍：近 60 根或全部，採用 StockCenter 置中算法
    const initBars = Math.min(60, realTotal);
    visibleBarsRef.current = initBars;
    const { start: initStart, end: initEnd } = calcZoomFromVisibleBars(initBars, realTotal, BUFFER_DAYS);

    const option: any = {
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'cross',
          link: [{ xAxisIndex: 'all' }],
        },
        backgroundColor: isDark ? 'rgba(15, 23, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)',
        borderColor: isDark ? '#334155' : '#cbd5e1',
        textStyle: { color: isDark ? '#f8fafc' : '#0f172a', fontSize: 12 },
        formatter: (params: any) => {
          if (!Array.isArray(params) || params.length === 0) return '';
          const p0 = params[0];
          const idx = p0.dataIndex;
          if (idx >= realTotal) return '';
          const k = data.kline[idx];
          if (!k) return '';

          const chg = k.close - k.open;
          const chgPct = k.open > 0 ? (chg / k.open) * 100 : 0;
          const isUp = k.close >= k.open;
          const colorHex = isUp ? upColor : downColor;

          let html = `<div style="font-weight:700;margin-bottom:4px;">${k.date} ${data.code} ${data.name}</div>`;
          html += `<div style="color:${colorHex};font-weight:600;">收盤: ${k.close} (${isUp ? '+' : ''}${chg.toFixed(2)}, ${chgPct.toFixed(2)}%)</div>`;
          html += `<div>開: ${k.open} | 高: ${k.high} | 低: ${k.low}</div>`;
          html += `<div>成交量: ${Math.round(k.volume).toLocaleString()} 張</div>`;
          html += `<div style="color:#eab308;margin-top:2px;">MA5: ${k.ma5 || '-'} | MA10: ${k.ma10 || '-'} | MA20: ${k.ma20 || '-'}</div>`;
          if (k.boll_up) {
            html += `<div style="color:#60a5fa;">BOLL上: ${k.boll_up} | 中: ${k.boll_mid} | 下: ${k.boll_down}</div>`;
          }
          return html;
        },
      },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
      },
      grid: [
        { left: '45px', right: '78px', top: '30px', height: '55%' }, // K線主窗格，留出 78px 供右側價格徽章對齊
        { left: '45px', right: '78px', top: '70%', height: '22%' }, // 成交量窗格
      ],
      xAxis: [
        {
          type: 'category',
          data: expandedDates,
          gridIndex: 0,
          boundaryGap: false,
          axisLine: { lineStyle: { color: gridBorder } },
          axisLabel: { show: false },
          splitLine: { show: true, lineStyle: { color: isDark ? '#1e293b' : '#f1f5f9' } },
        },
        {
          type: 'category',
          data: expandedDates,
          gridIndex: 1,
          boundaryGap: false,
          axisLine: { lineStyle: { color: gridBorder } },
          axisLabel: { color: textColor, fontSize: 11 },
          splitLine: { show: true, lineStyle: { color: isDark ? '#1e293b' : '#f1f5f9' } },
        },
      ],
      yAxis: [
        {
          scale: true,
          gridIndex: 0,
          position: 'right',
          splitArea: { show: false },
          axisLabel: { color: textColor, fontSize: 11 },
          splitLine: { show: true, lineStyle: { color: isDark ? '#1e293b' : '#f1f5f9' } },
        },
        {
          scale: true,
          gridIndex: 1,
          position: 'right',
          splitNumber: 2,
          axisLabel: { color: textColor, fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: [0, 1],
          zoomOnMouseWheel: false,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
          start: initStart,
          end: initEnd,
        },
        {
          type: 'slider',
          xAxisIndex: [0, 1],
          bottom: '2px',
          height: '14px',
          start: initStart,
          end: initEnd,
          borderColor: 'transparent',
          backgroundColor: isDark ? 'rgba(30, 41, 59, 0.4)' : 'rgba(226, 232, 240, 0.5)',
          fillerColor: isDark ? 'rgba(56, 189, 248, 0.2)' : 'rgba(14, 165, 233, 0.2)',
          handleStyle: { color: '#0284c7' },
          textStyle: { show: false },
        },
      ],
      series: [
        {
          name: 'K線',
          type: 'candlestick',
          data: candles,
          barMaxWidth: 45, // 放大時單根 K 棒最大寬度，呈現超清晰粗厚實體與影線
          itemStyle: {
            color: upColor,
            color0: downColor,
            borderColor: upColor,
            borderColor0: downColor,
          },
        },
        {
          name: 'MA5',
          type: 'line',
          data: ma5,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.2, color: '#eab308' },
        },
        {
          name: 'MA10',
          type: 'line',
          data: ma10,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.2, color: '#38bdf8' },
        },
        {
          name: 'MA20',
          type: 'line',
          data: ma20,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.2, color: '#c084fc' },
        },
        {
          name: 'MA60',
          type: 'line',
          data: ma60,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1.2, color: '#94a3b8' },
        },
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
          lineStyle: { width: 1, type: 'dashed', color: '#818cf8' },
        },
        {
          name: 'BOLL下軌',
          type: 'line',
          data: bollDown,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, type: 'dashed', color: '#60a5fa' },
        },
        {
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          barMaxWidth: 45,
          data: volumes,
        },
      ],
    };

    chart.setOption(option, true);

    const dom = mainChartRef.current;

    // 初始與延遲更新 TradingView / StockCenter 右側價格徽章
    const refreshBadges = () => {
      updateRightPriceBadges(chart, dom, data.kline, currentPrice);
    };

    refreshBadges();
    requestAnimationFrame(refreshBadges);
    const badgeTimer = setTimeout(refreshBadges, 80);

    // 綁定以最新 K 柱為錨點的滾輪縮放邏輯 (StockCenter 居中聚焦體驗)
    const handleWheel = (e: WheelEvent) => {
      if (!mainInstanceRef.current || mainInstanceRef.current.isDisposed()) return;

      // 攔截滾輪事件，阻止頁面上下滾動，並以最新 K 棒置中為焦點縮放
      e.preventDefault();
      e.stopPropagation();

      const totalSlots = realTotal + BUFFER_DAYS;
      let currentBars = visibleBarsRef.current || Math.min(60, realTotal);

      const opt: any = mainInstanceRef.current.getOption();
      const dz = opt?.dataZoom?.[0];
      if (dz && dz.start != null && dz.end != null) {
        const spanSlots = ((dz.end - dz.start) / 100) * (totalSlots - 1);
        if (spanSlots > 0) {
          currentBars = Math.max(MIN_VISIBLE_BARS, Math.min(realTotal, spanSlots * 0.75));
        }
      }

      // 阻尼計算：平滑支援滑鼠滾輪與觸控板手勢
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 40;
      else if (e.deltaMode === 2) delta *= 800;
      const zoomStep = Math.min(0.28, Math.max(0.06, Math.abs(delta) / 360));
      const zoomFactor = delta < 0 ? 1 - zoomStep : 1 + zoomStep * 1.15;

      let nextBars = currentBars * zoomFactor;
      nextBars = Math.max(MIN_VISIBLE_BARS, Math.min(realTotal, nextBars));
      visibleBarsRef.current = nextBars;

      const res = calcZoomFromVisibleBars(nextBars, realTotal, BUFFER_DAYS);
      mainInstanceRef.current.dispatchAction({
        type: 'dataZoom',
        start: res.start,
        end: res.end,
      });
      refreshBadges();
    };

    dom.addEventListener('wheel', handleWheel, { passive: false, capture: true });

    // 同步手動 slider 或左右拖曳後的 K 棒數量與價格徽章
    const handleDataZoom = () => {
      const opt: any = chart.getOption();
      const dz = opt?.dataZoom?.[0];
      if (dz && dz.start != null && dz.end != null) {
        const spanSlots = ((dz.end - dz.start) / 100) * (realTotal + BUFFER_DAYS - 1);
        if (spanSlots > 0) {
          visibleBarsRef.current = Math.max(MIN_VISIBLE_BARS, Math.min(realTotal, spanSlots * 0.75));
        }
      }
      refreshBadges();
    };
    chart.on('datazoom', handleDataZoom);

    const handleResize = () => {
      chart.resize();
      refreshBadges();
    };
    window.addEventListener('resize', handleResize);
    return () => {
      clearTimeout(badgeTimer);
      dom.removeEventListener('wheel', handleWheel, { capture: true });
      chart.off('datazoom', handleDataZoom);
      window.removeEventListener('resize', handleResize);
    };
  }, [data, theme, isOpen]);

  // 3. 次圖（Tab 切換：三大法人籌碼 / 融資融券主力 / 大戶持股比例）
  useEffect(() => {
    if (!data || !subChartRef.current || !isOpen) return;

    if (subInstanceRef.current && subInstanceRef.current.isDisposed()) {
      subInstanceRef.current = null;
    }
    if (!subInstanceRef.current) {
      subInstanceRef.current = echarts.init(subChartRef.current);
    }
    const chart = subInstanceRef.current;

    const isDark = theme === 'dark';
    const textColor = isDark ? '#94a3b8' : '#64748b';
    const gridBorder = isDark ? '#334155' : '#e2e8f0';

    let subOption: echarts.EChartsOption = {};

    if (activeTab === 'chips') {
      // 籌碼：三大法人買賣超 (外資/投信/自營商)
      const flow = [...data.institutional].reverse();
      const dates = flow.map((i) => i.date.slice(5));
      const foreign = flow.map((i) => i.foreign);
      const trust = flow.map((i) => i.trust);
      const dealer = flow.map((i) => i.dealer);

      subOption = {
        animation: false,
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
        },
        legend: {
          data: ['外資', '投信', '自營商'],
          textStyle: { color: textColor, fontSize: 11 },
          top: 0,
        },
        grid: { left: '45px', right: '20px', top: '28px', bottom: '20px' },
        xAxis: {
          type: 'category',
          data: dates,
          axisLine: { lineStyle: { color: gridBorder } },
          axisLabel: { color: textColor, fontSize: 11 },
        },
        yAxis: {
          type: 'value',
          position: 'right',
          axisLabel: { color: textColor, fontSize: 10 },
          splitLine: { lineStyle: { color: isDark ? '#1e293b' : '#f1f5f9' } },
        },
        series: [
          {
            name: '外資',
            type: 'bar',
            data: foreign,
            itemStyle: { color: '#ef4444' },
          },
          {
            name: '投信',
            type: 'bar',
            data: trust,
            itemStyle: { color: '#f59e0b' },
          },
          {
            name: '自營商',
            type: 'bar',
            data: dealer,
            itemStyle: { color: '#38bdf8' },
          },
        ],
      };
    } else if (activeTab === 'margin') {
      // 主力：融資融券增減
      const flow = [...data.margin].reverse();
      const dates = flow.map((m) => m.date.slice(5));
      const marginChange = flow.map((m) => m.margin_change);
      const marginBalance = flow.map((m) => m.margin_balance);

      subOption = {
        animation: false,
        tooltip: { trigger: 'axis' },
        legend: {
          data: ['融資增減', '融資餘額'],
          textStyle: { color: textColor, fontSize: 11 },
          top: 0,
        },
        grid: { left: '45px', right: '20px', top: '28px', bottom: '20px' },
        xAxis: {
          type: 'category',
          data: dates,
          axisLine: { lineStyle: { color: gridBorder } },
          axisLabel: { color: textColor, fontSize: 11 },
        },
        yAxis: [
          {
            type: 'value',
            name: '增減',
            position: 'right',
            axisLabel: { color: textColor, fontSize: 10 },
            splitLine: { lineStyle: { color: isDark ? '#1e293b' : '#f1f5f9' } },
          },
          {
            type: 'value',
            name: '餘額',
            position: 'left',
            axisLabel: { color: textColor, fontSize: 10 },
            splitLine: { show: false },
          },
        ],
        series: [
          {
            name: '融資增減',
            type: 'bar',
            data: marginChange,
            itemStyle: {
              color: (p: any) => (p.value >= 0 ? '#ef4444' : '#10b981'),
            },
          },
          {
            name: '融資餘額',
            type: 'line',
            yAxisIndex: 1,
            data: marginBalance,
            lineStyle: { color: '#f59e0b', width: 2 },
          },
        ],
      };
    } else if (activeTab === 'holders') {
      // 大戶：集保週報 400張 / 1000張大戶比例 (依日期由舊到新排序，確保左舊右新)
      const flow = [...data.holders].sort((a, b) => a.date.localeCompare(b.date));
      const dates = flow.map((h) => h.date.slice(5));
      const over400 = flow.map((h) => h.over400_pct);
      const over1000 = flow.map((h) => h.over1000_pct);
      const retail = flow.map((h) => h.retail_pct);

      subOption = {
        animation: false,
        tooltip: { trigger: 'axis' },
        legend: {
          data: ['400張以上大戶', '1000張以上大戶', '散戶(<400張)'],
          textStyle: { color: textColor, fontSize: 11 },
          top: 0,
        },
        grid: { left: '45px', right: '20px', top: '28px', bottom: '20px' },
        xAxis: {
          type: 'category',
          data: dates,
          axisLine: { lineStyle: { color: gridBorder } },
          axisLabel: { color: textColor, fontSize: 11 },
        },
        yAxis: {
          type: 'value',
          position: 'right',
          axisLabel: { formatter: '{value}%', color: textColor, fontSize: 10 },
          splitLine: { lineStyle: { color: isDark ? '#1e293b' : '#f1f5f9' } },
        },
        series: [
          {
            name: '400張以上大戶',
            type: 'line',
            data: over400,
            lineStyle: { color: '#ef4444', width: 2 },
          },
          {
            name: '1000張以上大戶',
            type: 'line',
            data: over1000,
            lineStyle: { color: '#ec4899', width: 2 },
          },
          {
            name: '散戶(<400張)',
            type: 'line',
            data: retail,
            lineStyle: { color: '#10b981', width: 2 },
          },
        ],
      };
    }

    chart.setOption(subOption, true);

    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [data, activeTab, theme, isOpen]);

  // 同步兩張圖表的十字游標 (Connect)
  useEffect(() => {
    if (mainInstanceRef.current && subInstanceRef.current) {
      echarts.connect([mainInstanceRef.current, subInstanceRef.current]);
    }
  }, [data, activeTab]);

  if (!isOpen) return null;

  return (
    <div
      className="chart-drawer-overlay"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <aside
        className="chart-drawer-panel"
        onClick={(e) => e.stopPropagation()}
        aria-label="個股動態技術分析走勢圖"
      >
        {/* 抽屜頂部標題列 */}
        <div className="chart-drawer-header">
          <div className="chart-drawer-title-area">
            <span className="chart-stock-code">{code}</span>
            <span className="chart-stock-name">{data?.name || '載入中...'}</span>
            {currentPrice !== undefined && currentPrice !== null && (
              <span
                className={`chart-live-price ${
                  (changePercent ?? 0) > 0 ? 'color-up' : (changePercent ?? 0) < 0 ? 'color-down' : ''
                }`}
              >
                現價: {currentPrice} ({changePercent !== undefined && (changePercent ?? 0) > 0 ? '+' : ''}
                {changePercent?.toFixed(2)}%)
              </span>
            )}
            {data?.isAppendedToday && (
              <span className="chart-live-badge" title="已將今日最新報價無縫拼接至 K 線末端">
                ● 盤中動態同步中
              </span>
            )}
          </div>
          <button className="btn-drawer-close" onClick={onClose} title="關閉走勢圖 (Esc)">
            ✕
          </button>
        </div>

        {/* 內容區塊 */}
        <div className="chart-drawer-body">
          {loading && (
            <div className="chart-loading-state">
              <span className="chart-loading-spinner" />
              <span>正在載入 {code} 歷史走勢與籌碼分析...</span>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                （若為新個股，系統正自動連動 StockCenter 建立完整報告與指標數據，完成後將自動永久存檔）
              </div>
            </div>
          )}

          {error && (
            <div className="chart-error-state">
              <div style={{ fontSize: '24px', marginBottom: '8px' }}>⚠️</div>
              <div>{error}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                請確認 StockCenter/reports 是否已產出該個股之 HTML 技術分析報告。
              </div>
            </div>
          )}

          {!loading && !error && data && (
            <>
              {/* 1. 主圖：K線與成交量 */}
              <div className="chart-container-main" ref={mainChartRef} />

              {/* 2. 次圖切換 Tab 列 */}
              <div className="chart-sub-tabs">
                <button
                  className={`sub-tab-btn ${activeTab === 'chips' ? 'active' : ''}`}
                  onClick={() => setActiveTab('chips')}
                >
                  🏛️ 三大法人籌碼 ({data.institutional.length}日)
                </button>
                <button
                  className={`sub-tab-btn ${activeTab === 'margin' ? 'active' : ''}`}
                  onClick={() => setActiveTab('margin')}
                >
                  ⚡ 資券主力變動 ({data.margin.length}日)
                </button>
                <button
                  className={`sub-tab-btn ${activeTab === 'holders' ? 'active' : ''}`}
                  onClick={() => setActiveTab('holders')}
                >
                  👑 大戶散戶比例 ({data.holders.length}週)
                </button>
              </div>

              {/* 3. 次圖指標容器 */}
              <div className="chart-container-sub" ref={subChartRef} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
};
