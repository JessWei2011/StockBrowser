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
  onOpenOrder?: (code: string) => void;
  isReorderMode?: boolean;
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
  onOpenOrder,
  isReorderMode = false,
}) => {
  const formatPrice = (val: number | null | undefined, isSim?: boolean): React.ReactNode => {
    if (val === null || val === undefined || isNaN(val) || val <= 0) return '—';
    let text: string;
    if (val >= 1000 && val % 1 === 0) {
      text = Math.round(val).toLocaleString();
    } else {
      text = val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
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
    if (val >= 10000) {
      const w = val / 10000;
      return (w >= 100 ? w.toFixed(0) : w.toFixed(1)) + '萬';
    }
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

        let badgeClass = '';
        if (isLimitUp) {
          badgeClass = 'badge-limit-up';
          changeClass = 'color-up';
        } else if (isLimitDown) {
          badgeClass = 'badge-limit-down';
          changeClass = 'color-down';
        }

        // 3. 處置與注意標籤文字
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

        const isOtc = ((item.exchange || q?.exchange || '').toUpperCase() === 'OTC');
        const isEtfOrBond = item.code.startsWith('00') || ['ETF', 'BOND'].includes((item.securityType || q?.securityType || '').toUpperCase());

        const stockAnns = announcements[item.code] || [];
        const dispAnn = stockAnns.find((a) => a.category === 'disposition');
        const hasDisp = dispAnn || dispositionLevel > 0 || dispositionPeriod;
        const dispTitle = dispAnn ? `${dispAnn.title}\n${dispAnn.detail || ''}`.trim() : (dispositionPeriod ? `處置股票 (期間: ${dispositionPeriod})` : '處置股票');
        const dispLabel = dispAnn?.tag || dispText;

        const attAnn = stockAnns.find((a) => a.category === 'attention');
        const hasAtt = !hasDisp && (attAnn || isAttention);
        const attTitle = attAnn ? `${attAnn.title}\n${attAnn.detail || ''}`.trim() : '注意股票';

        return (
          <div
            key={item.id}
            className={`flat-stock-item ${isDimmed ? 'card-dimmed' : ''}`}
            onClick={!isEtfOrBond && onSelectStock ? () => onSelectStock(item.code) : undefined}
          >
            {/* 上半行：商品識別 (左) + 核心即時現價與漲跌 (右) */}
            <div className="flat-row-primary">
              <div className="flat-stock-id">
                <div className="flat-id-row">
                  <span className={`exchange-badge ${isOtc ? 'badge-otc' : 'badge-tse'}`} title={isOtc ? '上櫃股票' : '上市股票'}>
                    {isOtc ? '櫃' : '市'}
                  </span>
                  <span className={`flat-code ${isOtc ? 'code-otc' : 'code-tse'}`}>{item.code}</span>
                  <span className="flat-name" title={item.name || q?.name || ''}>
                    {item.name || q?.name || ''}
                  </span>
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
                </div>
              </div>

              <div className="flat-primary-right">
                <div className="flat-price-display">
                  <div className="flat-price-main-col">
                    {badgeClass ? (
                      <span className={`flat-price-pill ${badgeClass}`}>
                        {formatPrice(last, isSimulated)}
                      </span>
                    ) : (
                      <span className={`flat-price-val ${getPriceClass(last, prev)}`}>
                        {formatPrice(last, isSimulated)}
                      </span>
                    )}
                    <span className={`flat-chg-sub ${changeClass}`}>
                      {effectiveChg === null || isNaN(effectiveChg)
                        ? '— 0.00'
                        : effectiveChg > 0
                        ? `▲ ${effectiveChg.toFixed(2)}`
                        : effectiveChg < 0
                        ? `▼ ${Math.abs(effectiveChg).toFixed(2)}`
                        : '— 0.00'}
                    </span>
                  </div>

                  <div className={`flat-pct-badge ${changeClass}`}>
                    {effectivePct === null || isNaN(effectivePct)
                      ? '0.00%'
                      : effectivePct > 0
                      ? `+${effectivePct.toFixed(2)}%`
                      : `${effectivePct.toFixed(2)}%`}
                  </div>
                </div>
              </div>
            </div>

            {/* 第二行：精煉指標（量能、高低區間、均線/零股）+ 快速下單快捷鍵 */}
            <div className="flat-row-metrics-modern">
              <div className="flat-metric-item flat-metric-vol">
                <span className="flat-metric-lbl">量</span>
                <span className="flat-metric-val vol-val" title={q?.totalVolume ? `總成交量: ${q.totalVolume.toLocaleString()} 張` : undefined}>
                  {formatVolume(q?.totalVolume)}
                </span>
              </div>

              <div className="flat-metric-item flat-metric-range">
                <span className="flat-metric-lbl">高/低</span>
                <span className="flat-metric-val range-val">
                  <span className={getPriceClass(q?.high, prev)}>{formatPrice(q?.high)}</span>
                  <span className="range-sep">/</span>
                  <span className={getPriceClass(q?.low, prev)}>{formatPrice(q?.low)}</span>
                </span>
              </div>

              {/* 均線燈號（若為個股）或零股現價（若為 ETF/BOND） */}
              <div className="flat-metric-item flat-metric-extra">
                {!isEtfOrBond ? (() => {
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
                      <span className={`ma-tag ${is5Up === true ? 'tag-up' : (is5Up === false ? 'tag-down' : 'tag-neutral')}`} title="5MA">5M</span>
                      <span className={`ma-tag ${is10Up === true ? 'tag-up' : (is10Up === false ? 'tag-down' : 'tag-neutral')}`} title="10MA">10M</span>
                      <span className={`ma-tag ${is20Up === true ? 'tag-up' : (is20Up === false ? 'tag-down' : 'tag-neutral')}`} title="20MA">20M</span>
                    </div>
                  );
                })() : (
                  <span className="flat-oddlot-price" title="零股成交價">
                    <span className="flat-oddlot-prefix">零</span>
                    <span className={getPriceClass(q?.oddLotLast, prev)}>{formatPrice(q?.oddLotLast)}</span>
                  </span>
                )}
              </div>

              {/* 快速下單按鈕 (融入第二行右側，絕不搶佔第一行股票名稱空間) */}
              <button
                type="button"
                className="btn-order-shortcut-modern"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenOrder?.(item.code);
                }}
                title={`帶入「${item.name || item.code}」快速下單`}
              >
                <span>下單</span>
                <span className="order-shortcut-arrow">↗</span>
              </button>
            </div>

            {/* 排序與刪除控制列：僅在「排序整理模式」開啟時顯示 */}
            {isReorderMode && (
              <div className="flat-row-reorder-bar" onClick={(e) => e.stopPropagation()}>
                <span className="reorder-prompt">順序調整：</span>
                <div className="flat-actions">
                  <button
                    type="button"
                    className="btn-flat-action"
                    disabled={idx === 0}
                    onClick={() => onMoveItem(idx, 'up')}
                    title="上移"
                  >
                    ↑ 上移
                  </button>
                  <button
                    type="button"
                    className="btn-flat-action"
                    disabled={idx === items.length - 1}
                    onClick={() => onMoveItem(idx, 'down')}
                    title="下移"
                  >
                    ↓ 下移
                  </button>
                  {!isWealthGroup && (
                    <button
                      type="button"
                      className="btn-flat-action btn-flat-delete"
                      onClick={() => onRemoveItem(item.code)}
                      title="刪除商品"
                    >
                      ✕ 刪除
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
