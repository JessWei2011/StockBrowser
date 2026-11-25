import React, { useEffect } from 'react';
import type { OrderDealNotification, SmartOrderTriggeredNotification } from '../types';

export interface DealToastItem extends OrderDealNotification {
  id: string;
}

export interface SmartToastItem extends SmartOrderTriggeredNotification {
  id: string;
}

interface DealToastContainerProps {
  toasts: DealToastItem[];
  onDismiss: (id: string) => void;
  smartToasts?: SmartToastItem[];
  onDismissSmartToast?: (id: string) => void;
  onClickSmartToast?: (toast: SmartToastItem) => void;
}

export const DealToastContainer: React.FC<DealToastContainerProps> = ({
  toasts,
  onDismiss,
  smartToasts = [],
  onDismissSmartToast,
  onClickSmartToast,
}) => {
  if (toasts.length === 0 && smartToasts.length === 0) return null;

  return (
    <div className="deal-toast-container" aria-live="polite">
      {smartToasts.map((toast) => (
        <SmartAlertToastCard
          key={toast.id}
          toast={toast}
          onDismiss={onDismissSmartToast}
          onClick={onClickSmartToast}
        />
      ))}
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

interface SmartAlertToastCardProps {
  toast: SmartToastItem;
  onDismiss?: (id: string) => void;
  onClick?: (toast: SmartToastItem) => void;
}

const SmartAlertToastCard: React.FC<SmartAlertToastCardProps> = ({ toast, onDismiss, onClick }) => {
  // 智慧預約單警報需手動點擊 × 才關閉（不設自動消失定時器）
  return (
    <div
      className="deal-toast-card deal-smart-alert"
      role="alert"
      onClick={() => onClick?.(toast)}
      title={`點擊帶入「${toast.name} (${toast.code})」快速下單`}
    >
      {/* 第一行：[智慧警報] 股名 (代號) + 時間 + 手動關閉 × */}
      <div className="deal-toast-row1">
        <div className="deal-toast-title-group">
          <span className="deal-action-badge smart-alert-badge">智慧警報</span>
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
              onDismiss?.(toast.id);
            }}
            title="關閉通知"
          >
            ×
          </button>
        </div>
      </div>

      {/* 第二行：觸發條件原因 + 點擊下單提示 */}
      <div className="deal-toast-row2">
        <span className="smart-alert-reason">{toast.triggerReason}</span>
        <span className="deal-status-tag smart-order-action-tag">下單 ↗</span>
      </div>
    </div>
  );
};
