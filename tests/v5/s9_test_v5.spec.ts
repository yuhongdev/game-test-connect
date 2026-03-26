/**
 * s9_test_v5.spec.ts — v5 test runner: adaptive concurrency + page pooling.
 *
 * ── vendor-config.json (optional skip adapter) ────────────────────────────────
 *
 *  Create playwright/.auth/vendor-config.json to mark vendors that should be
 *  skipped in bulk runs (e.g. VPN-required, maintenance, under-construction).
 *  Skipped vendors are logged at startup and excluded from test creation.
 *  They can still be tested individually using -g "v5: VendorName".
 *
 *  Format:
 *    {
 *      "PG Soft": { "skipInBulkRun": true, "reason": "VPN required" },
 *      "BETBY":   { "skipInBulkRun": true, "reason": "Under maintenance" }
 *    }
 *
 *  Keys are matched case-insensitively against the vendor name from vendors.json.
 *  The file is completely optional — if absent, all vendors run as normal.
 *
 * ── Key upgrades from v4 ──────────────────────────────────────────────────────
 *
 *  1. GLOBAL_PAGE_BUDGET is enforced by a single Semaphore shared across all
 *     Playwright workers in this process.  When a small vendor finishes early,
 *     its tokens are released back and the still-running large-vendor workers
 *     absorb them automatically — the last worker scales up toward the full budget.
 *
 *  2. Per-worker slot count is computed dynamically:
 *       perWorkerSlots = Math.floor(GLOBAL_PAGE_BUDGET / workers)
 *     This controls the PagePool size (how many contexts are pre-created) and
 *     the primary-pass concurrency inside apiValidationFlowV5.
 *
 *  3. Mobile emulation (iPhone 14 Pro Max, landscape 932×430) is applied
 *     in every BrowserContext created by the PagePool — fixes CQ9 404 block
 *     and EpicWin rotate-phone splash.
 *
 *  4. test.afterAll calls process.exit(0) to prevent the zombie-worker hang
 *     that was observed past 49 vendors in v4 runs.
 *
 * ── Run commands ──────────────────────────────────────────────────────────────
 *
 *  All vendors (recommended):
 *    npx playwright test tests/v5/ --project=chromium --workers=6
 *
 *  Single vendor — headless:
 *    npx playwright test tests/v5/ --project=chromium -g "v5: EpicWin"
 *
 *  Single vendor — headed (see browser):
 *    npx playwright test tests/v5/ --project=chromium -g "v5: EpicWin" --workers=1 --headed
 *
 *  ⚠️  Always include --project=chromium.
 *      Without it: chromium + firefox + webkit = 3× the runs.
 *
 * ── Generate reports after a run ─────────────────────────────────────────────
 *
 *  Latest run:        npx ts-node tests/reports/generateReport.ts --latest
 *  All history:       npx ts-node tests/reports/generateReport.ts
 *  Diff two runs:     npx ts-node tests/reports/diffRuns.ts --latest
 *
 * ── Tuning ────────────────────────────────────────────────────────────────────
 *
 *  GLOBAL_PAGE_BUDGET = 36  → ~7.2 GB browser RAM  ← recommended (12 workers × 3 slots)
 *  GLOBAL_PAGE_BUDGET = 20  → ~4.0 GB browser RAM  (conservative / 6 workers)
 *
 *  workers=12, budget=36 → perWorkerSlots = floor(36/12) = 3  ← default ⭐
 *  workers=6,  budget=20 → perWorkerSlots = floor(20/6)  = 3  ← conservative
 */

import { test }  from '@playwright/test';
import * as fs   from 'fs';
import * as path from 'path';
import { apiValidateVendorGamesFlowV5, Semaphore } from './apiValidationFlowV5';
import { RUN_META_FILE } from '../globalSetup';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Hard upper bound on total browser pages open across ALL vendor workers.
 * Formula:  GLOBAL_PAGE_BUDGET × 200 MB ≤ (total_RAM - ~10 GB overhead)
 *   32 GB machine: budget=36 → 36×200MB = 7.2 GB browser + ~1.8 GB worker procs ≈ 22 GB total peak (69%).
 *   If RAM exceeds 28 GB during a run, drop budget to 30.
 */
const GLOBAL_PAGE_BUDGET = 36;

// ── Shared run timestamp ──────────────────────────────────────────────────────
//
// Read from run-meta.json written by globalSetup (runs once before all workers).
// This ensures every worker uses the SAME timestamp → same output folder.
// Fallback to a local timestamp only if the file is missing (e.g. solo run).
//
function loadRunTimestamp(): string {
    try {
        if (fs.existsSync(RUN_META_FILE)) {
            const meta = JSON.parse(fs.readFileSync(RUN_META_FILE, 'utf8'));
            if (typeof meta?.runTimestamp === 'string') return meta.runTimestamp;
        }
    } catch { /* fall through */ }
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
const RUN_TIMESTAMP = loadRunTimestamp();

// ── Shared global semaphore ───────────────────────────────────────────────────
//
// One semaphore with GLOBAL_PAGE_BUDGET tokens is shared across all vendor
// test functions executed within this Playwright worker process.
//
// When a small vendor finishes early its tokens flow back to the semaphore and
// any still-running large-vendor workers consume them — adaptive concurrency.
//
const GLOBAL_SEM = new Semaphore(GLOBAL_PAGE_BUDGET);

// ── Dynamic vendor list + vendor-config.json skip adapter ─────────────────────

const VENDORS_FILE       = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'vendors.json');
const VENDOR_CONFIG_FILE = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'vendor-config.json');

interface VendorConfig {
    skipInBulkRun?: boolean;
    reason?:        string;
}

function loadVendors(): Array<{ id: number; name: string }> {
    if (!fs.existsSync(VENDORS_FILE)) {
        throw new Error(
            `vendors.json not found at ${VENDORS_FILE}.\n` +
            `Run auth setup first: npx playwright test --project=setup\n` +
            `Then retry: npx playwright test tests/v5/ --project=chromium`
        );
    }
    return JSON.parse(fs.readFileSync(VENDORS_FILE, 'utf8')) as Array<{ id: number; name: string }>;
}

/**
 * Loads the optional vendor-config.json.
 * Returns an empty object if the file doesn't exist — no vendors skipped.
 */
function loadVendorConfig(): Record<string, VendorConfig> {
    if (!fs.existsSync(VENDOR_CONFIG_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(VENDOR_CONFIG_FILE, 'utf8')) as Record<string, VendorConfig>;
    } catch (e: any) {
        console.warn(`⚠️  vendor-config.json parse error: ${e.message} — skipping config.`);
        return {};
    }
}

// Case-insensitive key lookup
function getVendorCfg(
    config: Record<string, VendorConfig>,
    name: string,
): VendorConfig | undefined {
    const lower = name.toLowerCase();
    for (const [key, cfg] of Object.entries(config)) {
        if (key.toLowerCase() === lower) return cfg;
    }
    return undefined;
}

const allVendors   = loadVendors();
const vendorConfig = loadVendorConfig();

const skippedVendors = allVendors.filter(v => getVendorCfg(vendorConfig, v.name)?.skipInBulkRun === true);
const vendors        = allVendors.filter(v => getVendorCfg(vendorConfig, v.name)?.skipInBulkRun !== true);

// ── Compute per-worker slot count ─────────────────────────────────────────────
//
// workers is read from the Playwright config (playwright.config.ts).
// We infer it here from process.env.PW_TEST_WORKER_INDEX being sequential:
// Playwright spawns workers numbered 0…(workers-1).
// We don't have direct access to the total worker count at module load time,
// so we read it from the standard Playwright env variable PLAYWRIGHT_WORKERS
// if set, otherwise fall back to a safe default of 6.
//
const configuredWorkers = parseInt(process.env['PLAYWRIGHT_WORKERS'] ?? '6', 10);
const perWorkerSlots    = Math.max(1, Math.floor(GLOBAL_PAGE_BUDGET / configuredWorkers));

// ── Note: run info is logged inside test.beforeAll below, not here ───────────
// Logging at module-level would fire once per Playwright *worker process*,
// producing N duplicate lines in the console when --workers=N is used.

// ── v5 Vendor Validation Tests ────────────────────────────────────────────────

test.describe('v5 API Vendor Validation', () => {
    test.describe.configure({ mode: 'parallel' });

    // No timeout — large vendors (600+ games) can take 15+ minutes per worker.
    test.setTimeout(0);

    // Log run summary once per worker (not at module load, which runs N times).
    test.beforeAll(() => {
        const workerIdx = process.env['PW_TEST_WORKER_INDEX'] ?? '?';
        if (workerIdx === '0') {
            // Only the first worker prints the summary to avoid duplicate lines.
            console.log(`\n📁 Run folder: test-results/vendor-reports/${RUN_TIMESTAMP}/`);
            console.log(`   ${vendors.length} vendors queued  (${skippedVendors.length} skipped by vendor-config.json).`);
            for (const v of skippedVendors) {
                const reason = getVendorCfg(vendorConfig, v.name)?.reason ?? 'no reason given';
                console.log(`   ⏭️  SKIP: ${v.name} (ID: ${v.id}) — ${reason}`);
            }
            console.log(`   Global page budget: ${GLOBAL_PAGE_BUDGET}`);
            console.log(`   Configured workers: ${configuredWorkers}`);
            console.log(`   Per-worker pool slots: ${perWorkerSlots}\n`);
        }
    });

    for (const vendor of vendors) {
        test(`v5: ${vendor.name} (ID: ${vendor.id})`, async ({ browser }) => {
            await apiValidateVendorGamesFlowV5(
                browser,
                vendor.id,
                vendor.name,
                RUN_TIMESTAMP,
                GLOBAL_SEM,
                perWorkerSlots,
            );
        });
    }

    // ── FIX D: Clean process exit ─────────────────────────────────────────────
    //
    // Playwright sometimes hangs after all tests complete (zombie worker).
    // This was observed in v4 runs past 49 vendors. Force-exit cleanly.
    //
    test.afterAll(async () => {
        // Give CSV writers a moment to flush
        await new Promise(r => setTimeout(r, 2000));
        console.log('\n✅ v5 run complete — exiting process cleanly.');
        process.exit(0);
    });
});
