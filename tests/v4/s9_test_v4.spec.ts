/**
 * s9_test_v4.spec.ts — v4 test runner: memory-safe concurrent game validation.
 *
 * ── Per-run datetime folder ───────────────────────────────────────────────────
 *
 *  RUN_TIMESTAMP is computed ONCE when this module loads (before any test runs).
 *  It is passed into every vendor call so all 53 vendors from this run share
 *  the same output folder:
 *
 *    test-results/vendor-reports/
 *        2026-03-19T08-24-15/           ← all vendors from this run
 *            Amusnet_2026-03-19T08-24-15.csv
 *            PG_Soft_2026-03-19T08-24-15.csv
 *            ...
 *        2026-03-20T09-00-00/           ← all vendors from next run
 *            ...
 *
 *  This makes it trivial to:
 *    - Know which CSV files belong to the same run
 *    - Pass a single folder to generateReport.ts for a single-run report
 *    - Diff two runs by pointing diffRuns.ts at two dated folders
 *
 * ── Run commands ──────────────────────────────────────────────────────────────
 *
 *  All vendors:
 *    npx playwright test tests/v4/ --project=chromium --workers=6
 *
 *  Single vendor — headless:
 *    npx playwright test tests/v4/ --project=chromium -g "v4: Amusnet"
 *
 *  Single vendor — headed (see browser):
 *    npx playwright test tests/v4/ --project=chromium -g "v4: Amusnet" --workers=1 --headed
 *
 *  ⚠️  Always include --project=chromium.
 *      Without it: chromium + firefox + webkit = 3× the runs.
 *
 *  View HTML report:
 *    npx playwright show-report
 *
 * ── Generate the dashboard after a run ───────────────────────────────────────
 *
 *  Report for the latest run folder only:
 *    npx ts-node tests/reports/generateReport.ts --latest
 *
 *  Report across ALL runs (full history):
 *    npx ts-node tests/reports/generateReport.ts
 *
 *  Diff the two most recent runs:
 *    npx ts-node tests/reports/diffRuns.ts --latest
 *
 *  Open reports:
 *    start test-results\report.html
 *    start test-results\diff.html
 *
 * ── Tuning (edit apiValidationFlowV4.ts) ─────────────────────────────────────
 *
 *  MAX_CONCURRENT_GAMES = Math.floor(GLOBAL_PAGE_BUDGET / workers)
 *    workers=6, budget=20 → 3 per vendor  ← recommended safe start
 *    workers=6, budget=24 → 4 per vendor  ← slightly more throughput
 */

import { test } from '@playwright/test';
import * as fs   from 'fs';
import * as path from 'path';
import { apiValidateVendorGamesFlowV4 } from './apiValidationFlowV4';

// ── Shared run timestamp ──────────────────────────────────────────────────────
//
// Computed ONCE at module load time — before any test starts.
// All vendor tests in this Playwright run share this timestamp, so their CSVs
// land in the same dated subfolder under test-results/vendor-reports/.
//
// Format: "2026-03-19T08-24-15"  (colons replaced with dashes, filesystem-safe)
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── Dynamic vendor list ───────────────────────────────────────────────────────

const VENDORS_FILE = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'vendors.json');

function loadVendors(): Array<{ id: number; name: string }> {
    if (!fs.existsSync(VENDORS_FILE)) {
        throw new Error(
            `vendors.json not found at ${VENDORS_FILE}.\n` +
            `Run auth setup first: npx playwright test --project=setup\n` +
            `Then retry: npx playwright test tests/v4/ --project=chromium`
        );
    }
    return JSON.parse(fs.readFileSync(VENDORS_FILE, 'utf8')) as Array<{ id: number; name: string }>;
}

const vendors = loadVendors();

// Log the run folder so the user knows where CSVs will be saved
console.log(`\n📁 Run folder: test-results/vendor-reports/${RUN_TIMESTAMP}/`);
console.log(`   ${vendors.length} vendors queued.\n`);

// ── v4 Vendor Validation Tests ────────────────────────────────────────────────

test.describe('v4 API Vendor Validation', () => {
    test.describe.configure({ mode: 'parallel' });

    // No timeout — large vendors (600+ games) can take 15+ minutes per worker.
    test.setTimeout(0);

    for (const vendor of vendors) {
        test(`v4: ${vendor.name} (ID: ${vendor.id})`, async ({ browser }) => {
            await apiValidateVendorGamesFlowV4(browser, vendor.id, vendor.name, RUN_TIMESTAMP);
        });
    }
});