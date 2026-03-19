/**
 * apiValidationFlowV3.ts — Production-scale game validation (v3).
 *
 * Designed for: 53 vendors · 6,000+ games · 14 parallel workers · 32 GB RAM
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * FIXES FROM v2
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  FIX 1 — Race condition on results array
 *    v2:  concurrent push()           ← unordered, unsafe
 *    v3:  results[globalIndex] = r    ← pre-sized, index-safe
 *
 *  FIX 2 — Semaphore re-created per super-batch
 *    v2:  new Semaphore() inside for-loop
 *    v3:  single Semaphore for the full vendor run
 *
 *  FIX 3 — Browser context opened before retry-eligibility check
 *    v2:  always opens context first, then checks
 *    v3:  AUTH_FAILURE short-circuits — no wasted context open
 *
 *  FIX 4 — Gate 4 blocks the event loop
 *    v2:  waitForTimeout() — stalls event loop 5s per game
 *    v3:  sleep() — macrotask yield, other games' I/O runs freely
 *
 *  FIX 5 — Response listener leak
 *    v2:  page.on('response') removed only on happy path
 *    v3:  always removed in finally block
 *
 *  FIX 6 — Blunt 5s super-batch cooldown
 *    v2:  flat sleep(5000) between every 50 games
 *    v3:  removed — semaphore already caps load
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * NEW IN v3 (scale improvements for 6,000+ games / 53 vendors)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  NEW 1 — Worker pool replaces Promise.all(games.map(...))
 *    Promise.all on N games allocates N Promises immediately regardless of
 *    concurrency limits. For a vendor with 300 games: 294 idle Promises consuming
 *    heap memory and pressuring GC throughout the entire run.
 *    v3: exactly MAX_CONCURRENT_GAMES worker loops share a SharedIndex counter.
 *    Only MAX_CONCURRENT_GAMES Promises ever exist at once, regardless of
 *    total game count. The difference compounds across 53 vendors.
 *
 *  NEW 2 — Streaming CSV (append per game, not bulk at end)
 *    v2 buffered all results in memory and wrote one block at end. A crash at
 *    game 299/300 lost everything.
 *    v3: WriteStream opened at startup, one row appended per finished game.
 *    Partial results survive crashes and token-expiry mid-run.
 *
 *  NEW 3 — Auth state loaded once into memory
 *    v2: storageState: AUTH_STATE_PATH passed to every newContext() call.
 *    Playwright reads and parses user.json on each invocation.
 *    At 6,000 games × 3 retries = up to 18,000 redundant disk reads per run.
 *    v3: user.json read and parsed once per vendor call; object reused.
 *
 *  NEW 4 — Structured progress logging
 *    v2: 2 log lines per game = ~12,000 lines per full run.
 *    v3: only failures, retried passes, and snapshots every PROGRESS_EVERY_N games.
 *    Terminal and CI logs stay readable at any scale.
 *
 *  NEW 5 — Adaptive rate-limit back-pressure (improved in v3.1)
 *    Rolling window tracks 429 error rate. If it exceeds the threshold, workers
 *    add RATE_BACKOFF_MS stagger before each game — prevents 429 cascades.
 *    IMPROVEMENT: back-pressure now activates as soon as any 429s are seen,
 *    not only after the window fills (fixed cold-window dead zone from v3.0).
 *
 *  NEW 6 — Game-list fetch retry
 *    v2/v3.0: a single network hiccup during getGameList silently skipped the
 *    entire vendor with no recovery attempt.
 *    v3: getGameList is retried up to GAME_LIST_RETRIES times before giving up.
 *    At 53 vendors, this prevents losing a full vendor's results to a transient
 *    API blip that would have resolved within seconds.
 *
 *  NEW 7 — Progress counter deduplication
 *    v3.0: multiple workers could both increment `completed` past a PROGRESS_EVERY_N
 *    boundary in the same event loop turn, causing duplicate progress lines.
 *    v3: progress log uses a lastProgressMilestone check — only fires once per N.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   apiValidateVendorGamesFlowV3()   — one call per vendor / one Playwright worker
 *   │
 *   ├─ loadCredential() + loadAuthState()   ← parsed once, reused per game
 *   ├─ getGameListWithRetry()               ← retried on transient failure
 *   ├─ CsvStreamWriter(csvPath)             ← streaming CSV, open for full run
 *   │
 *   └─ runWorkerPool()
 *        │
 *        │  SharedIndex   ← atomic next-game counter (JS is single-threaded)
 *        │  RateLimitMonitor ← sliding-window 429 tracker shared by all workers
 *        │
 *        ├─ worker-0  loop: pull → fresh context → 4 gates → CSV row → close
 *        ├─ worker-1  loop: pull → fresh context → 4 gates → CSV row → close
 *        ├─ worker-2  loop: pull → fresh context → 4 gates → CSV row → close
 *        └─ worker-N  (N = MAX_CONCURRENT_GAMES, max 6 by default)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * MEMORY MODEL  (14 workers × 53 vendors × 6,000+ games)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   Per vendor worker at peak:
 *     MAX_CONCURRENT_GAMES browser contexts × ~200 MB  =   1.2 GB
 *     results[] (e.g. 300 entries × ~100 B)            = ~0.03 MB  (negligible)
 *     Live Promise overhead (exactly MAX_CONCURRENT)   = ~0.1  MB
 *       (vs ~18–30 MB with Promise.all on 300 games)
 *
 *   14 workers × 1.2 GB = 16.8 GB peak RAM   (unchanged from v2)
 *   Zero context accumulation — every context closed in finally.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * PERFORMANCE ESTIMATE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   v1:  ~3.5h   (sequential, DOM-based)
 *   v2:  ~18min  (semaphore + batch)
 *   v3:  ~16min  (worker pool, no batch overhead, Gate 4 non-blocking)
 *
 *   The wall-clock improvement is modest on healthy runs; the primary gain is
 *   stability — v3 does not degrade or lag on large vendors (300+ games) the
 *   way v2 did due to Promise heap bloat and event-loop starvation at scale.
 */

import { Page, Browser, BrowserContext } from '@playwright/test';
import * as fs   from 'fs';
import * as path from 'path';
import { getGameList, enterGame, S9Credential, GameInfo } from '../api/s9ApiClient';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Maximum simultaneous browser pages per vendor worker.
 *
 * Tuning guide (14 workers):
 *   4 → 56 total pages  · ~11.2 GB · conservative
 *   6 → 84 total pages  · ~16.8 GB · recommended for 32 GB
 *   8 → 112 total pages · ~22.4 GB · aggressive, watch memory
 */
const MAX_CONCURRENT_GAMES = 6;

/**
 * Retry attempts for transient game failures.
 * AUTH_FAILURE is never retried regardless of this value.
 *   0 = no retry  |  1 = recommended  |  2 = unstable game servers
 */
const MAX_RETRIES = 2;

/** Cooldown between game retry attempts (ms). Lets the game server recover. */
const RETRY_DELAY_MS = 3_000;

/**
 * Retry attempts for getGameList() on transient network failure.
 * Prevents an entire vendor being silently skipped due to a momentary API blip.
 * Each retry waits GAME_LIST_RETRY_DELAY_MS before the next attempt.
 */
const GAME_LIST_RETRIES      = 3;
const GAME_LIST_RETRY_DELAY  = 4_000; // ms between game-list fetch retries

/**
 * Cold-start stagger between worker launches (ms).
 * Worker N waits N × STAGGER_MS before its very first game.
 * Prevents all MAX_CONCURRENT_GAMES workers from calling enterGame()
 * simultaneously before the API connection pool has warmed up.
 */
const STAGGER_MS = 200;

/**
 * Log a progress snapshot every N completed games per vendor.
 * Keeps terminal output readable without per-game noise.
 * Set to 0 to disable.
 */
const PROGRESS_EVERY_N = 20;

/**
 * Adaptive rate-limit back-pressure.
 *
 * RATE_WINDOW_SIZE  — number of recent games to track (sliding window).
 * RATE_LIMIT_THRESHOLD — fraction of 429 errors that activates throttling.
 * RATE_BACKOFF_MS  — extra stagger added per game while throttled.
 * RATE_MIN_SAMPLES — minimum samples before threshold comparison is applied.
 *                    Ensures back-pressure activates early even before the full
 *                    window fills (fixes the cold-window dead zone in v3.0).
 */
const RATE_WINDOW_SIZE     = 20;
const RATE_LIMIT_THRESHOLD = 0.25;  // >25% 429s → throttle
const RATE_BACKOFF_MS      = 500;   // extra ms of stagger per game
const RATE_MIN_SAMPLES     = 3;     // activate after as few as 3 samples

// ── Gate timing ───────────────────────────────────────────────────────────────

/** ms to settle after iframe body attaches before scanning for error text. */
const GATE3_SETTLE_MS   = 2_000;

/** Total ms to watch for late-appearing errors after Gate 3 passes. */
const GATE4_DURATION_MS = 5_000;

/** Poll interval inside Gate 4 stability watch. */
const GATE4_INTERVAL_MS = 2_000;

// ── File paths ────────────────────────────────────────────────────────────────

/** Browser session state (cookies + localStorage) saved by auth.setup.ts. */
const AUTH_STATE_PATH = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'user.json');

/** API credential {did, uid, token} saved by auth.setup.ts. */
const CRED_FILE       = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'credential.json');

/** Directory for per-vendor CSV result files. Created automatically if absent. */
const REPORTS_DIR     = path.resolve(__dirname, '..', '..', 'test-results', 'vendor-reports');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type GameStatus = 'Pass' | 'Fail';

export interface GameResult {
    gameId:     number;
    gameName:   string;
    status:     GameStatus;
    /** Gate that failed (1–4), or 0 for Pass. */
    gate:       number;
    errorLabel: string;
    /** Retry attempts consumed (0 = passed or failed on the first try). */
    retries:    number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RATE-LIMIT MONITOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sliding-window 429 error rate monitor, shared across all workers in a vendor run.
 *
 * FIX (v3.1): v3.0 ignored the window until it contained RATE_WINDOW_SIZE samples,
 * creating a cold-window dead zone where the first 20 games were unprotected.
 * v3.1 uses RATE_MIN_SAMPLES: back-pressure activates as soon as there are at
 * least RATE_MIN_SAMPLES entries AND the error rate exceeds the threshold.
 * This means 3 consecutive 429s in the first 3 games immediately triggers throttling.
 *
 * JS is single-threaded — all mutations here are atomic, no locking needed.
 */
class RateLimitMonitor {
    private readonly window: boolean[] = [];

    /** Call once per completed game. Pass true if the game hit a 429 at Gate 1. */
    record(wasRateLimited: boolean): void {
        this.window.push(wasRateLimited);
        if (this.window.length > RATE_WINDOW_SIZE) this.window.shift();
    }

    /**
     * Returns additional stagger ms to apply before the next game starts.
     * Returns 0 when the API appears healthy or the window is too small to judge.
     */
    extraStagger(): number {
        if (this.window.length < RATE_MIN_SAMPLES) return 0;
        const rate = this.window.filter(Boolean).length / this.window.length;
        return rate > RATE_LIMIT_THRESHOLD ? RATE_BACKOFF_MS : 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOADERS
// ═══════════════════════════════════════════════════════════════════════════════

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
 * Load browser auth state into memory once per vendor run.
 *
 * NEW (v3): Playwright re-reads and re-parses user.json on every newContext()
 * call when passed a file path. At 6,000 games × 3 retries = up to 18,000
 * disk reads per full run. Parsing once and reusing the object eliminates this.
 */
function loadAuthState(): object {
    if (!fs.existsSync(AUTH_STATE_PATH)) {
        throw new Error(
            `user.json not found at ${AUTH_STATE_PATH}.\n` +
            `Run auth setup: npx playwright test --project=setup`
        );
    }
    return JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf8'));
}

/**
 * Fetch the game list for a vendor, with retry on transient network failure.
 *
 * NEW (v3): v2 and v3.0 had a bare try/catch that returned early on failure,
 * silently skipping the entire vendor. At 53 vendors, a single API blip would
 * cause a complete vendor loss with no recovery attempt.
 * v3.1 retries up to GAME_LIST_RETRIES times with GAME_LIST_RETRY_DELAY ms
 * between attempts before giving up and logging the failure.
 */
async function getGameListWithRetry(
    credential:  S9Credential,
    vendorId:    number,
    vendorName:  string,
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
    return null; // unreachable, but satisfies TS
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Non-blocking sleep backed by setTimeout (macrotask queue).
 * Unlike Playwright's waitForTimeout, this fully yields the event loop between
 * ticks — other games' I/O callbacks run while this task is waiting.
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const ERROR_TEXT_PATTERN =
    /error occurred|network error|connection error|failed to load|cannot connect|server error|access denied|game unavailable|please try again|session expired|unauthorized|service unavailable|insecure connection/i;

/**
 * Scans both the main page and the #gameframe iframe for known error strings.
 * Uses a short 300 ms timeout per query so it never blocks significantly.
 */
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
// 4-GATE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates one game through the 4-gate pipeline.
 *
 *   Gate 1 — API entry              ~200 ms
 *   Gate 2 — iframe load            up to 20 s
 *   Gate 3 — settle + error scan    2 s
 *   Gate 4 — stability watch        5 s  (non-blocking — other games run freely)
 *
 * The page is fully owned by the caller's browser context.
 * The caller must close the context in a finally block regardless of outcome.
 * This function never throws — all errors are returned as Fail results.
 */
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
    //
    // page.route() intercepts s9.com → returns an instant stub HTML page.
    //   (1) Provides HTTPS parent context for providers that check
    //       window.parent.location.protocol (e.g. PG Soft)
    //   (2) Gives immediate document.body for iframe injection
    //   (3) Eliminates 5–20s real server navigation latency
    //
    // FIX (v3): listener always removed in finally — v2 leaked it on error paths.
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
        page.off('response', responseHandler); // always removed
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
    //
    // FIX (v3): sleep() (macrotask / setTimeout) fully yields the event loop
    // between ticks. waitForTimeout() (used in v2) stalls this task for its
    // full duration, preventing other concurrent games' I/O callbacks from
    // being processed during Gate 4.
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
// RETRY WRAPPER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Runs validateSingleGame with up to MAX_RETRIES attempts.
 *
 * Each attempt uses a fresh browser context + page so stale cookies, cached
 * route handlers, and prior event listeners cannot bleed into the next attempt.
 *
 * FIX (v3): AUTH_FAILURE exits the loop immediately — no pointless context
 * opens for futile follow-up attempts. v2 always opened the context first.
 *
 * Memory: every context is closed in a finally block. No zombie contexts.
 */
async function runWithRetry(
    browser:    Browser,
    game:       GameInfo,
    vendorId:   number,
    credential: S9Credential,
    authState:  object,
    rateMon:    RateLimitMonitor,
    slotLabel:  string,
): Promise<GameResult> {
    let lastResult: GameResult = {
        gameId:     game.game_id,
        gameName:   game.name,
        status:     'Fail',
        gate:       0,
        errorLabel: 'No result recorded (internal error)',
        retries:    0,
    };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            console.log(
                `${slotLabel} ↻ Retry ${attempt}/${MAX_RETRIES}: ` +
                `${game.name} (waiting ${RETRY_DELAY_MS}ms)`
            );
            await sleep(RETRY_DELAY_MS);
        }

        // authState is a pre-parsed object — no file read, no JSON parse overhead
        const context: BrowserContext = await browser.newContext({
            storageState:      authState as any,
            ignoreHTTPSErrors: true,
        });

        try {
            const page   = await context.newPage();
            const result = await validateSingleGame(page, credential, game, vendorId);
            result.retries = attempt;
            lastResult     = result;

            // FIX (v3.1): detect 429 via API code, not substring match on errorLabel.
            // The Gate 1 error format is "API Error (code=429): ..." — checking the
            // code number directly avoids false positives on game names containing "429".
            const wasRateLimited = result.errorLabel.includes('code=429');
            rateMon.record(wasRateLimited);

            if (result.status === 'Pass' || result.errorLabel.startsWith('AUTH_FAILURE')) {
                break;
            }
            if (attempt >= MAX_RETRIES) break;

        } catch (e: any) {
            lastResult = {
                gameId:     game.game_id,
                gameName:   game.name,
                status:     'Fail',
                gate:       2,
                errorLabel: `Unexpected: ${(e as Error).message.slice(0, 50)}`,
                retries:    attempt,
            };
            rateMon.record(false);
            if (attempt >= MAX_RETRIES) break;
        } finally {
            await context.close().catch(() => {}); // always closed
        }
    }

    return lastResult;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STREAMING CSV WRITER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Appends one CSV row per completed game using a Node.js WriteStream.
 *
 * NEW (v3): v2 buffered all results in memory and wrote one large block at the
 * end. A crash or token expiry mid-run lost all buffered results.
 * v3 writes each row immediately on game completion — partial results survive.
 */
class CsvStreamWriter {
    private readonly stream:     fs.WriteStream;
    private readonly vendorId:   number;
    private readonly vendorName: string;

    constructor(csvPath: string, vendorId: number, vendorName: string) {
        fs.mkdirSync(path.dirname(csvPath), { recursive: true });
        this.stream     = fs.createWriteStream(csvPath, { encoding: 'utf8', flags: 'w' });
        this.vendorId   = vendorId;
        this.vendorName = vendorName;
        this.stream.write(
            'VendorId,VendorName,GameId,GameName,Status,Gate,Retries,Error,Timestamp\n'
        );
    }

    appendRow(r: GameResult, timestamp: string): void {
        const row = [
            this.vendorId,
            `"${this.vendorName}"`,
            r.gameId,
            `"${r.gameName.replace(/"/g, '""')}"`,
            r.status,
            r.gate || '',
            r.retries,
            `"${(r.errorLabel || '').replace(/"/g, '""')}"`,
            timestamp,
        ].join(',');
        this.stream.write(row + '\n');
    }

    close(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.stream.end((err: any) => (err ? reject(err) : resolve()));
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED GAME INDEX  (worker pool queue)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Atomic game-index counter for the worker pool.
 *
 * JavaScript is single-threaded, so next() is always atomic with no locking.
 * Each worker calls next() to claim the index of the next unclaimed game.
 * Returns null when all games have been claimed.
 */
class SharedIndex {
    private cursor = 0;
    constructor(private readonly total: number) {}

    next(): number | null {
        return this.cursor < this.total ? this.cursor++ : null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER POOL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Runs exactly MAX_CONCURRENT_GAMES worker coroutines over the full game list.
 *
 * NEW (v3): replaces Promise.all(games.map(...)).
 *
 * Promise.all(N games) allocates N Promises immediately regardless of the
 * concurrency limit. For a vendor with 300 games this creates 294 Promises
 * sitting idle in the heap, adding GC pressure across the entire run.
 * Multiplied by 53 vendors, this is significant cumulative overhead.
 *
 * The worker pool keeps exactly MAX_CONCURRENT_GAMES Promises alive:
 *
 *   worker-0:  game[0] → game[6] → game[12] → …   (pulls next on finish)
 *   worker-1:  game[1] → game[7] → game[13] → …
 *   worker-5:  game[5] → game[11] → game[17] → …
 *
 * Zero idle time, zero Promise heap bloat, constant memory footprint per vendor.
 */
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

    // Shared mutable counters — safe because JS is single-threaded.
    let completed           = 0;
    let passed              = 0;
    let failed              = 0;
    // FIX (v3.1): track the last milestone that triggered a progress log.
    // Without this, two workers completing their game in the same event loop
    // turn could both see `completed % N === 0` and emit duplicate progress lines.
    let lastProgressMilestone = 0;

    /**
     * Single worker coroutine.
     * Loops: claim next game index → validate → write CSV row → repeat.
     * Exits when the shared queue is exhausted.
     */
    async function worker(workerId: number): Promise<void> {
        // Cold-start stagger: worker N waits N × STAGGER_MS before its first game,
        // spreading the initial burst of enterGame() API calls across time.
        if (workerId > 0) await sleep(workerId * STAGGER_MS);

        while (true) {
            const idx = queue.next();
            if (idx === null) return; // queue exhausted — worker exits cleanly

            const game      = games[idx];
            const slotLabel = `[${vendorName}][${idx + 1}/${games.length}]`;

            // Adaptive back-pressure: stagger more if the API is throttling us
            const extraMs = rateMon.extraStagger();
            if (extraMs > 0) await sleep(extraMs);

            const result = await runWithRetry(
                browser, game, vendorId, credential, authState, rateMon, slotLabel,
            );

            results[idx] = result; // index write — no concurrent push() race
            completed++;
            if (result.status === 'Pass') passed++; else failed++;

            // Append row to CSV immediately — crash-safe, no buffering
            csvWriter.appendRow(result, timestamp);

            // Log only failures and retried passes to keep terminal readable
            if (result.status === 'Fail') {
                console.log(
                    `${slotLabel} ✗ FAIL | Gate ${result.gate}: ${result.errorLabel}` +
                    (result.retries > 0 ? ` [retried ${result.retries}×]` : '')
                );
            } else if (result.retries > 0) {
                console.log(
                    `${slotLabel} ✅ Pass [retried ${result.retries}×]: ${game.name}`
                );
            }

            // FIX (v3.1): emit progress only when the milestone is new.
            // Prevents duplicate lines when two workers finish within the same
            // event loop turn and both see completed % PROGRESS_EVERY_N === 0.
            if (PROGRESS_EVERY_N > 0) {
                const milestone = Math.floor(completed / PROGRESS_EVERY_N);
                if (milestone > lastProgressMilestone) {
                    lastProgressMilestone = milestone;
                    const pct = ((completed / games.length) * 100).toFixed(1);
                    console.log(
                        `[${vendorName}] ── ${completed}/${games.length} (${pct}%)` +
                        `  ✅ ${passed}  ✗ ${failed}`
                    );
                }
            }
        }
    }

    // Spawn exactly MAX_CONCURRENT_GAMES workers (or fewer for tiny vendors)
    const workerCount = Math.min(MAX_CONCURRENT_GAMES, games.length);
    await Promise.all(
        Array.from({ length: workerCount }, (_, id) => worker(id))
    );

    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXPORTED FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates all games for one vendor using the v3 worker pool.
 *
 * Called once per vendor by the Playwright test runner.
 * With 14 workers, up to 14 vendors run this function simultaneously.
 * Each call is fully isolated — no shared mutable state between vendors.
 *
 * @param browser    Playwright Browser fixture (from the test runner)
 * @param vendorId   Numeric vendor ID (e.g. 600005 for Amusnet)
 * @param vendorName Display name for logging and CSV filename
 */
export async function apiValidateVendorGamesFlowV3(
    browser:    Browser,
    vendorId:   number,
    vendorName: string,
): Promise<void> {

    // Load credential and auth state once per vendor call — not per game
    const credential = loadCredential();
    const authState  = loadAuthState();

    // Fetch the game list with retry on transient network failure
    const games = await getGameListWithRetry(credential, vendorId, vendorName);
    if (!games) return; // all retries exhausted — already logged
    if (games.length === 0) {
        console.warn(`[${vendorName}] ⚠ No active games found — skipping.`);
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName  = vendorName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const csvPath   = path.join(REPORTS_DIR, `${safeName}_${timestamp}.csv`);

    console.log(
        `\n=== [${vendorName}] v3 validation starting ` +
        `(ven_id=${vendorId}, games=${games.length}, workers=${MAX_CONCURRENT_GAMES}) ===`
    );

    // Open the CSV stream — rows appended per game, not buffered to end
    const csvWriter = new CsvStreamWriter(csvPath, vendorId, vendorName);

    let results: GameResult[];
    try {
        results = await runWorkerPool(
            browser, games, vendorId, vendorName,
            credential, authState, csvWriter, timestamp,
        );
    } finally {
        // Always close the stream — even if the run crashes or token expires mid-way
        await csvWriter.close().catch(e =>
            console.warn(`[${vendorName}] ⚠ CSV stream close error: ${(e as Error).message}`)
        );
    }

    // ── Final summary ─────────────────────────────────────────────────────────
    const validResults  = results.filter(Boolean); // guard against sparse gaps
    const passed        = validResults.filter(r => r.status === 'Pass').length;
    const failed        = validResults.filter(r => r.status === 'Fail').length;
    const retried       = validResults.filter(r => r.retries > 0).length;

    console.log(
        `\n### [${vendorName}] v3 Complete` +
        ` — ${passed} passed · ${failed} failed · ${validResults.length} total` +
        (retried > 0 ? ` · ${retried} retried` : '')
    );

    // Only print the failed games in the summary table.
    // Printing every passing game at 300+ games per vendor floods the terminal.
    const failedResults = validResults.filter(r => r.status === 'Fail');
    if (failedResults.length > 0) {
        console.log('\nFailed games:');
        console.log('| Game | Gate | Retries | Error |');
        console.log('|------|------|---------|-------|');
        for (const r of failedResults) {
            console.log(`| ${r.gameName} | ${r.gate} | ${r.retries} | ${r.errorLabel} |`);
        }
    }

    console.log(`\n📄 CSV saved: ${csvPath}\n`);
}