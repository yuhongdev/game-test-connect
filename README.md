# s9.com Game Vendor Validation

Automated testing suite that validates all game vendors and their games on s9.com using an **API-first** approach with Playwright.

---

## ⚡ Quick Command Reference

> **Always run auth setup first.** Auth is required before any test can run.

| What you want | Command |
|---|---|
| **First-time / session expired** | `npx playwright test --project=setup` |
| **Run all vendors (v2 recommended)** | `npx playwright test tests/v2/ --project=chromium --workers=14` |
| **Single vendor — headless** | `npx playwright test tests/v2/ --project=chromium -g "v2: Amusnet"` |
| **Single vendor — visible browser** | `npx playwright test tests/v2/ --project=chromium -g "v2: Amusnet" --workers=1 --headed` |
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

**~50 vendors, ~6,000+ games, tested in parallel:**

| Version | Location | Strategy | Est. Speed |
|---|---|---|---|
| v1 | `tests/s9_test.spec.ts` | 1 game at a time per vendor, DOM scroll | ~3.5h |
| v2 ⭐ | `tests/v2/s9_test_v2.spec.ts` | Semaphore-based concurrent queue, API | ~18 min |

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
│   │   ├── s9_test_v2.spec.ts     # v2 test runner (concurrent queue) ⭐
│   │   └── apiValidationFlowV2.ts # v2 validation logic + retry logic
│   ├── api/
│   │   └── s9ApiClient.ts         # Pure HTTP client (no browser)
│   ├── flows/
│   │   ├── apiValidationFlow.ts   # v1 validation logic
│   │   └── vendorValidationFlow.ts # Legacy DOM-based (reference only)
│   └── models/
│       └── LoginPage.ts
├── test-results/
│   └── vendor-reports/            # ← CSV files saved here after each run
│       ├── Amusnet_2026-03-13.csv
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
Vendor list saved: 50 active vendors → playwright/.auth/vendors.json
```

> **Re-run whenever the session expires** — token expiry shows as `AUTH_FAILURE` in results.

---

## Running Tests

### ⭐ Recommended: v2 — all vendors, fully concurrent

```bash
npx playwright test tests/v2/ --project=chromium --workers=14
```
- 14 vendors simultaneously, 6 games per vendor concurrently = 84 browser pages
- ~18 min for all ~6,000 games on an i7-14700F / 32GB machine

### v2 — single vendor (debugging)

```bash
# Headless (fast)
npx playwright test tests/v2/ --project=chromium -g "v2: Amusnet"

# Headed (see the browser)
npx playwright test tests/v2/ --project=chromium -g "v2: PG Soft" --workers=1 --headed
```

### v2 — live progress in terminal

```bash
npx playwright test tests/v2/ --project=chromium --workers=14 --reporter=line
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
- Filter `Retries > 0` in Excel to identify flaky game servers

Example:
```
600005,"Amusnet",1297,"Dynamic Roulette 120x","Pass",,,0,,"2026-03-13T08-24-15"
600005,"Amusnet",1298,"Live European Roulette","Fail",3,2,"Game Error: An error occurred...","2026-03-13T08-24-15"
```

### 3. Live Console (during run)

```
=== [Amusnet] v2 validation starting (ven_id=600005, concurrent=6) ===
[Amusnet][1/161] Starting: 40 Almighty Ramses II
[Amusnet][1/161] ✗ Attempt 1 failed | Gate 2: Connection Failed
[Amusnet][1/161] ↻ Retry 1/2 for: 40 Almighty Ramses II (waiting 3000ms)
[Amusnet][1/161] ✅ Passed on retry 1: 40 Almighty Ramses II
[Amusnet][1/161] → Pass [retried 1×]

### [Amusnet] v2 Summary: 159 passed, 2 failed / 161 total (4 needed retry)
```

---

## How It Works

### Startup Sequence
```
1. globalSetup.ts     → refreshes vendors.json from live API (uses saved credential)
2. auth.setup.ts      → logs in → saves user.json + credential.json + vendors.json
3. s9_test_v2.spec.ts → reads vendors.json → creates one test() per vendor
4. 14 workers run vendor tests in parallel
5. Each vendor: semaphore queue → up to 6 games concurrent → retry on fail → CSV saved
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
- **`MAX_RETRIES = 2`** — up to 2 retries (configurable in `apiValidationFlowV2.ts`)
- **`RETRY_DELAY_MS = 3000`** — 3s cooldown before retry (lets server recover)
- **`AUTH_FAILURE`** — never retried (token issue, need to re-run auth setup)
- Each retry uses a **fresh browser context**
- Retry count is recorded in the `Retries` CSV column

### Semaphore Concurrent Queue (v2)
```
Semaphore(6) — up to 6 games running freely at any time:

  game 1 ──→ finishes at 7s  → game 7 starts immediately
  game 2 ──→ finishes at 11s → game 8 starts immediately
  game 3 ──→ finishes at 7s  → game 9 starts immediately
  ...

No batch boundaries. Zero idle time between games.
14 workers × 6 concurrent = 84 browser pages × ~200MB = ~16.8GB peak RAM
```

### HTTPS Parent Page (v2)
Some providers (e.g. PG Soft) check `window.parent.location.protocol`. v2 intercepts `https://s9.com/**` with `page.route()`, serving an instant local stub to keep the HTTPS URL while eliminating the 5–20s live server navigation delay.

---

## Tuning (Edit `apiValidationFlowV2.ts`)

| Constant | Default | Effect |
|---|---|---|
| `MAX_CONCURRENT_GAMES` | `6` | Games per vendor worker. ↑ = faster but more RAM |
| `MAX_RETRIES` | `2` | Retry attempts per failed game |
| `RETRY_DELAY_MS` | `3000` | Cooldown between retries (ms) |
| `GATE3_SETTLE_MS` | `2000` | Settle wait before error scan |
| `GATE4_DURATION_MS` | `5000` | Stability watch duration |

**RAM guide for `MAX_CONCURRENT_GAMES` (at 14 workers):**

| Games | Total pages | Peak RAM |
|---|---|---|
| 4 | 56 | ~11.2GB |
| 6 (default) | 84 | ~16.8GB |
| 8 | 112 | ~22.4GB |

**Workers guide** (edit `playwright.config.ts`):

| Workers | Best for |
|---|---|
| 1 | Single vendor debugging |
| 8 | Conservative (low CPU) |
| 14 | Recommended (i7-14700F) |

---

## Troubleshooting

| Symptom | Solution |
|---|---|
| `AUTH_FAILURE` in many games | Re-run auth: `npx playwright test --project=setup` |
| `credential.json not found` | Run auth setup first |
| `vendors.json not found` | Run auth setup first |
| Rate limit errors (HTTP 429) | Reduce `MAX_CONCURRENT_GAMES` |
| All games fail at Gate 2 | Check `playwright/.auth/user.json` is fresh |
| Game keeps failing after retries | Server-side issue; check game manually |
| Test runs 3× for single vendor | Add `--project=chromium` to your command |
| No CSV files appear | Check `test-results/vendor-reports/` directory |
