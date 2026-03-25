/**
 * home.spec.ts — TC-HOME-001 to TC-HOME-008
 *
 * Tests the home/dashboard page after login.
 * Uses saved storageState (setup project must have run first).
 *
 * Known runtime overlays — handled automatically:
 *  - Browser alert (developer push reload): accepted inside HomePage.goto().
 *  - Full-screen notification overlay: dismissed via home.dismissOverlays() after load.
 */

import { test, expect } from '@playwright/test';
import { HomePage } from '../models/HomePage';
import { BottomNavPage } from '../models/BottomNavPage';

test.describe('Home Page', () => {

    test('TC-HOME-001 — Dashboard renders key elements after login', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissOverlays();

        // Notification icon in header is always visible when logged in
        await expect(home.notificationIcon).toBeVisible({ timeout: 10000 });

        // Logo / menu toggle is always visible
        await expect(home.sidebarToggle).toBeVisible();

        // Bottom navigation exists
        const nav = new BottomNavPage(page);
        await expect(nav.homeTab).toBeVisible();
    });

    test('TC-HOME-001b — Sidebar wallet shows Deposit and Withdrawal buttons', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissOverlays();

        // Open sidebar to reveal wallet buttons
        await home.openSidebar();
        await expect(home.depositButton).toBeVisible({ timeout: 5000 });
        await expect(home.withdrawalButton).toBeVisible({ timeout: 5000 });
    });

    test('TC-HOME-002 — Promotional banners are visible', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissOverlays();
        await home.dismissAnnouncementModal();

        await expect(home.bannerCarousel).toBeVisible({ timeout: 5000 });
    });

    test('TC-HOME-003 — Game category tabs are clickable', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissOverlays();
        await home.dismissAnnouncementModal();

        await expect(home.popularGamesTab).toBeVisible({ timeout: 8000 });
        await home.switchGameTab('popular');
        await home.switchGameTab('collection');
        await home.switchGameTab('all');
    });

    test('TC-HOME-004 — Electronic games section heading is visible', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissOverlays();
        await home.dismissAnnouncementModal();

        await expect(home.eGameSwiper).toBeVisible({ timeout: 8000 });
    });

    test('TC-HOME-005 — Live casino section heading is visible', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissOverlays();
        await home.dismissAnnouncementModal();

        await expect(home.liveCasinoSwiper).toBeVisible({ timeout: 8000 });
    });

    test('TC-HOME-006 — Chatroom widget shows online users', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissOverlays();

        await expect(home.chatroomWidget).toBeVisible({ timeout: 8000 });
        // The online count indicator should also be visible
        await expect(page.getByText(/Online:\s*\d+/i)).toBeVisible({ timeout: 5000 });
    });

    test('TC-HOME-007 — Scoreboard and Live Broadcast show "Under construction"', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissOverlays();
        await home.dismissAnnouncementModal();

        // Scoreboard — click then immediately assert the transient toast before it fades
        await home.scoreboardIcon.click();
        await expect(
            page.getByText(/under construction|coming soon/i)
        ).toBeVisible({ timeout: 3000 });

        // Wait for toast to auto-dismiss before clicking Live Broadcast
        await expect(
            page.getByText(/under construction|coming soon/i)
        ).toBeHidden({ timeout: 6000 });

        // Live Broadcast — same behavior
        await home.liveBroadcastIcon.click();
        await expect(
            page.getByText(/under construction|coming soon/i)
        ).toBeVisible({ timeout: 3000 });
    });

    test('TC-HOME-008 — Notification icon opens notification list', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissOverlays();
        await home.dismissAnnouncementModal();

        await home.clickNotification();

        // The notification panel appears with a "Notifications" heading and h4 item titles.
        // It uses Tailwind utility classes (no semantic class names), so we match by content.
        await expect(
            page.getByText('Notifications', { exact: true })
        ).toBeVisible({ timeout: 5000 });
    });
});
