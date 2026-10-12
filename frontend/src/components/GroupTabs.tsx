import React from 'react';
import type { WatchlistGroup } from '../types';

interface GroupTabsProps {
  groups: WatchlistGroup[];
  activeGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  onOpenDrawer: () => void;
  isDrawerOpen?: boolean;
}

export const GroupTabs: React.FC<GroupTabsProps> = ({
  groups,
  activeGroupId,
  onSelectGroup,
  onOpenDrawer,
  isDrawerOpen,
}) => {
  // 過濾掉財神庫，財神庫已移入左側輔助視窗；主頁籤以財神簿為首
  const watchlistGroups = groups.filter(
    (g) => g.id !== 'g-vault' && g.name !== '財神庫'
  );

  return (
    <div className="tabs-bar-wrapper">
      <div className="tabs-bar-left">
        {/* 3號位置：開啟左側輔助視窗按鈕 (財神庫 / 財神筆) */}
        <button
          className={`btn-drawer-trigger ${isDrawerOpen ? 'active' : ''}`}
          onClick={onOpenDrawer}
          title="開啟輔助分頁視窗（分頁一：財神庫、分頁二：財神筆）"
        >
          <span className="drawer-btn-icon">🏦</span>
          <span className="drawer-btn-text">財神庫</span>
        </button>

        {/* 主自選群組頁籤 (以財神簿為首) */}
        <div className="tabs-list">
          {watchlistGroups.map((group) => {
            const isActive = group.id === activeGroupId;
            const isWealth = group.id === 'g-wealth' || group.name === '財神簿';
            return (
              <button
                key={group.id}
                className={`tab-item ${isActive ? 'active' : ''} ${isWealth ? 'tab-wealth' : ''}`}
                onClick={() => onSelectGroup(group.id)}
              >
                {isWealth && <span className="wealth-icon">💰</span>}
                {group.name}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
