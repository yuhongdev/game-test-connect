import { Page, Locator } from '@playwright/test';

export class BetHistoryPage {
    readonly page: Page;

    readonly manufacturerDropdown: Locator;
    readonly gameDropdown: Locator;
    readonly dateRangeStart: Locator;
    readonly dateRangeEnd: Locator;
    readonly applyButton: Locator;

    readonly tableRows: Locator;
    readonly emptyStateText: Locator;

    constructor(page: Page) {
        this.page = page;

        this.manufacturerDropdown = page.locator('[class*="manufacturer"], [class*="vendor"]').first();
        this.gameDropdown         = page.locator('[class*="game-select"], [class*="select-game"]').first();
        this.dateRangeStart       = page.locator('input[type="date"]').first();
        this.dateRangeEnd         = page.locator('input[type="date"]').last();
        this.applyButton          = page.getByRole('button', { name: /search|apply|query/i });

        this.tableRows      = page.locator('table tbody tr, [class*="bet-item"], [class*="record-item"]');
        this.emptyStateText = page.getByText(/no.*data|no.*record|empty/i);
    }

    async goto() {
        await this.page.goto('/personal/bet');
        await this.page.waitForLoadState('networkidle');
    }

    async filterByManufacturer(name: string) {
        await this.manufacturerDropdown.click();
        await this.page.getByText(name, { exact: false }).click();
        await this.page.waitForTimeout(500);
    }

    async filterByDate(from: string, to: string) {
        await this.dateRangeStart.fill(from);
        await this.dateRangeEnd.fill(to);
        if (await this.applyButton.isVisible()) {
            await this.applyButton.click();
        }
        await this.page.waitForTimeout(500);
    }

    async getRowCount(): Promise<number> {
        return this.tableRows.count();
    }
}
