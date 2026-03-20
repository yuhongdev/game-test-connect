import { Page, Locator } from '@playwright/test';

export class HomePage {
    readonly page: Page;

    // Header / Wallet
    readonly walletBalance: Locator;
    readonly depositButton: Locator;
    readonly withdrawalButton: Locator;
    readonly notificationIcon: Locator;
    readonly avatarIcon: Locator;
    readonly sidebarToggle: Locator;

    // Promotional Banners
    readonly bannerCarousel: Locator;

    // Game category tabs
    readonly popularGamesTab: Locator;
    readonly myCollectionTab: Locator;
    readonly allGamesTab: Locator;

    // Game swipers
    readonly eGameSwiper: Locator;
    readonly liveCasinoSwiper: Locator;

    // Chatroom widget
    readonly chatroomWidget: Locator;

    // Quick feature links (home page icons)
    readonly referralIcon: Locator;
    readonly chatRoomIcon: Locator;
    readonly scoreboardIcon: Locator;
    readonly liveBroadcastIcon: Locator;

    constructor(page: Page) {
        this.page = page;

        // Wallet section — balance is typically a text node near the wallet container
        this.walletBalance       = page.locator('[class*="wallet"] [class*="balance"], [class*="amount"]').first();
        this.depositButton       = page.getByRole('button', { name: /deposit/i }).first();
        this.withdrawalButton    = page.getByRole('button', { name: /withdraw/i }).first();
        this.notificationIcon    = page.locator('[class*="notice"], [class*="notification"], [class*="bell"]').first();
        this.avatarIcon          = page.locator('[class*="avatar"], [class*="user-icon"]').first();
        this.sidebarToggle       = page.locator('[class*="menu"], [class*="hamburger"], [class*="sidebar"]').first();

        // Banner
        this.bannerCarousel = page.locator('[class*="banner"], [class*="swiper"], [class*="carousel"]').first();

        // Game tabs
        this.popularGamesTab  = page.getByText(/popular.*game|hot.*game/i).first();
        this.myCollectionTab  = page.getByText(/my.*collect|collection/i).first();
        this.allGamesTab      = page.getByText(/^all$/i).first();

        // Swipers
        this.eGameSwiper      = page.locator('[class*="e-game"], [class*="egame"], [class*="electronic"]').first();
        this.liveCasinoSwiper = page.locator('[class*="live"], [class*="casino"]').first();

        // Chatroom widget
        this.chatroomWidget   = page.locator('[class*="chat"], [class*="online"]').first();

        // Quick links
        this.referralIcon      = page.getByText(/referral/i).first();
        this.chatRoomIcon      = page.getByText(/chat.*room|chatroom/i).first();
        this.scoreboardIcon    = page.getByText(/scoreboard/i).first();
        this.liveBroadcastIcon = page.getByText(/live.*broadcast|broadcast/i).first();
    }

    async goto() {
        await this.page.goto('/');
        await this.page.waitForLoadState('networkidle');
    }

    async getWalletBalanceText(): Promise<string> {
        return (await this.walletBalance.textContent()) ?? '';
    }

    async clickDeposit() {
        await this.depositButton.click();
    }

    async clickWithdrawal() {
        await this.withdrawalButton.click();
    }

    async clickNotification() {
        await this.notificationIcon.click();
    }

    async switchGameTab(tab: 'popular' | 'collection' | 'all') {
        if (tab === 'popular')    await this.popularGamesTab.click();
        if (tab === 'collection') await this.myCollectionTab.click();
        if (tab === 'all')        await this.allGamesTab.click();
    }

    async dismissAnnouncementModal() {
        const closeBtn = this.page.locator('[class*="close"], [class*="modal"] button').first();
        if (await closeBtn.isVisible()) {
            await closeBtn.click();
        }
    }
}
