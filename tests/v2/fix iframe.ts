/**
 * apiValidationFlowV2.ts — Fully concurrent game validation (v2, memory-safe).
 *
 * ── What changed from the previous v2 ────────────────────────────────────────
 *
 *  FIX 1 — page.route() now always unrouted in a finally block
 *  FIX 2 — response listener always removed in finally block
 *  FIX 3 — retry delay moved OUTSIDE the semaphore slot
 *  FIX 4 — auth state parsed once per vendor, not per context
 *  FIX 5 — super-batch pattern removed
 *  FIX 6 — MAX_CONCURRENT_GAMES reduced to match real RAM budget
 *
 *  FIX 7 — nested iframe (iframe-within-iframe) support
 *
 *    PROBLEM:
 *      Some providers return a redirect_url that is itself an HTML wrapper page
 *      containing a second <iframe> pointing to the real game engine:
 *
 *        page  (https://s9.com/... — our stub)
 *        └── #gameframe  (https://provider.com/launch — outer iframe)
 *            └── <iframe src="https://game-engine.com/...">  (real game)
 *
 *      With the old code:
 *        • Gate 2 passed  — outer body attaches immediately (it's just a shell)
 *        • Gate 3/4 error scan only looked inside #gameframe (one level deep)
 *          → errors inside the nested iframe were invisible → false Pass possible
 *        • Gate 4 blank-screen check used #gameframe body *:visible
 *          → only sees the <iframe> element, not canvas/game content
 *          → always reported "Blank Screen" → false Fail for these providers
 *
 *    SOLUTION (resolveGameFrame):
 *      After Gate 2 confirms the outer body is attached, a new helper checks
 *      whether the outer body is purely a pass-through wrapper:
 *        1. Is there an <iframe> inside #gameframe?               (within 1s)
 *        2. Does the outer body have visible non-iframe content?
 *           → Yes: stay at depth 1 (outer frame IS the game, e.g. lobby shells)
 *           → No:  descend to depth 2 (inner iframe is the real game)
 *        3. Wait for the inner frame's body to attach before proceeding.
 *
 *      Gates 3 and 4 then use the resolved FrameLocator — correct depth always.
 *      Detection runs during the existing GATE3_SETTLE_MS window → zero extra time.
 *
 *    LOGGED: frameDepth (1 or 2) appears in console output and CSV column.
 *
 * ── Parallelism at both levels ────────────────────────────────────────────────
 *
 *  Level 1 (vendor): up to `workers` vendor tests run in parallel
 *  Level 2 (game):   up to MAX_CONCURRENT_GAMES games run per vendor at any moment
 *  Total pages = workers × MAX_CONCURRENT_GAMES
 *  Recommended for 32GB: 6 workers × 3 games = 18 pages → ~3.6GB
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

const MAX_CONCURRENT_GAMES = 3;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;
const INITIAL_WARMUP_MS = 500;
const STAGGER_MS = 200;

const AUTH_STATE  = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'user.json');
const CRED_FILE   = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'credential.json');
const REPORTS_DIR = path.resolve(__dirname, '..', '..', 'test-results', 'vendor-reports');

// ── Gate timing ───────────────────────────────────────────────────────────────

const GATE3_SETTLE_MS       = 2000;
const GATE4_DURATION_MS     = 5000;
const GATE4_INTERVAL_MS     = 2000;

/**
 * FIX 7: How long to wait when probing for a nested iframe inside #gameframe.
 *
 * Must be < GATE3_SETTLE_MS (2000ms) so the detection runs during the settle
 * window and adds zero time to the total gate sequence on the happy path.
 *
 * 1000ms is sufficient — provider wrapper pages resolve their inner iframe
 * src within the first load tick, well before 1s.
 */
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
    /** FIX 7: 1 = normal single iframe, 2 = nested iframe detected */
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
    if (!fs.existsSync(CRED_FILE)) throw new Error(`credential.json not found at ${CRED_FILE}.\nRun: npx playwright test --project=setup`);
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) as S9Credential;
}

function loadAuthState(): object {
    if (!fs.existsSync(AUTH_STATE)) throw new Error(`user.json not found at ${AUTH_STATE}.\nRun: npx playwright test --project=setup`);
    return JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'));
}

// ── Main exported flow ────────────────────────────────────────────────────────

export async function apiValidateVendorGamesFlowV2(
    browser: Browser,
    vendorId: number,
    vendorName: string
): Promise<void> {
    const credential = loadCredential();
    const authState  = loadAuthState();  // FIX 4: parsed once, reused per context

    console.log(`\n=== [${vendorName}] v2 validation starting (ven_id=${vendorId}, concurrent=${MAX_CONCURRENT_GAMES}) ===`);

    let games: GameInfo[];
    try {
        games = await getGameList(credential, vendorId);
    } catch (e: any) {
        console.error(`[${vendorName}] Failed to fetch game list: ${e.message}`);
        return;
    }

    if (games.length === 0) { console.warn(`[${vendorName}] No active games found.`); return; }
    console.log(`[${vendorName}] ${games.length} games to test (max ${MAX_CONCURRENT_GAMES} concurrent).`);

    const results: GameResult[] = new Array(games.length);
    const semaphore = new Semaphore(MAX_CONCURRENT_GAMES);

    await Promise.all(
        games.map(async (game, globalIndex) => {
            // Stagger first wave to prevent cold-start API burst
            const staggerMs = globalIndex === 0
                ? INITIAL_WARMUP_MS
                : Math.min(globalIndex, MAX_CONCURRENT_GAMES - 1) * STAGGER_MS;
            if (staggerMs > 0) await sleep(staggerMs);

            const slotLabel = `[${vendorName}][${globalIndex + 1}/${games.length}]`;
            let finalResult: GameResult | null = null;

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                // FIX 3: retry delay runs BEFORE acquiring slot — slot stays free during wait
                if (attempt > 0) {
                    console.log(`${slotLabel} ↻ Retry ${attempt}/${MAX_RETRIES} for: ${game.name} (waiting ${RETRY_DELAY_MS}ms)`);
                    await sleep(RETRY_DELAY_MS);
                }

                await semaphore.acquire();
                if (attempt === 0) console.log(`${slotLabel} Starting: ${game.name}`);

                try {
                    const context = await browser.newContext({
                        storageState: authState as any,  // FIX 4: object not file path
                        ignoreHTTPSErrors: true,
                    });

                    try {
                        const page   = await context.newPage();
                        const result = await validateSingleGame(page, credential, game, vendorId);
                        result.retries = attempt;

                        if (result.status === 'Pass') {
                            finalResult = result;
                            if (attempt > 0) console.log(`${slotLabel} ✅ Passed on retry ${attempt}: ${game.name}`);
                        } else {
                            const isAuthFailure = result.errorLabel.startsWith('AUTH_FAILURE');
                            if (isAuthFailure || attempt >= MAX_RETRIES) {
                                finalResult = result;
                            } else {
                                console.log(`${slotLabel} ✗ Attempt ${attempt + 1} failed | Gate ${result.gate}: ${result.errorLabel}`);
                                finalResult = result;
                            }
                        }
                    } finally {
                        await context.close().catch(() => {});
                    }
                } catch (e: any) {
                    finalResult = {
                        gameId: game.game_id, gameName: game.name, status: 'Fail',
                        gate: 2, errorLabel: `Unexpected error: ${e.message.slice(0, 60)}`,
                        retries: attempt, frameDepth: 1,
                    };
                } finally {
                    semaphore.release();  // FIX 3: always release before retry sleep
                }

                if (
                    finalResult?.status === 'Pass' ||
                    finalResult?.errorLabel.startsWith('AUTH_FAILURE') ||
                    attempt >= MAX_RETRIES
                ) break;
            }

            results[globalIndex] = finalResult ?? {
                gameId: game.game_id, gameName: game.name, status: 'Fail',
                gate: 0, errorLabel: 'No result recorded (internal error)',
                retries: MAX_RETRIES, frameDepth: 1,
            };

            const r          = results[globalIndex];
            const retryNote  = r.retries > 0    ? ` [retried ${r.retries}×]`  : '';
            const depthNote  = r.frameDepth === 2 ? ' [nested iframe]'         : '';
            const detail     = r.status === 'Fail' ? ` | Gate ${r.gate}: ${r.errorLabel}` : '';
            console.log(`${slotLabel} → ${r.status}${retryNote}${depthNote}${detail}`);
        })
    );

    // ── Summary ───────────────────────────────────────────────────────────────
    const passed    = results.filter(r => r.status === 'Pass').length;
    const failed    = results.filter(r => r.status === 'Fail').length;
    const retried   = results.filter(r => r.retries > 0).length;
    const nested    = results.filter(r => r.frameDepth === 2).length;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    console.log(
        `\n### [${vendorName}] v2 Summary: ${passed} passed, ${failed} failed / ` +
        `${results.length} total (${retried} retried, ${nested} nested-iframe)\n`
    );
    console.log('| Game | Status | Gate | Retries | FrameDepth | Error |');
    console.log('|------|--------|------|---------|------------|-------|');
    for (const r of results) {
        console.log(`| ${r.gameName} | ${r.status} | ${r.gate || '-'} | ${r.retries} | ${r.frameDepth} | ${r.errorLabel || '-'} |`);
    }

    // ── CSV ───────────────────────────────────────────────────────────────────
    try {
        fs.mkdirSync(REPORTS_DIR, { recursive: true });
        const safeName = vendorName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const csvPath  = path.join(REPORTS_DIR, `${safeName}_${timestamp}.csv`);
        const csvLines = [
            'VendorId,VendorName,GameId,GameName,Status,Gate,Retries,FrameDepth,Error,Timestamp',
            ...results.map(r =>
                [
                    vendorId,
                    `"${vendorName}"`,
                    r.gameId,
                    `"${r.gameName.replace(/"/g, '""')}"`,
                    r.status,
                    r.gate || '',
                    r.retries,
                    r.frameDepth,
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

async function validateSingleGame(
    page: Page,
    credential: S9Credential,
    game: GameInfo,
    vendorId: number,
): Promise<GameResult> {
    const pass = (frameDepth: number): GameResult => ({
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
    let iframeLoaded    = false;
    let iframeHttpError: number | null = null;
    const routeUrl      = 'https://s9.com/**';

    const routeHandler = (route: any) => {
        route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<!DOCTYPE html><html><head><style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden}</style></head><body></body></html>',
        });
    };

    const responseHandler = (res: any) => {
        if (res.url() === redirectUrl && res.status() >= 400) iframeHttpError = res.status();
    };

    page.on('response', responseHandler);  // FIX 2: attached before try block

    try {
        await page.route(routeUrl, routeHandler);  // FIX 1: always unrouted in finally

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

    // ── FIX 7: Resolve the actual game frame ──────────────────────────────────
    //
    // Runs during the Gate 3 settle window (NESTED_IFRAME_DETECT_MS ≤ GATE3_SETTLE_MS)
    // so no additional time is added to the gate sequence.
    //
    // Returns the correct FrameLocator for all downstream checks:
    //   frameDepth=1  →  use #gameframe directly (normal case)
    //   frameDepth=2  →  use the nested iframe inside #gameframe
    const { gameFrame, frameDepth } = await resolveGameFrame(page);

    // Top up any remaining Gate 3 settle time after the detection probe
    const remainingSettle = Math.max(0, GATE3_SETTLE_MS - NESTED_IFRAME_DETECT_MS);
    if (remainingSettle > 0) await page.waitForTimeout(remainingSettle);

    // ── Gate 3: Immediate error scan ──────────────────────────────────────────
    const gate3Error = await detectErrorText(page, gameFrame);
    if (gate3Error) return fail(3, `Game Error: "${gate3Error}"`, frameDepth);

    // ── Gate 4: Stability watch ───────────────────────────────────────────────
    const ticks = Math.floor(GATE4_DURATION_MS / GATE4_INTERVAL_MS);
    for (let tick = 0; tick < ticks; tick++) {
        await page.waitForTimeout(GATE4_INTERVAL_MS);
        const gate4Error = await detectErrorText(page, gameFrame);
        if (gate4Error) return fail(4, `Unstable: "${gate4Error}"`, frameDepth);
    }

    // ── Gate 4: Blank screen check ────────────────────────────────────────────
    // FIX 7: uses resolved gameFrame — not hardcoded #gameframe.
    // Depth-1 path is identical to before. Depth-2 looks inside the nested frame.
    const hasContent = await gameFrame
        .locator('body *:visible').first()
        .isVisible({ timeout: 1000 }).catch(() => false);
    if (!hasContent) return fail(4, 'Blank Screen (no visible content after game load)', frameDepth);

    return pass(frameDepth);
}

// ── FIX 7: Nested iframe resolver ────────────────────────────────────────────

/**
 * Determines whether #gameframe is a pass-through wrapper or the real game frame.
 *
 * Detection logic:
 *
 *   Step 1 — Is there an <iframe> inside #gameframe?
 *             Wait up to NESTED_IFRAME_DETECT_MS (1s).
 *             No → frameDepth=1, return outerFrame immediately.
 *
 *   Step 2 — Does the outer body have visible non-iframe content?
 *             Visible elements other than <iframe>, <script>, <style>, <link>.
 *             Yes → frameDepth=1 (it's a lobby shell, not a pure wrapper).
 *             No  → proceed to step 3.
 *
 *   Step 3 — Wait for inner frame's body to attach (up to NESTED_IFRAME_DETECT_MS).
 *             Attached → frameDepth=2, return innerFrame.
 *             Not attached → fall back to frameDepth=1 (safety — avoids false fail).
 *
 * Why the "visible non-iframe content" check matters:
 *   Some providers load a lobby or shell UI in the outer iframe that itself
 *   contains nested iframes for sub-panels (chat, side menu, game window).
 *   In this case the outer frame IS the meaningful content — we should not
 *   descend. Only a pure pass-through (body contains nothing but an <iframe>)
 *   should trigger depth-2 mode.
 */
async function resolveGameFrame(
    page: Page,
): Promise<{ gameFrame: FrameLocator; frameDepth: 1 | 2 }> {
    const outerFrame = page.frameLocator('#gameframe');

    // Step 1: probe for a nested iframe
    const hasNestedIframe = await outerFrame
        .locator('iframe')
        .first()
        .waitFor({ state: 'attached', timeout: NESTED_IFRAME_DETECT_MS })
        .then(() => true)
        .catch(() => false);

    if (!hasNestedIframe) {
        return { gameFrame: outerFrame, frameDepth: 1 };
    }

    // Step 2: check whether the outer body has any meaningful visible content
    // beyond the nested iframe — if it does, this is a lobby shell, not a wrapper
    const hasOuterContent = await outerFrame
        .locator('body > *:not(iframe):not(script):not(style):not(link):visible')
        .first()
        .isVisible({ timeout: 300 })
        .catch(() => false);

    if (hasOuterContent) {
        // Outer frame has real content — treat as normal depth-1 game
        return { gameFrame: outerFrame, frameDepth: 1 };
    }

    // Step 3: outer body is a pure wrapper — resolve to the inner frame
    const innerFrame = outerFrame.frameLocator('iframe');

    const innerBodyAttached = await innerFrame
        .locator('body')
        .waitFor({ state: 'attached', timeout: NESTED_IFRAME_DETECT_MS })
        .then(() => true)
        .catch(() => false);

    if (!innerBodyAttached) {
        // Inner frame not ready yet — fall back to outer to avoid false fail
        return { gameFrame: outerFrame, frameDepth: 1 };
    }

    return { gameFrame: innerFrame, frameDepth: 2 };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Scans for error text in the main page and in the resolved game frame.
 *
 * FIX 7: accepts the resolved gameFrame locator so errors are detected at
 * the correct depth regardless of whether nesting was detected.
 */
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