# s9.com Game Vendor Validation

Automated testing suite that validates all game vendors and their games on s9.com using an **API-first** approach with Playwright.

---

## ⚡ Quick Command Reference

> **Always run auth setup first.** Auth is required before any test can run.

| What you want | Command |
|---|---|
| **First-time / session expired** | `npx playwright test --project=setup` |
| **Run all vendors (v3 recommended)** | `npx playwright test tests/v3/ --project=chromium --workers=14` |
| **Single vendor — headless** | `npx playwright test tests/v3/ --project=chromium -g "v3: Amusnet"` |
| **Single vendor — visible browser** | `npx playwright test tests/v3/ --project=chromium -g "v3: Amusnet" --workers=1 --headed` |
| **v2 all vendors (previous)** | `npx playwright test tests/v2/ --project=chromium --workers=14` |
| **v1 single vendor (legacy)** | `npx playwright test tests/s9_test.spec.ts --project=chromium -g "API Validate: Amusnet"` |
| **View HTML report** | `npx playwright show-report` |

> ⚠️ **Always include `--project=chromium`** when running single vendor tests.
> Without it, Playwright runs through all 3 browser projects (chromium + firefox + webkit) = 3× runs.

---

## Overview

Instead of clicking through the website UI, this suite calls the s9.com backend API directly to:
1. Fetch the live vendor list automatically from the API (no hardcoded list)
2. Discover all games per vendor instantly (no DOM scrolling)
3. Launch each game session and receive the provider's redirect URL
4. Embed the game in an iframe with an HTTPS parent page (via `page.route()` intercept)
5. Run a **4-gate validation** to classify each game as **Pass** or **Fail**
6. **Auto-retry** transient failures (configurable, default 2 retries with 3s cooldown)

**53 vendors · 6,000+ games · tested in parallel:**

| Version | Location | Strategy | Est. Speed |
|---|---|---|---|
| v1 | `tests/s9_test.spec.ts` | 1 game at a time per vendor, DOM scroll | ~3.5h |
| v2 | `tests/v2/s9_test_v2.spec.ts` | Semaphore-based concurrent queue, API | ~18 min |
| v3 ⭐ | `tests/v3/s9_test_v3.spec.ts` | Worker pool, streaming CSV, scale-safe | ~16 min |

---

## Prerequisites

```bash
npm install
npx playwright install chromium
```

---

## Project Structure

```
d:/Yoong testing/
├── tests/
│   ├── auth.setup.ts              # Login + save auth state, API credential & vendor list
│   ├── globalSetup.ts             # Refreshes vendor list before each test run
│   ├── s9_test.spec.ts            # v1 test runner (sequential, legacy)
│   ├── v2/
│   │   ├── s9_test_v2.spec.ts     # v2 test runner (semaphore queue)
│   │   └── apiValidationFlowV2.ts # v2 validation logic
│   ├── v3/
│   │   ├── s9_test_v3.spec.ts     # v3 test runner (worker pool) ⭐
│   │   └── apiValidationFlowV3.ts # v3 validation logic
│   ├── api/
│   │   └── s9ApiClient.ts         # Pure HTTP client (no browser)
│   ├── flows/
│   │   ├── apiValidationFlow.ts   # v1 validation logic
│   │   └── vendorValidationFlow.ts # Legacy DOM-based (reference only)
│   └── models/
│       └── LoginPage.ts
├── test-results/
│   └── vendor-reports/            # ← CSV files saved here after each run
│       ├── Amusnet_2026-03-13T08-24-15.csv
│       └── ...
├── playwright/
│   └── .auth/
│       ├── user.json              # Browser session state
│       ├── credential.json        # API credential {did, uid, token}
│       └── vendors.json           # Live vendor list (auto-refreshed each run)
├── playwright.config.ts
├── .env
└── README.md
```

---

## First-Time Setup

### 1. Configure credentials
Create `.env` in the project root:
```
TEST_USER=yoongtestt01
TEST_PASS=Yoong01!!
BASE_URL=https://s9.com
```

### 2. Run authentication setup
Logs in, captures API token, saves browser session + vendor list:
```bash
npx playwright test --project=setup
```

Expected output:
```
Login successful.
Auth state saved to playwright/.auth/user.json
API credential saved to playwright/.auth/credential.json
  uid=29140028  token=NmRhZmU5...
Vendor list saved: 53 active vendors → playwright/.auth/vendors.json
```

> **Re-run whenever the session expires** — token expiry shows as `AUTH_FAILURE` in results.

---

## Running Tests

### ⭐ Recommended: v3 — all vendors, fully concurrent

```bash
npx playwright test tests/v3/ --project=chromium --workers=14
```
- 14 vendors simultaneously · 6 games per vendor = 84 browser pages
- ~16 min for all 6,000+ games on an i7-14700F / 32GB machine
- Worker pool architecture — no memory degradation on large vendors (300+ games)
- Results streamed to CSV per game — survives token expiry or crash mid-run

### v3 — single vendor (debugging)

```bash
# Headless (fast)
npx playwright test tests/v3/ --project=chromium -g "v3: Amusnet"

# Headed (see the browser)
npx playwright test tests/v3/ --project=chromium -g "v3: PG Soft" --workers=1 --headed
```

### v3 — live progress in terminal

```bash
npx playwright test tests/v3/ --project=chromium --workers=14 --reporter=line
```

### v2 — all vendors (previous version, still works)

```bash
npx playwright test tests/v2/ --project=chromium --workers=14
```

### v1 — single vendor (legacy sequential)

```bash
npx playwright test tests/s9_test.spec.ts --project=chromium -g "API Validate: Amusnet"
```

---

## Viewing Results

### 1. Playwright HTML Report
```bash
npx playwright show-report
```
Interactive browser report — pass/fail per vendor, console logs, duration, errors.

### 2. CSV Files (open in Excel)

Each vendor's results are saved to:
```
test-results/vendor-reports/<VendorName>_<timestamp>.csv
```

Columns:
| VendorId | VendorName | GameId | GameName | Status | Gate | Retries | Error | Timestamp |

- **Retries** = number of retry attempts (0 = first try; ≥1 = was retried due to transient failure)
- **Gate** = which gate failed (1–4), blank for passing games
- Filter `Status = Fail` in Excel to see all failed games
- Filter `Retries > 0` in Excel to identify flaky game servers

Example:
```
600005,"Amusnet",1297,"Dynamic Roulette 120x","Pass",,0,"","2026-03-13T08-24-15"
600005,"Amusnet",1298,"Live European Roulette","Fail",3,2,"Game Error: An error occurred...","2026-03-13T08-24-15"
```

> **v3 note:** CSV rows are written as each game completes, not all at once at the end.
> If a run is interrupted mid-way (token expiry, machine crash), all completed rows are preserved.

### 3. Live Console (during v3 run)

v3 only logs failures, retried passes, and a progress snapshot every 20 games:

```
=== [Amusnet] v3 validation starting (ven_id=600005, games=161, workers=6) ===
[Amusnet][3/161] ↻ Retry 1/2: 40 Almighty Ramses II (waiting 3000ms)
[Amusnet][3/161] ✅ Pass [retried 1×]: 40 Almighty Ramses II
[Amusnet][7/161] ✗ FAIL | Gate 3: Game Error: "An error occurred" [retried 2×]
[Amusnet] ── 20/161 (12.4%)  ✅ 19  ✗ 1
[Amusnet] ── 40/161 (24.8%)  ✅ 38  ✗ 2
...
### [Amusnet] v3 Complete — 159 passed · 2 failed · 161 total · 3 retried

Failed games:
| Game | Gate | Retries | Error |
|------|------|---------|-------|
| Live European Roulette | 3 | 2 | Game Error: "An error occurred" |
| Speed Baccarat A | 2 | 2 | HTTP Error (502) |

📄 CSV saved: test-results/vendor-reports/Amusnet_2026-03-19T08-24-15.csv
```

---

## How It Works

### Startup Sequence
```
1. globalSetup.ts      → refreshes vendors.json from live API
2. auth.setup.ts       → logs in → saves user.json + credential.json + vendors.json
3. s9_test_v3.spec.ts  → reads vendors.json → creates one test() per vendor
4. 14 workers run vendor tests in parallel
5. Each vendor: worker pool → up to 6 games concurrent → retry on fail → CSV row written
```

### Vendor List (Auto-Discovery)
The vendor list is **fetched live from the API** — no hardcoded IDs. `globalSetup.ts` calls:
```
POST /ns9/api/public/partner/game-vendor/list → writes playwright/.auth/vendors.json
```
To exclude a vendor, add its ID to `EXCLUDED_VENDOR_IDS` in `globalSetup.ts` and `auth.setup.ts`.

### API Endpoints Used
| Purpose | Endpoint |
|---|---|
| Vendor list | `POST /ns9/api/public/partner/game-vendor/list` |
| Game list (paginated) | `POST /ns9/api/public/partner/game/list` |
| Start game session | `POST /ns9/api/gus/game/enter` → `redirect_url` |

All on `https://new.98ent.com`.

### 4-Gate Validation (per game, ~7s minimum)

```
Gate 1 — API Entry                                          (~200ms)
  ✅ code=1 + redirect_url              → proceed
  ❌ code≠1 / no redirect_url          → "API Error" / "AUTH_FAILURE"

Gate 2 — iframe Load                                          (≤20s)
  ✅ iframe body attaches               → proceed
  ❌ HTTP 4xx/5xx from provider server  → "HTTP Error (404/502)"
  ❌ No response within 20s            → "Connection Failed"

Gate 3 — Immediate Error Scan                           (2s settle)
  ✅ No error text visible              → proceed
  ❌ Error message on screen            → "Game Error: <text>"

Gate 4 — Stability Watch                                      (5s)
  ✅ No errors + visible content        → ✅ PASS
  ❌ Error appears during watch         → "Unstable: <text>"
  ❌ Nothing visible in iframe          → "Blank Screen"
```

### Retry Logic
If a game fails at any gate, it is retried automatically:
- **`MAX_RETRIES = 2`** — up to 2 retries (configurable in `apiValidationFlowV3.ts`)
- **`RETRY_DELAY_MS = 3000`** — 3s cooldown before retry (lets server recover)
- **`AUTH_FAILURE`** — never retried (token issue, need to re-run auth setup)
- **Game-list fetch** — also retried up to 3 times on transient network failure
- Each retry uses a **fresh browser context**
- Retry count is recorded in the `Retries` CSV column

### v3 Worker Pool
```
Fixed pool of 6 worker coroutines — each pulls the next game on completion:

  worker-0:  game[1] → game[7]  → game[13] → …
  worker-1:  game[2] → game[8]  → game[14] → …
  worker-2:  game[3] → game[9]  → game[15] → …
  worker-3:  game[4] → game[10] → game[16] → …
  worker-4:  game[5] → game[11] → game[17] → …
  worker-5:  game[6] → game[12] → game[18] → …

No batch boundaries. Zero idle time. Constant 6 Promises alive at any moment
regardless of total game count (vs N Promises in v2 for a vendor with N games).

14 workers × 6 concurrent = 84 browser pages × ~200MB = ~16.8GB peak RAM
```

### Adaptive Rate-Limit Back-Pressure (v3)
```
RateLimitMonitor tracks 429 errors in a rolling window of 20 games.
If >25% of recent games hit 429 → each worker adds 500ms stagger per game.
Activates after as few as 3 consecutive 429s (no cold-window dead zone).
Automatically relaxes once the 429 rate drops back below the threshold.
```

### HTTPS Parent Page
Some providers (e.g. PG Soft) check `window.parent.location.protocol`. v3 intercepts `https://s9.com/**` with `page.route()`, serving an instant local stub to keep the HTTPS parent URL while eliminating the 5–20s live server navigation delay.

---

## Tuning (Edit `apiValidationFlowV3.ts`)

| Constant | Default | Effect |
|---|---|---|
| `MAX_CONCURRENT_GAMES` | `6` | Worker pool size per vendor. ↑ = faster but more RAM |
| `MAX_RETRIES` | `2` | Retry attempts per failed game |
| `RETRY_DELAY_MS` | `3000` | Cooldown between game retries (ms) |
| `GAME_LIST_RETRIES` | `3` | Retry attempts for game-list fetch on network error |
| `GAME_LIST_RETRY_DELAY` | `4000` | Cooldown between game-list retries (ms) |
| `PROGRESS_EVERY_N` | `20` | Console progress log interval (games). 0 = disable |
| `RATE_WINDOW_SIZE` | `20` | Rolling window size for 429 rate-limit detection |
| `RATE_LIMIT_THRESHOLD` | `0.25` | 429 fraction that triggers back-pressure (0–1) |
| `RATE_BACKOFF_MS` | `500` | Extra stagger added per game while throttled (ms) |
| `GATE3_SETTLE_MS` | `2000` | Settle wait before error scan (ms) |
| `GATE4_DURATION_MS` | `5000` | Stability watch duration (ms) |

**RAM guide for `MAX_CONCURRENT_GAMES` (at 14 workers):**

| Games | Total pages | Peak RAM |
|---|---|---|
| 4 | 56 | ~11.2 GB |
| 6 (default) | 84 | ~16.8 GB |
| 8 | 112 | ~22.4 GB |

**Workers guide** (edit `playwright.config.ts`):

| Workers | Best for |
|---|---|
| 1 | Single vendor debugging |
| 8 | Conservative (lower CPU / RAM) |
| 14 | Recommended (i7-14700F / 32 GB) |

---

## Migrating from v2 to v3

1. Copy `apiValidationFlowV3.ts` into `tests/v3/`
2. Create `tests/v3/s9_test_v3.spec.ts` — copy `s9_test_v2.spec.ts` and replace:
   - `import { apiValidateVendorGamesFlowV2 }` → `import { apiValidateVendorGamesFlowV3 }`
   - `apiValidateVendorGamesFlowV2(` → `apiValidateVendorGamesFlowV3(`
   - Test description prefix `'v2:'` → `'v3:'`
3. Run using the v3 commands in the Quick Reference table above.
4. v2 remains intact and runnable — no files are modified.

---

## Troubleshooting

| Symptom | Solution |
|---|---|
| `AUTH_FAILURE` in many games | Re-run auth: `npx playwright test --project=setup` |
| `credential.json not found` | Run auth setup first |
| `vendors.json not found` | Run auth setup first |
| Vendor skipped after 3 warnings | Transient game-list fetch failure; re-run the single vendor |
| Rate limit errors (HTTP 429) | Reduce `MAX_CONCURRENT_GAMES` or increase `RATE_BACKOFF_MS` |
| All games fail at Gate 2 | Check `playwright/.auth/user.json` is fresh (re-run auth) |
| Game keeps failing after retries | Server-side issue; check game manually in browser |
| Test runs 3× for single vendor | Add `--project=chromium` to your command |
| No CSV files appear | Check `test-results/vendor-reports/` directory |
| CSV has partial results | Run was interrupted mid-way — v3 keeps all rows written before the stop |
| Progress lines appear twice | Already fixed in v3 (milestone deduplication) |