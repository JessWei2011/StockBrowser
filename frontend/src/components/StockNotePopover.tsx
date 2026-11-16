import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { StockAiNote } from '../types';
import { fetchStockAiNote, regenerateStockAiNote, updateStockAiNote } from '../services/api';

interface StockNotePopoverProps {
  code: string;
  name: string;
  isOpen: boolean;
  onClose: () => void;
  targetRect: DOMRect | null;
  cachedNote?: StockAiNote | null;
  onNoteUpdated?: (note: StockAiNote) => void;
}

export const StockNotePopover: React.FC<StockNotePopoverProps> = ({
  code,
  name,
  isOpen,
  onClose,
  targetRect,
  cachedNote,
  onNoteUpdated,
}) => {
  const [note, setNote] = useState<StockAiNote | null>(cachedNote || null);
  const [loading, setLoading] = useState<boolean>(false);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editBusiness, setEditBusiness] = useState<string>('');
  const [editCustomers, setEditCustomers] = useState<string>('');
  const [editAiRelation, setEditAiRelation] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // 當開啟或切換股票時，若無快取則自動抓取或生成
  useEffect(() => {
    if (!isOpen || !code) return;
    setIsEditing(false);
    setCopied(false);

    if (cachedNote && cachedNote.code === code && cachedNote.business) {
      setNote(cachedNote);
      setEditBusiness(cachedNote.business);
      setEditCustomers(cachedNote.customers);
      setEditAiRelation(cachedNote.ai_relation);
      setLoading(false);
      return;
    }

    let isMounted = true;
    setLoading(true);
    fetchStockAiNote(code, name)
      .then((data) => {
        if (!isMounted) return;
        setNote(data);
        setEditBusiness(data.business || '');
        setEditCustomers(data.customers || '');
        setEditAiRelation(data.ai_relation || '');
        onNoteUpdated?.(data);
      })
      .catch((err) => {
        if (!isMounted) return;
        setNote({
          code,
          name,
          business: '目前無法載入筆記，請檢查網路連線或稍後重試。',
          customers: '—',
          ai_relation: '—',
          error: String(err),
        });
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, code, name, cachedNote]);

  // 點擊彈窗外部或按下 Esc 鍵自動關閉
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    // 延遲綁定點擊，避免當次點擊按鈕立即觸發關閉
    const timer = setTimeout(() => {
      window.addEventListener('mousedown', handleClickOutside);
    }, 50);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // 計算彈出框定位
  let popoverStyle: React.CSSProperties = {};
  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
    popoverStyle = {
      position: 'fixed',
      left: '16px',
      right: '16px',
      bottom: '24px',
      maxWidth: 'calc(100vw - 32px)',
      zIndex: 99999,
    };
  } else if (targetRect) {
    const popoverWidth = 360;
    let left = targetRect.right - popoverWidth;
    let top = targetRect.bottom + 8;

    // 防止超出右邊界
    if (left + popoverWidth > window.innerWidth - 16) {
      left = window.innerWidth - popoverWidth - 16;
    }
    // 防止超出左邊界
    if (left < 16) {
      left = 16;
    }
    // 防止超出下邊界（若下方空間不足則往上彈）
    const estimatedHeight = 320;
    if (top + estimatedHeight > window.innerHeight - 16) {
      top = Math.max(16, targetRect.top - estimatedHeight - 8);
    }

    popoverStyle = {
      position: 'fixed',
      top: `${top}px`,
      left: `${left}px`,
      width: `${popoverWidth}px`,
      zIndex: 99999,
    };
  } else {
    popoverStyle = {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: '360px',
      zIndex: 99999,
    };
  }

  const handleRegenerate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    setIsEditing(false);
    try {
      const updated = await regenerateStockAiNote(code, name);
      setNote(updated);
      setEditBusiness(updated.business || '');
      setEditCustomers(updated.customers || '');
      setEditAiRelation(updated.ai_relation || '');
      onNoteUpdated?.(updated);
    } catch (err) {
      alert(`重新生成失敗: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveEdit = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (saving) return;
    setSaving(true);
    try {
      const updated = await updateStockAiNote(code, {
        business: editBusiness.trim(),
        customers: editCustomers.trim(),
        ai_relation: editAiRelation.trim(),
        name,
      });
      setNote(updated);
      onNoteUpdated?.(updated);
      setIsEditing(false);
    } catch (err) {
      alert(`儲存失敗: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!note) return;
    const text = `【${code} ${name || note.name} AI產業筆記】\n【業務】${note.business}\n【客戶】${note.customers}\n【AI交會】${note.ai_relation}`;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const renderContent = () => {
    if (loading) {
      return (
        <div className="note-popover-loading">
          <div className="note-loading-spinner" />
          <div className="note-loading-text">
            <span>AI 正在提煉核心業務、客戶與 AI 題材...</span>
            <span className="note-loading-sub">約需 2~3 秒，生成後永久秒開</span>
          </div>
          <div className="note-skeleton-group">
            <div className="note-skeleton-line sk-w-80" />
            <div className="note-skeleton-line sk-w-100" />
            <div className="note-skeleton-line sk-w-60" />
          </div>
        </div>
      );
    }

    if (isEditing) {
      return (
        <div className="note-popover-edit-form">
          <div className="note-edit-field">
            <label className="note-edit-label">
              <span className="badge-tag-lbl tag-lbl-biz">業務</span> 主要業務做什麼、產業地位與產品：
            </label>
            <textarea
              className="note-edit-textarea"
              rows={2}
              value={editBusiness}
              onChange={(e) => setEditBusiness(e.target.value)}
              placeholder="主要業務與核心產品..."
            />
          </div>
          <div className="note-edit-field">
            <label className="note-edit-label">
              <span className="badge-tag-lbl tag-lbl-cust">客戶</span> 主要客戶有誰（代工/品牌/CSP）：
            </label>
            <textarea
              className="note-edit-textarea"
              rows={2}
              value={editCustomers}
              onChange={(e) => setEditCustomers(e.target.value)}
              placeholder="主要一線客戶與供應鏈..."
            />
          </div>
          <div className="note-edit-field">
            <label className="note-edit-label">
              <span className="badge-tag-lbl tag-lbl-ai">AI交會</span> 與 AI 產業/算力供應鏈交會點：
            </label>
            <textarea
              className="note-edit-textarea"
              rows={2}
              value={editAiRelation}
              onChange={(e) => setEditAiRelation(e.target.value)}
              placeholder="AI 伺服器、算力、交換機、封裝等交會項目..."
            />
          </div>
          <div className="note-edit-actions">
            <button
              type="button"
              className="btn-note-cancel"
              onClick={() => setIsEditing(false)}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="button"
              className="btn-note-save"
              onClick={handleSaveEdit}
              disabled={saving}
            >
              {saving ? '儲存中...' : '儲存修改'}
            </button>
          </div>
        </div>
      );
    }

    if (note?.error) {
      return (
        <div className="note-popover-error-card">
          <div className="note-error-icon">⚠️</div>
          <div className="note-error-msg">{note.business}</div>
          <button
            type="button"
            className="btn-note-retry"
            onClick={handleRegenerate}
          >
            🔄 立即重試生成
          </button>
        </div>
      );
    }

    return (
      <div className="note-popover-sections">
        {/* 格式 1: 三段結構 */}
        <div className="note-section-card">
          <div className="note-sec-header">
            <span className="badge-tag-lbl tag-lbl-biz">業務</span>
            <span className="note-sec-title">核心業務與地位</span>
          </div>
          <p className="note-sec-body">{note?.business || '暫無業務資料'}</p>
        </div>

        <div className="note-section-card">
          <div className="note-sec-header">
            <span className="badge-tag-lbl tag-lbl-cust">客戶</span>
            <span className="note-sec-title">主要客戶與終端</span>
          </div>
          <p className="note-sec-body">{note?.customers || '暫無客戶資料'}</p>
        </div>

        <div className="note-section-card">
          <div className="note-sec-header">
            <span className="badge-tag-lbl tag-lbl-ai">AI交會</span>
            <span className="note-sec-title">AI 產業算力交會點</span>
          </div>
          <p className="note-sec-body">{note?.ai_relation || '暫無 AI 題材交會點'}</p>
        </div>
      </div>
    );
  };

  return createPortal(
    <>
      {/* 遮罩背景 (手機版使用暗幕，電腦版為透明可點擊) */}
      <div
        className={`note-popover-backdrop ${isMobile ? 'backdrop-mobile' : 'backdrop-desktop'}`}
        onClick={onClose}
      />

      <div
        ref={popoverRef}
        className="stock-note-popover-card"
        style={popoverStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 頂部標題列 */}
        <div className="note-popover-header">
          <div className="note-header-left">
            <span className="note-stock-code">{code}</span>
            <span className="note-stock-name">{name || note?.name}</span>
            <span className="note-ai-pill">
              <span className="note-ai-sparkle">✨</span> AI 筆記
            </span>
          </div>
          <button
            type="button"
            className="note-close-btn"
            onClick={onClose}
            title="關閉 (Esc)"
          >
            ✕
          </button>
        </div>

        {/* 筆記主體內容 */}
        <div className="note-popover-content">{renderContent()}</div>

        {/* 底部功能與操作列 */}
        {!loading && !isEditing && (
          <div className="note-popover-footer">
            <div className="note-footer-meta">
              <span className="note-update-time">
                {note?.updated_at ? `更新：${note.updated_at.slice(0, 10)}` : '本機快取'}
              </span>
            </div>
            <div className="note-footer-actions">
              <button
                type="button"
                className="btn-note-action"
                onClick={handleCopy}
                title="複製純文字筆記"
              >
                {copied ? '✓ 已複製' : '📋 複製'}
              </button>
              <button
                type="button"
                className="btn-note-action"
                onClick={() => setIsEditing(true)}
                title="手動自訂編輯筆記"
              >
                ✏️ 編輯
              </button>
              <button
                type="button"
                className="btn-note-action btn-note-regen"
                onClick={handleRegenerate}
                title="使用 Gemini 重新分析生成"
              >
                🔄 重整
              </button>
            </div>
          </div>
        )}
      </div>
    </>,
    document.body
  );
};
