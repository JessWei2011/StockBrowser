import React from 'react';
import type { WatchlistGroup } from '../types';

interface GroupTabsProps {
  groups: WatchlistGroup[];
  activeGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
}

export const GroupTabs: React.FC<GroupTabsProps> = ({
  groups,
  activeGroupId,
  onSelectGroup,
}) => {
  return (
    <div className="tabs-container">
      <div className="tabs-list">
        {groups.map((group) => {
          const isActive = group.id === activeGroupId;
          const isWealth = group.id === 'g-wealth' || group.name === '財神簿' || group.isSystemGroup;
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
  );
};
