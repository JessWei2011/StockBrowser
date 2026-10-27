import React, { useState, useEffect } from 'react';
import type { WatchlistGroup } from '../types';

interface GroupModalProps {
  mode: 'create' | 'edit';
  groups: WatchlistGroup[];
  isOpen: boolean;
  onClose: () => void;
  onCreateGroup: (name: string) => Promise<void>;
  onRenameGroup: (id: string, name: string) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
  onReorderGroups?: (groupIds: string[]) => Promise<void>;
}

export const GroupModal: React.FC<GroupModalProps> = ({
  mode,
  groups,
  isOpen,
  onClose,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onReorderGroups,
}) => {
  const [newGroupName, setNewGroupName] = useState('');
  const [editingNames, setEditingNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [localGroups, setLocalGroups] = useState<WatchlistGroup[]>(groups);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => {
    setLocalGroups(groups);
  }, [groups]);

  if (!isOpen) return null;

  const handleCreate = async () => {
    if (!newGroupName.trim() || loading) return;
    try {
      setLoading(true);
      await onCreateGroup(newGroupName.trim());
      setNewGroupName('');
      onClose();
    } catch (e: any) {
      alert(e.message || '建立失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleRename = async (id: string) => {
    const name = editingNames[id]?.trim();
    if (!name || loading) return;
    try {
      setLoading(true);
      await onRenameGroup(id, name);
      const updated = { ...editingNames };
      delete updated[id];
      setEditingNames(updated);
    } catch (e: any) {
      alert(e.message || '更新失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`確定要刪除「${name}」自選組合嗎？`)) return;
    try {
      setLoading(true);
      await onDeleteGroup(id);
    } catch (e: any) {
      alert(e.message || '刪除失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleMove = (id: string, direction: 'up' | 'down') => {
    if (!onReorderGroups) return;
    const customList = localGroups.filter(
      (g) => !(g.id === 'g-vault' || g.id === 'g-wealth' || g.name === '財神庫' || g.name === '財神簿' || g.isSystemGroup)
    );
    const currentIndex = customList.findIndex((g) => g.id === id);
    if (currentIndex === -1) return;

    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= customList.length) return;

    // 交換位置
    const nextCustomList = [...customList];
    const [moved] = nextCustomList.splice(currentIndex, 1);
    nextCustomList.splice(targetIndex, 0, moved);

    // 重組 localGroups 並立刻反映在 UI 上（無延遲、不鎖定按鈕）
    const systemList = localGroups.filter(
      (g) => g.id === 'g-vault' || g.id === 'g-wealth' || g.name === '財神庫' || g.name === '財神簿' || g.isSystemGroup
    );
    const updatedAll = [...systemList, ...nextCustomList];
    setLocalGroups(updatedAll);

    // 送出自選群組 ID 陣列給後端
    const nextIds = nextCustomList.map((g) => g.id);
    onReorderGroups(nextIds).catch((err) => {
      console.error('Reorder error:', err);
    });
  };

  // 滑鼠拖曳排序 (Drag & Drop)
  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };

  const handleDragOver = (e: React.DragEvent, id: string, isSystem: boolean) => {
    e.preventDefault();
    if (isSystem) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.dataTransfer.dropEffect = 'move';
    if (dragOverId !== id) {
      setDragOverId(id);
    }
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDragOverId(null);
  };

  const handleDrop = (e: React.DragEvent, targetId: string, isSystem: boolean) => {
    e.preventDefault();
    if (isSystem || !draggedId || draggedId === targetId) {
      handleDragEnd();
      return;
    }

    const customList = localGroups.filter(
      (g) => !(g.id === 'g-vault' || g.id === 'g-wealth' || g.name === '財神庫' || g.name === '財神簿' || g.isSystemGroup)
    );
    const fromIndex = customList.findIndex((g) => g.id === draggedId);
    const toIndex = customList.findIndex((g) => g.id === targetId);

    handleDragEnd();

    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;

    // 將項目從來源移至目標位置
    const nextCustomList = [...customList];
    const [moved] = nextCustomList.splice(fromIndex, 1);
    nextCustomList.splice(toIndex, 0, moved);

    const systemList = localGroups.filter(
      (g) => g.id === 'g-vault' || g.id === 'g-wealth' || g.name === '財神庫' || g.name === '財神簿' || g.isSystemGroup
    );
    const updatedAll = [...systemList, ...nextCustomList];
    setLocalGroups(updatedAll);

    if (onReorderGroups) {
      const nextIds = nextCustomList.map((g) => g.id);
      onReorderGroups(nextIds).catch((err) => {
        console.error('Reorder error:', err);
      });
    }
  };

  // 排除純背景資料庫用的 g-vault (財神庫)，展示與主畫面頁籤完全一致的組合列表
  const displayGroups = localGroups.filter((g) => g.id !== 'g-vault' && g.name !== '財神庫');
  const customGroups = displayGroups.filter(
    (g) => !(g.id === 'g-wealth' || g.name === '財神簿' || g.isSystemGroup)
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card-group" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            {mode === 'create' ? '+ 新增自選組合' : '✎ 編輯自選組合'}
          </h2>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {mode === 'create' ? (
            <div className="form-group">
              <label>組合名稱：</label>
              <input
                type="text"
                className="modal-input"
                placeholder="例如：高殖利率、AI概念股"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <div className="modal-footer">
                <button className="btn-secondary" onClick={onClose}>
                  取消
                </button>
                <button
                  className="btn-primary"
                  disabled={!newGroupName.trim() || loading}
                  onClick={handleCreate}
                >
                  {loading ? '建立中...' : '確認建立'}
                </button>
              </div>
            </div>
          ) : (
            <div className="group-list-edit">
              <div className="group-edit-hint">
                💡 說明：可按住「<strong>⠿</strong>」以滑鼠直接<strong>拖曳整列排序</strong>，或點選 <strong>↑ / ↓</strong> 微調順序；點選「儲存」更名。「財神簿」為固定首頁。
              </div>

              {displayGroups.map((g) => {
                const currentName = editingNames[g.id] ?? g.name;
                const isModified = editingNames[g.id] !== undefined && editingNames[g.id] !== g.name;
                const isSystem = Boolean(g.id === 'g-wealth' || g.name === '財神簿' || g.isSystemGroup);
                const customIdx = customGroups.findIndex((cg) => cg.id === g.id);
                const isFirst = customIdx === 0;
                const isLast = customIdx === customGroups.length - 1;
                const isDragging = draggedId === g.id;
                const isDropTarget = dragOverId === g.id;

                return (
                  <div
                    key={g.id}
                    className={`group-edit-row ${isDragging ? 'group-row-dragging' : ''} ${
                      isDropTarget ? 'group-row-drop-target' : ''
                    }`}
                    draggable={!isSystem}
                    onDragStart={(e) => handleDragStart(e, g.id)}
                    onDragOver={(e) => handleDragOver(e, g.id, isSystem)}
                    onDragEnd={handleDragEnd}
                    onDrop={(e) => handleDrop(e, g.id, isSystem)}
                  >
                    <div className="group-order-controls">
                      {isSystem ? (
                        <span className="group-lock-badge" title="系統固定分頁，位置固定於第一位">
                          🔒
                        </span>
                      ) : (
                        <>
                          <span
                            className="drag-handle group-drag-handle"
                            title="按住滑鼠左鍵拖曳排序"
                          >
                            ⠿
                          </span>
                          <button
                            type="button"
                            className="btn-order-arrow btn-group-arrow"
                            disabled={isFirst}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMove(g.id, 'up');
                            }}
                            title="向前移動一位"
                            onDragStart={(e) => e.stopPropagation()}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="btn-order-arrow btn-group-arrow"
                            disabled={isLast}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMove(g.id, 'down');
                            }}
                            title="向後移動一位"
                            onDragStart={(e) => e.stopPropagation()}
                          >
                            ↓
                          </button>
                        </>
                      )}
                    </div>

                    <input
                      type="text"
                      className="modal-input-compact"
                      value={currentName}
                      disabled={isSystem}
                      draggable={false}
                      onDragStart={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        setEditingNames({ ...editingNames, [g.id]: e.target.value })
                      }
                    />

                    <button
                      className="btn-primary-sm"
                      disabled={isSystem || !isModified || loading}
                      onClick={() => handleRename(g.id)}
                      title="儲存更名"
                      onDragStart={(e) => e.stopPropagation()}
                    >
                      儲存
                    </button>
                    <button
                      className="btn-danger-sm"
                      disabled={isSystem || customGroups.length <= 1 || loading}
                      onClick={() => handleDelete(g.id, g.name)}
                      title={
                        isSystem
                          ? `${g.name}為系統固定分頁，無法刪除`
                          : (customGroups.length <= 1 ? '至少需保留一個自選組合' : '刪除此群組')
                      }
                      onDragStart={(e) => e.stopPropagation()}
                    >
                      刪除
                    </button>
                  </div>
                );
              })}
              <div className="modal-footer">
                <button className="btn-primary" onClick={onClose}>
                  完成
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
