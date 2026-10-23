import React, { useState, useEffect } from 'react';
import type { FinancialNewsItem, FinancialNewsResponse } from '../types';
import { fetchFinancialNews, refreshFinancialNews } from '../services/api';

interface FinancialNewsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const FinancialNewsModal: React.FC<FinancialNewsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [data, setData] = useState<FinancialNewsResponse | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedNewsIds, setExpandedNewsIds] = useState<Set<string>>(new Set());

  // 載入指定日期的新聞
  const loadNews = async (dateStr?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetchFinancialNews(dateStr);
      setData(res);
      setSelectedDate(res.selectedDate);
    } catch (err: any) {
      setError(err?.message || '讀取新聞失敗');
    } finally {
      setIsLoading(false);
    }
  };

  // 重新整理新聞源
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const res = await refreshFinancialNews();
      setData(res);
      setSelectedDate(res.selectedDate);
    } catch (err: any) {
      setError(err?.message || '重新整理新聞失敗');
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadNews();
    }
  }, [isOpen]);

  // ESC 鍵關閉
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const toggleExpand = (id: string) => {
    setExpandedNewsIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // 格式化日期標籤 (例如 "10/23 週五")
  const formatDateLabel = (dateStr: string) => {
    try {
      const [y, m, d] = dateStr.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
      const wk = weekdays[date.getDay()];
      return {
        monthDay: `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`,
        weekday: wk,
        isToday: dateStr === new Date().toISOString().slice(0, 10),
      };
    } catch {
      return { monthDay: dateStr, weekday: '', isToday: false };
    }
  };

  return (
    <div className="news-modal-overlay" onClick={onClose}>
      <div className="news-modal-container" onClick={(e) => e.stopPropagation()}>
        {/* 頂部導覽列 */}
        <div className="news-modal-header">
          <div className="news-header-left">
            <span className="news-header-icon">📰</span>
            <div className="news-header-title-group">
              <h2 className="news-header-title">即時財經新聞</h2>
              <span className="news-header-sub">
                台股大盤 · 熱門產業 · 即時頭條 (滾動保留 5 天)
              </span>
            </div>
          </div>

          <div className="news-header-actions">
            <button
              className={`btn-icon ${isRefreshing ? 'spinning' : ''}`}
              title="重新整理新聞"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              ↻
            </button>
            <button className="news-modal-close" onClick={onClose} title="關閉 (Esc)">
              ✕
            </button>
          </div>
        </div>

        {/* 雙欄主內容區：左側日期欄（較小，降冪 5 天），右側三行卡片瀑布流佔滿空間 */}
        <div className="news-modal-body">
          {/* 最左欄：日期列表（降冪排列，預設保留 5 天） */}
          <div className="news-sidebar-dates">
            <div className="news-dates-title">
              📅 歷史日期
            </div>
            <div className="news-dates-list">
              {data?.dates && data.dates.length > 0 ? (
                data.dates.map((dStr) => {
                  const { monthDay, weekday, isToday } = formatDateLabel(dStr);
                  const isSelected = dStr === selectedDate;
                  return (
                    <button
                      key={dStr}
                      type="button"
                      className={`news-date-item ${isSelected ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedDate(dStr);
                        loadNews(dStr);
                      }}
                    >
                      <div className="news-date-main">
                        <span className="news-date-text">{monthDay}</span>
                        <span className="news-date-weekday">{weekday}</span>
                      </div>
                      {isToday && <span className="news-date-today-badge">今日</span>}
                    </button>
                  );
                })
              ) : (
                <div className="news-dates-empty">暫無日期</div>
              )}
            </div>
          </div>

          {/* 右側：佔滿空間，分成 3 欄固定大小卡片，N 列新聞向下延伸 */}
          <div className="news-content-pane">
            <div className="news-pane-header">
              <div className="news-pane-title">
                <strong>{selectedDate}</strong> 即時新聞
              </div>
              <span className="news-pane-count">
                共 {data?.totalCount || 0} 則新聞
              </span>
            </div>

            <div className="news-pane-scroll-area">
              {isLoading ? (
                <div className="news-empty-state">新聞載入中...</div>
              ) : error ? (
                <div className="news-empty-state news-error-state">{error}</div>
              ) : !data || data.news.length === 0 ? (
                <div className="news-empty-state">該日無新聞紀錄</div>
              ) : (
                <div className="news-cards-three-col-grid">
                  {data.news.map((item: FinancialNewsItem) => {
                    const isExpanded = expandedNewsIds.has(item.id);
                    const isTitleLong = item.title.length > 100;
                    const displayTitle = !isExpanded && isTitleLong ? `${item.title.slice(0, 100)}...` : item.title;
                    const hasDetail = Boolean(item.detail && item.detail.trim().length > 0);

                    return (
                      <div key={item.id} className={`news-card-item ${isExpanded ? 'is-expanded' : ''}`}>
                        <div className="news-card-top">
                          <span className="news-source-tag">{item.source}</span>
                          <span className="news-time-tag">⏰ {item.time}</span>
                        </div>

                        <h4 className="news-card-title">{displayTitle}</h4>

                        {hasDetail && (
                          <div className={`news-detail-wrapper ${isExpanded ? 'expanded' : 'collapsed'}`}>
                            <p className="news-detail-text">{item.detail}</p>
                          </div>
                        )}

                        <div className="news-card-bottom-bar">
                          {hasDetail && (
                            <button
                              type="button"
                              className="news-btn-toggle-expand"
                              onClick={() => toggleExpand(item.id)}
                            >
                              {isExpanded ? '收起全文 ▴' : '閱讀全文 ▾'}
                            </button>
                          )}

                          {item.link && (
                            <a
                              href={item.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="news-external-link"
                              title="開啟原文"
                            >
                              來源 ↗
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FinancialNewsModal;
