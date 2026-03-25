import { Page, Locator } from '@playwright/test';

export class WithdrawalPage {
    readonly page: Page;

    // Tabs
    readonly digitalWalletTab: Locator;
    readonly cryptoPaymentTab: Locator;

    // Form fields
    readonly currencyDisplay: Locator;
    readonly networkDropdown: Locator;
    readonly addressDropdown: Locator;
    readonly amountInput: Locator;
    readonly fundPasswordField: Locator;
    readonly withdrawButton: Locator;

    // Info panel
    readonly availableBalanceText: Locator;
    readonly turnoverRequiredText: Locator;

    // Modals
    readonly specialOfferModal: Locator;
    readonly specialOfferCloseButton: Locator;
    readonly accountBindingModal: Locator;

    constructor(page: Page) {
        this.page = page;

        // Tabs
        this.digitalWalletTab = page.getByRole('tab', { name: /digital.*wallet/i })
            .or(page.getByText(/digital.*wallet/i)).first();
        this.cryptoPaymentTab = page.getByRole('tab', { name: /crypto.*pay/i })
            .or(page.getByText(/crypto.*pay/i)).first();

        // Form
        this.currencyDisplay   = page.locator('[class*="currency"]').first();
        this.networkDropdown   = page.locator('[class*="network"]').first();
        this.addressDropdown   = page.locator('[class*="address"]').first();
        this.amountInput       = page.getByPlaceholder(/amount|enter.*amount/i);
        this.fundPasswordField = page.locator('[class*="fund-password"]')
            .or(page.locator('[class*="fundpassword"]'))
            .or(page.locator('[class*="pin-input"], [class*="pin"]').first())
            .first();
        this.withdrawButton    = page.getByRole('button', { name: /^withdraw$/i });

        // Info panel
        this.availableBalanceText = page.getByText(/available.*balance/i);
        this.turnoverRequiredText = page.getByText(/turnover.*required|turnover/i);

        // Modals
        this.specialOfferModal       = page.locator('[class*="modal"], [class*="dialog"]').filter({ hasText: /special.*offer|offer/i }).first();
        this.specialOfferCloseButton = this.specialOfferModal.locator('[class*="close"], button').first();
        this.accountBindingModal     = page.getByText(/account.*binding|binding.*required/i);
    }

    async goto() {
        await this.page.goto('/personal/withdraw');
        await this.page.waitForLoadState('networkidle');
    }

    /** Dismisses the Special Offer modal that may appear when navigating to withdrawal. */
    async dismissSpecialOfferModal() {
        if (await this.specialOfferModal.isVisible()) {
            await this.specialOfferCloseButton.click();
            await this.specialOfferModal.waitFor({ state: 'hidden', timeout: 5000 });
        }
    }

    async selectNetwork(network: string) {
        await this.networkDropdown.click();
        await this.page.getByText(network, { exact: false }).click();
    }

    async selectAddress(address: string) {
        await this.addressDropdown.click();
        await this.page.getByText(address, { exact: false }).click();
    }

    async enterAmount(amount: string | number) {
        await this.amountInput.fill(String(amount));
    }

    async clickWithdraw() {
        await this.withdrawButton.click();
    }

    async getAvailableBalance(): Promise<string> {
        return (await this.availableBalanceText.textContent()) ?? '';
    }

    async getTurnoverRequired(): Promise<string> {
        return (await this.turnoverRequiredText.textContent()) ?? '';
    }

    async isAccountBindingRequired(): Promise<boolean> {
        return this.accountBindingModal.isVisible();
    }
}
