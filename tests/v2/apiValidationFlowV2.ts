/**
 * apiValidationFlowV2.ts — Fully concurrent game validation (v2, improved).
 *
 * ── What changed from the original v2 ────────────────────────────────────────
 *
 *  ORIGINAL v2:  sequential BATCHES of GAMES_PER_BATCH
 *    - Games split into chunks of 3
 *    - await Promise.all(chunk) — must wait for ALL games in chunk to finish
 *    - If game 1 takes 20s (slow server), games 2 and 3 sit idle after 11s
 *    - Inter-batch idle time = (slowest game in batch - fastest game in batch)
 *
 *  IMPROVED v2:  semaphore-based CONCURRENT QUEUE
 *    - All games dispatched through a Semaphore(MAX_CONCURRENT_GAMES)
 *    - As soon as any game finishes, the next one starts immediately
 *    - Zero inter-batch idle time
 *    - Same memory cap (slot count = MAX_CONCURRENT_GAMES)
 *
 * ── Parallelism at both levels ────────────────────────────────────────────────
 *
 *  Level 1 (vendor): up to `workers` vendor tests run in parallel (playwright.config.ts)
 *  Level 2 (game):   up to MAX_CONCURRENT_GAMES games run per vendor at any moment
 *
 *  Total simultaneous browser pages = workers × MAX_CONCURRENT_GAMES
 *  14 workers × 6 games = 84 pages → ~16.8GB browser memory (safe for 32GB)
 *
 * ── Performance estimate ──────────────────────────────────────────────────────
 *
 *  Original v2 @ batch=3: ~50 min
 *  Improved v2 @ concurrent=6, 7s/game: ~18 min
 *
 * ── Bug fixes ──────────────────────────────────────────────────────────────────
 *
 *  - Pagination infinite loop: pageIndex now increments BEFORE break check
 *  - Empty-page guard added to stop runaway loops on API glitches
 *  - Stagger no longer multiplied linearly (was wasting 2.5s on index 5)
 */

import { Page, Browser } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { getGameList, enterGame, S9Credential, GameInfo } from '../api/s9ApiClient';

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Maximum number of games to validate simultaneously within a single vendor.
 *
 * Tuning guide (workers=14):
 *   4  → 56 total pages,  ~11.2GB — conservative
 *   6  → 84 total pages,  ~16.8GB — recommended for 32GB (leaves headroom)
 *   8  → 112 total pages, ~22.4GB — aggressive, watch memory
 *
 * Unlike the old GAMES_PER_BATCH, this is a true concurrency cap — games
 * start as soon as a slot is free, not locked to fixed batch boundaries.
 */
const MAX_CONCURRENT_GAMES = 6;

/**
 * How many times to retry a failed game before recording it as Fail.
 *
 * A retry is only attempted for transient failures (Gate 1 API errors,
 * Gate 2 connection failures, Gate 3/4 intermittent errors).
 * AUTH_FAILURE always skips retries — re-auth is needed in that case.
 *
 *   0  = no retry (fastest, but flaky servers cause false failures)
 *   1  = one retry (recommended — handles most transient server issues)
 *   2  = two retries (for very unstable environments)
 */
const MAX_RETRIES = 2;

/**
 * Milliseconds to wait before retrying a failed game.
 * Gives the game server time to recover from a transient error.
 * 3000ms = 3s cooldown between attempts.
 */
const RETRY_DELAY_MS = 3000;

/**
 * Milliseconds to wait before the very first game starts (index 0).
 * Prevents a cold-start burst where 6 games all call enterGame() simultaneously
 * before the API connection pool has warmed up.
 * Game 0 waits this long; subsequent games wait STAGGER_MS × their index (up to cap).
 */
const INITIAL_WARMUP_MS = 500;

/**
 * Milliseconds to stagger between starting each concurrent game.
 * Prevents a spike of simultaneous game/enter API calls at startup.
 */
const STAGGER_MS = 200;

/** Absolute path to the browser auth state file saved by auth.setup.ts. */
const AUTH_STATE = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'user.json');

/** Absolute path to the API credential file saved by auth.setup.ts. */
const CRED_FILE  = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'credential.json');

/**
 * Directory where per-vendor CSV result files are saved.
 * Created automatically if it does not exist.
 */
const REPORTS_DIR = path.resolve(__dirname, '..', '..', 'test-results', 'vendor-reports');

// ── Gate timing constants ──────────────────────────────────────────────────────

/** ms to wait after iframe loads before scanning for error text (Gate 3) */
const GATE3_SETTLE_MS    = 2000;

/** Total ms to watch for late-appearing errors (Gate 4) */
const GATE4_DURATION_MS  = 5000;

/** Poll interval inside Gate 4 stability watch */
const GATE4_INTERVAL_MS  = 2000;

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
 *
 * No external dependencies — works in Node.js/Playwright out of the box.
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
    // const credential = loadCredential();
    // console.log(`\n=== [${vendorName}] v2 validation starting (ven_id=${vendorId}, concurrent=${MAX_CONCURRENT_GAMES}) ===`);

    // // ── Step 1: Fetch all games via API ──────────────────────────────────────
    // let games: GameInfo[];
    // try {
    //     games = await getGameList(credential, vendorId);
    // } catch (e: any) {
    //     console.error(`[${vendorName}] Failed to fetch game list: ${e.message}`);
    //     return;
    // }

    // if (games.length === 0) {
    //     console.warn(`[${vendorName}] No active games found.`);
    //     return;
    // }
    // console.log(`[${vendorName}] ${games.length} games to test (max ${MAX_CONCURRENT_GAMES} concurrent).`);

    // ── Step 2: Run all games through a semaphore-based concurrent queue ──────
    //
    // All game tasks are dispatched at once. Each acquires a semaphore slot
    // before creating a browser context, and releases it immediately after
    // context.close() — so the next queued game starts the instant a slot opens.
    //
    // This eliminates the inter-batch idle time of the old fixed-batch model.
    // const results: GameResult[] = new Array(games.length); // pre-sized for ordering
    // const semaphore = new Semaphore(MAX_CONCURRENT_GAMES);

    // await Promise.all(
    //     games.map(async (game, globalIndex) => {
    //         // ── Startup stagger ───────────────────────────────────────────────
    //         // Game 0 gets a warmup delay to prevent a cold-start API burst.
    //         // Games 1–5 get incremental stagger. Games 6+ wait only STAGGER_MS
    //         // (they queue behind the semaphore anyway, so extra stagger is wasteful).
    //         const staggerMs = globalIndex === 0
    //             ? INITIAL_WARMUP_MS
    //             : Math.min(globalIndex, MAX_CONCURRENT_GAMES - 1) * STAGGER_MS;
    //         if (staggerMs > 0) await sleep(staggerMs);

    //         // Block until a concurrency slot is available
    //         await semaphore.acquire();

    //         const slotLabel = `[${vendorName}][${globalIndex + 1}/${games.length}]`;
    //         console.log(`${slotLabel} Starting: ${game.name}`);

    //         let finalResult: GameResult | null = null;

    //         // ── Retry loop ────────────────────────────────────────────────────
    //         // Each attempt gets a fresh browser context. The retry loop runs
    //         // entirely INSIDE the semaphore slot, so no extra concurrency slots
    //         // are consumed while waiting between retries.
    //         for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    //             if (attempt > 0) {
    //                 console.log(`${slotLabel} ↻ Retry ${attempt}/${MAX_RETRIES} for: ${game.name} (waiting ${RETRY_DELAY_MS}ms)`);
    //                 await sleep(RETRY_DELAY_MS);
    //             }

    //             const context = await browser.newContext({
    //                 storageState: AUTH_STATE,
    //                 ignoreHTTPSErrors: true,
    //             });

    //             try {
    //                 const gamePage: Page = await context.newPage();
    //                 const result = await validateSingleGame(gamePage, credential, game, vendorId);
    //                 result.retries = attempt;

    //                 if (result.status === 'Pass') {
    //                     // ✅ Passed — stop retrying
    //                     finalResult = result;
    //                     if (attempt > 0) {
    //                         console.log(`${slotLabel} ✅ Passed on retry ${attempt}: ${game.name}`);
    //                     }
    //                     break;
    //                 }

    //                 // ❌ Failed — check if we should retry
    //                 const isAuthFailure = result.errorLabel.startsWith('AUTH_FAILURE');
    //                 if (isAuthFailure || attempt >= MAX_RETRIES) {
    //                     // Auth failures never retry. Last attempt: record the failure.
    //                     finalResult = result;
    //                     break;
    //                 }

    //                 // Will retry — record this attempt's error for logging
    //                 console.log(`${slotLabel} ✗ Attempt ${attempt + 1} failed | Gate ${result.gate}: ${result.errorLabel}`);
    //                 finalResult = result; // carry forward in case next attempt also fails

    //             } catch (e: any) {
    //                 const errorResult: GameResult = {
    //                     gameId: game.game_id,
    //                     gameName: game.name,
    //                     status: 'Fail',
    //                     gate: 2,
    //                     errorLabel: `Unexpected error: ${e.message.slice(0, 60)}`,
    //                     retries: attempt,
    //                 };
    //                 if (attempt >= MAX_RETRIES) {
    //                     finalResult = errorResult;
    //                     break;
    //                 }
    //                 console.log(`${slotLabel} ✗ Attempt ${attempt + 1} threw: ${e.message.slice(0, 60)}`);
    //                 finalResult = errorResult;
    //             } finally {
    //                 await context.close().catch(() => {});
    //             }
    //         }

    //         results[globalIndex] = finalResult ?? {
    //             gameId: game.game_id,
    //             gameName: game.name,
    //             status: 'Fail',
    //             gate: 0,
    //             errorLabel: 'No result recorded (internal error)',
    //             retries: MAX_RETRIES,
    //         };

    //         const r = results[globalIndex];
    //         const retryNote = r.retries > 0 ? ` [retried ${r.retries}×]` : '';
    //         const detail = r.status === 'Fail' ? ` | Gate ${r.gate}: ${r.errorLabel}` : '';
    //         console.log(`${slotLabel} → ${r.status}${retryNote}${detail}`);

    //         semaphore.release();
    //     })
    // );

    const credential = loadCredential();
    const games = await getGameList(credential, vendorId);
    
    // Split games into larger "Super-Batches" to allow system cooldown
    const SUPER_BATCH_SIZE = 50; 
    const results: GameResult[] = [];

    for (let i = 0; i < games.length; i += SUPER_BATCH_SIZE) {
        const chunk = games.slice(i, i + SUPER_BATCH_SIZE);
        const semaphore = new Semaphore(MAX_CONCURRENT_GAMES);

        await Promise.all(
            chunk.map(async (game, index) => {
                await semaphore.acquire();
                try {
                    // Existing validation logic...
                    const result = await runWithRetry(browser, game, vendorId, credential);
                    results.push(result);
                } finally {
                    semaphore.release();
                }
            })
        );

        // SYSTEM COOLDOWN: Give the OS/Node.js time to reclaim memory 
        // after every 50 games to prevent cumulative slowdown.
        if (i + SUPER_BATCH_SIZE < games.length) {
            console.log(`[${vendorName}] Reached Super-Batch limit. Cooling down for 5s...`);
            await sleep(5000);
        }
    }

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
 * Gate timing (improved vs original):
 *   Gate 1: API entry          — ~200ms  (unchanged)
 *   Gate 2: iframe load        — 20s max (unchanged)
 *   Gate 3: settle + scan      — 2s      (was 3s, saves 1s)
 *   Gate 4: stability watch    — 5s      (was 8s, saves 3s)
 *   Total minimum per game     — ~7s     (was 11s, 36% faster)
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
    // page.route() intercepts the s9.com URL and returns an instant stub HTML page.
    // This gives us:  (1) HTTPS parent URL — satisfies providers checking window.parent.location.protocol
    //                 (2) document.body — available immediately for iframe injection
    //
    // No real s9.com server request is made — sub-11s setup instead of 5–20s.
    let iframeLoaded = false;
    let iframeHttpError: number | null = null;

    try {
        const errorHandler = (res: any) => {
            if (res.url() === redirectUrl && res.status() >= 400) {
                iframeHttpError = res.status();
            }
        };
        page.on('response', errorHandler);

        await page.route('https://s9.com/**', (route) => {
            route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: '<!DOCTYPE html><html><head><style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden}</style></head><body></body></html>',
            });
        });

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

        page.off('response', errorHandler);
    } catch (e: any) {
        return fail(2, `Connection Failed: ${e.message.slice(0, 80)}`);
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


/**
 * Helper to handle the browser context lifecycle and retries for a single game.
 * This ensures that even if one game crashes, the context is closed properly.
 */
async function runWithRetry(
    browser: Browser,
    game: GameInfo,
    vendorId: number,
    credential: S9Credential
): Promise<GameResult> {
    let finalResult: GameResult | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) await sleep(RETRY_DELAY_MS);

        const context = await browser.newContext({
            storageState: AUTH_STATE,
            ignoreHTTPSErrors: true,
        });

        try {
            const page = await context.newPage();
            const result = await validateSingleGame(page, credential, game, vendorId);
            result.retries = attempt;

            if (result.status === 'Pass' || result.errorLabel.startsWith('AUTH_FAILURE')) {
                finalResult = result;
                break; 
            }
            finalResult = result;
        } catch (e: any) {
            finalResult = {
                gameId: game.game_id,
                gameName: game.name,
                status: 'Fail',
                gate: 2,
                errorLabel: `Unexpected: ${e.message.slice(0, 50)}`,
                retries: attempt,
            };
        } finally {
            await context.close().catch(() => {});
        }
    }
    return finalResult!;
}