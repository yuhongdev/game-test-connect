/**
 * home.spec.ts — TC-HOME-001 to TC-HOME-008
 *
 * Tests the home/dashboard page after login.
 * Uses saved storageState (setup project must have run first).
 */

import { test, expect } from '@playwright/test';
import { HomePage } from '../models/HomePage';
import { BottomNavPage } from '../models/BottomNavPage';

test.describe('Home Page', () => {

    test('TC-HOME-001 — Dashboard renders key elements after login', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();

        // Wallet section
        await expect(home.depositButton).toBeVisible({ timeout: 10000 });
        await expect(home.withdrawalButton).toBeVisible();

        // Bottom navigation exists
        const nav = new BottomNavPage(page);
        await expect(nav.homeTab).toBeVisible();
    });

    test('TC-HOME-002 — Promotional banners are visible', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissAnnouncementModal();

        await expect(home.bannerCarousel).toBeVisible({ timeout: 5000 });
    });

    test('TC-HOME-003 — Game category tabs are clickable', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissAnnouncementModal();

        await expect(home.popularGamesTab).toBeVisible({ timeout: 8000 });
        await home.switchGameTab('popular');
        await home.switchGameTab('collection');
        await home.switchGameTab('all');
    });

    test('TC-HOME-004 — Electronic games swiper is visible', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissAnnouncementModal();

        await expect(home.eGameSwiper).toBeVisible({ timeout: 8000 });
    });

    test('TC-HOME-005 — Live casino swiper is visible', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissAnnouncementModal();

        await expect(home.liveCasinoSwiper).toBeVisible({ timeout: 8000 });
    });

    test('TC-HOME-006 — Chatroom widget shows online users', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();

        await expect(home.chatroomWidget).toBeVisible({ timeout: 8000 });
    });

    test('TC-HOME-007 — Scoreboard and Live Broadcast show "Under construction"', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissAnnouncementModal();

        await home.scoreboardIcon.click();
        await expect(page.getByText(/under.*construct|coming soon/i)).toBeVisible({ timeout: 5000 });

        // Dismiss and check Live Broadcast
        const closeBtn = page.locator('[class*="close"], button').filter({ hasText: /ok|close/i }).first();
        if (await closeBtn.isVisible()) await closeBtn.click();

        await home.liveBroadcastIcon.click();
        await expect(page.getByText(/under.*construct|coming soon/i)).toBeVisible({ timeout: 5000 });
    });

    test('TC-HOME-008 — Notification icon opens notification list', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissAnnouncementModal();
        await home.clickNotification();

        // Notification list or drawer should appear
        await expect(
            page.locator('[class*="notice"], [class*="notification"]').filter({ hasText: /.+/ }).first()
        ).toBeVisible({ timeout: 5000 });
    });
});
