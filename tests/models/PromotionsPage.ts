import { Page, Locator } from '@playwright/test';

export type PromoCategory = 'all' | 'electronic' | 'sports' | 'general';

export class PromotionsPage {
    readonly page: Page;

    // Category filter tabs
    readonly allTab: Locator;
    readonly electronicTab: Locator;
    readonly sportsTab: Locator;
    readonly generalTab: Locator;

    // Content
    readonly promotionCards: Locator;

    constructor(page: Page) {
        this.page = page;

        this.allTab        = page.getByRole('tab', { name: /^all$/i }).or(page.getByText(/^all$/i)).first();
        this.electronicTab = page.getByText(/electronic|e-game/i).first();
        this.sportsTab     = page.getByText(/^sports$/i).first();
        this.generalTab    = page.getByText(/^general$/i).first();

        this.promotionCards = page.locator('[class*="promo"] [class*="card"], [class*="promotion-item"]');
    }

    async goto() {
        await this.page.goto('/promotion');
        await this.page.waitForLoadState('networkidle');
    }

    async filterByCategory(category: PromoCategory) {
        const map = {
            all:        this.allTab,
            electronic: this.electronicTab,
            sports:     this.sportsTab,
            general:    this.generalTab,
        };
        await map[category].click();
        await this.page.waitForTimeout(500);
    }

    async getCardCount(): Promise<number> {
        return this.promotionCards.count();
    }

    async clickCard(index = 0) {
        await this.promotionCards.nth(index).click();
    }

    async getCardTitles(): Promise<string[]> {
        const titles = await this.promotionCards.locator('[class*="title"]').allTextContents();
        return titles;
    }
}
