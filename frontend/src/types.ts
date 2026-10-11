export type DataStatus = 'live' | 'stale' | 'initializing' | 'closed' | 'error';

export interface QuoteState {
  code: string;
  name: string;
  exchange: string;
  securityType: string;
  last: number | null;
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

export interface BootstrapResponse {
  groups: WatchlistGroup[];
  quotes: Record<string, QuoteState>;
  wealthSummary?: WealthSummary;
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
    }
  | {
      type: 'quote_delta';
      serverVersion: number;
      generatedAt: string;
      quotes: QuoteState[];
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
