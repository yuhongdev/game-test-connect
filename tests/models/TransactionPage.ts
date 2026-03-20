import { Page, Locator } from '@playwright/test';

export class TransactionPage {
    readonly page: Page;

    readonly currencyFilter: Locator;
    readonly timeRangeFilter: Locator;
    readonly transactionItems: Locator;
    readonly emptyStateText: Locator;

    constructor(page: Page) {
        this.page = page;

        this.currencyFilter   = page.locator('[class*="currency"]').first();
        this.timeRangeFilter  = page.locator('[class*="time"], [class*="date-range"]').first();
        this.transactionItems = page.locator('[class*="transaction-item"], [class*="record-item"]');
        this.emptyStateText   = page.getByText(/no.*data|no.*record|empty/i);
    }

    async goto() {
        await this.page.goto('/personal/transaction');
        await this.page.waitForLoadState('networkidle');
    }

    async filterByTimeRange(range: string) {
        await this.timeRangeFilter.click();
        await this.page.getByText(range, { exact: false }).click();
        await this.page.waitForTimeout(500);
    }

    async getTransactionCount(): Promise<number> {
        return this.transactionItems.count();
    }
}
