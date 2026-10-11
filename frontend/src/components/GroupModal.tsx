import React, { useState } from 'react';
import type { WatchlistGroup } from '../types';

interface GroupModalProps {
  mode: 'create' | 'edit';
  groups: WatchlistGroup[];
  isOpen: boolean;
  onClose: () => void;
  onCreateGroup: (name: string) => Promise<void>;
  onRenameGroup: (id: string, name: string) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
}

export const GroupModal: React.FC<GroupModalProps> = ({
  mode,
  groups,
  isOpen,
  onClose,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
}) => {
  const [newGroupName, setNewGroupName] = useState('');
  const [editingNames, setEditingNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
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
              {groups.map((g) => {
                const currentName = editingNames[g.id] ?? g.name;
                const isModified = editingNames[g.id] !== undefined && editingNames[g.id] !== g.name;

                return (
                  <div key={g.id} className="group-edit-row">
                    <input
                      type="text"
                      className="modal-input-compact"
                      value={currentName}
                      onChange={(e) =>
                        setEditingNames({ ...editingNames, [g.id]: e.target.value })
                      }
                    />
                    <button
                      className="btn-primary-sm"
                      disabled={!isModified || loading}
                      onClick={() => handleRename(g.id)}
                    >
                      儲存
                    </button>
                    <button
                      className="btn-danger-sm"
                      disabled={groups.length <= 1 || loading}
                      onClick={() => handleDelete(g.id, g.name)}
                      title={groups.length <= 1 ? '至少需保留一個群組' : '刪除此群組'}
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
