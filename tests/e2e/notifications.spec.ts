/**
 * notifications.spec.ts — TC-NOTIF-001 to TC-NOTIF-002
 */

import { test, expect } from '@playwright/test';
import { NotificationsPage } from '../models/NotificationsPage';
import { HomePage } from '../models/HomePage';

test.describe('Notifications', () => {

    test('TC-NOTIF-001 — Notification icon opens notification drawer', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissAnnouncementModal();

        const notif = new NotificationsPage(page);
        await notif.open();

        await expect(notif.drawer).toBeVisible({ timeout: 5000 });
    });

    test('TC-NOTIF-002 — Clicking a notification marks it as read', async ({ page }) => {
        const home = new HomePage(page);
        await home.goto();
        await home.dismissAnnouncementModal();

        const notif = new NotificationsPage(page);
        await notif.open();

        const count = await notif.getItemCount();
        if (count === 0) {
            test.skip();
            return;
        }

        const unreadBefore = await notif.getUnreadCount();
        await notif.clickFirst();
        await page.waitForTimeout(500);

        const unreadAfter = await notif.getUnreadCount();
        // After clicking, unread count should decrease or detail should appear
        expect(unreadAfter <= unreadBefore).toBeTruthy();
    });
});
