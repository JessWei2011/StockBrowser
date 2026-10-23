import React, { useState, useEffect, useMemo } from 'react';
import type { CalendarEvent, CalendarMonthData } from '../types';
import { fetchCalendarMonth } from '../services/api';

interface InvestmentCalendarModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectStock?: (code: string) => void;
}

type FilterType = 'all' | 'futures' | 'macro' | 'exhibition' | 'stock';

/**
 * 格式化日曆事件標籤：
 * 依使用者需求，月曆每一天格子中已明確顯示日期，標籤必須標明具體目標 (如「致茂 財報」、「台積電 除息」)，
 * 絕不顯示無目標的「財報 10/19」等冗餘日期標籤。
 */
export const formatEventTag = (ev: CalendarEvent): string => {
  if (ev.type === 'stock') {
    const target = ev.name || ev.code;
    let baseTag = ev.tag || '';
    if (/\d{1,2}\/\d{1,2}/.test(baseTag)) {
      if (baseTag.includes('財報')) {
        return target ? `${target} 財報` : '財報';
      }
      if (baseTag.includes('除息')) {
        return target ? `${target} 除息` : '除息';
      }
      if (baseTag.includes('除權')) {
        return target ? `${target} 除權` : '除權';
      }
      baseTag = baseTag.replace(/[\s(]*\d{1,2}\/\d{1,2}[)]*/g, '').trim();
    }
    if (target && !baseTag.startsWith(target)) {
      return `${target} ${baseTag}`.trim();
    }
    return baseTag;
  }
  return ev.tag;
};

export const InvestmentCalendarModal: React.FC<InvestmentCalendarModalProps> = ({
  isOpen,
  onClose,
  onSelectStock,
}) => {
  const today = useMemo(() => new Date(), []);
  const [currentYear, setCurrentYear] = useState<number>(today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState<number>(today.getMonth() + 1);
  const [calendarData, setCalendarData] = useState<CalendarMonthData | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // 手機專用檢視模式：'calendar' (月曆網格 + 當日明細) | 'list' (全月所有事件清單)
  const [mobileViewMode, setMobileViewMode] = useState<'calendar' | 'list'>('calendar');

  // 選取的單日與篩選器
  const [selectedDate, setSelectedDate] = useState<string>(
    `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  );
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');

  // 記錄使用者點擊展開全文的事件 ID 集合
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());

  const toggleExpandEvent = (id: string) => {
    setExpandedEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const loadData = async (y: number, m: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchCalendarMonth(y, m);
      setCalendarData(data);
    } catch (err: any) {
      setError(err?.message || '讀取日曆事件失敗');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadData(currentYear, currentMonth);
    }
  }, [isOpen, currentYear, currentMonth]);

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

  const handlePrevMonth = () => {
    if (currentMonth === 1) {
      setCurrentYear((y) => y - 1);
      setCurrentMonth(12);
    } else {
      setCurrentMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (currentMonth === 12) {
      setCurrentYear((y) => y + 1);
      setCurrentMonth(1);
    } else {
      setCurrentMonth((m) => m + 1);
    }
  };

  const handleGoToday = () => {
    const now = new Date();
    setCurrentYear(now.getFullYear());
    setCurrentMonth(now.getMonth() + 1);
    setSelectedDate(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
  };

  const getWeekdayStr = (dateStr: string) => {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return '';
    const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    return weekdays[dt.getDay()] || '';
  };

  // 生成月曆矩陣（每週 7 天，週日到週六）
  const calendarGrid = useMemo(() => {
    const firstDayIndex = new Date(currentYear, currentMonth - 1, 1).getDay(); // 0 is Sunday
    const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
    const prevDaysInMonth = new Date(currentYear, currentMonth - 1, 0).getDate();

    const cells: Array<{
      dateStr: string;
      dayNum: number;
      isCurrentMonth: boolean;
      isToday: boolean;
    }> = [];

    // 上個月補位
    for (let i = firstDayIndex - 1; i >= 0; i--) {
      const day = prevDaysInMonth - i;
      const prevM = currentMonth === 1 ? 12 : currentMonth - 1;
      const prevY = currentMonth === 1 ? currentYear - 1 : currentYear;
      const dateStr = `${prevY}-${String(prevM).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      cells.push({
        dateStr,
        dayNum: day,
        isCurrentMonth: false,
        isToday: false,
      });
    }

    // 當月
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({
        dateStr,
        dayNum: d,
        isCurrentMonth: true,
        isToday: dateStr === todayStr,
      });
    }

    // 下個月補位至 35 或 42 格
    const remaining = 7 - (cells.length % 7);
    if (remaining < 7) {
      const nextM = currentMonth === 12 ? 1 : currentMonth + 1;
      const nextY = currentMonth === 12 ? currentYear + 1 : currentYear;
      for (let d = 1; d <= remaining; d++) {
        const dateStr = `${nextY}-${String(nextM).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        cells.push({
          dateStr,
          dayNum: d,
          isCurrentMonth: false,
          isToday: false,
        });
      }
    }

    return cells;
  }, [currentYear, currentMonth, today]);

  // 依日期分類 events
  const eventsByDate = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {};
    if (!calendarData?.events) return map;

    for (const ev of calendarData.events) {
      if (activeFilter !== 'all' && ev.type !== activeFilter) {
        continue;
      }
      if (!map[ev.date]) {
        map[ev.date] = [];
      }
      map[ev.date].push(ev);
    }
    return map;
  }, [calendarData, activeFilter]);

  // 當前選取日期的事件列表
  const selectedDateEvents = useMemo(() => {
    return (eventsByDate[selectedDate] || []).sort((a, b) => {
      // 期貨 > 總經 > 產業大展 > 個股
      const rank = { futures: 0, macro: 1, exhibition: 2, stock: 3 };
      return (rank[a.type] ?? 9) - (rank[b.type] ?? 9);
    });
  }, [eventsByDate, selectedDate]);

  // 當月所有事件（依日期排序），用於手機「事件清單 (Agenda)」模式
  const allMonthEventsGrouped = useMemo(() => {
    if (!calendarData?.events) return [];
    const dateMap = new Map<string, CalendarEvent[]>();
    for (const ev of calendarData.events) {
      if (activeFilter !== 'all' && ev.type !== activeFilter) {
        continue;
      }
      if (!dateMap.has(ev.date)) {
        dateMap.set(ev.date, []);
      }
      dateMap.get(ev.date)!.push(ev);
    }
    const sortedDates = Array.from(dateMap.keys()).sort();
    const rank = { futures: 0, macro: 1, exhibition: 2, stock: 3 };
    return sortedDates.map((dStr) => {
      const list = dateMap.get(dStr)!;
      list.sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9));
      return {
        dateStr: dStr,
        events: list,
      };
    });
  }, [calendarData, activeFilter]);

  const totalFilteredEventsCount = useMemo(() => {
    return allMonthEventsGrouped.reduce((acc, g) => acc + g.events.length, 0);
  }, [allMonthEventsGrouped]);

  const renderEventCard = (ev: CalendarEvent) => {
    const isExpanded = expandedEventIds.has(ev.id);
    const isTitleLong = ev.title.length > 100;
    const displayTitle = !isExpanded && isTitleLong ? `${ev.title.slice(0, 100)}...` : ev.title;
    const hasLongContent = isTitleLong || (ev.detail && ev.detail.length > 80);

    return (
      <div key={ev.id} className={`cal-event-card type-${ev.type} ${isExpanded ? 'is-expanded' : ''}`}>
        <div className="cal-card-top">
          <div className="cal-card-badges">
            <span className={`cal-type-tag tag-${ev.type}`}>
              {ev.type === 'futures'
                ? '期指結算'
                : ev.type === 'macro'
                ? '美國總經'
                : ev.type === 'exhibition'
                ? '產業大展'
                : '個股事件'}
            </span>
            <span className="cal-tag-pill">{formatEventTag(ev)}</span>
            {ev.time && (
              <span className="cal-time-pill">⏰ {ev.time}</span>
            )}
          </div>

          <div className="cal-card-top-actions">
            {ev.code && onSelectStock && (
              <button
                type="button"
                className="cal-btn-view-stock"
                onClick={() => {
                  onClose();
                  onSelectStock(ev.code!);
                }}
                title="開啟此個股技術圖表"
              >
                走勢圖 ↗
              </button>
            )}
          </div>
        </div>

        <h4 className="cal-event-title">{displayTitle}</h4>

        {ev.detail && (
          <div className={`cal-event-detail-wrapper ${isExpanded ? 'expanded' : 'collapsed'}`}>
            <p className="cal-event-detail">
              {ev.detail}
            </p>
          </div>
        )}

        {hasLongContent && (
          <div className="cal-card-expand-bar">
            <button
              type="button"
              className="cal-btn-toggle-expand"
              onClick={() => toggleExpandEvent(ev.id)}
            >
              {isExpanded ? '收起全文 ▴' : '閱讀全文 ▾'}
            </button>
          </div>
        )}

        {(ev.forecast || ev.previous) && (
          <div className="cal-macro-data-row">
            {ev.forecast && (
              <span className="data-pill forecast">
                預測: <strong>{ev.forecast}</strong>
              </span>
            )}
            {ev.previous && (
              <span className="data-pill previous">
                前值: <strong>{ev.previous}</strong>
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="cal-modal-overlay" onClick={onClose}>
      <div className="cal-modal-container" onClick={(e) => e.stopPropagation()}>
        {/* 頂部導覽列 */}
        <div className="cal-header">
          <div className="cal-header-left">
            <span className="cal-header-icon">📅</span>
            <h2 className="cal-header-title">投資事件月行事曆</h2>
            <span className="cal-header-sub">
              (期指結算 · 美國總經 · 產業大展 · 自選與權值股事件)
            </span>
          </div>

          <div className="cal-header-center">
            <button className="cal-nav-btn" onClick={handlePrevMonth} title="上個月">
              ◀
            </button>
            <div className="cal-current-label">
              <strong>{currentYear} 年</strong> {currentMonth} 月
            </div>
            <button className="cal-nav-btn" onClick={handleNextMonth} title="下個月">
              ▶
            </button>
            <button className="cal-today-btn" onClick={handleGoToday}>
              回到今天
            </button>
          </div>

          <div className="cal-header-actions">
            {/* 手機專用：切換「月曆」與「清單」檢視模式 */}
            <div className="cal-view-mode-toggle">
              <button
                type="button"
                className={`cal-view-mode-btn ${mobileViewMode === 'calendar' ? 'active' : ''}`}
                onClick={() => setMobileViewMode('calendar')}
              >
                📅 月曆
              </button>
              <button
                type="button"
                className={`cal-view-mode-btn ${mobileViewMode === 'list' ? 'active' : ''}`}
                onClick={() => setMobileViewMode('list')}
              >
                📋 清單 ({totalFilteredEventsCount})
              </button>
            </div>

            <button className="cal-close-btn" onClick={onClose} title="關閉 (Esc)">
              ✕
            </button>
          </div>
        </div>

        {/* 篩選切換列 */}
        <div className="cal-filter-bar">
          <span className="cal-filter-label">類別篩選：</span>
          <button
            className={`cal-filter-pill ${activeFilter === 'all' ? 'active' : ''}`}
            onClick={() => setActiveFilter('all')}
          >
            🌟 全部顯示
          </button>
          <button
            className={`cal-filter-pill pill-futures ${activeFilter === 'futures' ? 'active' : ''}`}
            onClick={() => setActiveFilter('futures')}
          >
            📊 期指結算 / 四巫日
          </button>
          <button
            className={`cal-filter-pill pill-macro ${activeFilter === 'macro' ? 'active' : ''}`}
            onClick={() => setActiveFilter('macro')}
          >
            🇺🇸 美國總經 / 聯準會
          </button>
          <button
            className={`cal-filter-pill pill-exhibition ${activeFilter === 'exhibition' ? 'active' : ''}`}
            onClick={() => setActiveFilter('exhibition')}
          >
            🎪 產業大展
          </button>
          <button
            className={`cal-filter-pill pill-stock ${activeFilter === 'stock' ? 'active' : ''}`}
            onClick={() => setActiveFilter('stock')}
          >
            🏢 自選與權值股事件
          </button>

          {calendarData && (
            <span className="cal-count-badge">
              本月共有 {calendarData.events.length} 項關鍵事件
            </span>
          )}
        </div>

        {/* 月曆與側邊詳情雙欄區 */}
        <div className={`cal-body-wrapper mode-${mobileViewMode}`}>
          {/* 左側日曆主網格 */}
          <div className="cal-grid-pane">
            <div className="cal-weekday-row">
              <span className="cal-weekday weekend">週日</span>
              <span className="cal-weekday">週一</span>
              <span className="cal-weekday">週二</span>
              <span className="cal-weekday">週三</span>
              <span className="cal-weekday">週四</span>
              <span className="cal-weekday">週五</span>
              <span className="cal-weekday weekend">週六</span>
            </div>

            <div className="cal-days-grid">
              {calendarGrid.map((cell) => {
                const dayEvents = eventsByDate[cell.dateStr] || [];
                const isSelected = cell.dateStr === selectedDate;
                const hasHighImpact = dayEvents.some((e) => e.type === 'futures' || e.impact === 'High');

                return (
                  <div
                    key={cell.dateStr}
                    className={`cal-day-cell ${
                      !cell.isCurrentMonth ? 'not-current-month' : ''
                    } ${cell.isToday ? 'cell-today' : ''} ${
                      isSelected ? 'cell-selected' : ''
                    } ${hasHighImpact ? 'has-high-impact' : ''}`}
                    onClick={() => setSelectedDate(cell.dateStr)}
                  >
                    <div className="cal-cell-header">
                      <span className="cal-cell-num">{cell.dayNum}</span>
                      {cell.isToday && <span className="cal-today-tag">今日</span>}
                    </div>

                    {/* 桌面端事件摘要文字標籤 */}
                    <div className="cal-cell-events">
                      {dayEvents.slice(0, 3).map((ev) => (
                        <div
                          key={ev.id}
                          className={`cal-mini-badge badge-${ev.type}`}
                          title={`${ev.time ? `[${ev.time}] ` : ''}${ev.title}`}
                        >
                          <span className="mini-tag">{formatEventTag(ev)}</span>
                        </div>
                      ))}
                      {dayEvents.length > 3 && (
                        <div className="cal-more-badge">
                          +{dayEvents.length - 3} 項
                        </div>
                      )}
                    </div>

                    {/* 手機端事件彩色圓點標示 (俐落不破版) */}
                    <div className="cal-cell-dots">
                      {dayEvents.slice(0, 4).map((ev) => (
                        <span
                          key={ev.id}
                          className={`cal-cell-dot dot-${ev.type}`}
                          title={formatEventTag(ev)}
                        />
                      ))}
                      {dayEvents.length > 4 && (
                        <span className="cal-cell-dot-more">+{dayEvents.length - 4}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 右側所選日期的事件詳情抽屜 (手機月曆模式下置於月曆下方) */}
          <div className="cal-detail-pane">
            <div className="cal-detail-header">
              <h3 className="cal-detail-title">
                {selectedDate} 當日事件明細
              </h3>
              <span className="cal-detail-count">
                共 {selectedDateEvents.length} 項
              </span>
            </div>

            <div className="cal-detail-list">
              {isLoading ? (
                <div className="cal-empty-state">載入中...</div>
              ) : error ? (
                <div className="cal-empty-state cal-error-state">{error}</div>
              ) : selectedDateEvents.length === 0 ? (
                <div className="cal-empty-state">
                  當日尚無排定之重大財經事件或結算。
                </div>
              ) : (
                selectedDateEvents.map(renderEventCard)
              )}
            </div>
          </div>

          {/* 手機全月事件清單 (在清單模式下全螢幕捲動瀏覽) */}
          <div className="cal-agenda-pane">
            <div className="cal-agenda-header">
              <span className="cal-agenda-header-title">
                {currentYear} 年 {currentMonth} 月事件一覽
              </span>
              <span className="cal-agenda-header-count">
                共 {totalFilteredEventsCount} 項
              </span>
            </div>

            <div className="cal-agenda-list">
              {isLoading ? (
                <div className="cal-empty-state">載入中...</div>
              ) : error ? (
                <div className="cal-empty-state cal-error-state">{error}</div>
              ) : allMonthEventsGrouped.length === 0 ? (
                <div className="cal-empty-state">
                  本月尚無排定之重大財經事件或結算。
                </div>
              ) : (
                allMonthEventsGrouped.map((group) => {
                  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
                  const isGroupToday = group.dateStr === todayStr;
                  return (
                    <div key={group.dateStr} className="cal-agenda-date-group">
                      <div className={`cal-agenda-date-header ${isGroupToday ? 'is-today' : ''}`}>
                        <div className="cal-agenda-date-left">
                          <span className="cal-agenda-date-badge">
                            {group.dateStr.slice(5).replace('-', '/')}
                          </span>
                          <span className="cal-agenda-weekday">
                            {getWeekdayStr(group.dateStr)}
                          </span>
                          {isGroupToday && (
                            <span className="cal-agenda-today-pill">今日</span>
                          )}
                        </div>
                        <span className="cal-agenda-date-count">
                          {group.events.length} 項
                        </span>
                      </div>
                      <div className="cal-agenda-cards-list">
                        {group.events.map(renderEventCard)}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
export default InvestmentCalendarModal;
