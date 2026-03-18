# v2 Improvements — Implementation Plan

## Background

The current v2 implementation has 5 areas to fix:
1. **Hardcoded vendor list** — spec file has 51 vendors pasted in manually instead of calling the API
2. **Sequential batch bottleneck** — games within a vendor are run in locked steps of 3, not freely concurrent
3. **Loop bugs** — pagination loop and stagger multiplier have subtle issues
4. **CPU hogging** — no Chromium launch args, vendor workers only 8
5. **Gate timing waste** — 11s minimum per game is higher than needed

---

## Bugs Found (Loop Audit)

> [!WARNING]
> These bugs exist in the **current** code and need to be fixed.

### Bug 1 — [getGameList()](file:///d:/Yoong%20testing/tests/api/s9ApiClient.ts#176-231) pagination: `pageIndex` increments AFTER break check (logic fault)
[s9ApiClient.ts](file:///d:/Yoong%20testing/tests/api/s9ApiClient.ts) lines 200–224:
```diff
- if (games.length < PAGE_SIZE) break;
- pageIndex++;
+ pageIndex++;
+ if (games.length < PAGE_SIZE) break;
```
**Current behaviour**: On the very last page call, if it returns exactly 50 games AND it happens to be the last page, the `while` loop condition `allGames.length < totalCount` catches it — OK in that case. But if `res.count` is missing/0 (API quirk), `totalCount` remains `Infinity` and the loop runs forever requesting page 0 repeatedly because `pageIndex` never gets to increment when the last page returns 0 items.

**Fix**: Always increment `pageIndex` before checking the break condition. Also add a hard guard: if `games.length === 0` always break unconditionally.

### Bug 2 — [getGameList()](file:///d:/Yoong%20testing/tests/api/s9ApiClient.ts#176-231) returns `count=0` for empty vendors causing infinite loop
If a vendor has 0 games, the API returns `count=0`. Then `totalCount = 0`, and `allGames.length (0) < totalCount (0)` is `false` so the loop never starts. This is actually fine — but the `Infinity` initial value means if `res.count` is ever `undefined` (network glitch), we spin forever.

**Fix**: Add `if (games.length === 0) break;` as unconditional safety guard inside the loop.

### Bug 3 — Stagger multiplier is incorrect for large batches
```typescript
// Current — waits 0, 500, 1000ms for batch of 3
await sleep(indexInChunk * STAGGER_MS);
```
With `GAMES_PER_BATCH=6`, game index 5 waits 2500ms before starting. This is 2.5s wasted idle time at the start of every batch. A fixed small stagger (not multiplied) is better:
```typescript
// Better — waits 0, 300, 600, 900, 1200, 1500ms max
await sleep(indexInChunk * 300);
```
But with a semaphore-based queue (Bug 3 fix eliminates batches entirely), stagger becomes irrelevant.

---

## Proposed Changes

### Component 1 — API Client

#### [MODIFY] [s9ApiClient.ts](file:///d:/Yoong%20testing/tests/api/s9ApiClient.ts)
- Fix `pageIndex` increment order in [getGameList()](file:///d:/Yoong%20testing/tests/api/s9ApiClient.ts#176-231) pagination loop
- Add `if (games.length === 0) break;` safety guard
- No other changes to the public API

---

### Component 2 — Test Spec (Dynamic Vendor List)

#### [MODIFY] [s9_test_v2.spec.ts](file:///d:/Yoong%20testing/tests/v2/s9_test_v2.spec.ts)
- Remove the 51-entry hardcoded `vendors` array entirely
- Use `test.beforeAll()` to call [getVendorList()](file:///d:/Yoong%20testing/tests/api/s9ApiClient.ts#153-175) once before any tests run
- Store result in module-level variable
- Keep a small `EXCLUDED_VENDOR_IDS` set (e.g. `[600006]`) for explicit overrides
- Generate [test()](file:///d:/Yoong%20testing/tests/flows/vendorValidationFlow.ts#115-330) entries from the dynamic list using `for...of` inside `test.describe`

> [!IMPORTANT]
> Playwright generates test cases **at collection time** (before `beforeAll` runs). To support dynamic test generation, we use a **two-pass approach**:
> 1. A `globalSetup` script (already runs before everything) pre-fetches the vendor list and writes it to `playwright/.auth/vendors.json`
> 2. The spec reads `vendors.json` synchronously (no await needed) to build its test list

This is the only reliable pattern for dynamic test generation in Playwright because `test.describe` callbacks are synchronous.

---

### Component 3 — Main Flow (Full Concurrency + Performance)

#### [MODIFY] [apiValidationFlowV2.ts](file:///d:/Yoong%20testing/tests/v2/apiValidationFlowV2.ts)

**Replace sequential batch loop with a semaphore-based concurrent queue:**

Current (bad):
```
Batch 1: [g1, g2, g3] — await all 3
Batch 2: [g4, g5, g6] — await all 3  ← waits for slowest in batch 1
Batch 3: [g7, g8, g9] — await all 3  ← waits for slowest in batch 2
```
> If g2 takes 20s (slow game server), g3 finishes in 11s but **sits idle waiting for batch to complete** before g4 starts.

Proposed (correct — semaphore queue):
```
Semaphore(6) — up to 6 games running at ANY time
g1 starts → g2 starts → g3 starts → g4 starts → g5 starts → g6 starts
g3 finishes (11s) → g7 immediately starts (no waiting for g1/g2)
```
This eliminates all inter-batch idle time. A semaphore limits the cap (avoids memory explosion).

**Implementation** — a simple in-process semaphore class (no npm dependency):
```typescript
class Semaphore {
    private running = 0;
    private queue: (() => void)[] = [];
    constructor(private max: number) {}
    acquire(): Promise<void> {
        return new Promise(resolve => {
            if (this.running < this.max) { this.running++; resolve(); }
            else this.queue.push(resolve);
        });
    }
    release(): void {
        this.running--;
        const next = this.queue.shift();
        if (next) { this.running++; next(); }
    }
}
```

**Timing reductions:**
- Gate 3 settle: `3000` → `2000` ms (saves 1s per game)
- Gate 4 duration: `8000` → `5000` ms (saves 3s per game)
- Total minimum per game: `11s` → `7s` (**36% faster**)

**Tuning constants:**
```typescript
const MAX_CONCURRENT_GAMES = 6;  // replaces GAMES_PER_BATCH
const STAGGER_MS = 200;          // between concurrent game starts
```

---

### Component 4 — Playwright Config (CPU Performance)

#### [MODIFY] [playwright.config.ts](file:///d:/Yoong%20testing/playwright.config.ts)
- Increase `workers`: `8` → `14`
- Add `launchOptions.args`: `['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions']`
- These flags reduce Chrome's GPU IPC overhead (GT 710 is bottleneck) and shared memory overhead

---

### Component 5 — Global Setup (vendor pre-fetch)

#### [NEW] [globalSetup.ts](file:///d:/Yoong%20testing/tests/globalSetup.ts)
- Reads `credential.json`
- Calls [getVendorList()](file:///d:/Yoong%20testing/tests/api/s9ApiClient.ts#153-175) — fast single API call
- Writes `playwright/.auth/vendors.json`
- Only runs once before the test suite starts (wired in [playwright.config.ts](file:///d:/Yoong%20testing/playwright.config.ts))

---

## Performance Projection

| Config | Workers | Games/Worker | Min/game | Est. Total |
|---|---|---|---|---|
| **Current** | 8 | 3 (sequential batches) | 11s | ~50 min |
| **After fix** | 14 | 6 (semaphore queue) | 7s | **~18 min** |

Memory: 14 workers × 6 games = 84 pages × ~200MB = ~16.8GB peak (within 32GB budget)

---

## Verification Plan

### Automated (TypeScript compile check)
```powershell
cd "d:\Yoong testing"
npx tsc --noEmit
```
Must return 0 errors.

### Single-vendor smoke test (fast, ~3 min)
```powershell
cd "d:\Yoong testing"
npx playwright test tests/v2/ --project=chromium -g "v2: Amusnet" --workers=1
```
- Confirms dynamic vendor list loads correctly (Amusnet appears in results)
- Confirms gate timings work (no false failures)
- Confirms CSV is written to `test-results/vendor-reports/`

### Full run (manual observational check)
```powershell
cd "d:\Yoong testing"
npx playwright test tests/v2/ --project=chromium --workers=14
```
- Watch Task Manager CPU — should be lower (spread across cores vs pegged at 100%)
- Check `test-results/vendor-reports/` for CSV files per vendor
- Run `npx playwright show-report` to view HTML report
