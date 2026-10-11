import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { WatchlistGroup, QuoteState, UpstreamStatus, WebSocketMessage } from './types';
import {
  fetchBootstrap,
  createGroup,
  updateGroup,
  deleteGroup,
  addItem,
  removeItem,
  reorderItems,
} from './services/api';
import { wsClient } from './services/websocket';
import { Header } from './components/Header';
import { GroupTabs } from './components/GroupTabs';
import { QuoteTable } from './components/QuoteTable';
import { CompactCardList } from './components/CompactCardList';
import { GroupModal } from './components/GroupModal';
import './App.css';

export const App: React.FC = () => {
  const [groups, setGroups] = useState<WatchlistGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Record<string, QuoteState>>({});
  const [dirtyCodes, setDirtyCodes] = useState<Set<string>>(new Set());
  const [upstream, setUpstream] = useState<UpstreamStatus>({
    connected: false,
    loggedIn: false,
    lastQuoteTime: null,
    subscribedCount: 0,
    maxAllowed: 200,
    isMarketOpen: false,
    marketMode: 'auto',
  });
  const [wsConnected, setWsConnected] = useState(false);
  const [modalState, setModalState] = useState<{ isOpen: boolean; mode: 'create' | 'edit' }>({
    isOpen: false,
    mode: 'create',
  });
  const [wealthSummary, setWealthSummary] = useState<{
    totalPnl: number;
    totalCost: number;
    totalMarketValue: number;
    returnPercent: number;
  } | null>(null);
  const [marketIndices, setMarketIndices] = useState<Record<string, {
    code: string;
    name: string;
    price: number;
    change: number;
    changePercent: number;
  }> | null>(null);

  // 檢視模式：電腦預設為 'table' (完整表格)，手機預設為 'card' (兩行卡片)
  const [viewMode, setViewMode] = useState<'table' | 'card'>(() => {
    const saved = localStorage.getItem('stock_browser_view_mode');
    if (saved === 'table' || saved === 'card') return saved;
    return typeof window !== 'undefined' && window.innerWidth <= 768 ? 'card' : 'table';
  });

  // 主題模式：'light' (日間) 或 'dark' (夜間)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('stock_browser_theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('stock_browser_theme', theme);
  }, [theme]);

  const handleToggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const handleToggleViewMode = (mode: 'table' | 'card') => {
    setViewMode(mode);
    localStorage.setItem('stock_browser_view_mode', mode);
  };

  const flashTimerRef = useRef<number | null>(null);

  // 載入初始 Bootstrap
  const loadBootstrap = useCallback(async () => {
    try {
      const data = await fetchBootstrap();
      setGroups(data.groups);
      setQuotes((prev) => ({ ...prev, ...data.quotes }));
      setUpstream(data.upstream);
      if (data.wealthSummary) {
        setWealthSummary(data.wealthSummary);
      }
      if (data.marketIndices) {
        setMarketIndices(data.marketIndices);
      }
      setActiveGroupId((prev) => {
        if (prev && data.groups.some((g) => g.id === prev)) return prev;
        return data.groups[0]?.id || null;
      });
    } catch (e) {
      console.error('Failed to load bootstrap data:', e);
    }
  }, []);

  useEffect(() => {
    loadBootstrap();

    // 註冊 WebSocket 連線與訊息監聽
    wsClient.connect();
    const unsubStatus = wsClient.onStatus((connected) => {
      setWsConnected(connected);
    });

    const unsubMsg = wsClient.onMessage((msg: WebSocketMessage) => {
      if (msg.type === 'snapshot') {
        const nextQuotes: Record<string, QuoteState> = {};
        for (const q of msg.quotes) {
          nextQuotes[q.code] = q;
        }
        setQuotes((prev) => ({ ...prev, ...nextQuotes }));
      } else if (msg.type === 'quote_delta') {
        const changedCodes = new Set<string>();
        setQuotes((prev) => {
          const next = { ...prev };
          for (const q of msg.quotes) {
            next[q.code] = q;
            changedCodes.add(q.code);
          }
          return next;
        });

        // 觸發閃爍效果
        setDirtyCodes(changedCodes);
        if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = window.setTimeout(() => {
          setDirtyCodes(new Set());
        }, 700);
      } else if (msg.type === 'watchlist_changed') {
        // 自選清單異動，重新抓取 bootstrap
        loadBootstrap();
      }
    });

    // 處理頁面從休眠 / 背景返回前景
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadBootstrap();
        if (!wsClient.isConnected) {
          wsClient.connect();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      unsubStatus();
      unsubMsg();
      wsClient.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    };
  }, [loadBootstrap]);

  // 目前選取的群組
  const activeGroup = groups.find((g) => g.id === activeGroupId) || groups[0] || null;

  // 新增個股
  const handleAddStock = async (code: string) => {
    if (!activeGroup) return;
    await addItem(activeGroup.id, code);
    await loadBootstrap();
  };

  // 移除個股
  const handleRemoveStock = async (code: string) => {
    if (!activeGroup) return;
    await removeItem(activeGroup.id, code);
    await loadBootstrap();
  };

  // 移動排序
  const handleMoveStock = async (index: number, direction: 'up' | 'down') => {
    if (!activeGroup) return;
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= activeGroup.items.length) return;

    const newItems = [...activeGroup.items];
    const temp = newItems[index];
    newItems[index] = newItems[targetIdx];
    newItems[targetIdx] = temp;

    // 樂觀更新
    const nextCodes = newItems.map((i) => i.code);
    setGroups((prev) =>
      prev.map((g) => (g.id === activeGroup.id ? { ...g, items: newItems } : g))
    );
    await reorderItems(activeGroup.id, nextCodes);
  };

  // 拖曳任意位置排序
  const handleReorderItems = async (fromIndex: number, toIndex: number) => {
    if (!activeGroup) return;
    const newItems = [...activeGroup.items];
    const [moved] = newItems.splice(fromIndex, 1);
    newItems.splice(toIndex, 0, moved);

    const nextCodes = newItems.map((i) => i.code);
    setGroups((prev) =>
      prev.map((g) => (g.id === activeGroup.id ? { ...g, items: newItems } : g))
    );
    await reorderItems(activeGroup.id, nextCodes);
  };

  // 組合管理
  const handleCreateGroup = async (name: string) => {
    const created = await createGroup(name);
    await loadBootstrap();
    setActiveGroupId(created.id);
  };

  const handleRenameGroup = async (id: string, name: string) => {
    await updateGroup(id, { name });
    await loadBootstrap();
  };

  const handleDeleteGroup = async (id: string) => {
    await deleteGroup(id);
    await loadBootstrap();
  };

  return (
    <div className="stock-browser-app">
      <Header
        currentGroupId={activeGroup?.id || null}
        isWealthGroup={activeGroup?.id === 'g-wealth' || activeGroup?.name === '財神簿' || activeGroup?.isSystemGroup}
        subscribedCount={upstream.subscribedCount}
        maxSubscribed={upstream.maxAllowed}
        wsConnected={wsConnected}
        upstreamConnected={upstream.connected}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onRefresh={loadBootstrap}
        onAddStock={handleAddStock}
        onOpenCreateGroup={() => setModalState({ isOpen: true, mode: 'create' })}
        onOpenEditGroup={() => setModalState({ isOpen: true, mode: 'edit' })}
      />

      <GroupTabs
        groups={groups}
        activeGroupId={activeGroup?.id || null}
        onSelectGroup={(id) => setActiveGroupId(id)}
      />

      {/* 視圖切換列 (可直接切換「完整表格」與「兩行卡片」) */}
      <div className={`view-mode-bar ${viewMode === 'card' ? 'view-mode-card' : 'view-mode-table'}`}>
        <div className="view-mode-header-row">
          <div className="view-mode-count">
            本組合共 <strong>{activeGroup?.items.length || 0}</strong> 檔商品
          </div>
          <div className="view-mode-toggle">
            <span className="view-toggle-label">檢視模式：</span>
            <div className="toggle-pill-group">
              <button
                className={`toggle-pill ${viewMode === 'table' ? 'active' : ''}`}
                onClick={() => handleToggleViewMode('table')}
                title="橫向滑動完整表格 (固定商品欄位)"
              >
                ⊞ 完整表格
              </button>
              <button
                className={`toggle-pill ${viewMode === 'card' ? 'active' : ''}`}
                onClick={() => handleToggleViewMode('card')}
                title="手機兩行式精簡卡片 (無需左右滑動)"
              >
                ▤ 兩行卡片
              </button>
            </div>
          </div>
        </div>

        {wealthSummary && (
          <div className="wealth-pnl-summary">
            <span className="pnl-summary-item">
              總損益{' '}
              <strong
                className={
                  wealthSummary.totalPnl > 0
                    ? 'color-up'
                    : wealthSummary.totalPnl < 0
                    ? 'color-down'
                    : 'color-neutral'
                }
              >
                {wealthSummary.totalPnl > 0 ? '+' : ''}
                {Math.round(wealthSummary.totalPnl).toLocaleString()}元
              </strong>
            </span>
            <span className="pnl-summary-divider">•</span>
            <span className="pnl-summary-item">
              報酬率{' '}
              <strong
                className={
                  wealthSummary.returnPercent > 0
                    ? 'color-up'
                    : wealthSummary.returnPercent < 0
                    ? 'color-down'
                    : 'color-neutral'
                }
              >
                {wealthSummary.returnPercent > 0 ? '+' : ''}
                {wealthSummary.returnPercent.toFixed(2)}%
              </strong>
            </span>
          </div>
        )}

        {marketIndices && (
          <div className="market-indices-summary">
            {marketIndices.TSE && (
              <div className="index-pill">
                <span className="index-label">加權</span>
                <span
                  className={`index-val ${
                    marketIndices.TSE.change > 0
                      ? 'color-up'
                      : marketIndices.TSE.change < 0
                      ? 'color-down'
                      : 'color-neutral'
                  }`}
                >
                  {marketIndices.TSE.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span
                  className={`index-chg ${
                    marketIndices.TSE.change > 0
                      ? 'color-up'
                      : marketIndices.TSE.change < 0
                      ? 'color-down'
                      : 'color-neutral'
                  }`}
                >
                  {marketIndices.TSE.change > 0
                    ? `▲${marketIndices.TSE.change.toFixed(2)}`
                    : marketIndices.TSE.change < 0
                    ? `▼${Math.abs(marketIndices.TSE.change).toFixed(2)}`
                    : '0.00'}
                  {' '}
                  ({marketIndices.TSE.changePercent > 0 ? '+' : ''}
                  {marketIndices.TSE.changePercent.toFixed(2)}%)
                </span>
              </div>
            )}
            {marketIndices.OTC && (
              <div className="index-pill">
                <span className="index-label">櫃買</span>
                <span
                  className={`index-val ${
                    marketIndices.OTC.change > 0
                      ? 'color-up'
                      : marketIndices.OTC.change < 0
                      ? 'color-down'
                      : 'color-neutral'
                  }`}
                >
                  {marketIndices.OTC.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span
                  className={`index-chg ${
                    marketIndices.OTC.change > 0
                      ? 'color-up'
                      : marketIndices.OTC.change < 0
                      ? 'color-down'
                      : 'color-neutral'
                  }`}
                >
                  {marketIndices.OTC.change > 0
                    ? `▲${marketIndices.OTC.change.toFixed(2)}`
                    : marketIndices.OTC.change < 0
                    ? `▼${Math.abs(marketIndices.OTC.change).toFixed(2)}`
                    : '0.00'}
                  {' '}
                  ({marketIndices.OTC.changePercent > 0 ? '+' : ''}
                  {marketIndices.OTC.changePercent.toFixed(2)}%)
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <main className="main-content">
        {viewMode === 'table' ? (
          <QuoteTable
            items={activeGroup?.items || []}
            isWealthGroup={activeGroup?.id === 'g-wealth' || activeGroup?.name === '財神簿' || activeGroup?.isSystemGroup}
            quotes={quotes}
            dirtyCodes={dirtyCodes}
            onRemoveItem={handleRemoveStock}
            onMoveItem={handleMoveStock}
            onReorderItems={handleReorderItems}
          />
        ) : (
          <CompactCardList
            items={activeGroup?.items || []}
            isWealthGroup={activeGroup?.id === 'g-wealth' || activeGroup?.name === '財神簿' || activeGroup?.isSystemGroup}
            quotes={quotes}
            dirtyCodes={dirtyCodes}
            onRemoveItem={handleRemoveStock}
            onMoveItem={handleMoveStock}
          />
        )}
      </main>

      <footer className="app-footer">
        <div className="footer-status">
          <span>券商：{upstream.connected ? '已連線' : '連線中'}</span>
          <span>•</span>
          <span>推播：{wsConnected ? 'WebSocket 1Hz 即時' : '重連中'}</span>
          <span>•</span>
          <span className={`market-mode-badge ${upstream.isMarketOpen ? 'market-open' : 'market-closed'}`}>
            <span
              className={`status-dot ${upstream.isMarketOpen ? 'live' : 'warning'}`}
              style={{ display: 'inline-block', marginRight: 6, verticalAlign: 'middle' }}
            />
            {upstream.isMarketOpen ? '台股盤中即時 (09:00~13:30)' : '非盤中 (自動模擬跳動測試中)'}
          </span>
          {upstream.lastQuoteTime && (
            <>
              <span>•</span>
              <span>最後更新：{new Date(upstream.lastQuoteTime).toLocaleTimeString()}</span>
            </>
          )}
        </div>
        <div className="footer-info">Mac mini 私人看盤系統 (Tailscale 內網專用)</div>
      </footer>

      <GroupModal
        mode={modalState.mode}
        groups={groups}
        isOpen={modalState.isOpen}
        onClose={() => setModalState({ isOpen: false, mode: 'create' })}
        onCreateGroup={handleCreateGroup}
        onRenameGroup={handleRenameGroup}
        onDeleteGroup={handleDeleteGroup}
      />
    </div>
  );
};
export default App;
