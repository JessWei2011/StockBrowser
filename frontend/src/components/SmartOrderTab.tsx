import React, { useState, useEffect } from 'react';
import type { StockPosition, QuoteState, SmartOrderCondition } from '../types';
import { fetchSmartOrders, createSmartOrder, cancelSmartOrder, resumeSmartOrder, deleteSmartOrder } from '../services/api';

interface SmartOrderTabProps {
  positions: StockPosition[];
  quotes: Record<string, QuoteState>;
  initialCode?: string;
}

export const SmartOrderTab: React.FC<SmartOrderTabProps> = ({
  positions,
  quotes,
  initialCode,
}) => {
  // 1. 股號與預填零股庫存
  const [stockCode, setStockCode] = useState(initialCode || (positions[0]?.code || '2330'));
  const [quantity, setQuantity] = useState<number>(() => {
    const pos = positions.find((p) => p.code === (initialCode || positions[0]?.code));
    return pos ? Math.min(999, Math.round(pos.quantity)) : 100;
  });

  // 取得基準價（昨收或現價，用於雙向換算 % 與 元）
  const currentQuote = quotes[stockCode];
  const currentPos = positions.find((p) => p.code === stockCode);
  const basePrice = (currentQuote?.previousClose && currentQuote.previousClose > 0)
    ? currentQuote.previousClose
    : ((currentQuote?.last && currentQuote.last > 0) ? currentQuote.last : 100);

  // 選項 1: 現價高於 N% 或 M 元
  const [opt1Enabled, setOpt1Enabled] = useState(false);
  const [opt1Pct, setOpt1Pct] = useState<string>('5.0');
  const [opt1Price, setOpt1Price] = useState<string>('');

  // 選項 2: 現價低於 N% 或 M 元
  const [opt2Enabled, setOpt2Enabled] = useState(false);
  const [opt2Pct, setOpt2Pct] = useState<string>('-3.0');
  const [opt2Price, setOpt2Price] = useState<string>('');

  // 選項 3: 現價高於 N% 或 M 元，啟動高點獲利條件判斷，衝高回落 X% 發出通知
  const [opt3Enabled, setOpt3Enabled] = useState(false);
  const [opt3Pct, setOpt3Pct] = useState<string>('6.0');
  const [opt3Price, setOpt3Price] = useState<string>('');
  const [opt3TrailingPct, setOpt3TrailingPct] = useState<string>('0.5');

  // 選項 4: 現價跌破均線（5MA、10MA、20MA）發出通知
  const [opt4Enabled, setOpt4Enabled] = useState(false);
  const [opt4MaType, setOpt4MaType] = useState<'5MA' | '10MA' | '20MA'>('5MA');

  // 清單與送出狀態
  const [smartOrders, setSmartOrders] = useState<SmartOrderCondition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  // 當股票切換或基準價更新時，預設填入換算金額
  useEffect(() => {
    if (initialCode) {
      setStockCode(initialCode);
      const pos = positions.find((p) => p.code === initialCode);
      if (pos && pos.quantity > 0) {
        setQuantity(Math.min(999, Math.round(pos.quantity)));
      }
    }
  }, [initialCode, positions]);

  // 當選定商品或基準價更新時，若價格未手動調整過，自動計算雙向對應價格
  useEffect(() => {
    if (basePrice > 0) {
      // opt1: +5%
      const p1 = basePrice * (1 + (parseFloat(opt1Pct) || 5) / 100);
      setOpt1Price(p1.toFixed(2));
      // opt2: -3%
      const p2 = basePrice * (1 + (parseFloat(opt2Pct) || -3) / 100);
      setOpt2Price(p2.toFixed(2));
      // opt3: +6%
      const p3 = basePrice * (1 + (parseFloat(opt3Pct) || 6) / 100);
      setOpt3Price(p3.toFixed(2));
    }
  }, [stockCode, basePrice]);

  // 雙向連動處理：輸入 % 自動算元；輸入元自動算 %
  const handleOpt1PctChange = (val: string) => {
    setOpt1Pct(val);
    const num = parseFloat(val);
    if (!isNaN(num) && basePrice > 0) {
      setOpt1Price((basePrice * (1 + num / 100)).toFixed(2));
    }
  };
  const handleOpt1PriceChange = (val: string) => {
    setOpt1Price(val);
    const num = parseFloat(val);
    if (!isNaN(num) && basePrice > 0) {
      setOpt1Pct((((num - basePrice) / basePrice) * 100).toFixed(2));
    }
  };

  const handleOpt2PctChange = (val: string) => {
    setOpt2Pct(val);
    const num = parseFloat(val);
    if (!isNaN(num) && basePrice > 0) {
      setOpt2Price((basePrice * (1 + num / 100)).toFixed(2));
    }
  };
  const handleOpt2PriceChange = (val: string) => {
    setOpt2Price(val);
    const num = parseFloat(val);
    if (!isNaN(num) && basePrice > 0) {
      setOpt2Pct((((num - basePrice) / basePrice) * 100).toFixed(2));
    }
  };

  const handleOpt3PctChange = (val: string) => {
    setOpt3Pct(val);
    const num = parseFloat(val);
    if (!isNaN(num) && basePrice > 0) {
      setOpt3Price((basePrice * (1 + num / 100)).toFixed(2));
    }
  };
  const handleOpt3PriceChange = (val: string) => {
    setOpt3Price(val);
    const num = parseFloat(val);
    if (!isNaN(num) && basePrice > 0) {
      setOpt3Pct((((num - basePrice) / basePrice) * 100).toFixed(2));
    }
  };

  const loadSmartOrders = async () => {
    try {
      setIsLoading(true);
      const data = await fetchSmartOrders();
      setSmartOrders(data);
    } catch (err: any) {
      console.error('Failed to load smart orders:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSmartOrders();
  }, []);

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = stockCode.trim().toUpperCase();
    if (!cleanCode) {
      setMessage({ type: 'error', text: '請輸入有效的股票代碼' });
      return;
    }

    if (!opt1Enabled && !opt2Enabled && !opt3Enabled && !opt4Enabled) {
      setMessage({ type: 'error', text: '請至少開啟一個通知選項（4個選項目前皆關閉）' });
      return;
    }

    // 前端選項級防呆：檢查該個股是否已經開啟過相同選項
    const activeOrdersForStock = smartOrders.filter(
      (o) => o.code === cleanCode && o.status === 'PENDING'
    );
    for (const o of activeOrdersForStock) {
      if (opt1Enabled && o.opt1_enabled) {
        setMessage({ type: 'error', text: `【${cleanCode}】已開啟過「選項 1（現價高於）」盯盤中！同選項不可重複建立。` });
        return;
      }
      if (opt2Enabled && o.opt2_enabled) {
        setMessage({ type: 'error', text: `【${cleanCode}】已開啟過「選項 2（現價低於）」盯盤中！同選項不可重複建立。` });
        return;
      }
      if (opt3Enabled && o.opt3_enabled) {
        setMessage({ type: 'error', text: `【${cleanCode}】已開啟過「選項 3（衝高回落）」盯盤中！同選項不可重複建立。` });
        return;
      }
      if (opt4Enabled && o.opt4_enabled) {
        setMessage({ type: 'error', text: `【${cleanCode}】已開啟過「選項 4（跌破均線）」盯盤中！同選項不可重複建立。` });
        return;
      }
    }

    try {
      setIsSubmitting(true);
      setMessage(null);
      await createSmartOrder({
        code: cleanCode,
        quantity: quantity || 100,
        opt1_enabled: opt1Enabled,
        opt1_pct: opt1Enabled ? parseFloat(opt1Pct) : null,
        opt1_price: opt1Enabled ? parseFloat(opt1Price) : null,
        opt2_enabled: opt2Enabled,
        opt2_pct: opt2Enabled ? parseFloat(opt2Pct) : null,
        opt2_price: opt2Enabled ? parseFloat(opt2Price) : null,
        opt3_enabled: opt3Enabled,
        opt3_pct: opt3Enabled ? parseFloat(opt3Pct) : null,
        opt3_price: opt3Enabled ? parseFloat(opt3Price) : null,
        opt3_trailing_pct: opt3Enabled ? parseFloat(opt3TrailingPct) : null,
        opt4_enabled: opt4Enabled,
        opt4_ma_type: opt4Enabled ? opt4MaType : null,
      });

      setMessage({
        type: 'success',
        text: `已成功儲存【${cleanCode}】出場警報通知設定！明日 09:00 開盤即啟動盯盤，任一條件符合時即發送 Discord 通知。`,
      });
      await loadSmartOrders();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || '儲存失敗' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    try {
      await cancelSmartOrder(orderId);
      await loadSmartOrders();
      setMessage({ type: 'info', text: '已暫停該警報通知（可隨時點擊「恢復盯盤」重新啟動）' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || '暫停失敗' });
    }
  };

  const handleResumeOrder = async (orderId: string) => {
    try {
      await resumeSmartOrder(orderId);
      await loadSmartOrders();
      setMessage({ type: 'success', text: '已成功恢復「09:00 盯盤中」狀態！' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || '恢復失敗' });
    }
  };

  const handleDeleteOrder = async (orderId: string) => {
    try {
      await deleteSmartOrder(orderId);
      await loadSmartOrders();
      setMessage({ type: 'info', text: '已移除該警報設定' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || '刪除失敗' });
    }
  };

  return (
    <div className="smart-order-container">
      {message && (
        <div className={`smart-order-alert alert-${message.type}`}>
          <span>{message.text}</span>
          <button type="button" className="btn-alert-close" onClick={() => setMessage(null)}>✕</button>
        </div>
      )}

      <form className="smart-order-form" onSubmit={handleCreateOrder}>
        {/* 標的商品與預填零股庫存 */}
        <div className="smart-card-section">
          <div className="smart-inputs-row">
            <div className="input-group flex-1">
              <label>股號</label>
              <input
                type="text"
                className="form-input"
                placeholder="例如: 2330"
                value={stockCode}
                onChange={(e) => setStockCode(e.target.value.toUpperCase())}
              />
              {currentQuote && (
                <span className="input-hint">
                  {currentQuote.name}（昨收/現價: ${basePrice.toFixed(2)}）
                </span>
              )}
            </div>

            <div className="input-group flex-1">
              <label>預填現有零股庫存 (股)</label>
              <div className="input-with-action">
                <input
                  type="number"
                  className="form-input"
                  min="1"
                  max="999"
                  value={quantity}
                  onChange={(e) => setQuantity(parseInt(e.target.value, 10) || 0)}
                />
                {currentPos && (
                  <button
                    type="button"
                    className="btn-fill-holding"
                    title="帶入庫存"
                    onClick={() => setQuantity(Math.min(999, Math.round(currentPos.quantity)))}
                  >
                    帶入庫存
                  </button>
                )}
              </div>
              {currentPos && (
                <span className="input-hint">現有持股: {Math.round(currentPos.quantity).toLocaleString()} 股</span>
              )}
            </div>
          </div>
        </div>

        {/* 選項 1: 現價高於 N% 或 M 元 */}
        <div className={`smart-card-section option-card ${opt1Enabled ? 'is-active border-up' : ''}`}>
          <div className="section-title-bar">
            <div className="opt-title-wrap">
              <span className="opt-badge badge-opt1">選項 1</span>
              <span className="step-title">現價高於 N% 或 M 元 發出通知</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={opt1Enabled}
                onChange={(e) => setOpt1Enabled(e.target.checked)}
              />
              <span className="slider round"></span>
            </label>
          </div>

          {opt1Enabled && (
            <div className="option-content-body">
              <div className="smart-grid-2">
                <div className="input-group">
                  <label>高於漲幅（N%）</label>
                  <div className="input-with-unit">
                    <input
                      type="number"
                      step="0.1"
                      className="form-input"
                      value={opt1Pct}
                      onChange={(e) => handleOpt1PctChange(e.target.value)}
                    />
                    <span className="unit-suffix">%</span>
                  </div>
                </div>
                <div className="input-group">
                  <label>對應金額（M 元）</label>
                  <div className="input-with-unit">
                    <span className="unit-prefix">$</span>
                    <input
                      type="number"
                      step="0.01"
                      className="form-input"
                      value={opt1Price}
                      onChange={(e) => handleOpt1PriceChange(e.target.value)}
                    />
                    <span className="unit-suffix">元</span>
                  </div>
                </div>
              </div>
              <span className="input-hint">💡 兩欄即時自動換算，達到此門檻立即向 Discord 發出高價通知。</span>
            </div>
          )}
        </div>

        {/* 選項 2: 現價低於 N% 或 M 元 */}
        <div className={`smart-card-section option-card ${opt2Enabled ? 'is-active border-down' : ''}`}>
          <div className="section-title-bar">
            <div className="opt-title-wrap">
              <span className="opt-badge badge-opt2">選項 2</span>
              <span className="step-title">現價低於 N% 或 M 元 發出通知</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={opt2Enabled}
                onChange={(e) => setOpt2Enabled(e.target.checked)}
              />
              <span className="slider round"></span>
            </label>
          </div>

          {opt2Enabled && (
            <div className="option-content-body">
              <div className="smart-grid-2">
                <div className="input-group">
                  <label>低於跌幅（N%）</label>
                  <div className="input-with-unit">
                    <input
                      type="number"
                      step="0.1"
                      className="form-input"
                      value={opt2Pct}
                      onChange={(e) => handleOpt2PctChange(e.target.value)}
                    />
                    <span className="unit-suffix">%</span>
                  </div>
                </div>
                <div className="input-group">
                  <label>對應金額（M 元）</label>
                  <div className="input-with-unit">
                    <span className="unit-prefix">$</span>
                    <input
                      type="number"
                      step="0.01"
                      className="form-input"
                      value={opt2Price}
                      onChange={(e) => handleOpt2PriceChange(e.target.value)}
                    />
                    <span className="unit-suffix">元</span>
                  </div>
                </div>
              </div>
              <span className="input-hint">💡 用於下檔停損或關鍵防守價跌破時發出通知。</span>
            </div>
          )}
        </div>

        {/* 選項 3: 現價高於 N% 或 M 元，啟動高點獲利條件判斷，衝高回落 X% 發出通知 */}
        <div className={`smart-card-section option-card ${opt3Enabled ? 'is-active border-trailing' : ''}`}>
          <div className="section-title-bar">
            <div className="opt-title-wrap">
              <span className="opt-badge badge-opt3">選項 3</span>
              <span className="step-title">高於門檻啟動高點獲利判斷，衝高回落 X% 發出通知</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={opt3Enabled}
                onChange={(e) => setOpt3Enabled(e.target.checked)}
              />
              <span className="slider round"></span>
            </label>
          </div>

          {opt3Enabled && (
            <div className="option-content-body">
              <div className="smart-grid-3">
                <div className="input-group">
                  <label>啟動漲幅（N%）</label>
                  <div className="input-with-unit">
                    <input
                      type="number"
                      step="0.1"
                      className="form-input"
                      value={opt3Pct}
                      onChange={(e) => handleOpt3PctChange(e.target.value)}
                    />
                    <span className="unit-suffix">%</span>
                  </div>
                </div>
                <div className="input-group">
                  <label>啟動金額（M 元）</label>
                  <div className="input-with-unit">
                    <span className="unit-prefix">$</span>
                    <input
                      type="number"
                      step="0.01"
                      className="form-input"
                      value={opt3Price}
                      onChange={(e) => handleOpt3PriceChange(e.target.value)}
                    />
                    <span className="unit-suffix">元</span>
                  </div>
                </div>
                <div className="input-group">
                  <label>衝高回落（X%）</label>
                  <div className="input-with-unit">
                    <input
                      type="number"
                      step="0.1"
                      className="form-input"
                      placeholder="0.5"
                      value={opt3TrailingPct}
                      onChange={(e) => setOpt3TrailingPct(e.target.value)}
                    />
                    <span className="unit-suffix">%</span>
                  </div>
                </div>
              </div>
              <span className="input-hint">💡 突破啟動門檻後持續記錄當日最高價，一旦自最高點回檔 X% 立即提醒獲利出場。</span>
            </div>
          )}
        </div>

        {/* 選項 4: 現價跌破均線（5MA、10MA、20MA）發出通知 */}
        <div className={`smart-card-section option-card ${opt4Enabled ? 'is-active border-ma' : ''}`}>
          <div className="section-title-bar">
            <div className="opt-title-wrap">
              <span className="opt-badge badge-opt4">選項 4</span>
              <span className="step-title">現價跌破均線（5MA、10MA、20MA）發出通知</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={opt4Enabled}
                onChange={(e) => setOpt4Enabled(e.target.checked)}
              />
              <span className="slider round"></span>
            </label>
          </div>

          {opt4Enabled && (
            <div className="option-content-body">
              <div className="input-group">
                <label>選擇防守均線</label>
                <div className="pill-toggle-group">
                  {(['5MA', '10MA', '20MA'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`pill-toggle ${opt4MaType === m ? 'active' : ''}`}
                      onClick={() => setOpt4MaType(m)}
                    >
                      {opt4MaType === m && '✓ '}
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <span className="input-hint">💡 盤中動態均線跌破時，第一時間發送 Discord 警報。</span>
            </div>
          )}
        </div>

        {/* 提交按鈕 */}
        <div className="smart-form-actions">
          <button
            type="submit"
            className="btn-submit-smart-order"
            disabled={isSubmitting}
          >
            {isSubmitting ? '儲存中...' : '🔔 儲存出場警報設定'}
          </button>
        </div>
      </form>

      {/* 監控中警報列表 */}
      <div className="smart-orders-list-section">
        <div className="list-header">
          <div className="list-title-wrap">
            <span className="list-icon">📋</span>
            <span className="list-title">已設定出場警報列表</span>
            <span className="orders-count-pill">{smartOrders.length} 檔</span>
          </div>
          <button
            type="button"
            className="btn-refresh-smart-orders"
            onClick={loadSmartOrders}
            disabled={isLoading}
          >
            {isLoading ? '⟳ 更新中...' : '⟳ 整理'}
          </button>
        </div>

        {smartOrders.length === 0 ? (
          <div className="smart-orders-empty">
            <span className="empty-icon">📭</span>
            <p>目前尚無設定出場警報，歡迎開啟上方選項建立通知！</p>
          </div>
        ) : (
          <div className="smart-orders-cards">
            {smartOrders.map((order) => {
              const isPending = order.status === 'PENDING';
              const isTriggered = order.status === 'TRIGGERED';

              return (
                <div key={order.id} className={`smart-order-card status-${order.status.toLowerCase()}`}>
                  <div className="card-top-row">
                    <div className="card-stock-info">
                      <span className="card-stock-code">{order.code}</span>
                      <span className="card-stock-name">{order.name || order.code}</span>
                      <span className="card-qty-badge">{order.quantity} 股</span>
                    </div>
                    <div className="card-status-badge">
                      {isPending && <span className="badge-pending">👀 09:00 盯盤中</span>}
                      {isTriggered && <span className="badge-triggered">🚨 已發送通知</span>}
                      {order.status === 'CANCELLED' && <span className="badge-cancelled">✕ 已暫停</span>}
                    </div>
                  </div>

                  <div className="card-conditions-summary">
                    {order.opt1_enabled && (
                      <div className="cond-item">
                        <span className="cond-label">選項1 (高於):</span>
                        <span className="cond-val text-up">+{order.opt1_pct}% (${order.opt1_price})</span>
                      </div>
                    )}
                    {order.opt2_enabled && (
                      <div className="cond-item">
                        <span className="cond-label">選項2 (低於):</span>
                        <span className="cond-val text-down">{order.opt2_pct}% (${order.opt2_price})</span>
                      </div>
                    )}
                    {order.opt3_enabled && (
                      <div className="cond-item">
                        <span className="cond-label">選項3 (衝高回落):</span>
                        <span className="cond-val text-trailing">
                          &gt;+{order.opt3_pct}% 回落 -{order.opt3_trailing_pct}%
                        </span>
                      </div>
                    )}
                    {order.opt4_enabled && (
                      <div className="cond-item">
                        <span className="cond-label">選項4 (跌破均線):</span>
                        <span className="cond-val text-ma">破 {order.opt4_ma_type}</span>
                      </div>
                    )}
                  </div>

                  {order.trigger_reason && (
                    <div className="card-trigger-reason">
                      📢 最近通知原因: <strong>{order.trigger_reason}</strong>
                    </div>
                  )}

                  <div className="card-footer-row">
                    <span className="card-time">設定於: {order.created_at.slice(5, 16)}</span>
                    <div className="card-actions">
                      {isPending ? (
                        <button
                          type="button"
                          className="btn-cancel-cond"
                          onClick={() => handleCancelOrder(order.id)}
                          title="暫停盯盤通知"
                        >
                          暫停盯盤
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-resume-cond"
                          onClick={() => handleResumeOrder(order.id)}
                          title="重新啟動 09:00 盯盤通知"
                        >
                          ▶ 恢復盯盤
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-delete-cond"
                        onClick={() => handleDeleteOrder(order.id)}
                        title="徹底刪除此筆警報設定"
                      >
                        刪除
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
