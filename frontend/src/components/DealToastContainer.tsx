import React, { useEffect } from 'react';
import type { OrderDealNotification } from '../types';

export interface DealToastItem extends OrderDealNotification {
  id: string;
}

interface DealToastContainerProps {
  toasts: DealToastItem[];
  onDismiss: (id: string) => void;
}

export const DealToastContainer: React.FC<DealToastContainerProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="deal-toast-container" aria-live="polite">
      {toasts.map((toast) => (
        <DealToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
};

interface DealToastCardProps {
  toast: DealToastItem;
  onDismiss: (id: string) => void;
}

const DealToastCard: React.FC<DealToastCardProps> = ({ toast, onDismiss }) => {
  useEffect(() => {
    // 成交通知維持 15 秒自動關閉
    const timer = window.setTimeout(() => {
      onDismiss(toast.id);
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const isBuy = toast.action === 'Buy';

  return (
    <div
      className={`deal-toast-card ${isBuy ? 'deal-buy' : 'deal-sell'}`}
      role="alert"
      onClick={() => onDismiss(toast.id)}
      title="點擊關閉成交通知"
    >
      {/* 第一行：買進/賣出 標的名稱 (代號) 與 右側時間+關閉鈕 */}
      <div className="deal-toast-row1">
        <div className="deal-toast-title-group">
          <span className="deal-action-badge">{isBuy ? '買進' : '賣出'}</span>
          <strong className="deal-stock-title">{toast.name}</strong>
          <span className="deal-stock-code">({toast.code})</span>
        </div>
        <div className="deal-toast-meta">
          <span className="deal-toast-time">{toast.time}</span>
          <button
            type="button"
            className="deal-toast-close"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(toast.id);
            }}
            title="關閉"
          >
            ×
          </button>
        </div>
      </div>

      {/* 第二行：--- 1 股 @ $90.6 --- 成交 */}
      <div className="deal-toast-row2">
        <span className="deal-divider">---</span>
        <strong className="deal-qty">
          {toast.quantity.toLocaleString()} {toast.unit}
        </strong>
        <span className="deal-at">@</span>
        <strong className="deal-price">
          ${toast.price.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}
        </strong>
        <span className="deal-divider">---</span>
        <span className="deal-status-tag">成交</span>
      </div>
    </div>
  );
};
