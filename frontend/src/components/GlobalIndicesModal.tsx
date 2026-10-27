import React, { useState, useEffect, useId, useRef } from 'react';
import type { GlobalIndicesResponse, MarketIndexState, GlobalIndexItem } from '../types';
import { fetchGlobalIndices } from '../services/api';
import { loadGlobalIndicesCache, saveGlobalIndicesCache } from '../services/storageCache';

interface GlobalIndicesModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'all' | 'tw' | 'us' | 'asia';
  twIndices?: Record<string, MarketIndexState> | null;
  twMarketStatus?: {
    isOpen: boolean;
    badgeLabel: string;
    badgeType: string;
  };
}

const getTxfSession = (twMarketStatus?: { isOpen: boolean; badgeLabel: string; badgeType: string }) => {
  if (twMarketStatus && !twMarketStatus.isOpen && (twMarketStatus.badgeType === 'typhoon' || twMarketStatus.badgeType === 'holiday')) {
    return { statusClass: twMarketStatus.badgeType, statusLabel: twMarketStatus.badgeLabel };
  }
  const now = new Date();
  const twDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = twDate.getDay();
  const mins = twDate.getHours() * 60 + twDate.getMinutes();
  if (day === 0) return { statusClass: 'weekend', statusLabel: '週末休市' };
  if (day === 6 && mins >= 300) return { statusClass: 'weekend', statusLabel: '週末休市' };
  if (day === 1 && mins < 525) return { statusClass: 'closed', statusLabel: '未開盤' };
  // 日盤: 08:45 ~ 13:45
  if (mins >= 525 && mins < 825) return { statusClass: 'open', statusLabel: '日盤交易' };
  // 夜盤: 15:00 ~ 次日 05:00
  if (mins >= 900 || mins < 300) return { statusClass: 'open', statusLabel: '夜盤交易' };
  return { statusClass: 'closed', statusLabel: '盤間休息' };
};

interface SparklineInput {
  reference?: number | null;
  price?: number | null;
  open?: number | null;
  points?: number[];
}

// 專屬大尺寸 Yahoo 風格分時走勢卡片折線圖元件（具備超高容錯與防崩潰機制）
const YahooCardSparkline: React.FC<{ item: SparklineInput }> = ({ item }) => {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const W = 280;
  const H = 64;
  const padTop = 4;
  const padBottom = 4;
  const usableH = H - padTop - padBottom;

  const validPrice = typeof item.price === 'number' && Number.isFinite(item.price) && item.price > 0 ? item.price : 0;
  const validRef = typeof item.reference === 'number' && Number.isFinite(item.reference) && item.reference > 0
    ? item.reference
    : (validPrice > 0 ? validPrice : 100);
  const validOpen = typeof item.open === 'number' && Number.isFinite(item.open) && item.open > 0 ? item.open : validRef;

  const y = validRef;
  const z = validPrice > 0 ? validPrice : y;

  const validPoints = Array.isArray(item.points)
    ? item.points.filter((pt): pt is number => typeof pt === 'number' && Number.isFinite(pt) && pt > 0)
    : [];

  let pts = validPoints.length >= 2
    ? [...validPoints]
    : (validPoints.length === 1 ? [validPoints[0], z] : [validOpen, z]);

  if (pts.length === 0) pts = [y, z];
  if (pts.length === 1) pts = [pts[0], pts[0]];

  // 確保最後一點貼齊現價 (若現價有效)
  if (pts.length > 0 && z > 0) {
    pts[pts.length - 1] = z;
  }

  let minVal = y;
  let maxVal = y;
  for (const pt of pts) {
    if (pt < minVal) minVal = pt;
    if (pt > maxVal) maxVal = pt;
  }

  const span = Math.max(0, maxVal - minVal);
  const margin = Math.max(span * 0.08, 0.5);
  const scaleMin = minVal - margin;
  const scaleMax = maxVal + margin;
  const scaleRange = Math.max(scaleMax - scaleMin, 0.001);

  const getY = (val: number) => {
    const ratio = Math.max(0, Math.min(1, (val - scaleMin) / scaleRange));
    return padTop + (1 - ratio) * usableH;
  };

  const rawBaseY = getY(y);
  const baseY = Number.isFinite(rawBaseY)
    ? Math.max(padTop, Math.min(H - padBottom, Math.round(rawBaseY * 10) / 10))
    : Math.round(H / 2);
  const totalPts = pts.length;

  const coords: Array<[number, number]> = pts.map((pt, i) => {
    const x = totalPts > 1 ? (i / (totalPts - 1)) * (W - 8) + 4 : W / 2;
    const cy = Math.max(padTop, Math.min(H - padBottom, getY(pt)));
    return [
      Number.isFinite(x) ? Math.round(x * 10) / 10 : 4,
      Number.isFinite(cy) ? Math.round(cy * 10) / 10 : baseY,
    ];
  });

  const firstX = coords.length > 0 && Number.isFinite(coords[0][0]) ? coords[0][0] : 4;
  const lastX = coords.length > 0 && Number.isFinite(coords[coords.length - 1][0]) ? coords[coords.length - 1][0] : W - 4;
  const lastY = coords.length > 0 && Number.isFinite(coords[coords.length - 1][1]) ? coords[coords.length - 1][1] : baseY;

  const lineD = coords.reduce((acc, [x, cy], i) => `${acc} ${i === 0 ? 'M' : 'L'} ${x} ${cy}`, '');
  const areaD = `${lineD} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;

  const isUp = z >= y;
  const pointColor = isUp ? '#ff5964' : '#22c55e';
  const clipAboveH = Math.max(0, baseY);
  const clipBelowH = Math.max(0, H - baseY);

  return (
    <svg className="yahoo-modal-sparkline" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
      <defs>
        <linearGradient id={`m-grad-up-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ff5964" stopOpacity="0.45" />
          <stop offset="90%" stopColor="#ff5964" stopOpacity="0.05" />
        </linearGradient>

        <linearGradient id={`m-grad-down-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="10%" stopColor="#22c55e" stopOpacity="0.05" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0.45" />
        </linearGradient>

        <clipPath id={`m-clip-above-${uid}`}>
          <rect x="0" y="0" width={W} height={clipAboveH} />
        </clipPath>

        <clipPath id={`m-clip-below-${uid}`}>
          <rect x="0" y={baseY} width={W} height={clipBelowH} />
        </clipPath>
      </defs>

      {/* 昨收基準線 */}
      <line
        x1="2"
        y1={baseY}
        x2={W - 2}
        y2={baseY}
        stroke="var(--border-color, #94a3b8)"
        strokeDasharray="3,2.5"
        strokeWidth="1"
        opacity="0.85"
      />

      {/* 基準線上：紅線 + 紅漸層 */}
      <g clipPath={`url(#m-clip-above-${uid})`}>
        <path d={areaD} fill={`url(#m-grad-up-${uid})`} />
        <path d={lineD} fill="none" stroke="#ff5964" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* 基準線下：綠線 + 綠漸層 */}
      <g clipPath={`url(#m-clip-below-${uid})`}>
        <path d={areaD} fill={`url(#m-grad-down-${uid})`} />
        <path d={lineD} fill="none" stroke="#22c55e" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* 端點圓點 */}
      <circle cx={lastX} cy={lastY} r="3" fill={pointColor} stroke="var(--bg-card, #ffffff)" strokeWidth="1.5" />
    </svg>
  );
};

const GlobalIndicesModalContent: React.FC<GlobalIndicesModalProps> = ({
  isOpen,
  onClose,
  initialTab = 'all',
  twIndices,
  twMarketStatus,
}) => {
  const [activeTab, setActiveTab] = useState<'all' | 'tw' | 'us' | 'asia'>(initialTab);
  // 優先由本地快取載入國際指數（秒開無等待）
  const [data, setData] = useState<GlobalIndicesResponse | null>(() => loadGlobalIndicesCache());
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>('');
  const prevOpenRef = useRef(false);

  // 僅在視窗從關閉切換為開啟時，切換為呼叫端指定的初始分頁，避免背景 WebSocket 更新時重置使用者分頁
  useEffect(() => {
    if (!prevOpenRef.current && isOpen) {
      setActiveTab(initialTab);
    }
    prevOpenRef.current = isOpen;
  }, [isOpen, initialTab]);

  const loadData = async () => {
    try {
      setLoading(true);
      const res = await fetchGlobalIndices();
      setData(res);
      saveGlobalIndicesCache(res);
      setLastRefreshed(new Date().toLocaleTimeString('zh-TW', { hour12: false }));
    } catch (e) {
      console.error('Failed to load global indices:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadData();
      const timer = setInterval(loadData, 30000);
      return () => clearInterval(timer);
    }
  }, [isOpen]);

  // 支援 ESC 鍵快速關閉
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const fmt = (num?: number | null) =>
    typeof num === 'number' && Number.isFinite(num)
      ? num.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '-';

  const fmtPct = (pct?: number | null) => {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) return '0.00%';
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(2)}%`;
  };

  // 合併來自 App props 與來自 API 的台股三大指數
  const effectiveTw = (twIndices && Object.keys(twIndices).length > 0) ? twIndices : data?.tw;

  const renderTwCard = (
    item: MarketIndexState | undefined,
    defaultName: string,
    defaultCode: string,
    overrideSession?: { statusClass: string; statusLabel: string }
  ) => {
    if (!item) return null;
    const isUp = item.change > 0;
    const isDown = item.change < 0;
    const chgColor = isUp ? 'color-up' : isDown ? 'color-down' : 'color-neutral';
    const chgSign = isUp ? '▲' : isDown ? '▼' : '';
    const ref = item.reference || (item.price ? item.price - item.change : item.price);
    const statusClass = overrideSession?.statusClass || twMarketStatus?.badgeType || 'closed';
    const statusLabel = overrideSession?.statusLabel || twMarketStatus?.badgeLabel || '休市中';

    return (
      <div key={defaultCode} className={`yahoo-index-card status-${statusClass}`}>
        <div className="yahoo-card-header">
          <div className="yahoo-card-title-col">
            <div className="yahoo-card-name-row">
              <span className="yahoo-card-name">{item.name || defaultName}</span>
              <span className={`card-status-pill ${statusClass}`}>
                <span className="card-status-dot" />
                {statusLabel}
              </span>
            </div>
            <div className="yahoo-card-meta-row">
              <span className="yahoo-card-symbol">{item.code || defaultCode}</span>
              {item.volumeText && (
                <span className="yahoo-card-vol">成交 {item.volumeText}</span>
              )}
            </div>
          </div>

          <div className="yahoo-card-price-col">
            <div className={`yahoo-card-price ${chgColor}`}>
              {fmt(item.price)}
            </div>
            <div className={`yahoo-card-change ${chgColor}`}>
              <span>
                {chgSign} {fmt(Math.abs(item.change))}
              </span>
              <span>
                ({fmtPct(item.changePercent)})
              </span>
            </div>
          </div>
        </div>

        <div className="yahoo-card-chart-area">
          <YahooCardSparkline
            item={{
              reference: ref,
              price: item.price,
              open: item.open,
              points: item.points,
            }}
          />
        </div>

        <div className="yahoo-card-stats-grid">
          <div className="yahoo-stat-item">
            <span className="yahoo-stat-label">開盤</span>
            <span className="yahoo-stat-val">{fmt(item.open)}</span>
          </div>
          <div className="yahoo-stat-item">
            <span className="yahoo-stat-label">昨收</span>
            <span className="yahoo-stat-val">{fmt(ref)}</span>
          </div>
          <div className="yahoo-stat-item">
            <span className="yahoo-stat-label">最高</span>
            <span className="yahoo-stat-val">{fmt(item.high)}</span>
          </div>
          <div className="yahoo-stat-item">
            <span className="yahoo-stat-label">最低</span>
            <span className="yahoo-stat-val">{fmt(item.low)}</span>
          </div>
        </div>
      </div>
    );
  };

  const renderGlobalCard = (item: GlobalIndexItem) => {
    const isUp = item.change > 0;
    const isDown = item.change < 0;
    const chgColor = isUp ? 'color-up' : isDown ? 'color-down' : 'color-neutral';
    const chgSign = isUp ? '▲' : isDown ? '▼' : '';
    const statusClass = item.marketStatus || 'closed';
    const statusLabel = item.statusLabel || (statusClass === 'open' ? '盤中交易' : '已收盤');

    return (
      <div key={item.symbol} className={`yahoo-index-card status-${statusClass}`}>
        <div className="yahoo-card-header">
          <div className="yahoo-card-title-col">
            <div className="yahoo-card-name-row">
              <span className="yahoo-card-name">{item.name}</span>
              <span className={`card-status-pill ${statusClass}`} title={item.tradingHours || ''}>
                <span className="card-status-dot" />
                {statusLabel}
              </span>
            </div>
            <div className="yahoo-card-meta-row">
              <span className="yahoo-card-symbol">{item.symbol}</span>
              {item.englishName && (
                <span className="yahoo-card-en-name">{item.englishName}</span>
              )}
            </div>
          </div>

          <div className="yahoo-card-price-col">
            <div className={`yahoo-card-price ${chgColor}`}>
              {fmt(item.price)}
            </div>
            <div className={`yahoo-card-change ${chgColor}`}>
              <span>
                {chgSign} {fmt(Math.abs(item.change))}
              </span>
              <span>
                ({fmtPct(item.changePercent)})
              </span>
            </div>
          </div>
        </div>

        <div className="yahoo-card-chart-area">
          <YahooCardSparkline item={item} />
        </div>

        <div className="yahoo-card-stats-grid">
          <div className="yahoo-stat-item">
            <span className="yahoo-stat-label">開盤</span>
            <span className="yahoo-stat-val">{fmt(item.open)}</span>
          </div>
          <div className="yahoo-stat-item">
            <span className="yahoo-stat-label">昨收</span>
            <span className="yahoo-stat-val">{fmt(item.reference)}</span>
          </div>
          <div className="yahoo-stat-item">
            <span className="yahoo-stat-label">最高</span>
            <span className="yahoo-stat-val">{fmt(item.high)}</span>
          </div>
          <div className="yahoo-stat-item">
            <span className="yahoo-stat-label">最低</span>
            <span className="yahoo-stat-val">{fmt(item.low)}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="global-modal-overlay" onClick={onClose}>
      <div className="global-modal-content" onClick={(e) => e.stopPropagation()}>
        {/* 頂部標題列 */}
        <div className="global-modal-header">
          <div className="global-modal-header-left">
            <button
              className="global-modal-back-btn"
              onClick={onClose}
              title="返回我的自選看盤"
            >
              <span className="back-arrow">‹</span>
              <span className="back-text">返回</span>
            </button>
            <div className="global-modal-title-group">
              <h2 className="global-modal-title">
                <span className="global-modal-icon">📈</span> 大盤與國際指數
              </h2>
              <span className="global-modal-subtitle">
                {lastRefreshed ? `最後同步: ${lastRefreshed}` : '即時同步中'}
              </span>
            </div>
          </div>

          <div className="global-modal-actions">
            <button
              className={`btn-icon ${loading ? 'spinning' : ''}`}
              title="重新整理行情"
              onClick={loadData}
              disabled={loading}
            >
              ↻
            </button>
            <button className="global-modal-close" onClick={onClose} title="關閉視窗">
              ✕
            </button>
          </div>
        </div>

        {/* 頁籤切換 (全部 / 台股 / 美股 / 亞股) */}
        <div className="global-modal-tabs">
          <button
            className={`global-tab-btn ${activeTab === 'all' ? 'active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            <span>🌐 全部市場 (台/美/亞)</span>
          </button>
          <button
            className={`global-tab-btn ${activeTab === 'tw' ? 'active' : ''}`}
            onClick={() => setActiveTab('tw')}
          >
            <span>🇹🇼 台股大盤</span>
            <span className={`tab-market-badge ${twMarketStatus?.badgeType || 'closed'}`}>
              <span className="tab-status-dot" />
              {twMarketStatus?.badgeLabel || '休市中'}
            </span>
          </button>
          <button
            className={`global-tab-btn ${activeTab === 'us' ? 'active' : ''}`}
            onClick={() => setActiveTab('us')}
          >
            <span>🇺🇸 美股四大指數</span>
            {data?.marketSummary?.us && (
              <span className={`tab-market-badge ${data.marketSummary.us.status}`}>
                <span className="tab-status-dot" />
                {data.marketSummary.us.label}
              </span>
            )}
          </button>
          <button
            className={`global-tab-btn ${activeTab === 'asia' ? 'active' : ''}`}
            onClick={() => setActiveTab('asia')}
          >
            <span>🌏 亞股主要指數</span>
            {data?.marketSummary?.asia && (
              <span className={`tab-market-badge ${data.marketSummary.asia.status}`}>
                <span className="tab-status-dot" />
                {data.marketSummary.asia.label}
              </span>
            )}
          </button>
        </div>

        {/* 交易時鐘與時段提示列 */}
        <div className="global-modal-time-banner">
          <span className="time-banner-icon">🕒</span>
          <span className="time-banner-text">
            {activeTab === 'all' && '全球主要交易時段：台股 09:00~13:30 ｜ 美股 台北 21:30~04:00 (夏令) ｜ 亞股日韓 08:00~14:30'}
            {activeTab === 'tw' && '台股現貨：09:00 ~ 13:30 ｜ 台指期貨：日盤 08:45 ~ 13:45、夜盤 15:00 ~ 次日 05:00'}
            {activeTab === 'us' && `美股時段：${data?.marketSummary?.us?.hours || '台北 21:30~04:00 (夏令) / 22:30~05:00 (冬令) ｜ 美東 09:30~16:00'}`}
            {activeTab === 'asia' && '亞股時段：日股 台北 08:00~14:30 (10:30~11:30 午休) ｜ 韓股 台北 08:00~14:30 (全日連續交易)'}
          </span>
        </div>

        {/* 卡片網格 (Yahoo 樣式) */}
        <div className={`global-cards-grid grid-${activeTab}`}>
          {/* 1. 全部行情檢視 (台股 + 美股 + 亞股) */}
          {activeTab === 'all' && (
            <>
              <div className="global-grid-section-header">
                <span>🇹🇼 台股大盤行情</span>
                <span className={`tab-market-badge ${twMarketStatus?.badgeType || 'closed'}`}>
                  <span className="tab-status-dot" />
                  {twMarketStatus?.badgeLabel || '休市中'}
                </span>
              </div>
              {renderTwCard(effectiveTw?.TSE, '上市（加權指數）', 'IX0001')}
              {renderTwCard(effectiveTw?.OTC, '上櫃（櫃買指數）', 'IX0043')}
              {renderTwCard(effectiveTw?.TXF, '台指近（全）', 'WTX&', getTxfSession(twMarketStatus))}

              <div className="global-grid-section-header">
                <span>🇺🇸 美股四大指數</span>
                {data?.marketSummary?.us && (
                  <span className={`tab-market-badge ${data.marketSummary.us.status}`}>
                    <span className="tab-status-dot" />
                    {data.marketSummary.us.label}
                  </span>
                )}
              </div>
              {(data?.us || []).map(renderGlobalCard)}

              <div className="global-grid-section-header">
                <span>🌏 亞股主要指數</span>
                {data?.marketSummary?.asia && (
                  <span className={`tab-market-badge ${data.marketSummary.asia.status}`}>
                    <span className="tab-status-dot" />
                    {data.marketSummary.asia.label}
                  </span>
                )}
              </div>
              {(data?.asia || []).map(renderGlobalCard)}
            </>
          )}

          {/* 2. 僅台股分頁 */}
          {activeTab === 'tw' && (
            <>
              {renderTwCard(effectiveTw?.TSE, '上市（加權指數）', 'IX0001')}
              {renderTwCard(effectiveTw?.OTC, '上櫃（櫃買指數）', 'IX0043')}
              {renderTwCard(effectiveTw?.TXF, '台指近（全）', 'WTX&', getTxfSession(twMarketStatus))}
            </>
          )}

          {/* 3. 僅美股分頁 */}
          {activeTab === 'us' && (data?.us || []).map(renderGlobalCard)}

          {/* 4. 僅亞股分頁 */}
          {activeTab === 'asia' && (data?.asia || []).map(renderGlobalCard)}
        </div>

        {/* 底部備註與返回按鈕 */}
        <div className="global-modal-footer">
          <button
            type="button"
            className="global-modal-bottom-back-btn"
            onClick={onClose}
            title="返回看盤列表"
          >
            ‹ 返回自選股
          </button>
          <span className="global-modal-footer-note">
            數據來源：永豐金即時報價 & Yahoo 財經 ｜ 分時走勢圖以昨日收盤為基準線，上方紅色、下方綠色
          </span>
        </div>
      </div>
    </div>
  );
};

interface ErrorBoundaryProps {
  children: React.ReactNode;
  onClose: () => void;
  isOpen: boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorInfo?: string;
}

class ModalErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: any): ErrorBoundaryState {
    return { hasError: true, errorInfo: String(error?.message || error) };
  }

  componentDidCatch(error: any, info: any) {
    console.error('[GlobalIndicesModal] Uncaught Render Error:', error, info);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    // 當視窗重新打開時重置錯誤狀態
    if (!prevProps.isOpen && this.props.isOpen && this.state.hasError) {
      this.setState({ hasError: false, errorInfo: undefined });
    }
  }

  render() {
    if (this.state.hasError && this.props.isOpen) {
      return (
        <div className="global-modal-overlay" onClick={this.props.onClose}>
          <div className="global-modal-content global-modal-error-fallback" onClick={(e) => e.stopPropagation()}>
            <div className="global-modal-header">
              <button
                type="button"
                className="global-modal-back-btn"
                onClick={this.props.onClose}
                title="返回看盤"
              >
                <span className="back-arrow">‹</span>
                <span className="back-text">返回</span>
              </button>
              <h2 className="global-modal-title">📈 國際指數行情</h2>
              <button
                type="button"
                className="global-modal-close"
                onClick={this.props.onClose}
                title="關閉"
              >
                ✕
              </button>
            </div>
            <div style={{ padding: '32px 16px', textAlign: 'center', flex: 1 }}>
              <div style={{ fontSize: '36px', marginBottom: '12px' }}>⚠️</div>
              <h3 style={{ margin: '0 0 8px 0', color: 'var(--text-main, #fff)' }}>行情暫時無法顯示</h3>
              <p style={{ color: 'var(--text-muted, #94a3b8)', fontSize: '13px', margin: '0 0 20px 0' }}>
                抱歉，國際指數資料載入中發生錯誤，系統已為您隔離保護看盤功能。
              </p>
              <button
                type="button"
                className="global-modal-bottom-back-btn"
                onClick={this.props.onClose}
              >
                ‹ 返回自選股
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export const GlobalIndicesModal: React.FC<GlobalIndicesModalProps> = (props) => {
  return (
    <ModalErrorBoundary isOpen={props.isOpen} onClose={props.onClose}>
      <GlobalIndicesModalContent {...props} />
    </ModalErrorBoundary>
  );
};
