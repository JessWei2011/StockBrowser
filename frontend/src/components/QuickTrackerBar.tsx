import React from 'react';
import type { QuoteState } from '../types';

export interface QuickTrackedStock {
  code: string;
  name: string;
  exchange?: string;
}

interface QuickTrackerBarProps {
  trackedStocks: QuickTrackedStock[];
  quotes: Record<string, QuoteState>;
  toastMessage?: string | null;
  onDismissToast?: () => void;
  onRemoveTrack: (code: string) => void;
  onOpenOrder: (code: string) => void;
}

export const QuickTrackerBar: React.FC<QuickTrackerBarProps> = ({
  trackedStocks,
  quotes,
  toastMessage,
  onDismissToast,
  onRemoveTrack,
  onOpenOrder,
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

  const getPriceClass = (val: number | null | undefined, prev: number | null | undefined): string => {
    if (val === null || val === undefined || isNaN(val) || val <= 0 || prev === null || prev === undefined || isNaN(prev) || prev <= 0) {
      return 'color-neutral';
    }
    if (val > prev) return 'color-up';
    if (val < prev) return 'color-down';
    return 'color-neutral';
  };

  // 永遠顯示固定 8 個快速追蹤槽位 (1~8 號，靠左對齊)
  const slots = Array.from({ length: 8 }, (_, i) => trackedStocks[i] || null);

  return (
    <div className="quick-tracker-wrapper">
      <div className="quick-tracker-container">
        <div className="quick-tracker-slots">
          {slots.map((item, idx) => {
            const slotNum = idx + 1;

            if (!item) {
              return (
                <div key={`empty-slot-${slotNum}`} className="quick-tracker-slot slot-empty" title="點擊個股旁的紅色三角驚嘆號 ⚠️ 加入追蹤">
                  <div className="slot-empty-content">
                    <span className="slot-badge slot-badge-empty">{slotNum}</span>
                    <span className="slot-empty-text">待追蹤</span>
                  </div>
                </div>
              );
            }

            const q = quotes[item.code];
            const prev = q?.previousClose && q.previousClose > 0 ? q.previousClose : null;
            const last = q?.last && q.last > 0 ? q.last : null;
            const oddLot = q?.oddLotLast && q.oddLotLast > 0 ? q.oddLotLast : null;
            const chg = last !== null && prev !== null ? (q?.change ?? (last - prev)) : null;
            const pct = last !== null && prev !== null ? (q?.changePercent ?? (chg !== null ? (chg / prev) * 100 : null)) : null;

            let changeClass = 'color-neutral';
            if (chg !== null && !isNaN(chg)) {
              if (chg > 0) changeClass = 'color-up';
              else if (chg < 0) changeClass = 'color-down';
            }

            const displayName = item.name || q?.name || item.code;

            return (
              <div
                key={item.code}
                className="quick-tracker-slot slot-active"
                onClick={() => onOpenOrder(item.code)}
                title={`點擊「${item.code} ${displayName}」快速開啟下單`}
              >
                {/* 頂部：序號、代號、股名、移除鍵 */}
                <div className="slot-top-row">
                  <div className="slot-id-wrap">
                    <span className="slot-badge slot-badge-active">{slotNum}</span>
                    <span className="slot-code">{item.code}</span>
                    <span className="slot-name" title={displayName}>{displayName}</span>
                  </div>
                  <button
                    type="button"
                    className="slot-btn-remove"
                    title="從快速追蹤區移除"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveTrack(item.code);
                    }}
                  >
                    ×
                  </button>
                </div>

                {/* 底部：成交價、零股價、漲跌幅 */}
                <div className="slot-bottom-row">
                  <div className="slot-price-data">
                    <div className="slot-price-item">
                      <span className="slot-label">現價</span>
                      <span className={`slot-val ${getPriceClass(last, prev)}`}>
                        {formatPrice(last, q?.isSimulated)}
                      </span>
                    </div>

                    <div className="slot-price-item">
                      <span className="slot-label">零股</span>
                      <span className={`slot-val ${getPriceClass(oddLot, prev)}`}>
                        {formatPrice(oddLot)}
                      </span>
                    </div>

                    <div className="slot-price-item">
                      <span className="slot-label">幅</span>
                      <span className={`slot-val ${changeClass}`}>
                        {pct === null || isNaN(pct)
                          ? '—'
                          : pct > 0
                          ? `+${pct.toFixed(2)}%`
                          : `${pct.toFixed(2)}%`}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* 滿額提示 Toast */}
        {toastMessage && (
          <div className="quick-tracker-toast" role="alert" onClick={onDismissToast}>
            <span className="quick-tracker-toast-icon">⚠️</span>
            <span className="quick-tracker-toast-text">{toastMessage}</span>
            <button
              type="button"
              className="quick-tracker-toast-close"
              onClick={(e) => {
                e.stopPropagation();
                onDismissToast?.();
              }}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
