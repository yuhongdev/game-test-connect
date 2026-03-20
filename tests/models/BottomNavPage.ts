import { Page, Locator } from '@playwright/test';

export type NavSection = 'home' | 'deposit' | 'promotions' | 'referral' | 'profile';

export class BottomNavPage {
    readonly page: Page;

    readonly homeTab: Locator;
    readonly depositTab: Locator;
    readonly promotionsTab: Locator;
    readonly referralTab: Locator;
    readonly profileTab: Locator;

    constructor(page: Page) {
        this.page = page;

        // Bottom navigation bar — select by text within the bottom nav region
        const nav = page.locator('[class*="tabbar"], [class*="bottom-nav"], [class*="footer-nav"]').first();

        this.homeTab       = nav.getByText(/^home$/i);
        this.depositTab    = nav.getByText(/^deposit$/i);
        this.promotionsTab = nav.getByText(/promo/i);
        this.referralTab   = nav.getByText(/referral|agency/i);
        this.profileTab    = nav.getByText(/profile|me$/i);
    }

    async navigateTo(section: NavSection) {
        const map: Record<NavSection, Locator> = {
            home:       this.homeTab,
            deposit:    this.depositTab,
            promotions: this.promotionsTab,
            referral:   this.referralTab,
            profile:    this.profileTab,
        };
        await map[section].click();
        await this.page.waitForLoadState('networkidle');
    }

    /** Returns the text content of the visually active tab */
    async getActiveTabText(): Promise<string | null> {
        const active = this.page.locator(
            '[class*="tabbar"] [class*="active"], [class*="bottom-nav"] [class*="active"]'
        ).first();
        return active.textContent();
    }
}
