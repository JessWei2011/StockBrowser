import React, { useState, useEffect, useRef } from 'react';
import type { InstrumentSearchResult } from '../types';
import { searchInstruments } from '../services/api';

interface HeaderProps {
  currentGroupId: string | null;
  subscribedCount: number;
  maxSubscribed: number;
  wsConnected: boolean;
  upstreamConnected: boolean;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onRefresh: () => void;
  onAddStock: (code: string) => Promise<void>;
  onOpenCreateGroup: () => void;
  onOpenEditGroup: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentGroupId,
  subscribedCount,
  maxSubscribed,
  wsConnected,
  upstreamConnected,
  theme,
  onToggleTheme,
  onRefresh,
  onAddStock,
  onOpenCreateGroup,
  onOpenEditGroup,
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
            <button
              className="btn-add-stock"
              disabled={!query.trim() || !currentGroupId || isAdding}
              onClick={() => handleAdd(results[0]?.code || query)}
            >
              {isAdding ? '新增中...' : '新增個股'}
            </button>
          </div>

          {showDropdown && results.length > 0 && (
            <div className="search-dropdown">
              {results.map((item) => {
                const dispText = item.dispositionPeriod ? `處置 ${item.dispositionPeriod}` : '處置';
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
        <div className="status-badge" title={wsConnected ? 'WebSocket 已連線' : 'WebSocket 連線中...'}>
          <span className={`status-dot ${wsConnected && upstreamConnected ? 'live' : 'warning'}`} />
          <span className="status-text">
            {wsConnected ? (upstreamConnected ? '即時同步' : '行情連線中') : '離線重連中'}
          </span>
        </div>

        <div className="count-info">
          共 <strong className="count-highlight">{subscribedCount}/{maxSubscribed}</strong> 檔自選股
        </div>

        <button className="btn-icon" title="重新載入" onClick={onRefresh}>
          ↻
        </button>

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
