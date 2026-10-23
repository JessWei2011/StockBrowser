import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { WatchlistGroup, QuoteState, UpstreamStatus, WebSocketMessage, StockPosition, StockAnnouncement, MarketIndexState, StockMaSummary, MarketCalendarStatus } from './types';
import {
  fetchBootstrap,
  createGroup,
  updateGroup,
  deleteGroup,
  addItem,
  removeItem,
  reorderItems,
  refreshSystemQuotes,
} from './services/api';
import { wsClient } from './services/websocket';
import { Header } from './components/Header';
import { GroupTabs } from './components/GroupTabs';
import { QuoteTable } from './components/QuoteTable';
import { CompactCardList } from './components/CompactCardList';
import { AssistantSidebar } from './components/AssistantSidebar';
import { GroupModal } from './components/GroupModal';
import { VaultPasswordModal, isVaultAuthenticated, clearVaultAuthenticated } from './components/VaultPasswordModal';
import { StockChartDrawer } from './components/StockChartDrawer';
import { MarketIndexTrend } from './components/MarketIndexTrend';
import { InvestmentCalendarModal } from './components/InvestmentCalendarModal';
import { GlobalIndicesModal } from './components/GlobalIndicesModal';
import './App.css';

export const App: React.FC = () => {
  const [groups, setGroups] = useState<WatchlistGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Record<string, QuoteState>>({});
  const [positions, setPositions] = useState<StockPosition[]>([]);
  const [dirtyCodes, setDirtyCodes] = useState<Set<string>>(new Set());
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'vault' | 'vault_ledger' | 'order' | 'balance'>('vault');
  const [isVaultPasswordModalOpen, setIsVaultPasswordModalOpen] = useState(false);
  const [isGlobalIndicesModalOpen, setIsGlobalIndicesModalOpen] = useState(false);
  const [marketModalTab, setMarketModalTab] = useState<'tw' | 'us' | 'asia'>('tw');
  const [orderTargetCode, setOrderTargetCode] = useState<string | null>(null);
  const [pendingOrderCode, setPendingOrderCode] = useState<string | null>(null);
  const [selectedChartCode, setSelectedChartCode] = useState<string | null>(null);
  const [isCalendarModalOpen, setIsCalendarModalOpen] = useState(false);
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
  const [marketIndices, setMarketIndices] = useState<Record<string, MarketIndexState> | null>(null);
  const [indicators, setIndicators] = useState<Record<string, StockMaSummary>>({});
  const [marketCalendar, setMarketCalendar] = useState<MarketCalendarStatus | null>(null);

  const [announcements, setAnnouncements] = useState<Record<string, StockAnnouncement[]>>({});

  // 判斷台股現貨與期貨市場是否處於開盤狀態與膠囊標籤資訊 (依據 TW_MARKET_HOLIDAY_DETECTION_GUIDE.md 權威判定)
  const twMarketBadge = useMemo(() => {
    // 1. 若後端已提供權威 marketCalendar，優先採用
    if (marketCalendar) {
      return {
        isOpen: marketCalendar.isOpen,
        badgeLabel: marketCalendar.badgeLabel,
        badgeType: marketCalendar.badgeType,
      };
    }
    // 2. 備援前端判定
    const status = marketIndices?.TSE?.marketStatus;
    if (status === 'open') return { isOpen: true, badgeLabel: '開盤中', badgeType: 'open' };
    const now = new Date();
    const twDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const day = twDate.getDay();
    if (day === 0 || day === 6) return { isOpen: false, badgeLabel: '週末休市', badgeType: 'weekend' };
    const mins = twDate.getHours() * 60 + twDate.getMinutes();
    if (status === 'close' && mins >= 540 && mins < 810) {
      return { isOpen: false, badgeLabel: '休市中', badgeType: 'closed' };
    }
    if (mins < 540) return { isOpen: false, badgeLabel: '未開盤', badgeType: 'closed' };
    if (mins >= 810) return { isOpen: false, badgeLabel: '已收盤', badgeType: 'closed' };
    return { isOpen: true, badgeLabel: '開盤中', badgeType: 'open' };
  }, [marketCalendar, marketIndices?.TSE?.marketStatus]);

  const txfMarketBadge = useMemo(() => {
    // 若全市場天然災害休市或國定假日，期貨亦同步休市
    if (marketCalendar && !marketCalendar.isOpen && (marketCalendar.badgeType === 'typhoon' || marketCalendar.badgeType === 'holiday')) {
      return {
        isOpen: false,
        badgeLabel: marketCalendar.badgeLabel,
        badgeType: marketCalendar.badgeType,
      };
    }
    const status = marketIndices?.TXF?.marketStatus;
    if (status === 'open') return { isOpen: true, badgeLabel: '交易中', badgeType: 'open' };
    const now = new Date();
    const twDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const day = twDate.getDay();
    const mins = twDate.getHours() * 60 + twDate.getMinutes();
    if (day === 0) return { isOpen: false, badgeLabel: '週末休市', badgeType: 'weekend' };
    if (day === 6 && mins >= 300) return { isOpen: false, badgeLabel: '週末休市', badgeType: 'weekend' };
    if (day === 1 && mins < 525) return { isOpen: false, badgeLabel: '未開盤', badgeType: 'closed' };
    const isOpen = (mins >= 525 && mins < 825) || (mins >= 900) || (mins < 300);
    return {
      isOpen,
      badgeLabel: isOpen ? '交易中' : '休市中',
      badgeType: isOpen ? 'open' : 'closed',
    };
  }, [marketCalendar, marketIndices?.TXF?.marketStatus]);

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
      if (data.announcements) {
        setAnnouncements(data.announcements);
      }
      if (data.positions) {
        setPositions(data.positions);
      }
      setUpstream(data.upstream);
      if (data.wealthSummary) {
        setWealthSummary(data.wealthSummary);
      }
      if (data.marketIndices) {
        setMarketIndices(data.marketIndices);
      }
      if (data.marketCalendar) {
        setMarketCalendar(data.marketCalendar);
      }
      if (data.indicators) {
        setIndicators(data.indicators);
      }
      setActiveGroupId((prev) => {
        if (prev && prev !== 'g-vault' && data.groups.some((g) => g.id === prev && g.name !== '財神庫')) return prev;
        const firstWatchlist = data.groups.find((g) => g.id !== 'g-vault' && g.name !== '財神庫');
        return firstWatchlist?.id || data.groups[0]?.id || null;
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
        if (msg.positions) setPositions(msg.positions);
        if (msg.wealthSummary) setWealthSummary(msg.wealthSummary);
        if (msg.marketIndices) setMarketIndices(msg.marketIndices);
      } else if (msg.type === 'quote_delta') {
        if (msg.wealthSummary) setWealthSummary(msg.wealthSummary);
        if (msg.marketIndices) setMarketIndices(msg.marketIndices);

        if (msg.quotes && msg.quotes.length > 0) {
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
        }
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

  // 目前選取的群組 (排除財神庫，財神庫由左側輔助視窗獨立呈現)
  const watchlistGroups = groups.filter((g) => g.id !== 'g-vault' && g.name !== '財神庫');
  const activeGroup = watchlistGroups.find((g) => g.id === activeGroupId) || watchlistGroups[0] || null;

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
      prev.map((g) => {
        if (g.id === activeGroup.id || ((activeGroup.id === 'g-wealth' || activeGroup.id === 'g-vault') && (g.id === 'g-wealth' || g.id === 'g-vault'))) {
          const itemMap = new Map(g.items.map((it) => [it.code, it]));
          const reordered = nextCodes.map((c) => itemMap.get(c)).filter(Boolean);
          const remaining = g.items.filter((it) => !nextCodes.includes(it.code));
          return { ...g, items: [...reordered, ...remaining] as typeof g.items };
        }
        return g;
      })
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
      prev.map((g) => {
        if (g.id === activeGroup.id || ((activeGroup.id === 'g-wealth' || activeGroup.id === 'g-vault') && (g.id === 'g-wealth' || g.id === 'g-vault'))) {
          const itemMap = new Map(g.items.map((it) => [it.code, it]));
          const reordered = nextCodes.map((c) => itemMap.get(c)).filter(Boolean);
          const remaining = g.items.filter((it) => !nextCodes.includes(it.code));
          return { ...g, items: [...reordered, ...remaining] as typeof g.items };
        }
        return g;
      })
    );
    await reorderItems(activeGroup.id, nextCodes);
  };

  // 側邊欄持股自訂排序 (財神庫 / 財神簿，雙向同步財神簿與財神庫組合)
  const handleReorderPositions = async (nextCodes: string[]) => {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id === 'g-wealth' || g.id === 'g-vault' || g.name === '財神簿' || g.name === '財神庫') {
          const itemMap = new Map(g.items.map((it) => [it.code, it]));
          const reordered = nextCodes
            .map((c) => itemMap.get(c))
            .filter((it): it is typeof g.items[0] => Boolean(it));
          const remaining = g.items.filter((it) => !nextCodes.includes(it.code));
          return { ...g, items: [...reordered, ...remaining] };
        }
        return g;
      })
    );
    await reorderItems('g-wealth', nextCodes);
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

  // 點選任一個股最右側下單按鈕：需財神庫密碼通過後方可開啟財神筆
  const handleOpenOrder = (code: string) => {
    if (!isVaultAuthenticated()) {
      setPendingOrderCode(code);
      setIsVaultPasswordModalOpen(true);
      return;
    }
    setOrderTargetCode(code);
    setDrawerTab('order');
    setIsDrawerOpen(true);
  };

  const isVaultGroup = activeGroup?.id === 'g-vault' || activeGroup?.name === '財神庫';
  const isWealthGroup = activeGroup?.id === 'g-wealth' || activeGroup?.name === '財神簿';
  const isSystemGroup = isVaultGroup || isWealthGroup || Boolean(activeGroup?.isSystemGroup);

  return (
    <div className="stock-browser-app">
      <Header
        currentGroupId={activeGroup?.id || null}
        isWealthGroup={isSystemGroup}
        subscribedCount={upstream.subscribedCount}
        maxSubscribed={upstream.maxAllowed}
        wsConnected={wsConnected}
        upstreamConnected={upstream.connected}
        isMarketOpen={upstream.isMarketOpen}
        lastQuoteTime={upstream.lastQuoteTime}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onRefresh={loadBootstrap}
        onForceReconnect={async () => {
          try {
            await refreshSystemQuotes(true);
            await loadBootstrap();
          } catch (e) {
            console.error('Failed to force reconnect:', e);
          }
        }}
        onAddStock={handleAddStock}
        onOpenCreateGroup={() => setModalState({ isOpen: true, mode: 'create' })}
        onOpenEditGroup={() => setModalState({ isOpen: true, mode: 'edit' })}
        onOpenCalendar={() => setIsCalendarModalOpen(true)}
      />

      <GroupTabs
        groups={groups}
        activeGroupId={activeGroup?.id || null}
        onSelectGroup={(id) => setActiveGroupId(id)}
        onOpenDrawer={() => {
          if (isDrawerOpen) {
            // 已開啟時直接關閉
            setIsDrawerOpen(false);
            return;
          }
          // 未開啟時，開啟財神庫前需驗證密碼
          if (!isVaultAuthenticated()) {
            setIsVaultPasswordModalOpen(true);
            return;
          }
          setDrawerTab('vault');
          setIsDrawerOpen(true);
        }}
        isDrawerOpen={isDrawerOpen}
      />

      {/* 工作區：支援左側並排推擠輔助視窗 (財神庫/財神筆) 與右側自選股行情同時對照 */}
      <div className={`app-workspace ${isDrawerOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
        {isDrawerOpen && (
          <AssistantSidebar
            isOpen={isDrawerOpen}
            onClose={() => setIsDrawerOpen(false)}
            activeTab={drawerTab}
            onChangeTab={(tab) => {
              if ((tab === 'vault' || tab === 'vault_ledger') && !isVaultAuthenticated()) {
                setIsVaultPasswordModalOpen(true);
                return;
              }
              setDrawerTab(tab);
            }}
            positions={positions}
            quotes={quotes}
            wealthSummary={wealthSummary}
            dirtyCodes={dirtyCodes}
            initialOrderCode={orderTargetCode || undefined}
            onOrderTargetCodeChange={(code) => setOrderTargetCode(code)}
            orderedCodes={
              groups.find((g) => g.id === 'g-wealth' || g.name === '財神簿')?.items.map((i) => i.code) ||
              groups.find((g) => g.id === 'g-vault' || g.name === '財神庫')?.items.map((i) => i.code) ||
              []
            }
            onLock={() => {
              clearVaultAuthenticated();
              setIsDrawerOpen(false);
            }}
            onRefreshPositions={loadBootstrap}
            onReorderPositions={handleReorderPositions}
          />
        )}

        <div className="workspace-main">
          {/* 視圖切換列與市場損益資訊列 */}
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

            {marketIndices && (
              <div className="market-indices-summary">
                {marketIndices.TSE && (
                  <div
                    className="index-pill index-pill-clickable"
                    onClick={() => {
                      setMarketModalTab('tw');
                      setIsGlobalIndicesModalOpen(true);
                    }}
                    title="點擊放大查看加權指數走勢圖與完整行情"
                  >
                    <span className="index-label">加權</span>
                    <span className={`market-pulse-pill-badge ${twMarketBadge.badgeType}`}>
                      <span className="badge-dot" />
                      {twMarketBadge.badgeLabel}
                    </span>
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
                    {marketIndices.TSE.volumeText && (
                      <span className="index-vol" title="加權指數累積成交金額">
                        成交量 {marketIndices.TSE.volumeText}
                      </span>
                    )}
                    <MarketIndexTrend quote={marketIndices.TSE} />
                  </div>
                )}
                {marketIndices.OTC && (
                  <div
                    className="index-pill index-pill-clickable"
                    onClick={() => {
                      setMarketModalTab('tw');
                      setIsGlobalIndicesModalOpen(true);
                    }}
                    title="點擊放大查看櫃買指數走勢圖與完整行情"
                  >
                    <span className="index-label">櫃買</span>
                    <span className={`market-pulse-pill-badge ${twMarketBadge.badgeType}`}>
                      <span className="badge-dot" />
                      {twMarketBadge.badgeLabel}
                    </span>
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
                    {marketIndices.OTC.volumeText && (
                      <span className="index-vol" title="櫃買指數累積成交金額">
                        成交量 {marketIndices.OTC.volumeText}
                      </span>
                    )}
                    <MarketIndexTrend quote={marketIndices.OTC} />
                  </div>
                )}
                {marketIndices.TXF && marketIndices.TXF.price > 0 && (
                  <div
                    className="index-pill index-pill-clickable"
                    onClick={() => {
                      setMarketModalTab('tw');
                      setIsGlobalIndicesModalOpen(true);
                    }}
                    title="點擊放大查看台指近（全）走勢圖與完整行情"
                  >
                    <span className="index-label">台指近(全)</span>
                    <span className={`market-pulse-pill-badge ${txfMarketBadge.badgeType}`}>
                      <span className="badge-dot" />
                      {txfMarketBadge.badgeLabel}
                    </span>
                    <span
                      className={`index-val ${
                        marketIndices.TXF.change > 0
                          ? 'color-up'
                          : marketIndices.TXF.change < 0
                          ? 'color-down'
                          : 'color-neutral'
                      }`}
                    >
                      {marketIndices.TXF.price.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}
                    </span>
                    <span
                      className={`index-chg ${
                        marketIndices.TXF.change > 0
                          ? 'color-up'
                          : marketIndices.TXF.change < 0
                          ? 'color-down'
                          : 'color-neutral'
                      }`}
                    >
                      {marketIndices.TXF.change > 0
                        ? `▲${marketIndices.TXF.change.toFixed(0)}`
                        : marketIndices.TXF.change < 0
                        ? `▼${Math.abs(marketIndices.TXF.change).toFixed(0)}`
                        : '0'}
                      {' '}
                      ({marketIndices.TXF.changePercent > 0 ? '+' : ''}
                      {marketIndices.TXF.changePercent.toFixed(2)}%)
                    </span>
                    {marketIndices.TXF.volumeText && (
                      <span className="index-vol" title="台指近(全)累積成交口數">
                        口數 {marketIndices.TXF.volumeText}
                      </span>
                    )}
                    <MarketIndexTrend quote={marketIndices.TXF} />
                  </div>
                )}
                <button
                  className="index-pill btn-global-indices"
                  onClick={() => {
                    setMarketModalTab('us');
                    setIsGlobalIndicesModalOpen(true);
                  }}
                  title="查看美股四大指數與亞股(日韓)行情與分時走勢"
                >
                  <span className="global-pill-icon">🌐</span>
                  <span className="global-pill-title">美股 / 亞股</span>
                  <span className="global-pill-arrow">›</span>
                </button>
              </div>
            )}
          </div>

          <main className="main-content">
            {viewMode === 'table' ? (
              <QuoteTable
                items={activeGroup?.items || []}
                isWealthGroup={isSystemGroup}
                quotes={quotes}
                announcements={announcements}
                indicators={indicators}
                dirtyCodes={dirtyCodes}
                onRemoveItem={handleRemoveStock}
                onMoveItem={handleMoveStock}
                onReorderItems={handleReorderItems}
                onSelectStock={(code) => setSelectedChartCode(code)}
                onOpenOrder={handleOpenOrder}
              />
            ) : (
              <CompactCardList
                items={activeGroup?.items || []}
                isWealthGroup={isSystemGroup}
                quotes={quotes}
                announcements={announcements}
                indicators={indicators}
                dirtyCodes={dirtyCodes}
                onRemoveItem={handleRemoveStock}
                onMoveItem={handleMoveStock}
                onSelectStock={(code) => setSelectedChartCode(code)}
                onOpenOrder={handleOpenOrder}
              />
            )}
          </main>
        </div>
      </div>

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

      <VaultPasswordModal
        isOpen={isVaultPasswordModalOpen}
        onClose={() => {
          setIsVaultPasswordModalOpen(false);
          setPendingOrderCode(null);
        }}
        onSuccess={() => {
          setIsVaultPasswordModalOpen(false);
          if (pendingOrderCode) {
            setOrderTargetCode(pendingOrderCode);
            setPendingOrderCode(null);
            setDrawerTab('order');
            setIsDrawerOpen(true);
          } else {
            setDrawerTab('vault');
            setIsDrawerOpen(true);
          }
        }}
      />

      <StockChartDrawer
        code={selectedChartCode}
        isOpen={Boolean(selectedChartCode)}
        onClose={() => setSelectedChartCode(null)}
        theme={theme}
        currentPrice={selectedChartCode && quotes[selectedChartCode]?.last ? quotes[selectedChartCode].last : null}
        changePercent={selectedChartCode && quotes[selectedChartCode]?.changePercent ? quotes[selectedChartCode].changePercent : null}
      />

      <InvestmentCalendarModal
        isOpen={isCalendarModalOpen}
        onClose={() => setIsCalendarModalOpen(false)}
        onSelectStock={(code) => setSelectedChartCode(code)}
      />

      <GlobalIndicesModal
        isOpen={isGlobalIndicesModalOpen}
        onClose={() => setIsGlobalIndicesModalOpen(false)}
        initialTab={marketModalTab}
        twIndices={marketIndices}
      />
    </div>
  );
};
export default App;
