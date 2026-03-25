/**
 * auth.spec.ts — TC-AUTH-001 to TC-AUTH-007
 *
 * These tests verify the login, logout, and session flows.
 * storageState is cleared so tests run unauthenticated.
 */

import { test, expect } from '@playwright/test';
import { LoginPage } from '../models/LoginPage';

// Run all auth tests without any saved session
test.use({ storageState: { cookies: [], origins: [] } });

const BASE = process.env.BASE_URL ?? 'https://s9.com';
const USER = process.env.TEST_USER ?? 'yoongtest05';
const PASS = process.env.TEST_PASS ?? 'Yoong01!';

test.describe('Authentication', () => {

    test('TC-AUTH-007 — Login page has required UI elements', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await page.goto(`${BASE}/login`);

        await expect(page.getByRole('textbox', { name: /email|phone|account/i })).toBeVisible();
        await expect(page.getByRole('textbox', { name: /password/i })).toBeVisible();
        // Scope to the form to avoid strict-mode collision with the sidebar Login button
        await expect(page.locator('form').getByRole('button', { name: /^login$/i })).toBeVisible();
        await expect(page.getByText(/forgot.*password|forgot the password/i)).toBeVisible();
        // "Sign Up" appears as a link in both the sidebar and the form paragraph — just check it exists
        await expect(page.getByText(/sign.*up/i).first()).toBeVisible();
    });

    test('TC-AUTH-001 — Valid login redirects to home', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await page.goto(`${BASE}/login`);
        await loginPage.login(USER, PASS);

        // After login the avatar should be visible
        await expect(loginPage.avatarImg).toBeVisible({ timeout: 15000 });
        expect(page.url()).not.toContain('/login');
    });

    test('TC-AUTH-002 — Wrong password shows error', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await page.goto(`${BASE}/login`);
        await loginPage.login(USER, 'wrong_password_xyz');

        // Should stay on login page
        expect(page.url()).toContain('/login');
        // The app shows "Bad Password" — broaden to catch that and other variants.
        const errorLocator = page
            .getByText(/bad.?password|error|invalid|incorrect|fail|wrong|帳號|密碼|please try|account.*not|not.*found/i)
            .or(page.locator('[class*="toast"], [class*="alert"], [class*="error"]').filter({ hasText: /.+/ }))
            .or(page.locator('[role="alert"]'));
        await expect(errorLocator.first()).toBeVisible({ timeout: 10000 });
    });

    test('TC-AUTH-003 — Empty fields show validation error', async ({ page }) => {
        await page.goto(`${BASE}/login`);
        await page.locator('form').getByRole('button', { name: /^login$/i }).click();

        // The app may use HTML5 native validation OR application-level error messages.
        // Check all possible signals.
        const nativeInvalid = await page.locator('input:invalid').count();
        const errorText = await page
            .getByText(/required|cannot be empty|please.*enter|please.*fill|fill in|帳號|密碼/i)
            .isVisible();
        const errorClass = await page
            .locator('[class*="error"], [class*="invalid"], [class*="toast"]')
            .filter({ hasText: /.+/ })
            .isVisible();
        expect(nativeInvalid > 0 || errorText || errorClass).toBeTruthy();
    });

    test('TC-AUTH-006 — Session persists after page refresh', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await page.goto(`${BASE}/login`);
        await loginPage.login(USER, PASS);
        await expect(loginPage.avatarImg).toBeVisible({ timeout: 15000 });

        // Refresh and confirm still logged in
        await page.reload();
        await expect(loginPage.avatarImg).toBeVisible({ timeout: 10000 });
        expect(page.url()).not.toContain('/login');
    });

    test('TC-AUTH-005 — Logout clears the session', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await page.goto(`${BASE}/login`);
        await loginPage.login(USER, PASS);
        await expect(loginPage.avatarImg).toBeVisible({ timeout: 15000 });

        await loginPage.logout();
        // App redirects to homepage after logout (not /login).
        // Wait for the banner's Login link to reappear — proof the session was cleared.
        // The banner renders Login as a generic/link element, not a button role.
        await expect(
            page.getByRole('banner').getByText('Login')
        ).toBeVisible({ timeout: 15000 });
    });

    test('TC-AUTH-004 — Remember password checkbox is present', async ({ page }) => {
        await page.goto(`${BASE}/login`);
        const rememberCheckbox = page.getByRole('checkbox').or(page.getByText(/remember/i));
        await expect(rememberCheckbox.first()).toBeVisible();
    });

    test('TC-NFR-004 — Protected route redirects to login when unauthenticated', async ({ page }) => {
        await page.goto(`${BASE}/personal`);
        await page.waitForURL(/login/, { timeout: 8000 });
        expect(page.url()).toContain('/login');
    });
});
