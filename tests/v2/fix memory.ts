/**
 * apiValidationFlowV2.ts — Fully concurrent game validation (v2, memory-safe).
 *
 * ── Root cause of OOM freeze (fixed here) ────────────────────────────────────
 *
 *  The previous Promise.all(games.map(...)) pattern dispatches ALL game promises
 *  simultaneously. A vendor with 600 games creates 600 promise closures at once —
 *  each holding a GameInfo reference, result slot, credential ref, and closure
 *  state in the V8 heap. The semaphore throttled EXECUTION but not ALLOCATION.
 *
 *  With 6 workers each handling a large vendor:
 *    6 workers × 600 games × closure_overhead = thousands of live objects
 *    + 6 workers × MAX_CONCURRENT_GAMES × 200MB Chromium pages
 *    = OOM at ~44 vendors regardless of semaphore settings
 *
 * ── New architecture: worker pool + async generator ───────────────────────────
 *
 *  runWorkerPool() spawns exactly MAX_CONCURRENT_GAMES worker coroutines per
 *  vendor. Each worker pulls ONE game at a time from a shared index counter,
 *  validates it, writes the result to CSV, then pulls the next. Zero pre-allocation.
 *
 *  Memory profile at any moment:
 *    Exactly MAX_CONCURRENT_GAMES GameInfo objects in flight (not 600)
 *    Exactly MAX_CONCURRENT_GAMES browser contexts open per vendor worker
 *    Results written to CSV immediately — no accumulation array in RAM
 *    Game list array (games[]) freed by GC after iteration completes
 *
 * ── Global page ceiling ───────────────────────────────────────────────────────
 *
 *  GLOBAL_PAGE_BUDGET is the hard upper bound on total browser pages open
 *  across all vendor workers simultaneously. Formula:
 *    GLOBAL_PAGE_BUDGET × 200MB ≤ (total_RAM - 8GB OS/Node overhead)
 *    32GB machine: (32 - 8) / 0.2 = 120 theoretical max; use 20 conservatively.
 *
 *  Per-worker concurrency: MAX_CONCURRENT_GAMES = 4
 *  With workers=6: worst case 6 × 4 = 24 pages — close to budget.
 *  In practice, vendors finish at different times, so average is much lower.
 *  To guarantee ≤ budget: set MAX_CONCURRENT_GAMES = floor(GLOBAL_PAGE_BUDGET / workers).
 *
 * ── CSV streaming output ──────────────────────────────────────────────────────
 *
 *  Results are written row-by-row as each game completes (CsvStreamWriter).
 *  Previously results accumulated in a GameResult[] array until vendor done.
 *  Now: zero result RAM accumulation, partial saves on crash.
 *
 * ── Fix history ───────────────────────────────────────────────────────────────
 *
 *  FIX 1  — page.route() always unrouted in finally block
 *  FIX 2  — response listener always removed in finally block
 *  FIX 3  — retry delay outside semaphore slot
 *  FIX 4  — auth state parsed once per vendor
 *  FIX 5  — super-batch pattern removed
 *  FIX 6  — per-worker concurrency cap
 *  FIX 7  — nested iframe detection (resolveGameFrame)
 *  FIX 8  — Promise.all replaced with worker pool + index-based dispatch
 *  FIX 9  — global page budget configuration
 *  FIX 10 — streaming CSV (CsvStreamWriter, no result array)
 *
 * ── Run commands ──────────────────────────────────────────────────────────────
 *
 *  All vendors:    npx playwright test tests/v2/ --project=chromium --workers=6
 *  Single vendor:  npx playwright test tests/v2/ --project=chromium -g "v2: Amusnet" --workers=1 --headed
 *  View report:    npx playwright show-report
 */

import { Page, Browser, FrameLocator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { getGameList, enterGame, S9Credential, GameInfo } from '../api/s9ApiClient';

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Hard ceiling on total browser pages open across ALL vendor workers at once.
 *
 * This is a documentation/planning constant — enforcement is via MAX_CONCURRENT_GAMES.
 * To hard-enforce: MAX_CONCURRENT_GAMES = Math.floor(GLOBAL_PAGE_BUDGET / workers)
 *
 *   Budget=20 → ~4GB browser RAM   ← safe for 32GB
 *   Budget=30 → ~6GB browser RAM   ← acceptable
 *   Budget=40 → ~8GB browser RAM   ← aggressive
 *
 * With workers=6, MAX_CONCURRENT_GAMES=3: 18 pages max. Always within budget=20.
 * With workers=6, MAX_CONCURRENT_GAMES=4: 24 pages max. Slightly over budget=20
 *   but safe in practice since not all workers saturate simultaneously.
 */
const GLOBAL_PAGE_BUDGET = 20;

/**
 * Max concurrent game pages per vendor worker.
 *
 * Safe value: Math.floor(GLOBAL_PAGE_BUDGET / workers)
 *   workers=6, budget=20 → floor(20/6) = 3  ← guaranteed safe
 *   workers=6, budget=24 → floor(24/6) = 4  ← also fine with the pool pattern
 *
 * The worker pool pattern (FIX 8) means this is a true hard cap — no extra
 * promise closures exist beyond the active workers.
 */
const MAX_CONCURRENT_GAMES = 3;

/** Max retries per failed game. AUTH_FAILURE always skips retries. */
const MAX_RETRIES = 2;

/** Cooldown between retries (ms). Budget slot is FREE during this wait. */
const RETRY_DELAY_MS = 3000;

/** Stagger delay between worker startups (cold-start burst prevention). */
const STAGGER_MS = 200;

const AUTH_STATE  = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'user.json');
const CRED_FILE   = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'credential.json');
const REPORTS_DIR = path.resolve(__dirname, '..', '..', 'test-results', 'vendor-reports');

// ── Gate timing ───────────────────────────────────────────────────────────────

const GATE3_SETTLE_MS         = 2000;
const GATE4_DURATION_MS       = 5000;
const GATE4_INTERVAL_MS       = 2000;
const NESTED_IFRAME_DETECT_MS = 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

export type GameStatus = 'Pass' | 'Fail';

export interface GameResult {
    gameId:     number;
    gameName:   string;
    status:     GameStatus;
    gate:       number;
    errorLabel: string;
    retries:    number;
    /** 1 = normal single iframe, 2 = nested iframe detected */
    frameDepth: number;
}

// ── Error pattern ─────────────────────────────────────────────────────────────

const ERROR_TEXT_PATTERN =
    /error occurred|network error|connection error|failed to load|cannot connect|server error|access denied|game unavailable|please try again|session expired|unauthorized|service unavailable|insecure connection/i;

// ── Semaphore ─────────────────────────────────────────────────────────────────

class Semaphore {
    private running = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly max: number) {}

    acquire(): Promise<void> {
        return new Promise<void>(resolve => {
            if (this.running < this.max) { this.running++; resolve(); }
            else { this.queue.push(resolve); }
        });
    }

    release(): void {
        this.running--;
        const next = this.queue.shift();
        if (next) { this.running++; next(); }
    }
}

// ── Loaders ───────────────────────────────────────────────────────────────────

function loadCredential(): S9Credential {
    if (!fs.existsSync(CRED_FILE)) throw new Error(
        `credential.json not found at ${CRED_FILE}.\nRun: npx playwright test --project=setup`
    );
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) as S9Credential;
}

function loadAuthState(): object {
    if (!fs.existsSync(AUTH_STATE)) throw new Error(
        `user.json not found at ${AUTH_STATE}.\nRun: npx playwright test --project=setup`
    );
    return JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'));
}

// ── FIX 10: Streaming CSV writer ──────────────────────────────────────────────

/**
 * Writes CSV rows one-at-a-time as games complete.
 *
 * Previous: accumulate results[] → write all at end.
 *   Problem: 600-game vendor holds 600 objects in RAM for its entire duration.
 *   With 6 workers: up to 3600 result objects alive simultaneously.
 *
 * New: open file → write header → append one row per game → close.
 *   Result object released to GC immediately after append().
 *   Partial CSV saved even if worker crashes mid-run.
 */
class CsvStreamWriter {
    private readonly fd:         number;
    private readonly vendorId:   number;
    private readonly vendorName: string;
    private readonly timestamp:  string;
    private rowCount = 0;

    constructor(csvPath: string, vendorId: number, vendorName: string, timestamp: string) {
        fs.mkdirSync(path.dirname(csvPath), { recursive: true });
        this.fd         = fs.openSync(csvPath, 'w');
        this.vendorId   = vendorId;
        this.vendorName = vendorName;
        this.timestamp  = timestamp;
        fs.writeSync(this.fd,
            'VendorId,VendorName,GameId,GameName,Status,Gate,Retries,FrameDepth,Error,Timestamp\n'
        );
    }

    append(r: GameResult): void {
        const line = [
            this.vendorId,
            `"${this.vendorName}"`,
            r.gameId,
            `"${r.gameName.replace(/"/g, '""')}"`,
            r.status,
            r.gate || '',
            r.retries,
            r.frameDepth,
            `"${(r.errorLabel || '').replace(/"/g, '""')}"`,
            this.timestamp,
        ].join(',') + '\n';
        fs.writeSync(this.fd, line);
        this.rowCount++;
    }

    close(): number {
        fs.closeSync(this.fd);
        return this.rowCount;
    }
}

// ── FIX 8: Worker pool dispatcher ────────────────────────────────────────────

/**
 * Runs exactly `workerCount` concurrent workers that consume items one at a time.
 *
 * Key property: only `workerCount` items are "in flight" at any moment.
 * No pre-allocation of promises. The shared `nextIndex` counter is the only
 * coordination mechanism — no queues, no closures beyond the active workers.
 *
 * For a vendor with 600 games and workerCount=3:
 *   OLD (Promise.all): 600 closures created immediately, all alive until done
 *   NEW (runWorkerPool): 3 closures max, each recycled for the next item
 */
async function runWorkerPool<T>(
    items: T[],
    workerCount: number,
    handler: (item: T, index: number, total: number) => Promise<void>,
    staggerMs = 0
): Promise<void> {
    if (items.length === 0) return;

    let nextIndex = 0;
    const total   = items.length;
    const actual  = Math.min(workerCount, total);

    async function worker(workerIndex: number): Promise<void> {
        // Stagger worker startup to prevent cold-start API burst
        if (staggerMs > 0 && workerIndex > 0) {
            await sleep(staggerMs * workerIndex);
        }

        while (true) {
            // Claim next item atomically (JS is single-threaded — no race)
            const myIndex = nextIndex++;
            if (myIndex >= total) return;  // Exhausted — worker exits cleanly

            await handler(items[myIndex], myIndex, total);
            // After handler returns, items[myIndex] can be GC'd
            // The worker immediately loops to claim the next item
        }
    }

    await Promise.all(Array.from({ length: actual }, (_, i) => worker(i)));
}

// ── Main exported flow ────────────────────────────────────────────────────────

export async function apiValidateVendorGamesFlowV2(
    browser: Browser,
    vendorId: number,
    vendorName: string
): Promise<void> {
    const credential = loadCredential();
    const authState  = loadAuthState();  // FIX 4: parsed once, reused per context

    console.log(`\n=== [${vendorName}] v2 validation starting ` +
        `(ven_id=${vendorId}, concurrent=${MAX_CONCURRENT_GAMES}, budget=${GLOBAL_PAGE_BUDGET}) ===`);

    // ── Fetch game list ───────────────────────────────────────────────────────
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
    console.log(`[${vendorName}] ${games.length} games to test.`);

    // ── Open streaming CSV ────────────────────────────────────────────────────
    // FIX 10: opened before the run, rows appended as games complete
    const safeName  = vendorName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const csvPath   = path.join(REPORTS_DIR, `${safeName}_${timestamp}.csv`);

    let csv: CsvStreamWriter | null = null;
    try {
        csv = new CsvStreamWriter(csvPath, vendorId, vendorName, timestamp);
    } catch (e: any) {
        console.warn(`⚠️ Could not open CSV for writing: ${e.message}`);
    }

    // ── Lightweight counters (no result array) ────────────────────────────────
    let cntPassed = 0, cntFailed = 0, cntRetried = 0, cntNested = 0;

    // Per-vendor semaphore — limits concurrent pages within this worker
    const sem = new Semaphore(MAX_CONCURRENT_GAMES);

    // ── FIX 8: Worker pool dispatch ───────────────────────────────────────────
    await runWorkerPool(
        games,
        MAX_CONCURRENT_GAMES,
        async (game: GameInfo, gameIndex: number, total: number) => {
            const label = `[${vendorName}][${gameIndex + 1}/${total}]`;
            let result: GameResult | null = null;

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                // FIX 3: retry sleep BEFORE acquiring slot — slot free during wait
                if (attempt > 0) {
                    console.log(`${label} ↻ Retry ${attempt}/${MAX_RETRIES}: ${game.name} (wait ${RETRY_DELAY_MS}ms)`);
                    await sleep(RETRY_DELAY_MS);
                }

                await sem.acquire();
                if (attempt === 0) console.log(`${label} Starting: ${game.name}`);

                try {
                    const context = await browser.newContext({
                        storageState: authState as any,  // FIX 4
                        ignoreHTTPSErrors: true,
                    });

                    try {
                        const page = await context.newPage();
                        result = await validateSingleGame(page, credential, game, vendorId);
                        result.retries = attempt;

                        if (result.status === 'Pass') {
                            if (attempt > 0) console.log(`${label} ✅ Passed on retry ${attempt}: ${game.name}`);
                        } else {
                            const isAuth = result.errorLabel.startsWith('AUTH_FAILURE');
                            if (!isAuth && attempt < MAX_RETRIES) {
                                console.log(`${label} ✗ Attempt ${attempt + 1} failed | Gate ${result.gate}: ${result.errorLabel}`);
                            }
                        }
                    } finally {
                        await context.close().catch(() => {});
                    }
                } catch (e: any) {
                    result = {
                        gameId: game.game_id, gameName: game.name, status: 'Fail',
                        gate: 2, errorLabel: `Unexpected: ${e.message.slice(0, 60)}`,
                        retries: attempt, frameDepth: 1,
                    };
                } finally {
                    sem.release();  // FIX 3: slot freed before retry sleep
                }

                // Stop looping if: passed, auth failure, or exhausted retries
                if (
                    result?.status === 'Pass' ||
                    result?.errorLabel.startsWith('AUTH_FAILURE') ||
                    attempt >= MAX_RETRIES
                ) break;
            }

            const r = result ?? {
                gameId: game.game_id, gameName: game.name, status: 'Fail' as GameStatus,
                gate: 0, errorLabel: 'No result (internal error)', retries: MAX_RETRIES, frameDepth: 1,
            };

            // FIX 10: write immediately — result can be GC'd after this line
            csv?.append(r);

            if (r.status === 'Pass') cntPassed++; else cntFailed++;
            if (r.retries > 0)       cntRetried++;
            if (r.frameDepth === 2)  cntNested++;

            const log = [
                `${label} → ${r.status}`,
                r.retries > 0     ? ` [retried ${r.retries}×]`  : '',
                r.frameDepth === 2 ? ' [nested iframe]'          : '',
                r.status === 'Fail' ? ` | Gate ${r.gate}: ${r.errorLabel}` : '',
            ].join('');
            console.log(log);
        },
        STAGGER_MS
    );

    // ── Close CSV ─────────────────────────────────────────────────────────────
    if (csv) {
        try {
            const rows = csv.close();
            console.log(`\n📄 CSV saved: ${csvPath} (${rows} rows)`);
        } catch (e: any) {
            console.warn(`⚠️ CSV close failed: ${e.message}`);
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(
        `\n### [${vendorName}] Summary: ${cntPassed} passed, ${cntFailed} failed / ` +
        `${games.length} total  (${cntRetried} retried, ${cntNested} nested-iframe)\n`
    );
}

// ── Single game validation (4 gates) ─────────────────────────────────────────

async function validateSingleGame(
    page: Page,
    credential: S9Credential,
    game: GameInfo,
    vendorId: number,
): Promise<GameResult> {
    const pass = (frameDepth = 1): GameResult => ({
        gameId: game.game_id, gameName: game.name, status: 'Pass',
        gate: 0, errorLabel: '', retries: 0, frameDepth,
    });
    const fail = (gate: number, label: string, frameDepth = 1): GameResult => ({
        gameId: game.game_id, gameName: game.name, status: 'Fail',
        gate, errorLabel: label, retries: 0, frameDepth,
    });

    // ── Gate 1: API Entry ─────────────────────────────────────────────────────
    let redirectUrl: string;
    try {
        const res = await enterGame(credential, game.game_id, vendorId);
        if (res.code !== 1 || !res.redirect_url) {
            const isAuth = res.msg?.toLowerCase().includes('token') ||
                           res.msg?.toLowerCase().includes('login') ||
                           res.code === 401;
            if (isAuth) return fail(1, `AUTH_FAILURE: ${res.msg}`);
            return fail(1, `API Error (code=${res.code}): ${res.msg || 'no redirect_url'}`);
        }
        redirectUrl = res.redirect_url;
    } catch (e: any) {
        return fail(1, `API call failed: ${e.message.slice(0, 80)}`);
    }

    // ── Gate 2: iframe Load ───────────────────────────────────────────────────
    let iframeLoaded    = false;
    let iframeHttpError: number | null = null;
    const routeUrl      = 'https://s9.com/**';

    // Named refs required for finally cleanup (FIX 1, FIX 2)
    const routeHandler = (route: any) => route.fulfill({
        status: 200, contentType: 'text/html',
        body: '<!DOCTYPE html><html><head><style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden}</style></head><body></body></html>',
    });

    const responseHandler = (res: any) => {
        if (res.url() === redirectUrl && res.status() >= 400) iframeHttpError = res.status();
    };

    page.on('response', responseHandler);  // FIX 2: before try

    try {
        await page.route(routeUrl, routeHandler);

        try {
            await page.goto(`https://s9.com/games?ven_id=${vendorId}`, {
                waitUntil: 'domcontentloaded', timeout: 5000,
            });

            await page.evaluate((src: string) => {
                document.body.innerHTML = `<iframe id="gameframe" src="${src}"
                    style="width:100vw;height:100vh;border:none;display:block"
                    allowfullscreen
                    allow="autoplay; fullscreen; camera; microphone; accelerometer; gyroscope"
                ></iframe>`;
            }, redirectUrl);

            iframeLoaded = await page.frameLocator('#gameframe')
                .locator('body')
                .waitFor({ state: 'attached', timeout: 20000 })
                .then(() => true).catch(() => false);

        } finally {
            await page.unroute(routeUrl).catch(() => {});  // FIX 1
        }

    } catch (e: any) {
        return fail(2, `Connection Failed: ${e.message.slice(0, 80)}`);
    } finally {
        page.off('response', responseHandler);  // FIX 2
    }

    if (!iframeLoaded) {
        if (iframeHttpError) return fail(2, `HTTP Error (${iframeHttpError})`);
        return fail(2, 'iframe did not load in 20s (Connection Failed)');
    }

    // ── FIX 7: Resolve game frame (handles nested iframes) ───────────────────
    const { gameFrame, frameDepth } = await resolveGameFrame(page);

    // Top up remaining Gate 3 settle time after the nested-iframe probe
    const remainingSettle = Math.max(0, GATE3_SETTLE_MS - NESTED_IFRAME_DETECT_MS);
    if (remainingSettle > 0) await page.waitForTimeout(remainingSettle);

    // ── Gate 3: Error scan ────────────────────────────────────────────────────
    const gate3Error = await detectErrorText(page, gameFrame);
    if (gate3Error) return fail(3, `Game Error: "${gate3Error}"`, frameDepth);

    // ── Gate 4: Stability watch ───────────────────────────────────────────────
    const ticks = Math.floor(GATE4_DURATION_MS / GATE4_INTERVAL_MS);
    for (let tick = 0; tick < ticks; tick++) {
        await page.waitForTimeout(GATE4_INTERVAL_MS);
        const g4err = await detectErrorText(page, gameFrame);
        if (g4err) return fail(4, `Unstable: "${g4err}"`, frameDepth);
    }

    // ── Gate 4: Blank screen check ────────────────────────────────────────────
    const hasContent = await gameFrame
        .locator('body *:visible').first()
        .isVisible({ timeout: 1000 }).catch(() => false);
    if (!hasContent) return fail(4, 'Blank Screen (no visible content after game load)', frameDepth);

    return pass(frameDepth);
}

// ── FIX 7: Nested iframe resolver ────────────────────────────────────────────

async function resolveGameFrame(
    page: Page,
): Promise<{ gameFrame: FrameLocator; frameDepth: 1 | 2 }> {
    const outerFrame = page.frameLocator('#gameframe');

    // Step 1: is there a nested iframe at all?
    const hasNested = await outerFrame.locator('iframe').first()
        .waitFor({ state: 'attached', timeout: NESTED_IFRAME_DETECT_MS })
        .then(() => true).catch(() => false);

    if (!hasNested) return { gameFrame: outerFrame, frameDepth: 1 };

    // Step 2: does the outer body have real visible content (lobby shell)?
    const hasOuterContent = await outerFrame
        .locator('body > *:not(iframe):not(script):not(style):not(link):visible')
        .first().isVisible({ timeout: 300 }).catch(() => false);

    if (hasOuterContent) return { gameFrame: outerFrame, frameDepth: 1 };

    // Step 3: pure pass-through wrapper — descend to inner frame
    const innerFrame       = outerFrame.frameLocator('iframe');
    const innerBodyReady   = await innerFrame.locator('body')
        .waitFor({ state: 'attached', timeout: NESTED_IFRAME_DETECT_MS })
        .then(() => true).catch(() => false);

    // Fall back to outer if inner isn't ready — avoids false fail
    if (!innerBodyReady) return { gameFrame: outerFrame, frameDepth: 1 };

    return { gameFrame: innerFrame, frameDepth: 2 };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function detectErrorText(page: Page, gameFrame: FrameLocator): Promise<string | null> {
    const mainMatch = await page.getByText(ERROR_TEXT_PATTERN).first()
        .textContent({ timeout: 300 }).catch(() => null);
    if (mainMatch) return mainMatch.trim().slice(0, 100);

    const frameMatch = await gameFrame.getByText(ERROR_TEXT_PATTERN).first()
        .textContent({ timeout: 300 }).catch(() => null);
    if (frameMatch) return frameMatch.trim().slice(0, 100);

    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}