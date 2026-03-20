import { Page, Locator } from '@playwright/test';

export type DepositTab    = 'digital' | 'crypto';
export type DepositSubTab = 'qr' | 'link';

export class DepositPage {
    readonly page: Page;

    // Main tabs
    readonly digitalWalletTab: Locator;
    readonly cryptoPaymentTab: Locator;

    // Sub-tabs under Digital Wallet
    readonly walletQRSubTab: Locator;
    readonly walletLinkSubTab: Locator;

    // Dropdowns
    readonly currencyDropdown: Locator;
    readonly networkDropdown: Locator;

    // Wallet QR sub-tab content
    readonly qrCodeImage: Locator;
    readonly walletAddressText: Locator;
    readonly copyAddressButton: Locator;
    readonly rateNotice: Locator;

    // Wallet Link sub-tab content
    readonly walletLinkButton: Locator;
    readonly depositAmountInput: Locator;

    // Crypto Payment tab content
    readonly paymentChannelDropdown: Locator;

    // Notices
    readonly unregisteredWalletWarning: Locator;
    readonly exchangeRateWarning: Locator;

    // Feature unavailable notice (shop01.98ent.com)
    readonly featureUnavailableNotice: Locator;

    constructor(page: Page) {
        this.page = page;

        // Main tabs
        this.digitalWalletTab = page.getByRole('tab', { name: /digital.*wallet/i })
            .or(page.getByText(/digital.*wallet/i)).first();
        this.cryptoPaymentTab = page.getByRole('tab', { name: /crypto.*pay/i })
            .or(page.getByText(/crypto.*pay/i)).first();

        // Sub-tabs
        this.walletQRSubTab   = page.getByText(/wallet.*qr|qr/i).first();
        this.walletLinkSubTab = page.getByText(/wallet.*link|link/i).first();

        // Dropdowns
        this.currencyDropdown = page.locator('[class*="currency"]').first();
        this.networkDropdown  = page.locator('[class*="network"]').first();

        // QR tab content
        this.qrCodeImage      = page.locator('img[class*="qr"], canvas[class*="qr"], [class*="qrcode"]').first();
        this.walletAddressText = page.locator('[class*="address"]').first();
        this.copyAddressButton = page.locator('[class*="copy"]').first();
        this.rateNotice        = page.getByText(/1 USDT = 1 USD/i);

        // Wallet Link tab
        this.walletLinkButton   = page.getByRole('button', { name: /wallet.*link/i });
        this.depositAmountInput = page.getByPlaceholder(/amount/i).first();

        // Crypto payment
        this.paymentChannelDropdown = page.locator('[class*="channel"]').first();

        // Warnings
        this.unregisteredWalletWarning = page.getByText(/unregistered.*wallet|not.*credited/i);
        this.exchangeRateWarning       = page.getByText(/exchange.*rate|fluctuat/i);

        // Unavailable
        this.featureUnavailableNotice = page.getByText(/not yet available|feature.*unavailable/i);
    }

    async goto() {
        await this.page.goto('/personal/recharge');
        await this.page.waitForLoadState('networkidle');
    }

    async switchTab(tab: DepositTab) {
        if (tab === 'digital') await this.digitalWalletTab.click();
        if (tab === 'crypto')  await this.cryptoPaymentTab.click();
        await this.page.waitForTimeout(300);
    }

    async switchSubTab(subTab: DepositSubTab) {
        if (subTab === 'qr')   await this.walletQRSubTab.click();
        if (subTab === 'link') await this.walletLinkSubTab.click();
        await this.page.waitForTimeout(300);
    }

    async selectNetwork(networkName: string) {
        await this.networkDropdown.click();
        await this.page.getByText(networkName, { exact: false }).click();
    }

    async copyAddress() {
        await this.copyAddressButton.click();
    }

    async getWalletAddress(): Promise<string> {
        return (await this.walletAddressText.textContent()) ?? '';
    }

    async isFeatureUnavailable(): Promise<boolean> {
        return this.featureUnavailableNotice.isVisible();
    }
}
