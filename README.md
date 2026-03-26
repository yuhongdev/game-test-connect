# s9.com Game Vendor Validation

Automated testing suite that validates all game vendors and their games on s9.com using an **API-first** approach with Playwright.

---

## ⚡ Quick Command Reference

> **Always run auth setup first.** Auth is required before any test can run.

| What you want | Command |
|---|---|
| **First-time / session expired** | `npx playwright test --project=setup` |
| **Run all vendors (v5 recommended)** | `npx playwright test tests/v5/ --project=chromium --workers=10` |
| **Single vendor — headless (v5)** | `npx playwright test tests/v5/ --project=chromium -g "v5: Amusnet"` |
| **Single vendor — visible browser (v5)** | `npx playwright test tests/v5/ --project=chromium -g "v5: Amusnet" --workers=1 --headed` |
| **Run all vendors (v4 stable)** | `npx playwright test tests/v4/ --project=chromium --workers=6` |
| **Single vendor — headless (v4)** | `npx playwright test tests/v4/ --project=chromium -g "v4: Amusnet"` |
| **Single vendor — visible browser (v4)** | `npx playwright test tests/v4/ --project=chromium -g "v4: Amusnet" --workers=1 --headed` |
| **Generate dashboard report** | `npx ts-node tests/reports/generateReport.ts` |
| **Report — latest run only** | `npx ts-node tests/reports/generateReport.ts --latest` |
| **Diff two most recent runs** | `npx ts-node tests/reports/diffRuns.ts --latest` |
| **Open dashboard** | `start test-results\report.html` |
| **View Playwright HTML report** | `npx playwright show-report` |
| **v2 all vendors (previous)** | `npx playwright test tests/v2/ --project=chromium --workers=6` |
| **v1 single vendor (legacy)** | `npx playwright test tests/s9_test.spec.ts --project=chromium -g "API Validate: Amusnet"` |
| | |
| **UI E2E — all suites** | `npx playwright test tests/e2e/ --project=chromium` |
| **UI E2E — single suite** | `npx playwright test tests/e2e/home.spec.ts --project=chromium` |
| **UI E2E — headed (debug)** | `npx playwright test tests/e2e/home.spec.ts --project=chromium --headed` |

> ⚠️ **Always include `--project=chromium`** when running single vendor tests.
> Without it, Playwright runs through all 3 browser projects (chromium + firefox + webkit) = 3× runs.

---

## UI E2E Test Suite

A **Page Object Model (POM)** based browser automation suite that tests the s9.com frontend directly — login, home dashboard, deposit, withdrawal, profile, promotions, referral, and more.

### Test Suites

| Spec file | Test IDs | What it covers |
|---|---|---|
| `auth.spec.ts` | TC-AUTH-* | Login, logout, session persistence |
| `home.spec.ts` | TC-HOME-* | Dashboard elements, game tabs, chatroom, scoreboard, notifications |
| `deposit.spec.ts` | TC-DEP-* | Deposit form, payment methods |
| `withdrawal.spec.ts` | TC-WD-* | Withdrawal form, fund password keyboard |
| `profile.spec.ts` | TC-PROF-* | Profile page fields, avatar, personal info |
| `promotions.spec.ts` | TC-PROMO-* | Promotion list, banner visibility |
| `referral.spec.ts` | TC-REF-* | Referral page, invite link |
| `notifications.spec.ts` | TC-NOTIF-* | Notification panel, read/unread state |
| `bet-history.spec.ts` | TC-BET-* | Bet history table, filters |
| `transactions.spec.ts` | TC-TXN-* | Transaction history |
| `chat.spec.ts` | TC-CHAT-* | Chatroom widget, message input |
| `navigation.spec.ts` | TC-NAV-* | Bottom navigation, page routing |

### Page Object Models

| Model | Covers |
|---|---|
| `LoginPage.ts` | Login form, submit, avatar detection |
| `HomePage.ts` | Banner, chatroom, game tabs, quick links (Scoreboard, Live Broadcast), sidebar wallet |
| `BottomNavPage.ts` | Bottom nav tabs (Home, Deposit, Promotions, Referral, Profile) |
| `DepositPage.ts` | Deposit form and payment method selector |
| `WithdrawalPage.ts` | Withdrawal form and fund password keyboard |
| `FundPasswordPage.ts` | Randomized PIN keyboard interaction |
| `ProfilePage.ts` | Profile fields, avatar, settings |
| `PromotionsPage.ts` | Promotion cards and banner |
| `ReferralPage.ts` | Referral link and stats |
| `NotificationsPage.ts` | Notification list and state |
| `BetHistoryPage.ts` | Bet history table and filters |
| `TransactionPage.ts` | Transaction list |
| `ChatPage.ts` | Chat widget and input |

### Running UI E2E Tests

```bash
# Auth setup (required once per session)
npx playwright test --project=setup

# All UI suites
npx playwright test tests/e2e/ --project=chromium

# Single suite
npx playwright test tests/e2e/home.spec.ts --project=chromium

# Single test by ID
npx playwright test tests/e2e/home.spec.ts --project=chromium -g "TC-HOME-001"

# Headed mode (see the browser)
npx playwright test tests/e2e/home.spec.ts --project=chromium --headed
```

### Test Results Output

Each UI E2E run writes artifacts to an **isolated datetime-scoped subfolder** so results from different test flows are never overwritten:

```
test-results/
├── e2e-ui/
│   ├── 2026-03-25_13-44-00/    ← run from 25 Mar 13:44
│   │   ├── e2e-home-Home-Page-TC-HOME-001-chromium/
│   │   │   ├── error-context.md   (ARIA snapshot on failure)
│   │   │   └── screenshot.png
│   │   └── ...
│   └── 2026-03-26_09-00-00/    ← next run
└── vendor-reports/              ← game vendor validation (separate)
```

### Known UI Behaviours (handled automatically)

| Behaviour | How it's handled |
|---|---|
| **Login/logout success overlay** | Non-clickable, auto-dismisses in ~2 s — `dismissOverlays()` waits for it to disappear |
| **Developer push reload alert** | Browser-level `confirm()` — accepted via `page.once('dialog', ...)` inside `goto()` |
| **Notification overlay** | Full-screen, auto-dismisses — same `dismissOverlays()` wait |
| **Announcement/promo modal** | Clickable close button — `dismissAnnouncementModal()` closes it if present |
| **Sidebar wallet buttons** | Deposit/Withdrawal are inside a hidden drawer — `openSidebar()` reveals them |
| **"Under construction" toast** | Transient auto-dismiss — asserted immediately after click |
| **Persistent WebSocket (chatroom)** | `networkidle` never resolves — `goto()` uses `'load'` state + 1 s wait instead |

---

## Overview

Instead of clicking through the website UI, this suite calls the s9.com backend API directly to:
1. Fetch the live vendor list automatically from the API (no hardcoded list)
2. Discover all games per vendor instantly (no DOM scrolling)
3. Launch each game session and receive the provider's redirect URL
4. Embed the game in an iframe with an HTTPS parent page (via `page.route()` intercept)
5. Run a **4-gate validation** to classify each game as **Pass** or **Fail**
6. **Auto-retry** transient failures (configurable, default 2 retries with 3s cooldown)
7. **Generate a dashboard report** with vendor health heatmap, flaky game detection, and SLA tracking

**53 vendors · 6,000+ games · tested in parallel:**

| Version | Location | Strategy | Est. Speed |
|---|---|---|---|
| v1 | `tests/s9_test.spec.ts` | 1 game at a time per vendor, DOM scroll | ~3.5h |
| v2 | `tests/v2/s9_test_v2.spec.ts` | Semaphore-based concurrent queue, API | ~18 min |
| v4 | `tests/v4/s9_test_v4.spec.ts` | Worker pool, nested iframe detection, dated run folders | ~100 min @ 6 workers |
| v5 ⭐ | `tests/v5/s9_test_v5.spec.ts` | Adaptive concurrency, page pool, mobile emulation, dead-letter retries, freeze watchdog | ~50–60 min @ 6 workers |

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
│   ├── auth.setup.ts                  # Login + save auth state, API credential & vendor list
│   ├── globalSetup.ts                 # Refreshes vendor list before each test run
│   ├── s9_test.spec.ts                # v1 test runner (sequential, legacy)
│   ├── v2/
│   │   ├── s9_test_v2.spec.ts         # v2 test runner (semaphore queue)
│   │   └── apiValidationFlowV2.ts     # v2 validation logic
│   ├── v4/
│   │   ├── s9_test_v4.spec.ts         # v4 test runner (worker pool)
│   │   └── apiValidationFlowV4.ts     # v4 validation logic
│   ├── v5/
│   │   ├── s9_test_v5.spec.ts         # v5 test runner (adaptive concurrency + page pool) ⭐
│   │   └── apiValidationFlowV5.ts     # v5 validation logic
│   ├── reports/
│   │   ├── generateReport.ts          # Builds HTML dashboard from all CSV runs
│   │   └── diffRuns.ts                # Diffs two runs, shows regressions & recoveries
│   ├── api/
│   │   └── s9ApiClient.ts             # Pure HTTP client (no browser)
│   ├── flows/
│   │   ├── apiValidationFlow.ts       # v1 validation logic
│   │   └── vendorValidationFlow.ts    # Legacy DOM-based (reference only)
│   └── models/
│       ├── LoginPage.ts
│       ├── HomePage.ts
│       ├── BottomNavPage.ts
│       ├── DepositPage.ts
│       ├── WithdrawalPage.ts
│       ├── FundPasswordPage.ts
│       ├── ProfilePage.ts
│       ├── PromotionsPage.ts
│       ├── ReferralPage.ts
│       ├── NotificationsPage.ts
│       ├── BetHistoryPage.ts
│       ├── TransactionPage.ts
│       └── ChatPage.ts
├── test-results/
│   ├── e2e-ui/                        # ← UI E2E artifacts — one dated folder per run
│   │   ├── 2026-03-25_13-44-00/       #   run from 25 Mar 13:44
│   │   │   └── e2e-home-.../          #   per-test failure artifacts
│   │   └── ...
│   ├── vendor-reports/                # ← CSV output — one dated folder per run
│   │   ├── 2026-03-19T08-24-15/       #   run from 19 Mar 08:24
│   │   │   ├── Amusnet_2026-03-19T08-24-15.csv
│   │   │   └── PG_Soft_2026-03-19T08-24-15.csv
│   │   └── 2026-03-20T09-00-00/       #   run from 20 Mar 09:00
│   │       └── ...
│   ├── report.html                    # ← generated dashboard (open in browser)
│   └── diff.html                      # ← generated diff report
├── playwright/
│   └── .auth/
│       ├── user.json                  # Browser session state
│       ├── credential.json            # API credential {did, uid, token}
│       └── vendors.json               # Live vendor list (auto-refreshed each run)
├── playwright.config.ts
├── .env
└── README.md
```

> **Note:** UI E2E artifacts land in `test-results/e2e-ui/<datetime>/` and are **not wiped between runs** — each run gets its own folder. Game vendor CSV output in `test-results/vendor-reports/` follows the same pattern. If you want to clear old results, delete the dated subfolders manually.

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

### ⭐ Recommended: v5 — all vendors

```bash
npx playwright test tests/v5/ --project=chromium --workers=12
```

- **12 workers × 3 slots = 36 pages** — confirmed ⭐ sweet spot on 32 GB RAM (peaks ~22 GB, 69%)
- Global shared 36-token concurrency pool — last surviving vendor scales up to consume all free slots
- Page pool per vendor: contexts are recycled between games (no newContext per game)
- iPhone 14 Pro Max mobile emulation — portrait default, auto-switches to landscape if game requests it
- Dead-letter retry queue — failed games retried at end, zero mid-run CPU sleep
- 5-min freeze watchdog — aborts only the frozen worker; siblings continue unaffected
- All 53 vendor CSVs from this run land in one shared dated folder

### v5 — single vendor (debugging)

```bash
# Headless (fast)
npx playwright test tests/v5/ --project=chromium -g "v5: EpicWin"

# Headed (see the browser, confirm mobile emulation)
npx playwright test tests/v5/ --project=chromium -g "v5: EpicWin" --workers=1 --headed
```

### v4 — all vendors (stable baseline)

```bash
npx playwright test tests/v4/ --project=chromium --workers=6
```

- 6 vendors simultaneously · 3 games per vendor = 18 browser pages (constant ceiling)
- All 53 vendor CSVs from this run land in one shared dated folder: `test-results/vendor-reports/2026-03-19T08-24-15/`
- Worker pool architecture — memory stays flat regardless of vendor game count

### v4 — single vendor (debugging)

```bash
# Headless (fast)
npx playwright test tests/v4/ --project=chromium -g "v4: Amusnet"

# Headed (see the browser)
npx playwright test tests/v4/ --project=chromium -g "v4: PG Soft" --workers=1 --headed
```

### v4 — live progress in terminal

```bash
npx playwright test tests/v4/ --project=chromium --workers=6 --reporter=line
```

### v2 — all vendors (previous version, still works)

```bash
npx playwright test tests/v2/ --project=chromium --workers=6
```

### v1 — single vendor (legacy sequential)

```bash
npx playwright test tests/s9_test.spec.ts --project=chromium -g "API Validate: Amusnet"
```

---

## Viewing Results

### 1. Dashboard Report (recommended)

After a test run, generate the HTML dashboard from the project root:

```bash
# Full history (all run folders)
npx ts-node tests/reports/generateReport.ts

# Latest run only
npx ts-node tests/reports/generateReport.ts --latest

# Specific run folder
npx ts-node tests/reports/generateReport.ts --dir test-results/vendor-reports/2026-03-19T08-24-15

# Open the report
start test-results\report.html
```

The dashboard includes:
- **Overview KPIs** — total games, pass rate, fail count, flaky count, SLA breaches
- **Vendor health heatmap** — all 53 vendors ranked worst-to-best with green/red pass rate bars
- **Gate analysis** — which gate fails most often and why
- **Run timeline chart** — pass/fail trend across multiple runs
- **Flaky games** — games that produced both Pass and Fail across different runs
- **SLA breaches** — games failing continuously for more than 24 hours
- **Searchable game table** — filter by status, vendor, or flag; sortable columns

### 2. Run Diff

Compare two runs to see what regressed or was fixed:

```bash
# Auto-diff the two most recent runs
npx ts-node tests/reports/diffRuns.ts --latest

# Diff two specific run folders
npx ts-node tests/reports/diffRuns.ts ^
  --a-dir test-results/vendor-reports/2026-03-18T08-00-00 ^
  --b-dir test-results/vendor-reports/2026-03-19T08-00-00

# Open the diff report
start test-results\diff.html
```

The diff report shows:
- **Regressions** — games that changed from Pass → Fail (requires investigation)
- **Recoveries** — games that changed from Fail → Pass (vendor fixed the issue)
- **Error changed** — games still failing but with a different error message
- **New / removed games** — games that appeared or disappeared from the vendor list

### 3. Playwright HTML Report
```bash
npx playwright show-report
```
Interactive Playwright report — pass/fail per vendor, console logs, duration, screenshots on failure.

### 4. CSV Files (open in Excel)

Each vendor's results are saved to a dated run folder:
```
test-results/vendor-reports/<run-datetime>/<VendorName>_<run-datetime>.csv
```

CSV columns:
| VendorId | VendorName | GameId | GameName | Status | Gate | Retries | FrameDepth | Orientation | Error | Timestamp |

- **Gate** — which gate failed (1–4), blank for passing games
- **Retries** — retry attempts used (0 = first try; ≥1 = transient failure)
- **FrameDepth** — 1 = normal iframe, 2 = nested iframe detected and handled
- **Orientation** — `portrait` or `landscape` (v5 only — detected adaptively per game)
- Filter `Status = Fail` in Excel to see all failed games
- Filter `Retries > 0` in Excel to identify flaky game servers
- Filter `Orientation = landscape` to identify vendors with landscape-only games (e.g. EpicWin)

Example:
```
betby_600012_2026-03-25T10-11-15.csv      ← lowercase + vendor ID avoids
betby_600037_2026-03-25T10-11-15.csv         collision between "Betby" & "BETBY"
amusnet_600005_2026-03-19T08-24-15.csv
pg_soft_600021_2026-03-19T08-24-15.csv
```

### 5. Live Console (during v4 run)

```
📁 Run folder: test-results/vendor-reports/2026-03-19T08-24-15/
   53 vendors queued.

=== [Amusnet] v4 validation starting (ven_id=600005, concurrent=3, budget=20) ===
    CSV → test-results\vendor-reports\2026-03-19T08-24-15\Amusnet_2026-03-19T08-24-15.csv
[Amusnet] 161 games to test.
[Amusnet][1/161] Starting: 40 Almighty Ramses II
[Amusnet][1/161] ✗ Attempt 1 failed | Gate 2: Connection Failed
[Amusnet][1/161] ↻ Retry 1/2: 40 Almighty Ramses II (wait 3000ms)
[Amusnet][1/161] ✅ Passed on retry 1: 40 Almighty Ramses II
[Amusnet][1/161] → Pass [retried 1×]

📄 CSV saved: test-results\...\Amusnet_2026-03-19T08-24-15.csv (161 rows)
### [Amusnet] Summary: 159 passed, 2 failed / 161 total  (3 retried, 0 nested-iframe)
```

---

## How It Works

### Startup Sequence (v4)
```
1. globalSetup.ts        → refreshes vendors.json from live API
2. auth.setup.ts         → logs in → saves user.json + credential.json + vendors.json
3. s9_test_v4.spec.ts    → computes RUN_TIMESTAMP once (shared by all 53 vendors)
                         → reads vendors.json → creates one test() per vendor
4. 6 workers run vendor tests in parallel
5. Each vendor:
     worker pool (3 slots) → each slot pulls one game at a time
     → fresh browser context per game → 4-gate validation
     → retry on fail (up to 2×) → CSV row written immediately
     → next game pulled when slot finishes
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

### Nested Iframe Detection (v4)
Some providers load the actual game inside a second iframe nested inside the primary one. v4 automatically detects this pattern and descends to validate the inner frame instead, avoiding false failures on games that use a pass-through wrapper. The `FrameDepth` column in the CSV records `1` (normal) or `2` (nested).

### Retry Logic
If a game fails at any gate, it is retried automatically:
- **`MAX_RETRIES = 2`** — up to 2 retries (configurable in `apiValidationFlowV4.ts`)
- **`RETRY_DELAY_MS = 3000`** — 3s cooldown before retry (lets server recover)
- **`AUTH_FAILURE`** — never retried (token issue, re-run auth setup)
- Each retry uses a **fresh browser context** — no state from the failed attempt carries over
- Retry count recorded in the `Retries` CSV column

### Worker Pool Architecture (v4)
```
Worker pool — exactly MAX_CONCURRENT_GAMES slots per vendor, no pre-allocation:

  slot 0:  game[0] → game[3] → game[6] → …   (pulls next immediately on finish)
  slot 1:  game[1] → game[4] → game[7] → …
  slot 2:  game[2] → game[5] → game[8] → …

Only 3 browser contexts open per vendor at any moment, regardless of game count.
A vendor with 600 games creates no more RAM overhead than one with 10 games.

6 workers × 3 slots = 18 browser pages total ceiling × ~200MB = ~3.6GB browser RAM
```

### HTTPS Parent Page
Some providers (e.g. PG Soft) check `window.parent.location.protocol`. v4 intercepts `https://s9.com/**` with `page.route()`, serving an instant local stub to keep the HTTPS parent URL while eliminating the 5–20s real server navigation delay.

### Per-Run Dated Folders
The spec file computes `RUN_TIMESTAMP` once before any test starts. All 53 vendor CSVs from the same test invocation share that timestamp and land in the same subfolder:

```
test-results/vendor-reports/
    2026-03-19T08-24-15/      ← Monday run
        Amusnet_2026-03-19T08-24-15.csv
        PG_Soft_2026-03-19T08-24-15.csv
        ...  (one file per vendor)
    2026-03-20T09-00-00/      ← Tuesday run
        Amusnet_2026-03-20T09-00-00.csv
        ...
```

This makes it easy to report on a single run with `--latest`, or diff any two runs by folder name.

---

## Vendor Skip Adapter (`vendor-config.json`)

For vendors that require a VPN or have known issues, mark them for skipping in bulk runs by editing `playwright/.auth/vendor-config.json`:

```json
{
  "PG Soft": {
    "skipInBulkRun": true,
    "reason": "VPN required — games return REGION_RESTRICTED without VPN"
  },
  "BETBY": {
    "skipInBulkRun": true,
    "reason": "Under maintenance until 2026-04-01"
  }
}
```

- Keys are **case-insensitive** — `"pg soft"` matches vendor named `"PG Soft"` or `"PG SOFT"`
- Skipped vendors are **logged at startup** with their reason
- Skipped vendors can still be tested individually: `npx playwright test tests/v5/ --project=chromium -g "v5: PG Soft" --workers=1 --headed`
- The file is **optional** — if absent, all vendors run normally

---

## Tuning (Edit `apiValidationFlowV5.ts`)

| Constant | Default | Effect |
|---|---|---|
| `GLOBAL_PAGE_BUDGET` | `20` | Total browser pages across all workers. `budget × 200 MB ≤ available RAM` |
| `GAME_TIMEOUT_MS` | `90000` | Per-game hard timeout (ms). Race-kills frozen games immediately |
| `MAX_RETRIES` | `2` | Retry attempts per failed game (applied in dead-letter pass) |
| `RETRY_DELAY_MS` | `3000` | Cooldown between retries in dead-letter pass (ms) |
| `STAGGER_MS` | `200` | Delay between pool-slot cold-starts (ms) |
| `WATCHDOG_CHECK_MS` | `60000` | How often the freeze watchdog polls (ms) |
| `WORKER_IDLE_LIMIT_MS` | `300000` | Max idle time before watchdog force-exits frozen worker (ms) |
| `GATE3_SETTLE_MS` | `2000` | Settle wait before error scan (ms) |
| `GATE4_DURATION_MS` | `5000` | Stability watch duration (ms) |
| `NESTED_IFRAME_DETECT_MS` | `1000` | Timeout to probe for nested iframes (ms) |

> For v4 tuning constants, see the equivalent table in `apiValidationFlowV4.ts`.

**`MAX_CONCURRENT_GAMES` guide — formula: `floor(GLOBAL_PAGE_BUDGET / workers)`**

| Workers | Budget | `perWorkerSlots` | Total pages | Peak browser RAM | Notes |
|---|---|---|---|---|---|
| **12** | **36** | **3** | **36** | **~7.2 GB** | **✅ Confirmed sweet spot (32 GB machine)** |
| 6 | 20 | 3 | 18 | ~3.6 GB | Conservative / low-RAM machines |
| 6 | 24 | 4 | 24 | ~4.8 GB | |
| 8 | 24 | 3 | 24 | ~4.8 GB | |
| 12 | 30 | 2 | 24 | ~4.8 GB | If RAM spikes above 28 GB with budget=36 |
| 14 | 42 | 3 | 42 | ~8.4 GB | |

**Workers guide** (edit `playwright.config.ts`):

| Workers | Best for |
|---|---|
| 1 | Single vendor debugging |
| 6 | Recommended (stable, low memory) |
| 8 | Faster, still safe on 32 GB |
| 14 | Maximum throughput, watch memory |

---

## Report Tuning (Edit `generateReport.ts`)

| Constant | Default | Effect |
|---|---|---|
| `SLA_FAIL_HOURS` | `24` | Hours of continuous failure before a game is flagged as SLA breach |
| `FLAKY_MIN_RUNS` | `2` | Minimum runs needed before a game can be flagged as flaky |

---

## Migrating from v2 to v4

v2 remains fully functional. To switch to v4:

1. Place `tests/v4/s9_test_v4.spec.ts` and `tests/v4/apiValidationFlowV4.ts` in the project
2. Place `tests/reports/generateReport.ts` and `tests/reports/diffRuns.ts` in the project
3. Run using the v4 commands above — v2 commands still work unchanged

Key differences you will notice:

- Test prefix in Playwright report changes from `v2:` to `v4:`
- CSV now has a `FrameDepth` column between `Retries` and `Error`
- CSVs land in a dated subfolder instead of directly in `vendor-reports/`
- Console shows the run folder path at startup

---

## Troubleshooting

| Symptom | Solution |
|---|---|
| `AUTH_FAILURE` in many games | Re-run auth: `npx playwright test --project=setup` |
| `credential.json not found` | Run auth setup first |
| `vendors.json not found` | Run auth setup first |
| Rate limit errors (HTTP 429) | Reduce `GLOBAL_PAGE_BUDGET` or add stagger |
| All games fail at Gate 2 | Check `playwright/.auth/user.json` is fresh (re-run auth) |
| Game keeps failing after retries | Server-side issue; check that game manually in a browser |
| Test runs 3× for single vendor | Add `--project=chromium` to your command |
| No CSV files appear | Check `test-results/vendor-reports/<run-datetime>/` subfolder |
| `generateReport.ts` — no CSV directory | Run the validation tests first, then generate |
| `diffRuns.ts --latest` — only 1 run found | Need at least two completed runs to diff |
| CSV history lost between sessions | Playwright wipes `test-results/` on each run — copy dated folders out, or move `REPORTS_BASE_DIR` outside `test-results/` |
| Games show `FrameDepth = 2` | Normal — those games use a nested iframe; v4/v5 handle them automatically |
| CQ9 games show 404 blocked | Use v5 — iPhone 14 Pro Max UA bypasses DevTools bot-detection |
| EpicWin games show "Session Expired" | Use v5 — adaptive orientation auto-rotates to landscape for landscape-only games |
| Worker freezes past 49 vendors | v5 watchdog detects idle >5 min and force-exits only the frozen worker |
| Process hangs after all tests done | v5 `afterAll` calls `process.exit(0)` — zombie-worker hang is fixed |
| PG Soft (or other) all games REGION_RESTRICTED | Add vendor to `playwright/.auth/vendor-config.json` with `skipInBulkRun: true` |
| Two vendors with same name (different case) produce duplicate CSV | v5 auto-deduplicates: CSV filename includes vendor ID suffix e.g. `betby_600012_...csv` |

---

# s9.com 游戏供应商验证 (中文版)

自动化测试套件，通过基于 **API 优先** 的 Playwright 验证 s9.com 上的所有游戏供应商及其游戏。

---

## ⚡ 快捷命令参考

> **请务必先运行 auth setup。** 在运行任何测试之前，必须先进行身份验证。

| 您的需求 | 命令 |
|---|---|
| **首次运行 / 会话过期** | `npx playwright test --project=setup` |
| **运行所有供应商 (推荐使用 v5)** | `npx playwright test tests/v5/ --project=chromium --workers=6` |
| **单个供应商 — v5 无头模式** | `npx playwright test tests/v5/ --project=chromium -g "v5: Amusnet"` |
| **单个供应商 — v5 显示浏览器** | `npx playwright test tests/v5/ --project=chromium -g "v5: Amusnet" --workers=1 --headed` |
| **运行所有供应商 (v4 稳定版)** | `npx playwright test tests/v4/ --project=chromium --workers=6` |
| **单个供应商 — v4 无头模式** | `npx playwright test tests/v4/ --project=chromium -g "v4: Amusnet"` |
| **单个供应商 — v4 显示浏览器** | `npx playwright test tests/v4/ --project=chromium -g "v4: Amusnet" --workers=1 --headed` |
| **生成仪表板报告** | `npx ts-node tests/reports/generateReport.ts` |
| **报告 — 仅限最新运行** | `npx ts-node tests/reports/generateReport.ts --latest` |
| **比较最近的两次运行** | `npx ts-node tests/reports/diffRuns.ts --latest` |
| **打开仪表板** | `start test-results\report.html` |
| **查看 Playwright HTML 报告** | `npx playwright show-report` |
| **v2 所有供应商 (旧版)** | `npx playwright test tests/v2/ --project=chromium --workers=6` |
| **v1 单个供应商 (旧版)** | `npx playwright test tests/s9_test.spec.ts --project=chromium -g "API Validate: Amusnet"` |
| | |
| **UI E2E — 所有套件** | `npx playwright test tests/e2e/ --project=chromium` |
| **UI E2E — 单个套件** | `npx playwright test tests/e2e/home.spec.ts --project=chromium` |
| **UI E2E — 有头模式 (调试)** | `npx playwright test tests/e2e/home.spec.ts --project=chromium --headed` |

> ⚠️ **运行单个供应商测试时，请务必包含 `--project=chromium`**。
> 否则，Playwright 将运行所有 3 个浏览器项目 (chromium + firefox + webkit) = 运行 3 次。

---

## UI E2E 测试套件

基于**页面对象模型 (POM)** 的浏览器自动化套件，直接测试 s9.com 前端 — 登录、主仪表板、存款、提款、个人资料、促销活动、推荐等。

### 测试套件

| 规范文件 (Spec file) | 测试 ID | 测试范围 |
|---|---|---|
| `auth.spec.ts` | TC-AUTH-* | 登录、登出、会话持久性 |
| `home.spec.ts` | TC-HOME-* | 仪表板元素、游戏选项卡、聊天室、记分板、通知 |
| `deposit.spec.ts` | TC-DEP-* | 存款表单、付款方式 |
| `withdrawal.spec.ts` | TC-WD-* | 提款表单、资金密码键盘 |
| `profile.spec.ts` | TC-PROF-* | 个人资料字段、头像、个人信息 |
| `promotions.spec.ts` | TC-PROMO-* | 促销列表、横幅可见性 |
| `referral.spec.ts` | TC-REF-* | 推荐页面、邀请链接 |
| `notifications.spec.ts` | TC-NOTIF-* | 通知面板、已读/未读状态 |
| `bet-history.spec.ts` | TC-BET-* | 投注历史表格、过滤器 |
| `transactions.spec.ts` | TC-TXN-* | 交易历史 |
| `chat.spec.ts` | TC-CHAT-* | 聊天室小部件、消息输入 |
| `navigation.spec.ts` | TC-NAV-* | 底部导航、页面路由 |

### 页面对象模型 (POM)

| 模型 | 覆盖范围 |
|---|---|
| `LoginPage.ts` | 登录表单、提交、头像检测 |
| `HomePage.ts` | 横幅、聊天室、游戏选项卡、快速链接 (记分板、直播)、侧边栏钱包 |
| `BottomNavPage.ts` | 底部导航选项卡 (主页、存款、促销、推荐、个人资料) |
| `DepositPage.ts` | 存款表单和付款方式选择器 |
| `WithdrawalPage.ts` | 提款表单和资金密码键盘 |
| `FundPasswordPage.ts` | 随机 PIN 键盘交互 |
| `ProfilePage.ts` | 个人资料字段、头像、设置 |
| `PromotionsPage.ts` | 促销卡片和横幅 |
| `ReferralPage.ts` | 推荐链接和统计 |
| `NotificationsPage.ts` | 通知列表和状态 |
| `BetHistoryPage.ts` | 投注历史表格和过滤器 |
| `TransactionPage.ts` | 交易列表 |
| `ChatPage.ts` | 聊天小部件和输入 |

### 运行 UI E2E 测试

```bash
# Auth 设置 (每个会话需运行一次)
npx playwright test --project=setup

# 所有 UI 套件
npx playwright test tests/e2e/ --project=chromium

# 单个套件
npx playwright test tests/e2e/home.spec.ts --project=chromium

# 按 ID 运行单个测试
npx playwright test tests/e2e/home.spec.ts --project=chromium -g "TC-HOME-001"

# 有头模式 (显示浏览器)
npx playwright test tests/e2e/home.spec.ts --project=chromium --headed
```

### 测试结果输出

每次 UI E2E 运行都会将工件写入**隔离的按日期时间命名的子文件夹**，因此不同测试流程的结果永远不会被覆盖：

```
test-results/
├── e2e-ui/
│   ├── 2026-03-25_13-44-00/    ← 3月25日 13:44 的运行
│   │   ├── e2e-home-Home-Page-TC-HOME-001-chromium/
│   │   │   ├── error-context.md   (失败时的 ARIA 快照)
│   │   │   └── screenshot.png
│   │   └── ...
│   └── 2026-03-26_09-00-00/    ← 下一次运行
└── vendor-reports/              ← 游戏供应商验证 (分开存放)
```

### 已知的 UI 行为 (自动处理)

| 行为 | 处理方式 |
|---|---|
| **登录/登出成功覆盖层** | 不可点击，约 2 秒后自动消失 — `dismissOverlays()` 会等待其消失 |
| **开发者推送重新加载警报** | 浏览器级别 `confirm()` — 在 `goto()` 内通过 `page.once('dialog', ...)` 接受 |
| **通知覆盖层** | 全屏，自动消失 — 使用相同的 `dismissOverlays()` 等待 |
| **公告/促销模态框** | 可点击关闭按钮 — 如果存在，`dismissAnnouncementModal()` 会将其关闭 |
| **侧边栏钱包按钮** | 存款/提款包含在一个隐藏的抽屉里 — 使用 `openSidebar()` 显示它们 |
| **“建设中”提示** | 短暂自动消失 — 点击后立即断言 |
| **持久化的 WebSocket (聊天室)** | `networkidle` 永远不会结束 — 因此 `goto()` 使用 `'load'` 状态 + 1 秒等待 |

---

## 概述

此套件不通过点击网站 UI，而是直接调用 s9.com 后端 API 来：
1. 自动从 API 获取实时供应商列表 (非硬编码列表)
2. 立即发现每个供应商的所有游戏 (无需滚动 DOM)
3. 启动每个游戏会话并接收提供商的重定向 URL
4. 使用与父页面相同的 HTTPS (通过 `page.route()` 拦截) 将游戏嵌入到 iframe 中
5. 运行 **4 关卡验证 (4-gate validation)**，将每个游戏分类为 **通过 (Pass)** 或 **失败 (Fail)**
6. **自动重试** 临时故障 (可配置，默认 2 次重试，间隔 3 秒)
7. **生成仪表板报告**，包含供应商健康热力图、不稳定游戏检测和 SLA 跟踪

**53 个供应商 · 6,000+ 款游戏 · 并行测试：**

| 版本 | 位置 | 策略 | 预计速度 |
|---|---|---|---|
| v1 | `tests/s9_test.spec.ts` | 每个供应商一次 1 个游戏，DOM 滚动 | ~3.5小时 |
| v2 | `tests/v2/s9_test_v2.spec.ts` | 基于信号量的并发队列，API | ~18 分钟 |
| v4 | `tests/v4/s9_test_v4.spec.ts` | 工作池，嵌套 iframe 检测，包含日期的运行文件夹 | ~100 分钟 @ 6 workers |
| v5 ⭐ | `tests/v5/s9_test_v5.spec.ts` | 自适应并发、页面池、移动端模拟、死信重试队列、冻结挂起守卫 | ~50–60 分钟 @ 6 workers |

---

## 前置条件

```bash
npm install
npx playwright install chromium
```

---

## 项目结构
(此处与英文版目录结构一致。`#` 后的部分为相关文件的标注说明。)

```
d:/Yoong testing/
├── tests/
│   ├── auth.setup.ts                  # 登录 + 保存 auth 状态，API 凭据及供应商列表
│   ├── globalSetup.ts                 # 每次运行测试前刷新供应商列表
│   ├── s9_test.spec.ts                # v1 测试运行器 (顺序执行，旧版)
│   ├── v2/
│   │   ├── s9_test_v2.spec.ts         # v2 测试运行器 (信号量队列)
│   │   └── apiValidationFlowV2.ts     # v2 验证逻辑
│   ├── v4/
│   │   ├── s9_test_v4.spec.ts         # v4 测试运行器 (工作池)
│   │   └── apiValidationFlowV4.ts     # v4 验证逻辑
│   ├── v5/
│   │   ├── s9_test_v5.spec.ts         # v5 测试运行器 (自适应并发 + 页面池) ⭐
│   │   └── apiValidationFlowV5.ts     # v5 验证逻辑
│   ├── reports/
│   │   ├── generateReport.ts          # 根据所有 CSV 运行数据构建 HTML 仪表板
│   │   └── diffRuns.ts                # 比较两次运行，展示回归与恢复情况
│   ├── api/
│   │   └── s9ApiClient.ts             # 纯 HTTP 客户端 (无浏览器)
... (其他 UI 及 POM 模型省略，同英文版)
├── test-results/
│   ├── e2e-ui/                        # ← UI E2E 产物 — 每次运行生成一个日期文件夹
│   ├── vendor-reports/                # ← CSV 输出 — 每次运行生成一个日期文件夹
│   ├── report.html                    # ← 生成的仪表板 (在浏览器中打开)
│   └── diff.html                      # ← 生成的对比报告
...
```

> **注意：** UI E2E 产物保存在 `test-results/e2e-ui/<datetime>/` 中并且**不会在运行之间被擦除** — 每次运行都有自己的文件夹。游戏供应商的 CSV 输出保存在 `test-results/vendor-reports/` 遵循相同模式。如果想清除旧结果，需手动删除相关的日期子文件夹。

---

## 首次设置

### 1. 配置凭据
在项目根目录创建 `.env` 文件：
```
TEST_USER=yoongtestt01
TEST_PASS=Yoong01!!
BASE_URL=https://s9.com
```

### 2. 运行身份验证设置
登录，捕获 API 令牌，保存浏览器会话 + 供应商列表：
```bash
npx playwright test --project=setup
```
> **每当会话过期时重新运行** — 令牌过期会在结果中显示为 `AUTH_FAILURE`。

---

## 运行测试

### ⭐ 推荐：v5 — 所有供应商

```bash
npx playwright test tests/v5/ --project=chromium --workers=6
```

- 全局共享 20 令牌并发池 — 最后剩余的大供应商自动扩展并消耗所有空闲令牌
- 每个供应商使用页面池 — 上下文在游戏间循环复用，无需每次重新创建
- iPhone 14 Pro Max 移动端模拟 — 默认竖屏，如游戏需要则自动旋转横屏
- 死信重试队列 — 失败游戏在所有游戏结束后重试，零等待中断
- 5 分钟冻结守卫 — 仅中止冻结的单个 worker，其他 worker 正常继续

### v4 — 所有供应商 (稳定基准)

```bash
npx playwright test tests/v4/ --project=chromium --workers=6
```

- 同时测试 6 个供应商 · 每个供应商 3 个游戏 = 18 个浏览器页面 (固定资源上限)
- 此运行中的所有 53 个供应商 CSV 都会落入一个共享的日期文件夹：`test-results/vendor-reports/2026-03-19T08-24-15/`
- 工作池架构 — 无论供应商游戏数量多少，内存都保持平稳

### v4 — 单个供应商 (调试)

```bash
# 无头模式 (快)
npx playwright test tests/v4/ --project=chromium -g "v4: Amusnet"

# 有头模式 (显示浏览器)
npx playwright test tests/v4/ --project=chromium -g "v4: PG Soft" --workers=1 --headed
```

### 查看结果

#### 1. 仪表板报告 (推荐)
通过命令 `npx ts-node tests/reports/generateReport.ts` (可加 `--latest`) 生成包含游戏通过率、健康情况及 SLA 违规情况的仪表板。

#### 2. 运行差异对比
通过命令 `npx ts-node tests/reports/diffRuns.ts --latest` 可以比较发现相比上次新增的错误（回归）以及修复好的游戏。

#### 3. Playwright HTML 报告
可使用 `npx playwright show-report` 浏览控制台日志和截图等。

#### 4. CSV 文件 (在 Excel 内打开)
`Gate` — 失败的关卡 (1-4)  
`Retries` — 重试次数  
`FrameDepth` — 嵌套 iframe 深度  
`Orientation` — 游戏实际运行的屏幕方向（`portrait` 竖屏 / `landscape` 横屏，仅 v5）

---

## 它是如何工作的 (v4 验证原理)

启动时获取最新的供应商和游戏数据；每个游戏经历的 **4 关卡验证 (4-Gate Validation)** 为：
1. **Gate 1 — API 接口 (API Entry):** 校验获取游戏 URL 等数据。
2. **Gate 2 — iframe 加载 (iframe Load):** 检查游戏 iframe 页面有没有 4xx/5xx 下载错误或超时。
3. **Gate 3 — 立即错误扫描 (Immediate Error Scan):** 扫描明显的游戏报错字符。
4. **Gate 4 — 稳定性监控 (Stability Watch):** 检查游戏内部一定时间会不会崩溃或白屏。

如游戏具备嵌套套娃 iframe，v4 版可自动捕获进入 (FrameDepth = 2)。只要任何一关失败，系统都会重新开启一个新的独立浏览器上下文，默认**重试 2 次**。

### 常见的排错情况
- **`AUTH_FAILURE`**: 重新跑 setup 更新 Token。
- **所有游戏失败于 Gate 2**: 用户状态过期或 IP 问题。
- **速率受限 (HTTP 429)**: 调低 `GLOBAL_PAGE_BUDGET` 或增加队列延迟。
- **CQ9 游戏显示 404 被封锁**: 使用 v5 — iPhone UA 绕过 DevTools 检测。
- **EpicWin 游戏显示「会话已过期」**: 使用 v5 — 自适应方向会自动旋转为横屏。
- **进程在所有测试结束后挂起**: v5 已修复 — `afterAll` 中调用 `process.exit(0)`。
- **Worker 在 49 个供应商后冻结**: v5 冻结守卫：超过 5 分钟无活动则仅强制退出该 worker。

更多配置可在 `apiValidationFlowV5.ts` 与 `generateReport.ts` 中根据注释修改。