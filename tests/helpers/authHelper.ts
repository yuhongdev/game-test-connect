import { Page, expect } from '@playwright/test';
import { LoginPage } from '../models/LoginPage';

/**
 * Checks if the current page session is still valid by verifying the avatar is visible.
 * @returns true if logged in, false if session has expired
 */
export async function isSessionValid(page: Page): Promise<boolean> {
    try {
        const loginPage = new LoginPage(page);
        await expect(loginPage.avatarImg).toBeVisible({ timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Performs a full re-authentication on the given page instance.
 * Navigates to the homepage, clicks login, fills in credentials, and waits
 * for the avatar to confirm the session is restored.
 *
 * Use this mid-test when a session token expires during a long-running loop.
 */
export async function reAuthenticate(page: Page): Promise<void> {
    console.warn('[Auth] Session invalid or expired. Re-authenticating...');

    const loginPage = new LoginPage(page);
    const user = process.env.TEST_USER || 'yoongtestt01';
    const pass = process.env.TEST_PASS || 'Yoong01!!';

    // Navigate to root first to ensure we are on a clean state
    await page.goto('/');
    
    // If avatar is already visible, session recovered on its own (e.g. cookie refresh)
    const alreadyLoggedIn = await isSessionValid(page);
    if (alreadyLoggedIn) {
        console.log('[Auth] Session recovered automatically. Proceeding...');
        return;
    }

    // Perform fresh login
    await loginPage.login(user, pass);
    await expect(loginPage.avatarImg).toBeVisible({ timeout: 10000 });
    console.log('[Auth] Re-authentication successful. Resuming test...');
}
