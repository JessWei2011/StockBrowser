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
          return (
            <button
              key={group.id}
              className={`tab-item ${isActive ? 'active' : ''}`}
              onClick={() => onSelectGroup(group.id)}
            >
              {group.name}
            </button>
          );
        })}
      </div>
    </div>
  );
};
