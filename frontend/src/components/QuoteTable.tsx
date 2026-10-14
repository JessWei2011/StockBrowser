import React, { useState } from 'react';
import type { QuoteState, WatchlistItem, StockAnnouncement, StockMaSummary } from '../types';

interface QuoteTableProps {
  items: WatchlistItem[];
  isWealthGroup?: boolean;
  quotes: Record<string, QuoteState>;
  announcements?: Record<string, StockAnnouncement[]>;
  indicators?: Record<string, StockMaSummary>;
  dirtyCodes: Set<string>;
  onRemoveItem: (code: string) => Promise<void>;
  onMoveItem: (index: number, direction: 'up' | 'down') => Promise<void>;
  onReorderItems: (fromIndex: number, toIndex: number) => Promise<void>;
  onSelectStock?: (code: string) => void;
}

export const QuoteTable: React.FC<QuoteTableProps> = ({
  items,
  isWealthGroup,
  quotes,
  announcements = {},
  indicators = {},
  onRemoveItem,
  onMoveItem,
  onReorderItems,
  onSelectStock,
}) => {
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

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

  const formatVolume = (val: number | null | undefined): string => {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return val.toLocaleString();
  };

  const getPriceClass = (val: number | null | undefined, prev: number | null | undefined): string => {
    if (val === null || val === undefined || isNaN(val) || val <= 0 || prev === null || prev === undefined || isNaN(prev) || prev <= 0) return 'color-neutral';
    if (val > prev) return 'color-up';
    if (val < prev) return 'color-down';
    return 'color-neutral';
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIdx(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${index}`);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIdx !== index) {
      setDragOverIdx(index);
    }
  };

  const handleDragEnd = () => {
    setDraggedIdx(null);
    setDragOverIdx(null);
  };

  const handleDrop = async (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === dropIndex) {
      handleDragEnd();
      return;
    }
    const from = draggedIdx;
    handleDragEnd();
    await onReorderItems(from, dropIndex);
  };

  return (
    <div className="table-responsive-wrapper">
      <table className="quote-table">
        <thead>
          <tr>
            <th className="th-reorder">排序</th>
            <th className="th-sticky-stock">商品</th>
            <th>成交價</th>
            <th>零股價</th>
            <th>漲跌</th>
            <th>漲跌幅</th>
            <th>最高</th>
            <th>最低</th>
            <th>總量</th>
            <th>昨收</th>
            <th>開盤價</th>
            <th className="th-action">{isWealthGroup ? '均線' : '均線 / 刪除'}</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={12} className="empty-message">
                目前群組沒有商品，請由上方搜尋並新增個股。
              </td>
            </tr>
          ) : (
            items.map((item, idx) => {
              const q = quotes[item.code];
              const prev = (q?.previousClose && q.previousClose > 0) ? q.previousClose : null;
              const last = (q?.last && q.last > 0) ? q.last : null;
              const chg = (last !== null && prev !== null) ? (q?.change ?? (last - prev)) : null;
              const pct = (last !== null && prev !== null) ? (q?.changePercent ?? (chg !== null ? (chg / prev) * 100 : null)) : null;

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

              // 3. 樣式與徽章判定
              let badgeClass = '';
              if (isLimitUp) {
                badgeClass = 'badge-limit-up';
                changeClass = 'color-up'; // 漲停必定為紅
              } else if (isLimitDown) {
                badgeClass = 'badge-limit-down';
                changeClass = 'color-down'; // 跌停必定為綠
              }

              const isDragging = draggedIdx === idx;
              const isDropTarget = dragOverIdx === idx;

              const isSimulated = q?.isSimulated ?? false;
              const isAttention = q?.isAttention ?? false;
              const dispositionLevel = q?.dispositionLevel ?? 0;
              const dispositionPeriod = q?.dispositionPeriod ?? null;
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

              return (
                <tr
                  key={item.id}
                  className={`quote-row ${isDimmed ? 'row-dimmed' : ''} ${isDragging ? 'row-dragging' : ''} ${
                    isDropTarget ? 'row-drop-target' : ''
                  }`}
                  draggable
                  onDragStart={(e) => handleDragStart(e, idx)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDragEnd={handleDragEnd}
                  onDrop={(e) => handleDrop(e, idx)}
                >
                  {/* 拖曳握把與上下移動按鈕 */}
                  <td className="td-reorder" title="可拖曳整列，或點擊上下箭頭改變排序">
                    <div className="reorder-controls">
                      <span className="drag-handle" title="拖曳排序">⠿</span>
                      <button
                        className="btn-order-arrow"
                        title="上移"
                        disabled={idx === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          onMoveItem(idx, 'up');
                        }}
                      >
                        ↑
                      </button>
                      <button
                        className="btn-order-arrow"
                        title="下移"
                        disabled={idx === items.length - 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          onMoveItem(idx, 'down');
                        }}
                      >
                        ↓
                      </button>
                    </div>
                  </td>

                  {/* Sticky 商品代號與名稱 */}
                  <td className="td-sticky-stock">
                    {(() => {
                      const isOtc = ((item.exchange || q?.exchange || '').toUpperCase() === 'OTC');
                      const isEtfOrBond = item.code.startsWith('00') || ['ETF', 'BOND'].includes((item.securityType || q?.securityType || '').toUpperCase());
                      return (
                        <span
                          className={isEtfOrBond ? 'stock-plain' : 'stock-clickable'}
                          onClick={!isEtfOrBond && onSelectStock ? () => onSelectStock(item.code) : undefined}
                          title={!isEtfOrBond ? '點擊開啟個股動態技術走勢圖 (K線/均線/布林/籌碼/大戶)' : undefined}
                        >
                          <span
                            className={`exchange-badge ${isOtc ? 'badge-otc' : 'badge-tse'}`}
                            title={isOtc ? '上櫃股票' : '上市股票'}
                          >
                            {isOtc ? '櫃' : '市'}
                          </span>
                          <span className={`stock-code ${isOtc ? 'code-otc' : 'code-tse'}`}>{item.code}</span>
                          <span className="stock-name">{item.name || q?.name || ''}</span>
                        </span>
                      );
                    })()}
                    {(() => {
                      const stockAnns = announcements[item.code] || [];
                      // 1. 處置標籤
                      const dispAnn = stockAnns.find((a) => a.category === 'disposition');
                      const hasDisp = dispAnn || dispositionLevel > 0 || dispositionPeriod;
                      const dispTitle = dispAnn ? `${dispAnn.title}\n${dispAnn.detail || ''}`.trim() : (dispositionPeriod ? `處置股票 (期間: ${dispositionPeriod})` : '處置股票');
                      const dispLabel = dispAnn?.tag || dispText;

                      // 2. 注意標籤
                      const attAnn = stockAnns.find((a) => a.category === 'attention');
                      const hasAtt = !hasDisp && (attAnn || isAttention);
                      const attTitle = attAnn ? `${attAnn.title}\n${attAnn.detail || ''}`.trim() : '注意股票';

                      // 3. 財報/法說標籤
                      const earnAnn = stockAnns.find((a) => a.category === 'earnings');

                      // 4. 重大訊息標籤
                      const newsAnn = stockAnns.find((a) => a.category === 'news');

                      // 5. 除權除息標籤
                      const exdivAnn = stockAnns.find((a) => a.category === 'exdividend');

                      // 6. 最新自結營收標籤
                      const revAnn = stockAnns.find((a) => a.category === 'revenue');

                      return (
                        <>
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
                          {revAnn && (
                            <span className="stock-badge badge-revenue" title={`${revAnn.title}\n${revAnn.detail || ''}`.trim()}>
                              [{revAnn.tag}]
                            </span>
                          )}
                          {earnAnn && (
                            <span className="stock-badge badge-earnings" title={`${earnAnn.title}\n${earnAnn.detail || ''}`.trim()}>
                              [{earnAnn.tag}]
                            </span>
                          )}
                          {newsAnn && (
                            <span className="stock-badge badge-news" title={`${newsAnn.title}\n${newsAnn.detail || ''}`.trim()}>
                              [{newsAnn.tag}]
                            </span>
                          )}
                          {exdivAnn && (
                            <span className="stock-badge badge-exdiv" title={`${exdivAnn.title}\n${exdivAnn.detail || ''}`.trim()}>
                              [{exdivAnn.tag}]
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </td>

                  {/* 成交價 */}
                  <td className="td-num">
                    {badgeClass ? (
                      <span className={`cell-badge ${badgeClass}`}>{formatPrice(last, isSimulated)}</span>
                    ) : (
                      <span className={getPriceClass(last, prev)}>{formatPrice(last, isSimulated)}</span>
                    )}
                  </td>

                  {/* 零股價 */}
                  <td className="td-num" title="盤中零股最新撮合成交價">
                    <span className={getPriceClass(q?.oddLotLast, prev)}>
                      {formatPrice(q?.oddLotLast)}
                    </span>
                  </td>

                  {/* 漲跌 */}
                  <td className="td-num">
                    <span className={changeClass}>
                      {effectiveChg === null || isNaN(effectiveChg)
                        ? '—'
                        : effectiveChg > 0
                        ? `▲ ${effectiveChg.toFixed(2)}`
                        : effectiveChg < 0
                        ? `▼ ${Math.abs(effectiveChg).toFixed(2)}`
                        : `— 0.00`}
                    </span>
                  </td>

                  {/* 漲跌幅 */}
                  <td className="td-num">
                    <span className={changeClass}>
                      {effectivePct === null || isNaN(effectivePct)
                        ? '—'
                        : effectivePct > 0
                        ? `▲ ${effectivePct.toFixed(2)} %`
                        : effectivePct < 0
                        ? `▼ ${Math.abs(effectivePct).toFixed(2)} %`
                        : `0.00 %`}
                    </span>
                  </td>

                  {/* 最高 */}
                  <td className={`td-num ${getPriceClass(q?.high, prev)}`}>
                    {formatPrice(q?.high)}
                  </td>

                  {/* 最低 */}
                  <td className={`td-num ${getPriceClass(q?.low, prev)}`}>
                    {formatPrice(q?.low)}
                  </td>

                  {/* 總量 */}
                  <td className="td-num td-vol">{formatVolume(q?.totalVolume)}</td>

                  {/* 昨收 */}
                  <td className="td-num color-neutral">{formatPrice(prev)}</td>

                  {/* 開盤價 (遵循1.png標準，中性無色彩) */}
                  <td className="td-num color-neutral">
                    {formatPrice(q?.open)}
                  </td>

                  {/* 均線燈號與操作欄位 (個股顯示 5MA/10MA/20MA 燈號，ETF與債券不用；非財神簿保留刪除鍵) */}
                  <td className="td-action">
                    {(() => {
                      const isEtfOrBond = item.code.startsWith('00') || ['ETF', 'BOND'].includes((item.securityType || q?.securityType || '').toUpperCase());
                      const ind = indicators[item.code];
                      const currP = (q?.last && q.last > 0) ? q.last : ((prev && prev > 0) ? prev : null);

                      const ma5 = ind?.ma5;
                      const ma10 = ind?.ma10;
                      const ma20 = ind?.ma20;

                      const is5Up = (ma5 !== null && ma5 !== undefined && currP !== null) ? currP >= ma5 : null;
                      const is10Up = (ma10 !== null && ma10 !== undefined && currP !== null) ? currP >= ma10 : null;
                      const is20Up = (ma20 !== null && ma20 !== undefined && currP !== null) ? currP >= ma20 : null;

                      return (
                        <div className="action-cell-content">
                          {/* 均線標籤：個股顯示，ETF與債券不用 */}
                          {!isEtfOrBond ? (
                            <div className="ma-tag-group">
                              <span
                                className={`ma-tag ${is5Up === true ? 'tag-up' : (is5Up === false ? 'tag-down' : 'tag-neutral')}`}
                                title={ma5 !== null && ma5 !== undefined ? `5MA: ${ma5.toFixed(2)}${currP !== null ? ` (現價 ${currP.toFixed(2)} ${is5Up ? '衝破/站上' : '跌破'})` : ''}` : '5MA 資料計算中'}
                              >
                                5MA
                              </span>
                              <span
                                className={`ma-tag ${is10Up === true ? 'tag-up' : (is10Up === false ? 'tag-down' : 'tag-neutral')}`}
                                title={ma10 !== null && ma10 !== undefined ? `10MA: ${ma10.toFixed(2)}${currP !== null ? ` (現價 ${currP.toFixed(2)} ${is10Up ? '衝破/站上' : '跌破'})` : ''}` : '10MA 資料計算中'}
                              >
                                10MA
                              </span>
                              <span
                                className={`ma-tag ${is20Up === true ? 'tag-up' : (is20Up === false ? 'tag-down' : 'tag-neutral')}`}
                                title={ma20 !== null && ma20 !== undefined ? `20MA: ${ma20.toFixed(2)}${currP !== null ? ` (現價 ${currP.toFixed(2)} ${is20Up ? '衝破/站上' : '跌破'})` : ''}` : '20MA 資料計算中'}
                              >
                                20MA
                              </span>
                            </div>
                          ) : isWealthGroup ? (
                            <span className="color-neutral ma-empty">—</span>
                          ) : null}

                          {/* 刪除鍵：財神簿外之群組保留刪除功能 */}
                          {!isWealthGroup && (
                            <button
                              className="btn-cell-delete"
                              title="從此群組移除"
                              onClick={() => onRemoveItem(item.code)}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
};
