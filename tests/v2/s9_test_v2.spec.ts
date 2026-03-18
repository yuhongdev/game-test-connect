/**
 * s9_test_v2.spec.ts — v2 test runner: fully concurrent game validation.
 *
 * Architecture vs v1 (s9_test.spec.ts):
 *
 *  v1: 1 browser page per vendor — games loop sequentially within the page.
 *
 *  v2: games run with a semaphore-based concurrent queue (no fixed batches).
 *      Up to MAX_CONCURRENT_GAMES games run simultaneously per vendor worker.
 *      As soon as one game finishes, the next starts — zero inter-batch idle time.
 *
 * ── Vendor list ────────────────────────────────────────────────────────────────
 *  Vendor list is loaded DYNAMICALLY from playwright/.auth/vendors.json.
 *  This file is written by globalSetup.ts (runs once before test collection)
 *  which calls the live game-vendor/list API.
 *
 *  To exclude a specific vendor, add its ID to EXCLUDED_VENDOR_IDS in globalSetup.ts.
 *  Do NOT hardcode vendor IDs here.
 *
 * ── Memory usage ──────────────────────────────────────────────────────────────
 *  Each browser page uses ~200MB.
 *  At 14 workers × 6 games = 84 pages → ~16.8GB peak.
 *  Safe for machines with 32GB RAM.
 *
 * ── Run commands ──────────────────────────────────────────────────────────────
 *  All vendors:
 *    npx playwright test tests/v2/ --project=chromium --workers=14
 *
 *  Single vendor (debugging) — ALWAYS include --project=chromium:
 *    npx playwright test tests/v2/ --project=chromium -g "v2: Amusnet" --workers=1 --headed
 *
 *  ⚠️  Without --project=chromium, Playwright runs the test through all 3 browser
 *  projects (chromium + firefox + webkit), which causes 3 full runs of the vendor.
 *
 *  View report:
 *    npx playwright show-report
 */

import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { apiValidateVendorGamesFlowV2 } from './apiValidationFlowV2';

// ── Dynamic vendor list ───────────────────────────────────────────────────────
//
// vendors.json is written by globalSetup.ts before test collection begins.
// We read it synchronously here because test.describe() callbacks are sync.
// If the file doesn't exist (e.g. setup hasn't run), we fail with a clear message.
// ─────────────────────────────────────────────────────────────────────────────

const VENDORS_FILE = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'vendors.json');

function loadVendors(): Array<{ id: number; name: string }> {
    if (!fs.existsSync(VENDORS_FILE)) {
        throw new Error(
            `vendors.json not found at ${VENDORS_FILE}.\n` +
            `Run auth setup first: npx playwright test --project=setup\n` +
            `Then retry: npx playwright test tests/v2/ --project=chromium`
        );
    }
    const raw = fs.readFileSync(VENDORS_FILE, 'utf8');
    return JSON.parse(raw) as Array<{ id: number; name: string }>;
}

const vendors = loadVendors();

// ─────────────────────────────────────────────────────────────────────────────
// Global setup: auto-dismiss version update banners
//
// s9.com occasionally shows a "Version update available" overlay on the root
// page context. Per-game contexts are short-lived (< 11s) and unlikely to
// encounter the banner.
// ─────────────────────────────────────────────────────────────────────────────
test.beforeEach(async ({ page }) => {
    await page.addLocatorHandler(
        page.getByText('Version update available, please refresh the page'),
        async () => {
            await page.getByRole('button', { name: 'Refresh' }).click();
        }
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// v2 API Vendor Validation Tests
//
// One Playwright test per vendor — vendors run in parallel across workers.
// Within each vendor test, games run concurrently via semaphore queue.
//
// ⚠️  Always include --project=chromium when running a single vendor.
//     Without it, Playwright runs through chromium + firefox + webkit (3× runs).
//
// Run all vendors:     npx playwright test tests/v2/ --project=chromium --workers=14
// Run single vendor:   npx playwright test tests/v2/ --project=chromium -g "v2: Amusnet"
// ─────────────────────────────────────────────────────────────────────────────
test.describe('v2 API Vendor Validation', () => {
    // Vendors are distributed across Playwright workers (vendor-level parallelism)
    test.describe.configure({ mode: 'parallel' });

    // No timeout — Amusnet has 161 games; at 6 concurrent × 7s ≈ ~3 min per vendor
    test.setTimeout(0);

    for (const vendor of vendors) {
        // Test name prefixed with "v2:" to distinguish from v1 tests in the report
        test(`v2: ${vendor.name} (ID: ${vendor.id})`, async ({ browser }) => {
            await apiValidateVendorGamesFlowV2(browser, vendor.id, vendor.name);
        });
    }
});
