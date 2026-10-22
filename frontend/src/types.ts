export type DataStatus = 'live' | 'stale' | 'initializing' | 'closed' | 'error';

export interface QuoteState {
  code: string;
  name: string;
  exchange: string;
  securityType: string;
  last: number | null;
  oddLotLast?: number | null;
  bid: number | null;
  ask: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  totalVolume: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  isSimulated?: boolean;
  isAttention?: boolean;
  dispositionLevel?: number;
  dispositionPeriod?: string | null;
  sourceTs: string | null;
  oddLotSourceTs?: string | null;
  receivedAt: string;
  dataStatus: DataStatus;
  revision: number;
}

export interface WatchlistItem {
  id: string;
  groupId: string;
  code: string;
  name: string;
  exchange: string;
  securityType: string;
  position: number;
}

export interface WatchlistGroup {
  id: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  isSystemGroup?: boolean;
  items: WatchlistItem[];
}

export interface UpstreamStatus {
  connected: boolean;
  loggedIn: boolean;
  lastQuoteTime: string | null;
  subscribedCount: number;
  maxAllowed: number;
  isMarketOpen?: boolean;
  marketMode?: string;
}

export interface WealthSummary {
  totalPnl: number;
  totalCost: number;
  totalMarketValue: number;
  returnPercent: number;
}

export interface MarketIndexState {
  code: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  reference?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volumeText?: string | null;
  volumeAmount?: number | null;
  points?: number[];
}

export interface GlobalIndexItem {
  symbol: string;
  name: string;
  englishName?: string;
  price: number;
  reference: number;
  open: number;
  high: number;
  low: number;
  change: number;
  changePercent: number;
  points: number[];
}

export interface GlobalIndicesResponse {
  us: GlobalIndexItem[];
  asia: GlobalIndexItem[];
  updatedAt: string;
}

export interface StockPosition {
  code: string;
  name: string;
  exchange?: string;
  quantity: number;
  costPrice: number;
  initialLast?: number;
  initialPnl?: number;
}

export interface StockAnnouncement {
  id: string;
  code: string;
  tag: string;
  title: string;
  date?: string | null;
  detail?: string | null;
  category: 'attention' | 'disposition' | 'news' | 'exdividend' | 'earnings' | 'revenue';
  updatedAt?: string | null;
}

export interface CalendarEvent {
  id: string;
  date: string; // YYYY-MM-DD
  time?: string | null;
  type: 'futures' | 'macro' | 'stock' | 'exhibition';
  category: string;
  title: string;
  tag: string;
  code?: string | null;
  name?: string | null;
  detail?: string | null;
  forecast?: string | null;
  previous?: string | null;
  impact?: 'High' | 'Medium' | 'Low' | string | null;
}

export interface CalendarMonthData {
  year: number;
  month: number;
  events: CalendarEvent[];
  updatedAt: string;
}

export interface StockMaSummary {
  code: string;
  name?: string;
  ma5?: number | null;
  ma10?: number | null;
  ma20?: number | null;
  lastClose?: number | null;
  recentCloses?: number[];
}

export interface BootstrapResponse {
  groups: WatchlistGroup[];
  quotes: Record<string, QuoteState>;
  announcements?: Record<string, StockAnnouncement[]>;
  positions?: StockPosition[];
  wealthSummary?: WealthSummary;
  marketIndices?: Record<string, MarketIndexState>;
  indicators?: Record<string, StockMaSummary>;
  serverVersion: number;
  upstream: UpstreamStatus;
}

export interface InstrumentSearchResult {
  code: string;
  name: string;
  exchange: string;
  securityType: string;
  reference: number | null;
  isAttention?: boolean;
  dispositionLevel?: number;
  dispositionPeriod?: string | null;
}

export type WebSocketMessage =
  | {
      type: 'snapshot';
      serverVersion: number;
      generatedAt: string;
      quotes: QuoteState[];
      positions?: StockPosition[];
      wealthSummary?: WealthSummary;
      marketIndices?: Record<string, MarketIndexState>;
    }
  | {
      type: 'quote_delta';
      serverVersion: number;
      generatedAt: string;
      quotes: QuoteState[];
      wealthSummary?: WealthSummary;
      marketIndices?: Record<string, MarketIndexState>;
    }
  | {
      type: 'watchlist_changed';
      serverVersion: number;
      generatedAt: string;
    }
  | {
      type: 'pong';
      ts: string;
    };

export interface KlineBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5?: number | null;
  ma10?: number | null;
  ma20?: number | null;
  ma60?: number | null;
  boll_up?: number | null;
  boll_mid?: number | null;
  boll_down?: number | null;
  rsi?: number | null;
  macd_hist?: number | null;
  k?: number | null;
  d?: number | null;
}

export interface InstitutionalFlowItem {
  date: string;
  foreign: number;
  trust: number;
  dealer: number;
  total: number;
}

export interface MarginFlowItem {
  date: string;
  margin_balance: number;
  margin_change: number;
  short_balance: number;
  short_change: number;
}

export interface HolderFlowItem {
  date: string;
  over400_pct: number;
  over600_pct: number;
  over800_pct: number;
  over1000_pct: number;
  retail_pct: number;
  total_holders: number;
}

export interface StockChartData {
  code: string;
  name: string;
  title: string;
  lastUpdate: string;
  kline: KlineBar[];
  institutional: InstitutionalFlowItem[];
  margin: MarginFlowItem[];
  holders: HolderFlowItem[];
  isAppendedToday: boolean;
}

export interface OrderItem {
  id: string;
  ordno: string;
  code: string;
  name: string;
  action: 'Buy' | 'Sell' | string;
  price: number;
  originalPrice: number;
  modifiedPrice: number;
  priceType: string;
  qty: number;
  originalQty: number;
  dealQty: number;
  cancelQty: number;
  orderLot: 'Common' | 'IntradayOdd' | string;
  status: string;
  statusCode: string;
  msg: string;
  time: string;
  canCancel: boolean;
  canUpdatePrice: boolean;
  canUpdateQty: boolean;
}

export interface UpdateOrderParams {
  newPrice?: number;
  newQty?: number;
}

export interface SettlementItem {
  t: number;
  date: string;
  amount: number;
  amountWan: number;
}

export interface SettlementTradeDetail {
  code: string;
  name: string;
  action: 'Buy' | 'Sell' | string;
  qty: number;
  price: number;
  totalPrice: number;
  fee: number;
  tax: number;
  netAmount: number;
  netAmountWan: number;
}

export interface AccountBalanceState {
  hasConfigured: boolean;
  baseCapitalWan: number | null;
  capitalMode: 'before_t0' | 'after_t0';
  t0Date: string;
  t0Amount: number;
  t0RemainingWan: number | null;
  t1Date: string;
  t1Amount: number;
  t1RemainingWan: number | null;
  t2Date: string;
  t2Amount: number;
  t2RemainingWan: number | null;
  t2Formula?: string;
  t2Details?: SettlementTradeDetail[];
  settlements: SettlementItem[];
  updatedAt: string;
}


