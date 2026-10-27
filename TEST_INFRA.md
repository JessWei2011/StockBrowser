# E2E Test Infra: StockBrowser

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation design.
- Methodology: Category-Partition + BVA + Pairwise + Workload Testing.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | Backend Watchlist Non-Blocking Addition & Broker Isolation | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 2 | Backend Input Validation & Error Handling | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 3 | Frontend Optimistic Watchlist UI & Resilient Button State | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 4 | Frontend Client-Side Timeout & Network Resilience | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 5 | Backend Bootstrap & Full-System Async Safety | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 6 | Automated Non-blocking & Delay Simulation Tests | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 7 | Frontend Clean Build & Type Safety | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |

## Test Architecture
- Test runner: `pytest` with `pytest-asyncio` / `anyio` and `httpx.AsyncClient`
- Test commands:
  - Backend: `PYTHONPATH=. pytest backend/tests -v`
  - Frontend: `cd frontend && npm run build`
- Test case format:
  - `backend/tests/test_watchlist_async_safety.py`: End-to-end API and simulated broker latency tests.
  - Assertions on HTTP status codes, latency thresholds (< 1.0s, < 0.2s for health check), database state integrity, and event loop non-blocking guarantees.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | User adds stock while broker snapshot/subscription has high network latency (3+ seconds) | F1, F3, F6 | High |
| 2 | Concurrent requests: user adds stock while other users fetch `/api/bootstrap` and `/api/health` | F1, F5, F6 | High |
| 3 | User enters invalid stock code, non-existent group ID, or duplicate item | F2, F3 | Medium |
| 4 | Rapid double-clicking / pressing Enter during input composition (IME) | F3, F4 | Medium |
| 5 | Frontend clean compilation, Vite packaging, and full backend test regression | F6, F7 | Medium |

## Coverage Thresholds
- Tier 1: ≥5 per feature
- Tier 2: ≥5 per feature (boundary and corner cases)
- Tier 3: pairwise coverage of major feature interactions
- Tier 4: ≥5 realistic application scenarios
