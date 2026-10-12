import React from 'react';
import type { StockPosition, QuoteState } from '../types';

interface VaultCardListProps {
  positions: StockPosition[];
  quotes: Record<string, QuoteState>;
  dirtyCodes: Set<string>;
}

export const VaultCardList: React.FC<VaultCardListProps> = ({
  positions,
  quotes,
  dirtyCodes,
}) => {
  // 依股票代號排序（與財神簿相同順序）
  const sortedPositions = [...positions].sort((a, b) => a.code.localeCompare(b.code));

  if (sortedPositions.length === 0) {
    return (
      <div className="card-list-empty">
        目前尚無庫存持股資料，系統將於永豐 API 連線後自動同步。
      </div>
    );
  }

  return (
    <div className="compact-card-list vault-card-list">
      {sortedPositions.map((pos) => {
        const q = quotes[pos.code];
        const currPrice = (q?.last !== null && q?.last !== undefined && q.last > 0) ? q.last : (pos.initialLast && pos.initialLast > 0 ? pos.initialLast : pos.costPrice);
        const cost = pos.costPrice * pos.quantity;
        const marketVal = currPrice * pos.quantity;
        const pnl = marketVal - cost;
        const roi = cost > 0 ? (pnl / cost) * 100 : 0;

        const pnlClass = pnl > 0 ? 'color-up' : pnl < 0 ? 'color-down' : 'color-neutral';
        const roiClass = roi > 0 ? 'color-up' : roi < 0 ? 'color-down' : 'color-neutral';
        const isDirty = dirtyCodes.has(pos.code);

        return (
          <div
            key={pos.code}
            className={`compact-card vault-card ${isDirty ? 'card-flash' : ''}`}
          >
            {/* 第一行：現股名稱 與 剩餘股數 */}
            <div className="card-row card-row-top">
              <div className="card-stock-info">
                {(() => {
                  const isOtc = ((pos.exchange || quotes[pos.code]?.exchange || '').toUpperCase() === 'OTC');
                  return (
                    <>
                      <span
                        className={`exchange-badge ${isOtc ? 'badge-otc' : 'badge-tse'}`}
                        title={isOtc ? '上櫃股票' : '上市股票'}
                      >
                        {isOtc ? '櫃' : '市'}
                      </span>
                      <span className="card-stock-name">{pos.name || pos.code}</span>
                      <span className={`card-stock-code ${isOtc ? 'code-otc' : 'code-tse'}`}>{pos.code}</span>
                    </>
                  );
                })()}
              </div>
              <div className="card-qty-badge">
                <span className="card-qty-label">剩餘股數：</span>
                <span className="card-qty-val">{Math.round(pos.quantity).toLocaleString()}</span>
                <span className="card-qty-unit"> 股</span>
              </div>
            </div>

            {/* 第二行：損益試算 與 報酬率 */}
            <div className="card-row card-row-bottom">
              <div className="card-pnl-col">
                <span className="card-pnl-label">損益試算：</span>
                <span className={`card-pnl-val ${pnlClass}`}>
                  {pnl > 0 ? '+' : ''}
                  {Math.round(pnl).toLocaleString()}
                  <span className="currency-unit"> 元</span>
                </span>
              </div>
              <div className="card-roi-col">
                <span className="card-roi-label">報酬率：</span>
                <span className={`card-roi-val ${roiClass}`}>
                  {roi > 0 ? '+' : ''}
                  {roi.toFixed(2)}%
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
export default VaultCardList;
