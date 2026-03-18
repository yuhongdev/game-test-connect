/**
 * captureApiHeaders.ts
 * Run: npx ts-node scripts/captureApiHeaders.ts
 *
 * Logs in to s9.com, navigates to the Amusnet vendor page, enters one game,
 * and captures the exact request headers + payloads for all 4 API endpoints.
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

const OUTPUT_FILE = path.join(__dirname, 'captured_api.json');

const ENDPOINTS = [
    'game-vendor/list',
    'game/list',
    'wallet/list',
    'game/enter',
];

interface CapturedCall {
    url: string;
    method: string;
    requestHeaders: Record<string, string>;
    requestBody: any;
    responseStatus: number;
    responseHeaders: Record<string, string>;
    responseBody: any;
}

async function main() {
    const captured: Record<string, CapturedCall> = {};

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Intercept all API responses matching our endpoints
    page.on('response', async (response) => {
        const url = response.url();
        const matched = ENDPOINTS.find(ep => url.includes(ep));
        if (!matched || captured[matched]) return;

        try {
            const req = response.request();
            const reqBody = req.postData();
            const resBody = await response.text();

            captured[matched] = {
                url,
                method: req.method(),
                requestHeaders: req.headers(),
                requestBody: reqBody ? JSON.parse(reqBody) : null,
                responseStatus: response.status(),
                responseHeaders: response.headers(),
                responseBody: JSON.parse(resBody),
            };

            console.log(`\n✅ Captured: ${matched}`);
            console.log(`   URL: ${url}`);
            console.log(`   Status: ${response.status()}`);
        } catch (e) {
            console.error(`❌ Failed to capture ${matched}:`, e);
        }
    });

    // Step 1: Navigate and login
    console.log('Navigating to s9.com...');
    await page.goto('https://s9.com/games?ven_id=600005');
    await page.waitForLoadState('networkidle');

    // Use stored auth state if available, otherwise login manually
    const authFile = path.join(__dirname, '../playwright/.auth/user.json');
    if (fs.existsSync(authFile)) {
        console.log('Using stored auth state — loading cookies...');
        await context.addCookies(
            JSON.parse(fs.readFileSync(authFile, 'utf8')).cookies || []
        );
        await page.reload();
        await page.waitForLoadState('networkidle');
    }

    // Check if logged in, otherwise login
    const isLoggedIn = await page.getByRole('banner').getByText('Login').isVisible({ timeout: 3000 }).catch(() => false);
    if (isLoggedIn) {
        console.log('Logging in manually...');
        await page.getByRole('banner').getByText('Login').click();
        await page.getByPlaceholder(/username|account/i).fill(process.env.TEST_USER || 'yoongtestt01');
        await page.getByPlaceholder(/password/i).fill(process.env.TEST_PASS || 'Yoong01!!');
        await page.getByRole('button', { name: /login|sign in/i }).click();
        await page.waitForLoadState('networkidle');
    }

    // Step 2: Trigger vendor list + game list by navigating to vendor page
    console.log('\nNavigating to Amusnet vendor page to trigger game-vendor/list and game/list...');
    await page.goto('https://s9.com/games?ven_id=600005');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000); // allow background calls to fire

    // Step 3: Trigger wallet/list by waiting (usually fires on page load)
    await page.waitForTimeout(1000);

    // Step 4: Click a game to trigger game/enter
    console.log('\nClicking first game card to trigger game/enter...');
    const firstGame = page.locator('img[src*="game/"]').first();
    if (await firstGame.isVisible({ timeout: 5000 }).catch(() => false)) {
        await firstGame.click();
        await page.waitForTimeout(3000);
    } else {
        console.warn('⚠️  Could not find game card to click');
    }

    // Wait for all captures
    await page.waitForTimeout(2000);

    // Save captured data
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(captured, null, 2));
    console.log(`\n✅ All captured. Saved to: ${OUTPUT_FILE}`);
    console.log('Captured endpoints:', Object.keys(captured).join(', '));

    // Print credential for reference
    const anyCall = Object.values(captured)[0];
    if (anyCall?.requestBody?.credential) {
        console.log('\n📋 Credential object:');
        console.log(JSON.stringify(anyCall.requestBody.credential, null, 2));
    }

    await browser.close();
}

main().catch(console.error);
