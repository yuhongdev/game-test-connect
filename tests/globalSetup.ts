/**
 * globalSetup.ts — Runs ONCE before all Playwright tests start.
 *
 * Responsibilities:
 *  1. Read the API credential saved by auth.setup.ts
 *  2. Fetch the live vendor list from the 98ent.com API
 *  3. Write it to playwright/.auth/vendors.json
 *
 * Why a globalSetup instead of test.beforeAll()?
 *  Playwright generates test cases synchronously at *collection time* —
 *  before any beforeAll() callback runs. To dynamically generate one
 *  test() per vendor, the vendor list must be available synchronously
 *  when s9_test_v2.spec.ts is loaded. globalSetup runs before collection,
 *  so vendors.json is written in time for the spec to read it.
 *
 * This file is wired in playwright.config.ts: globalSetup: './tests/globalSetup.ts'
 */

import * as fs from 'fs';
import * as path from 'path';
import { getVendorList, VendorInfo } from './api/s9ApiClient';

const CRED_FILE    = path.resolve(__dirname, '..', 'playwright', '.auth', 'credential.json');
const VENDORS_FILE = path.resolve(__dirname, '..', 'playwright', '.auth', 'vendors.json');
export const RUN_META_FILE = path.resolve(__dirname, '..', 'playwright', '.auth', 'run-meta.json');

/**
 * Vendor IDs to always skip regardless of their API status.
 * Add new exclusions here with a comment explaining why.
 */
const EXCLUDED_VENDOR_IDS = new Set<number>([
    600006, // AdvantPlay — status=2 (disabled on platform as of 2026-03)
]);

export default async function globalSetup(): Promise<void> {
    // If credential.json doesn't exist yet (first run before auth.setup),
    // skip vendor pre-fetch — auth.setup will run first and then a retry works.
    if (!fs.existsSync(CRED_FILE)) {
        console.warn('[globalSetup] credential.json not found — skipping vendor pre-fetch.');
        console.warn('[globalSetup] Run: npx playwright test --project=setup  then retry.');
        return;
    }

    const credential = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    console.log('[globalSetup] Fetching live vendor list from API...');

    let vendors: VendorInfo[];
    try {
        vendors = await getVendorList(credential.token);
    } catch (e: any) {
        console.error(`[globalSetup] Failed to fetch vendor list: ${e.message}`);
        console.error('[globalSetup] Falling back to cached vendors.json if it exists.');
        return; // Leave existing vendors.json in place as fallback
    }

    // Filter out explicitly excluded vendors
    const active = vendors.filter(v => !EXCLUDED_VENDOR_IDS.has(v.ven_id));

    const summary = active.map(v => ({ id: v.ven_id, name: v.name }));

    fs.mkdirSync(path.dirname(VENDORS_FILE), { recursive: true });
    fs.writeFileSync(VENDORS_FILE, JSON.stringify(summary, null, 2), 'utf8');

    // Write a shared run timestamp so all workers land CSVs in the same folder.
    const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(RUN_META_FILE, JSON.stringify({ runTimestamp }, null, 2), 'utf8');

    console.log(`[globalSetup] ${active.length} active vendors saved to vendors.json`);
    console.log(`[globalSetup] Excluded: ${vendors.length - active.length} vendor(s) via denylist`);
    console.log(`[globalSetup] Run timestamp: ${runTimestamp}`);
}
