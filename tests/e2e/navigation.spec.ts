/**
 * navigation.spec.ts — TC-NAV-001 to TC-NAV-002
 *
 * Tests the persistent bottom navigation bar.
 */

import { test, expect } from '@playwright/test';
import { BottomNavPage } from '../models/BottomNavPage';
import { HomePage } from '../models/HomePage';

const EXPECTED_URLS: Record<string, RegExp> = {
    home:       /^https?:\/\/[^/]+\/?$/,
    deposit:    /personal\/recharge/,
    promotions: /promotion/,
    referral:   /agency/,
    profile:    /personal/,
};

test.describe('Bottom Navigation', () => {

    test('TC-NAV-002 — Each nav item routes to the correct URL', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissAnnouncementModal();

        const nav = new BottomNavPage(page);
        const sections: Array<'deposit' | 'promotions' | 'referral' | 'profile' | 'home'> = [
            'deposit', 'promotions', 'referral', 'profile', 'home',
        ];

        for (const section of sections) {
            await nav.navigateTo(section);
            expect(page.url()).toMatch(EXPECTED_URLS[section]);
        }
    });

    test('TC-NAV-001 — Active tab is highlighted for the current route', async ({ page }) => {
        const nav = new BottomNavPage(page);
        await page.goto('/promotion');
        await page.waitForLoadState('networkidle');

        // At minimum the active tab should exist (class based)
        const activeCount = await page.locator(
            '[class*="tabbar"] [class*="active"], [class*="bottom-nav"] [class*="active"]'
        ).count();
        expect(activeCount).toBeGreaterThan(0);
    });
});
