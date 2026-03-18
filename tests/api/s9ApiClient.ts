/**
 * s9ApiClient.ts — Pure Node.js HTTP API client for the s9.com backend.
 *
 * This module makes direct HTTP calls to the 98ent.com server that powers s9.com.
 * It does NOT use a browser — it's a plain Node.js HTTPS client.
 *
 * ── Why no browser? ───────────────────────────────────────────────────────────
 * Using a browser to discover games means waiting for page loads, lazy-loading
 * images, DOM rendering, and scroll events. The backend API returns all game data
 * instantly in a single JSON response. Fetching 161 games via DOM scroll takes
 * ~3 minutes; via API it takes ~80 milliseconds.
 *
 * ── Authentication ────────────────────────────────────────────────────────────
 * All authenticated endpoints require two things:
 *  1. Authorization: Bearer <token>  (HTTP header)
 *  2. credential: { did, mode, pid, uid, token }  (inside the JSON request body)
 *
 * The token value is the same string in both places. It is captured once during
 * auth setup (auth.setup.ts) and saved to playwright/.auth/credential.json.
 *
 * ── Endpoints used ───────────────────────────────────────────────────────────
 *  POST /ns9/api/public/partner/game-vendor/list  → list of all game vendors
 *  POST /ns9/api/public/partner/game/list         → games for one vendor (paginated)
 *  POST /ns9/api/gus/game/enter                   → start a game session → redirect_url
 *
 * All payload shapes confirmed via DevTools capture (see scripts/captured_api.json).
 */

import * as https from 'https';

// ── Constants ────────────────────────────────────────────────────────────────

/** The backend API host. All endpoints live here, not on s9.com itself. */
const API_HOST = 'new.98ent.com';

/** Used in the "header" object of every request body. Tells the server which
 *  frontend page triggered the request. Must match s9.com's actual page URLs
 *  or the server may reject the request. */
const DEFAULT_PAGE_URL = 'https://s9.com/games';

/** API version string sent in every request header object. */
const API_VERSION = 'v0.0.1';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The credential object embedded in the body of every authenticated API call.
 * Captured from the browser after login and saved to credential.json.
 *
 * Fields:
 *  - did   Device ID (unique per browser/device)
 *  - mode  Always 1 for logged-in users
 *  - pid   Partner ID (always 1 for this platform)
 *  - uid   User ID (numeric, tied to the test account)
 *  - token JWT-like session token; same value as the Authorization Bearer token
 */
export interface S9Credential {
    did: number;
    mode: number;
    pid: number;
    uid: number;
    token: string;
}

/** A game vendor (provider) from the game-vendor/list API. */
export interface VendorInfo {
    ven_id: number;
    code: string;
    name: string;
    /** 1 = active (testable), 2 = disabled (skip) */
    status: number;
}

/** A single game entry from the game/list API. */
export interface GameInfo {
    game_id: number;
    name: string;
    code: string;
    ven_id: number;
    cat_id: number;
    /** 1 = active, other values = unavailable */
    status: number;
    /** If true, the game is in maintenance mode — skip it */
    maintain: boolean;
}

/** Result of a game/enter API call. */
export interface EnterResult {
    /** 1 = success, anything else = error */
    code: number;
    /** Human-readable error message (empty string on success) */
    msg: string;
    /** The URL to navigate to / embed in an iframe to launch the game.
     *  null if the API returned an error. */
    redirect_url: string | null;
}

// ── Core HTTP helper ─────────────────────────────────────────────────────────

/**
 * Makes a POST request to the 98ent.com API and parses the JSON response.
 *
 * @param path    Full URL path (e.g. '/ns9/api/gus/game/enter')
 * @param body    Request body object — will be JSON-stringified
 * @param token   If provided, adds an Authorization: Bearer header.
 *                Public endpoints (game-vendor/list) don't need this,
 *                but authenticated endpoints require it.
 */
function post(path: string, body: object, token?: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);

        const options: https.RequestOptions = {
            hostname: API_HOST,
            path,
            method: 'POST',
            timeout: 15000,
            headers: {
                // Prevent Node.js from keeping connections alive and blocking program exit
                'Connection': 'close',
                // Required by all endpoints
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                // The server uses Referer to validate the request origin
                'Referer': 'https://s9.com/',
                'Accept-Language': 'en-US',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                // Must be set correctly or the server returns a 400
                'Content-Length': Buffer.byteLength(payload),
                // Only sent for authenticated endpoints
                ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    // Non-JSON response usually means a server error (502, 503, etc.)
                    reject(new Error(`Non-JSON response (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
                }
            });
            // Handle response stream errors
            res.on('error', reject);
        });

        // Handle timeouts explicitly to prevent hanging promises
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request timeout accessing ${path}`));
        });
        req.on('error', reject);  // Network-level errors (DNS, connection refused)
        req.write(payload);
        req.end();
    });
}

// ── Public API functions ─────────────────────────────────────────────────────

/**
 * Fetches the list of all game vendors registered on the platform.
 *
 * This is a semi-public endpoint — it needs the Authorization header but does NOT
 * require the credential body. It returns all vendors regardless of status.
 *
 * @returns Array of VendorInfo. Filter by status === 1 for active vendors.
 *
 * Example response shape:
 *   { code: 1, count: 51, list: [{ ven_id: 600005, name: "Amusnet", status: 1 }, ...] }
 */
export async function getVendorList(token: string): Promise<VendorInfo[]> {
    const res = await post('/ns9/api/public/partner/game-vendor/list', {
        header: { page_url: DEFAULT_PAGE_URL, version: API_VERSION },
        // page_size: 100 ensures we get all vendors in one call even if count grows
        condition: { mode: 2, page_index: 0, page_size: 100 },
        param: {},
    }, token);

    if (res.code !== 1) throw new Error(`vendor list failed: ${res.msg}`);
    return (res.list as VendorInfo[]).filter(v => v.status === 1);
}

/**
 * Fetches ALL games for a given vendor, handling pagination automatically.
 *
 * The API returns games in pages (default page_size is 15 in the frontend,
 * but we request 50 per page to reduce the number of API calls needed).
 * We keep fetching until we have all games or the last page is incomplete.
 *
 * Only returns games that are:
 *  - status === 1  (active, not hidden)
 *  - maintain === false  (not in maintenance mode)
 *
 * @param credential  User credential for authentication
 * @param venId       Vendor ID (e.g. 600005 for Amusnet)
 * @returns           List of testable games for this vendor
 *
 * Example: Amusnet (600005) has 161 total games. This function fetches them
 * in 4 pages of 50 and returns all 161 in one array.
 */
export async function getGameList(credential: S9Credential, venId: number): Promise<GameInfo[]> {
    const PAGE_SIZE = 50;
    let pageIndex = 0;
    // Use a large sentinel; will be set from the first API response.
    // Do NOT leave as Infinity permanently — see Bug Fix note below.
    let totalCount = Number.MAX_SAFE_INTEGER;
    const allGames: GameInfo[] = [];

    while (allGames.length < totalCount) {
        const res = await post('/ns9/api/public/partner/game/list', {
            header: { page_url: `${DEFAULT_PAGE_URL}?ven_id=${venId}`, version: API_VERSION },
            condition: {
                page_index: pageIndex,
                page_size: PAGE_SIZE,
                mode: 2,
                ven_id: venId,
            },
            credential,  // Required: this endpoint checks the user's session
            param: {},
        }, credential.token);

        if (res.code !== 1) {
            throw new Error(`game list failed (ven_id=${venId}, page=${pageIndex}): ${res.msg}`);
        }

        // 'count' is the total number of games across all pages (not this page's count).
        // Fall back to 0 only when count is truly missing — the while-condition will exit.
        totalCount = res.count ?? 0;
        const games: GameInfo[] = res.games ?? [];
        allGames.push(...games);

        // BUG FIX: pageIndex must increment BEFORE the break check.
        // Previously it incremented AFTER, so if the API ever returned
        // count=undefined the loop would re-request page 0 forever.
        pageIndex++;

        // Safety guard 1: last page is a partial page — we're done.
        if (games.length < PAGE_SIZE) break;

        // Safety guard 2: empty page — stop unconditionally to prevent
        // infinite loops caused by API returning count > actual items.
        if (games.length === 0) break;
    }

    // Skip games that are inactive or under maintenance — they will naturally fail
    // but are expected to, so including them would inflate the failure count.
    return allGames.filter(g => g.status === 1 && !g.maintain);
}

/**
 * Calls the game/enter endpoint to start a game session.
 *
 * The server validates the user's session, checks if the game is available,
 * and returns a redirect_url to the game provider's server. This URL is
 * unique-per-session and expires after use or after a timeout.
 *
 * @param credential  User credential
 * @param gameId      The game to launch (from GameInfo.game_id)
 * @param venId       The vendor this game belongs to (used in back_url and page_url)
 * @returns           EnterResult with code, msg, and redirect_url
 *
 * Success response:
 *   { code: 1, msg: "", info: { redirect_url: "https://staging-pod.games.amusnet.io/..." } }
 *
 * Failure response example:
 *   { code: 0, msg: "Token expired" }  → AUTH_FAILURE, need re-login
 *   { code: 0, msg: "Game not found" } → permanent failure for this game
 */
export async function enterGame(
    credential: S9Credential,
    gameId: number,
    venId: number
): Promise<EnterResult> {
    const res = await post('/ns9/api/gus/game/enter', {
        header: { page_url: `${DEFAULT_PAGE_URL}?ven_id=${venId}`, version: API_VERSION },
        param: {
            game_id: gameId,
            // back_url is where the game's "back" button returns to (must be a valid s9.com URL)
            back_url: `${DEFAULT_PAGE_URL}?ven_id=${venId}`,
        },
        credential,
    }, credential.token);

    return {
        code: res.code,
        msg: res.msg ?? '',
        redirect_url: res.info?.redirect_url ?? null,
    };
}
