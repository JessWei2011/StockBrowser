import React from 'react';
import type { QuoteState, WatchlistItem } from '../types';

interface CompactCardListProps {
  items: WatchlistItem[];
  quotes: Record<string, QuoteState>;
  dirtyCodes: Set<string>;
  onRemoveItem: (code: string) => Promise<void>;
  onMoveItem: (index: number, direction: 'up' | 'down') => Promise<void>;
}

export const CompactCardList: React.FC<CompactCardListProps> = ({
  items,
  quotes,
  onRemoveItem,
  onMoveItem,
}) => {
  const formatPrice = (val: number | null | undefined, isSim?: boolean): React.ReactNode => {
    if (val === null || val === undefined || isNaN(val)) return '—';
    const text = val.toFixed(2);
    if (isSim) {
      return (
        <>
          <span className="sim-asterisk" title="試撮階段">*</span>
          {text}
        </>
      );
    }
    return text;
  };

  const formatVolume = (val: number | null | undefined): string => {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return val.toLocaleString();
  };

  const getPriceClass = (val: number | null | undefined, prev: number | null | undefined): string => {
    if (val === null || val === undefined || isNaN(val) || prev === null || prev === undefined || isNaN(prev)) return 'color-neutral';
    if (val > prev) return 'color-up';
    if (val < prev) return 'color-down';
    return 'color-neutral';
  };

  if (items.length === 0) {
    return (
      <div className="flat-card-container empty-flat-container">
        <p className="empty-message">目前組合沒有商品，請由上方搜尋並新增個股。</p>
      </div>
    );
  }

  return (
    <div className="flat-card-container">
      {items.map((item, idx) => {
        const q = quotes[item.code];
        const prev = q?.previousClose ?? null;
        const last = q?.last ?? null;
        const chg = q?.change ?? null;
        const pct = q?.changePercent ?? null;
        const isSimulated = q?.isSimulated ?? false;
        const isAttention = q?.isAttention ?? false;
        const dispositionLevel = q?.dispositionLevel ?? 0;
        const dispositionPeriod = q?.dispositionPeriod ?? null;

        // 1. 核心漲跌顏色判定 (紅漲、綠跌、平盤中性灰)
        let changeClass = 'color-neutral';
        const effectiveChg = chg !== null ? chg : (last !== null && prev !== null ? last - prev : null);
        const effectivePct = pct !== null ? pct : (effectiveChg !== null && prev !== null && prev > 0 ? (effectiveChg / prev) * 100 : null);
        if (effectiveChg !== null && !isNaN(effectiveChg)) {
          if (effectiveChg > 0) changeClass = 'color-up';
          else if (effectiveChg < 0) changeClass = 'color-down';
        }

        // 2. 檢查漲跌停 (幅標 >= 9.5% 或 <= -9.5%)
        const isLimitUp = effectivePct !== null && !isNaN(effectivePct) && effectivePct >= 9.5;
        const isLimitDown = effectivePct !== null && !isNaN(effectivePct) && effectivePct <= -9.5;

        // 3. 樣式與徽章判定
        let badgeClass = '';
        if (isLimitUp) {
          badgeClass = 'badge-limit-up';
          changeClass = 'color-up'; // 漲停必定為紅
        } else if (isLimitDown) {
          badgeClass = 'badge-limit-down';
          changeClass = 'color-down'; // 跌停必定為綠
        }

        // 4. 處置與注意標籤文字
        const dispText = dispositionPeriod ? `處置 ${dispositionPeriod}` : '處置';

        return (
          <div key={item.id} className="flat-stock-item">
            {/* 上半行：商品識別 (左) + 核心即時現價與漲跌 (右) */}
            <div className="flat-row-primary">
              <div className="flat-stock-id">
                <span className="flat-code">{item.code}</span>
                <span className="flat-name">{item.name || q?.name || ''}</span>
                {dispositionLevel > 0 && (
                  <span className="stock-badge badge-disposition" title={dispositionPeriod ? `處置股票 (期間: ${dispositionPeriod})` : '處置股票'}>
                    [{dispText}]
                  </span>
                )}
                {dispositionLevel === 0 && isAttention && (
                  <span className="stock-badge badge-attention" title="注意股票">
                    [注意]
                  </span>
                )}
                <span className="flat-tag">{item.exchange}</span>
              </div>

              <div className="flat-price-display">
                {badgeClass ? (
                  <span className={`flat-price-pill ${badgeClass}`}>
                    {formatPrice(last, isSimulated)}
                  </span>
                ) : (
                  <span className={`flat-price-val ${getPriceClass(last, prev)}`}>
                    {formatPrice(last, isSimulated)}
                  </span>
                )}

                <div className="flat-chg-stack">
                  <span className={`flat-chg-num ${changeClass}`}>
                    {effectiveChg === null || isNaN(effectiveChg)
                      ? '—'
                      : effectiveChg > 0
                      ? `▲ ${effectiveChg.toFixed(2)}`
                      : effectiveChg < 0
                      ? `▼ ${Math.abs(effectiveChg).toFixed(2)}`
                      : '— 0.00'}
                  </span>
                  <span className={`flat-pct-num ${changeClass}`}>
                    {effectivePct === null || isNaN(effectivePct)
                      ? ''
                      : effectivePct > 0
                      ? `+${effectivePct.toFixed(2)}%`
                      : effectivePct < 0
                      ? `${effectivePct.toFixed(2)}%`
                      : '0.00%'}
                  </span>
                </div>
              </div>
            </div>

            {/* 下半行：扁平網格數值 (最高、最低、總量、昨收、開盤) + 極簡操作按鈕 */}
            <div className="flat-row-secondary">
              <div className="flat-grid">
                <div className="flat-col flat-col-stagger-high">
                  <span className="flat-label">最高</span>
                  <span className={`flat-val ${getPriceClass(q?.high, prev)}`}>
                    {formatPrice(q?.high)}
                  </span>
                </div>

                <div className="flat-col flat-col-stagger-low">
                  <span className="flat-label">最低</span>
                  <span className={`flat-val ${getPriceClass(q?.low, prev)}`}>
                    {formatPrice(q?.low)}
                  </span>
                </div>

                <div className="flat-col flat-col-stagger-high">
                  <span className="flat-label">總量</span>
                  <span className="flat-val flat-vol-val">
                    {formatVolume(q?.totalVolume)}
                  </span>
                </div>

                <div className="flat-col flat-col-stagger-low">
                  <span className="flat-label">昨收</span>
                  <span className="flat-val flat-ref-val">
                    {formatPrice(prev)}
                  </span>
                </div>

                <div className="flat-col flat-col-stagger-high">
                  <span className="flat-label">開盤</span>
                  <span className="flat-val flat-open-val">
                    {formatPrice(q?.open)}
                  </span>
                </div>
              </div>

              <div className="flat-actions">
                <button
                  className="btn-flat-action"
                  disabled={idx === 0}
                  onClick={() => onMoveItem(idx, 'up')}
                  title="上移"
                >
                  ↑
                </button>
                <button
                  className="btn-flat-action"
                  disabled={idx === items.length - 1}
                  onClick={() => onMoveItem(idx, 'down')}
                  title="下移"
                >
                  ↓
                </button>
                <button
                  className="btn-flat-action btn-flat-delete"
                  onClick={() => onRemoveItem(item.code)}
                  title="刪除"
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
