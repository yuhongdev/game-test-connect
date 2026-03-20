# s9.com Game Vendor Validation

Automated testing suite that validates all game vendors and their games on s9.com using an **API-first** approach with Playwright.

---

## ⚡ Quick Command Reference

> **Always run auth setup first.** Auth is required before any test can run.

| What you want | Command |
|---|---|
| **First-time / session expired** | `npx playwright test --project=setup` |
| **Run all vendors (v4 recommended)** | `npx playwright test tests/v4/ --project=chromium --workers=6` |
| **Single vendor — headless** | `npx playwright test tests/v4/ --project=chromium -g "v4: Amusnet"` |
| **Single vendor — visible browser** | `npx playwright test tests/v4/ --project=chromium -g "v4: Amusnet" --workers=1 --headed` |
| **Generate dashboard report** | `npx ts-node tests/reports/generateReport.ts` |
| **Report — latest run only** | `npx ts-node tests/reports/generateReport.ts --latest` |
| **Diff two most recent runs** | `npx ts-node tests/reports/diffRuns.ts --latest` |
| **Open dashboard** | `start test-results\report.html` |
| **View Playwright HTML report** | `npx playwright show-report` |
| **v2 all vendors (previous)** | `npx playwright test tests/v2/ --project=chromium --workers=6` |
| **v1 single vendor (legacy)** | `npx playwright test tests/s9_test.spec.ts --project=chromium -g "API Validate: Amusnet"` |

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
7. **Generate a dashboard report** with vendor health heatmap, flaky game detection, and SLA tracking

**53 vendors · 6,000+ games · tested in parallel:**

| Version | Location | Strategy | Est. Speed |
|---|---|---|---|
| v1 | `tests/s9_test.spec.ts` | 1 game at a time per vendor, DOM scroll | ~3.5h |
| v2 | `tests/v2/s9_test_v2.spec.ts` | Semaphore-based concurrent queue, API | ~18 min |
| v4 ⭐ | `tests/v4/s9_test_v4.spec.ts` | Worker pool, nested iframe detection, dated run folders | ~25 min @ 6 workers |

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
│   │   ├── s9_test_v4.spec.ts         # v4 test runner (worker pool) ⭐
│   │   └── apiValidationFlowV4.ts     # v4 validation logic
│   ├── reports/
│   │   ├── generateReport.ts          # Builds HTML dashboard from all CSV runs
│   │   └── diffRuns.ts                # Diffs two runs, shows regressions & recoveries
│   ├── api/
│   │   └── s9ApiClient.ts             # Pure HTTP client (no browser)
│   ├── flows/
│   │   ├── apiValidationFlow.ts       # v1 validation logic
│   │   └── vendorValidationFlow.ts    # Legacy DOM-based (reference only)
│   └── models/
│       └── LoginPage.ts
├── test-results/
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

> **Note:** `test-results/` is wiped by Playwright before every run. The dated run folders inside `vendor-reports/` are also wiped. If you want to keep CSV history across multiple test sessions, copy the dated folders out before re-running, or change `REPORTS_BASE_DIR` in `apiValidationFlowV4.ts` to a path outside `test-results/`.

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

### ⭐ Recommended: v4 — all vendors

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
| VendorId | VendorName | GameId | GameName | Status | Gate | Retries | FrameDepth | Error | Timestamp |

- **Gate** — which gate failed (1–4), blank for passing games
- **Retries** — retry attempts used (0 = first try; ≥1 = transient failure)
- **FrameDepth** — 1 = normal iframe, 2 = nested iframe detected and handled
- Filter `Status = Fail` in Excel to see all failed games
- Filter `Retries > 0` in Excel to identify flaky game servers

Example:
```
600005,"Amusnet",1297,"Dynamic Roulette 120x","Pass",,0,1,"",2026-03-19T08-24-15
600005,"Amusnet",1298,"Live European Roulette","Fail",3,2,1,"Game Error: An error occurred...","2026-03-19T08-24-15"
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

## Tuning (Edit `apiValidationFlowV4.ts`)

| Constant | Default | Effect |
|---|---|---|
| `MAX_CONCURRENT_GAMES` | `3` | Game slots per vendor worker. Hard ceiling on browser pages |
| `GLOBAL_PAGE_BUDGET` | `20` | Documentation cap: `MAX_CONCURRENT_GAMES = floor(budget / workers)` |
| `MAX_RETRIES` | `2` | Retry attempts per failed game |
| `RETRY_DELAY_MS` | `3000` | Cooldown between retries (ms) |
| `STAGGER_MS` | `200` | Delay between worker cold-starts (ms) |
| `GATE3_SETTLE_MS` | `2000` | Settle wait before error scan (ms) |
| `GATE4_DURATION_MS` | `5000` | Stability watch duration (ms) |
| `NESTED_IFRAME_DETECT_MS` | `1000` | Timeout to probe for nested iframes (ms) |

**`MAX_CONCURRENT_GAMES` guide — formula: `floor(GLOBAL_PAGE_BUDGET / workers)`**

| Workers | Budget | MAX_CONCURRENT_GAMES | Total pages | Peak browser RAM |
|---|---|---|---|---|
| 6 | 20 | 3 | 18 | ~3.6 GB |
| 6 | 24 | 4 | 24 | ~4.8 GB |
| 8 | 20 | 2 | 16 | ~3.2 GB |
| 8 | 24 | 3 | 24 | ~4.8 GB |
| 14 | 20 | 1 | 14 | ~2.8 GB |
| 14 | 42 | 3 | 42 | ~8.4 GB |

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
| Rate limit errors (HTTP 429) | Reduce `MAX_CONCURRENT_GAMES` or add workers stagger |
| All games fail at Gate 2 | Check `playwright/.auth/user.json` is fresh (re-run auth) |
| Game keeps failing after retries | Server-side issue; check that game manually in a browser |
| Test runs 3× for single vendor | Add `--project=chromium` to your command |
| No CSV files appear | Check `test-results/vendor-reports/<run-datetime>/` subfolder |
| `generateReport.ts` — no CSV directory | Run the validation tests first, then generate |
| `diffRuns.ts --latest` — only 1 run found | Need at least two completed runs to diff |
| CSV history lost between sessions | Playwright wipes `test-results/` on each run — copy dated folders out, or move `REPORTS_BASE_DIR` outside `test-results/` |
| Games show `FrameDepth = 2` | Normal — those games use a nested iframe; v4 handles them automatically |