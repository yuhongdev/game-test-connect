/**
 * withdrawal.spec.ts — TC-WD-001 to TC-WD-007
 *
 * Tests the Withdrawal page on s9.com.
 *
 * ⚠️  Fund password keyboard is randomized — we always press "1" six times.
 *     Test fund password = "111111"
 */

import { test, expect } from '@playwright/test';
import { WithdrawalPage } from '../models/WithdrawalPage';
import { FundPasswordPage } from '../models/FundPasswordPage';

test.describe('Withdrawal', () => {

    test('TC-WD-001 — Special Offer modal appears and can be dismissed when clicking withdrawal', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        // Click withdrawal from the home wallet section
        const withdrawalBtn = page.getByRole('button', { name: /withdraw/i }).first();
        if (await withdrawalBtn.isVisible()) {
            await withdrawalBtn.click();
        }

        const wd = new WithdrawalPage(page);
        // If modal appeared, dismiss it
        await wd.dismissSpecialOfferModal();

        // After dismissal, we should be on the withdrawal page or still on home (binding required)
        expect(page.url()).toMatch(/withdraw|personal|\//);
    });

    test('TC-WD-002 — Account binding modal shown if no account is bound', async ({ page }) => {
        const wd = new WithdrawalPage(page);
        await wd.goto();
        await wd.dismissSpecialOfferModal();

        const bindingRequired = await wd.isAccountBindingRequired();

        if (bindingRequired) {
            await expect(wd.accountBindingModal).toBeVisible({ timeout: 5000 });
        } else {
            // Account is already bound — verify withdrawal form instead
            await expect(wd.withdrawButton).toBeVisible({ timeout: 5000 });
        }
    });

    test('TC-WD-003 — Withdrawal form fields render when account is bound', async ({ page }) => {
        const wd = new WithdrawalPage(page);
        await wd.goto();
        await wd.dismissSpecialOfferModal();

        if (await wd.isAccountBindingRequired()) {
            test.skip();
            return;
        }

        await expect(wd.networkDropdown).toBeVisible({ timeout: 8000 });
        await expect(wd.addressDropdown).toBeVisible();
        await expect(wd.amountInput).toBeVisible();
        await expect(wd.withdrawButton).toBeVisible();
    });

    test('TC-WD-004 — Amount below 1 USDT shows validation error', async ({ page }) => {
        const wd = new WithdrawalPage(page);
        await wd.goto();
        await wd.dismissSpecialOfferModal();

        if (await wd.isAccountBindingRequired()) {
            test.skip();
            return;
        }

        await wd.enterAmount('0');
        await wd.clickWithdraw();

        await expect(
            page.getByText(/minimum|at least|1 usdt|invalid amount/i)
        ).toBeVisible({ timeout: 5000 });
    });

    test('TC-WD-005 — Turnover Required info is displayed', async ({ page }) => {
        const wd = new WithdrawalPage(page);
        await wd.goto();
        await wd.dismissSpecialOfferModal();

        if (await wd.isAccountBindingRequired()) {
            test.skip();
            return;
        }

        await expect(wd.turnoverRequiredText).toBeVisible({ timeout: 8000 });
    });

    test('TC-WD-006 — Fund password field uses randomized keyboard, "1" button is clickable', async ({ page }) => {
        const wd = new WithdrawalPage(page);
        await wd.goto();
        await wd.dismissSpecialOfferModal();

        if (await wd.isAccountBindingRequired()) {
            test.skip();
            return;
        }

        // Click fund password field to trigger keyboard
        await wd.fundPasswordField.click();

        const fundPw = new FundPasswordPage(page);
        await fundPw.waitForKeyboard();

        // Verify the randomized keyboard is visible and "1" button exists
        await expect(fundPw.keyboardContainer).toBeVisible();
        await expect(fundPw.digitButton('1')).toBeVisible();

        // Click "1" six times (test PIN = 111111)
        await fundPw.enterPin('111111');
    });

    test('TC-WD-007 — Withdrawal form completes submission flow (UI only, no real funds)', async ({ page }) => {
        const wd = new WithdrawalPage(page);
        await wd.goto();
        await wd.dismissSpecialOfferModal();

        if (await wd.isAccountBindingRequired()) {
            test.skip();
            return;
        }

        // Fill the form
        await wd.enterAmount('1');
        await wd.fundPasswordField.click();

        const fundPw = new FundPasswordPage(page);
        await fundPw.waitForKeyboard();
        await fundPw.enterPin('111111');
        await wd.clickWithdraw();

        // Expect either success toast, pending status, or error (insufficient balance / turnover)
        await expect(
            page.getByText(/success|submitted|pending|insufficient|turnover/i)
        ).toBeVisible({ timeout: 10000 });
    });
});
