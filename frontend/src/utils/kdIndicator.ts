import type { KlineBar } from '../types';

export type KdPeriod = 'daily' | 'weekly';

/**
 * 將 kline 中各種日期格式 (YYYY-MM-DD, YYYY/MM/DD, MM/DD) 解析為所屬週的週一日期字串 (YYYY-MM-DD)，
 * 作為週 K 分組鍵值；若為無年份之 MM/DD 格式，依時間軸由新到舊反推正確年份 (含跨年遞減)。
 */
function buildWeekMondayKeys(kline: KlineBar[]): string[] {
  const n = kline.length;
  const keys = new Array<string>(n);
  if (n === 0) return keys;

  const now = new Date();
  let inferredYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // 先檢查最後一筆無年份日期的月份，若遠大於當前月份 (例如 1 月初看去年 12 月資料)，起始年份減 1
  const lastParts = kline[n - 1].date.trim().split(/[-/]/);
  if (lastParts.length === 2) {
    const lastMonth = Number(lastParts[0]);
    if (Number.isFinite(lastMonth) && lastMonth - currentMonth > 6) {
      inferredYear -= 1;
    }
  }

  let prevMonth: number | null = null;

  for (let i = n - 1; i >= 0; i--) {
    const raw = kline[i].date.trim();
    const parts = raw.split(/[-/]/);
    let y: number;
    let m: number;
    let d: number;

    if (parts.length === 3) {
      y = Number(parts[0]);
      m = Number(parts[1]);
      d = Number(parts[2]);
    } else if (parts.length === 2) {
      m = Number(parts[0]);
      d = Number(parts[1]);
      if (prevMonth !== null && m > prevMonth) {
        inferredYear -= 1;
      }
      y = inferredYear;
      prevMonth = m;
    } else {
      keys[i] = raw;
      continue;
    }

    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
      keys[i] = raw;
      continue;
    }

    const dt = new Date(Date.UTC(y, m - 1, d));
    const day = dt.getUTCDay(); // 0: Sun, 1: Mon, ..., 6: Sat
    const diffToMon = day === 0 ? -6 : 1 - day;
    const monday = new Date(dt.getTime() + diffToMon * 86400000);
    keys[i] = monday.toISOString().slice(0, 10);
  }

  return keys;
}

/**
 * 計算標準日 KD(9, 3, 3) 隨機指標
 * 若後端已提供則優先採用；若無（例如大盤指數或後端舊快取），即時由開高低收進行標準平滑計算
 */
export function getCalculatedDailyKD(kline: KlineBar[]) {
  const count = kline.length;
  const kVals: (number | null)[] = new Array(count).fill(null);
  const dVals: (number | null)[] = new Array(count).fill(null);

  const validBackendK = kline.filter((b) => b.k != null && !isNaN(b.k));
  if (count > 0 && validBackendK.length > count * 0.7) {
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
 * 計算標準週 KD(9, 3, 3) 隨機指標，並逐日對齊至日 K 時間軸
 * 採週內漸進更新：已完成週鎖定週收盤計算基準，當週各交易日依截至當日之週高/低/收即時計算，
 * 既與上方日 K 主圖 100% 同步縮放與十字游標，又可於週五收盤及最新盤中呈現精確週 KD 數值。
 */
export function getCalculatedWeeklyKD(kline: KlineBar[]) {
  const count = kline.length;
  const kVals: (number | null)[] = new Array(count).fill(null);
  const dVals: (number | null)[] = new Array(count).fill(null);

  if (count === 0) return { kVals, dVals };

  const weekKeys = buildWeekMondayKeys(kline);
  const completedWeeks: Array<{ high: number; low: number; close: number }> = [];
  let prevWeekK = 50.0;
  let prevWeekD = 50.0;
  let curWeekKey: string | null = null;
  let curWeekHigh = -Infinity;
  let curWeekLow = Infinity;

  const calcWeekRsv = (
    curHigh: number,
    curLow: number,
    curClose: number,
    prevWeeks: Array<{ high: number; low: number; close: number }>
  ) => {
    let subHigh = curHigh;
    let subLow = curLow;
    const lookbackStart = Math.max(0, prevWeeks.length - 8);
    for (let w = lookbackStart; w < prevWeeks.length; w++) {
      if (prevWeeks[w].high > subHigh) subHigh = prevWeeks[w].high;
      if (prevWeeks[w].low < subLow) subLow = prevWeeks[w].low;
    }
    if (subHigh <= subLow) return 50.0;
    const rsv = ((curClose - subLow) / (subHigh - subLow)) * 100.0;
    return Math.max(0, Math.min(100, rsv));
  };

  for (let i = 0; i < count; i++) {
    const bar = kline[i];
    const wk = weekKeys[i];

    if (wk !== curWeekKey) {
      if (curWeekKey !== null && i > 0) {
        const prevClose = kline[i - 1].close;
        const rsv = calcWeekRsv(curWeekHigh, curWeekLow, prevClose, completedWeeks);
        prevWeekK = (2 / 3) * prevWeekK + (1 / 3) * rsv;
        prevWeekD = (2 / 3) * prevWeekD + (1 / 3) * prevWeekK;
        completedWeeks.push({
          high: curWeekHigh,
          low: curWeekLow,
          close: prevClose,
        });
      }
      curWeekKey = wk;
      curWeekHigh = bar.high;
      curWeekLow = bar.low;
    } else {
      if (bar.high > curWeekHigh) curWeekHigh = bar.high;
      if (bar.low < curWeekLow) curWeekLow = bar.low;
    }

    const rsvToday = calcWeekRsv(curWeekHigh, curWeekLow, bar.close, completedWeeks);
    const kToday = (2 / 3) * prevWeekK + (1 / 3) * rsvToday;
    const dToday = (2 / 3) * prevWeekD + (1 / 3) * kToday;

    // 滿 9 週 (第 9 週起，completedWeeks.length >= 8) 輸出數值
    if (completedWeeks.length >= 8) {
      kVals[i] = Math.round(kToday * 100) / 100;
      dVals[i] = Math.round(dToday * 100) / 100;
    }
  }

  return { kVals, dVals };
}

export function getCalculatedKD(kline: KlineBar[], period: KdPeriod = 'daily') {
  return period === 'weekly' ? getCalculatedWeeklyKD(kline) : getCalculatedDailyKD(kline);
}
