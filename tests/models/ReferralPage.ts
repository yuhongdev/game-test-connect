import { Page, Locator } from '@playwright/test';

export type ReferralTab = 'invite' | 'team';

export class ReferralPage {
    readonly page: Page;

    // Tabs
    readonly inviteLinkTab: Locator;
    readonly myTeamTab: Locator;

    // Invite link tab content
    readonly referralUrlText: Locator;
    readonly qrCodeImage: Locator;
    readonly copyLinkButton: Locator;

    // My Team tab content
    readonly teamStats: Locator;

    constructor(page: Page) {
        this.page = page;

        this.inviteLinkTab = page.getByRole('tab', { name: /invite/i })
            .or(page.getByText(/invite.*link/i)).first();
        this.myTeamTab     = page.getByRole('tab', { name: /my.*team/i })
            .or(page.getByText(/my.*team/i)).first();

        // Invite link content
        this.referralUrlText = page.locator('[class*="invite-link"], [class*="referral-url"]').first();
        this.qrCodeImage     = page.locator('[class*="qr"] img, canvas[class*="qr"], [class*="qrcode"]').first();
        this.copyLinkButton  = page.locator('[class*="invite"] [class*="copy"], [class*="copy-link"]').first();

        // Team tab
        this.teamStats = page.locator('[class*="team"], [class*="subordinate"]').first();
    }

    async goto() {
        await this.page.goto('/agency');
        await this.page.waitForLoadState('networkidle');
    }

    async switchTab(tab: ReferralTab) {
        if (tab === 'invite') await this.inviteLinkTab.click();
        if (tab === 'team')   await this.myTeamTab.click();
        await this.page.waitForTimeout(500);
    }

    async copyLink() {
        await this.copyLinkButton.click();
    }

    async getReferralUrl(): Promise<string> {
        return (await this.referralUrlText.textContent()) ?? '';
    }
}
