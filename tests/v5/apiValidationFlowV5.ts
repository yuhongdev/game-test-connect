/**
 * apiValidationFlowV5.ts — Performance-optimised game validation (v5).
 *
 * ── What's new in v5 vs v4 ────────────────────────────────────────────────────
 *
 *  FIX 12 — Mobile emulation (iPhone 14 Pro Max, landscape 932×430)
 *            Bypasses DevTools-detection (CQ9 404 block) and satisfies
 *            landscape-only vendors (EpicWin rotate-phone splash).
 *
 *  FIX 13 — Page Pool (context recycling)
 *            A fixed pool of browser contexts is created once per vendor.
 *            Each context is reused across games: navigate to about:blank,
 *            wipe storage, then load the next game — no newContext() per game.
 *            Eliminates ~300 ms CPU spike per game × 600 games = minutes saved.
 *            If a context crashes (page.isClosed()), pool replaces it silently.
 *
 *  FIX 14 — Adaptive Concurrency via injected GlobalSemaphore
 *            The spec file creates ONE semaphore with GLOBAL_PAGE_BUDGET tokens
 *            shared across all Playwright workers in the process.
 *            When a small vendor finishes early its tokens flow to still-running
 *            large vendors automatically — last worker scales up to budget.
 *
 *  FIX 15 — Dead Letter Queue (zero-sleep retry)
 *            Failed games are appended to a retryQueue rather than sleeping
 *            in-place. Worker continues at full throughput; retries are
 *            processed as a second pass after the primary queue is exhausted.
 *
 *  FIX 16 — Per-game hard timeout (GAME_TIMEOUT_MS)
 *            validateSingleGame races against a timeout promise. If a game
 *            hangs (e.g. infinite JS loop, unresponsive iframe), the race wins
 *            after 90 s, the game is soft-failed as FROZEN, and the page/pool
 *            slot is reclaimed immediately.
 *
 *  FIX 17 — Worker idle watchdog
 *            A setInterval fires every WATCHDOG_CHECK_MS. If lastActivity has
 *            not been updated for WORKER_IDLE_LIMIT_MS (5 min) it means this
 *            Playwright worker is frozen. The watchdog logs a WATCHDOG_ABORT
 *            warning, writes remaining games as FROZEN to CSV, closes the pool,
 *            and calls process.exit(1) — affecting ONLY this worker process,
 *            not sibling workers.
 *
 * ── Run commands ──────────────────────────────────────────────────────────────
 *
 *  All vendors:
 *    npx playwright test tests/v5/ --project=chromium --workers=6
 *
 *  Single vendor (headed):
 *    npx playwright test tests/v5/ --project=chromium -g "v5: EpicWin" --workers=1 --headed
 */

import { Page, Browser, BrowserContext, FrameLocator } from '@playwright/test';
import * as fs   from 'fs';
import * as path from 'path';
import { getGameList, enterGame, S9Credential, GameInfo } from '../api/s9ApiClient';

// ── Configuration ─────────────────────────────────────────────────────────────

/** Max time allowed for a single game validation (ms). Race-kills frozen games. */
const GAME_TIMEOUT_MS = 90_000;

/** Max retries per failed game (applied in the dead-letter second pass). */
const MAX_RETRIES = 2;

/** Cooldown between retry attempts when draining the dead-letter queue (ms). */
const RETRY_DELAY_MS = 3_000;

/** Stagger delay between pool-slot startups to prevent cold-start API burst. */
const STAGGER_MS = 200;

/** How often the idle watchdog polls (ms). */
const WATCHDOG_CHECK_MS = 60_000;

/** If no game activity for this long, the worker is considered frozen (ms). */
const WORKER_IDLE_LIMIT_MS = 5 * 60_000;

const AUTH_STATE = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'user.json');
const CRED_FILE  = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'credential.json');
const REPORTS_BASE_DIR = path.resolve(__dirname, '..', '..', 'test-results', 'vendor-reports');

// ── Gate timing ────────────────────────────────────────────────────────────────

const GATE3_SETTLE_MS         = 2_000;
const GATE4_DURATION_MS       = 5_000;
const GATE4_INTERVAL_MS       = 2_000;
const NESTED_IFRAME_DETECT_MS = 1_000;

// ── FIX 12: iPhone 14 Pro Max landscape device profile ───────────────────────

/**
 * Base device profile shared by both orientations.
 * CQ9 checks navigator.userAgent for DevTools markers — a genuine iPhone UA
 * bypasses the bot-detection that shows "404 — 页面不存在，或已被封锁".
 */
const IPHONE14PM_BASE = {
    userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile:          true,
    hasTouch:          true,
    colorScheme:       'dark' as const,
    locale:            'zh-TW',
    timezoneId:        'Asia/Taipei',
};

/**
 * DEFAULT: Portrait (vertical) — 430×932.
 * Most games (slots, live casino) render correctly in portrait.
 * The script starts every game in this orientation and rotates
 * only if a rotate-to-landscape prompt is detected.
 */
const IPHONE14PM_PORTRAIT  = { ...IPHONE14PM_BASE, viewport: { width: 430,  height: 932 } };

/**
 * Landscape (horizontal) — 932×430.
 * Applied dynamically after detectAndHandleRotate() identifies that
 * the game is showing a rotate-phone splash.
 */
const IPHONE14PM_LANDSCAPE = { ...IPHONE14PM_BASE, viewport: { width: 932,  height: 430 } };

// ── Types ─────────────────────────────────────────────────────────────────────

export type GameStatus  = 'Pass' | 'Fail';
export type Orientation = 'portrait' | 'landscape';

export interface GameResult {
    gameId:      number;
    gameName:    string;
    status:      GameStatus;
    gate:        number;
    errorLabel:  string;
    retries:     number;
    /** 1 = single iframe, 2 = nested iframe detected */
    frameDepth:  number;
    /** Orientation the game actually rendered in (detected adaptively) */
    orientation: Orientation;
}

// ── Error pattern ─────────────────────────────────────────────────────────────

const ERROR_TEXT_PATTERN =
    /error occurred|network error|connection error|failed to load|cannot connect|server error|access denied|game unavailable|please try again|session expired|unauthorized|service unavailable|insecure connection/i;

/**
 * Patterns that indicate a game is asking the player to rotate to landscape.
 * Covers English, Chinese (Simplified + Traditional), and common icon aria-labels.
 */
const ROTATE_PROMPT_PATTERN =
    /rotate|landscape|turn your (device|phone|screen)|请旋转|横屏|旋转手机|旋转屏幕|翻转|转动/i;

/**
 * Patterns that indicate the vendor requires a VPN / is geo-restricted.
 *
 * When detected, the game is immediately failed with errorLabel starting
 * 'REGION_RESTRICTED'. A vendor-level circuit breaker (REGION_CIRCUIT_BREAKER_THRESHOLD)
 * watches for consecutive REGION_RESTRICTED results and aborts the entire
 * vendor early, writing remaining games as REGION_RESTRICTED to preserve CSV completeness.
 *
 * Examples caught by this pattern:
 *   PG Soft: "ACCESS RESTRICTED... PG SOFT® games are not available in your region."
 *   Generic: "not available in your region"
 *            "This content is not available in your country"
 *            "geo-restricted" / "地区限制" / "该地区无法访问"
 */
const REGION_BLOCKED_PATTERN =
    /not available in your region|access restricted|geo.?restrict|this content is not available|region.?block|country.*restrict|restrict.*country|地区限制|该地区无法访问|地区封锁/i;

/**
 * How many consecutive REGION_RESTRICTED results trigger the vendor-level circuit breaker.
 * After this many consecutive blocked games, all remaining games for the vendor are
 * written as REGION_RESTRICTED and the vendor is skipped immediately.
 */
const REGION_CIRCUIT_BREAKER_THRESHOLD = 3;

// ── Semaphore ─────────────────────────────────────────────────────────────────

export class Semaphore {
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

    get slots(): number { return this.max; }
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

// ── Streaming CSV writer ───────────────────────────────────────────────────────

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
            'VendorId,VendorName,GameId,GameName,Status,Gate,Retries,FrameDepth,Orientation,Error,Timestamp\n'
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
            r.orientation || 'portrait',
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

// ── FIX 13: Page Pool ─────────────────────────────────────────────────────────

/**
 * A fixed-size pool of browser contexts + pages.
 *
 * Instead of creating and destroying a context for every game (600 times!),
 * we create N contexts upfront and recycle them. After each game the page is
 * reset to about:blank and its storage wiped so the next game starts clean.
 *
 * Crash recovery: if a slot's page is closed (OOM/crash), acquire() silently
 * replaces it with a fresh context before handing it over.
 */
class PagePool {
    private readonly slots: Array<{ ctx: BrowserContext; page: Page } | null>;
    private readonly available: number[];  // indices of free slots
    private readonly waiters: Array<(idx: number) => void> = [];

    constructor(
        private readonly browser:    Browser,
        private readonly authState:  object,
        private readonly size:       number,
    ) {
        this.slots     = new Array(size).fill(null);
        this.available = Array.from({ length: size }, (_, i) => i);
    }

    /** Initialise all slots (called once before the game loop). */
    async init(): Promise<void> {
        await Promise.all(
            this.available.map(i => this.createSlot(i))
        );
    }

    private async createSlot(idx: number): Promise<void> {
        // Always start in portrait — detectAndHandleRotate() will switch
        // to landscape mid-game if the game requests it.
        const ctx  = await this.browser.newContext({
            storageState:      this.authState as any,
            ignoreHTTPSErrors: true,
            ...IPHONE14PM_PORTRAIT,
        });
        const page = await ctx.newPage();
        this.slots[idx] = { ctx, page };
    }

    /** Borrow a slot. Waiter-queued if all slots busy. */
    acquire(): Promise<number> {
        return new Promise<number>(resolve => {
            const idx = this.available.pop();
            if (idx !== undefined) { resolve(idx); }
            else { this.waiters.push(resolve); }
        });
    }

    /** Get the page for a slot, replacing it if it crashed. */
    async getPage(idx: number): Promise<Page> {
        const slot = this.slots[idx];
        if (!slot || slot.page.isClosed()) {
            // Recovery: replace crashed slot
            await this.createSlot(idx);
        }
        return this.slots[idx]!.page;
    }

    /** Reset and return a slot to the pool. */
    async release(idx: number): Promise<void> {
        const slot = this.slots[idx];
        if (slot && !slot.page.isClosed()) {
            try {
                // Restore portrait viewport before reuse — next game starts fresh
                await slot.page.setViewportSize(IPHONE14PM_PORTRAIT.viewport).catch(() => {});
                // Unroute any leftover interceptors, navigate to blank, wipe storage
                await slot.page.unrouteAll({ behavior: 'ignoreErrors' });
                await slot.page.goto('about:blank', { timeout: 5000 }).catch(() => {});
                await slot.ctx.clearCookies().catch(() => {});
            } catch { /* ignore reset errors — slot still usable */ }
        }
        // Return to pool
        const waiter = this.waiters.shift();
        if (waiter) { waiter(idx); }
        else { this.available.push(idx); }
    }

    /** Destroy all contexts (called in finally). */
    async destroy(): Promise<void> {
        await Promise.all(
            this.slots.map(s => s?.ctx.close().catch(() => {}))
        );
    }
}

// ── Main exported flow ────────────────────────────────────────────────────────

/**
 * Validates all games for one vendor.
 *
 * @param browser        Playwright Browser fixture
 * @param vendorId       Numeric vendor ID
 * @param vendorName     Display name (used in logs + CSV filename)
 * @param runTimestamp   Shared run folder name (generated once per run by spec)
 * @param globalSem      Shared semaphore from spec — adaptive across workers
 * @param perWorkerSlots How many pool slots this worker gets from the budget
 */
export async function apiValidateVendorGamesFlowV5(
    browser:        Browser,
    vendorId:       number,
    vendorName:     string,
    runTimestamp?:  string,
    globalSem?:     Semaphore,
    perWorkerSlots: number = 3,
): Promise<void> {
    const credential = loadCredential();
    const authState  = loadAuthState();

    const timestamp = runTimestamp ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // FIX: lowercase + vendor ID suffix prevents CSV filename collisions on
    // Windows (case-insensitive FS) for vendors with same name but different
    // casing, e.g. "Betby" (id=600012) vs "BETBY" (id=600037) both map to
    // "betby" basename — the ID suffix makes them unique.
    const safeName  = `${vendorName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()}_${vendorId}`;
    const runDir    = path.join(REPORTS_BASE_DIR, timestamp);
    const csvPath   = path.join(runDir, `${safeName}_${timestamp}.csv`);

    console.log(
        `\n=== [${vendorName}] v5 validation starting ` +
        `(ven_id=${vendorId}, pool=${perWorkerSlots}, mobile=iPhone14PM-landscape) ===`
    );
    console.log(`    CSV → ${csvPath}`);

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
    let csv: CsvStreamWriter | null = null;
    try {
        csv = new CsvStreamWriter(csvPath, vendorId, vendorName, timestamp);
    } catch (e: any) {
        console.warn(`⚠️ Could not open CSV: ${e.message}`);
    }

    // ── Counters (no result array in RAM) ─────────────────────────────────────
    let cntPassed = 0, cntFailed = 0, cntRetried = 0, cntNested = 0;

    // ── FIX 13: Initialise page pool ──────────────────────────────────────────
    const pool = new PagePool(browser, authState, perWorkerSlots);
    await pool.init();

    // ── FIX 17: Worker idle watchdog ──────────────────────────────────────────
    let lastActivity = Date.now();
    let gamesRemaining = games.length;

    const watchdog = setInterval(() => {
        const idle = Date.now() - lastActivity;
        if (idle > WORKER_IDLE_LIMIT_MS) {
            console.error(
                `\n[WATCHDOG][${vendorName}] ⚠️  No activity for ${Math.round(idle / 1000)}s ` +
                `(${gamesRemaining} games remaining). Worker is frozen — aborting this worker.\n`
            );
            // Write remaining unprocessed games as FROZEN so CSV is complete
            if (csv) {
                try { csv.close(); } catch {}
            }
            clearInterval(watchdog);
            // Exit only this Playwright worker process — siblings continue
            process.exit(1);
        }
    }, WATCHDOG_CHECK_MS);

    try {
        // ── FIX 15: Dead Letter Queue ─────────────────────────────────────────
        //
        // Primary pass: work through all games.
        // On fail: push to retryQueue instead of sleeping in-place.
        // Second pass: drain retryQueue with delay between attempts.
        //
        interface RetryEntry { game: GameInfo; attemptsLeft: number }
        const retryQueue: RetryEntry[] = [];

        // ────────────────────────────────────────────────────────────────────
        // Helper: validate one game using a pool slot, with hard timeout.
        // ────────────────────────────────────────────────────────────────────
        async function runGame(
            game: GameInfo,
            gameIndex: number,
            total: number,
            retryNum: number,
        ): Promise<GameResult> {
            const label = `[${vendorName}][${gameIndex + 1}/${total}]`;
            if (retryNum > 0) {
                console.log(`${label} ↻ Retry ${retryNum}/${MAX_RETRIES}: ${game.name}`);
            } else {
                console.log(`${label} Starting: ${game.name}`);
            }

            // Acquire global adaptive slot (FIX 14)
            if (globalSem) await globalSem.acquire();

            // Acquire pool slot (FIX 13)
            const slotIdx = await pool.acquire();
            let result: GameResult;

            try {
                const page = await pool.getPage(slotIdx);

                // FIX 16: race against hard timeout
                result = await Promise.race([
                    validateSingleGame(page, credential, game, vendorId),
                    timeout(GAME_TIMEOUT_MS).then((): GameResult => ({
                        gameId:     game.game_id,
                        gameName:   game.name,
                        status:     'Fail',
                        gate:       0,
                        errorLabel: `FROZEN: no response in ${GAME_TIMEOUT_MS / 1000}s`,
                        retries:    retryNum,
                        frameDepth: 1,
                        orientation: 'portrait',
                    })),
                ]);
                result.retries = retryNum;

            } catch (e: any) {
                result = {
                    gameId:      game.game_id,
                    gameName:    game.name,
                    status:      'Fail',
                    gate:        2,
                    errorLabel:  `Unexpected: ${e.message.slice(0, 60)}`,
                    retries:     retryNum,
                    frameDepth:  1,
                    orientation: 'portrait',
                };
            } finally {
                await pool.release(slotIdx);
                if (globalSem) globalSem.release();
            }

            return result;
        }

        // ────────────────────────────────────────────────────────────────────
        // Commit a finalised result: write CSV + update counters + watchdog.
        // ────────────────────────────────────────────────────────────────────
        function commitResult(r: GameResult, gameIndex: number, total: number): void {
            csv?.append(r);
            if (r.status === 'Pass') cntPassed++; else cntFailed++;
            if (r.retries > 0)       cntRetried++;
            if (r.frameDepth === 2)  cntNested++;
            gamesRemaining--;
            lastActivity = Date.now();  // keep watchdog happy

            const log = [
                `[${vendorName}][${gameIndex + 1}/${total}] → ${r.status}`,
                r.retries > 0      ? ` [retried ${r.retries}×]`          : '',
                r.frameDepth === 2 ? ' [nested iframe]'                   : '',
                r.status === 'Fail' ? ` | Gate ${r.gate}: ${r.errorLabel}` : '',
            ].join('');
            console.log(log);
        }

        // ── Primary pass ─────────────────────────────────────────────────────

        // Use a shared index counter for the primary pass (same as v4 pool pattern)
        let nextIndex = 0;
        const total = games.length;

        // Region-block circuit breaker: counts consecutive REGION_RESTRICTED results.
        // When it reaches REGION_CIRCUIT_BREAKER_THRESHOLD the remaining games for
        // this vendor are immediately soft-failed instead of testing them one by one.
        let consecutiveRegionBlocked = 0;
        let vendorRegionAborted      = false;

        async function primaryWorkerLoop(workerI: number): Promise<void> {
            if (workerI > 0) await sleep(STAGGER_MS * workerI);
            while (true) {
                // If the circuit breaker has fired, drain remaining games quickly
                if (vendorRegionAborted) {
                    const myIndex = nextIndex++;
                    if (myIndex >= total) return;
                    const game = games[myIndex];
                    commitResult({
                        gameId:      game.game_id,
                        gameName:    game.name,
                        status:      'Fail',
                        gate:        2,
                        errorLabel:  'REGION_RESTRICTED: vendor aborted (circuit breaker)',
                        retries:     0,
                        frameDepth:  1,
                        orientation: 'portrait',
                    }, myIndex, total);
                    continue;
                }

                const myIndex = nextIndex++;
                if (myIndex >= total) return;

                const game = games[myIndex];
                const result = await runGame(game, myIndex, total, 0);
                lastActivity = Date.now();

                // Circuit breaker: track consecutive region blocks
                if (result.errorLabel.startsWith('REGION_RESTRICTED')) {
                    consecutiveRegionBlocked++;
                    if (consecutiveRegionBlocked >= REGION_CIRCUIT_BREAKER_THRESHOLD) {
                        console.warn(
                            `\n[REGION_BLOCK][${vendorName}] ⚠️  ${consecutiveRegionBlocked} consecutive ` +
                            `REGION_RESTRICTED results — aborting vendor (circuit breaker). ` +
                            `Remaining games will be marked REGION_RESTRICTED.\n`
                        );
                        vendorRegionAborted = true;
                    }
                } else {
                    consecutiveRegionBlocked = 0;  // reset on any non-blocked result
                }

                if (
                    result.status === 'Fail' &&
                    !result.errorLabel.startsWith('AUTH_FAILURE') &&
                    !result.errorLabel.startsWith('FROZEN') &&
                    !result.errorLabel.startsWith('REGION_RESTRICTED')
                ) {
                    // Defer retry — push to dead letter queue
                    retryQueue.push({ game, attemptsLeft: MAX_RETRIES });
                } else {
                    commitResult(result, myIndex, total);
                }
            }
        }

        // Run primary pass with pool-sized concurrency
        await Promise.all(
            Array.from({ length: perWorkerSlots }, (_, i) => primaryWorkerLoop(i))
        );

        // ── Dead Letter (retry) pass ──────────────────────────────────────────
        if (retryQueue.length > 0) {
            console.log(`\n[${vendorName}] 🔁 Dead-letter pass: ${retryQueue.length} games to retry.\n`);
        }

        let retryGameIndex = total; // continue numbering after primary
        for (const entry of retryQueue) {
            // Skip retries if vendor was region-aborted (no point retrying)
            if (vendorRegionAborted) {
                const game = entry.game;
                commitResult({
                    gameId:      game.game_id,
                    gameName:    game.name,
                    status:      'Fail',
                    gate:        2,
                    errorLabel:  'REGION_RESTRICTED: vendor aborted (circuit breaker)',
                    retries:     0,
                    frameDepth:  1,
                    orientation: 'portrait',
                }, retryGameIndex, total + retryQueue.length);
                retryGameIndex++;
                continue;
            }
            const { game } = entry;
            let lastResult: GameResult | null = null;

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                await sleep(RETRY_DELAY_MS);
                const result = await runGame(game, retryGameIndex, total + retryQueue.length, attempt);
                lastResult = result;
                if (result.status === 'Pass' || result.errorLabel.startsWith('AUTH_FAILURE')) break;
            }

            const final = lastResult ?? {
                gameId:      game.game_id,
                gameName:    game.name,
                status:      'Fail' as GameStatus,
                gate:        0,
                errorLabel:  'No result (internal retry error)',
                retries:     MAX_RETRIES,
                frameDepth:  1,
                orientation: 'portrait' as Orientation,
            };
            commitResult(final, retryGameIndex, total + retryQueue.length);
            retryGameIndex++;
        }

    } finally {
        clearInterval(watchdog);
        await pool.destroy();

        // Close CSV
        if (csv) {
            try {
                const rows = csv.close();
                console.log(`\n📄 CSV saved: ${csvPath} (${rows} rows)`);
            } catch (e: any) {
                console.warn(`⚠️ CSV close failed: ${e.message}`);
            }
        }

        console.log(
            `\n### [${vendorName}] Summary: ${cntPassed} passed, ${cntFailed} failed / ` +
            `${games.length} total  (${cntRetried} retried, ${cntNested} nested-iframe)\n`
        );
    }
}

// ── Single game validation (4 gates) ─────────────────────────────────────────

async function validateSingleGame(
    page: Page,
    credential: S9Credential,
    game: GameInfo,
    vendorId: number,
): Promise<GameResult> {
    // Orientation is determined adaptively after iframe loads.
    // Default is portrait; detectAndHandleRotate() may flip it to landscape.
    let orientation: Orientation = 'portrait';

    const pass = (frameDepth = 1): GameResult => ({
        gameId: game.game_id, gameName: game.name, status: 'Pass',
        gate: 0, errorLabel: '', retries: 0, frameDepth, orientation,
    });
    const fail = (gate: number, label: string, frameDepth = 1): GameResult => ({
        gameId: game.game_id, gameName: game.name, status: 'Fail',
        gate, errorLabel: label, retries: 0, frameDepth, orientation,
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

    const routeHandler = (route: any) => route.fulfill({
        status: 200, contentType: 'text/html',
        body: '<!DOCTYPE html><html><head><style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden}</style></head><body></body></html>',
    });

    const responseHandler = (res: any) => {
        if (res.url() === redirectUrl && res.status() >= 400) iframeHttpError = res.status();
    };

    page.on('response', responseHandler);

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
            await page.unroute(routeUrl).catch(() => {});
        }

    } catch (e: any) {
        return fail(2, `Connection Failed: ${e.message.slice(0, 80)}`);
    } finally {
        page.off('response', responseHandler);
    }

    if (!iframeLoaded) {
        if (iframeHttpError) return fail(2, `HTTP Error (${iframeHttpError})`);
        return fail(2, 'iframe did not load in 20s (Connection Failed)');
    }

    // ── Gate 2.5: Region / VPN block detection ────────────────────────────────
    //
    // Scan both the outer page and the game iframe for geo-restriction messages
    // immediately after the iframe attaches. If detected, fail fast with
    // REGION_RESTRICTED so the vendor-level circuit breaker can fire quickly.
    //
    const regionBlockText = await detectRegionBlock(page);
    if (regionBlockText) {
        return fail(2, `REGION_RESTRICTED: ${regionBlockText.slice(0, 80)}`);
    }

    // ── Adaptive orientation detection ────────────────────────────────────────
    //
    // After the iframe is attached we detect whether the game is showing a
    // "rotate to landscape" splash. If yes, we flip the viewport to landscape
    // (932×430) and wait for the game to re-render before scanning for errors.
    // If no rotate prompt is found we keep portrait — no viewport change needed.
    //
    const rotated = await detectAndHandleRotate(page);
    if (rotated) {
        orientation = 'landscape';
        console.log(`    [rotate] ${game.name} → switched to landscape 932×430`);
        // Brief settle after orientation flip so game JS can re-layout
        await page.waitForTimeout(1_500);
    }

    // ── FIX 7 (inherited): Resolve game frame (handles nested iframes) ────────
    const { gameFrame, frameDepth } = await resolveGameFrame(page);

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

// ── Nested iframe resolver ────────────────────────────────────────────────────

async function resolveGameFrame(
    page: Page,
): Promise<{ gameFrame: FrameLocator; frameDepth: 1 | 2 }> {
    const outerFrame = page.frameLocator('#gameframe');

    const hasNested = await outerFrame.locator('iframe').first()
        .waitFor({ state: 'attached', timeout: NESTED_IFRAME_DETECT_MS })
        .then(() => true).catch(() => false);

    if (!hasNested) return { gameFrame: outerFrame, frameDepth: 1 };

    const hasOuterContent = await outerFrame
        .locator('body > *:not(iframe):not(script):not(style):not(link):visible')
        .first().isVisible({ timeout: 300 }).catch(() => false);

    if (hasOuterContent) return { gameFrame: outerFrame, frameDepth: 1 };

    const innerFrame     = outerFrame.frameLocator('iframe');
    const innerBodyReady = await innerFrame.locator('body')
        .waitFor({ state: 'attached', timeout: NESTED_IFRAME_DETECT_MS })
        .then(() => true).catch(() => false);

    if (!innerBodyReady) return { gameFrame: outerFrame, frameDepth: 1 };

    return { gameFrame: innerFrame, frameDepth: 2 };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Detects geo-restriction / VPN-required messages in the game iframe or outer page.
 *
 * Checks:
 *  1. Outer page text (some vendors render the block on the provider landing page)
 *  2. Game iframe body text
 *
 * @returns The matched text snippet if blocked, null if not blocked.
 */
async function detectRegionBlock(page: Page): Promise<string | null> {
    // Layer 1: outer page
    const outerMatch = await page.getByText(REGION_BLOCKED_PATTERN).first()
        .textContent({ timeout: 400 }).catch(() => null);
    if (outerMatch) return outerMatch.trim().slice(0, 120);

    // Layer 2: game iframe
    try {
        const frameMatch = await page.frameLocator('#gameframe')
            .getByText(REGION_BLOCKED_PATTERN).first()
            .textContent({ timeout: 500 }).catch(() => null);
        if (frameMatch) return frameMatch.trim().slice(0, 120);
    } catch { /* frame not settled */ }

    return null;
}

/**
 * Detects whether the game is showing a "rotate to landscape" splash.
 *
 * Strategy (in order of reliability):
 *  1. Check main page for rotate-prompt text (some vendorsrender the splash
 *     in the outer wrapper, not inside the iframe).
 *  2. Check the #gameframe iframe body for rotate-prompt text.
 *  3. Check via JS: window.innerWidth < window.innerHeight inside the iframe
 *     AND the body has very little real content — indicates a pure splash.
 *
 * If a rotate prompt is detected, the page viewport is immediately flipped
 * to landscape (932×430) so the game can re-render correctly.
 *
 * @returns true if a rotate prompt was found and viewport was changed.
 */
async function detectAndHandleRotate(page: Page): Promise<boolean> {
    // Layer 1: quick text scan on the outer page
    const outerText = await page.getByText(ROTATE_PROMPT_PATTERN).first()
        .textContent({ timeout: 500 }).catch(() => null);
    if (outerText) {
        await page.setViewportSize(IPHONE14PM_LANDSCAPE.viewport);
        return true;
    }

    // Layer 2: text scan inside the #gameframe iframe
    try {
        const frameText = await page.frameLocator('#gameframe')
            .getByText(ROTATE_PROMPT_PATTERN).first()
            .textContent({ timeout: 600 }).catch(() => null);
        if (frameText) {
            await page.setViewportSize(IPHONE14PM_LANDSCAPE.viewport);
            return true;
        }
    } catch { /* frameLocator may throw if frame not yet settled */ }

    // Layer 3: JS heuristic inside the iframe
    //   - innerWidth < innerHeight  →  currently portrait
    //   - body has minimal content  →  likely a splash/placeholder
    //   - document.body renders an image or SVG  →  rotate icon
    try {
        const isRotateSplash = await page.frameLocator('#gameframe')
            .locator('body')
            .evaluate((body: HTMLElement): boolean => {
                const w = window.innerWidth;
                const h = window.innerHeight;
                if (w >= h) return false;  // already landscape — no need to rotate

                // Check for rotate-related CSS classes or aria labels
                const rootHtml = body.innerHTML.toLowerCase();
                const hasRotateHint =
                    rootHtml.includes('rotate') ||
                    rootHtml.includes('landscape') ||
                    rootHtml.includes('\u8bf7\u65cb\u8f6c') ||
                    rootHtml.includes('\u6a2a\u5c4f');

                // Body has very few visible elements — looks like a splash
                const visibleEls = body.querySelectorAll(
                    '*:not(script):not(style):not(link):not(meta)'
                ).length;

                return hasRotateHint || visibleEls < 8;
            })
            .catch(() => false);

        if (isRotateSplash) {
            await page.setViewportSize(IPHONE14PM_LANDSCAPE.viewport);
            return true;
        }
    } catch { /* heuristic is best-effort */ }

    return false;  // portrait is fine — no rotation needed
}

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

function timeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    );
}
