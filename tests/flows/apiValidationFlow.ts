/**
 * apiValidationFlow.ts — API-first game connection validation flow.
 *
 * This is the core of the testing strategy. For each vendor, it:
 *  1. Fetches the complete game list via direct API call (no browser DOM)
 *  2. For each game, calls game/enter to get a redirect_url session URL
 *  3. Embeds that URL in an iframe on the live https://s9.com page
 *  4. Runs 4 sequential validation gates to classify the game as Pass or Fail
 *
 * ── Why iframe on s9.com instead of a local page? ────────────────────────────
 * Many game providers (e.g. PG Soft) check window.parent.location.protocol.
 * If the parent frame is NOT served over HTTPS, they show an "Insecure Connection"
 * warning and refuse to load. Using page.setContent() creates an about:blank
 * parent (not HTTPS) which triggers this. By navigating to the real https://s9.com
 * page first and then injecting the iframe via page.evaluate(), the parent page
 * is genuinely HTTPS — exactly as it would be for a real user.
 *
 * ── 4-Gate Validation System ─────────────────────────────────────────────────
 *
 *  Gate 1 — API Entry
 *    Call game/enter. Must return code=1 and a redirect_url.
 *    Failure: "API Error", "AUTH_FAILURE"
 *
 *  Gate 2 — iframe Load
 *    Inject redirect_url into iframe on https://s9.com.
 *    Wait up to 15s for the iframe body to attach to the DOM.
 *    Failure: "HTTP Error (404/502/...)", "Connection Failed"
 *
 *  Gate 3 — Immediate Error Text
 *    Wait 3s for the loading screen to pass, then scan for visible error messages.
 *    Failure: "Game Error: <matched text>"
 *
 *  Gate 4 — Stability (8s watch)
 *    Watch for 8 more seconds — some games load their UI then hit a server error.
 *    Also checks that the iframe body has at least one visible element (not blank).
 *    Failure: "Unstable: <matched text>", "Blank Screen"
 *
 *  Pass: game has content and no errors after the full 11s window.
 */

import { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { getGameList, enterGame, S9Credential, GameInfo } from '../api/s9ApiClient';

// ── Types ────────────────────────────────────────────────────────────────────

export type GameStatus = 'Pass' | 'Fail';

/** Result record for a single game validation. */
export interface GameResult {
    gameId: number;
    gameName: string;
    status: GameStatus;
    /** Which gate the game failed at (1–4). 0 means Pass. */
    gate: number;
    /** Human-readable error description (empty for Pass). */
    errorLabel: string;
}

// ── Error text detection ─────────────────────────────────────────────────────

/**
 * Regex pattern for visible error messages inside the game iframe.
 *
 * This covers:
 *  - Generic server/connection errors ("An error occurred while trying to connect")
 *  - PG Soft's HTTPS warning ("Warning: Insecure Connection")
 *  - Network-related failures ("Network Error", "Failed to load")
 *  - Auth/session issues ("Session expired", "Unauthorized")
 *
 * Case-insensitive so it catches any capitalisation ("Error Occurred", "ERROR OCCURRED").
 * When adding new patterns, use shorter fragments — "server error" matches
 * "A server error occurred", "Internal server error", etc.
 */
const ERROR_TEXT_PATTERN =
    /error occurred|network error|connection error|failed to load|cannot connect|server error|access denied|game unavailable|please try again|session expired|unauthorized|service unavailable|insecure connection/i;

// ── Credential loading ───────────────────────────────────────────────────────

/**
 * Path to the credential file saved by auth.setup.ts after login.
 * Stored outside the tests/ folder so it persists across test runs.
 */
const CRED_FILE = path.join(__dirname, '..', '..', 'playwright', '.auth', 'credential.json');

/**
 * Loads the API credential from disk.
 * Throws a helpful error if auth setup hasn't been run yet.
 */
function loadCredential(): S9Credential {
    if (!fs.existsSync(CRED_FILE)) {
        throw new Error(
            `credential.json not found at ${CRED_FILE}.\n` +
            `Run the auth setup first: npx playwright test --project=setup`
        );
    }
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) as S9Credential;
}

// ── Main exported flow ───────────────────────────────────────────────────────

/**
 * Validates all games for a single vendor using the API-first approach.
 *
 * This is called by the test runner (s9_test.spec.ts) once per Playwright test.
 * Since each vendor runs in its own test, multiple vendors can run simultaneously
 * (controlled by the workers setting in playwright.config.ts).
 *
 * @param page       Playwright Page object (one per worker, isolated)
 * @param vendorId   The ven_id of the vendor to test (e.g. 600005 for Amusnet)
 * @param vendorName Display name for logging (e.g. "Amusnet")
 */
export async function apiValidateVendorGamesFlow(
    page: Page,
    vendorId: number,
    vendorName: string
): Promise<void> {
    const credential = loadCredential();

    console.log(`\n=== [${vendorName}] API validation starting (ven_id=${vendorId}) ===`);

    // ── Step 1: Fetch game list via API ───────────────────────────────────────
    // No browser needed here — pure HTTP call returns all games in ~80ms.
    // getGameList() handles pagination automatically.
    let games: GameInfo[];
    try {
        games = await getGameList(credential, vendorId);
    } catch (e: any) {
        console.error(`[${vendorName}] Failed to fetch game list: ${e.message}`);
        return;
    }

    if (games.length === 0) {
        console.warn(`[${vendorName}] No active games found via API.`);
        return;
    }
    console.log(`[${vendorName}] ${games.length} active games to test.`);

    // ── Step 2: Validate each game sequentially ───────────────────────────────
    // Sequential (not parallel) within a vendor to avoid rate-limiting the
    // game/enter API. The parallelism happens at the vendor level across workers.
    const results: GameResult[] = [];

    for (let i = 0; i < games.length; i++) {
        const game = games[i];
        console.log(`[${vendorName}] [${i + 1}/${games.length}] ${game.name} (id=${game.game_id})`);

        const result = await validateSingleGame(page, credential, game, vendorId);
        results.push(result);

        // Inline result logging for real-time monitoring during a run
        const detail = result.status === 'Fail' ? ` | Gate ${result.gate}: ${result.errorLabel}` : '';
        console.log(`  → ${result.status}${detail}`);
    }

    // ── Step 3: Print final summary table ─────────────────────────────────────
    // This appears in the Playwright HTML report under the test's console output.
    const passed = results.filter(r => r.status === 'Pass').length;
    const failed = results.filter(r => r.status === 'Fail').length;
    console.log(`\n### [${vendorName}] Summary: ${passed} passed, ${failed} failed / ${results.length} total\n`);
    console.log('| Game | Status | Gate | Error |');
    console.log('|------|--------|------|-------|');
    for (const r of results) {
        console.log(`| ${r.gameName} | ${r.status} | ${r.gate || '-'} | ${r.errorLabel || '-'} |`);
    }
}

// ── Single game validation (4 gates) ────────────────────────────────────────

/**
 * Validates a single game through 4 sequential quality gates.
 * Returns immediately at the first gate that fails.
 *
 * @param page       Playwright Page (reused across games for the same vendor)
 * @param credential API credential for game/enter calls
 * @param game       Game metadata from the game/list API
 * @param vendorId   Used to construct the back_url and parent page URL
 */
async function validateSingleGame(
    page: Page,
    credential: S9Credential,
    game: GameInfo,
    vendorId: number,
): Promise<GameResult> {
    // Shorthand helpers to create result objects cleanly
    const pass = (): GameResult => ({
        gameId: game.game_id, gameName: game.name, status: 'Pass', gate: 0, errorLabel: ''
    });
    const fail = (gate: number, label: string): GameResult => ({
        gameId: game.game_id, gameName: game.name, status: 'Fail', gate, errorLabel: label
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GATE 1: API Entry
    //
    // Purpose: Verify that the platform can successfully create a game session.
    // A failure here means the game is not launchable at all — wrong game_id,
    // expired token, backend misconfiguration, etc.
    //
    // The game/enter API returns:
    //   { code: 1, info: { redirect_url: "https://..." } }  → success
    //   { code: 0, msg: "Token expired" }                   → auth failure
    //   { code: 0, msg: "Game not found" }                  → config error
    // ─────────────────────────────────────────────────────────────────────────
    let redirectUrl: string;
    try {
        const enterResult = await enterGame(credential, game.game_id, vendorId);

        if (enterResult.code !== 1 || !enterResult.redirect_url) {
            // Distinguish auth failures so the operator knows to re-run auth setup
            const isAuthFailure =
                enterResult.msg?.toLowerCase().includes('token') ||
                enterResult.msg?.toLowerCase().includes('login') ||
                enterResult.code === 401;

            if (isAuthFailure) {
                return fail(1, `AUTH_FAILURE: ${enterResult.msg} (re-run: npx playwright test --project=setup)`);
            }
            return fail(1, `API Error (code=${enterResult.code}): ${enterResult.msg || 'no redirect_url returned'}`);
        }

        redirectUrl = enterResult.redirect_url;
    } catch (e: any) {
        // Network-level failure (DNS, timeout, server down)
        return fail(1, `API call failed: ${e.message.slice(0, 80)}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GATE 2: iframe Load
    //
    // Purpose: Verify that the game provider's server is reachable and the
    // game URL loads in an iframe.
    //
    // HTTPS Parent Fix:
    //   Some providers (e.g. PG Soft) check window.parent.location.protocol.
    //   If the parent is not HTTPS, they show "Warning: Insecure Connection".
    //   We navigate to the live https://s9.com/games page first, then inject
    //   our iframe into the live page body via page.evaluate(). This keeps the
    //   parent URL as https://s9.com/... — passing all HTTPS checks.
    //
    // We detect HTTP-level errors (404, 502, etc.) via response listener,
    // because the iframe itself may not visually render an error for all codes.
    // ─────────────────────────────────────────────────────────────────────────
    let iframeLoaded = false;
    let iframeHttpError: number | null = null;

    try {
        // Listen for error responses from the game provider's domain
        const errorHandler = (res: any) => {
            if (res.url() === redirectUrl && res.status() >= 400) {
                iframeHttpError = res.status();
            }
        };
        page.on('response', errorHandler);

        // Ensure we're on an HTTPS s9.com page before injecting (see above)
        const parentUrl = `https://s9.com/games?ven_id=${vendorId}`;
        if (!page.url().startsWith('https://s9.com')) {
            // First game in this vendor run: navigate to the vendor page.
            // For subsequent games, the page is already on s9.com — just re-inject.
            await page.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        }

        // Replace the entire page body with just our iframe.
        // The page URL stays https://s9.com/games?ven_id=... throughout.
        await page.evaluate((src: string) => {
            document.body.innerHTML = `
                <iframe
                    id="gameframe"
                    src="${src}"
                    style="width:100vw;height:100vh;border:none;display:block"
                    allowfullscreen
                    allow="autoplay; fullscreen; camera; microphone; accelerometer; gyroscope"
                ></iframe>`;
        }, redirectUrl);

        // Wait for the iframe's document body to appear in the DOM.
        // 15s is generous — most games connect within 3–5s.
        const gameFrame = page.frameLocator('#gameframe');
        iframeLoaded = await gameFrame.locator('body')
            .waitFor({ state: 'attached', timeout: 15000 })
            .then(() => true)
            .catch(() => false);

        page.off('response', errorHandler); // Clean up listener
    } catch (e: any) {
        return fail(2, `Connection Failed: ${e.message.slice(0, 80)}`);
    }

    if (!iframeLoaded) {
        // Prioritise the HTTP error code if we captured one — more specific
        if (iframeHttpError) return fail(2, `HTTP Error (${iframeHttpError})`);
        return fail(2, 'iframe did not load in 15s (Connection Failed)');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GATE 3: Immediate Error Text Scan
    //
    // Purpose: Catch games that load their iframe but immediately show an error.
    // Example: "An error occurred while trying to connect to server."
    //
    // We wait 3 seconds first to let the initial loading spinner clear.
    // Without this wait, we might scan the page while the spinner is still
    // showing and get a false-negative (no error found yet).
    //
    // The scan checks both the main page body and inside the game iframe,
    // because different providers render error messages in different places.
    // ─────────────────────────────────────────────────────────────────────────
    await page.waitForTimeout(3000);

    const gate3Error = await detectErrorText(page);
    if (gate3Error) {
        return fail(3, `Game Error: "${gate3Error}"`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GATE 4: Stability Watch (8 seconds)
    //
    // Purpose: Catch games that appear to load successfully but then fail after
    // connecting to their backend server. Some live dealer games show a
    // video loading screen, then fail when the video stream can't be established.
    //
    // Also catches "Blank Screen" — game iframe loaded but nothing is visible
    // (pure black or white canvas with no DOM elements).
    //
    // Total wait after iframe load: 3s (Gate 3) + 8s (Gate 4) = 11 seconds.
    // This mirrors how long a real user would wait before deciding the game failed.
    // ─────────────────────────────────────────────────────────────────────────
    const STABILITY_INTERVAL_MS = 2000; // Check every 2 seconds
    const STABILITY_DURATION_MS = 8000; // Watch for 8 seconds total
    const checks = STABILITY_DURATION_MS / STABILITY_INTERVAL_MS;

    for (let tick = 0; tick < checks; tick++) {
        await page.waitForTimeout(STABILITY_INTERVAL_MS);
        const gate4Error = await detectErrorText(page);
        if (gate4Error) {
            return fail(4, `Unstable: "${gate4Error}"`);
        }
    }

    // Final blank screen check: at least one visible element must exist in the iframe.
    // Slot games should have a canvas, live dealer games should have video elements.
    const hasContent = await page.frameLocator('#gameframe')
        .locator('body *:visible')
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false);

    if (!hasContent) {
        return fail(4, 'Blank Screen (no visible content after 11s)');
    }

    return pass();
}

// ── Error text detection helper ──────────────────────────────────────────────

/**
 * Scans visible text on the page for known error message patterns.
 *
 * Checks two places:
 *  1. The main page body (rare — games usually render everything in the iframe)
 *  2. Inside the #gameframe iframe (most error messages appear here)
 *
 * Uses a short timeout (300ms) for each check to keep the scan fast.
 * Returns the matched error text (trimmed, max 100 chars), or null if clean.
 *
 * @param page  The current Playwright Page (must have #gameframe injected)
 */
async function detectErrorText(page: Page): Promise<string | null> {
    // Check the outer page first — some providers break out of the iframe
    const mainPageMatch = await page
        .getByText(ERROR_TEXT_PATTERN)
        .first()
        .textContent({ timeout: 300 })
        .catch(() => null);
    if (mainPageMatch) return mainPageMatch.trim().slice(0, 100);

    // Check inside the iframe — this is where most error messages appear
    const frameMatch = await page
        .frameLocator('#gameframe')
        .getByText(ERROR_TEXT_PATTERN)
        .first()
        .textContent({ timeout: 300 })
        .catch(() => null);
    if (frameMatch) return frameMatch.trim().slice(0, 100);

    return null; // No error detected
}
