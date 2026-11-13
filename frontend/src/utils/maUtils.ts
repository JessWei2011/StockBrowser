import type { StockMaSummary } from '../types';

export interface RealtimeMaResult {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  is5Up: boolean | null;
  is10Up: boolean | null;
  is20Up: boolean | null;
}

/**
 * 計算盤中動態均線 (Realtime Moving Average) 與站上/跌破判定
 * 
 * 均線定義：
 * - 盤中交易時段：N 日均線 = (前 N-1 日收盤價總和 + 當前盤中即時現價) / N
 * - 當股價 currP 每跳動一檔，均線與燈號立即在瀏覽器端 0 延遲連動重算
 * - 若無 recentCloses 歷史序列，自動退回使用昨日收盤靜態均線 (fallback)
 */
export function getRealtimeMaIndicators(
  ind: StockMaSummary | undefined,
  currP: number | null
): RealtimeMaResult {
  if (!ind) {
    return {
      ma5: null,
      ma10: null,
      ma20: null,
      is5Up: null,
      is10Up: null,
      is20Up: null,
    };
  }

  const recentCloses = ind.recentCloses;
  const hasCloses = Array.isArray(recentCloses) && recentCloses.length > 0;
  const validP = currP !== null && currP !== undefined && currP > 0;

  // 1. 5MA 計算：前 4 日收盤 + 今日現價
  let ma5: number | null = null;
  if (validP && hasCloses && recentCloses.length >= 4) {
    const sum4 = recentCloses.slice(-4).reduce((acc, v) => acc + v, 0);
    ma5 = Math.round(((sum4 + currP!) / 5) * 100) / 100;
  } else if (ind.ma5 !== undefined && ind.ma5 !== null) {
    ma5 = ind.ma5;
  }

  // 2. 10MA 計算：前 9 日收盤 + 今日現價
  let ma10: number | null = null;
  if (validP && hasCloses && recentCloses.length >= 9) {
    const sum9 = recentCloses.slice(-9).reduce((acc, v) => acc + v, 0);
    ma10 = Math.round(((sum9 + currP!) / 10) * 100) / 100;
  } else if (ind.ma10 !== undefined && ind.ma10 !== null) {
    ma10 = ind.ma10;
  }

  // 3. 20MA 計算：前 19 日收盤 + 今日現價
  let ma20: number | null = null;
  if (validP && hasCloses && recentCloses.length >= 19) {
    const sum19 = recentCloses.slice(-19).reduce((acc, v) => acc + v, 0);
    ma20 = Math.round(((sum19 + currP!) / 20) * 100) / 100;
  } else if (ind.ma20 !== undefined && ind.ma20 !== null) {
    ma20 = ind.ma20;
  }

  const is5Up = validP && ma5 !== null ? currP! >= ma5 : null;
  const is10Up = validP && ma10 !== null ? currP! >= ma10 : null;
  const is20Up = validP && ma20 !== null ? currP! >= ma20 : null;

  return { ma5, ma10, ma20, is5Up, is10Up, is20Up };
}
