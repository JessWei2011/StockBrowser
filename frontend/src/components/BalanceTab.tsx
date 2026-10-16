import React, { useState, useEffect } from 'react';
import type { AccountBalanceState } from '../types';
import { fetchAccountBalance, updateAccountCapital } from '../services/api';

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

  // 快捷加減本金 (以萬為單位)
  const adjustCapital = (deltaWan: number) => {
    const cur = parseFloat(inputCapital) || 0;
    const next = Math.max(0, Math.round((cur + deltaWan) * 100) / 100);
    setInputCapital(next.toString());
    setIsEditing(true);
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
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
      await loadBalance();
    } catch (err: any) {
      alert(`儲存失敗: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  // 格式化交割款加減文字
  const formatSettleDelta = (amtWan: number, amtRaw: number) => {
    if (amtRaw === 0) {
      return <span className="delta-zero">無交割款 (0元)</span>;
    }
    const isIncome = amtRaw > 0;
    const sign = isIncome ? '+' : '';
    return (
      <span className={isIncome ? 'delta-income' : 'delta-expense'}>
        {sign}{amtWan.toFixed(2)} 萬 ({sign}{Math.round(amtRaw).toLocaleString()} 元)
      </span>
    );
  };

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

      {/* 區塊 1：手填帳戶本金與業外存提 */}
      <div className="balance-capital-card">
        <div className="capital-card-header">
          <span className="capital-label">🏦 帳戶起始投資本金</span>
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
                // 只允許數字與小數點
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
          <span className="adjust-tip">業外存提快捷：</span>
          <div className="adjust-buttons">
            <button
              type="button"
              className="btn-adjust btn-adjust-sub"
              onClick={() => {
                adjustCapital(-10);
                setIsEditing(true);
              }}
              title="生活支出領出 10 萬"
            >
              -10萬
            </button>
            <button
              type="button"
              className="btn-adjust btn-adjust-sub"
              onClick={() => {
                adjustCapital(-5);
                setIsEditing(true);
              }}
              title="生活支出領出 5 萬"
            >
              -5萬
            </button>
            <button
              type="button"
              className="btn-adjust btn-adjust-add"
              onClick={() => {
                adjustCapital(5);
                setIsEditing(true);
              }}
              title="業外存入 5 萬"
            >
              +5萬
            </button>
            <button
              type="button"
              className="btn-adjust btn-adjust-add"
              onClick={() => {
                adjustCapital(10);
                setIsEditing(true);
              }}
              title="業外存入 10 萬"
            >
              +10萬
            </button>
          </div>
        </div>
      </div>

      {/* 區塊 2：三大階段餘額格子 (格子1: T+0, 格子2: T+1, 格子3: T+2) */}
      <div className="balance-stages-grid">
        {/* 格子 1: T+0 今日交割後 */}
        <div className="balance-grid-card stage-t0">
          <div className="grid-card-tag">格子 1 · 今日</div>
          <div className="grid-card-title">
            <span>T+0 交割餘額</span>
            <span className="grid-date">{balance?.t0Date || '今日'}</span>
          </div>
          <div className="grid-amount-row">
            <span className="grid-main-val">
              {balance && balance.hasConfigured && balance.t0RemainingWan !== null
                ? balance.t0RemainingWan.toFixed(2)
                : '--'}
            </span>
            <span className="grid-val-unit">萬</span>
          </div>
          <div className="grid-delta-row">
            <span className="grid-delta-label">今日交割：</span>
            {balance ? (
              capitalMode === 'after_t0' ? (
                <span className="delta-applied" title="您填入的本金已是扣款後數字，不再重複扣抵">
                  (已計入本金 · 交割款 {balance.t0Amount >= 0 ? '+' : ''}{(balance.t0Amount / 10000).toFixed(2)}萬)
                </span>
              ) : (
                formatSettleDelta(balance.t0Amount / 10000, balance.t0Amount)
              )
            ) : '--'}
          </div>
        </div>

        {/* 格子 2: T+1 明日交割後 */}
        <div className="balance-grid-card stage-t1">
          <div className="grid-card-tag">格子 2 · 明日</div>
          <div className="grid-card-title">
            <span>T+1 交割剩餘</span>
            <span className="grid-date">{balance?.t1Date || '次營業日'}</span>
          </div>
          <div className="grid-amount-row">
            <span className="grid-main-val">
              {balance && balance.hasConfigured && balance.t1RemainingWan !== null
                ? balance.t1RemainingWan.toFixed(2)
                : '--'}
            </span>
            <span className="grid-val-unit">萬</span>
          </div>
          <div className="grid-delta-row">
            <span className="grid-delta-label">次日交割：</span>
            {balance ? formatSettleDelta(balance.t1Amount / 10000, balance.t1Amount) : '--'}
          </div>
        </div>

        {/* 格子 3: T+2 後天交割後 (最終可用本金) */}
        <div className="balance-grid-card stage-t2 highlight-target">
          <div className="grid-card-tag badge-final">格子 3 · 最終可用</div>
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
          <div className="grid-delta-row t2-delta-formula-row">
            <span className="grid-delta-label">今日買賣算式：</span>
            {balance && balance.t2Details && balance.t2Details.length > 0 ? (
              <div className="t2-formula-container">
                <div className="t2-formula-pills">
                  {balance.t2Details.map((td, idx) => {
                    const isIncome = td.netAmount >= 0;
                    return (
                      <span
                        key={idx}
                        className={`t2-formula-item ${isIncome ? 'formula-plus' : 'formula-minus'}`}
                        title={`${td.name} (${td.code}) ${td.action === 'Sell' ? '賣出' : '買入'} ${td.qty}股 @ ${td.price}元\n總值: ${td.totalPrice} | 手續費: ${td.fee} | 稅: ${td.tax}\n淨額: ${td.netAmount} 元`}
                      >
                        <span className="formula-op">{isIncome ? '+' : '-'}</span>
                        <span className="formula-val">{Math.abs(td.netAmountWan).toFixed(2)}萬</span>
                        <span className="formula-name">({td.name || td.code})</span>
                      </span>
                    );
                  })}
                  <span className="t2-formula-equal">=</span>
                  <span className={`t2-formula-total ${balance.t2Amount >= 0 ? 'color-up' : 'color-down'}`}>
                    {balance.t2Amount >= 0 ? '+' : ''}{(balance.t2Amount / 10000).toFixed(2)}萬 ({balance.t2Amount >= 0 ? '+' : ''}{Math.round(balance.t2Amount).toLocaleString()}元)
                  </span>
                </div>
              </div>
            ) : balance ? (
              formatSettleDelta(balance.t2Amount / 10000, balance.t2Amount)
            ) : '--'}
          </div>
          <div className="grid-card-footnote">
            ★ 已預先扣除 T+2 即將發生的交割款，此為收盤後實質剩餘本金
          </div>
        </div>
      </div>

      {/* 區塊 3：在途款項明細清單 */}
      <div className="balance-details-card">
        <h4 className="details-title">📋 永豐證券在途交割款清單</h4>
        <div className="settlements-table-wrap">
          <table className="settlements-table">
            <thead>
              <tr>
                <th>時程</th>
                <th>預計交割日</th>
                <th>收付性質</th>
                <th className="align-right">交割款 (萬元)</th>
                <th className="align-right">台幣金額 (元)</th>
              </tr>
            </thead>
            <tbody>
              {balance?.settlements && balance.settlements.length > 0 ? (
                balance.settlements.map((s, idx) => {
                  const isPositive = s.amount > 0;
                  const isNegative = s.amount < 0;
                  return (
                    <tr key={idx}>
                      <td>
                        <span className={`badge-t badge-t${s.t}`}>T+{s.t}</span>
                      </td>
                      <td className="settle-date">{s.date}</td>
                      <td>
                        {isNegative ? (
                          <span className="tag-pay">買入扣款 (付)</span>
                        ) : isPositive ? (
                          <span className="tag-receive">賣出入帳 (收)</span>
                        ) : (
                          <span className="tag-none">無收付</span>
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
                  <td colSpan={5} className="table-empty">
                    目前無在途交割款項紀錄
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
