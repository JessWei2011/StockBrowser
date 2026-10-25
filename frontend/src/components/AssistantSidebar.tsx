import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { StockPosition, QuoteState, WealthSummary, OrderItem } from '../types';
import { submitOrder, fetchOrders, cancelOrder, updateOrder, clearOrders } from '../services/api';
import { getStoredVaultPassword } from './VaultPasswordModal';
import { BalanceTab } from './BalanceTab';

interface AssistantSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  activeTab: 'vault' | 'vault_ledger' | 'order' | 'balance';
  onChangeTab: (tab: 'vault' | 'vault_ledger' | 'order' | 'balance') => void;
  positions: StockPosition[];
  quotes: Record<string, QuoteState>;
  wealthSummary: WealthSummary | null;
  dirtyCodes: Set<string>;
  initialOrderCode?: string;
  onOrderTargetCodeChange?: (code: string) => void;
  onLock?: () => void;
  orderedCodes?: string[];
  onRefreshPositions?: () => Promise<void> | void;
  onReorderPositions?: (codes: string[]) => Promise<void> | void;
}

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

export const AssistantSidebar: React.FC<AssistantSidebarProps> = ({
  isOpen,
  onClose,
  activeTab,
  onChangeTab,
  positions,
  quotes,
  wealthSummary,
  dirtyCodes,
  initialOrderCode,
  onOrderTargetCodeChange,
  onLock,
  orderedCodes = [],
  onRefreshPositions,
  onReorderPositions,
}) => {
  const [isRefreshingPositions, setIsRefreshingPositions] = useState(false);
  // 財神庫排序模式：'custom' (依照自選排序，預設) 或 'pnl' (依損益金額排序)
  const [vaultSortMode, setVaultSortMode] = useState<'custom' | 'pnl'>('custom');
  // 拖曳排序狀態
  const [draggedPosIdx, setDraggedPosIdx] = useState<number | null>(null);
  const [dragOverPosIdx, setDragOverPosIdx] = useState<number | null>(null);
  // 手動清除歷史委託單紀錄
  const [isClearingOrders, setIsClearingOrders] = useState(false);
  const prevInitialCodeRef = useRef<string | undefined>(undefined);

  // 側邊欄多螢幕自適應與手動自由拖曳寬度
  const sidebarRef = useRef<HTMLElement>(null);
  const [customWidth, setCustomWidth] = useState<number | null>(() => {
    const saved = localStorage.getItem('assistant_sidebar_custom_width');
    return saved ? parseInt(saved, 10) : null;
  });
  const [isResizing, setIsResizing] = useState(false);

  // 限制自訂寬度在合理範圍內 (避免拖曳到較小螢幕時遮蔽行情區，最多不超過視窗寬度 55%)
  const effectiveWidth = customWidth ? Math.min(customWidth, Math.max(320, window.innerWidth * 0.55)) : undefined;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const initialWidth = sidebarRef.current ? sidebarRef.current.getBoundingClientRect().width : 520;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const minW = 320;
      const maxW = Math.max(minW, Math.min(800, window.innerWidth * 0.6));
      const newW = Math.max(minW, Math.min(maxW, initialWidth + delta));
      setCustomWidth(newW);
    };

    const onMouseUp = (upEvent: MouseEvent) => {
      setIsResizing(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      const delta = upEvent.clientX - startX;
      const minW = 320;
      const maxW = Math.max(minW, Math.min(800, window.innerWidth * 0.6));
      const finalW = Math.max(minW, Math.min(maxW, initialWidth + delta));
      setCustomWidth(finalW);
      localStorage.setItem('assistant_sidebar_custom_width', `${finalW}`);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleResetWidth = () => {
    setCustomWidth(null);
    localStorage.removeItem('assistant_sidebar_custom_width');
  };

  // 下單頁面 (財神筆) 狀態
  const [orderAction, setOrderAction] = useState<'buy' | 'sell'>('buy');
  // 交易時段：'normal' 盤中交易 (09:00~13:30) 或 'after_hours' 盤後交易 (13:40~14:30)
  const [orderSession, setOrderSession] = useState<'normal' | 'after_hours'>(() => {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    return (minutes >= 13 * 60 + 35 && minutes <= 14 * 60 + 35) ? 'after_hours' : 'normal';
  });
  const [orderUnit, setOrderUnit] = useState<'lot' | 'share'>('lot'); // lot: 整股(張), share: 零股(股)
  const [afterHoursLot, setAfterHoursLot] = useState<'Fixing' | 'Odd'>('Fixing'); // 'Fixing' 盤後定價(張), 'Odd' 盤後零股(股)
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit');
  const [stockCode, setStockCode] = useState(initialOrderCode || (positions[0]?.code || '2330'));
  const [orderPrice, setOrderPrice] = useState<string>('');
  const [orderQty, setOrderQty] = useState<number>(1);
  const [orderNotice, setOrderNotice] = useState<string | null>(null);
  const [orderNoticeType, setOrderNoticeType] = useState<'success' | 'error' | 'info'>('info');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // 下單前二次防護確認視窗狀態
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [confirmPin, setConfirmPin] = useState<string>('');

  // 委託單列表狀態
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [isLoadingOrders, setIsLoadingOrders] = useState(false);
  const [orderSubTab, setOrderSubTab] = useState<'form' | 'orders'>('form');
  const [orderFilter, setOrderFilter] = useState<'all' | 'active' | 'filled' | 'cancelled'>('all');

  // 改價彈窗狀態
  const [editingPriceOrder, setEditingPriceOrder] = useState<OrderItem | null>(null);
  const [newPriceInput, setNewPriceInput] = useState<string>('');
  const [isUpdatingPrice, setIsUpdatingPrice] = useState(false);

  // 改量彈窗狀態
  const [editingQtyOrder, setEditingQtyOrder] = useState<OrderItem | null>(null);
  const [newQtyInput, setNewQtyInput] = useState<number>(1);
  const [isUpdatingQty, setIsUpdatingQty] = useState(false);

  // 撤單確認狀態
  const [cancellingOrder, setCancellingOrder] = useState<OrderItem | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const loadOrders = async () => {
    try {
      setIsLoadingOrders(true);
      const data = await fetchOrders();
      setOrders(data);
    } catch (err: any) {
      console.error('Failed to fetch orders:', err);
    } finally {
      setIsLoadingOrders(false);
    }
  };

  useEffect(() => {
    if (isOpen && activeTab === 'order') {
      loadOrders();
      const timer = setInterval(loadOrders, 4000);
      return () => clearInterval(timer);
    }
  }, [isOpen, activeTab]);

  const activeOrdersCount = orders.filter((o) => o.canCancel).length;
  const currentStockActiveOrders = orders.filter((o) => o.code === stockCode && o.canCancel);

  // 當 initialOrderCode 變更時同步更新代號與最新參考價 (僅在代號真正改變時觸發，避免 quotes 1Hz 更新時衝掉使用者選擇)
  useEffect(() => {
    if (initialOrderCode && initialOrderCode !== prevInitialCodeRef.current) {
      prevInitialCodeRef.current = initialOrderCode;
      setStockCode(initialOrderCode);
      const q = quotes[initialOrderCode];
      if (q && q.last && q.last > 0) {
        setOrderPrice(q.last.toFixed(2));
      } else if (q && q.previousClose && q.previousClose > 0) {
        setOrderPrice(q.previousClose.toFixed(2));
      }
    }
  }, [initialOrderCode, quotes]);

  // 當選定個股時，若尚未輸入價格則帶入現價或昨收；若為盤後定價則鎖定為收盤價
  const currentQuote = quotes[stockCode];
  const closingPriceVal = currentQuote?.last || currentQuote?.previousClose || 0;

  useEffect(() => {
    if (orderSession === 'after_hours' && afterHoursLot === 'Fixing' && closingPriceVal > 0) {
      setOrderPrice(closingPriceVal.toFixed(2));
    } else if (currentQuote && currentQuote.last && currentQuote.last > 0 && !orderPrice) {
      setOrderPrice(currentQuote.last.toFixed(2));
    }
  }, [stockCode, currentQuote, orderSession, afterHoursLot, closingPriceVal]);

  // 監聽 Esc 鍵快速關閉下單確認視窗
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isConfirmModalOpen && !isSubmitting) {
        setIsConfirmModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isConfirmModalOpen, isSubmitting]);

  if (!isOpen) return null;

  // 排序持股：預設依自選順序 (與財神簿相同)，亦可切換為損益排行
  const sortedPositions = [...positions].sort((a, b) => {
    if (vaultSortMode === 'custom' && orderedCodes && orderedCodes.length > 0) {
      const idxA = orderedCodes.indexOf(a.code);
      const idxB = orderedCodes.indexOf(b.code);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
    }
    const qA = quotes[a.code];
    const qB = quotes[b.code];
    const priceA = (qA?.last && qA.last > 0) ? qA.last : (a.initialLast && a.initialLast > 0 ? a.initialLast : a.costPrice);
    const priceB = (qB?.last && qB.last > 0) ? qB.last : (b.initialLast && b.initialLast > 0 ? b.initialLast : b.costPrice);
    const pnlA = calcPositionMetrics(a.code, priceA, a.quantity, a.costPrice, a.initialLast, a.initialPnl).pnl;
    const pnlB = calcPositionMetrics(b.code, priceB, b.quantity, b.costPrice, b.initialLast, b.initialPnl).pnl;
    return pnlB - pnlA;
  });

  // 向上或向下移動持股位置 (與財神簿自訂排序雙向同步)
  const handleMovePosition = async (index: number, delta: number) => {
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= sortedPositions.length) return;

    const currentCodes = sortedPositions.map((p) => p.code);
    const newDisplayCodes = [...currentCodes];
    const temp = newDisplayCodes[index];
    newDisplayCodes[index] = newDisplayCodes[targetIdx];
    newDisplayCodes[targetIdx] = temp;

    // 將可見順序整合回完整的 orderedCodes
    const displaySet = new Set(newDisplayCodes);
    const fullNewCodes: string[] = [];
    let dIdx = 0;
    for (const c of orderedCodes) {
      if (displaySet.has(c)) {
        fullNewCodes.push(newDisplayCodes[dIdx++]);
      } else {
        fullNewCodes.push(c);
      }
    }
    for (const c of newDisplayCodes) {
      if (!fullNewCodes.includes(c)) {
        fullNewCodes.push(c);
      }
    }

    if (onReorderPositions) {
      await onReorderPositions(fullNewCodes);
    }
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    if (vaultSortMode !== 'custom') return;
    setDraggedPosIdx(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${index}`);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    if (vaultSortMode !== 'custom') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverPosIdx !== index) {
      setDragOverPosIdx(index);
    }
  };

  const handleDragEnd = () => {
    setDraggedPosIdx(null);
    setDragOverPosIdx(null);
  };

  const handleDrop = async (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (vaultSortMode !== 'custom' || draggedPosIdx === null || draggedPosIdx === dropIndex) {
      handleDragEnd();
      return;
    }
    const from = draggedPosIdx;
    handleDragEnd();

    const currentCodes = sortedPositions.map((p) => p.code);
    const newDisplayCodes = [...currentCodes];
    const [moved] = newDisplayCodes.splice(from, 1);
    newDisplayCodes.splice(dropIndex, 0, moved);

    const displaySet = new Set(newDisplayCodes);
    const fullNewCodes: string[] = [];
    let dIdx = 0;
    for (const c of orderedCodes) {
      if (displaySet.has(c)) {
        fullNewCodes.push(newDisplayCodes[dIdx++]);
      } else {
        fullNewCodes.push(c);
      }
    }
    for (const c of newDisplayCodes) {
      if (!fullNewCodes.includes(c)) {
        fullNewCodes.push(c);
      }
    }

    if (onReorderPositions) {
      await onReorderPositions(fullNewCodes);
    }
  };

  // 點選持股一鍵帶入財神筆下單
  const handleSelectToOrder = (code: string, quantity?: number) => {
    prevInitialCodeRef.current = code;
    onOrderTargetCodeChange?.(code);
    setStockCode(code);
    const q = quotes[code];
    if (q && q.last && q.last > 0) {
      setOrderPrice(q.last.toFixed(2));
    }
    // 預設導入現有個股數與單位，並預設為賣出
    if (quantity && quantity > 0) {
      if (quantity >= 1000 && quantity % 1000 === 0) {
        setOrderUnit('lot');
        setOrderQty(Math.floor(quantity / 1000));
      } else {
        setOrderUnit('share');
        setOrderQty(quantity);
      }
      setOrderAction('sell');
    }
    onChangeTab('order');
  };

  // 價格快速晶片 (跌停/平盤/現價/漲停)
  const prevClose = currentQuote?.previousClose;
  const lastPrice = currentQuote?.last;
  const limitUp = prevClose && prevClose > 0 ? (prevClose * 1.1).toFixed(2) : null;
  const limitDown = prevClose && prevClose > 0 ? (prevClose * 0.9).toFixed(2) : null;

  // 查詢當前輸入代號之庫存資訊
  const currentPosition = positions.find((p) => p.code === stockCode);

  // 依交易時段與規格決定有效單位、委託別與價格
  const effectiveUnit: 'lot' | 'share' = orderSession === 'after_hours'
    ? (afterHoursLot === 'Fixing' ? 'lot' : 'share')
    : orderUnit;

  const effectiveOrderLot: 'Common' | 'IntradayOdd' | 'Fixing' | 'Odd' = orderSession === 'after_hours'
    ? afterHoursLot
    : (orderUnit === 'lot' ? 'Common' : 'IntradayOdd');

  const effectivePriceType: 'limit' | 'market' = orderSession === 'after_hours' ? 'limit' : orderType;

  const effectivePrice = (orderSession === 'after_hours' && afterHoursLot === 'Fixing')
    ? (closingPriceVal > 0 ? closingPriceVal.toFixed(2) : orderPrice)
    : orderPrice;

  // 試算金額 (含手續費 0.1425% 與賣出證交稅 0.3%/0.1%)
  const numPrice = parseFloat(effectivePrice) || (lastPrice && lastPrice > 0 ? lastPrice : 0);
  const totalShares = effectiveUnit === 'lot' ? orderQty * 1000 : orderQty;
  const estimatedAmount = Math.round(numPrice * totalShares);
  const estimatedFee = Math.max(20, Math.round(estimatedAmount * 0.001425));
  const isEtf = stockCode.startsWith('00');
  const taxRate = isEtf ? 0.001 : 0.003;
  const estimatedTax = orderAction === 'sell' ? Math.round(estimatedAmount * taxRate) : 0;
  const estimatedTotal = orderAction === 'buy'
    ? estimatedAmount + estimatedFee
    : Math.max(0, estimatedAmount - estimatedFee - estimatedTax);

  // 買入金額 >= 30 萬強烈防護條件
  const isHighValueBuy = orderAction === 'buy' && estimatedTotal >= 300000;
  const isPinCorrect = isHighValueBuy ? confirmPin === getStoredVaultPassword() : true;

  // 1. 表單提交：前置檢查通過後，彈出二次防護確認視窗
  const handleSubmitOrder = (e: React.FormEvent) => {
    e.preventDefault();
    if (!stockCode.trim()) {
      setOrderNoticeType('error');
      setOrderNotice('請輸入或選擇股票代號');
      return;
    }
    const targetPrice = effectivePriceType === 'market' ? 0 : (parseFloat(effectivePrice) || 0);
    if (effectivePriceType === 'limit' && targetPrice <= 0) {
      setOrderNoticeType('error');
      setOrderNotice(orderSession === 'after_hours' && afterHoursLot === 'Fixing'
        ? '尚未取得今日收盤價，請手動確認價格'
        : '限價委託請輸入大於 0 的價格');
      return;
    }
    if (orderQty <= 0) {
      setOrderNoticeType('error');
      setOrderNotice('委託數量必須大於 0');
      return;
    }

    // 重置密碼輸入並彈出二次防護確認視窗
    setConfirmPin('');
    setIsConfirmModalOpen(true);
  };

  // 2. 於防護確認視窗按下確認後，實際送出委託
  const handleExecuteOrder = async () => {
    // 若為 >=30 萬買入委託，必須驗證安全密碼方可放行
    if (isHighValueBuy && !isPinCorrect) {
      return;
    }
    setIsConfirmModalOpen(false);
    const targetPrice = effectivePriceType === 'market' ? 0 : (parseFloat(effectivePrice) || 0);

    setIsSubmitting(true);
    setOrderNoticeType('info');
    const lotLabel = orderSession === 'after_hours'
      ? (afterHoursLot === 'Fixing' ? '盤後定價' : '盤後零股')
      : (orderUnit === 'lot' ? '整股' : '零股');
    setOrderNotice(`正在送出【${orderAction === 'buy' ? '買進' : '賣出'}】${lotLabel}委託至永豐金證券 (${stockCode} ${orderQty}${effectiveUnit === 'lot' ? '張' : '股'})...`);

    try {
      const res = await submitOrder({
        code: stockCode.trim(),
        action: orderAction,
        quantity: orderQty,
        unit: effectiveUnit,
        price_type: effectivePriceType,
        price: targetPrice,
        order_lot: effectiveOrderLot,
      });

      if (res.success) {
        setOrderNoticeType('success');
        setOrderNotice(`✔ 委託已成功送出！單號: ${res.orderId || '已確認'} | ${res.message}`);
        await loadOrders();
        setOrderSubTab('orders');
      } else {
        setOrderNoticeType('error');
        setOrderNotice(`❌ 委託未成立: ${res.message || res.detail || '交易所退單'}`);
      }
    } catch (err: any) {
      setOrderNoticeType('error');
      setOrderNotice(`❌ 下單失敗: ${err.message || '連線或委託異常'}`);
    } finally {
      setIsSubmitting(false);
      setTimeout(() => {
        setOrderNotice(null);
      }, 8000);
    }
  };

  const handleConfirmCancel = async () => {
    if (!cancellingOrder) return;
    try {
      setIsCancelling(true);
      const res = await cancelOrder(cancellingOrder.id);
      setOrderNoticeType('success');
      setOrderNotice(`✔ 撤單成功：${res.message || '委託已撤銷'}`);
      setCancellingOrder(null);
      await loadOrders();
    } catch (err: any) {
      setOrderNoticeType('error');
      setOrderNotice(`❌ 撤單失敗: ${err.message || '撤單異常'}`);
    } finally {
      setIsCancelling(false);
      setTimeout(() => setOrderNotice(null), 8000);
    }
  };

  const handleStartEditPrice = (order: OrderItem) => {
    if (order.orderLot === 'Fixing' || order.orderLot === 'Odd') {
      setOrderNoticeType('error');
      setOrderNotice('台股交易所規範：盤後交易（盤後定價與盤後零股）均不支援線上改價！若欲變更價格請先撤單後重新送單。');
      return;
    }
    setEditingPriceOrder(order);
    setNewPriceInput(order.price.toString());
  };

  const handleConfirmUpdatePrice = async () => {
    if (!editingPriceOrder) return;
    const p = parseFloat(newPriceInput);
    if (isNaN(p) || p <= 0) {
      alert('請輸入大於 0 的有效價格');
      return;
    }
    try {
      setIsUpdatingPrice(true);
      const res = await updateOrder(editingPriceOrder.id, { newPrice: p });
      setOrderNoticeType('success');
      setOrderNotice(`✔ ${res.message || '改價成功'}`);
      setEditingPriceOrder(null);
      await loadOrders();
    } catch (err: any) {
      setOrderNoticeType('error');
      setOrderNotice(`❌ 改價失敗: ${err.message || '改價異常'}`);
    } finally {
      setIsUpdatingPrice(false);
      setTimeout(() => setOrderNotice(null), 8000);
    }
  };

  const handleStartEditQty = (order: OrderItem) => {
    const isLot = order.orderLot === 'Common' || order.orderLot === 'Fixing';
    const unitText = isLot ? '張' : '股';
    if (order.qty <= 1) {
      setOrderNoticeType('error');
      setOrderNotice(`目前剩餘委託量僅 1 ${unitText}，依法規減量後不能為 0！已無法再減量，若欲全數取消請直接使用「🗑️ 撤單」。`);
      return;
    }
    setEditingQtyOrder(order);
    setNewQtyInput(Math.max(1, order.qty - (isLot ? 1 : 100)));
  };

  const handleConfirmUpdateQty = async () => {
    if (!editingQtyOrder) return;
    const q = newQtyInput;
    if (isNaN(q) || q <= 0 || q >= editingQtyOrder.qty) {
      alert(`新數量必須大於 0 且小於目前剩餘數量 ${editingQtyOrder.qty}`);
      return;
    }
    try {
      setIsUpdatingQty(true);
      const res = await updateOrder(editingQtyOrder.id, { newQty: q });
      setOrderNoticeType('success');
      setOrderNotice(`✔ ${res.message || '改量成功'}`);
      setEditingQtyOrder(null);
      await loadOrders();
    } catch (err: any) {
      setOrderNoticeType('error');
      setOrderNotice(`❌ 改量失敗: ${err.message || '改量異常'}`);
    } finally {
      setIsUpdatingQty(false);
      setTimeout(() => setOrderNotice(null), 8000);
    }
  };

  // 手動清除歷史委託單紀錄
  const handleClearOrders = async () => {
    const activeList = orders.filter((o) => o.canCancel);
    let confirmMsg = '確定要清空今日委託單歷史紀錄嗎？';
    if (activeList.length > 0) {
      confirmMsg = `目前尚有 ${activeList.length} 筆掛單待撮合。\n\n「清空歷史單」僅清空畫面歷史顯示，不會向券商撤銷進行中的掛單。\n\n確定要清空紀錄嗎？`;
    }

    if (!window.confirm(confirmMsg)) return;

    try {
      setIsClearingOrders(true);
      await clearOrders();
      setOrders([]);
      setOrderNoticeType('info');
      setOrderNotice('✔ 今日委託單歷史紀錄已清空');
      setTimeout(() => setOrderNotice(null), 5000);
    } catch (err: any) {
      console.error('Failed to clear orders:', err);
      alert('清空紀錄失敗：' + (err.message || '請稍後再試'));
    } finally {
      setIsClearingOrders(false);
    }
  };

  // 篩選委託單列表
  const filteredOrders = orders.filter((o) => {
    if (orderFilter === 'active') return o.canCancel;
    if (orderFilter === 'filled') return o.status === 'Filled';
    if (orderFilter === 'cancelled') return o.status === 'Cancelled';
    return true;
  });

  return (
    <aside
      ref={sidebarRef}
      className={`assistant-sidebar ${isResizing ? 'is-resizing' : ''}`}
      style={effectiveWidth ? { width: effectiveWidth } : undefined}
      aria-label="側邊輔助資料視窗"
    >
      {/* 拖曳調節分隔手柄 (支援手動自由拉伸寬度，雙擊還原當前螢幕最佳寬度) */}
      <div
        className={`sidebar-resizer ${isResizing ? 'is-resizing' : ''}`}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleResetWidth}
        title="按住拖曳可調整財神庫寬度；雙擊重設為當前螢幕最佳自適應寬度"
      />
      {/* 頂部標題與分頁切換列 */}
      <div className="sidebar-header">
        <div className="sidebar-tabs">
          <button
            className={`sidebar-tab-btn ${activeTab === 'vault' ? 'active' : ''}`}
            onClick={() => onChangeTab('vault')}
            title="分頁一：財神庫（庫存持股與未實現損益）"
          >
            <span className="sidebar-tab-icon">🏦</span>
            <span className="sidebar-tab-title">財神庫</span>
            <span className="sidebar-tab-badge">{positions.length}</span>
          </button>
          <button
            className={`sidebar-tab-btn ${activeTab === 'vault_ledger' ? 'active' : ''}`}
            onClick={() => onChangeTab('vault_ledger')}
            title="分頁二：財神簿（持股即時成交行情與操作）"
          >
            <span className="sidebar-tab-icon">📖</span>
            <span className="sidebar-tab-title">財神簿</span>
          </button>
          <button
            className={`sidebar-tab-btn ${activeTab === 'order' ? 'active' : ''}`}
            onClick={() => onChangeTab('order')}
            title="分頁三：財神筆（快速下單與委託管理）"
          >
            <span className="sidebar-tab-icon">✍️</span>
            <span className="sidebar-tab-title">財神筆</span>
            {activeOrdersCount > 0 ? (
              <span className="sidebar-tab-badge badge-active-orders" title={`目前有 ${activeOrdersCount} 筆掛單待撮合`}>
                {activeOrdersCount}
              </span>
            ) : orders.length > 0 ? (
              <span className="sidebar-tab-badge" title={`今日共 ${orders.length} 筆委託紀錄`}>
                {orders.length}
              </span>
            ) : null}
          </button>
          <button
            className={`sidebar-tab-btn ${activeTab === 'balance' ? 'active' : ''}`}
            onClick={() => onChangeTab('balance')}
            title="分頁四：財神口袋（T+2 在途交割與投資本金試算）"
          >
            <span className="sidebar-tab-icon">💰</span>
            <span className="sidebar-tab-title">財神口袋</span>
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {onLock && (
            <button
              className="btn-sidebar-lock"
              onClick={onLock}
              title="立即上鎖財神庫（下次開啟需重新輸入密碼）"
            >
              🔒 上鎖
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="btn-sidebar-close"
              onClick={onClose}
              title="關閉視窗"
              aria-label="關閉視窗"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 側邊主體內容 */}
      <div className="sidebar-body">
        {activeTab === 'vault' ? (
          /* ==================== 分頁一：財神庫 ==================== */
          <div className="sidebar-vault-content">
            {/* 庫存即時總損益摘要 */}
            {wealthSummary && (
              <div className="sidebar-vault-summary">
                <div className="sidebar-summary-card">
                  <span className="sidebar-summary-label">總未實現損益</span>
                  <span
                    className={`sidebar-summary-val ${
                      wealthSummary.totalPnl > 0
                        ? 'color-up'
                        : wealthSummary.totalPnl < 0
                        ? 'color-down'
                        : 'color-neutral'
                    }`}
                  >
                    {wealthSummary.totalPnl > 0 ? '+' : ''}
                    {Math.round(wealthSummary.totalPnl).toLocaleString()} 元
                  </span>
                </div>
                <div className="sidebar-summary-card">
                  <span className="sidebar-summary-label">總報酬率</span>
                  <span
                    className={`sidebar-summary-val ${
                      wealthSummary.returnPercent > 0
                        ? 'color-up'
                        : wealthSummary.returnPercent < 0
                        ? 'color-down'
                        : 'color-neutral'
                    }`}
                  >
                    {wealthSummary.returnPercent > 0 ? '+' : ''}
                    {wealthSummary.returnPercent.toFixed(2)}%
                  </span>
                </div>
              </div>
            )}

            {/* 持股明細清單 (扁平化單行卡片) */}
            <div className="sidebar-vault-list">
              {sortedPositions.length === 0 ? (
                <div className="sidebar-empty-msg">
                  尚無持股資料，系統將於永豐證券 API 連線後自動同步。
                </div>
              ) : (
                <>
                  <div className="vault-sort-bar">
                    <span className="vault-sort-title">
                      持股列表
                      {vaultSortMode === 'custom' && (
                        <span className="vault-sort-subhint">（可按 ↑ / ↓ 自由排序）</span>
                      )}
                    </span>
                    <div className="vault-sort-btn-group">
                      <button
                        type="button"
                        className={`vault-sort-pill ${vaultSortMode === 'custom' ? 'active' : ''}`}
                        onClick={() => setVaultSortMode('custom')}
                        title="自訂排序 (可按 ↑ / ↓ 或拖曳調整，並與財神簿即時同步)"
                      >
                        📌 自訂排序
                      </button>
                      <button
                        type="button"
                        className={`vault-sort-pill ${vaultSortMode === 'pnl' ? 'active' : ''}`}
                        onClick={() => setVaultSortMode('pnl')}
                        title="依未實現損益高低排序"
                      >
                        💰 損益排行
                      </button>
                      {onRefreshPositions && (
                        <button
                          type="button"
                          className="vault-sort-pill vault-refresh-pill"
                          disabled={isRefreshingPositions}
                          onClick={async () => {
                            setIsRefreshingPositions(true);
                            try {
                              await onRefreshPositions();
                            } finally {
                              setIsRefreshingPositions(false);
                            }
                          }}
                          title="立即向永豐證券重新同步最新庫存 (包含買賣成交異動)"
                        >
                          {isRefreshingPositions ? '⟳ 同步中...' : '⟳ 同步持股'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="sidebar-vault-col-header">
                    {vaultSortMode === 'custom' && <span className="col-h-reorder">排序</span>}
                    <span className="col-h-stock">商品</span>
                    <span className="col-h-qty">股數</span>
                    <span className="col-h-pnl">損益試算</span>
                    <span className="col-h-roi">報酬率</span>
                    <span className="col-h-action">操作</span>
                  </div>
                  {sortedPositions.map((pos, idx) => {
                    const q = quotes[pos.code];
                    const currPrice =
                      q?.last !== null && q?.last !== undefined && q.last > 0
                        ? q.last
                        : pos.initialLast && pos.initialLast > 0
                        ? pos.initialLast
                        : pos.costPrice;
                    const { pnl, roi } = calcPositionMetrics(
                      pos.code,
                      currPrice,
                      pos.quantity,
                      pos.costPrice,
                      pos.initialLast,
                      pos.initialPnl
                    );
                    const isOtc = ((pos.exchange || q?.exchange || '').toUpperCase() === 'OTC');
                    const isDirty = dirtyCodes.has(pos.code);

                    const pnlClass = pnl > 0 ? 'color-up' : pnl < 0 ? 'color-down' : 'color-neutral';
                    const roiClass = roi > 0 ? 'color-up' : roi < 0 ? 'color-down' : 'color-neutral';
                    const isDimmed = Boolean(
                      pos.code.startsWith('00') ||
                      pos.code.includes('B') ||
                      ['ETF', 'BOND'].includes((q?.securityType || '').toUpperCase()) ||
                      pos.code === '6757'
                    );

                    return (
                      <div
                        key={pos.code}
                        className={`sidebar-stock-card flat-card ${isDimmed ? 'card-dimmed' : ''} ${isDirty ? 'card-flash' : ''} ${
                          draggedPosIdx === idx ? 'card-dragging' : ''
                        } ${dragOverPosIdx === idx ? 'card-drop-target' : ''}`}
                        draggable={vaultSortMode === 'custom'}
                        onDragStart={(e) => handleDragStart(e, idx)}
                        onDragOver={(e) => handleDragOver(e, idx)}
                        onDragEnd={handleDragEnd}
                        onDrop={(e) => handleDrop(e, idx)}
                      >
                        <div className="vault-card-row-main">
                          {vaultSortMode === 'custom' && (
                            <div className="sidebar-reorder-controls" onClick={(e) => e.stopPropagation()}>
                              <span className="drag-handle sidebar-drag-handle" title="按住拖曳排序">⠿</span>
                              <button
                                type="button"
                                className="btn-order-arrow btn-sidebar-arrow"
                                title="往上移"
                                disabled={idx === 0}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleMovePosition(idx, -1);
                                }}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="btn-order-arrow btn-sidebar-arrow"
                                title="往下移"
                                disabled={idx === sortedPositions.length - 1}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleMovePosition(idx, 1);
                                }}
                              >
                                ↓
                              </button>
                            </div>
                          )}

                          <div className="flat-card-stock">
                            <span
                              className={`exchange-badge ${isOtc ? 'badge-otc' : 'badge-tse'}`}
                              title={isOtc ? '上櫃股票' : '上市股票'}
                            >
                              {isOtc ? '櫃' : '市'}
                            </span>
                            <span className="flat-stock-name" title={pos.name || pos.code}>
                              {pos.name || pos.code}
                            </span>
                            <span className={`flat-stock-code ${isOtc ? 'code-otc' : 'code-tse'}`}>
                              {pos.code}
                            </span>
                          </div>

                          <div className="vault-card-pnl-roi-group">
                            <div className={`flat-card-pnl ${pnlClass}`} title="損益試算 (已扣手續費與稅金)">
                              {pnl > 0 ? '+' : ''}{Math.round(pnl).toLocaleString()}
                              <span className="flat-unit">元</span>
                            </div>

                            <div className={`flat-card-roi ${roiClass}`} title="報酬率">
                              {roi > 0 ? '+' : ''}{roi.toFixed(2)}%
                            </div>
                          </div>
                        </div>

                        <div className="vault-card-row-sub">
                          <div className="vault-card-sub-info">
                            <div className="flat-card-qty" title={`剩餘股數: ${Math.round(pos.quantity).toLocaleString()} 股`}>
                              <span className="sub-lbl">庫存</span>
                              <span className="flat-qty-num">{Math.round(pos.quantity).toLocaleString()}</span>
                              <span className="flat-unit">股</span>
                            </div>
                            <div className="vault-card-price-info">
                              <span className="sub-lbl">現價</span>
                              <span className="sub-val">{currPrice.toFixed(2)}</span>
                            </div>
                          </div>

                          <button
                            type="button"
                            className="btn-order-shortcut"
                            title={`帶入「${pos.name || pos.code}」現有 ${Math.round(pos.quantity).toLocaleString()} 股至財神筆快速下單`}
                            onClick={() => handleSelectToOrder(pos.code, pos.quantity)}
                          >
                            <span>下單</span>
                            <span className="order-shortcut-arrow">↗</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        ) : activeTab === 'vault_ledger' ? (
          /* ==================== 分頁二：財神簿 ==================== */
          <div className="sidebar-vault-content">
            <div className="sidebar-vault-list">
              {sortedPositions.length === 0 ? (
                <div className="sidebar-empty-msg">
                  尚無持股資料，系統將於永豐證券 API 連線後自動同步。
                </div>
              ) : (
                <>
                  <div className="vault-sort-bar">
                    <span className="vault-sort-title">
                      財神簿 ({sortedPositions.length} 檔)
                      {vaultSortMode === 'custom' && (
                        <span className="vault-sort-subhint">（可按 ↑ / ↓ 自由排序）</span>
                      )}
                    </span>
                    <div className="vault-sort-btn-group">
                      <button
                        type="button"
                        className={`vault-sort-pill ${vaultSortMode === 'custom' ? 'active' : ''}`}
                        onClick={() => setVaultSortMode('custom')}
                        title="自訂排序 (可按 ↑ / ↓ 或拖曳調整，並與主畫面財神簿即時同步)"
                      >
                        📌 自訂排序
                      </button>
                      <button
                        type="button"
                        className={`vault-sort-pill ${vaultSortMode === 'pnl' ? 'active' : ''}`}
                        onClick={() => setVaultSortMode('pnl')}
                        title="依未實現損益高低排序"
                      >
                        💰 損益排行
                      </button>
                      {onRefreshPositions && (
                        <button
                          type="button"
                          className="vault-sort-pill vault-refresh-pill"
                          disabled={isRefreshingPositions}
                          onClick={async () => {
                            setIsRefreshingPositions(true);
                            try {
                              await onRefreshPositions();
                            } finally {
                              setIsRefreshingPositions(false);
                            }
                          }}
                          title="立即向永豐證券重新同步最新庫存 (包含買賣成交異動)"
                        >
                          {isRefreshingPositions ? '⟳ 同步中...' : '⟳ 同步持股'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="sidebar-vault-col-header">
                    {vaultSortMode === 'custom' && <span className="col-h-reorder">排序</span>}
                    <span className="col-h-stock">商品</span>
                    <span className="col-h-last-price">成交價</span>
                    <span className="col-h-oddlot-price">零股價</span>
                    <span className="col-h-change-pct">漲跌幅</span>
                    <span className="col-h-action">操作</span>
                  </div>
                  {sortedPositions.map((pos, idx) => {
                    const q = quotes[pos.code];
                    const prev = (q?.previousClose && q.previousClose > 0) ? q.previousClose : null;
                    const last = (q?.last && q.last > 0) ? q.last : null;
                    const chg = (last !== null && prev !== null) ? (q?.change ?? (last - prev)) : null;
                    const pct = (last !== null && prev !== null) ? (q?.changePercent ?? (chg !== null ? (chg / prev) * 100 : null)) : null;

                    let changeClass = 'color-neutral';
                    if (chg !== null && !isNaN(chg)) {
                      if (chg > 0) changeClass = 'color-up';
                      else if (chg < 0) changeClass = 'color-down';
                    }

                    const lastClass = (last !== null && prev !== null)
                      ? (last > prev ? 'color-up' : last < prev ? 'color-down' : 'color-neutral')
                      : 'color-neutral';

                    const oddLot = q?.oddLotLast ?? null;
                    const oddLotClass = (oddLot !== null && prev !== null)
                      ? (oddLot > prev ? 'color-up' : oddLot < prev ? 'color-down' : 'color-neutral')
                      : 'color-neutral';

                    const isOtc = ((pos.exchange || q?.exchange || '').toUpperCase() === 'OTC');
                    const isDirty = dirtyCodes.has(pos.code);
                    const isDimmed = Boolean(
                      pos.code.startsWith('00') ||
                      pos.code.includes('B') ||
                      ['ETF', 'BOND'].includes((q?.securityType || '').toUpperCase()) ||
                      pos.code === '6757'
                    );

                    return (
                      <div
                        key={pos.code}
                        className={`sidebar-stock-card flat-card ${isDimmed ? 'card-dimmed' : ''} ${isDirty ? 'card-flash' : ''} ${
                          draggedPosIdx === idx ? 'card-dragging' : ''
                        } ${dragOverPosIdx === idx ? 'card-drop-target' : ''}`}
                        draggable={vaultSortMode === 'custom'}
                        onDragStart={(e) => handleDragStart(e, idx)}
                        onDragOver={(e) => handleDragOver(e, idx)}
                        onDragEnd={handleDragEnd}
                        onDrop={(e) => handleDrop(e, idx)}
                      >
                        <div className="vault-card-row-main">
                          {vaultSortMode === 'custom' && (
                            <div className="sidebar-reorder-controls" onClick={(e) => e.stopPropagation()}>
                              <span className="drag-handle sidebar-drag-handle" title="按住拖曳排序">⠿</span>
                              <button
                                type="button"
                                className="btn-order-arrow btn-sidebar-arrow"
                                title="往上移"
                                disabled={idx === 0}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleMovePosition(idx, -1);
                                }}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="btn-order-arrow btn-sidebar-arrow"
                                title="往下移"
                                disabled={idx === sortedPositions.length - 1}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleMovePosition(idx, 1);
                                }}
                              >
                                ↓
                              </button>
                            </div>
                          )}

                          <div className="flat-card-stock">
                            <span
                              className={`exchange-badge ${isOtc ? 'badge-otc' : 'badge-tse'}`}
                              title={isOtc ? '上櫃股票' : '上市股票'}
                            >
                              {isOtc ? '櫃' : '市'}
                            </span>
                            <span className="flat-stock-name" title={pos.name || pos.code}>
                              {pos.name || pos.code}
                            </span>
                            <span className={`flat-stock-code ${isOtc ? 'code-otc' : 'code-tse'}`}>
                              {pos.code}
                            </span>
                          </div>

                          <div className="vault-card-price-pct-group">
                            <div className={`flat-card-price ${lastClass}`} title="整股成交價">
                              {last !== null ? last.toFixed(2) : '—'}
                            </div>
                            <div className={`flat-card-pct ${changeClass}`} title="當日漲跌幅">
                              {pct === null || isNaN(pct)
                                ? '—'
                                : pct > 0
                                ? `+${pct.toFixed(2)}%`
                                : `${pct.toFixed(2)}%`}
                            </div>
                          </div>
                        </div>

                        <div className="vault-card-row-sub">
                          <div className="vault-card-sub-info">
                            <div className={`flat-card-oddlot ${oddLotClass}`} title="盤中零股成交價">
                              <span className="oddlot-prefix">零股</span>
                              {oddLot !== null && oddLot > 0 ? oddLot.toFixed(2) : '—'}
                            </div>
                            <div className="flat-card-qty" title={`剩餘股數: ${Math.round(pos.quantity).toLocaleString()} 股`}>
                              <span className="sub-lbl">庫存</span>
                              <span className="flat-qty-num">{Math.round(pos.quantity).toLocaleString()}</span>
                              <span className="flat-unit">股</span>
                            </div>
                          </div>

                          <button
                            type="button"
                            className="btn-order-shortcut"
                            title={`帶入「${pos.name || pos.code}」快速下單`}
                            onClick={() => handleSelectToOrder(pos.code, pos.quantity)}
                          >
                            <span>下單</span>
                            <span className="order-shortcut-arrow">↗</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        ) : activeTab === 'order' ? (
          /* ==================== 分頁二：財神筆 ==================== */
          <div className="sidebar-order-content">
            {orderNotice && (
              <div className={`sidebar-order-notice notice-${orderNoticeType}`}>
                {orderNotice}
              </div>
            )}

            {/* 財神筆子分頁切換列：下單委託 vs 今日交易單 */}
            <div className="order-subnav-bar">
              <button
                type="button"
                className={`subnav-btn ${orderSubTab === 'form' ? 'active' : ''}`}
                onClick={() => setOrderSubTab('form')}
              >
                <span>✍️ 快速下單委託</span>
              </button>
              <button
                type="button"
                className={`subnav-btn ${orderSubTab === 'orders' ? 'active' : ''}`}
                onClick={() => {
                  setOrderSubTab('orders');
                  loadOrders();
                }}
              >
                <span>📋 今日交易單</span>
                {activeOrdersCount > 0 && (
                  <span className="subnav-badge pulse">{activeOrdersCount}</span>
                )}
              </button>
            </div>

            {orderSubTab === 'form' ? (
              <>
                {currentStockActiveOrders.length > 0 && (
                  <div className="current-stock-orders-banner">
                    <div className="banner-text">
                      <span className="banner-icon">⚠️</span>
                      <span>
                        目前【{stockCode}】有 <strong>{currentStockActiveOrders.length}</strong> 筆有效掛單中
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn-view-orders-link"
                      onClick={() => setOrderSubTab('orders')}
                    >
                      查看交易單 ↗
                    </button>
                  </div>
                )}

                <form className="order-form" onSubmit={handleSubmitOrder}>
              {/* 1. 買賣方向區 (紅/綠高對比警示) */}
              <div className={`order-section-action action-${orderAction}`}>
                <div className="action-toggle-group">
                  <button
                    type="button"
                    className={`btn-action-toggle btn-buy ${orderAction === 'buy' ? 'active' : ''}`}
                    onClick={() => setOrderAction('buy')}
                  >
                    🔴 買進 (Buy)
                  </button>
                  <button
                    type="button"
                    className={`btn-action-toggle btn-sell ${orderAction === 'sell' ? 'active' : ''}`}
                    onClick={() => setOrderAction('sell')}
                  >
                    🟢 賣出 (Sell)
                  </button>
                </div>
                <div className={`action-mode-banner banner-${orderAction}`}>
                  {orderAction === 'buy' ? (
                    <span>🔴 買進委託（扣款委託）：成交款項將自交割銀行帳戶扣款 (T+2)</span>
                  ) : (
                    <span>🟢 賣出委託（入帳委託）：成交款項扣除手續費與稅金後匯入交割帳戶 (T+2)</span>
                  )}
                </div>
              </div>

              {/* 2. 標的商品區 (藍色調區塊) */}
              <div className="order-card-section section-stock">
                <div className="section-header">
                  <div className="section-title-wrap">
                    <span className="section-badge badge-stock">標的</span>
                    <span className="section-title">委託商品</span>
                  </div>
                  {currentPosition && (
                    <span className="holding-pill">
                      庫存: {Math.round(currentPosition.quantity).toLocaleString()} 股
                    </span>
                  )}
                </div>
                <div className="order-stock-picker">
                  <input
                    type="text"
                    className="form-input"
                    placeholder="輸入股號 (例: 2330)"
                    value={stockCode}
                    onChange={(e) => setStockCode(e.target.value.toUpperCase())}
                  />
                  {currentQuote && (
                    <div className="stock-quick-info">
                      <span className="quick-name">{currentQuote.name || stockCode}</span>
                      {currentQuote.last && currentQuote.last > 0 && (
                        <span className="quick-last">現價 {currentQuote.last.toFixed(2)}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* 3. 委託規格區 (紫色調區塊) */}
              <div className="order-card-section section-specs">
                <div className="section-header">
                  <div className="section-title-wrap">
                    <span className="section-badge badge-specs">規格</span>
                    <span className="section-title">交易時段與委託規格</span>
                  </div>
                </div>

                {/* 交易時段選擇：盤中 vs 盤後 */}
                <div className="specs-session-row">
                  <span className="specs-label">交易時段</span>
                  <div className="pill-toggle-group session-toggle-group">
                    <button
                      type="button"
                      className={`pill-toggle ${orderSession === 'normal' ? 'active' : ''}`}
                      onClick={() => setOrderSession('normal')}
                    >
                      {orderSession === 'normal' && <span className="pill-check-icon">✓</span>}
                      <span>☀️ 盤中委託 (09:00~13:30)</span>
                    </button>
                    <button
                      type="button"
                      className={`pill-toggle ${orderSession === 'after_hours' ? 'active active-after-hours' : ''}`}
                      onClick={() => {
                        setOrderSession('after_hours');
                        if (afterHoursLot === 'Fixing' && closingPriceVal > 0) {
                          setOrderPrice(closingPriceVal.toFixed(2));
                        }
                      }}
                    >
                      {orderSession === 'after_hours' && <span className="pill-check-icon">✓</span>}
                      <span>🌙 盤後交易 (13:40~14:30)</span>
                    </button>
                  </div>
                </div>

                {orderSession === 'normal' ? (
                  /* 盤中規格：單位 (整張/零股) + 條件 (限價/市價) */
                  <div className="specs-grid">
                    <div className="specs-col">
                      <span className="specs-label">單位</span>
                      <div className="pill-toggle-group">
                        <button
                          type="button"
                          className={`pill-toggle ${orderUnit === 'lot' ? 'active' : ''}`}
                          onClick={() => setOrderUnit('lot')}
                        >
                          {orderUnit === 'lot' && <span className="pill-check-icon">✓</span>}
                          <span>現股整股 (張)</span>
                        </button>
                        <button
                          type="button"
                          className={`pill-toggle ${orderUnit === 'share' ? 'active' : ''}`}
                          onClick={() => setOrderUnit('share')}
                        >
                          {orderUnit === 'share' && <span className="pill-check-icon">✓</span>}
                          <span>盤中零股 (股)</span>
                        </button>
                      </div>
                    </div>
                    <div className="specs-col">
                      <span className="specs-label">條件</span>
                      <div className="pill-toggle-group">
                        <button
                          type="button"
                          className={`pill-toggle ${orderType === 'limit' ? 'active' : ''}`}
                          onClick={() => setOrderType('limit')}
                        >
                          {orderType === 'limit' && <span className="pill-check-icon">✓</span>}
                          <span>限價 (ROD)</span>
                        </button>
                        <button
                          type="button"
                          className={`pill-toggle ${orderType === 'market' ? 'active' : ''}`}
                          onClick={() => {
                            setOrderType('market');
                            setOrderPrice('');
                          }}
                        >
                          {orderType === 'market' && <span className="pill-check-icon">✓</span>}
                          <span>市價</span>
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  /* 盤後規格：盤後定價(張) vs 盤後零股(股) */
                  <div className="specs-after-hours-box">
                    <div className="specs-col">
                      <span className="specs-label">盤後委託種類</span>
                      <div className="pill-toggle-group">
                        <button
                          type="button"
                          className={`pill-toggle ${afterHoursLot === 'Fixing' ? 'active active-after-hours' : ''}`}
                          onClick={() => {
                            setAfterHoursLot('Fixing');
                            if (closingPriceVal > 0) {
                              setOrderPrice(closingPriceVal.toFixed(2));
                            }
                          }}
                        >
                          {afterHoursLot === 'Fixing' && <span className="pill-check-icon">✓</span>}
                          <span>📌 盤後定價 (張)</span>
                        </button>
                        <button
                          type="button"
                          className={`pill-toggle ${afterHoursLot === 'Odd' ? 'active active-after-hours' : ''}`}
                          onClick={() => setAfterHoursLot('Odd')}
                        >
                          {afterHoursLot === 'Odd' && <span className="pill-check-icon">✓</span>}
                          <span>🪙 盤後零股 (股)</span>
                        </button>
                      </div>
                    </div>
                    <div className="specs-after-hours-tip">
                      {afterHoursLot === 'Fixing' ? (
                        <span>
                          💡 <strong>盤後定價交易</strong>：於 14:00~14:30 申報，14:30 依今日收盤價（NT$ {closingPriceVal > 0 ? closingPriceVal.toFixed(2) : '--'}）定價撮合，單位為「整張 (1,000股)」。
                        </span>
                      ) : (
                        <span>
                          💡 <strong>盤後零股交易</strong>：於 13:40~14:30 申報，14:30 進行集合競價撮合，單位為「股 (1~999股)」，依限價申報。
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 4. 委託價格區 (金黃/琥珀色調區塊) */}
              <div className="order-card-section section-price">
                <div className="section-header">
                  <div className="section-title-wrap">
                    <span className="section-badge badge-price">價格</span>
                    <span className="section-title">
                      {orderSession === 'after_hours' && afterHoursLot === 'Fixing'
                        ? '今日收盤定盤價 (NT$)'
                        : '委託價格 (NT$)'}
                    </span>
                  </div>
                  {orderSession === 'after_hours' && afterHoursLot === 'Fixing' && (
                    <span className="price-fixed-badge">🔒 今日收盤價撮合</span>
                  )}
                </div>
                <div className="order-price-control">
                  <input
                    type="number"
                    step="0.05"
                    className={`form-input ${orderSession === 'after_hours' && afterHoursLot === 'Fixing' ? 'input-price-fixed' : ''}`}
                    placeholder={
                      orderSession === 'after_hours' && afterHoursLot === 'Fixing'
                        ? `定盤價 NT$ ${closingPriceVal > 0 ? closingPriceVal.toFixed(2) : '--'}`
                        : effectivePriceType === 'market'
                        ? '市價委託'
                        : '輸入價格'
                    }
                    disabled={effectivePriceType === 'market' || (orderSession === 'after_hours' && afterHoursLot === 'Fixing')}
                    value={effectivePrice}
                    onChange={(e) => setOrderPrice(e.target.value)}
                  />
                  {effectivePriceType === 'limit' && !(orderSession === 'after_hours' && afterHoursLot === 'Fixing') && (
                    <div className="price-steppers">
                      <button
                        type="button"
                        className="btn-step"
                        onClick={() => {
                          const cur = parseFloat(orderPrice) || (lastPrice || 0);
                          setOrderPrice((cur - 0.5 > 0 ? (cur - 0.5).toFixed(2) : '0'));
                        }}
                      >
                        -0.5
                      </button>
                      <button
                        type="button"
                        className="btn-step"
                        onClick={() => {
                          const cur = parseFloat(orderPrice) || (lastPrice || 0);
                          setOrderPrice((cur + 0.5).toFixed(2));
                        }}
                      >
                        +0.5
                      </button>
                    </div>
                  )}
                </div>
                {/* 價格快捷鍵 */}
                {effectivePriceType === 'limit' && !(orderSession === 'after_hours' && afterHoursLot === 'Fixing') && (
                  <div className="quick-chips-row">
                    {limitDown && (
                      <button
                        type="button"
                        className="chip-btn chip-down"
                        onClick={() => setOrderPrice(limitDown)}
                      >
                        跌停 {limitDown}
                      </button>
                    )}
                    {prevClose && prevClose > 0 && (
                      <button
                        type="button"
                        className="chip-btn chip-prev"
                        onClick={() => setOrderPrice(prevClose.toFixed(2))}
                      >
                        平盤 {prevClose.toFixed(2)}
                      </button>
                    )}
                    {lastPrice && lastPrice > 0 && (
                      <button
                        type="button"
                        className="chip-btn chip-last"
                        onClick={() => setOrderPrice(lastPrice.toFixed(2))}
                      >
                        現價 {lastPrice.toFixed(2)}
                      </button>
                    )}
                    {limitUp && (
                      <button
                        type="button"
                        className="chip-btn chip-up"
                        onClick={() => setOrderPrice(limitUp)}
                      >
                        漲停 {limitUp}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* 5. 委託數量區 (青藍色調區塊) */}
              <div className="order-card-section section-qty">
                <div className="section-header">
                  <div className="section-title-wrap">
                    <span className="section-badge badge-qty">數量</span>
                    <span className="section-title">
                      委託數量 ({effectiveUnit === 'lot' ? '張 (1,000股)' : '股'})
                    </span>
                  </div>
                  {currentPosition && (
                    <button
                      type="button"
                      className="btn-fill-holding"
                      onClick={() => {
                        if (effectiveUnit === 'lot') {
                          setOrderQty(Math.max(1, Math.floor(currentPosition.quantity / 1000)));
                        } else {
                          const oddPart = currentPosition.quantity % 1000;
                          setOrderQty(oddPart > 0 ? oddPart : Math.round(currentPosition.quantity));
                        }
                      }}
                      title="帶入庫存數量"
                    >
                      帶入庫存全數 ({Math.round(currentPosition.quantity).toLocaleString()} 股)
                    </button>
                  )}
                </div>
                <div className="order-qty-control">
                  <button
                    type="button"
                    className="btn-step"
                    onClick={() => setOrderQty((q) => Math.max(1, q - 1))}
                  >
                    -
                  </button>
                  <input
                    type="number"
                    min="1"
                    className="form-input qty-input"
                    value={orderQty}
                    onChange={(e) => setOrderQty(Math.max(1, parseInt(e.target.value) || 1))}
                  />
                  <button
                    type="button"
                    className="btn-step"
                    onClick={() => setOrderQty((q) => q + 1)}
                  >
                    +
                  </button>
                </div>
              </div>

              {/* 6. 金額試算與交割款項明細區 (紅/綠強對比區分) */}
              <div className={`order-calc-card ${orderAction === 'buy' ? 'calc-buy' : 'calc-sell'}`}>
                <div className="calc-card-header">
                  <span className="calc-card-title">
                    {orderSession === 'after_hours'
                      ? (orderAction === 'buy' ? '🌙 盤後買進交割扣款試算' : '🌙 盤後賣出交割入帳試算')
                      : (orderAction === 'buy' ? '🔴 買進交割扣款試算' : '🟢 賣出交割入帳試算')}
                  </span>
                  <span className="calc-note">
                    {orderAction === 'buy' ? '由銀行交割戶扣款' : '匯入銀行交割戶'}
                  </span>
                </div>
                <div className="calc-row">
                  <span>預估成交價金</span>
                  <span>{estimatedAmount.toLocaleString()} 元</span>
                </div>
                <div className="calc-row">
                  <span>預估手續費 (0.1425%)</span>
                  <span>{estimatedFee.toLocaleString()} 元</span>
                </div>
                {orderAction === 'sell' && (
                  <div className="calc-row">
                    <span>預估證交稅 ({isEtf ? '0.1%' : '0.3%'})</span>
                    <span>{estimatedTax.toLocaleString()} 元</span>
                  </div>
                )}
                <div className="calc-row calc-total">
                  <span>預估應{orderAction === 'buy' ? '付總額 (交割扣款)' : '收總額 (交割入帳)'}</span>
                  <span className={orderAction === 'buy' ? 'color-up' : 'color-down'}>
                    {estimatedTotal.toLocaleString()} 元
                  </span>
                </div>
              </div>

              {/* 7. 送出委託按鈕 */}
              <button
                type="submit"
                disabled={isSubmitting}
                className={`btn-order-submit ${orderAction === 'buy' ? 'submit-buy' : 'submit-sell'} ${isSubmitting ? 'submitting' : ''}`}
              >
                {isSubmitting ? (
                  <span>⏳ 正在送出委託至券商...</span>
                ) : (
                  orderAction === 'buy'
                    ? `🔴 確認${orderSession === 'after_hours' ? '【盤後買進】' : '買進'}【${stockCode || '---'}】(扣款 NT$ ${estimatedTotal.toLocaleString()})`
                    : `🟢 確認${orderSession === 'after_hours' ? '【盤後賣出】' : '賣出'}【${stockCode || '---'}】(入帳 NT$ ${estimatedTotal.toLocaleString()})`
                )}
              </button>
                </form>
              </>
            ) : (
              /* ==================== 今日交易單檢視區 ==================== */
              <div className="orders-management-view">
                <div className="orders-mgmt-header">
                  <div className="orders-mgmt-title">
                    <span>今日委託單紀錄</span>
                    <span className="orders-count-tag">共 {orders.length} 筆</span>
                  </div>
                  <div className="orders-mgmt-actions">
                    <button
                      type="button"
                      className="btn-clear-orders"
                      onClick={handleClearOrders}
                      disabled={isClearingOrders || orders.length === 0}
                      title={orders.length === 0 ? "目前尚無委託單可清空" : "清空目前顯示的歷史委託單紀錄"}
                    >
                      {isClearingOrders ? '🧹 清空中...' : '🧹 清空歷史單'}
                    </button>
                    <button
                      type="button"
                      className={`btn-reload-orders ${isLoadingOrders ? 'loading' : ''}`}
                      onClick={loadOrders}
                      disabled={isLoadingOrders}
                      title="立即更新委託單狀態"
                    >
                      {isLoadingOrders ? '🔄 更新中...' : '🔄 整理'}
                    </button>
                  </div>
                </div>

                {/* 篩選標籤 */}
                <div className="orders-filter-chips">
                  <button
                    type="button"
                    className={`filter-chip ${orderFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setOrderFilter('all')}
                  >
                    全部 ({orders.length})
                  </button>
                  <button
                    type="button"
                    className={`filter-chip ${orderFilter === 'active' ? 'active' : ''}`}
                    onClick={() => setOrderFilter('active')}
                  >
                    委託中 ({orders.filter((o) => o.canCancel).length})
                  </button>
                  <button
                    type="button"
                    className={`filter-chip ${orderFilter === 'filled' ? 'active' : ''}`}
                    onClick={() => setOrderFilter('filled')}
                  >
                    已成交 ({orders.filter((o) => o.status === 'Filled').length})
                  </button>
                  <button
                    type="button"
                    className={`filter-chip ${orderFilter === 'cancelled' ? 'active' : ''}`}
                    onClick={() => setOrderFilter('cancelled')}
                  >
                    已取消 ({orders.filter((o) => o.status === 'Cancelled' || o.status === 'Failed').length})
                  </button>
                </div>

                {/* 委託單列表卡片 */}
                <div className="orders-cards-list">
                  {filteredOrders.length === 0 ? (
                    <div className="orders-empty-state">
                      <div className="empty-icon">📭</div>
                      <div className="empty-text">今日尚無符合條件的委託單</div>
                      <div className="empty-subtext">（每日 15:00 收盤後自動歸檔清空，不影響次日交易）</div>
                      <button
                        type="button"
                        className="btn-goto-order"
                        onClick={() => setOrderSubTab('form')}
                      >
                        ✍️ 前往下單
                      </button>
                    </div>
                  ) : (
                    filteredOrders.map((order) => {
                      const isOdd = order.orderLot === 'IntradayOdd' || order.orderLot === 'Odd';
                      const unitStr = isOdd ? '股' : '張';
                      const hasModifiedPrice = !!(order.modifiedPrice && order.modifiedPrice !== order.price);

                      return (
                        <div
                          key={order.id}
                          className={`order-item-card action-${order.action.toLowerCase()} status-${order.status.toLowerCase()}`}
                        >
                          <div className="order-card-top">
                            <div className="order-card-stock">
                              <span className={`order-action-pill pill-${order.action.toLowerCase()}`}>
                                {order.action === 'Buy' ? '買進' : '賣出'}
                              </span>
                              <span className="order-stock-code">{order.code}</span>
                              <span className="order-stock-name">{order.name}</span>
                              <span className={`order-lot-tag tag-lot-${order.orderLot.toLowerCase()}`}>
                                {order.orderLot === 'Fixing'
                                  ? '🌙 盤後定價'
                                  : order.orderLot === 'Odd'
                                  ? '🌙 盤後零股'
                                  : order.orderLot === 'IntradayOdd'
                                  ? '盤中零股'
                                  : '現股整張'}
                              </span>
                            </div>
                            <div className="order-status-badge">
                              <span className={`status-pill pill-${order.status.toLowerCase()}`}>
                                {order.status === 'Submitted' && '掛單中'}
                                {order.status === 'PartFilled' && '部分成交'}
                                {order.status === 'Filled' && '全部成交'}
                                {order.status === 'Cancelled' && '已取消'}
                                {order.status === 'Failed' && '委託失敗'}
                                {order.status === 'PendingSubmit' && '傳送中'}
                                {order.status === 'PreSubmitted' && '預約單'}
                              </span>
                            </div>
                          </div>

                          <div className="order-card-details">
                            <div className="detail-item">
                              <span className="detail-label">委託價格</span>
                              <span className="detail-val price-val">
                                NT$ {order.price.toFixed(2)}
                                {hasModifiedPrice && (
                                  <span className="modified-price-badge">
                                    (改: {order.modifiedPrice?.toFixed(2)})
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="detail-item">
                              <span className="detail-label">委託量 / 已成交</span>
                              <span className="detail-val">
                                {order.qty.toLocaleString()} {unitStr}
                                {order.dealQty > 0 && (
                                  <span className="filled-qty-badge">
                                    (成 {order.dealQty.toLocaleString()} {unitStr})
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="detail-item full-row">
                              <span className="detail-label">委託時間 / 書號</span>
                              <span className="detail-val meta-val">
                                {order.time ? order.time.slice(11, 19) : '--:--:--'}
                                {order.ordno ? ` #${order.ordno}` : ''}
                                <span className="order-id-sub"> ({order.id.slice(0, 8)})</span>
                              </span>
                            </div>
                          </div>

                          {/* 動作按鈕：僅在可撤單/委託中狀態顯示 */}
                          {order.canCancel && (
                            <div className="order-card-actions">
                              {/* 依交易所規定：盤後交易（定價與零股）均不可改價，僅盤中委託支援改價 */}
                              {order.orderLot !== 'Fixing' && order.orderLot !== 'Odd' && (order.canUpdatePrice ?? true) && (
                                <button
                                  type="button"
                                  className="btn-card-action btn-edit-price"
                                  onClick={() => handleStartEditPrice(order)}
                                  title="修改此筆委託價格"
                                >
                                  ✏️ 改價
                                </button>
                              )}
                              {/* 依交易所規定：剩餘委託量大於 1 時才可減量，若剩餘委託量僅 1 則必須直接撤單 */}
                              {order.qty > 1 && (order.canUpdateQty ?? true) && (
                                <button
                                  type="button"
                                  className="btn-card-action btn-edit-qty"
                                  onClick={() => handleStartEditQty(order)}
                                  title="減少委託數量"
                                >
                                  ✂️ 改量
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn-card-action btn-cancel-order"
                                onClick={() => setCancellingOrder(order)}
                                title="撤銷此筆委託"
                              >
                                🗑️ 撤單
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* ==================== 撤單確認彈窗 (Modal) ==================== */}
            {cancellingOrder && createPortal(
              <div className="order-modal-overlay" onClick={() => !isCancelling && setCancellingOrder(null)}>
                <div className="order-modal-card" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-header">
                    <span className="modal-title">🗑️ 確認撤銷委託單</span>
                    <button
                      type="button"
                      className="btn-modal-close"
                      disabled={isCancelling}
                      onClick={() => setCancellingOrder(null)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="modal-body">
                    <p className="modal-desc">您即將向券商申請撤銷此筆掛單：</p>
                    <div className="modal-summary-box">
                      <div className="summary-row">
                        <span className="label">標的商品：</span>
                        <span className="val bold">{cancellingOrder.code} {cancellingOrder.name}</span>
                      </div>
                      <div className="summary-row">
                        <span className="label">買賣方向：</span>
                        <span className={`val bold ${cancellingOrder.action === 'Buy' ? 'color-up' : 'color-down'}`}>
                          {cancellingOrder.action === 'Buy' ? '🔴 買進' : '🟢 賣出'}
                        </span>
                      </div>
                      <div className="summary-row">
                        <span className="label">委託規格：</span>
                        <span className="val">
                          {cancellingOrder.orderLot === 'Fixing'
                            ? '🌙 盤後定價'
                            : cancellingOrder.orderLot === 'Odd'
                            ? '🌙 盤後零股'
                            : cancellingOrder.orderLot === 'IntradayOdd'
                            ? '盤中零股'
                            : '盤中整張'} @ NT$ {cancellingOrder.price.toFixed(2)}
                        </span>
                      </div>
                      <div className="summary-row">
                        <span className="label">剩餘委託量：</span>
                        <span className="val bold">
                          {cancellingOrder.qty.toLocaleString()} {cancellingOrder.orderLot === 'Common' || cancellingOrder.orderLot === 'Fixing' ? '張' : '股'}
                        </span>
                      </div>
                    </div>
                    <p className="modal-warning-text">⚠️ 撤單確認後將自市場撤回剩餘委託量，無法復原。</p>
                  </div>
                  <div className="modal-footer">
                    <button
                      type="button"
                      className="btn-modal-cancel"
                      disabled={isCancelling}
                      onClick={() => setCancellingOrder(null)}
                    >
                      返回
                    </button>
                    <button
                      type="button"
                      className="btn-modal-confirm confirm-danger"
                      disabled={isCancelling}
                      onClick={handleConfirmCancel}
                    >
                      {isCancelling ? '撤單處理中...' : '確認撤銷委託'}
                    </button>
                  </div>
                </div>
              </div>,
              document.body
            )}

            {/* ==================== 改價彈窗 (Modal) ==================== */}
            {editingPriceOrder && createPortal(
              <div className="order-modal-overlay" onClick={() => !isUpdatingPrice && setEditingPriceOrder(null)}>
                <div className="order-modal-card" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-header">
                    <span className="modal-title">✏️ 修改委託價格</span>
                    <button
                      type="button"
                      className="btn-modal-close"
                      disabled={isUpdatingPrice}
                      onClick={() => setEditingPriceOrder(null)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="modal-body">
                    <div className="modal-summary-box">
                      <div className="summary-row">
                        <span className="label">標的：</span>
                        <span className="val bold">{editingPriceOrder.code} {editingPriceOrder.name}</span>
                      </div>
                      <div className="summary-row">
                        <span className="label">委託類別：</span>
                        <span className="val">
                          {editingPriceOrder.orderLot === 'Common' ? '整張' : '盤中零股'} / {editingPriceOrder.qty.toLocaleString()} {editingPriceOrder.orderLot === 'Common' ? '張' : '股'}
                        </span>
                      </div>
                      <div className="summary-row">
                        <span className="label">目前委託價：</span>
                        <span className="val bold">NT$ {editingPriceOrder.price.toFixed(2)}</span>
                      </div>
                    </div>

                    {editingPriceOrder.orderLot === 'IntradayOdd' && (
                      <div className="modal-info-tip">
                        💡 盤中零股依法規無法直接改價，系統將以智慧模式自動「撤單並重下新價」。
                      </div>
                    )}

                    <div className="modal-input-section">
                      <label className="input-label">請輸入新價格 (TWD)</label>
                      <div className="order-price-control">
                        <button
                          type="button"
                          className="btn-step"
                          onClick={() => {
                            const curr = parseFloat(newPriceInput) || editingPriceOrder.price;
                            const step = curr < 10 ? 0.01 : curr < 50 ? 0.05 : curr < 100 ? 0.1 : curr < 500 ? 0.5 : 1.0;
                            setNewPriceInput(Math.max(0.01, curr - step).toFixed(2));
                          }}
                        >
                          -
                        </button>
                        <input
                          type="number"
                          step="any"
                          className="form-input price-input"
                          value={newPriceInput}
                          onChange={(e) => setNewPriceInput(e.target.value)}
                        />
                        <button
                          type="button"
                          className="btn-step"
                          onClick={() => {
                            const curr = parseFloat(newPriceInput) || editingPriceOrder.price;
                            const step = curr < 10 ? 0.01 : curr < 50 ? 0.05 : curr < 100 ? 0.1 : curr < 500 ? 0.5 : 1.0;
                            setNewPriceInput((curr + step).toFixed(2));
                          }}
                        >
                          +
                        </button>
                      </div>

                      {quotes[editingPriceOrder.code] && (
                        <div className="quick-price-chips modal-chips">
                          {quotes[editingPriceOrder.code].last && quotes[editingPriceOrder.code].last! > 0 && (
                            <button
                              type="button"
                              className="chip-btn chip-last"
                              onClick={() => setNewPriceInput(quotes[editingPriceOrder.code].last!.toFixed(2))}
                            >
                              現價 {quotes[editingPriceOrder.code].last!.toFixed(2)}
                            </button>
                          )}
                          {quotes[editingPriceOrder.code].previousClose && (
                            <button
                              type="button"
                              className="chip-btn chip-prev"
                              onClick={() => setNewPriceInput(quotes[editingPriceOrder.code].previousClose!.toFixed(2))}
                            >
                              平盤 {quotes[editingPriceOrder.code].previousClose!.toFixed(2)}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="modal-footer">
                    <button
                      type="button"
                      className="btn-modal-cancel"
                      disabled={isUpdatingPrice}
                      onClick={() => setEditingPriceOrder(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="btn-modal-confirm confirm-primary"
                      disabled={isUpdatingPrice}
                      onClick={handleConfirmUpdatePrice}
                    >
                      {isUpdatingPrice ? '改價處理中...' : '確認修改價格'}
                    </button>
                  </div>
                </div>
              </div>,
              document.body
            )}

            {/* ==================== 改量(減量)彈窗 (Modal) ==================== */}
            {editingQtyOrder && createPortal(
              <div className="order-modal-overlay" onClick={() => !isUpdatingQty && setEditingQtyOrder(null)}>
                <div className="order-modal-card" onClick={(e) => e.stopPropagation()}>
                  <div className="modal-header">
                    <span className="modal-title">✂️ 修改委託數量 (減量)</span>
                    <button
                      type="button"
                      className="btn-modal-close"
                      disabled={isUpdatingQty}
                      onClick={() => setEditingQtyOrder(null)}
                    >
                      ✕
                    </button>
                  </div>
                  {(() => {
                    const isLotOrder = editingQtyOrder.orderLot === 'Common' || editingQtyOrder.orderLot === 'Fixing';
                    const unitStr = isLotOrder ? '張' : '股';
                    const isSingleQty = editingQtyOrder.qty <= 1;
                    const maxAllowedQty = Math.max(1, editingQtyOrder.qty - 1);

                    return (
                      <>
                        <div className="modal-body">
                          <div className="modal-summary-box">
                            <div className="summary-row">
                              <span className="label">標的：</span>
                              <span className="val bold">{editingQtyOrder.code} {editingQtyOrder.name}</span>
                            </div>
                            <div className="summary-row">
                              <span className="label">目前委託量：</span>
                              <span className="val bold">
                                {editingQtyOrder.qty.toLocaleString()} {unitStr}
                              </span>
                            </div>
                            <div className="summary-row">
                              <span className="label">委託類別：</span>
                              <span className="val">
                                {editingQtyOrder.orderLot === 'Fixing'
                                  ? '🌙 盤後定價'
                                  : editingQtyOrder.orderLot === 'Odd'
                                  ? '🌙 盤後零股'
                                  : editingQtyOrder.orderLot === 'IntradayOdd'
                                  ? '盤中零股'
                                  : '盤中整張'}
                              </span>
                            </div>
                          </div>

                          {isSingleQty ? (
                            <div className="modal-warning-box">
                              ⚠️ <strong>無法減量提示</strong>：目前剩餘委託量僅有 <strong>1 {unitStr}</strong>。依交易所規範減量後必須大於 0（不能減為 0）。若欲全數取消此筆委託，請關閉此視窗並直接點選「<strong>🗑️ 撤單</strong>」。
                            </div>
                          ) : (
                            <div className="modal-warning-box">
                              ⚠️ 依交易所規範，委託單僅支援「減量」（減少剩餘委託量），無法增加數量。如需增量請另外新增委託單。
                            </div>
                          )}

                          {!isSingleQty && (
                            <div className="modal-input-section">
                              <label className="input-label">
                                變更後的新委託數量 ({unitStr})
                              </label>
                              <div className="order-qty-control">
                                <button
                                  type="button"
                                  className="btn-step"
                                  onClick={() => setNewQtyInput((q) => Math.max(1, q - 1))}
                                  disabled={newQtyInput <= 1}
                                >
                                  -
                                </button>
                                <input
                                  type="number"
                                  min="1"
                                  max={maxAllowedQty}
                                  className="form-input qty-input"
                                  value={newQtyInput}
                                  onChange={(e) => {
                                    const val = parseInt(e.target.value) || 1;
                                    setNewQtyInput(Math.max(1, Math.min(maxAllowedQty, val)));
                                  }}
                                />
                                <button
                                  type="button"
                                  className="btn-step"
                                  onClick={() => setNewQtyInput((q) => Math.min(maxAllowedQty, q + 1))}
                                  disabled={newQtyInput >= maxAllowedQty}
                                >
                                  +
                                </button>
                              </div>

                              <div className="quick-qty-chips modal-chips">
                                {isLotOrder ? (
                                  editingQtyOrder.qty > 2 && (
                                    <button
                                      type="button"
                                      className="chip-btn"
                                      onClick={() => setNewQtyInput(Math.max(1, Math.floor(editingQtyOrder.qty / 2)))}
                                    >
                                      減半至 {Math.max(1, Math.floor(editingQtyOrder.qty / 2))} 張
                                    </button>
                                  )
                                ) : (
                                  <>
                                    {editingQtyOrder.qty > 200 && (
                                      <button
                                        type="button"
                                        className="chip-btn"
                                        onClick={() => setNewQtyInput(Math.max(1, Math.floor(editingQtyOrder.qty / 2)))}
                                      >
                                        減半至 {Math.max(1, Math.floor(editingQtyOrder.qty / 2))} 股
                                      </button>
                                    )}
                                    {editingQtyOrder.qty > 100 && (
                                      <button
                                        type="button"
                                        className="chip-btn"
                                        onClick={() => setNewQtyInput(Math.max(1, editingQtyOrder.qty - 100))}
                                      >
                                        減 100 股 (剩 {editingQtyOrder.qty - 100} 股)
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>

                              <div className="reduction-preview">
                                本次將自市場減少委託：<strong>{(editingQtyOrder.qty - newQtyInput).toLocaleString()}</strong> {unitStr}（變更後剩餘 {newQtyInput.toLocaleString()} {unitStr}）
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="modal-footer">
                          <button
                            type="button"
                            className="btn-modal-cancel"
                            disabled={isUpdatingQty}
                            onClick={() => setEditingQtyOrder(null)}
                          >
                            取消
                          </button>
                          {!isSingleQty && (
                            <button
                              type="button"
                              className="btn-modal-confirm confirm-warning"
                              disabled={isUpdatingQty || newQtyInput >= editingQtyOrder.qty || newQtyInput <= 0}
                              onClick={handleConfirmUpdateQty}
                            >
                              {isUpdatingQty ? '減量處理中...' : '確認減少數量'}
                            </button>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>,
              document.body
            )}

            {/* 4. 下單前雙重防護確認視窗 (超大字眼買入/賣出警示) */}
            {isConfirmModalOpen && createPortal(
              <div className="order-modal-overlay" onClick={() => !isSubmitting && setIsConfirmModalOpen(false)}>
                <div
                  className={`order-modal-card order-confirm-modal ${orderAction === 'buy' ? 'modal-theme-buy' : 'modal-theme-sell'}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* 超大視覺焦點：買入 / 賣出 頂部橫幅 */}
                  <div className={`order-confirm-hero hero-${orderAction}`}>
                    <div className="hero-alert-badge">
                      <span>
                        {orderSession === 'after_hours'
                          ? '🌙 盤後交易安全防護確認 (14:30 撮合)'
                          : isHighValueBuy
                          ? '🚨 大額交易安全強烈防護 (買入 ≥ 30萬)'
                          : '⚠️ 下單安全防護確認'}
                      </span>
                    </div>
                    <div className="hero-action-headline">
                      {orderSession === 'after_hours'
                        ? (orderAction === 'buy' ? '盤後買入' : '盤後賣出')
                        : (orderAction === 'buy' ? '買　入' : '賣　出')}
                    </div>
                    <div className="hero-action-sub">
                      {orderSession === 'after_hours'
                        ? (afterHoursLot === 'Fixing'
                            ? `🌙 本筆為【盤後定價委託】，將依今日收盤價 NT$ ${closingPriceVal.toFixed(2)} 於 14:30 定價撮合！`
                            : '🌙 本筆為【盤後零股委託】，將於 14:30 集合競價一次性撮合！')
                        : orderAction === 'buy'
                        ? (isHighValueBuy
                            ? '🚨 本筆買入委託金額高達 30 萬元以上！請審慎確認標的與金額無誤！'
                            : '🔴 即將送出【買進】委託，成交後將自銀行交割戶扣款！')
                        : '🟢 即將送出【賣出】委託，成交後將扣除稅費並匯入交割帳戶！'}
                    </div>
                  </div>

                  <div className="modal-body confirm-modal-body">
                    <div className="confirm-details-table">
                      <div className="confirm-detail-row">
                        <span className="detail-label">委託商品</span>
                        <span className="detail-value stock-name-highlight">
                          <strong>{stockCode}</strong> {currentQuote?.name || currentPosition?.name || ''}
                        </span>
                      </div>
                      <div className="confirm-detail-row">
                        <span className="detail-label">交易方向</span>
                        <span className={`detail-value action-tag-badge tag-${orderAction}`}>
                          {orderAction === 'buy' ? '🔴 買入 (BUY)' : '🟢 賣出 (SELL)'}
                        </span>
                      </div>
                      <div className="confirm-detail-row">
                        <span className="detail-label">交易類別</span>
                        <span className="detail-value">
                          {orderSession === 'after_hours'
                            ? (afterHoursLot === 'Fixing' ? '🌙 盤後定價 (張)' : '🌙 盤後零股 (股)')
                            : (orderUnit === 'lot' ? '盤中整股 (張)' : '盤中零股 (股)')}
                        </span>
                      </div>
                      <div className="confirm-detail-row">
                        <span className="detail-label">委託價格</span>
                        <span className="detail-value price-highlight">
                          {orderSession === 'after_hours' && afterHoursLot === 'Fixing'
                            ? `今日收盤定價 NT$ ${closingPriceVal.toFixed(2)}`
                            : effectivePriceType === 'market'
                            ? '市價'
                            : `NT$ ${(parseFloat(effectivePrice) || 0).toFixed(2)}`}
                        </span>
                      </div>
                      <div className="confirm-detail-row">
                        <span className="detail-label">委託數量</span>
                        <span className="detail-value qty-highlight">
                          <strong>{orderQty.toLocaleString()}</strong> {effectiveUnit === 'lot' ? '張 (1,000股)' : '股'}
                        </span>
                      </div>
                      <div className={`confirm-detail-row total-row ${isHighValueBuy ? 'total-row-high-value' : ''}`}>
                        <span className="detail-label">
                          預估{orderAction === 'buy' ? '交割扣款' : '交割入帳'}
                        </span>
                        <span className={`detail-value total-highlight ${orderAction === 'buy' ? 'color-up' : 'color-down'} ${isHighValueBuy ? 'critical-amount-flashing' : ''}`}>
                          NT$ {estimatedTotal.toLocaleString()} 元
                          {isHighValueBuy && <span className="huge-amount-badge">🚨 ≥30萬大額</span>}
                        </span>
                      </div>
                    </div>

                    {isHighValueBuy ? (
                      <div className="confirm-huge-amount-alert">
                        <div className="huge-alert-title">
                          <span className="huge-alert-icon">🚨</span>
                          <span>大額買入強烈防護警示（金額達 NT$ {estimatedTotal.toLocaleString()} 元）</span>
                        </div>
                        <div className="huge-alert-msg">
                          ⚠️ 本筆買入金額已達 <strong>30 萬元</strong>！為防止大額誤下單，請輸入交易安全密碼以解鎖送出委託。
                        </div>
                        <div className="huge-alert-pin-input-wrap">
                          <label className="pin-input-label" htmlFor="high-value-pin-input">
                            🔑 安全密碼：
                          </label>
                          <input
                            id="high-value-pin-input"
                            type="password"
                            inputMode="numeric"
                            maxLength={12}
                            className={`pin-confirm-input ${isPinCorrect ? 'pin-valid' : confirmPin ? 'pin-invalid' : ''}`}
                            placeholder="••••"
                            value={confirmPin}
                            onChange={(e) => setConfirmPin(e.target.value.trim())}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && isPinCorrect && !isSubmitting) {
                                handleExecuteOrder();
                              }
                            }}
                            autoFocus
                          />
                          {isPinCorrect ? (
                            <span className="pin-status pin-pass">✅ 密碼正確已解鎖</span>
                          ) : confirmPin.length > 0 ? (
                            <span className="pin-status pin-error">❌ 密碼錯誤</span>
                          ) : (
                            <span className="pin-status pin-pending">🔒 請輸入安全密碼解鎖</span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className={`confirm-attention-box alert-${orderAction}`}>
                        <strong>注意：</strong>
                        {orderSession === 'after_hours'
                          ? `本筆為【盤後委託單】，將於 14:30 進行一次性撮合。請確認標的、方向與數量無誤。`
                          : <>請確認委託方向為【<span className={`bold-action ${orderAction}`}>{orderAction === 'buy' ? '買入' : '賣出'}</span>】，避免操作錯誤。</>}
                      </div>
                    )}
                  </div>

                  <div className="modal-footer confirm-modal-footer">
                    <button
                      type="button"
                      className="btn-modal-cancel"
                      disabled={isSubmitting}
                      onClick={() => setIsConfirmModalOpen(false)}
                    >
                      取消 (回上一步)
                    </button>
                    <button
                      type="button"
                      className={`btn-modal-confirm ${orderAction === 'buy' ? 'btn-confirm-buy' : 'btn-confirm-sell'} ${isHighValueBuy && !isPinCorrect ? 'btn-confirm-locked' : ''}`}
                      disabled={isSubmitting || (isHighValueBuy && !isPinCorrect)}
                      onClick={handleExecuteOrder}
                      autoFocus={!isHighValueBuy}
                    >
                      {isSubmitting ? (
                        '⏳ 委託送出中...'
                      ) : isHighValueBuy && !isPinCorrect ? (
                        '🔒 請輸入安全密碼解鎖'
                      ) : orderAction === 'buy' ? (
                        `🔴 確認【${orderSession === 'after_hours' ? '盤後買入' : '買入'}】${stockCode}`
                      ) : (
                        `🟢 確認【${orderSession === 'after_hours' ? '盤後賣出' : '賣出'}】${stockCode}`
                      )}
                    </button>
                  </div>
                </div>
              </div>,
              document.body
            )}
          </div>
        ) : (
          /* ==================== 分頁三：資金餘額 ==================== */
          <BalanceTab />
        )}
      </div>
    </aside>
  );
};
