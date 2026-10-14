import React from 'react';
import type { QuoteState, WatchlistItem, StockAnnouncement, StockMaSummary } from '../types';

interface CompactCardListProps {
  items: WatchlistItem[];
  isWealthGroup?: boolean;
  quotes: Record<string, QuoteState>;
  announcements?: Record<string, StockAnnouncement[]>;
  indicators?: Record<string, StockMaSummary>;
  dirtyCodes: Set<string>;
  onRemoveItem: (code: string) => Promise<void>;
  onMoveItem: (index: number, direction: 'up' | 'down') => Promise<void>;
  onSelectStock?: (code: string) => void;
}

export const CompactCardList: React.FC<CompactCardListProps> = ({
  items,
  isWealthGroup,
  quotes,
  announcements = {},
  indicators = {},
  onRemoveItem,
  onMoveItem,
  onSelectStock,
}) => {
  const formatPrice = (val: number | null | undefined, isSim?: boolean): React.ReactNode => {
    if (val === null || val === undefined || isNaN(val) || val <= 0) return '—';
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
    if (val === null || val === undefined || isNaN(val) || val <= 0 || prev === null || prev === undefined || isNaN(prev) || prev <= 0) return 'color-neutral';
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
        const prev = (q?.previousClose && q.previousClose > 0) ? q.previousClose : null;
        const last = (q?.last && q.last > 0) ? q.last : null;
        const chg = (last !== null && prev !== null) ? (q?.change ?? (last - prev)) : null;
        const pct = (last !== null && prev !== null) ? (q?.changePercent ?? (chg !== null ? (chg / prev) * 100 : null)) : null;
        const isSimulated = q?.isSimulated ?? false;
        const isAttention = q?.isAttention ?? false;
        const dispositionLevel = q?.dispositionLevel ?? 0;
        const dispositionPeriod = q?.dispositionPeriod ?? null;

        // 1. 核心漲跌顏色判定 (紅漲、綠跌、平盤中性灰)
        let changeClass = 'color-neutral';
        const effectiveChg = chg;
        const effectivePct = pct;
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

        // 4. 處置與注意標籤文字 (印出處置等級，例如：處置二 10/12~10/16 或 處置一)
        const lvlStr = dispositionLevel === 2 ? '二' : (dispositionLevel === 3 ? '三' : (dispositionLevel === 1 ? '一' : ''));
        const dispPrefix = lvlStr ? `處置${lvlStr}` : '處置';
        const dispText = dispositionPeriod ? `${dispPrefix} ${dispositionPeriod}` : dispPrefix;

        const isDimmed = Boolean(
          isWealthGroup && (
            item.code.startsWith('00') ||
            ['ETF', 'BOND'].includes((item.securityType || q?.securityType || '').toUpperCase()) ||
            item.code === '6757'
          )
        );

        return (
          <div key={item.id} className={`flat-stock-item ${isDimmed ? 'card-dimmed' : ''}`}>
            {/* 上半行：商品識別 (左) + 核心即時現價與漲跌 (右) */}
            <div className="flat-row-primary">
              <div className="flat-stock-id">
                {(() => {
                  const isOtc = ((item.exchange || q?.exchange || '').toUpperCase() === 'OTC');
                  const isEtfOrBond = item.code.startsWith('00') || ['ETF', 'BOND'].includes((item.securityType || q?.securityType || '').toUpperCase());
                  return (
                    <span
                      className={isEtfOrBond ? 'stock-plain' : 'stock-clickable'}
                      onClick={!isEtfOrBond && onSelectStock ? () => onSelectStock(item.code) : undefined}
                      title={!isEtfOrBond ? '點擊開啟個股動態技術走勢圖 (K線/均線/布林/籌碼/大戶)' : undefined}
                    >
                      <span
                        className={`exchange-badge ${isOtc ? 'badge-otc' : 'badge-tse'}`}
                        title={isOtc ? '上櫃股票' : '上市股票'}
                      >
                        {isOtc ? '櫃' : '市'}
                      </span>
                      <span className={`flat-code ${isOtc ? 'code-otc' : 'code-tse'}`}>{item.code}</span>
                      <span className="flat-name">{item.name || q?.name || ''}</span>
                    </span>
                  );
                })()}
                {(() => {
                  const stockAnns = announcements[item.code] || [];
                  // 1. 處置標籤
                  const dispAnn = stockAnns.find((a) => a.category === 'disposition');
                  const hasDisp = dispAnn || dispositionLevel > 0 || dispositionPeriod;
                  const dispTitle = dispAnn ? `${dispAnn.title}\n${dispAnn.detail || ''}`.trim() : (dispositionPeriod ? `處置股票 (期間: ${dispositionPeriod})` : '處置股票');
                  const dispLabel = dispAnn?.tag || dispText;

                  // 2. 注意標籤
                  const attAnn = stockAnns.find((a) => a.category === 'attention');
                  const hasAtt = !hasDisp && (attAnn || isAttention);
                  const attTitle = attAnn ? `${attAnn.title}\n${attAnn.detail || ''}`.trim() : '注意股票';

                  // 3. 財報/法說標籤
                  const earnAnn = stockAnns.find((a) => a.category === 'earnings');

                  // 4. 重大訊息標籤
                  const newsAnn = stockAnns.find((a) => a.category === 'news');

                  // 5. 除權除息標籤
                  const exdivAnn = stockAnns.find((a) => a.category === 'exdividend');

                  // 6. 最新自結營收標籤
                  const revAnn = stockAnns.find((a) => a.category === 'revenue');

                  return (
                    <>
                      {hasDisp && (
                        <span className="stock-badge badge-disposition" title={dispTitle}>
                          [{dispLabel}]
                        </span>
                      )}
                      {hasAtt && (
                        <span className="stock-badge badge-attention" title={attTitle}>
                          [注意]
                        </span>
                      )}
                      {revAnn && (
                        <span className="stock-badge badge-revenue" title={`${revAnn.title}\n${revAnn.detail || ''}`.trim()}>
                          [{revAnn.tag}]
                        </span>
                      )}
                      {earnAnn && (
                        <span className="stock-badge badge-earnings" title={`${earnAnn.title}\n${earnAnn.detail || ''}`.trim()}>
                          [{earnAnn.tag}]
                        </span>
                      )}
                      {newsAnn && (
                        <span className="stock-badge badge-news" title={`${newsAnn.title}\n${newsAnn.detail || ''}`.trim()}>
                          [{newsAnn.tag}]
                        </span>
                      )}
                      {exdivAnn && (
                        <span className="stock-badge badge-exdiv" title={`${exdivAnn.title}\n${exdivAnn.detail || ''}`.trim()}>
                          [{exdivAnn.tag}]
                        </span>
                      )}
                    </>
                  );
                })()}
              </div>

              <div className="flat-price-display">
                <div className="flat-price-stack">
                  {badgeClass ? (
                    <span className={`flat-price-pill ${badgeClass}`}>
                      {formatPrice(last, isSimulated)}
                    </span>
                  ) : (
                    <span className={`flat-price-val ${getPriceClass(last, prev)}`}>
                      {formatPrice(last, isSimulated)}
                    </span>
                  )}
                  <span className={`flat-oddlot-price ${getPriceClass(q?.oddLotLast, prev)}`} title="零股成交價">
                    <span className="flat-oddlot-prefix">零</span>{formatPrice(q?.oddLotLast)}
                  </span>
                </div>

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
                {/* 均線標籤：個股顯示，ETF與債券不用 */}
                {(() => {
                  const isEtfOrBond = item.code.startsWith('00') || ['ETF', 'BOND'].includes((item.securityType || q?.securityType || '').toUpperCase());
                  if (isEtfOrBond) return null;

                  const ind = indicators[item.code];
                  const currP = (q?.last && q.last > 0) ? q.last : ((prev && prev > 0) ? prev : null);

                  const ma5 = ind?.ma5;
                  const ma10 = ind?.ma10;
                  const ma20 = ind?.ma20;

                  const is5Up = (ma5 !== null && ma5 !== undefined && currP !== null) ? currP >= ma5 : null;
                  const is10Up = (ma10 !== null && ma10 !== undefined && currP !== null) ? currP >= ma10 : null;
                  const is20Up = (ma20 !== null && ma20 !== undefined && currP !== null) ? currP >= ma20 : null;

                  return (
                    <div className="ma-tag-group ma-tag-group-card">
                      <span
                        className={`ma-tag ${is5Up === true ? 'tag-up' : (is5Up === false ? 'tag-down' : 'tag-neutral')}`}
                        title={ma5 !== null && ma5 !== undefined ? `5MA: ${ma5.toFixed(2)}${currP !== null ? ` (現價 ${currP.toFixed(2)} ${is5Up ? '衝破/站上' : '跌破'})` : ''}` : '5MA 資料計算中'}
                      >
                        5MA
                      </span>
                      <span
                        className={`ma-tag ${is10Up === true ? 'tag-up' : (is10Up === false ? 'tag-down' : 'tag-neutral')}`}
                        title={ma10 !== null && ma10 !== undefined ? `10MA: ${ma10.toFixed(2)}${currP !== null ? ` (現價 ${currP.toFixed(2)} ${is10Up ? '衝破/站上' : '跌破'})` : ''}` : '10MA 資料計算中'}
                      >
                        10MA
                      </span>
                      <span
                        className={`ma-tag ${is20Up === true ? 'tag-up' : (is20Up === false ? 'tag-down' : 'tag-neutral')}`}
                        title={ma20 !== null && ma20 !== undefined ? `20MA: ${ma20.toFixed(2)}${currP !== null ? ` (現價 ${currP.toFixed(2)} ${is20Up ? '衝破/站上' : '跌破'})` : ''}` : '20MA 資料計算中'}
                      >
                        20MA
                      </span>
                    </div>
                  );
                })()}

                {/* 刪除按鈕 (非財神簿群組保留刪除鍵) */}
                {!isWealthGroup && (
                  <button
                    className="btn-flat-action btn-flat-delete"
                    onClick={() => onRemoveItem(item.code)}
                    title="刪除"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
