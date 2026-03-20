/**
 * profile.spec.ts — TC-PROFILE-001 to TC-PROFILE-010
 *
 * Tests the Personal Center / Profile page.
 */

import { test, expect } from '@playwright/test';
import { ProfilePage } from '../models/ProfilePage';

test.describe('Profile / Personal Center', () => {

    test('TC-PROFILE-001 — User info (nickname, ID, avatar) is displayed', async ({ page }) => {
        const profile = new ProfilePage(page);
        await profile.goto();

        await expect(profile.avatar).toBeVisible({ timeout: 8000 });
        // Nickname and/or user ID should be non-empty
        const nickname = await profile.getNickname();
        expect(nickname.trim().length).toBeGreaterThan(0);
    });

    test('TC-PROFILE-002 — Bet Records link navigates correctly', async ({ page }) => {
        const profile = new ProfilePage(page);
        await profile.goto();
        await profile.clickBetRecords();

        expect(page.url()).toMatch(/bet|record/);
    });

    test('TC-PROFILE-002b — Transaction Records link navigates correctly', async ({ page }) => {
        const profile = new ProfilePage(page);
        await profile.goto();
        await profile.clickTransactions();

        expect(page.url()).toMatch(/transaction|record/);
    });

    test('TC-PROFILE-003 — Personal Info tab shows contact form fields', async ({ page }) => {
        const profile = new ProfilePage(page);
        await profile.goto();
        await profile.switchTab('personal');

        // At least one form input should be visible
        const inputCount = await page.locator('input, [class*="form-item"]').count();
        expect(inputCount).toBeGreaterThan(0);
    });

    test('TC-PROFILE-005 — Deposit & Withdrawal Account tab shows Add Account button', async ({ page }) => {
        const profile = new ProfilePage(page);
        await profile.goto();
        await profile.switchTab('account');

        await expect(profile.addAccountButton).toBeVisible({ timeout: 5000 });
        await expect(profile.changeFundPasswordButton).toBeVisible();
    });

    test('TC-PROFILE-006c — Add Account triggers fund password setup when none set', async ({ page }) => {
        const profile = new ProfilePage(page);
        await profile.goto();
        await profile.switchTab('account');
        await profile.clickAddAccount();

        // Should either show a fund-password prompt or the account form
        await expect(
            page.locator('[class*="fund-password"], [class*="keyboard"], [class*="pin"]')
                .or(page.getByText(/fund.*password|set.*pin/i))
                .first()
        ).toBeVisible({ timeout: 8000 });
    });

    test('TC-PROFILE-007 — Security Settings tab shows Change Password button', async ({ page }) => {
        const profile = new ProfilePage(page);
        await profile.goto();
        await profile.switchTab('security');

        await expect(profile.changeLoginPasswordButton).toBeVisible({ timeout: 5000 });
    });

    test('TC-PROFILE-009 — Theme toggle is visible', async ({ page }) => {
        const profile = new ProfilePage(page);
        await profile.goto();

        await expect(profile.themeToggle).toBeVisible({ timeout: 5000 });
    });

    test('TC-PROFILE-010 — Language selector is accessible via sidebar', async ({ page }) => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');

        // Open sidebar
        const sidebarToggle = page.locator('[class*="menu"], [class*="hamburger"]').first();
        await sidebarToggle.click();

        // Look for language selector
        const langSelector = page.locator('[class*="lang"], [class*="language"]').first();
        await expect(langSelector).toBeVisible({ timeout: 5000 });
    });
});
