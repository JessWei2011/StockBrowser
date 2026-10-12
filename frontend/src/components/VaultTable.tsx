import React from 'react';
import type { StockPosition, QuoteState } from '../types';

interface VaultTableProps {
  positions: StockPosition[];
  quotes: Record<string, QuoteState>;
  dirtyCodes: Set<string>;
}

export const VaultTable: React.FC<VaultTableProps> = ({
  positions,
  quotes,
  dirtyCodes,
}) => {
  // 依股票代號排序（與財神簿相同順序）
  const sortedPositions = [...positions].sort((a, b) => a.code.localeCompare(b.code));

  // 計算整體彙總
  let totalShares = 0;
  let totalCost = 0;
  let totalMarketVal = 0;

  for (const pos of sortedPositions) {
    const q = quotes[pos.code];
    const currPrice = (q?.last !== null && q?.last !== undefined) ? q.last : (pos.initialLast ?? pos.costPrice);
    totalShares += pos.quantity;
    totalCost += pos.costPrice * pos.quantity;
    totalMarketVal += currPrice * pos.quantity;
  }

  const totalPnl = totalMarketVal - totalCost;
  const totalRoi = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

  return (
    <div className="table-responsive-wrapper">
      <table className="quote-table vault-table">
        <thead>
          <tr>
            <th className="th-vault-stock">現股名稱</th>
            <th className="th-vault-qty">剩餘股數</th>
            <th className="th-vault-pnl">損益試算</th>
            <th className="th-vault-roi">報酬率</th>
          </tr>
        </thead>
        <tbody>
          {sortedPositions.length === 0 ? (
            <tr>
              <td colSpan={4} className="empty-message">
                目前尚無庫存持股資料，系統將於永豐 API 連線後自動同步。
              </td>
            </tr>
          ) : (
            sortedPositions.map((pos) => {
              const q = quotes[pos.code];
              const currPrice = (q?.last !== null && q?.last !== undefined && q.last > 0) ? q.last : (pos.initialLast && pos.initialLast > 0 ? pos.initialLast : pos.costPrice);
              const cost = pos.costPrice * pos.quantity;
              const marketVal = currPrice * pos.quantity;
              const pnl = marketVal - cost;
              const roi = cost > 0 ? (pnl / cost) * 100 : 0;

              // 損益紅漲綠跌顏色 (台股慣例：正紅、負綠、平中性)
              const pnlClass = pnl > 0 ? 'color-up' : pnl < 0 ? 'color-down' : 'color-neutral';
              const roiClass = roi > 0 ? 'color-up' : roi < 0 ? 'color-down' : 'color-neutral';
              const isDirty = dirtyCodes.has(pos.code);

              return (
                <tr key={pos.code} className={`vault-row ${isDirty ? 'row-flash' : ''}`}>
                  <td className="cell-vault-stock">
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
                          <span className="stock-name">{pos.name || pos.code}</span>
                          <span className={`stock-code ${isOtc ? 'code-otc' : 'code-tse'}`}>{pos.code}</span>
                        </>
                      );
                    })()}
                  </td>
                  <td className="cell-vault-qty">
                    <span className="qty-val">{Math.round(pos.quantity).toLocaleString()}</span>
                    <span className="qty-unit"> 股</span>
                  </td>
                  <td className={`cell-vault-pnl ${pnlClass}`}>
                    {pnl > 0 ? '+' : ''}
                    {Math.round(pnl).toLocaleString()}
                    <span className="currency-unit"> 元</span>
                  </td>
                  <td className={`cell-vault-roi ${roiClass}`}>
                    {roi > 0 ? '+' : ''}
                    {roi.toFixed(2)}%
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
        {sortedPositions.length > 0 && (
          <tfoot>
            <tr className="vault-summary-footer">
              <td className="cell-vault-stock">
                <span className="summary-label">合計 ({sortedPositions.length} 檔持股)</span>
              </td>
              <td className="cell-vault-qty">
                {Math.round(totalShares).toLocaleString()}
                <span className="qty-unit"> 股</span>
              </td>
              <td className={`cell-vault-pnl ${totalPnl > 0 ? 'color-up' : totalPnl < 0 ? 'color-down' : 'color-neutral'}`}>
                {totalPnl > 0 ? '+' : ''}
                {Math.round(totalPnl).toLocaleString()}
                <span className="currency-unit"> 元</span>
              </td>
              <td className={`cell-vault-roi ${totalRoi > 0 ? 'color-up' : totalRoi < 0 ? 'color-down' : 'color-neutral'}`}>
                {totalRoi > 0 ? '+' : ''}
                {totalRoi.toFixed(2)}%
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
};
export default VaultTable;
