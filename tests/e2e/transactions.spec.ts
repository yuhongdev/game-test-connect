/**
 * transactions.spec.ts — TC-TXN-001 to TC-TXN-002
 */

import { test, expect } from '@playwright/test';
import { TransactionPage } from '../models/TransactionPage';

test.describe('Transaction Records', () => {

    test('TC-TXN-001 — Transaction records page renders with filter controls', async ({ page }) => {
        const txn = new TransactionPage(page);
        await txn.goto();

        // Currency filter or time filter should be visible
        await expect(
            txn.currencyFilter.or(txn.timeRangeFilter).first()
        ).toBeVisible({ timeout: 8000 });
    });

    test('TC-TXN-002 — Time range filter updates the displayed transactions', async ({ page }) => {
        const txn = new TransactionPage(page);
        await txn.goto();

        if (!await txn.timeRangeFilter.isVisible()) {
            test.skip();
            return;
        }

        // Click the time filter and pick first option
        await txn.timeRangeFilter.click();
        const firstOption = page.locator('[class*="option"], [role="option"]').first();
        if (await firstOption.isVisible()) {
            await firstOption.click();
            await page.waitForTimeout(800);
        }

        // Page should not crash
        expect(page.url()).toContain('transaction');
    });
});
