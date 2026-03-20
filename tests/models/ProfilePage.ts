import { Page, Locator } from '@playwright/test';

export type ProfileTab = 'personal' | 'account' | 'security';

export class ProfilePage {
    readonly page: Page;

    // User info header
    readonly nickname: Locator;
    readonly userId: Locator;
    readonly avatar: Locator;

    // Quick stats links
    readonly betRecordsLink: Locator;
    readonly transactionRecordsLink: Locator;
    readonly collectionsLink: Locator;

    // Tab bar
    readonly personalInfoTab: Locator;
    readonly depositWithdrawalTab: Locator;
    readonly securitySettingsTab: Locator;

    // Personal Info tab fields
    readonly nameInput: Locator;
    readonly identityInput: Locator;
    readonly birthdayInput: Locator;
    readonly phoneVerifyButton: Locator;
    readonly emailVerifyButton: Locator;

    // Deposit & Withdrawal Account tab
    readonly addAccountButton: Locator;
    readonly changeFundPasswordButton: Locator;

    // Security Settings tab
    readonly changeLoginPasswordButton: Locator;

    // Bottom
    readonly themeToggle: Locator;
    readonly signOutButton: Locator;

    constructor(page: Page) {
        this.page = page;

        // User header
        this.nickname  = page.locator('[class*="nickname"], [class*="username"]').first();
        this.userId    = page.locator('[class*="uid"], [class*="user-id"]').first();
        this.avatar    = page.locator('[class*="avatar"]').first();

        // Stats quick links (usually icon cards)
        this.betRecordsLink         = page.getByText(/bet.*record|record.*bet/i).first();
        this.transactionRecordsLink = page.getByText(/transaction.*record|record.*transaction/i).first();
        this.collectionsLink        = page.getByText(/collection/i).first();

        // Tabs — the three tabs inside Profile Management
        this.personalInfoTab        = page.getByText(/personal.*info|info/i).first();
        this.depositWithdrawalTab   = page.getByText(/deposit.*withdrawal|withdrawal.*account/i).first();
        this.securitySettingsTab    = page.getByText(/security/i).first();

        // Personal info form
        this.nameInput         = page.getByLabel(/name/i);
        this.identityInput     = page.getByLabel(/identity|cpf/i);
        this.birthdayInput     = page.getByLabel(/birth/i);
        this.phoneVerifyButton = page.locator('[class*="phone"] [class*="verify"], [class*="verify"]').first();
        this.emailVerifyButton = page.locator('[class*="email"] [class*="verify"]').first();

        // Account tab
        this.addAccountButton         = page.getByRole('button', { name: /add.*account/i });
        this.changeFundPasswordButton = page.getByRole('button', { name: /fund.*password|change.*fund/i });

        // Security tab
        this.changeLoginPasswordButton = page.getByRole('button', { name: /change.*password|login.*password/i });

        // Misc
        this.themeToggle  = page.locator('[class*="theme"], [class*="toggle"]').first();
        this.signOutButton = page.getByText(/sign.*out|logout/i);
    }

    async goto() {
        await this.page.goto('/personal');
        await this.page.waitForLoadState('networkidle');
    }

    async switchTab(tab: ProfileTab) {
        if (tab === 'personal') await this.personalInfoTab.click();
        if (tab === 'account')  await this.depositWithdrawalTab.click();
        if (tab === 'security') await this.securitySettingsTab.click();
        await this.page.waitForTimeout(500);
    }

    async clickBetRecords() {
        await this.betRecordsLink.click();
        await this.page.waitForLoadState('networkidle');
    }

    async clickTransactions() {
        await this.transactionRecordsLink.click();
        await this.page.waitForLoadState('networkidle');
    }

    async clickAddAccount() {
        await this.addAccountButton.click();
    }

    async clickSignOut() {
        await this.signOutButton.click();
    }

    async getNickname(): Promise<string> {
        return (await this.nickname.textContent()) ?? '';
    }

    async getUserId(): Promise<string> {
        return (await this.userId.textContent()) ?? '';
    }
}
