/**
 * captureApi.spec.ts — One-off diagnostic test to capture real API headers & payloads
 * Run: npx playwright test tests/captureApi.spec.ts --project=chromium --headed --reporter=line
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const OUTPUT = path.join(__dirname, '..', 'scripts', 'captured_api.json');
const VENDOR_URL = 'https://s9.com/games?ven_id=600005';

const TARGETS = ['game-vendor/list', 'partner/game/list', 'wallet/list', 'game/enter'];

const captured: Record<string, any> = {};

test('Capture all API headers and payloads', async ({ page }) => {
    test.setTimeout(60000);

    // Intercept every response from the s9 backend
    page.on('response', async (response) => {
        const url = response.url();
        const key = TARGETS.find(t => url.includes(t));
        if (!key || captured[key]) return;

        try {
            const req = response.request();
            const rawBody = req.postData() ?? '';
            const rawResponse = await response.text();

            captured[key] = {
                url,
                method: req.method(),
                requestHeaders: req.headers(),
                requestBody: rawBody ? JSON.parse(rawBody) : null,
                responseStatus: response.status(),
                responseHeaders: response.headers(),
                responseBody: JSON.parse(rawResponse),
            };

            console.log(`\n✅ CAPTURED: ${key}`);
            console.log(`   URL: ${url}`);
            console.log(`   Request body:`);
            console.log(JSON.stringify(captured[key].requestBody, null, 4));
            console.log(`   Response (${response.status()}):`);
            console.log(JSON.stringify(captured[key].responseBody, null, 4));
        } catch (e: any) {
            console.warn(`⚠️  Failed to capture ${key}: ${e.message}`);
        }
    });

    // Navigate — this triggers vendor list + game list + wallet list
    await page.goto(VENDOR_URL);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Click first game card to trigger game/enter
    const firstGameImg = page.locator('img[src*="game/"]').first();
    if (await firstGameImg.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('\nClicking first game to trigger game/enter...');
        await firstGameImg.click();
        await page.waitForTimeout(3000);
    } else {
        console.warn('⚠️  No game card found — game/enter may not be captured');
    }

    await page.waitForTimeout(2000);

    // Save to file
    fs.writeFileSync(OUTPUT, JSON.stringify(captured, null, 2));
    console.log(`\n\n📁 Saved to: ${OUTPUT}`);
    console.log('Keys captured:', Object.keys(captured).join(', '));

    // Print credential separately for quick reference
    const firstCall = Object.values(captured)[0] as any;
    if (firstCall?.requestBody?.credential) {
        console.log('\n📋 CREDENTIAL OBJECT:');
        console.log(JSON.stringify(firstCall.requestBody.credential, null, 2));
    }
});
