import { Page } from '@playwright/test';
import { reAuthenticate } from '../helpers/authHelper';

export interface GameResult {
    gameName: string;
    status: 'Pass' | 'Fail';
    errorType: string;
}

/**
 * ─── ARCHITECTURE: API-FIRST APPROACH ────────────────────────────────────────
 *
 * When a user clicks a game card, the site calls a POST "game enter" API:
 *   Request:  { header: {...}, param: { game_id, back_url }, credential: { token, ... } }
 *   Response: { code: 1, info: { redirect_url: "https://...game-provider.io/..." } }
 *
 * We intercept this API call to capture the redirect_url, then navigate to it
 * directly for validation. This replaces all DOM/iframe-click logic and is used
 * for both discovery and testing in a single scroll pass.
 *
 * Validation rules:
 *  1. No redirect_url returned (API error / auth failure) → Fail
 *  2. redirect_url navigated, no iframe visible in 15s → Fail
 *  3. iframe appeared but visible error text on screen → Fail
 *  4. iframe appeared, no error text → Pass
 */
export async function validateVendorGamesFlow(
    page: Page,
    vendorId: number,
    vendorName: string
): Promise<void> {
    const VENDOR_URL = `/games?ven_id=${vendorId}`;

    console.log(`\n=== [${vendorName}] Starting validation (ven_id=${vendorId}) ===`);

    // ─── Phase 1: Discover game names + intercept game entry URLs ────────────
    // We navigate to the vendor page, scroll to trigger all lazy-loaded cards,
    // and collect game names. For each game click, we also intercept the API
    // response to capture redirect_urls upfront (one pass = discover + get URLs).
    await page.goto(VENDOR_URL);
    await page.waitForLoadState('networkidle');

    console.log(`[${vendorName}] Discovering games...`);

    // Collect game names by scrolling through the vendor page
    const gameNames: string[] = [];
    const seenNames = new Set<string>();
    let noNewStreak = 0;

    while (noNewStreak < 3) {
        const names: string[] = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLImageElement>('img[src*="game/"][loading="lazy"]'))
                .map(img => img.alt)
                .filter(alt => !!alt && alt !== 'Loading')
        );
        let addedNew = false;
        for (const name of names) {
            if (!seenNames.has(name)) {
                seenNames.add(name);
                gameNames.push(name);
                addedNew = true;
            }
        }
        noNewStreak = addedNew ? 0 : noNewStreak + 1;
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
        await page.waitForTimeout(1200);
    }

    await page.evaluate(() => window.scrollTo(0, 0));

    if (gameNames.length === 0) {
        console.warn(`[${vendorName}] WARNING: Discovered 0 games. Vendor may be inactive.`);
        return;
    }

    console.log(`[${vendorName}] Discovered ${gameNames.length} games. Starting validation...`);
    const results: GameResult[] = [];

    // ─── Phase 2: Test each game via API interception ─────────────────────────
    for (let i = 0; i < gameNames.length; i++) {
        const gameName = gameNames[i];
        console.log(`[${vendorName}] Testing [${i + 1}/${gameNames.length}]: ${gameName}`);

        // Ensure the game image is in view (needed if page.goto() reset scroll)
        await scrollUntilGameVisible(page, gameName);

        const result = await testSingleGame(page, gameName, VENDOR_URL);

        if (result.errorType === 'AUTH_FAILURE') {
            console.warn(`[${vendorName}] Token expired. Re-authenticating and retrying...`);
            await reAuthenticate(page);
            await page.goto(VENDOR_URL);
            await page.waitForLoadState('networkidle');
            results.push(await testSingleGame(page, gameName, VENDOR_URL));
        } else {
            results.push(result);
        }

        const latest = results[results.length - 1];
        console.log(`  → ${latest.status}${latest.status === 'Fail' ? ` (${latest.errorType})` : ''}`);
    }

    // ─── Output Markdown summary ───────────────────────────────────────────────
    const passed = results.filter(r => r.status === 'Pass').length;
    const failed = results.filter(r => r.status === 'Fail').length;
    console.log(`\n### [${vendorName}] Results: ${passed} passed, ${failed} failed out of ${results.length} games\n`);
    console.log('| Game Name | Status | Error Type |');
    console.log('|-----------|--------|------------|');
    for (const res of results) {
        console.log(`| ${res.gameName} | ${res.status} | ${res.errorType} |`);
    }
    console.log('\n');
}

/**
 * Tests a single game using API interception:
 *  1. Set up a response interceptor for the game "enter" API call
 *  2. Click the game card — this triggers the POST request
 *  3. Capture the redirect_url from the API response
 *  4. Navigate to the redirect_url directly
 *  5. Validate: iframe appeared + no error text on screen
 *  6. Return to vendor page
 */
async function testSingleGame(
    page: Page,
    gameName: string,
    vendorUrl: string
): Promise<GameResult> {
    // Track game-asset network errors (scoped to /game/ URLs to avoid false positives)
    let networkErrorDetected = false;
    const requestListener = (req: any) => {
        if (req.failure() && req.url().includes('/game/')) networkErrorDetected = true;
    };
    const responseListener = (res: any) => {
        if (res.status() >= 400 && res.url().includes('/game/')) networkErrorDetected = true;
    };
    page.on('requestfailed', requestListener);
    page.on('response', responseListener);

    let isStuck = false;
    let errorType = 'N/A';

    try {
        // Auth check: if login button visible, session has expired
        const loginButton = page.getByRole('banner').getByText('Login');
        if (await loginButton.isVisible({ timeout: 1500 }).catch(() => false)) {
            return { gameName, status: 'Fail', errorType: 'AUTH_FAILURE' };
        }

        // ── API INTERCEPTION: capture redirect_url from game "enter" API ───────
        // The site POSTs to a game entry endpoint when a card is clicked.
        // Response: { code: 1, info: { redirect_url: "https://..." } }
        // We race between: (a) API response captured, (b) 8s timeout
        let redirectUrl: string | null = null;

        const apiCapturePromise = page.waitForResponse(
            (res) => {
                // Match the game enter API — it returns JSON with "redirect_url"
                const url = res.url();
                return (
                    (url.includes('/game/enter') ||
                     url.includes('/api/game') ||
                     url.includes('/enter')) &&
                    res.request().method() === 'POST'
                );
            },
            { timeout: 8000 }
        ).then(async (res) => {
            try {
                const json = await res.json();
                redirectUrl = json?.info?.redirect_url ?? null;
            } catch {
                redirectUrl = null;
            }
        }).catch(() => { redirectUrl = null; });

        // Click the game card — triggers the API call
        const gameImg = page.getByRole('img', { name: gameName }).first();
        await gameImg.scrollIntoViewIfNeeded();

        // Also detect if the click opens a new tab (some vendors do this)
        const newTabPromise = page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
        await gameImg.click();
        const newTab = await newTabPromise;

        if (newTab) {
            // ── New tab path: game opened in a separate browser window ─────────
            page.off('requestfailed', requestListener);
            page.off('response', responseListener);

            await newTab.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            const tabUrl = newTab.url();

            if (tabUrl.includes('404') || tabUrl.includes('error')) {
                isStuck = true;
                errorType = '404 / Page Not Found (new tab)';
            } else {
                const hasIframe = await newTab.locator('iframe').first()
                    .isVisible({ timeout: 12000 }).catch(() => false);

                if (hasIframe) {
                    // Check for error text inside the new tab
                    const tabError = await newTab
                        .getByText(/network error|connection error|game unavailable|failed to load|access denied|error occurred/i)
                        .first().isVisible({ timeout: 500 }).catch(() => false);
                    isStuck = tabError;
                    errorType = tabError ? 'Error shown in new tab' : 'N/A';
                } else {
                    isStuck = true;
                    errorType = 'No iframe in new tab (12s timeout)';
                }
            }
            await newTab.close();
            return { gameName, status: isStuck ? 'Fail' : 'Pass', errorType: isStuck ? errorType : 'N/A' };
        }

        // Wait for API capture to complete (or timeout)
        await apiCapturePromise;

        if (redirectUrl) {
            // ── API path: navigate directly to the redirect_url ────────────────
            // This is fast and reliable — no DOM dependency, no scroll issues.
            await page.goto(redirectUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

            // Give the game page a moment before checking for errors
            await page.waitForTimeout(3000);

            // Check for visible error text — either on the game provider page or in any iframe
            const pageError = await page
                .getByText(/network error|connection error|game unavailable|failed to load|access denied|error occurred/i)
                .first().isVisible({ timeout: 500 }).catch(() => false);

            // Check if iframe appeared (primary success signal)
            const iframeFound = await page.locator('iframe').first()
                .isVisible({ timeout: 12000 }).catch(() => false);

            if (!iframeFound) {
                isStuck = true;
                errorType = networkErrorDetected
                    ? '404/500 Network Error'
                    : 'No game content — blank/black screen (12s)';
            } else if (pageError || networkErrorDetected) {
                isStuck = true;
                errorType = '404/500 Network Error (shown on screen)';
            } else {
                isStuck = false;
            }

            // Go back to vendor page after testing
            await page.goto(vendorUrl, { waitUntil: 'networkidle', timeout: 15000 }).catch(async () => {
                await page.goto(vendorUrl);
                await page.waitForLoadState('networkidle');
            });

        } else {
            // ── Fallback: API not captured — validate via iframe on current page ──
            // Happens when the game endpoint URL pattern doesn't match our filter,
            // or when the game rendered directly on the page without a separate redirect.

            const siteLoader = page.getByText('Loading game...');
            if (await siteLoader.isVisible({ timeout: 2000 }).catch(() => false)) {
                await siteLoader.waitFor({ state: 'hidden', timeout: 12000 }).catch(() => {});
            }

            const outerIframe = page.locator('iframe').first();
            const iframeAppeared = await outerIframe.isVisible({ timeout: 15000 }).catch(() => false);

            if (!iframeAppeared) {
                isStuck = true;
                errorType = networkErrorDetected
                    ? '404/500 Network Error'
                    : 'No iframe — blank/black screen (15s)';
            } else {
                await page.waitForTimeout(3000);

                const pageError = await page
                    .getByText(/network error|connection error|game unavailable|failed to load|access denied|error occurred/i)
                    .first().isVisible({ timeout: 500 }).catch(() => false);

                const frameError = await outerIframe.contentFrame()
                    .getByText(/network error|connection error|game unavailable|failed to load|access denied|error occurred/i)
                    .first().isVisible({ timeout: 500 }).catch(() => false);

                if (pageError || frameError || networkErrorDetected) {
                    isStuck = true;
                    errorType = '404/500 Network Error (shown on screen)';
                } else {
                    isStuck = false;
                }
            }

            // Return to vendor page
            try {
                const urlBefore = page.url();
                await page.goBack({ timeout: 5000 }).catch(() => {});
                const urlAfter = page.url();

                if (!urlAfter.includes('ven_id=')) {
                    await page.goto(vendorUrl);
                    await page.waitForLoadState('networkidle');
                } else if (urlAfter === urlBefore) {
                    const closeBtn = page.locator('[aria-label="back"], [aria-label="close"]').first();
                    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                        await closeBtn.click();
                        await page.waitForTimeout(500);
                    } else {
                        await page.goto(vendorUrl);
                        await page.waitForLoadState('networkidle');
                    }
                }
            } catch {
                await page.goto(vendorUrl).catch(() => {});
                await page.waitForLoadState('networkidle').catch(() => {});
            }
        }
    } catch (e: any) {
        isStuck = true;
        errorType = `Unexpected error: ${(e?.message ?? '').split('\n')[0]}`;
    } finally {
        page.off('requestfailed', requestListener);
        page.off('response', responseListener);
    }

    return {
        gameName,
        status: isStuck ? 'Fail' : 'Pass',
        errorType: isStuck ? errorType : 'N/A',
    };
}

/**
 * Scrolls the vendor page until the target game image enters the DOM.
 * Fast path: already visible (bfcache preserved scroll) — returns immediately.
 * Slow path: after page.goto() reset scroll to top, scroll down step by step.
 */
async function scrollUntilGameVisible(page: Page, gameName: string): Promise<void> {
    const gameImg = page.getByRole('img', { name: gameName }).first();

    const alreadyVisible = await gameImg.isVisible({ timeout: 1000 }).catch(() => false);
    if (alreadyVisible) return;

    const MAX_SCROLLS = 30;
    for (let step = 0; step < MAX_SCROLLS; step++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await page.waitForTimeout(800);
        const nowVisible = await gameImg.isVisible({ timeout: 500 }).catch(() => false);
        if (nowVisible) {
            await gameImg.scrollIntoViewIfNeeded();
            return;
        }
    }

    await gameImg.scrollIntoViewIfNeeded().catch(() => {});
}
