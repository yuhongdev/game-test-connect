/**
 * s9_test.spec.ts — Main Playwright test entry point for s9.com game validation.
 *
 * This file is the top-level test runner. It wires together the page models, flow
 * helpers, and vendor data into executable Playwright tests.
 *
 * ── Test Suites ───────────────────────────────────────────────────────────────
 *
 *  1. "Verify session and Logout"
 *     Quick sanity check: confirms the stored auth state is valid by verifying
 *     the avatar is visible, then logs out cleanly.
 *
 *  2. "Vendor Game Validation" (legacy DOM-based, kept for reference)
 *     Original approach: navigates the s9.com frontend, scrolls game cards,
 *     clicks each one, and validates the resulting iframe. Slower and more
 *     brittle due to lazy-loading and DOM timing. Preserved in case DOM-specific
 *     checks are needed.
 *
 *  3. "API Vendor Validation" ← RECOMMENDED
 *     API-first approach: fetches the game list directly from the backend API,
 *     then calls game/enter for each game to get a redirect_url, and validates
 *     the game by embedding it in an iframe on the live https://s9.com page.
 *     Much faster, zero DOM scrolling, fully parallel across vendors.
 *
 * ── How to Run ────────────────────────────────────────────────────────────────
 *
 *  All 50 vendors (recommended, 8 workers in parallel):
 *    npx playwright test tests/s9_test.spec.ts -g "API Validate:" --project=chromium
 *
 *  One specific vendor:
 *    npx playwright test tests/s9_test.spec.ts -g "API Validate: Amusnet"
 *
 *  Open HTML report after run:
 *    npx playwright show-report
 *
 * ── Parallelism ───────────────────────────────────────────────────────────────
 *
 *  Workers are configured in playwright.config.ts (currently 8 for local, 1 for CI).
 *  test.describe.configure({ mode: 'parallel' }) ensures vendor tests run concurrently.
 *  Within each vendor test, games are validated sequentially to avoid rate limiting.
 */

import { test, expect } from '@playwright/test';
import { LoginPage } from './models/LoginPage';
import { validateVendorGamesFlow } from './flows/vendorValidationFlow';
import { apiValidateVendorGamesFlow } from './flows/apiValidationFlow';

// ─────────────────────────────────────────────────────────────────────────────
// Global Setup: Auto-dismiss version update banners
//
// s9.com occasionally shows a "Version update available, please refresh"
// overlay during tests. This handler intercepts it automatically for every
// test so it doesn't block game card clicks or iframe loading.
// ─────────────────────────────────────────────────────────────────────────────
test.beforeEach(async ({ page }) => {
    await page.addLocatorHandler(
        page.getByText('Version update available, please refresh the page'),
        async () => {
            console.log('Update banner detected — dismissing...');
            await page.getByRole('button', { name: 'Refresh' }).click();
        }
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test: Verify session and Logout
//
// Validates that the stored authentication state (playwright/.auth/user.json)
// is still valid by checking that the user avatar is visible immediately after
// navigating to the homepage. Then performs a clean logout.
//
// Run: npx playwright test -g "Verify session"
// ─────────────────────────────────────────────────────────────────────────────
test('Verify session and Logout', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await expect(loginPage.avatarImg).toBeVisible();
    await loginPage.logout();
});

// ─────────────────────────────────────────────────────────────────────────────
// Vendor Game Validation Tests (Legacy DOM-based approach)
//
// This approach navigates the actual s9.com frontend:
//   1. Opens the vendor's game list page
//   2. Scrolls to discover game cards lazily loaded by the frontend
//   3. Clicks each game card and waits for the iframe to appear
//   4. Checks for error messages and connection stability
//
// ⚠️  Slower than the API approach (DOM scroll delays, lazy loading timeouts).
//    Kept for reference and for validating frontend-specific behaviour.
//
// Run: npx playwright test -g "Validate games: Amusnet"
// ─────────────────────────────────────────────────────────────────────────────
test.describe('Vendor Game Validation', () => {
    // Each vendor runs in its own parallel worker.
    // Within a vendor, games are validated one at a time (sequential).
    test.describe.configure({ mode: 'parallel' });

    // No timeout — some vendors have 100+ games, each taking 10-15s.
    // A per-vendor run of 161 games × 12s ≈ 32 minutes.
    test.setTimeout(0);

    // ── Vendor list ────────────────────────────────────────────────────────
    // Each entry maps to a vendor page: https://s9.com/games?ven_id=<id>
    // IDs and names sourced from the game-vendor/list API (captured_api.json).
    const vendors = [
        { id: 600034, name: 'Micro Gaming' },
        { id: 600022, name: 'Bgaming' },
        { id: 600023, name: 'Booming' },
        { id: 600024, name: 'Spinomenal' },
        { id: 600025, name: 'Turbo Games' },
        { id: 600026, name: 'Habanero' },
        { id: 600027, name: 'Hacksaw' },
        { id: 600028, name: 'Inout' },
        { id: 600029, name: 'JDB' },
        { id: 600030, name: 'GTF' },
        { id: 600031, name: 'Jili' },
        { id: 600032, name: 'Live22' },
        { id: 600033, name: 'Lite' },
        { id: 600021, name: '7mojo' },
        { id: 600035, name: 'PG Soft' },
        { id: 600036, name: 'PlayNGo' },
        { id: 600037, name: 'Pragmatic Play' },
        { id: 600038, name: 'KingMidas' },
        { id: 600039, name: 'Relax Gaming' },
        { id: 600040, name: 'Spribe' },
        { id: 600041, name: 'Spade Gaming' },
        { id: 600042, name: 'The Better Platform' },
        { id: 600043, name: 'Winfinity' },
        { id: 600044, name: 'YeeBet' },
        { id: 600045, name: 'YellowBat' },
        { id: 700001, name: 'Betby (LG)' },
        { id: 600009, name: 'BNG' },
        { id: 200001, name: 'LUCKOAI' },
        { id: 300001, name: 'GL' },
        { id: 400001, name: 'BETBY' },
        { id: 500001, name: 'DBLIVE' },
        { id: 600001, name: 'AA Sexy' },
        { id: 600002, name: 'Alize Slots' },
        { id: 600003, name: 'Alize Mini' },
        { id: 600004, name: 'Askmeslot' },
        { id: 600005, name: 'Amusnet' },
        { id: 600006, name: 'AdvantPlay' },
        { id: 600007, name: 'Aviatrix' },
        { id: 600008, name: 'Live88' },
        { id: 100001, name: 'ORANGE' },
        { id: 600010, name: 'CQ9' },
        { id: 600011, name: 'DB Slots' },
        { id: 600012, name: 'Big Time Gaming' },
        { id: 600013, name: 'Evolution Live' },
        { id: 600014, name: 'NoLimit City' },
        { id: 600015, name: 'Netent' },
        { id: 600016, name: 'Evoplay' },
        { id: 600017, name: 'Red Tiger' },
        { id: 600018, name: 'EpicWin' },
        { id: 600019, name: 'Ezugi' },
        { id: 600020, name: 'FaChai' },
    ];

    // Dynamically create one test per vendor so Playwright can schedule them
    // across workers and report pass/fail per vendor individually.
    for (const vendor of vendors) {
        test(`Validate games: ${vendor.name} (ID: ${vendor.id})`, async ({ page }) => {
            await validateVendorGamesFlow(page, vendor.id, vendor.name);
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// API Vendor Validation Tests ⭐ RECOMMENDED
//
// API-first approach — no DOM scrolling or card clicking:
//   1. Read credential from playwright/.auth/credential.json (saved by auth setup)
//   2. Call game/list API directly → get all game IDs for the vendor at once
//   3. For each game: call game/enter API → receive redirect_url
//   4. Navigate to https://s9.com/games (HTTPS parent!) and inject an iframe
//      with the redirect_url — exactly how s9.com renders games in the browser
//   5. Run 4-gate validation (see apiValidationFlow.ts for full details)
//
// ── Advantages over DOM approach ─────────────────────────────────────────────
//  • No lazy-loading delays — all games discovered instantly via API
//  • HTTPS parent page prevents "Insecure Connection" warnings (e.g. PG Soft)
//  • Zero flakiness from DOM timing, scroll position, or banner overlays
//  • Pure API calls are fast: game list for 161 Amusnet games takes ~80ms
//
// ── Run commands ──────────────────────────────────────────────────────────────
//  All 50 vendors (8 parallel workers):
//    npx playwright test tests/s9_test.spec.ts -g "API Validate:" --project=chromium
//
//  Single vendor for debugging:
//    npx playwright test tests/s9_test.spec.ts -g "API Validate: PG Soft" --headed
//
//  View results:
//    npx playwright show-report
// ─────────────────────────────────────────────────────────────────────────────
test.describe('API Vendor Validation', () => {
    // Run all vendor tests in parallel — each gets its own browser page.
    // Safe to parallelise because: credential.json is read-only,
    // game/enter API is per-user (no shared state), and each page is isolated.
    test.describe.configure({ mode: 'parallel' });

    // No timeout — vendors range from 5 games (fast) to 161 games (Amusnet, ~32min).
    test.setTimeout(0);

    // ── Vendor list ────────────────────────────────────────────────────────
    // Sourced from game-vendor/list API (status=1 = active).
    // AdvantPlay (600006, status=2) is commented out — it is disabled on the platform.
    // Add new vendors here as they are onboarded.
    const vendors = [
        { id: 100001, name: 'ORANGE' },
        { id: 200001, name: 'LUCKOAI' },
        { id: 300001, name: 'GL' },
        { id: 400001, name: 'BETBY' },
        { id: 500001, name: 'DBLIVE' },
        { id: 600001, name: 'AA Sexy' },
        { id: 600002, name: 'Alize Slots' },
        { id: 600003, name: 'Alize Mini' },
        { id: 600004, name: 'Askmeslot' },
        { id: 600005, name: 'Amusnet' },
        // { id: 600006, name: 'AdvantPlay' },  // status=2, disabled on platform
        { id: 600007, name: 'Aviatrix' },
        { id: 600008, name: 'Live88' },
        { id: 600009, name: 'BNG' },
        { id: 600010, name: 'CQ9' },
        { id: 600011, name: 'DB Slots' },
        { id: 600012, name: 'Big Time Gaming' },
        { id: 600013, name: 'Evolution Live' },
        { id: 600014, name: 'NoLimit City' },
        { id: 600015, name: 'Netent' },
        { id: 600016, name: 'Evoplay' },
        { id: 600017, name: 'Red Tiger' },
        { id: 600018, name: 'EpicWin' },
        { id: 600019, name: 'Ezugi' },
        { id: 600020, name: 'FaChai' },
        { id: 600021, name: '7mojo' },
        { id: 600022, name: 'Bgaming' },
        { id: 600023, name: 'Booming' },
        { id: 600024, name: 'Spinomenal' },
        { id: 600025, name: 'Turbo Games' },
        { id: 600026, name: 'Habanero' },
        { id: 600027, name: 'Hacksaw' },
        { id: 600028, name: 'Inout' },
        { id: 600029, name: 'JDB' },
        { id: 600030, name: 'GTF' },
        { id: 600031, name: 'Jili' },
        { id: 600032, name: 'Live22' },
        { id: 600033, name: 'Lite' },
        { id: 600034, name: 'Micro Gaming' },
        { id: 600035, name: 'PG Soft' },
        { id: 600036, name: 'PlayNGo' },
        { id: 600037, name: 'Pragmatic Play' },
        { id: 600038, name: 'KingMidas' },
        { id: 600039, name: 'Relax Gaming' },
        { id: 600040, name: 'Spribe' },
        { id: 600041, name: 'Spade Gaming' },
        { id: 600042, name: 'The Better Platform' },
        { id: 600043, name: 'Winfinity' },
        { id: 600044, name: 'YeeBet' },
        { id: 600045, name: 'YellowBat' },
        { id: 700001, name: 'Betby' },
    ];

    // One Playwright test per vendor. Playwright schedules them across workers
    // automatically. The test name includes the vendor ID for easy grepping.
    for (const vendor of vendors) {
        test(`API Validate: ${vendor.name} (ID: ${vendor.id})`, async ({ page }) => {
            await apiValidateVendorGamesFlow(page, vendor.id, vendor.name);
        });
    }
});