import React, { useState, useMemo } from 'react';
import type { StockPosition, QuoteState, WealthSummary } from '../types';
import './VaultDetailView.css';

interface VaultDetailViewProps {
  positions: StockPosition[];
  quotes: Record<string, QuoteState>;
  wealthSummary?: WealthSummary | null;
  dirtyCodes?: Set<string>;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onRefresh?: () => Promise<void> | void;
  onOpenChart?: (code: string) => void;
}

type SortKey = 'code' | 'last' | 'costPrice' | 'cost' | 'marketVal' | 'pnl' | 'roi';

// 計算台股扣除證交稅與賣出手續費後之真實淨損益與報酬率
function calcPositionMetrics(
  code: string,
  currPrice: number,
  qty: number,
  costPrice: number,
  initialLast?: number,
  initialPnl?: number
): { pnl: number; roi: number; netMarketVal: number } {
  const cost = costPrice * qty;
  if (
    initialPnl !== undefined &&
    initialLast !== undefined &&
    initialLast > 0 &&
    Math.abs(currPrice - initialLast) < 0.0001
  ) {
    const pnl = initialPnl;
    const roi = cost > 0 ? (pnl / cost) * 100 : 0;
    return { pnl, roi, netMarketVal: cost + pnl };
  }

  const grossMv = currPrice * qty;
  let taxRate = 0.003;
  if (code.includes('B')) {
    taxRate = 0;
  } else if (code.startsWith('00')) {
    taxRate = 0.001;
  }
  const tax = Math.floor(grossMv * taxRate);
  const fee = Math.max(1, Math.floor(grossMv * 0.001425));
  const netMarketVal = grossMv - tax - fee;
  const pnl = netMarketVal - cost;
  const roi = cost > 0 ? (pnl / cost) * 100 : 0;
  return { pnl, roi, netMarketVal };
}

export const VaultDetailView: React.FC<VaultDetailViewProps> = ({
  positions,
  quotes,
  dirtyCodes,
  theme,
  onToggleTheme,
  onRefresh,
  onOpenChart,
}) => {
  const [sortKey, setSortKey] = useState<SortKey>('pnl');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 整理每一筆持股之即時數值
  const detailedPositions = useMemo(() => {
    return positions.map((pos) => {
      const q = quotes[pos.code];
      const currPrice =
        q?.last !== null && q?.last !== undefined && q.last > 0
          ? q.last
          : pos.initialLast && pos.initialLast > 0
          ? pos.initialLast
          : pos.costPrice;

      const ydQty = pos.ydQuantity ?? pos.quantity;
      const todayQty = pos.quantity;
      const cost = Math.round(pos.costPrice * todayQty);
      const marketVal = Math.round(currPrice * todayQty);
      const { pnl, roi } = calcPositionMetrics(
        pos.code,
        currPrice,
        todayQty,
        pos.costPrice,
        pos.initialLast,
        pos.initialPnl
      );

      return {
        ...pos,
        currPrice,
        ydQty,
        todayQty,
        cost,
        marketVal,
        pnl: Math.round(pnl),
        roi: Number(roi.toFixed(2)),
        isDirty: dirtyCodes?.has(pos.code) || false,
        exchange: pos.exchange || q?.exchange || 'TSE',
      };
    });
  }, [positions, quotes, dirtyCodes]);

  // 篩選與排序
  const filteredPositions = useMemo(() => {
    let result = detailedPositions;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toUpperCase();
      result = result.filter((p) => p.code.includes(q) || p.name.toUpperCase().includes(q));
    }

    return [...result].sort((a, b) => {
      let valA: any;
      let valB: any;

      switch (sortKey) {
        case 'code':
          valA = a.code;
          valB = b.code;
          break;
        case 'last':
          valA = a.currPrice;
          valB = b.currPrice;
          break;
        case 'costPrice':
          valA = a.costPrice;
          valB = b.costPrice;
          break;
        case 'cost':
          valA = a.cost;
          valB = b.cost;
          break;
        case 'marketVal':
          valA = a.marketVal;
          valB = b.marketVal;
          break;
        case 'pnl':
          valA = a.pnl;
          valB = b.pnl;
          break;
        case 'roi':
          valA = a.roi;
          valB = b.roi;
          break;
        default:
          valA = a.pnl;
          valB = b.pnl;
      }

      if (typeof valA === 'string') {
        return sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return sortDirection === 'asc' ? valA - valB : valB - valA;
    });
  }, [detailedPositions, searchQuery, sortKey, sortDirection]);

  // 計算合計
  const totals = useMemo(() => {
    let totalCost = 0;
    let totalPnl = 0;
    let totalMarketVal = 0;

    for (const p of detailedPositions) {
      totalCost += p.cost;
      totalPnl += p.pnl;
      totalMarketVal += p.marketVal;
    }

    const totalRoi = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    return {
      totalCost,
      totalPnl,
      totalRoi,
      totalMarketVal,
      count: detailedPositions.length,
    };
  }, [detailedPositions]);

  const handleHeaderClick = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('desc');
    }
  };

  const handleManualRefresh = async () => {
    if (!onRefresh) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setTimeout(() => setIsRefreshing(false), 500);
    }
  };

  const getSortIndicator = (key: SortKey) => {
    if (sortKey !== key) return <span className="sort-icon-neutral">⬍</span>;
    return <span className="sort-icon-active">{sortDirection === 'asc' ? '▲' : '▼'}</span>;
  };

  const getPnlClass = (val: number) => {
    if (val > 0) return 'text-up';
    if (val < 0) return 'text-down';
    return 'text-neutral';
  };

  return (
    <div className="vault-detail-page" data-theme={theme}>
      {/* 頂部功能與摘要導覽列 */}
      <header className="vault-detail-header">
        <div className="vault-header-left">
          <div className="vault-header-title-group">
            <span className="vault-header-icon">🏦</span>
            <div className="vault-header-title-text">
              <h1 className="vault-header-title">證券庫存損益試算表</h1>
              <span className="vault-header-subtitle">永豐金證券即時連線同步</span>
            </div>
          </div>

          {/* 總結算膠囊區 */}
          <div className="vault-summary-capsules">
            <div className="summary-capsule">
              <span className="capsule-label">付出總成本</span>
              <span className="capsule-value">{totals.totalCost.toLocaleString()} 元</span>
            </div>
            <div className="summary-capsule">
              <span className="capsule-label">目前總市值</span>
              <span className="capsule-value">{totals.totalMarketVal.toLocaleString()} 元</span>
            </div>
            <div className="summary-capsule">
              <span className="capsule-label">未實現總損益</span>
              <span className={`capsule-value ${getPnlClass(totals.totalPnl)}`}>
                {totals.totalPnl > 0 ? '+' : ''}
                {totals.totalPnl.toLocaleString()} 元
              </span>
            </div>
            <div className="summary-capsule">
              <span className="capsule-label">總報酬率</span>
              <span className={`capsule-value ${getPnlClass(totals.totalRoi)}`}>
                {totals.totalRoi > 0 ? '+' : ''}
                {totals.totalRoi.toFixed(2)}%
              </span>
            </div>
          </div>
        </div>

        <div className="vault-header-right">
          {/* 搜尋過濾 */}
          <div className="vault-search-box">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              placeholder="搜尋代號或名稱..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="vault-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="btn-search-clear"
                onClick={() => setSearchQuery('')}
              >
                ✕
              </button>
            )}
          </div>

          {/* 重新整理按鈕 */}
          <button
            type="button"
            className={`btn-vault-action ${isRefreshing ? 'refreshing' : ''}`}
            onClick={handleManualRefresh}
            title="手動重新整理永豐帳戶庫存"
          >
            <span className="action-icon">🔄</span>
            <span className="action-text">重新整理</span>
          </button>

          {/* 主題切換按鈕 */}
          <button
            type="button"
            className="btn-vault-action btn-icon-only"
            onClick={onToggleTheme}
            title={theme === 'dark' ? '切換為明亮主題' : '切換為深色主題'}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>

          {/* 關閉獨立分頁按鈕 */}
          <button
            type="button"
            className="btn-vault-action btn-close-tab"
            onClick={() => window.close()}
            title="關閉此分頁"
          >
            ✕ 關閉
          </button>
        </div>
      </header>

      {/* 主體表格區 */}
      <main className="vault-detail-content">
        <div className="vault-table-container">
          <table className="vault-table">
            <thead>
              <tr>
                <th
                  className="col-product sortable"
                  onClick={() => handleHeaderClick('code')}
                >
                  <div className="th-content">
                    <span>商品</span>
                    {getSortIndicator('code')}
                  </div>
                </th>
                <th
                  className="col-num sortable"
                  onClick={() => handleHeaderClick('last')}
                >
                  <div className="th-content th-right">
                    <span>現價</span>
                    {getSortIndicator('last')}
                  </div>
                </th>
                <th
                  className="col-num sortable"
                  onClick={() => handleHeaderClick('costPrice')}
                >
                  <div className="th-content th-right">
                    <span>成本均價</span>
                    {getSortIndicator('costPrice')}
                  </div>
                </th>
                <th
                  className="col-num sortable"
                  onClick={() => handleHeaderClick('cost')}
                >
                  <div className="th-content th-right">
                    <span>付出成本</span>
                    {getSortIndicator('cost')}
                  </div>
                </th>
                <th
                  className="col-num sortable"
                  onClick={() => handleHeaderClick('marketVal')}
                >
                  <div className="th-content th-right">
                    <span>今日價值</span>
                    {getSortIndicator('marketVal')}
                  </div>
                </th>
                <th
                  className="col-num sortable"
                  onClick={() => handleHeaderClick('pnl')}
                >
                  <div className="th-content th-right">
                    <span>損益試算</span>
                    {getSortIndicator('pnl')}
                  </div>
                </th>
                <th
                  className="col-num sortable"
                  onClick={() => handleHeaderClick('roi')}
                >
                  <div className="th-content th-right">
                    <span>報酬率</span>
                    {getSortIndicator('roi')}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredPositions.length === 0 ? (
                <tr>
                  <td colSpan={7} className="vault-empty-cell">
                    {searchQuery ? '無相符之持股標的' : '尚無持股資料，系統連線中...'}
                  </td>
                </tr>
              ) : (
                filteredPositions.map((pos) => {
                  return (
                    <tr
                      key={pos.code}
                      className="vault-row"
                      onClick={() => onOpenChart && onOpenChart(pos.code)}
                      title="點擊查看個股走勢與技術分析"
                    >
                      <td className="col-product">
                        <div className="product-cell-wrapper">
                          <span className="product-code">{pos.code}</span>
                          <span className="product-name">{pos.name}</span>
                          {pos.exchange === 'OTC' && (
                            <span className="market-badge otc-badge">櫃</span>
                          )}
                        </div>
                      </td>
                      <td className="col-num col-last-price">
                        <span className={`price-value ${getPnlClass(pos.currPrice - pos.costPrice)}`}>
                          {pos.currPrice.toFixed(2)}
                        </span>
                      </td>
                      <td className="col-num col-cost-price">
                        {pos.costPrice.toFixed(2)}
                      </td>
                      <td className="col-num col-cost">
                        {pos.cost.toLocaleString()}
                      </td>
                      <td className="col-num col-market-val">
                        <strong>{pos.marketVal.toLocaleString()}</strong>
                      </td>
                      <td className="col-num col-pnl">
                        <span className={`pnl-value ${getPnlClass(pos.pnl)}`}>
                          {pos.pnl > 0 ? '+' : ''}
                          {pos.pnl.toLocaleString()}
                        </span>
                      </td>
                      <td className="col-num col-roi">
                        <span className={`roi-value ${getPnlClass(pos.roi)}`}>
                          {pos.roi > 0 ? '+' : ''}
                          {pos.roi.toFixed(2)}%
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {/* 合計列 */}
            {detailedPositions.length > 0 && (
              <tfoot>
                <tr className="vault-total-row">
                  <td className="col-product">
                    <span className="total-title">合計（共 {totals.count} 檔）</span>
                  </td>
                  <td className="col-num col-last-price">-</td>
                  <td className="col-num col-cost-price">-</td>
                  <td className="col-num col-cost">
                    <strong>{totals.totalCost.toLocaleString()}</strong>
                  </td>
                  <td className="col-num col-market-val">
                    <strong>{totals.totalMarketVal.toLocaleString()}</strong>
                  </td>
                  <td className="col-num col-pnl">
                    <strong className={`total-pnl-val ${getPnlClass(totals.totalPnl)}`}>
                      {totals.totalPnl > 0 ? '+' : ''}
                      {totals.totalPnl.toLocaleString()}
                    </strong>
                  </td>
                  <td className="col-num col-roi">
                    <strong className={`total-roi-val ${getPnlClass(totals.totalRoi)}`}>
                      {totals.totalRoi > 0 ? '+' : ''}
                      {totals.totalRoi.toFixed(2)}%
                    </strong>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </main>
    </div>
  );
};
