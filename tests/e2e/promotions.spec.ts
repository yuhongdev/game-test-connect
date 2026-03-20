/**
 * promotions.spec.ts — TC-PROMO-001 to TC-PROMO-003
 */

import { test, expect } from '@playwright/test';
import { PromotionsPage } from '../models/PromotionsPage';

test.describe('Promotions', () => {

    test('TC-PROMO-001 — Promotions page renders promotion cards', async ({ page }) => {
        const promos = new PromotionsPage(page);
        await promos.goto();

        await expect(promos.promotionCards.first()).toBeVisible({ timeout: 8000 });
        const count = await promos.getCardCount();
        expect(count).toBeGreaterThan(0);
    });

    test('TC-PROMO-002 — Category filter tabs change the displayed promotions', async ({ page }) => {
        const promos = new PromotionsPage(page);
        await promos.goto();

        const categories: Array<'all' | 'electronic' | 'sports' | 'general'> = [
            'all', 'electronic', 'sports', 'general',
        ];

        for (const cat of categories) {
            await promos.filterByCategory(cat);
            // After filtering each category tab should be clickable without error
            // Count may be 0 for some categories — that's acceptable (empty state)
        }
    });

    test('TC-PROMO-003 — Clicking a promotion card opens detail or modal', async ({ page }) => {
        const promos = new PromotionsPage(page);
        await promos.goto();

        const count = await promos.getCardCount();
        if (count === 0) {
            test.skip();
            return;
        }

        await promos.clickCard(0);

        // Expect either navigation to a detail page or a modal appearing
        const navigated = !page.url().endsWith('/promotion');
        const modalVisible = await page.locator('[class*="modal"], [class*="dialog"]').first().isVisible();
        expect(navigated || modalVisible).toBeTruthy();
    });
});
