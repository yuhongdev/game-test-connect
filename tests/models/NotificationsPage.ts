import { Page, Locator } from '@playwright/test';

export class NotificationsPage {
    readonly page: Page;

    readonly notificationIcon: Locator;
    readonly drawer: Locator;
    readonly notificationItems: Locator;
    readonly unreadBadge: Locator;

    constructor(page: Page) {
        this.page = page;

        this.notificationIcon  = page.locator('[class*="notice-icon"], [class*="notification-icon"], [class*="bell"]').first();
        this.drawer            = page.locator('[class*="notice-drawer"], [class*="notification-list"], [class*="notice-panel"]').first();
        this.notificationItems = page.locator('[class*="notice-item"], [class*="notification-item"]');
        this.unreadBadge       = page.locator('[class*="badge"], [class*="unread-count"]').first();
    }

    async open() {
        await this.notificationIcon.click();
        await this.drawer.waitFor({ state: 'visible', timeout: 5000 });
    }

    async clickFirst() {
        await this.notificationItems.first().click();
    }

    async getUnreadCount(): Promise<number> {
        const text = await this.unreadBadge.textContent({ timeout: 3000 }).catch(() => '0');
        return parseInt(text ?? '0', 10) || 0;
    }

    async getItemCount(): Promise<number> {
        return this.notificationItems.count();
    }
}
