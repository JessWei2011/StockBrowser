import type { BootstrapResponse, InstrumentSearchResult, WatchlistGroup, WatchlistItem, StockAnnouncement } from '../types';

const API_BASE = import.meta.env.VITE_API_BASE || '';

export async function fetchBootstrap(): Promise<BootstrapResponse> {
  const res = await fetch(`${API_BASE}/api/v1/bootstrap`);
  if (!res.ok) throw new Error(`Bootstrap failed: ${res.statusText}`);
  return res.json();
}

export async function searchInstruments(query: string): Promise<InstrumentSearchResult[]> {
  if (!query.trim()) return [];
  const res = await fetch(`${API_BASE}/api/v1/instruments/search?q=${encodeURIComponent(query.trim())}`);
  if (!res.ok) throw new Error(`Search failed: ${res.statusText}`);
  return res.json();
}

export async function createGroup(name: string): Promise<WatchlistGroup> {
  const res = await fetch(`${API_BASE}/api/v1/groups`, {
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
  const res = await fetch(`${API_BASE}/api/v1/groups/${groupId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error('Failed to update group');
}

export async function deleteGroup(groupId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/groups/${groupId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete group');
}

export async function addItem(groupId: string, code: string): Promise<WatchlistItem> {
  const res = await fetch(`${API_BASE}/api/v1/groups/${groupId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to add item');
  }
  return res.json();
}

export async function removeItem(groupId: string, code: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/groups/${groupId}/items/${code}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to remove item');
}

export async function reorderItems(groupId: string, codes: string[]): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/groups/${groupId}/items/order`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes }),
  });
  if (!res.ok) throw new Error('Failed to reorder items');
}

export async function fetchAnnouncements(): Promise<Record<string, StockAnnouncement[]>> {
  const res = await fetch(`${API_BASE}/api/v1/announcements`);
  if (!res.ok) throw new Error('Failed to fetch announcements');
  return res.json();
}

