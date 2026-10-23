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
  onAddStock: (code: string) => Promise<void>;
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
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setShowDropdown(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const data = await searchInstruments(query.trim());
        setResults(data);
        setShowDropdown(data.length > 0);
      } catch (e) {
        console.error('Search error:', e);
      }
    }, 250);

    return () => clearTimeout(timer);
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

  const handleAdd = async (codeToAdd?: string) => {
    const code = (codeToAdd || query).trim().toUpperCase();
    if (!code || !currentGroupId || isAdding) return;
    try {
      setIsAdding(true);
      await onAddStock(code);
      setQuery('');
      setShowDropdown(false);
    } catch (e: any) {
      alert(e.message || '新增失敗');
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <header className="app-header">
      <div className="header-left">
        <h1 className="app-title">我的自選</h1>
        <div className="search-container" ref={dropdownRef}>
          <div className="search-input-group">
            <input
              type="text"
              className="search-input"
              placeholder="請輸入股號或商品名稱"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => results.length > 0 && setShowDropdown(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleAdd(results[0]?.code);
                }
              }}
            />
            {!isWealthGroup && (
              <button
                className="btn-add-stock"
                disabled={!query.trim() || !currentGroupId || isAdding}
                onClick={() => handleAdd(results[0]?.code || query)}
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
                    onClick={() => handleAdd(item.code)}
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
          // 盤中行情新鮮度檢測 (若開盤中且最後報價超過 20 秒未更新，視為行情斷線/停滯)
          const nowTs = Date.now();
          const lastTs = lastQuoteTime ? new Date(lastQuoteTime).getTime() : 0;
          const isStale = isMarketOpen && (!lastQuoteTime || (nowTs - lastTs > 20000));
          const isOffline = !wsConnected || !upstreamConnected;

          let badgeClass = 'live';
          let statusText = '即時同步';
          let badgeTitle = '報價正常跳動中';

          if (isOffline) {
            badgeClass = 'danger';
            statusText = wsConnected ? '行情斷線 (點擊重置)' : '伺服器重連中';
            badgeTitle = '券商行情未連線，點擊以強制重新連線';
          } else if (isStale) {
            badgeClass = 'danger pulse-danger';
            statusText = '行情逾時 (點擊重置)';
            badgeTitle = '盤中超過 20 秒無即時行情，點擊以強制重置連線';
          } else if (!isMarketOpen) {
            badgeClass = 'closed';
            statusText = '已收盤 (模擬/快照)';
            badgeTitle = '目前非盤中交易時段';
          }

          return (
            <div
              className={`status-badge ${isStale || isOffline ? 'status-badge-clickable' : ''}`}
              title={badgeTitle}
              onClick={() => {
                if ((isStale || isOffline) && onForceReconnect) {
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
