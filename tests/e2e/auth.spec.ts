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
        await expect(page.getByRole('button', { name: /^login$/i })).toBeVisible();
        await expect(page.getByText(/forgot.*password|forgot the password/i)).toBeVisible();
        await expect(page.getByText(/sign.*up/i)).toBeVisible();
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

        // Should stay on login; some error text should appear
        await expect(page.getByText(/error|invalid|incorrect|fail|wrong/i)).toBeVisible({ timeout: 8000 });
        expect(page.url()).toContain('/login');
    });

    test('TC-AUTH-003 — Empty fields show validation error', async ({ page }) => {
        await page.goto(`${BASE}/login`);
        await page.getByRole('button', { name: /^login$/i }).click();

        // Error or field highlighting should appear
        const errorVisible = await page.getByText(/required|cannot be empty|please.*enter/i).isVisible();
        const inputInvalid = await page.locator('input:invalid').count();
        expect(errorVisible || inputInvalid > 0).toBeTruthy();
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

    test('TC-AUTH-005 — Logout redirects to login', async ({ page }) => {
        const loginPage = new LoginPage(page);
        await page.goto(`${BASE}/login`);
        await loginPage.login(USER, PASS);
        await expect(loginPage.avatarImg).toBeVisible({ timeout: 15000 });

        await loginPage.logout();
        await page.waitForURL(/login/, { timeout: 10000 });
        expect(page.url()).toContain('/login');
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
