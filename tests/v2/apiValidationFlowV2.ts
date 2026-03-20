/**
 * apiValidationFlowV2.ts — Fully concurrent game validation (v2, memory-safe).
 *
 * ── What changed from the previous v2 ────────────────────────────────────────
 *
 *  FIX 1 — page.route() now always unrouted in a finally block
 *    BEFORE: route handler added inside try{}, never removed on exception path
 *    AFTER:  await page.unroute('https://s9.com/**') called in finally{} every time
 *    IMPACT: Eliminates Chromium-level route state accumulation across vendors
 *
 *  FIX 2 — response listener always removed in finally block
 *    BEFORE: page.off('response', errorHandler) only called on happy path;
 *            exception branch returned early and skipped it → listener leaked
 *    AFTER:  page.off() moved into finally{} so it fires on every exit path
 *    IMPACT: Eliminates closure-held memory from orphaned event listeners
 *
 *  FIX 3 — retry delay moved OUTSIDE the semaphore slot
 *    BEFORE: sleep(RETRY_DELAY_MS) ran inside runWithRetry while slot was held;
 *            all 6 slots could block-sleep simultaneously, causing context spikes
 *    AFTER:  retry sleep happens after semaphore.release(); slot is freed immediately
 *            after context.close() so next game can start during cooldown
 *    IMPACT: True MAX_CONCURRENT_GAMES cap is respected even during retries
 *
 *  FIX 4 — auth state parsed once per vendor, not per context
 *    BEFORE: storageState: AUTH_STATE (file path) → Playwright re-reads + parses
 *            user.json on every browser.newContext() call (6000+ times total)
 *    AFTER:  JSON.parse(fs.readFileSync(AUTH_STATE)) once at vendor start;
 *            parsed object passed directly to newContext() — zero repeated I/O
 *    IMPACT: Reduces cumulative heap pressure from repeated object allocation
 *
 *  FIX 5 — super-batch pattern removed
 *    BEFORE: 50-game super-batches + sleep(5000) "cooldown" tried to trigger GC
 *            V8 GC is non-deterministic; sleep doesn't guarantee collection
 *    AFTER:  Pure semaphore queue as originally designed — Fixes 1+2 eliminate
 *            the leak that made cooldowns necessary in the first place
 *    IMPACT: Cleaner architecture, zero idle time between games
 *
 *  FIX 6 — MAX_CONCURRENT_GAMES reduced to match real RAM budget
 *    BEFORE: 6 workers × 6 games = 36 pages × ~200MB = ~7.2GB (too tight)
 *    AFTER:  6 workers × 3 games = 18 pages × ~200MB = ~3.6GB (safe headroom)
 *    IMPACT: Leaves ~28GB for OS + Node heap + Playwright process overhead
 *
 * ── Parallelism at both levels ────────────────────────────────────────────────
 *
 *  Level 1 (vendor): up to `workers` vendor tests run in parallel (playwright.config.ts)
 *  Level 2 (game):   up to MAX_CONCURRENT_GAMES games run per vendor at any moment
 *
 *  Total simultaneous browser pages = workers × MAX_CONCURRENT_GAMES
 *  Recommended safe config for 32GB: 6 workers × 3 games = 18 pages → ~3.6GB
 *
 * ── RAM tuning guide ──────────────────────────────────────────────────────────
 *
 *  Formula: (available_RAM_GB - 4GB OS overhead) / workers / 0.2GB_per_page
 *  32GB machine: (32-4) / 6 / 0.2 = 23 max, but use 3–4 for real headroom
 *
 *  Workers=6, Games=3 →  18 pages, ~3.6GB  ← recommended (safe)
 *  Workers=6, Games=4 →  24 pages, ~4.8GB  ← acceptable
 *  Workers=6, Games=6 →  36 pages, ~7.2GB  ← original (too tight with leaks)
 *
 * ── Run commands ──────────────────────────────────────────────────────────────
 *
 *  All vendors (recommended):
 *    npx playwright test tests/v2/ --project=chromium --workers=6
 *
 *  Single vendor (debugging):
 *    npx playwright test tests/v2/ --project=chromium -g "v2: Amusnet" --workers=1 --headed
 *
 *  View report:
 *    npx playwright show-report
 */

import { Page, Browser } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { getGameList, enterGame, S9Credential, GameInfo } from '../api/s9ApiClient';

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Maximum number of games to validate simultaneously within a single vendor.
 *
 * RAM guide (see header for full formula):
 *   workers=6, games=3 →  18 pages, ~3.6GB  ← recommended for 32GB machines
 *   workers=6, games=4 →  24 pages, ~4.8GB  ← acceptable
 *   workers=6, games=6 →  36 pages, ~7.2GB  ← previous value, caused OOM
 *
 * Unlike a batch size, this is a true concurrency cap — a new game starts the
 * instant any slot frees up, regardless of what other games are doing.
 */
const MAX_CONCURRENT_GAMES = 3;

/**
 * How many times to retry a failed game before recording it as Fail.
 *
 * AUTH_FAILURE always skips retries — re-run auth setup in that case.
 * Each retry uses a fresh browser context and happens OUTSIDE the semaphore slot
 * (Fix 3) so the slot is not held idle during the cooldown delay.
 *
 *   0  = no retry (fastest, but flaky servers cause false failures)
 *   1  = one retry (recommended for most environments)
 *   2  = two retries (for very unstable server environments)
 */
const MAX_RETRIES = 2;

/**
 * Milliseconds to wait before retrying a failed game.
 * This delay now happens OUTSIDE the semaphore slot so no concurrency is wasted.
 */
const RETRY_DELAY_MS = 3000;

/**
 * Milliseconds to wait before the very first game starts.
 * Prevents a cold-start burst where all slots call enterGame() simultaneously.
 */
const INITIAL_WARMUP_MS = 500;

/**
 * Milliseconds to stagger between starting each initial concurrent game.
 * Games beyond the first MAX_CONCURRENT_GAMES queue behind the semaphore
 * naturally, so stagger only applies to the first wave.
 */
const STAGGER_MS = 200;

/** Absolute path to the browser auth state file saved by auth.setup.ts. */
const AUTH_STATE = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'user.json');

/** Absolute path to the API credential file saved by auth.setup.ts. */
const CRED_FILE = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'credential.json');

/**
 * Directory where per-vendor CSV result files are saved.
 * Created automatically if it does not exist.
 */
const REPORTS_DIR = path.resolve(__dirname, '..', '..', 'test-results', 'vendor-reports');

// ── Gate timing constants ──────────────────────────────────────────────────────

/** ms to wait after iframe loads before scanning for error text (Gate 3) */
const GATE3_SETTLE_MS = 2000;

/** Total ms to watch for late-appearing errors (Gate 4) */
const GATE4_DURATION_MS = 5000;

/** Poll interval inside Gate 4 stability watch */
const GATE4_INTERVAL_MS = 2000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type GameStatus = 'Pass' | 'Fail';

export interface GameResult {
    gameId: number;
    gameName: string;
    status: GameStatus;
    /** Gate that failed (1–4), or 0 for Pass */
    gate: number;
    errorLabel: string;
    /** Number of retry attempts made (0 = passed or failed on first try) */
    retries: number;
}

// ── Error detection ───────────────────────────────────────────────────────────

const ERROR_TEXT_PATTERN =
    /error occurred|network error|connection error|failed to load|cannot connect|server error|access denied|game unavailable|please try again|session expired|unauthorized|service unavailable|insecure connection/i;

// ── Semaphore ─────────────────────────────────────────────────────────────────

/**
 * A simple counting semaphore — limits concurrent async operations without batching.
 *
 * Unlike Promise.all(chunks), this allows a new game to start the INSTANT
 * any game finishes, rather than waiting for an entire batch to complete.
 */
class Semaphore {
    private running = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly max: number) {}

    acquire(): Promise<void> {
        return new Promise<void>(resolve => {
            if (this.running < this.max) {
                this.running++;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    }

    release(): void {
        this.running--;
        const next = this.queue.shift();
        if (next) {
            this.running++;
            next();
        }
    }
}

// ── Credential loader ─────────────────────────────────────────────────────────

function loadCredential(): S9Credential {
    if (!fs.existsSync(CRED_FILE)) {
        throw new Error(
            `credential.json not found at ${CRED_FILE}.\n` +
            `Run auth setup: npx playwright test --project=setup`
        );
    }
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) as S9Credential;
}

/**
 * FIX 4: Parse auth state once per vendor worker instead of on every newContext().
 *
 * Playwright accepts either a file path string OR a pre-parsed StorageState object
 * for the storageState option. Reading from disk 6000+ times across all games
 * causes cumulative heap pressure from repeated JSON parsing + object allocation.
 * Parsing once and reusing the same object eliminates this entirely.
 */
function loadAuthState(): object {
    if (!fs.existsSync(AUTH_STATE)) {
        throw new Error(
            `user.json not found at ${AUTH_STATE}.\n` +
            `Run auth setup: npx playwright test --project=setup`
        );
    }
    return JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'));
}

// ── Main exported flow ────────────────────────────────────────────────────────

/**
 * Validates all games for one vendor using a semaphore-based concurrent queue.
 *
 * @param browser    Playwright Browser fixture (passed from test runner)
 * @param vendorId   Vendor ID (e.g. 600005 for Amusnet)
 * @param vendorName Display name for logging
 */
export async function apiValidateVendorGamesFlowV2(
    browser: Browser,
    vendorId: number,
    vendorName: string
): Promise<void> {
    const credential = loadCredential();

    // FIX 4: Parse auth state object once — reused across all newContext() calls
    const authState = loadAuthState();

    console.log(`\n=== [${vendorName}] v2 validation starting (ven_id=${vendorId}, concurrent=${MAX_CONCURRENT_GAMES}) ===`);

    // ── Step 1: Fetch all games via API ──────────────────────────────────────
    let games: GameInfo[];
    try {
        games = await getGameList(credential, vendorId);
    } catch (e: any) {
        console.error(`[${vendorName}] Failed to fetch game list: ${e.message}`);
        return;
    }

    if (games.length === 0) {
        console.warn(`[${vendorName}] No active games found.`);
        return;
    }
    console.log(`[${vendorName}] ${games.length} games to test (max ${MAX_CONCURRENT_GAMES} concurrent).`);

    // ── Step 2: Run all games through a semaphore-based concurrent queue ──────
    //
    // All game tasks are dispatched at once. Each acquires a semaphore slot
    // before creating a browser context, and releases it immediately after
    // context.close() — so the next queued game starts the instant a slot opens.
    //
    // FIX 3: Retry delay happens OUTSIDE the semaphore slot. When a game fails
    // and needs a retry, the slot is released first, then the delay runs, then
    // a new slot is acquired for the retry attempt. This means the concurrency
    // cap is never exceeded during retry cooldowns.
    const results: GameResult[] = new Array(games.length);
    const semaphore = new Semaphore(MAX_CONCURRENT_GAMES);

    await Promise.all(
        games.map(async (game, globalIndex) => {
            // ── Startup stagger ───────────────────────────────────────────────
            // Game 0 gets a warmup delay to prevent a cold-start API burst.
            // Games 1–(MAX_CONCURRENT_GAMES-1) get incremental stagger.
            // Games beyond that queue behind the semaphore naturally.
            const staggerMs = globalIndex === 0
                ? INITIAL_WARMUP_MS
                : Math.min(globalIndex, MAX_CONCURRENT_GAMES - 1) * STAGGER_MS;
            if (staggerMs > 0) await sleep(staggerMs);

            const slotLabel = `[${vendorName}][${globalIndex + 1}/${games.length}]`;
            let finalResult: GameResult | null = null;

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                // FIX 3: Retry delay runs BEFORE re-acquiring the slot.
                // The previous slot was already released at the end of the last attempt.
                if (attempt > 0) {
                    console.log(`${slotLabel} ↻ Retry ${attempt}/${MAX_RETRIES} for: ${game.name} (waiting ${RETRY_DELAY_MS}ms)`);
                    await sleep(RETRY_DELAY_MS);
                }

                // Acquire slot — blocks until a concurrency slot is available
                await semaphore.acquire();

                if (attempt === 0) {
                    console.log(`${slotLabel} Starting: ${game.name}`);
                }

                try {
                    const context = await browser.newContext({
                        // FIX 4: Pass pre-parsed object, not file path string
                        storageState: authState as any,
                        ignoreHTTPSErrors: true,
                    });

                    try {
                        const page = await context.newPage();
                        const result = await validateSingleGame(page, credential, game, vendorId);
                        result.retries = attempt;

                        if (result.status === 'Pass') {
                            finalResult = result;
                            if (attempt > 0) {
                                console.log(`${slotLabel} ✅ Passed on retry ${attempt}: ${game.name}`);
                            }
                        } else {
                            const isAuthFailure = result.errorLabel.startsWith('AUTH_FAILURE');
                            if (isAuthFailure || attempt >= MAX_RETRIES) {
                                // Never retry auth failures. On last attempt, record failure.
                                finalResult = result;
                            } else {
                                // Will retry — log this attempt's error
                                console.log(`${slotLabel} ✗ Attempt ${attempt + 1} failed | Gate ${result.gate}: ${result.errorLabel}`);
                                finalResult = result; // carry forward in case next attempt also fails
                            }
                        }
                    } finally {
                        // Context always closed — even if validateSingleGame throws
                        await context.close().catch(() => {});
                    }
                } catch (e: any) {
                    finalResult = {
                        gameId: game.game_id,
                        gameName: game.name,
                        status: 'Fail',
                        gate: 2,
                        errorLabel: `Unexpected error: ${e.message.slice(0, 60)}`,
                        retries: attempt,
                    };
                } finally {
                    // FIX 3: Release slot immediately after context is closed.
                    // The retry delay (if needed) runs AFTER this release, so the
                    // slot is free for another game during the cooldown period.
                    semaphore.release();
                }

                // If we have a final result (pass, auth failure, or last attempt), stop
                if (
                    finalResult?.status === 'Pass' ||
                    finalResult?.errorLabel.startsWith('AUTH_FAILURE') ||
                    attempt >= MAX_RETRIES
                ) {
                    break;
                }
            }

            results[globalIndex] = finalResult ?? {
                gameId: game.game_id,
                gameName: game.name,
                status: 'Fail',
                gate: 0,
                errorLabel: 'No result recorded (internal error)',
                retries: MAX_RETRIES,
            };

            const r = results[globalIndex];
            const retryNote = r.retries > 0 ? ` [retried ${r.retries}×]` : '';
            const detail = r.status === 'Fail' ? ` | Gate ${r.gate}: ${r.errorLabel}` : '';
            console.log(`${slotLabel} → ${r.status}${retryNote}${detail}`);
        })
    );

    // ── Step 3: Print console summary table ──────────────────────────────────
    const passed  = results.filter(r => r.status === 'Pass').length;
    const failed  = results.filter(r => r.status === 'Fail').length;
    const retried = results.filter(r => r.retries > 0).length;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    console.log(`\n### [${vendorName}] v2 Summary: ${passed} passed, ${failed} failed / ${results.length} total (${retried} needed retry)\n`);
    console.log('| Game | Status | Gate | Retries | Error |');
    console.log('|------|--------|------|---------|-------|');
    for (const r of results) {
        console.log(`| ${r.gameName} | ${r.status} | ${r.gate || '-'} | ${r.retries} | ${r.errorLabel || '-'} |`);
    }

    // ── Step 4: Save CSV report ────────────────────────────────────────────────
    try {
        fs.mkdirSync(REPORTS_DIR, { recursive: true });

        const safeName = vendorName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const csvPath = path.join(REPORTS_DIR, `${safeName}_${timestamp}.csv`);

        const csvLines = [
            'VendorId,VendorName,GameId,GameName,Status,Gate,Retries,Error,Timestamp',
            ...results.map(r =>
                [
                    vendorId,
                    `"${vendorName}"`,
                    r.gameId,
                    `"${r.gameName.replace(/"/g, '""')}"`,
                    r.status,
                    r.gate || '',
                    r.retries,
                    `"${(r.errorLabel || '').replace(/"/g, '""')}"`,
                    timestamp,
                ].join(',')
            ),
        ];

        fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');
        console.log(`\n📄 CSV saved: ${csvPath}`);
    } catch (e: any) {
        console.warn(`⚠️ Could not save CSV: ${e.message}`);
    }
}

// ── Single game validation (4 gates) ─────────────────────────────────────────

/**
 * Validates one game through the 4-gate system.
 *
 * Gate timing:
 *   Gate 1: API entry          — ~200ms
 *   Gate 2: iframe load        — ≤20s max
 *   Gate 3: settle + scan      — 2s
 *   Gate 4: stability watch    — 5s
 *   Minimum per game           — ~7s
 *
 * Memory safety:
 *   - page.route() is always unrouted in a finally block (Fix 1)
 *   - page.on('response') listener is always removed in a finally block (Fix 2)
 *   - The page itself is closed by the caller (context.close() in runWithRetry)
 */
async function validateSingleGame(
    page: Page,
    credential: S9Credential,
    game: GameInfo,
    vendorId: number,
): Promise<GameResult> {
    const pass = (): GameResult => ({
        gameId: game.game_id, gameName: game.name, status: 'Pass', gate: 0, errorLabel: '', retries: 0
    });
    const fail = (gate: number, label: string): GameResult => ({
        gameId: game.game_id, gameName: game.name, status: 'Fail', gate, errorLabel: label, retries: 0
    });

    // ── Gate 1: API Entry ─────────────────────────────────────────────────────
    let redirectUrl: string;
    try {
        const enterResult = await enterGame(credential, game.game_id, vendorId);
        if (enterResult.code !== 1 || !enterResult.redirect_url) {
            const isAuthFailure =
                enterResult.msg?.toLowerCase().includes('token') ||
                enterResult.msg?.toLowerCase().includes('login') ||
                enterResult.code === 401;
            if (isAuthFailure) return fail(1, `AUTH_FAILURE: ${enterResult.msg}`);
            return fail(1, `API Error (code=${enterResult.code}): ${enterResult.msg || 'no redirect_url'}`);
        }
        redirectUrl = enterResult.redirect_url;
    } catch (e: any) {
        return fail(1, `API call failed: ${e.message.slice(0, 80)}`);
    }

    // ── Gate 2: iframe Load via HTTPS parent (route intercept) ────────────────
    //
    // page.route() intercepts https://s9.com/** and serves an instant stub page.
    // This gives us an HTTPS parent URL without hitting the live s9.com server.
    //
    // FIX 1: The route is now ALWAYS unrouted in a finally block.
    //         Previously, exceptions caused early returns that skipped unroute,
    //         leaving Chromium holding route state for the lifetime of the process.
    //
    // FIX 2: The response listener is now ALWAYS removed in a finally block.
    //         Previously, page.off() was only called on the happy path.
    let iframeLoaded = false;
    let iframeHttpError: number | null = null;

    const routeUrl = 'https://s9.com/**';

    // Define handler refs so they can be removed in finally
    const routeHandler = (route: any) => {
        route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<!DOCTYPE html><html><head><style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden}</style></head><body></body></html>',
        });
    };

    const responseHandler = (res: any) => {
        if (res.url() === redirectUrl && res.status() >= 400) {
            iframeHttpError = res.status();
        }
    };

    // FIX 2: Attach listener before try so finally can always remove it
    page.on('response', responseHandler);

    try {
        // FIX 1: Register route
        await page.route(routeUrl, routeHandler);

        try {
            await page.goto(`https://s9.com/games?ven_id=${vendorId}`, {
                waitUntil: 'domcontentloaded',
                timeout: 5000,
            });

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

            iframeLoaded = await page.frameLocator('#gameframe')
                .locator('body')
                .waitFor({ state: 'attached', timeout: 20000 })
                .then(() => true)
                .catch(() => false);

        } finally {
            // FIX 1: Always unroute — prevents Chromium route state accumulation
            await page.unroute(routeUrl).catch(() => {});
        }

    } catch (e: any) {
        return fail(2, `Connection Failed: ${e.message.slice(0, 80)}`);
    } finally {
        // FIX 2: Always remove response listener — prevents closure-held memory leak
        page.off('response', responseHandler);
    }

    if (!iframeLoaded) {
        if (iframeHttpError) return fail(2, `HTTP Error (${iframeHttpError})`);
        return fail(2, 'iframe did not load in 20s (Connection Failed)');
    }

    // ── Gate 3: Immediate error scan (after settle) ───────────────────────────
    await page.waitForTimeout(GATE3_SETTLE_MS);
    const gate3Error = await detectErrorText(page);
    if (gate3Error) return fail(3, `Game Error: "${gate3Error}"`);

    // ── Gate 4: Stability watch ───────────────────────────────────────────────
    const ticks = Math.floor(GATE4_DURATION_MS / GATE4_INTERVAL_MS);
    for (let tick = 0; tick < ticks; tick++) {
        await page.waitForTimeout(GATE4_INTERVAL_MS);
        const gate4Error = await detectErrorText(page);
        if (gate4Error) return fail(4, `Unstable: "${gate4Error}"`);
    }

    // Blank screen check (final gate 4 check)
    const hasContent = await page.frameLocator('#gameframe')
        .locator('body *:visible').first()
        .isVisible({ timeout: 1000 }).catch(() => false);
    if (!hasContent) return fail(4, 'Blank Screen (no visible content after game load)');

    return pass();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function detectErrorText(page: Page): Promise<string | null> {
    const mainMatch = await page.getByText(ERROR_TEXT_PATTERN).first()
        .textContent({ timeout: 300 }).catch(() => null);
    if (mainMatch) return mainMatch.trim().slice(0, 100);

    const frameMatch = await page.frameLocator('#gameframe').getByText(ERROR_TEXT_PATTERN).first()
        .textContent({ timeout: 300 }).catch(() => null);
    if (frameMatch) return frameMatch.trim().slice(0, 100);

    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}