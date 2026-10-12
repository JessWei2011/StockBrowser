import React, { useState } from 'react';

interface VaultPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const VAULT_DEFAULT_PASSWORD = '1030';
const STORAGE_KEY_AUTH = 'vault_authenticated';
const STORAGE_KEY_CUSTOM_PWD = 'vault_custom_password';

export const getStoredVaultPassword = (): string => {
  return localStorage.getItem(STORAGE_KEY_CUSTOM_PWD) || VAULT_DEFAULT_PASSWORD;
};

export const setStoredVaultPassword = (newPassword: string): void => {
  localStorage.setItem(STORAGE_KEY_CUSTOM_PWD, newPassword);
};

export const isVaultAuthenticated = (): boolean => {
  return sessionStorage.getItem(STORAGE_KEY_AUTH) === 'true';
};

export const markVaultAuthenticated = (): void => {
  sessionStorage.setItem(STORAGE_KEY_AUTH, 'true');
};

export const clearVaultAuthenticated = (): void => {
  sessionStorage.removeItem(STORAGE_KEY_AUTH);
};

export const VaultPasswordModal: React.FC<VaultPasswordModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const correctPassword = getStoredVaultPassword();
    if (password === correctPassword) {
      markVaultAuthenticated();
      setPassword('');
      setErrorMsg('');
      onSuccess();
    } else {
      setErrorMsg('密碼錯誤，請重新輸入');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card vault-password-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '380px' }}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>🔒</span>
            <h2 className="modal-title">財神庫安全驗證</h2>
          </div>
          <button className="modal-close" onClick={onClose} title="關閉">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <p style={{ margin: '0 0 14px 0', fontSize: '13px', color: 'var(--text-sub)' }}>
              需要通關密碼
            </p>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="modal-input"
                  placeholder="請輸入密碼"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errorMsg) setErrorMsg('');
                  }}
                  autoFocus
                  style={{
                    paddingRight: '36px',
                    borderColor: errorMsg ? '#ef4444' : undefined,
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: '10px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: '14px',
                    opacity: 0.6,
                    padding: 0,
                  }}
                  title={showPassword ? '隱藏密碼' : '顯示密碼'}
                >
                  {showPassword ? '🙈' : '👁️'}
                </button>
              </div>

              {errorMsg && (
                <div style={{ color: '#ef4444', fontSize: '12px', marginTop: '6px' }}>
                  ⚠️ {errorMsg}
                </div>
              )}
            </div>
          </div>

          <div className="modal-footer" style={{ borderTop: '1px solid var(--border-color)', padding: '12px 20px', margin: 0 }}>
            <button type="button" className="btn-secondary" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={!password.trim()}
              style={{
                backgroundColor: 'var(--color-orange)',
                borderColor: 'var(--color-orange)',
              }}
            >
              解鎖並開啟
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
