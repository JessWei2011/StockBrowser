import type {
  WatchlistGroup,
  QuoteState,
  StockPosition,
  MarketIndexState,
  MarketCalendarStatus,
  StockAnnouncement,
  StockMaSummary,
  BootstrapResponse,
  GlobalIndicesResponse,
} from '../types';

const BOOTSTRAP_CACHE_KEY = 'stock_browser_bootstrap_cache_v1';
const GLOBAL_INDICES_CACHE_KEY = 'stock_browser_global_indices_cache_v1';

export interface BootstrapCacheData {
  timestamp: number;
  dateStr: string;
  groups: WatchlistGroup[];
  quotes: Record<string, QuoteState>;
  positions?: StockPosition[];
  wealthSummary?: any;
  marketIndices?: Record<string, MarketIndexState> | null;
  marketCalendar?: MarketCalendarStatus | null;
  announcements?: Record<string, StockAnnouncement[]>;
  indicators?: Record<string, StockMaSummary>;
}

/** 取得當天日期字串 (YYYY-MM-DD) */
function getTodayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 讀取 Bootstrap 快取（0 秒立即冷開機呈現） */
export function loadBootstrapCache(): BootstrapCacheData | null {
  try {
    const raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
    if (!raw) return null;
    const parsed: BootstrapCacheData = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.groups) || parsed.groups.length === 0) {
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn('[Cache] Failed to load bootstrap cache:', e);
    return null;
  }
}

/** 儲存 Bootstrap 快取（供下次秒開） */
export function saveBootstrapCache(data: BootstrapResponse): void {
  try {
    const payload: BootstrapCacheData = {
      timestamp: Date.now(),
      dateStr: getTodayDateStr(),
      groups: data.groups,
      quotes: data.quotes,
      positions: data.positions,
      wealthSummary: data.wealthSummary,
      marketIndices: data.marketIndices,
      marketCalendar: data.marketCalendar,
      announcements: data.announcements,
      indicators: data.indicators,
    };
    localStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('[Cache] Failed to save bootstrap cache:', e);
  }
}

/** 讀取國際指數快取 */
export function loadGlobalIndicesCache(): GlobalIndicesResponse | null {
  try {
    const raw = localStorage.getItem(GLOBAL_INDICES_CACHE_KEY);
    if (!raw) return null;
    const parsed: GlobalIndicesResponse = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.us)) {
      return parsed;
    }
  } catch (e) {
    console.warn('[Cache] Failed to load global indices cache:', e);
  }
  return null;
}

/** 儲存國際指數快取 */
export function saveGlobalIndicesCache(data: GlobalIndicesResponse): void {
  try {
    localStorage.setItem(GLOBAL_INDICES_CACHE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('[Cache] Failed to save global indices cache:', e);
  }
}
