import React, { useState, useEffect, useRef } from 'react';
import type { InstrumentSearchResult } from '../types';
import { searchInstruments } from '../services/api';

interface HeaderProps {
  currentGroupId: string | null;
  isWealthGroup?: boolean;
  subscribedCount: number;
  maxSubscribed: number;
  wsConnected: boolean;
  upstreamConnected: boolean;
  isMarketOpen?: boolean;
  lastQuoteTime?: string | null;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onRefresh: () => void;
  onForceReconnect?: () => void;
  onAddStock: (code: string, meta?: { name?: string; exchange?: string; securityType?: string }) => Promise<void>;
  onOpenCreateGroup: () => void;
  onOpenEditGroup: () => void;
  onOpenCalendar?: () => void;
  onOpenNews?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentGroupId,
  isWealthGroup,
  subscribedCount,
  maxSubscribed,
  wsConnected,
  upstreamConnected,
  isMarketOpen,
  lastQuoteTime,
  theme,
  onToggleTheme,
  onRefresh,
  onForceReconnect,
  onAddStock,
  onOpenCreateGroup,
  onOpenEditGroup,
  onOpenCalendar,
  onOpenNews,
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InstrumentSearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const isSubmittingRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const showToast = (text: string, type: 'success' | 'error') => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ text, type });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 4000);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // 搜尋自動完成：使用 100ms 防抖與 AbortController 防範非同步競爭
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setShowDropdown(false);
      return;
    }

    let isActive = true;
    const controller = new AbortController();

    const timer = setTimeout(async () => {
      try {
        const data = await searchInstruments(trimmed, controller.signal);
        if (isActive) {
          setResults(data);
          setShowDropdown(data.length > 0);
        }
      } catch (e: any) {
        if (e.name !== 'AbortError' && isActive) {
          console.error('Search error:', e);
        }
      }
    }, 100);

    return () => {
      isActive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  // 點選外部關閉下拉選單
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleAdd = async (explicitCode?: string, itemMeta?: InstrumentSearchResult) => {
    if (isSubmittingRef.current || isAdding) return;

    const raw = (explicitCode || query).trim().toUpperCase();
    if (!raw || !currentGroupId) return;

    let codeToSubmit = raw;
    let meta = itemMeta;

    // 若使用者輸入的是代號格式 (4-6 位英數字)，優先以輸入之代號為準
    const isCodeFormat = /^[0-9A-Z]{4,6}$/.test(raw);
    if (!explicitCode && !isCodeFormat && results.length > 0) {
      codeToSubmit = results[0].code;
      meta = results[0];
    } else if (!meta && results.length > 0) {
      meta = results.find((r) => r.code === codeToSubmit);
    }

    try {
      isSubmittingRef.current = true;
      setIsAdding(true);
      setShowDropdown(false);

      await onAddStock(codeToSubmit, meta);
      setQuery('');
      setResults([]);
      const stockDisplayName = meta?.name ? `${codeToSubmit} (${meta.name})` : codeToSubmit;
      showToast(`已成功新增 ${stockDisplayName}`, 'success');
    } catch (e: any) {
      showToast(e.message || '新增失敗', 'error');
    } finally {
      isSubmittingRef.current = false;
      setIsAdding(false);
    }
  };

  return (
    <header className="app-header">
      {/* 獨立固定於右上角的全域通知 Toast，絕不遮擋搜尋列與下拉選單 */}
      {toast && (
        <div
          className={`header-toast header-toast-${toast.type}`}
          role="alert"
          onClick={() => setToast(null)}
          title="點擊關閉通知"
        >
          <span className="header-toast-icon">
            {toast.type === 'success' ? '✓' : '⚠️'}
          </span>
          <span className="header-toast-text">{toast.text}</span>
          <button
            className="header-toast-close"
            onClick={(e) => {
              e.stopPropagation();
              setToast(null);
            }}
            title="關閉"
          >
            ×
          </button>
        </div>
      )}

      <div className="header-left">
        <h1 className="app-title">我的自選</h1>
        <div className="search-container" ref={dropdownRef}>
          <div className="search-input-group">
            <input
              type="text"
              className="search-input"
              placeholder="請輸入股號或商品名稱"
              value={query}
              onChange={(e) => {
                if (toast) setToast(null);
                setQuery(e.target.value);
              }}
              onFocus={() => {
                if (toast) setToast(null);
                if (results.length > 0 && query.trim()) setShowDropdown(true);
              }}
              onClick={() => {
                if (toast) setToast(null);
                if (results.length > 0 && query.trim()) setShowDropdown(true);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.key !== 'Enter') return;
                e.preventDefault();
                handleAdd();
              }}
            />
            {!isWealthGroup && (
              <button
                className="btn-add-stock"
                disabled={!query.trim() || !currentGroupId || isAdding}
                onClick={() => handleAdd()}
                title="新增至目前組合"
              >
                {isAdding ? '新增中...' : '新增個股'}
              </button>
            )}
          </div>

          {showDropdown && results.length > 0 && (
            <div className="search-dropdown">
              {results.map((item) => {
                const lvlStr = item.dispositionLevel === 2 ? '二' : (item.dispositionLevel === 3 ? '三' : (item.dispositionLevel === 1 ? '一' : ''));
                const dispPrefix = lvlStr ? `處置${lvlStr}` : '處置';
                const dispText = item.dispositionPeriod ? `${dispPrefix} ${item.dispositionPeriod}` : dispPrefix;
                return (
                  <div
                    key={item.code}
                    className="dropdown-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleAdd(item.code, item)}
                  >
                    <span className="dropdown-code">{item.code}</span>
                    <span className="dropdown-name">{item.name}</span>
                    {(item.dispositionLevel && item.dispositionLevel > 0) || item.dispositionPeriod ? (
                      <span className="stock-badge badge-disposition">
                        [{dispText}]
                      </span>
                    ) : item.isAttention ? (
                      <span className="stock-badge badge-attention">
                        [注意]
                      </span>
                    ) : null}
                    <span className="dropdown-type">{item.securityType}</span>
                    <span className="dropdown-exchange">{item.exchange}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="header-right">
        {(() => {
          // 券商行情與連線狀態判定 (由後端連線心跳與 WebSocket 權威決定，杜絕客戶端時鐘偏差引發的頻繁閃爍)
          const isOffline = !wsConnected || !upstreamConnected;

          let badgeClass = 'live';
          let statusText = '即時同步';
          let badgeTitle = lastQuoteTime
            ? `報價跳動中 (最後更新: ${new Date(lastQuoteTime).toLocaleTimeString()})，點擊可手動校正`
            : '報價正常跳動中 (點擊可手動校正)';

          if (isOffline) {
            badgeClass = 'danger';
            statusText = wsConnected ? '行情斷線 (點擊重置)' : '伺服器重連中...';
            badgeTitle = '券商行情未連線，點擊以強制重新連線';
          } else if (!isMarketOpen) {
            badgeClass = 'closed';
            statusText = '已收盤 (模擬/快照)';
            badgeTitle = '目前非盤中交易時段 (點擊可立即手動校正)';
          }

          return (
            <div
              className={`status-badge ${isOffline ? 'status-badge-clickable' : ''}`}
              title={badgeTitle}
              onClick={() => {
                if (isOffline && onForceReconnect) {
                  onForceReconnect();
                } else {
                  onRefresh();
                }
              }}
            >
              <span className={`status-dot ${badgeClass}`} />
              <span className="status-text">{statusText}</span>
            </div>
          );
        })()}

        <div className="count-info">
          共 <strong className="count-highlight">{subscribedCount}/{maxSubscribed}</strong> 檔自選股
        </div>

        <button className="btn-icon" title="重新載入" onClick={onRefresh}>
          ↻
        </button>

        {onOpenCalendar && (
          <button
            className="btn-action btn-calendar-action"
            title="開啟投資事件月行事曆 (期指結算、美國總經、自選與權值股事件)"
            onClick={onOpenCalendar}
          >
            📅 行事曆
          </button>
        )}

        {onOpenNews && (
          <button
            className="btn-action btn-news-action"
            title="開啟即時財經新聞 (台股大盤、重點產業、即時頭條)"
            onClick={onOpenNews}
          >
            📰 財經新聞
          </button>
        )}

        <button
          className="btn-theme-toggle"
          title={theme === 'dark' ? '切換日間模式' : '切換夜間模式'}
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? '☀️ 日間' : '🌙 夜間'}
        </button>

        <button className="btn-action" onClick={onOpenCreateGroup}>
          + 新增組合
        </button>

        <button className="btn-action" onClick={onOpenEditGroup}>
          ✎ 編輯組合
        </button>
      </div>
    </header>
  );
};
