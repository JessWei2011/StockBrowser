import React from 'react';

export type MobileNavTab = 'watchlist' | 'vault' | 'order' | 'calendar' | 'news';

interface MobileNavBarProps {
  activeTab: MobileNavTab;
  onSelectTab: (tab: MobileNavTab) => void;
  positionsCount?: number;
  activeOrdersCount?: number;
}

export const MobileNavBar: React.FC<MobileNavBarProps> = ({
  activeTab,
  onSelectTab,
  positionsCount = 0,
  activeOrdersCount = 0,
}) => {
  return (
    <nav className="mobile-bottom-nav" aria-label="手機端主導覽列">
      <button
        type="button"
        className={`mobile-nav-item ${activeTab === 'watchlist' ? 'active' : ''}`}
        onClick={() => onSelectTab('watchlist')}
      >
        <span className="mobile-nav-icon">📊</span>
        <span className="mobile-nav-label">自選</span>
      </button>

      <button
        type="button"
        className={`mobile-nav-item ${activeTab === 'vault' ? 'active' : ''}`}
        onClick={() => onSelectTab('vault')}
      >
        <div className="mobile-nav-icon-wrapper">
          <span className="mobile-nav-icon">🏦</span>
          {positionsCount > 0 && (
            <span className="mobile-nav-badge">{positionsCount}</span>
          )}
        </div>
        <span className="mobile-nav-label">財神庫</span>
      </button>

      <button
        type="button"
        className={`mobile-nav-item ${activeTab === 'order' ? 'active' : ''}`}
        onClick={() => onSelectTab('order')}
      >
        <div className="mobile-nav-icon-wrapper">
          <span className="mobile-nav-icon">✍️</span>
          {activeOrdersCount > 0 && (
            <span className="mobile-nav-badge badge-active-orders">{activeOrdersCount}</span>
          )}
        </div>
        <span className="mobile-nav-label">財神筆</span>
      </button>

      <button
        type="button"
        className={`mobile-nav-item ${activeTab === 'calendar' ? 'active' : ''}`}
        onClick={() => onSelectTab('calendar')}
      >
        <span className="mobile-nav-icon">📅</span>
        <span className="mobile-nav-label">行事曆</span>
      </button>

      <button
        type="button"
        className={`mobile-nav-item ${activeTab === 'news' ? 'active' : ''}`}
        onClick={() => onSelectTab('news')}
      >
        <span className="mobile-nav-icon">📰</span>
        <span className="mobile-nav-label">新聞</span>
      </button>
    </nav>
  );
};
