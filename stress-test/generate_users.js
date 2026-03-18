/**
 * generate_users.js — Stress Test User CSV Generator
 * ====================================================
 * Runs on Node.js (already installed via Playwright — no separate Python needed).
 *
 * Generates a CSV of unique usernames + SHA-256 hashed password, plus all the
 * device-fingerprint fields required by the s9.com /register and /login APIs.
 *
 * Usage:
 *   node stress-test/generate_users.js
 *   node stress-test/generate_users.js --count 1000000
 *   node stress-test/generate_users.js --count 1000000 --output stress-test/stress_test_users.csv
 *   node stress-test/generate_users.js --count 500 --output stress-test/my_users.csv
 *
 * Common scale examples:
 *   Small test:   --count 1000      (default)
 *   Medium test:  --count 10000
 *   Large test:   --count 100000
 *   1M burst test:--count 1000000   ← for the 1M user / 1000-at-a-time burst scenario
 *
 * Output columns:
 *   index, username, password_plain, password_hash, email,
 *   device_id, fingerprint, udid, user_agent
 *
 * ⚡ Performance note: generating 1,000,000 rows takes ~10–20 seconds and
 *    produces a ~200 MB CSV.  Use a streaming write to stay within RAM limits.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_COUNT    = 1000;
const PLAIN_PASSWORD   = 'TestPass123!';
const DEFAULT_OUTPUT   = path.join(__dirname, 'stress_test_users.csv');

// Matches the platform values observed in the real DevTools capture:
//   client_type=2, platform=3, agent_mode=1, method=1
const PAGE_URL         = 'https://shop01.98ent.com/login?isLogin=false';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** SHA-256 hex hash — matches what the s9.com frontend sends for passwords. */
function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// ── Known-working device fingerprint (from real DevTools capture 2026-03-13) ──
// The server validates device_id + fingerprint + udid as a coherent set.
// They are derived by the s9.com client SDK from the browser environment —
// random values are rejected even if the integer range is correct.
// Sharing these across all virtual users is valid for load testing
// (models many users on the same browser/device type).
const KNOWN_DEVICE_ID   = 1615238534;
const KNOWN_FINGERPRINT = '9A4lq0m2JTwBOjqyu75K';
const KNOWN_UDID        = '1fb8db40cffb8f82535ab3685535e5065dfa7676825d72bf9bc50f66ea75928e';

/** Rotate through real Chrome user-agents for variety per user. */
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];

// ── Main ──────────────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { count: DEFAULT_COUNT, output: DEFAULT_OUTPUT };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--count' || args[i] === '-n') opts.count = parseInt(args[++i], 10);
        if (args[i] === '--output' || args[i] === '-o') opts.output = args[++i];
    }
    if (isNaN(opts.count) || opts.count < 1) {
        console.error('❌  --count must be a positive integer (e.g. --count 1000000)');
        process.exit(1);
    }
    return opts;
}

function generate() {
    const { count, output } = parseArgs();

    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });

    const passwordHash = sha256(PLAIN_PASSWORD);   // same hash for all users (static password)

    // CSV header — order matches what locustfile.py expects
    const header = [
        'index', 'username', 'password_plain', 'password_hash',
        'email', 'device_id', 'fingerprint', 'udid', 'user_agent'
    ].join(',') + '\n';

    // Use streaming writes so 1M+ rows don't blow RAM
    const stream = fs.createWriteStream(output, { encoding: 'utf8' });
    stream.write(header);

    const LOG_EVERY = 100_000;
    const start = Date.now();

    for (let i = 1; i <= count; i++) {
        /*
         * Username strategy: st0000001 … st1000000
         *
         * ⚠️  IMPORTANT: These users must NOT already exist in the DB.
         * On first run they are created via /register.  On second run, /register
         * will return code≠1 ("username taken") and /login will succeed.
         *
         * 'st' prefix + 7-digit zero-pad = 9 chars max (e.g. st0000001).
         * Consistent for all 1,000,000 users; well within the 16-char limit.
         */
        const username = `st${String(i).padStart(7, '0')}`;

        const row = [
            i,
            username,
            PLAIN_PASSWORD,
            passwordHash,
            '',                  // email: empty string (matches real register payload)
            KNOWN_DEVICE_ID,     // exact value from DevTools capture — server validates this
            KNOWN_FINGERPRINT,   // exact value from DevTools capture
            KNOWN_UDID,          // exact value from DevTools capture
            `"${USER_AGENTS[i % USER_AGENTS.length]}"`,  // quoted (contains commas)
        ].join(',') + '\n';

        stream.write(row);

        if (i % LOG_EVERY === 0) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.log(`  ⏳ ${i.toLocaleString()} / ${count.toLocaleString()} rows written (${elapsed}s)`);
        }
    }

    stream.end(() => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`\n✅ Generated ${count.toLocaleString()} users → ${output}  (${elapsed}s)`);
        console.log(`   Password (plain):   ${PLAIN_PASSWORD}`);
        console.log(`   Password (SHA-256): ${passwordHash}`);
        console.log(`\nNext step: run the Locust stress test`);
        console.log(`  locust -f stress-test/register_test.py --host https://new.98ent.com`);
        console.log(`  locust -f stress-test/login_test.py    --host https://new.98ent.com\n`);
    });
}

generate();
