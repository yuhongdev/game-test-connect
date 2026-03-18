/**
 * auth.setup.ts — Authentication Setup
 *
 * Runs ONCE before any test suite.
 * Saves:
 *  1. playwright/.auth/user.json       — browser auth state (cookies/localStorage)
 *  2. playwright/.auth/credential.json — API credential {did,mode,pid,uid,token}
 */

import { test as setup, expect } from '@playwright/test';
import { LoginPage } from './models/LoginPage';
import { S9Credential, getVendorList } from './api/s9ApiClient';
import * as fs from 'fs';
import * as path from 'path';

const authFile    = 'playwright/.auth/user.json';
const credFile    = 'playwright/.auth/credential.json';
const vendorsFile = 'playwright/.auth/vendors.json';

/**
 * Vendor IDs to always skip regardless of their API status.
 * Must be kept in sync with globalSetup.ts.
 */
const EXCLUDED_VENDOR_IDS = new Set<number>([
    600006, // AdvantPlay — status=2 (disabled on platform)
]);

setup('authenticate', async ({ page }) => {
    const loginPage = new LoginPage(page);

    // ─── Step 1: Navigate ──────────────────────────────────────────────────────
    await loginPage.goto();

    // ─── Step 2: Capture credential from first authenticated API call ──────────
    // We store it in an array to avoid TypeScript's strict narrowing limitation
    // where async callbacks prevent narrowing of outer 'let' variables.
    const credentialCapture: S9Credential[] = [];

    page.on('response', async (response) => {
        if (credentialCapture.length > 0) return; // already captured
        if (!response.url().includes('98ent.com')) return;
        if (response.request().method() !== 'POST') return;

        try {
            const raw = response.request().postData();
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed?.credential?.token) {
                credentialCapture.push(parsed.credential as S9Credential);
            }
        } catch {
            // ignore non-JSON requests
        }
    });

    // ─── Step 3: Login ────────────────────────────────────────────────────────
    const user = process.env.TEST_USER || 'yoongtestt01';
    const pass = process.env.TEST_PASS || 'Yoong01!!';
    await loginPage.login(user, pass);

    // ─── Step 4: Confirm login ────────────────────────────────────────────────
    await expect(loginPage.avatarImg).toBeVisible({ timeout: 10000 });
    console.log('Login successful.');

    // ─── Step 5: Trigger API calls if credential not captured yet ─────────────
    if (credentialCapture.length === 0) {
        await page.goto(`${process.env.BASE_URL || 'https://s9.com'}/games?ven_id=600005`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);
    }

    // ─── Step 6: Save browser session ────────────────────────────────────────
    await page.context().storageState({ path: authFile });
    console.log(`Auth state saved to ${authFile}`);

    // ─── Step 7: Save API credential ─────────────────────────────────────────
    if (credentialCapture.length > 0) {
        const cred = credentialCapture[0];
        fs.mkdirSync(path.dirname(credFile), { recursive: true });
        fs.writeFileSync(credFile, JSON.stringify(cred, null, 2));
        console.log(`API credential saved to ${credFile}`);
        console.log(`  uid=${cred.uid}  token=${cred.token.slice(0, 12)}...`);

        // ─── Step 8: Fetch and cache the vendor list ──────────────────────────
        // This runs AFTER credentials are saved, so globalSetup can also read
        // credential.json on subsequent runs. On the very first run, this is the
        // only place vendors.json gets written (globalSetup runs before auth).
        try {
            console.log('Fetching live vendor list...');
            const vendors = await getVendorList(cred.token);
            const active = vendors.filter(v => !EXCLUDED_VENDOR_IDS.has(v.ven_id));
            const summary = active.map(v => ({ id: v.ven_id, name: v.name }));
            fs.writeFileSync(vendorsFile, JSON.stringify(summary, null, 2), 'utf8');
            console.log(`Vendor list saved: ${active.length} active vendors → ${vendorsFile}`);
        } catch (e: any) {
            console.warn(`⚠️  Could not fetch vendor list: ${e.message}`);
            console.warn('vendors.json not updated — using cached version if it exists.');
        }
    } else {
        console.warn('⚠️  Could not capture API credential. Will retry on next auth run.');
    }
});
