import React, { useState, useEffect } from 'react';
import type { AccountBalanceState } from '../types';
import { fetchAccountBalance, updateAccountCapital, adjustAccountCapital } from '../services/api';

interface BalanceTabProps {
  onRefreshNeeded?: () => void;
}

export const BalanceTab: React.FC<BalanceTabProps> = () => {
  const [balance, setBalance] = useState<AccountBalanceState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 本金輸入狀態
  const [inputCapital, setInputCapital] = useState<string>('');
  const [capitalMode, setCapitalMode] = useState<'before_t0' | 'after_t0'>('after_t0');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showLedger, setShowLedger] = useState(false);

  // 快捷加減本金 (若已設定過本金則直接寫入帳本流水)
  const adjustCapital = async (deltaWan: number) => {
    if (balance?.hasConfigured && !isEditing) {
      setIsSaving(true);
      try {
        await adjustAccountCapital(deltaWan);
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 1800);
        await loadBalance();
      } catch (err: any) {
        alert(`業外存提記帳失敗: ${err.message}`);
      } finally {
        setIsSaving(false);
      }
      return;
    }
    const cur = parseFloat(inputCapital) || 0;
    const next = Math.max(0, Math.round((cur + deltaWan) * 100) / 100);
    setInputCapital(next.toString());
    setIsEditing(true);
  };

  const formatDateTime = (isoStr?: string) => {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      return d.toLocaleString('zh-TW', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoStr;
    }
  };

  const loadBalance = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchAccountBalance();
      setBalance(data);
      if (!isEditing) {
        if (data.hasConfigured && data.baseCapitalWan !== null && data.baseCapitalWan !== undefined) {
          setInputCapital(data.baseCapitalWan.toString());
        } else {
          setInputCapital('');
        }
        setCapitalMode(data.capitalMode || 'after_t0');
      }
    } catch (err: any) {
      setError(err?.message || '讀取帳戶餘額資料失敗');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadBalance();
  }, []);

  const handleSaveCapital = async (e?: React.FormEvent, newMode?: 'before_t0' | 'after_t0') => {
    if (e) e.preventDefault();
    const val = parseFloat(inputCapital);
    if (isNaN(val) || val <= 0) {
      alert('請先在輸入框輸入大於 0 的投資本金金額（單位：萬元）');
      return;
    }
    const modeToSave = newMode !== undefined ? newMode : capitalMode;
    setIsSaving(true);
    try {
      await updateAccountCapital(val, modeToSave);
      setIsEditing(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
      await loadBalance();
    } catch (err: any) {
      alert(`儲存失敗: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  // 格式化交割款加減文字 (保留供擴充)
  void 0;

  return (
    <div className="balance-tab-container">
      {/* 頂部標題說明 */}
      <div className="balance-header">
        <div className="balance-title-group">
          <h3 className="balance-title">💰 財神口袋 · 資金推算</h3>
          <span className="balance-subtitle">T+2 在途交割即時挪移試算</span>
        </div>
        <button
          className="btn-refresh-balance"
          onClick={loadBalance}
          disabled={isLoading}
          title="重新整理交割款與餘額"
        >
          {isLoading ? '⟳ 試算中...' : '⟳ 重新整理'}
        </button>
      </div>

      {error && <div className="balance-error-banner">⚠️ {error}</div>}

      {/* 區塊 1：T+2 最終可投資餘額 */}
      <div className="balance-stages-grid">
        <div className="balance-grid-card stage-t2 highlight-target">
          <div className="grid-card-tag badge-final">最終可用</div>
          <div className="grid-card-title">
            <span>T+2 可投資餘額</span>
            <span className="grid-date">{balance?.t2Date || 'T+2 交割日'}</span>
          </div>
          <div className="grid-amount-row highlight-amount">
            <span className="grid-main-val">
              {balance && balance.hasConfigured && balance.t2RemainingWan !== null
                ? balance.t2RemainingWan.toFixed(2)
                : '--'}
            </span>
            <span className="grid-val-unit">萬</span>
          </div>
          {balance && balance.hasConfigured && (
            <div className={`pending-orders-box ${balance.pendingBuyAmountTwd > 0 ? 'has-pending' : ''}`}>
              <div className="pending-orders-summary">
                <span>⏳ 委託中買單凍結：</span>
                <span className="pending-freeze-val">
                  {balance.pendingBuyAmountTwd > 0 ? `-${balance.pendingBuyAmountWan.toFixed(2)} 萬` : '0.00 萬'}
                </span>
              </div>
              {balance.t2WithPendingRemainingWan !== null && balance.t2WithPendingRemainingWan !== undefined && (
                <div className="pending-orders-after">
                  若掛單全成交後可用：
                  <strong className={balance.t2WithPendingRemainingWan < 0 ? 'color-down' : 'color-up'}>
                    {balance.t2WithPendingRemainingWan.toFixed(2)} 萬
                  </strong>
                </div>
              )}
              {balance.pendingBuyDetails && balance.pendingBuyDetails.length > 0 && (
                <div className="pending-orders-pills">
                  {balance.pendingBuyDetails.map((pd, i) => (
                    <span
                      key={i}
                      className="pending-pill"
                      title={`${pd.name} (${pd.code}) 買進掛單 ${pd.qty}股 @ ${pd.price}元\n預估含手續費: ${Math.round(pd.estimatedCostTwd).toLocaleString()}元`}
                    >
                      {pd.name || pd.code} {pd.qty}股 (-{pd.estimatedCostWan.toFixed(2)}萬)
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 區塊 3：在途款項明細清單 */}
      <div className="balance-details-card">
        <div className="details-header-row">
          <h4 className="details-title" style={{ margin: 0 }}>📋 永豐證券在途交割款清單</h4>
          {balance && balance.hasConfigured && balance.t0RemainingWan !== null && balance.t2RemainingWan !== null && (
            <div className="cashflow-summary-strip">
              現有 <strong>{balance.t0RemainingWan.toFixed(2)}萬</strong>
              {' '}
              <span className={balance.t1Amount >= 0 ? 'color-up' : 'color-down'}>
                {balance.t1Amount >= 0 ? '+' : ''}{(balance.t1Amount / 10000).toFixed(2)}萬(T+1)
              </span>
              {' '}
              <span className={balance.t2Amount >= 0 ? 'color-up' : 'color-down'}>
                {balance.t2Amount >= 0 ? '+' : ''}{(balance.t2Amount / 10000).toFixed(2)}萬(T+2)
              </span>
              {' = '}
              <strong className={balance.t2RemainingWan < 0 ? 'color-down' : 'color-up'}>
                {balance.t2RemainingWan.toFixed(2)}萬
              </strong>
            </div>
          )}
        </div>
        <div className="settlements-table-wrap" style={{ marginTop: 10 }}>
          <table className="settlements-table">
            <thead>
              <tr>
                <th>時程</th>
                <th>預計交割日</th>
                <th>收付性質</th>
                <th>成交標的明細</th>
                <th className="align-right">交割款 (萬元)</th>
                <th className="align-right">台幣金額 (元)</th>
              </tr>
            </thead>
            <tbody>
              {balance?.settlements && balance.settlements.length > 0 ? (
                balance.settlements.map((s, idx) => {
                  const isPositive = s.amount > 0;
                  const isNegative = s.amount < 0;
                  const isT0AlreadySettled = s.t === 0 && balance.todaySettled;
                  return (
                    <tr
                      key={idx}
                      className={`row-stage-t${s.t} ${isT0AlreadySettled ? 'row-settled-muted' : ''}`}
                    >
                      <td>
                        <span className={`badge-t badge-t${s.t}`}>T+{s.t}</span>
                      </td>
                      <td className="settle-date">{s.date}</td>
                      <td>
                        {isT0AlreadySettled ? (
                          <span className="tag-settled-done" title="已計入現有本金，不影響後續餘額">
                            已結清 (不扣款)
                          </span>
                        ) : isNegative ? (
                          <span className="tag-pay">買入扣款 (付)</span>
                        ) : isPositive ? (
                          <span className="tag-receive">賣出入帳 (收)</span>
                        ) : (
                          <span className="tag-none">無收付</span>
                        )}
                      </td>
                      <td>
                        {s.details && s.details.length > 0 ? (
                          <div className="settle-itemized-list">
                            {s.details.map((d, dIdx) => {
                              const isSell = d.action === 'Sell';
                              return (
                                <div key={dIdx} className="settle-itemized-row">
                                  <span className={`settle-stock-tag ${isSell ? 'tag-stock-sell' : 'tag-stock-buy'}`}>
                                    {isSell ? '賣出' : '買入'}
                                  </span>
                                  <span className="itemized-name">
                                    {d.name || d.code} <small>({d.code})</small>
                                  </span>
                                  <span className="itemized-qty-price">
                                    {d.qty.toLocaleString()}股 × {d.price}
                                  </span>
                                  <span className="itemized-fees">
                                    費{d.fee}{d.tax > 0 ? ` / 稅${d.tax}` : ''}
                                  </span>
                                  <span className={`itemized-net num-font ${d.netAmount >= 0 ? 'color-up' : 'color-down'}`}>
                                    {d.netAmount >= 0 ? '+' : ''}{d.netAmountWan.toFixed(2)}萬 ({d.netAmount >= 0 ? '+' : ''}{Math.round(d.netAmount).toLocaleString()}元)
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        ) : s.stockSummary ? (
                          <span className="settle-stock-text">{s.stockSummary}</span>
                        ) : (
                          <span className="tag-none">-</span>
                        )}
                      </td>
                      <td className={`align-right num-font ${isNegative ? 'color-down' : isPositive ? 'color-up' : ''}`}>
                        {isPositive ? '+' : ''}{s.amountWan.toFixed(2)} 萬
                      </td>
                      <td className={`align-right num-font ${isNegative ? 'color-down' : isPositive ? 'color-up' : ''}`}>
                        {isPositive ? '+' : ''}{Math.round(s.amount).toLocaleString()} 元
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="table-empty">
                    目前無在途交割款項紀錄
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 區塊 4：口袋帳本異動流水紀錄 */}
      {balance?.ledger && balance.ledger.length > 0 && (
        <div className="balance-details-card ledger-card">
          <div
            className="ledger-header-toggle"
            onClick={() => setShowLedger(!showLedger)}
            role="button"
            tabIndex={0}
          >
            <h4 className="details-title" style={{ margin: 0 }}>
              📖 口袋資金流水帳（近 {balance.ledger.length} 筆）
            </h4>
            <span className="ledger-toggle-icon">{showLedger ? '▲ 收合' : '▼ 展開'}</span>
          </div>
          {showLedger && (
            <div className="settlements-table-wrap" style={{ marginTop: 10 }}>
              <table className="settlements-table ledger-table">
                <thead>
                  <tr>
                    <th>時間</th>
                    <th>類型</th>
                    <th>說明</th>
                    <th className="align-right">異動 (萬元)</th>
                    <th className="align-right">結餘 (萬元)</th>
                  </tr>
                </thead>
                <tbody>
                  {balance.ledger.map((entry) => {
                    const isInit = entry.eventType === 'INIT';
                    const isPos = entry.amountTwd > 0;
                    const typeLabel =
                      entry.eventType === 'INIT'
                        ? '設定校正'
                        : entry.eventType === 'DEPOSIT'
                          ? '業外存入'
                          : entry.eventType === 'WITHDRAW'
                            ? '生活領出'
                            : '交割結轉';
                    return (
                      <tr key={entry.id}>
                        <td className="settle-date">{formatDateTime(entry.createdAt)}</td>
                        <td>
                          <span className={`ledger-badge ledger-${entry.eventType.toLowerCase()}`}>
                            {typeLabel}
                          </span>
                        </td>
                        <td>
                          <div>{entry.note}</div>
                          {entry.details && entry.details.length > 0 && (
                            <div className="settle-itemized-list ledger-itemized-list">
                              {entry.details.map((d, dIdx) => {
                                const isSell = d.action === 'Sell';
                                return (
                                  <div key={dIdx} className="settle-itemized-row">
                                    <span className={`settle-stock-tag ${isSell ? 'tag-stock-sell' : 'tag-stock-buy'}`}>
                                      {isSell ? '賣出' : '買入'}
                                    </span>
                                    <span className="itemized-name">
                                      {d.name || d.code} <small>({d.code})</small>
                                    </span>
                                    <span className="itemized-qty-price">
                                      {d.qty.toLocaleString()}股 × {d.price}
                                    </span>
                                    <span className={`itemized-net num-font ${d.netAmount >= 0 ? 'color-up' : 'color-down'}`}>
                                      {d.netAmount >= 0 ? '+' : ''}{d.netAmountWan.toFixed(2)}萬 ({d.netAmount >= 0 ? '+' : ''}{Math.round(d.netAmount).toLocaleString()}元)
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </td>
                        <td className={`align-right num-font ${isInit ? '' : isPos ? 'color-up' : 'color-down'}`}>
                          {isInit ? `${entry.amountWan.toFixed(2)} 萬` : `${isPos ? '+' : ''}${entry.amountWan.toFixed(2)} 萬`}
                        </td>
                        <td className="align-right num-font">
                          <strong>{entry.balanceAfterWan.toFixed(2)} 萬</strong>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 區塊 4：手填帳戶本金與業外存提 (移至最下方) */}
      <div className="balance-capital-card">
        <div className="capital-card-header">
          <span className="capital-label">
            🏦 口袋已交割現金（自動結轉）
            {balance?.configuredAt && (
              <span className="capital-configured-at"> · 上次校正 {formatDateTime(balance.configuredAt)}</span>
            )}
          </span>
          <span className="capital-unit">單位：萬元 (NT$)</span>
        </div>

        {/* 模式選擇：T+0 扣款前 vs T+0 扣款後 */}
        <div className="capital-mode-selector">
          <span className="mode-selector-label">此本金為：</span>
          <div className="mode-pills">
            <button
              type="button"
              className={`btn-mode-pill ${capitalMode === 'after_t0' ? 'active' : ''}`}
              onClick={() => {
                setCapitalMode('after_t0');
                handleSaveCapital(undefined, 'after_t0');
              }}
              title="今天 (T+0) 早晨銀行已扣款/入帳後的現有本金（不再重複扣 T+0 款項）"
            >
              ✓ 今日 T+0 扣款後 (預設)
            </button>
            <button
              type="button"
              className={`btn-mode-pill ${capitalMode === 'before_t0' ? 'active' : ''}`}
              onClick={() => {
                setCapitalMode('before_t0');
                handleSaveCapital(undefined, 'before_t0');
              }}
              title="尚未扣除今天 (T+0) 交割款的原始本金（系統將主動扣除 T+0 款項）"
            >
              今日 T+0 扣款前
            </button>
          </div>
        </div>

        <form onSubmit={handleSaveCapital} className="capital-input-row">
          <div className="capital-input-wrap">
            <input
              type="text"
              inputMode="decimal"
              className="capital-input"
              value={inputCapital}
              onChange={(e) => {
                const val = e.target.value;
                if (/^[0-9]*\.?[0-9]*$/.test(val)) {
                  setInputCapital(val);
                  setIsEditing(true);
                }
              }}
              onFocus={(e) => {
                setIsEditing(true);
                e.target.select();
              }}
              placeholder="輸入本金 (如 100)"
              autoComplete="off"
            />
            <span className="capital-input-suffix">萬</span>
          </div>

          <button
            type="submit"
            className={`btn-save-capital ${saveSuccess ? 'btn-save-success' : ''}`}
            disabled={isSaving}
          >
            {isSaving ? '儲存中...' : saveSuccess ? '✓ 已記錄' : '💾 記錄本金'}
          </button>
        </form>

        {/* 業外收入 / 生活開銷快捷調整 */}
        <div className="capital-adjust-toolbar">
          <span className="adjust-tip">業外存提快捷（即時記帳）：</span>
          <div className="adjust-buttons">
            <button
              type="button"
              className="btn-adjust btn-adjust-sub"
              disabled={isSaving}
              onClick={() => adjustCapital(-10)}
              title="從口袋領出 10 萬作生活支出"
            >
              -10萬
            </button>
            <button
              type="button"
              className="btn-adjust btn-adjust-sub"
              disabled={isSaving}
              onClick={() => adjustCapital(-5)}
              title="從口袋領出 5 萬作生活支出"
            >
              -5萬
            </button>
            <button
              type="button"
              className="btn-adjust btn-adjust-add"
              disabled={isSaving}
              onClick={() => adjustCapital(5)}
              title="業外存入 5 萬至投資口袋"
            >
              +5萬
            </button>
            <button
              type="button"
              className="btn-adjust btn-adjust-add"
              disabled={isSaving}
              onClick={() => adjustCapital(10)}
              title="業外存入 10 萬至投資口袋"
            >
              +10萬
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
