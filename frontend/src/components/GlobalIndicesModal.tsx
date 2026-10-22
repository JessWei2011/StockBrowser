import React, { useState, useEffect, useId } from 'react';
import type { GlobalIndexItem, GlobalIndicesResponse } from '../types';
import { fetchGlobalIndices } from '../services/api';

interface GlobalIndicesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// 專屬大尺寸 Yahoo 風格分時走勢卡片折線圖元件
const YahooCardSparkline: React.FC<{ item: GlobalIndexItem }> = ({ item }) => {
  const uid = useId().replace(/:/g, '');
  const W = 280;
  const H = 64;
  const padTop = 4;
  const padBottom = 4;
  const usableH = H - padTop - padBottom;

  const y = item.reference;
  const z = item.price;
  const rawPoints = Array.isArray(item.points) && item.points.length > 0
    ? [...item.points]
    : [item.open || y, z];

  // 確保最後一點貼齊現價
  if (rawPoints.length > 0 && z > 0) {
    rawPoints[rawPoints.length - 1] = z;
  }

  let minVal = y;
  let maxVal = y;
  for (const pt of rawPoints) {
    if (pt < minVal) minVal = pt;
    if (pt > maxVal) maxVal = pt;
  }

  const span = maxVal - minVal;
  const margin = Math.max(span * 0.08, 0.5);
  const scaleMin = minVal - margin;
  const scaleMax = maxVal + margin;
  const scaleRange = scaleMax - scaleMin || 1;

  const getY = (val: number) => {
    const ratio = (val - scaleMin) / scaleRange;
    return padTop + (1 - ratio) * usableH;
  };

  const baseY = Math.max(padTop, Math.min(H - padBottom, getY(y)));
  const totalPts = rawPoints.length;

  const coords: Array<[number, number]> = rawPoints.map((pt, i) => {
    const x = totalPts > 1 ? (i / (totalPts - 1)) * (W - 8) + 4 : W / 2;
    const cy = getY(pt);
    return [Math.round(x * 10) / 10, Math.round(cy * 10) / 10];
  });

  const lineD = coords.reduce((acc, [x, cy], i) => `${acc} ${i === 0 ? 'M' : 'L'} ${x} ${cy}`, '');
  const firstX = coords[0][0];
  const lastX = coords[coords.length - 1][0];
  const lastY = coords[coords.length - 1][1];
  const areaD = `${lineD} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;

  const isUp = z >= y;
  const pointColor = isUp ? '#ff5964' : '#22c55e';

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
          <rect x="0" y="0" width={W} height={baseY} />
        </clipPath>

        <clipPath id={`m-clip-below-${uid}`}>
          <rect x="0" y={baseY} width={W} height={H - baseY} />
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

export const GlobalIndicesModal: React.FC<GlobalIndicesModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'us' | 'asia'>('us');
  const [data, setData] = useState<GlobalIndicesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>('');

  const loadData = async () => {
    try {
      setLoading(true);
      const res = await fetchGlobalIndices();
      setData(res);
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

  if (!isOpen) return null;

  const currentList: GlobalIndexItem[] = data ? (activeTab === 'us' ? data.us : data.asia) : [];

  const fmt = (num?: number | null) =>
    typeof num === 'number' && Number.isFinite(num)
      ? num.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '-';

  return (
    <div className="global-modal-overlay" onClick={onClose}>
      <div className="global-modal-content" onClick={(e) => e.stopPropagation()}>
        {/* 頂部標題列 */}
        <div className="global-modal-header">
          <div className="global-modal-title-group">
            <h2 className="global-modal-title">
              <span className="global-modal-icon">🌐</span> 國際股市行情
            </h2>
            <span className="global-modal-subtitle">
              {lastRefreshed ? `更新時間: ${lastRefreshed}` : '即時同步中'}
            </span>
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
            <button className="global-modal-close" onClick={onClose} title="關閉">
              ✕
            </button>
          </div>
        </div>

        {/* 頁籤切換 (美股 / 亞股) */}
        <div className="global-modal-tabs">
          <button
            className={`global-tab-btn ${activeTab === 'us' ? 'active' : ''}`}
            onClick={() => setActiveTab('us')}
          >
            美股主要指數 ({data?.us?.length || 4})
          </button>
          <button
            className={`global-tab-btn ${activeTab === 'asia' ? 'active' : ''}`}
            onClick={() => setActiveTab('asia')}
          >
            亞股（日韓）({data?.asia?.length || 2})
          </button>
        </div>

        {/* 卡片網格 (Yahoo 樣式) */}
        <div className="global-cards-grid">
          {currentList.map((item) => {
            const isUp = item.change > 0;
            const isDown = item.change < 0;
            const chgColor = isUp ? 'color-up' : isDown ? 'color-down' : 'color-neutral';
            const chgSign = isUp ? '▲' : isDown ? '▼' : '';

            return (
              <div key={item.symbol} className="yahoo-index-card">
                {/* 卡片頭部：名稱 + 現價與漲跌幅 */}
                <div className="yahoo-card-header">
                  <div className="yahoo-card-title-col">
                    <span className="yahoo-card-name">{item.name}</span>
                    <span className="yahoo-card-symbol">{item.symbol}</span>
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
                        ({item.changePercent > 0 ? '+' : ''}
                        {item.changePercent.toFixed(2)}%)
                      </span>
                    </div>
                  </div>
                </div>

                {/* 卡片中間：Yahoo 雙色走勢圖 */}
                <div className="yahoo-card-chart-area">
                  <YahooCardSparkline item={item} />
                </div>

                {/* 卡片底部：2×2 數據 (開盤、昨收、最高、最低) */}
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
          })}
        </div>

        {/* 底部備註 */}
        <div className="global-modal-footer">
          <span>數據來源：Yahoo 財經行情 ｜ 分時走勢圖依昨收為基準線，上方紅色、下方綠色</span>
        </div>
      </div>
    </div>
  );
};
