/**
 * apiValidationFlowV3.ts — Memory-safe game validation (v3, context-reuse edition).
 *
 * Target: 53 vendors · 6,000+ games · --workers=8 · 32 GB RAM
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ROOT CAUSE OF THE RAM BLOWOUT  (29.6 GB physical / 52.8 GB committed)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  The previous code created a NEW BrowserContext for every single game attempt.
 *  This has two fatal consequences on Windows at scale:
 *
 *  PROBLEM 1 — Windows commits virtual memory eagerly, releases it lazily.
 *    Each BrowserContext = one Chromium renderer subprocess.
 *    Windows commits 300–500 MB of virtual address space per renderer process
 *    on creation (code, heap, GPU buffers) before the page loads anything.
 *    context.close() requests a release, but Windows defers it to the next
 *    memory manager cycle. With 8 workers × 6 concurrent games, there are
 *    48 new+close cycles happening per second at peak. "Closed" processes pile
 *    up in the OS deallocation queue faster than Windows can process them.
 *    By vendor 37/53, committed memory hit 52.8 GB — beyond physical RAM —
 *    causing swap thrashing and the test appearing frozen.
 *
 *  PROBLEM 2 — context.close() silently stalls with no deadline.
 *    If a game's page.goto() or iframe waitFor() is mid-flight when context.close()
 *    is called, Playwright waits for the navigation to settle before tearing down.
 *    The catch(() => {}) in the finally block swallows the error, but the renderer
 *    process remains alive indefinitely, never releasing its committed memory.
 *
 *  PROBLEM 3 — The spec's beforeEach uses { page }, creating an extra context.
 *    The { page } fixture spins up an additional browser context per vendor test.
 *    With 8 workers, that's 8 extra renderer processes doing nothing for the
 *    entire duration of each vendor run — pure wasted memory.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE FIX — Persistent ContextSlot (one context per worker, reused per game)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Each of the MAX_CONCURRENT_GAMES worker slots owns ONE BrowserContext for
 *  its entire lifetime (all games in the vendor run). Between games:
 *    1. page.unrouteAll()   — clears route handlers from the previous game
 *    2. page.goto('about:blank') — releases the game's DOM + renderer heap (~50ms)
 *    3. Start next game on the same page
 *
 *  A new context is only created when corruption is detected (thrown error,
 *  hard timeout, CDP disconnect). Even then, the old context is closed with
 *  a bounded 3-second deadline — if it doesn't close in time, it's abandoned.
 *
 *  Result:
 *    Renderer processes alive = 8 workers × MAX_CONCURRENT_GAMES = CONSTANT
 *    No deallocation queue buildup. Committed memory stays flat.
 *
 *  At MAX_CONCURRENT_GAMES=3, --workers=8:
 *    8 × 3 = 24 renderer processes × ~350 MB committed = ~8.4 GB committed
 *    Physical: ~4.8 GB active  (vs 52.8 GB committed previously)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ADDITIONAL FIXES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  FIX A — Hard per-game wall-clock timeout (GAME_HARD_TIMEOUT_MS)
 *    Each game races against a hard timeout covering all retry attempts.
 *    If it fires, the game is recorded as Fail and the slot is marked dirty
 *    (context replaced before the next game). One hung game server can no
 *    longer permanently stall a worker slot.
 *
 *  FIX B — Inter-game breathing room (INTER_GAME_YIELD_MS)
 *    After each game, the worker sleeps briefly before pulling the next.
 *    This gives Node.js GC time to collect the game's JS objects, and gives
 *    the OS time to process the about:blank navigation's deferred releases.
 *    At 80ms yield with ~7s average games, overhead is ~1%.
 *
 *  FIX C — Spec file: remove { page } from beforeEach
 *    See updated s9_test_v3.spec.ts. The { page } fixture must be removed
 *    so no extra context is created per vendor test.
 *
 *  All previous fixes retained:
 *    Worker pool (not Promise.all on N games), streaming CSV, auth state loaded
 *    once, game-list retry, sleep() not waitForTimeout(), response listener in
 *    finally, progress log deduplication, rate-limit monitor.
 */

import { Page, Browser, BrowserContext } from '@playwright/test';
import * as fs   from 'fs';
import * as path from 'path';
import { getGameList, enterGame, S9Credential, GameInfo } from '../api/s9ApiClient';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Persistent context slots per Playwright vendor worker.
 *
 * This is a HARD CEILING on renderer processes, not a soft concurrency cap.
 * Total alive = --workers × MAX_CONCURRENT_GAMES = CONSTANT throughout the run.
 *
 * Safe values for --workers=8 on a 32 GB machine:
 *   3 → 24 processes · ~8 GB committed  ← start here (very safe)
 *   4 → 32 processes · ~11 GB committed ← increase once confirmed stable
 *   5 → 40 processes · ~14 GB committed
 *   6 → 48 processes · ~17 GB committed ← max for 32 GB at 8 workers
 */
const MAX_CONCURRENT_GAMES = 3;

/**
 * Hard wall-clock deadline per game including all retry attempts (ms).
 * Worst case: 3 attempts × 28s + 2 × 3s cooldown = ~90s. Set to 120s.
 * If this fires: game is Fail, slot is marked dirty, context replaced next game.
 */
const GAME_HARD_TIMEOUT_MS = 120_000;

/**
 * Milliseconds to yield between games (breathing room for GC + OS memory).
 * Gives Node.js GC time to free the game's JS objects, and gives Windows
 * memory manager time to process the about:blank navigation's deferred releases.
 * 80ms × 3 slots = 240ms per slot-round. Overhead ~1% on 7s average games.
 */
const INTER_GAME_YIELD_MS = 80;

/**
 * How long to wait for context.close() before abandoning it (ms).
 * Prevents a hung page from blocking a slot from getting its replacement context.
 */
const CONTEXT_CLOSE_TIMEOUT_MS = 3_000;

/**
 * Retry attempts for transient game failures.
 * Reduced to 1: with context reuse, transient errors are less common.
 * The context is already warm, so transient network errors are the main cause.
 * Increase to 2 if false-fail rates are high on your game servers.
 */
const MAX_RETRIES    = 1;
const RETRY_DELAY_MS = 3_000;

const GAME_LIST_RETRIES     = 3;
const GAME_LIST_RETRY_DELAY = 4_000;

/** Cold-start stagger between slot launches (ms). Slot N waits N × STAGGER_MS. */
const STAGGER_MS = 300;

/** Progress snapshot every N completed games. 0 = disable. */
const PROGRESS_EVERY_N = 20;

const RATE_WINDOW_SIZE     = 20;
const RATE_LIMIT_THRESHOLD = 0.25;
const RATE_BACKOFF_MS      = 500;
const RATE_MIN_SAMPLES     = 3;

// ── Gate timing ───────────────────────────────────────────────────────────────

const GATE3_SETTLE_MS   = 2_000;
const GATE4_DURATION_MS = 5_000;
const GATE4_INTERVAL_MS = 2_000;

// ── Paths ─────────────────────────────────────────────────────────────────────

const AUTH_STATE_PATH = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'user.json');
const CRED_FILE       = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'credential.json');
const REPORTS_DIR     = path.resolve(__dirname, '..', '..', 'test-results', 'vendor-reports');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type GameStatus = 'Pass' | 'Fail';

export interface GameResult {
    gameId:     number;
    gameName:   string;
    status:     GameStatus;
    gate:       number;
    errorLabel: string;
    retries:    number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RATE-LIMIT MONITOR
// ═══════════════════════════════════════════════════════════════════════════════

class RateLimitMonitor {
    private readonly window: boolean[] = [];

    record(wasRateLimited: boolean): void {
        this.window.push(wasRateLimited);
        if (this.window.length > RATE_WINDOW_SIZE) this.window.shift();
    }

    extraStagger(): number {
        if (this.window.length < RATE_MIN_SAMPLES) return 0;
        const rate = this.window.filter(Boolean).length / this.window.length;
        return rate > RATE_LIMIT_THRESHOLD ? RATE_BACKOFF_MS : 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED GAME INDEX
// ═══════════════════════════════════════════════════════════════════════════════

class SharedIndex {
    private cursor = 0;
    constructor(private readonly total: number) {}
    next(): number | null {
        return this.cursor < this.total ? this.cursor++ : null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOADERS
// ═══════════════════════════════════════════════════════════════════════════════

function loadCredential(): S9Credential {
    if (!fs.existsSync(CRED_FILE)) {
        throw new Error(`credential.json not found at ${CRED_FILE}.\nRun: npx playwright test --project=setup`);
    }
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) as S9Credential;
}

function loadAuthState(): object {
    if (!fs.existsSync(AUTH_STATE_PATH)) {
        throw new Error(`user.json not found at ${AUTH_STATE_PATH}.\nRun: npx playwright test --project=setup`);
    }
    return JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf8'));
}

async function getGameListWithRetry(
    credential: S9Credential,
    vendorId:   number,
    vendorName: string,
): Promise<GameInfo[] | null> {
    for (let attempt = 1; attempt <= GAME_LIST_RETRIES; attempt++) {
        try {
            return await getGameList(credential, vendorId);
        } catch (e: any) {
            const isLast = attempt === GAME_LIST_RETRIES;
            console.warn(
                `[${vendorName}] ⚠ Game list fetch failed ` +
                `(attempt ${attempt}/${GAME_LIST_RETRIES}): ${(e as Error).message}` +
                (isLast ? ' — skipping vendor.' : ` — retrying in ${GAME_LIST_RETRY_DELAY}ms…`)
            );
            if (isLast) return null;
            await sleep(GAME_LIST_RETRY_DELAY);
        }
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const ERROR_TEXT_PATTERN =
    /error occurred|network error|connection error|failed to load|cannot connect|server error|access denied|game unavailable|please try again|session expired|unauthorized|service unavailable|insecure connection/i;

async function detectErrorText(page: Page): Promise<string | null> {
    const mainMatch = await page
        .getByText(ERROR_TEXT_PATTERN).first()
        .textContent({ timeout: 300 })
        .catch(() => null);
    if (mainMatch) return mainMatch.trim().slice(0, 100);

    const frameMatch = await page
        .frameLocator('#gameframe').getByText(ERROR_TEXT_PATTERN).first()
        .textContent({ timeout: 300 })
        .catch(() => null);
    if (frameMatch) return frameMatch.trim().slice(0, 100);

    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT SLOT — one persistent context per worker slot, reused across all games
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Owns exactly one BrowserContext for the duration of a vendor run.
 *
 * Between games: navigates to about:blank (frees the game's DOM + renderer heap)
 * and clears route handlers. Cost: ~50ms. No renderer process created or destroyed.
 *
 * Context is replaced only on:
 *   - Slot startup (initial creation)
 *   - Corruption detected (validateSingleGame threw, page in bad state)
 *   - Hard timeout fired (game exceeded GAME_HARD_TIMEOUT_MS)
 * Even then, the old context is closed with a 3s deadline to avoid blocking.
 */
class ContextSlot {
    private context: BrowserContext | null = null;
    private page:    Page | null           = null;
    private dirty                          = true;

    constructor(
        private readonly browser:   Browser,
        private readonly authState: object,
    ) {}

    async getPage(): Promise<Page> {
        if (this.dirty || !this.context || !this.page) {
            await this.replaceContext();
        } else {
            const cleared = await this.clearPage();
            if (!cleared) await this.replaceContext();
        }
        return this.page!;
    }

    markDirty(): void { this.dirty = true; }

    async dispose(): Promise<void> {
        await this.closeWithDeadline();
        this.context = null;
        this.page    = null;
    }

    // ── Private ─────────────────────────────────────────────────────────────

    private async clearPage(): Promise<boolean> {
        try {
            await this.page!.unrouteAll({ behavior: 'ignoreErrors' });
            await this.page!.goto('about:blank', {
                waitUntil: 'domcontentloaded',
                timeout:   5_000,
            });
            return true;
        } catch {
            return false;
        }
    }

    private async replaceContext(): Promise<void> {
        await this.closeWithDeadline();
        // Brief pause before allocating a new renderer process — lets Windows
        // finish processing the previous close before committing more memory.
        await sleep(150);
        this.context = await this.browser.newContext({
            storageState:      this.authState as any,
            ignoreHTTPSErrors: true,
        });
        this.page  = await this.context.newPage();
        this.dirty = false;
    }

    private async closeWithDeadline(): Promise<void> {
        if (!this.context) return;
        const old    = this.context;
        this.context = null;
        this.page    = null;
        // Race: close vs deadline. Either way, we move on.
        await Promise.race([
            old.close().catch(() => {}),
            sleep(CONTEXT_CLOSE_TIMEOUT_MS),
        ]);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4-GATE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

async function validateSingleGame(
    page:       Page,
    credential: S9Credential,
    game:       GameInfo,
    vendorId:   number,
): Promise<GameResult> {
    const pass = (): GameResult => ({
        gameId: game.game_id, gameName: game.name,
        status: 'Pass', gate: 0, errorLabel: '', retries: 0,
    });
    const fail = (gate: number, label: string): GameResult => ({
        gameId: game.game_id, gameName: game.name,
        status: 'Fail', gate, errorLabel: label, retries: 0,
    });

    // ── Gate 1: API Entry ─────────────────────────────────────────────────────
    let redirectUrl: string;
    try {
        const res = await enterGame(credential, game.game_id, vendorId);
        if (res.code !== 1 || !res.redirect_url) {
            const isAuth =
                res.msg?.toLowerCase().includes('token') ||
                res.msg?.toLowerCase().includes('login') ||
                res.code === 401;
            return isAuth
                ? fail(1, `AUTH_FAILURE: ${res.msg}`)
                : fail(1, `API Error (code=${res.code}): ${res.msg || 'no redirect_url'}`);
        }
        redirectUrl = res.redirect_url;
    } catch (e: any) {
        return fail(1, `API call failed: ${(e as Error).message.slice(0, 80)}`);
    }

    // ── Gate 2: Iframe load via HTTPS parent stub ─────────────────────────────
    let iframeLoaded    = false;
    let iframeHttpError: number | null = null;

    const responseHandler = (res: any) => {
        if (res.url() === redirectUrl && res.status() >= 400) {
            iframeHttpError = res.status();
        }
    };

    try {
        page.on('response', responseHandler);

        await page.route('https://s9.com/**', route => route.fulfill({
            status:      200,
            contentType: 'text/html',
            body: '<!DOCTYPE html><html><head><style>' +
                  '*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden}' +
                  '</style></head><body></body></html>',
        }));

        await page.goto(`https://s9.com/games?ven_id=${vendorId}`, {
            waitUntil: 'domcontentloaded',
            timeout:   5_000,
        });

        await page.evaluate((src: string) => {
            document.body.innerHTML =
                `<iframe id="gameframe" src="${src}"
                    style="width:100vw;height:100vh;border:none;display:block"
                    allowfullscreen
                    allow="autoplay; fullscreen; camera; microphone; accelerometer; gyroscope"
                ></iframe>`;
        }, redirectUrl);

        iframeLoaded = await page
            .frameLocator('#gameframe').locator('body')
            .waitFor({ state: 'attached', timeout: 20_000 })
            .then(() => true)
            .catch(() => false);

    } catch (e: any) {
        return fail(2, `Connection Failed: ${(e as Error).message.slice(0, 80)}`);
    } finally {
        // CRITICAL on reused pages: listener MUST be removed every time.
        // Without this, each game adds another listener on the same page object,
        // causing the array to grow unbounded across hundreds of games.
        page.off('response', responseHandler);
    }

    if (!iframeLoaded) {
        return iframeHttpError
            ? fail(2, `HTTP Error (${iframeHttpError})`)
            : fail(2, 'iframe did not load in 20s (Connection Failed)');
    }

    // ── Gate 3: Immediate error scan ──────────────────────────────────────────
    await sleep(GATE3_SETTLE_MS);
    const gate3Error = await detectErrorText(page);
    if (gate3Error) return fail(3, `Game Error: "${gate3Error}"`);

    // ── Gate 4: Stability watch ───────────────────────────────────────────────
    // sleep() is a macrotask — the event loop runs other slots' I/O between ticks.
    // waitForTimeout() (v2 style) would stall this slot's event loop processing.
    for (let tick = 0; tick < Math.floor(GATE4_DURATION_MS / GATE4_INTERVAL_MS); tick++) {
        await sleep(GATE4_INTERVAL_MS);
        const err = await detectErrorText(page);
        if (err) return fail(4, `Unstable: "${err}"`);
    }

    const hasContent = await page
        .frameLocator('#gameframe').locator('body *:visible').first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
    if (!hasContent) return fail(4, 'Blank Screen (no visible content after game load)');

    return pass();
}

// ═══════════════════════════════════════════════════════════════════════════════
// RETRY WRAPPER — with hard timeout over all attempts
// ═══════════════════════════════════════════════════════════════════════════════

async function runWithRetry(
    slot:       ContextSlot,
    game:       GameInfo,
    vendorId:   number,
    credential: S9Credential,
    rateMon:    RateLimitMonitor,
    slotLabel:  string,
): Promise<GameResult> {
    let timedOut = false;
    let lastResult: GameResult = {
        gameId: game.game_id, gameName: game.name,
        status: 'Fail', gate: 0,
        errorLabel: 'Hard timeout — slot context replaced',
        retries: MAX_RETRIES,
    };

    const gameWork = async (): Promise<GameResult> => {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (timedOut) break;
            if (attempt > 0) {
                console.log(`${slotLabel} ↻ Retry ${attempt}/${MAX_RETRIES}: ${game.name}`);
                await sleep(RETRY_DELAY_MS);
                if (timedOut) break;
            }

            try {
                const page   = await slot.getPage();
                const result = await validateSingleGame(page, credential, game, vendorId);
                result.retries = attempt;
                lastResult     = result;

                rateMon.record(result.errorLabel.includes('code=429'));

                if (result.status === 'Pass' || result.errorLabel.startsWith('AUTH_FAILURE')) {
                    return result;
                }
                if (attempt >= MAX_RETRIES) return result;

            } catch (e: any) {
                slot.markDirty();
                lastResult = {
                    gameId:     game.game_id,
                    gameName:   game.name,
                    status:     'Fail',
                    gate:       2,
                    errorLabel: `Unexpected: ${(e as Error).message.slice(0, 60)}`,
                    retries:    attempt,
                };
                rateMon.record(false);
                if (attempt >= MAX_RETRIES) return lastResult;
            }
        }
        return lastResult;
    };

    return Promise.race([
        gameWork(),
        sleep(GAME_HARD_TIMEOUT_MS).then((): GameResult => {
            timedOut = true;
            slot.markDirty();
            console.warn(`${slotLabel} ⏱ Hard timeout (${GAME_HARD_TIMEOUT_MS / 1000}s): ${game.name}`);
            return {
                gameId:     game.game_id,
                gameName:   game.name,
                status:     'Fail',
                gate:       2,
                errorLabel: `Hard timeout (>${GAME_HARD_TIMEOUT_MS / 1000}s)`,
                retries:    MAX_RETRIES,
            };
        }),
    ]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STREAMING CSV WRITER
// ═══════════════════════════════════════════════════════════════════════════════

class CsvStreamWriter {
    private readonly stream:     fs.WriteStream;
    private readonly vendorId:   number;
    private readonly vendorName: string;

    constructor(csvPath: string, vendorId: number, vendorName: string) {
        fs.mkdirSync(path.dirname(csvPath), { recursive: true });
        this.stream     = fs.createWriteStream(csvPath, { encoding: 'utf8', flags: 'w' });
        this.vendorId   = vendorId;
        this.vendorName = vendorName;
        this.stream.write('VendorId,VendorName,GameId,GameName,Status,Gate,Retries,Error,Timestamp\n');
    }

    appendRow(r: GameResult, timestamp: string): void {
        this.stream.write(
            [
                this.vendorId,
                `"${this.vendorName}"`,
                r.gameId,
                `"${r.gameName.replace(/"/g, '""')}"`,
                r.status,
                r.gate || '',
                r.retries,
                `"${(r.errorLabel || '').replace(/"/g, '""')}"`,
                timestamp,
            ].join(',') + '\n'
        );
    }

    close(): Promise<void> {
        return new Promise((resolve, reject) =>
            this.stream.end((err: any) => (err ? reject(err) : resolve()))
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER POOL
// ═══════════════════════════════════════════════════════════════════════════════

async function runWorkerPool(
    browser:    Browser,
    games:      GameInfo[],
    vendorId:   number,
    vendorName: string,
    credential: S9Credential,
    authState:  object,
    csvWriter:  CsvStreamWriter,
    timestamp:  string,
): Promise<GameResult[]> {
    const results: GameResult[] = new Array(games.length);
    const queue                 = new SharedIndex(games.length);
    const rateMon               = new RateLimitMonitor();
    let completed = 0, passed = 0, failed = 0, lastMilestone = 0;

    async function workerSlot(slotId: number): Promise<void> {
        if (slotId > 0) await sleep(slotId * STAGGER_MS);

        // One persistent context for this slot's entire vendor run
        const slot = new ContextSlot(browser, authState);
        try {
            while (true) {
                const idx = queue.next();
                if (idx === null) break;

                const game      = games[idx];
                const slotLabel = `[${vendorName}][${idx + 1}/${games.length}][s${slotId}]`;

                const extraMs = rateMon.extraStagger();
                if (extraMs > 0) await sleep(extraMs);

                const result = await runWithRetry(slot, game, vendorId, credential, rateMon, slotLabel);

                results[idx] = result;
                completed++;
                if (result.status === 'Pass') passed++; else failed++;
                csvWriter.appendRow(result, timestamp);

                if (result.status === 'Fail') {
                    console.log(
                        `${slotLabel} ✗ Gate ${result.gate}: ${result.errorLabel}` +
                        (result.retries > 0 ? ` [retried ${result.retries}×]` : '')
                    );
                } else if (result.retries > 0) {
                    console.log(`${slotLabel} ✅ Pass [retried ${result.retries}×]: ${game.name}`);
                }

                if (PROGRESS_EVERY_N > 0) {
                    const m = Math.floor(completed / PROGRESS_EVERY_N);
                    if (m > lastMilestone) {
                        lastMilestone = m;
                        const pct = ((completed / games.length) * 100).toFixed(1);
                        console.log(`[${vendorName}] ── ${completed}/${games.length} (${pct}%)  ✅ ${passed}  ✗ ${failed}`);
                    }
                }

                // Breathing room: GC + OS memory manager between games
                await sleep(INTER_GAME_YIELD_MS);
            }
        } finally {
            await slot.dispose();
        }
    }

    const slotCount = Math.min(MAX_CONCURRENT_GAMES, games.length);
    await Promise.all(Array.from({ length: slotCount }, (_, id) => workerSlot(id)));
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXPORTED FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

export async function apiValidateVendorGamesFlowV3(
    browser:    Browser,
    vendorId:   number,
    vendorName: string,
): Promise<void> {
    const credential = loadCredential();
    const authState  = loadAuthState();

    const games = await getGameListWithRetry(credential, vendorId, vendorName);
    if (!games) return;
    if (games.length === 0) {
        console.warn(`[${vendorName}] ⚠ No active games — skipping.`);
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName  = vendorName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const csvPath   = path.join(REPORTS_DIR, `${safeName}_${timestamp}.csv`);

    console.log(
        `\n=== [${vendorName}] v3 starting ` +
        `(ven_id=${vendorId}, games=${games.length}, slots=${MAX_CONCURRENT_GAMES}) ===`
    );

    const csvWriter = new CsvStreamWriter(csvPath, vendorId, vendorName);
    let results: GameResult[];
    try {
        results = await runWorkerPool(browser, games, vendorId, vendorName, credential, authState, csvWriter, timestamp);
    } finally {
        await csvWriter.close().catch(e =>
            console.warn(`[${vendorName}] ⚠ CSV close error: ${(e as Error).message}`)
        );
    }

    const validResults = results.filter(Boolean);
    const passed       = validResults.filter(r => r.status === 'Pass').length;
    const failed       = validResults.filter(r => r.status === 'Fail').length;
    const retried      = validResults.filter(r => r.retries > 0).length;

    console.log(
        `\n### [${vendorName}] Complete — ` +
        `${passed} passed · ${failed} failed · ${validResults.length} total` +
        (retried > 0 ? ` · ${retried} retried` : '')
    );

    const failedResults = validResults.filter(r => r.status === 'Fail');
    if (failedResults.length > 0) {
        console.log('\nFailed games:');
        console.log('| Game | Gate | Retries | Error |');
        console.log('|------|------|---------|-------|');
        for (const r of failedResults) {
            console.log(`| ${r.gameName} | ${r.gate} | ${r.retries} | ${r.errorLabel} |`);
        }
    }
    console.log(`\n📄 CSV: ${csvPath}\n`);
}