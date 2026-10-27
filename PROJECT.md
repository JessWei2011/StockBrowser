# Project: StockBrowser Watchlist Non-Blocking & Async Safety Fix

## Architecture
StockBrowser is a real-time Taiwan stock monitoring system with:
- **Backend**: FastAPI web service, SQLite persistence via `aiosqlite`, Shioaji broker integration (quotes, snapshots, orders, wealth/position sync), QuoteStore in-memory cache, and WebSocket batch publishing.
- **Frontend**: React + TypeScript + Vite single-page application with real-time WebSocket updates, watchlist management, and stock charts.
- **Data Flow**:
  - Watchlist mutations: Frontend `Header` / `App` -> REST API (`POST /api/v1/groups/{group_id}/items`) -> `WatchlistService.add_item` -> SQLite DB persistence -> non-blocking background quote subscription via `asyncio.to_thread` -> BatchPublisher broadcast -> WebSocket push to clients.
  - Bootstrap data: Frontend -> REST API (`GET /api/v1/bootstrap`) -> `WatchlistService.get_bootstrap_data` -> background thread MA calculation & broker sync -> lightweight consolidated response.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Backend Watchlist Non-Blocking Addition & Broker Isolation | Isolate `shioaji_adapter.subscribe_codes` and broker snapshots via `asyncio.to_thread` with timeouts; guarantee `POST /api/v1/groups/{group_id}/items` returns < 1s regardless of broker delay. | M1 | Survey Obs 1.1, Obs 1.2, ORIGINAL_REQUEST §R1 |
| 2 | Backend Input Validation & Error Handling | Reject invalid stock codes with 400, return 404 for non-existent groups, return 409 for duplicate stocks with clear Chinese message, protect system groups. | M1 | Survey Obs 1.3, ORIGINAL_REQUEST §R1 |
| 3 | Frontend Optimistic Watchlist UI & Resilient Button State | Immediately append temporary/optimistic item into React state; eliminate `await loadBootstrap()` on item add/remove; guarantee button reset in `finally`; non-blocking toast notifications; IME & double-submit guards. | M2 | Survey Obs 1.1, Obs 2.1, ORIGINAL_REQUEST §R1 |
| 4 | Frontend Client-Side Timeout & Network Resilience | Introduce `fetchWithTimeout` (8s default) with AbortSignal; add AbortController to search debounce; track WebSocket pong heartbeat and reconnect on visibility wake-up. | M2 | Survey Obs 2.1, Obs 2.2, ORIGINAL_REQUEST §R2 |
| 5 | Backend Bootstrap & Full-System Async Safety | Offload 25.6s `get_multiple_stocks_ma_summary` to `asyncio.to_thread` with caching; offload `sync_wealth_book` broker calls; offload trading routes (`/orders`, `/account/balance`) to threads; decouple QuoteStore disk I/O and publisher broadcasts. | M1 | Survey Obs 1.1, Obs 1.2 (Explorer 3), ORIGINAL_REQUEST §R2 |
| 6 | Automated Non-blocking & Delay Simulation Tests | Create dedicated test suite `backend/tests/test_watchlist_async_safety.py` testing < 1s response under simulated 3s broker delay, concurrent `/health` requests, error cases (400, 404, 409), and 100% pass on all existing backend tests. | M3 | Survey Obs 1.4, Section 5, ORIGINAL_REQUEST §R3 |
| 7 | Frontend Clean Build & Type Safety | Verify `npm run build` succeeds cleanly with 0 TypeScript errors and Vite bundle generation. | M4 | Survey Obs 1.4, ORIGINAL_REQUEST §R3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Backend Async Isolation & Safety | Features 1, 2, 5: `shioaji_adapter` thread isolation, `watchlist_service` decoupling, `db` validation, `rest.py` error mapping, MA indicator thread offloading/caching, QuoteStore disk I/O offloading. | none | DONE |
| M2 | Frontend Optimistic UI & Resilience | Features 3, 4: `api.ts` timeout wrapper, `App.tsx` optimistic additions/removals, `Header.tsx` button state & toast, `websocket.ts` pong heartbeat. | none | DONE |
| M3 | Automated Test Suite & E2E Validation | Feature 6: Implementation & passing of `backend/tests/test_watchlist_async_safety.py`, validating non-blocking under 3s broker delay, concurrent requests, error handling, and 100% pass on existing tests. | M1 | DONE |
| M4 | Dual-Track Review, Challenger Stress Testing & Forensic Audit | Feature 7 & Verification: 2 Reviewers, 2 Challengers, Forensic Auditor, TypeScript build check, and Gate verdict. | M1, M2, M3 | DONE |

## Interface Contracts
### Frontend (`api.ts`) ↔ Backend (`rest.py`)
- `POST /api/v1/groups/{group_id}/items`:
  - Request: `{"code": string}`
  - Success Response: HTTP 200 `WatchlistItem` object (`id`, `groupId`, `code`, `name`, `exchange`, `securityType`, `position`) within < 1.0s.
  - Error Responses:
    - HTTP 400: `{"detail": "查無台股標的「...」，請確認股票代號是否正確"}` or `"Stock code cannot be empty"` or system group protection.
    - HTTP 404: `{"detail": "自選群組不存在"}`.
    - HTTP 409: `{"detail": "該股票已存在於此群組中，無需重複新增"}`.
- `GET /api/v1/bootstrap`:
  - Success Response: HTTP 200 `BootstrapResponse` object, non-blocking to event loop (< 1.5s).

## Code Layout & Write Boundaries
- **Backend Worker** (M1):
  - Exclusive write ownership:
    - `backend/app/api/rest.py`
    - `backend/app/services/watchlist_service.py`
    - `backend/app/repositories/db.py`
    - `backend/app/services/shioaji_adapter.py`
    - `backend/app/services/quote_store.py`
    - `backend/app/services/publisher.py`
    - `backend/app/services/stock_chart_service.py`
- **Frontend Worker** (M2):
  - Exclusive write ownership:
    - `frontend/src/services/api.ts`
    - `frontend/src/services/websocket.ts`
    - `frontend/src/App.tsx`
    - `frontend/src/components/Header.tsx`
- **Test Writer Worker** (M3):
  - Exclusive write ownership:
    - `backend/tests/test_watchlist_async_safety.py`
