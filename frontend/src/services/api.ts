import type { BootstrapResponse, InstrumentSearchResult, WatchlistGroup, WatchlistItem, StockAnnouncement, AccountBalanceState } from '../types';

const API_BASE = import.meta.env.VITE_API_BASE || '';

/**
 * Helper for fetch with timeout and error handling.
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, timeoutMs);

  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } catch (err: any) {
    if (err.name === 'AbortError' || controller.signal.aborted) {
      if (timeoutTriggered) {
        throw new Error(`伺服器連線逾時（超過 ${Math.round(timeoutMs / 1000)} 秒），請稍後再試`);
      }
      throw err;
    }
    if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('Failed to fetch'))) {
      throw new Error('無法連線至看盤伺服器，請檢查後端服務是否正常運行');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBootstrap(signal?: AbortSignal): Promise<BootstrapResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/bootstrap`, { signal }, 10000);
  if (!res.ok) throw new Error(`Bootstrap failed: ${res.statusText}`);
  return res.json();
}

export async function searchInstruments(query: string, signal?: AbortSignal): Promise<InstrumentSearchResult[]> {
  if (!query.trim()) return [];
  const res = await fetchWithTimeout(
    `${API_BASE}/api/v1/instruments/search?q=${encodeURIComponent(query.trim())}`,
    { signal },
    5000
  );
  if (!res.ok) throw new Error(`Search failed: ${res.statusText}`);
  return res.json();
}

export async function createGroup(name: string): Promise<WatchlistGroup> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to create group');
  }
  return res.json();
}

export async function updateGroup(groupId: string, data: { name?: string; position?: number }): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/groups/${groupId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update group');
}

export async function reorderGroups(groupIds: string[]): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/groups/order`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_ids: groupIds }),
  });
  if (!res.ok) throw new Error('Failed to reorder groups');
}

export async function deleteGroup(groupId: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/groups/${groupId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete group');
}

export async function addItem(groupId: string, code: string, signal?: AbortSignal): Promise<WatchlistItem> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/groups/${groupId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
    signal,
  }, 8000);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 409) {
      throw new Error(err.detail || `商品 ${code} 已在目前自選組合中`);
    }
    if (res.status === 400) {
      throw new Error(err.detail || `無法新增個股 ${code}，代號可能無效`);
    }
    if (res.status === 404) {
      throw new Error(err.detail || '自選群組不存在');
    }
    throw new Error(err.detail || `新增失敗 (HTTP ${res.status})`);
  }
  return res.json();
}

export async function removeItem(groupId: string, code: string, signal?: AbortSignal): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/groups/${groupId}/items/${code}`, {
    method: 'DELETE',
    signal,
  }, 8000);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 404) {
      throw new Error(err.detail || `自選群組或商品 ${code} 不存在`);
    }
    throw new Error(err.detail || `移除商品 ${code} 失敗`);
  }
}

export async function reorderItems(groupId: string, codes: string[]): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/groups/${groupId}/items/order`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
  if (!res.ok) throw new Error('Failed to reorder items');
}

export async function fetchAnnouncements(): Promise<Record<string, StockAnnouncement[]>> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/announcements`);
  if (!res.ok) throw new Error('Failed to fetch announcements');
  return res.json();
}

export async function fetchStockChart(code: string): Promise<any> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/charts/${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error(`Chart data not found: ${res.statusText}`);
  return res.json();
}

export async function fetchStockIndicators(codes?: string[]): Promise<Record<string, any>> {
  const q = codes && codes.length > 0 ? `?codes=${encodeURIComponent(codes.join(','))}` : '';
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/indicators${q}`);
  if (!res.ok) throw new Error('Failed to fetch stock indicators');
  return res.json();
}

export interface PlaceOrderParams {
  code: string;
  action: 'buy' | 'sell';
  quantity: number;
  unit: 'lot' | 'share';
  price_type: 'limit' | 'market';
  price: number;
  order_lot?: 'Common' | 'IntradayOdd' | 'Fixing' | 'Odd';
}

export interface PlaceOrderResult {
  success: boolean;
  message: string;
  orderId?: string;
  status?: string;
  statusCode?: string;
  detail?: string;
}

export async function submitOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/orders/place`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || '委託送出失敗');
  }
  return res.json();
}

export async function fetchOrders(): Promise<import('../types').OrderItem[]> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/orders`);
  if (!res.ok) {
    throw new Error('無法取得今日委託列表');
  }
  return res.json();
}

export async function clearOrders(): Promise<{ success: boolean; message: string; clearedAt?: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/orders/clear`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || '清空委託單紀錄失敗');
  }
  return res.json();
}

export async function cancelOrder(orderId: string): Promise<{ success: boolean; message: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || '撤單失敗');
  }
  return res.json();
}

export async function updateOrder(orderId: string, params: { newPrice?: number; newQty?: number }): Promise<{ success: boolean; message: string; orderId?: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/orders/${encodeURIComponent(orderId)}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || '修改委託失敗');
  }
  return res.json();
}

export async function refreshSystemQuotes(forceReconnect: boolean = false): Promise<void> {
  const url = `${API_BASE}/api/v1/system/refresh?force_reconnect=${forceReconnect ? 'true' : 'false'}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error('Failed to refresh system quotes');
  }
}

export async function fetchAccountBalance(): Promise<AccountBalanceState> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/account/balance`);
  if (!res.ok) throw new Error('Failed to fetch account balance');
  return res.json();
}

export async function updateAccountCapital(capitalWan: number, capitalMode: 'before_t0' | 'after_t0' = 'after_t0'): Promise<{ status: string; capitalWan: number; capitalMode: string }> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/account/capital`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capitalWan, capitalMode }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || '更新本金失敗');
  }
  return res.json();
}

export async function fetchCalendarMonth(year?: number, month?: number): Promise<import('../types').CalendarMonthData> {
  const query = [];
  if (year) query.push(`year=${year}`);
  if (month) query.push(`month=${month}`);
  const qStr = query.length > 0 ? `?${query.join('&')}` : '';
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/calendar${qStr}`);
  if (!res.ok) throw new Error('無法取得投資日曆資料');
  return res.json();
}

export async function fetchGlobalIndices(): Promise<import('../types').GlobalIndicesResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/global-indices`);
  if (!res.ok) throw new Error('無法取得國際股市行情');
  return res.json();
}

export async function fetchFinancialNews(date?: string): Promise<import('../types').FinancialNewsResponse> {
  const qStr = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/news${qStr}`);
  if (!res.ok) throw new Error('無法取得財經新聞');
  return res.json();
}

export async function refreshFinancialNews(): Promise<import('../types').FinancialNewsResponse> {
  const res = await fetchWithTimeout(`${API_BASE}/api/v1/news/refresh`, { method: 'POST' });
  if (!res.ok) throw new Error('重新整理財經新聞失敗');
  return res.json();
}
