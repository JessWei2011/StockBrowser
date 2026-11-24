/**
 * 臺灣證券交易所 (TWSE) 升降單位與漲跌停價格計算工具
 */

export function getTwseTickSize(price: number): number {
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.10;
  if (price < 500) return 0.50;
  if (price < 1000) return 1.00;
  return 5.00;
}

/**
 * 計算台股標準漲停價：
 * 昨收基準價 * 1.10，未滿升降單位全部無條件捨去，且漲幅不得超過 10%
 */
export function calculateLimitUp(refPrice: number): number {
  if (!refPrice || refPrice <= 0) return 0;
  const raw = refPrice * 1.10;
  const tick = getTwseTickSize(raw);
  const steps = Math.floor((raw + 1e-7) / tick);
  let res = Math.round(steps * tick * 100) / 100;
  const maxRise = Math.round(refPrice * 0.10 * 100) / 100;
  if (Math.round((res - refPrice) * 100) / 100 > maxRise + 1e-4) {
    res = Math.round((steps - 1) * tick * 100) / 100;
  }
  return res;
}

/**
 * 計算台股標準跌停價：
 * 昨收基準價 * 0.90，未滿升降單位全部無條件進位，且跌幅不得超過 10%（最低 0.01）
 */
export function calculateLimitDown(refPrice: number): number {
  if (!refPrice || refPrice <= 0) return 0;
  const raw = refPrice * 0.90;
  const tick = getTwseTickSize(raw);
  const steps = Math.ceil((raw - 1e-7) / tick);
  let res = Math.round(steps * tick * 100) / 100;
  if (res < 0.01) res = 0.01;
  const maxDrop = Math.round(refPrice * 0.10 * 100) / 100;
  if (Math.round((refPrice - res) * 100) / 100 > maxDrop + 1e-4) {
    res = Math.round((steps + 1) * tick * 100) / 100;
  }
  return res;
}

/**
 * 判定個股現價是否正處於漲停狀態：
 * 必須確實觸及或高於漲停價（考慮浮點數容差 0.001）。
 * 若商品為無漲跌幅限制之債券或國外成分 ETF，則永遠不亮燈。
 * 一旦解開/打開漲停（例如買賣撮合落於漲停價之下一檔），燈號即刻熄滅。
 */
export function isLimitUpPrice(
  last: number | null | undefined,
  limitUp: number | null | undefined,
  refPrice: number | null | undefined,
  isEtfOrBond?: boolean
): boolean {
  if (last === null || last === undefined || last <= 0) return false;

  let targetLimitUp: number | null = null;
  if (limitUp !== null && limitUp !== undefined && limitUp > 0) {
    targetLimitUp = limitUp;
  } else if (!isEtfOrBond && refPrice && refPrice > 0) {
    targetLimitUp = calculateLimitUp(refPrice);
  }

  if (targetLimitUp === null || targetLimitUp <= 0) return false;
  return last >= targetLimitUp - 0.001;
}

/**
 * 判定個股現價是否正處於跌停狀態：
 * 必須確實觸及或低於跌停價（考慮浮點數容差 0.001）。
 * 若商品為無漲跌幅限制之債券或國外成分 ETF，則永遠不亮燈。
 * 一旦解開/打開跌停（例如買盤敲進成交價高於跌停價上一檔），燈號即刻熄滅。
 */
export function isLimitDownPrice(
  last: number | null | undefined,
  limitDown: number | null | undefined,
  refPrice: number | null | undefined,
  isEtfOrBond?: boolean
): boolean {
  if (last === null || last === undefined || last <= 0) return false;

  let targetLimitDown: number | null = null;
  if (limitDown !== null && limitDown !== undefined && limitDown > 0) {
    targetLimitDown = limitDown;
  } else if (!isEtfOrBond && refPrice && refPrice > 0) {
    targetLimitDown = calculateLimitDown(refPrice);
  }

  if (targetLimitDown === null || targetLimitDown <= 0) return false;
  return last <= targetLimitDown + 0.001;
}
