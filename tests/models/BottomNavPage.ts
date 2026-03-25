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

        // Bottom nav items are plain generic divs — each contains an img with alt text and a text label.
        // We locate by the img alt for Home/Deposit (which have alt attrs) and by text for others.
        this.homeTab       = page.getByRole('img', { name: 'Home' });
        this.depositTab    = page.getByRole('img', { name: 'Deposit' }).first();
        this.promotionsTab = page.getByText('Promotions', { exact: true }).last();
        this.referralTab   = page.getByText('Referral', { exact: true }).last();
        this.profileTab    = page.getByText('Profile', { exact: true }).last();
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
