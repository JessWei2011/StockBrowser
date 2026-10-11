import React, { useState } from 'react';
import type { QuoteState, WatchlistItem } from '../types';

interface QuoteTableProps {
  items: WatchlistItem[];
  isWealthGroup?: boolean;
  quotes: Record<string, QuoteState>;
  dirtyCodes: Set<string>;
  onRemoveItem: (code: string) => Promise<void>;
  onMoveItem: (index: number, direction: 'up' | 'down') => Promise<void>;
  onReorderItems: (fromIndex: number, toIndex: number) => Promise<void>;
}

export const QuoteTable: React.FC<QuoteTableProps> = ({
  items,
  isWealthGroup,
  quotes,
  onRemoveItem,
  onMoveItem,
  onReorderItems,
}) => {
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const formatPrice = (val: number | null | undefined, isSim?: boolean): React.ReactNode => {
    if (val === null || val === undefined || isNaN(val)) return '—';
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
    if (val === null || val === undefined || isNaN(val) || prev === null || prev === undefined || isNaN(prev)) return 'color-neutral';
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
            <th>漲跌</th>
            <th>漲跌幅</th>
            <th>最高</th>
            <th>最低</th>
            <th>總量</th>
            <th>昨收</th>
            <th>開盤價</th>
            <th className="th-action">刪除</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={11} className="empty-message">
                目前群組沒有商品，請由上方搜尋並新增個股。
              </td>
            </tr>
          ) : (
            items.map((item, idx) => {
              const q = quotes[item.code];
              const prev = q?.previousClose ?? null;
              const last = q?.last ?? null;
              const chg = q?.change ?? null;
              const pct = q?.changePercent ?? null;

              // 1. 核心漲跌顏色判定 (紅漲、綠跌、平盤中性灰)
              let changeClass = 'color-neutral';
              const effectiveChg = chg !== null ? chg : (last !== null && prev !== null ? last - prev : null);
              const effectivePct = pct !== null ? pct : (effectiveChg !== null && prev !== null && prev > 0 ? (effectiveChg / prev) * 100 : null);
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

              return (
                <tr
                  key={item.id}
                  className={`quote-row ${isDragging ? 'row-dragging' : ''} ${
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
                    <span className="stock-code">{item.code}</span>
                    <span className="stock-name">{item.name || q?.name || ''}</span>
                    {(dispositionLevel > 0 || dispositionPeriod) && (
                      <span className="stock-badge badge-disposition" title={dispositionPeriod ? `處置股票 (期間: ${dispositionPeriod})` : '處置股票'}>
                        [{dispText}]
                      </span>
                    )}
                    {dispositionLevel === 0 && !dispositionPeriod && isAttention && (
                      <span className="stock-badge badge-attention" title="注意股票">
                        [注意]
                      </span>
                    )}
                  </td>

                  {/* 成交價 */}
                  <td className="td-num">
                    {badgeClass ? (
                      <span className={`cell-badge ${badgeClass}`}>{formatPrice(last, isSimulated)}</span>
                    ) : (
                      <span className={getPriceClass(last, prev)}>{formatPrice(last, isSimulated)}</span>
                    )}
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

                  {/* 刪除 */}
                  <td className="td-action">
                    <button
                      className="btn-cell-delete"
                      disabled={isWealthGroup}
                      title={isWealthGroup ? '『財神簿』由永豐 API 持股自動同步，無法手動刪除' : '從此群組移除'}
                      onClick={() => !isWealthGroup && onRemoveItem(item.code)}
                      style={isWealthGroup ? { opacity: 0.25, cursor: 'not-allowed' } : undefined}
                    >
                      ✕
                    </button>
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
