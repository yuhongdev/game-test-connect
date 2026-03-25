import { Page, Locator } from '@playwright/test';

export class HomePage {
    readonly page: Page;

    // Header / Wallet (inside sidebar — only visible when sidebar is open)
    readonly walletBalance: Locator;
    /** Deposit & Withdrawal wallet buttons (inside the sidebar drawer) */
    readonly depositButton: Locator;
    readonly withdrawalButton: Locator;
    /** Bottom navigation Deposit tab — always visible on home page */
    readonly bottomNavDepositTab: Locator;
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

        // Wallet section — balance and Deposit/Withdrawal buttons live INSIDE the sidebar drawer.
        // They are present in the DOM but not visible until the sidebar is opened.
        this.walletBalance    = page.locator('text=/USD|USDT/').first();
        this.depositButton    = page.getByRole('button', { name: 'Deposit' });
        this.withdrawalButton = page.getByRole('button', { name: 'Withdrawal' });

        // Bottom navigation tab — always visible on any page
        this.bottomNavDepositTab = page.getByRole('link', { name: /Deposit/i })
            .or(page.locator('nav').getByText(/^Deposit$/i))
            .or(page.locator('[class*="tab"], [class*="nav"]').getByText(/^Deposit$/i))
            .first();

        // Header icons — identified by their accessible image alt attributes
        this.notificationIcon = page.getByRole('img', { name: 'Notification' });
        this.avatarIcon       = page.getByRole('img', { name: 'Avatar' }).first();
        this.sidebarToggle    = page.getByRole('img', { name: 'Menu' });

        // Promotional banner — identified by banner image alt text; target the parent carousel container
        this.bannerCarousel   = page.getByRole('img', { name: /Banner \d+/i }).first();

        // Game category tabs — exact paragraph text as seen in DOM snapshots
        this.popularGamesTab  = page.getByText('Popular Games', { exact: true });
        this.myCollectionTab  = page.getByText('My Collection', { exact: true });
        this.allGamesTab      = page.getByText('All', { exact: true }).first();

        // Game category section headings (level 3 headings)
        this.eGameSwiper      = page.getByRole('heading', { name: 'E-Game', level: 3 });
        this.liveCasinoSwiper = page.getByRole('heading', { name: 'Live Casino', level: 3 });

        // Chatroom widget — identified by the "CHATROOM" label text
        this.chatroomWidget   = page.getByText('CHATROOM', { exact: true });

        // Quick-access links — click the visible text label in the quick-link grid.
        // Note: 'Scoreboard' and 'Chat Room' also appear as text in the HIDDEN sidebar,
        // so we use .last() to get the VISIBLE instance in the main content area.
        // From the DOM: generic[cursor=pointer] > generic: "Scoreboard" | img "Scoreboard"
        this.referralIcon      = page.getByText('Referral', { exact: true }).last();
        this.chatRoomIcon      = page.getByText('Chat Room', { exact: true }).last();
        this.scoreboardIcon    = page.getByText('Scoreboard', { exact: true }).last();
        this.liveBroadcastIcon = page.getByText('Live Broadcast', { exact: true }).last();
    }

    /**
     * Navigate to home and wait for the page to settle.
     * Uses 'load' state (not 'networkidle') because the chatroom's persistent
     * WebSocket/polling would prevent networkidle from ever resolving.
     */
    async goto() {
        // Register dialog handler BEFORE navigating to catch any alert on load.
        this.page.once('dialog', async dialog => {
            await dialog.accept();
        });
        await this.page.goto('/');
        await this.page.waitForLoadState('load');
        // Brief pause for Vue/React to finish rendering after DOM load
        await this.page.waitForTimeout(1000);
    }

    /**
     * Wait for any blocking full-screen overlay to disappear.
     *
     * Two types exist:
     *  1. Login/logout success overlay — NON-CLICKABLE, auto-dismisses after ~2 s.
     *  2. Notification overlay — may appear after loading; also auto-dismisses or can be clicked.
     *
     * Strategy: wait up to 5 s for the overlay to become visible, then wait for it to
     * disappear on its own. Trying to click a non-clickable overlay throws an error, so
     * we intentionally avoid click() here.
     */
    async dismissOverlays() {
        const overlay = this.page.locator(
            '[class*="overlay"], [class*="mask"], [class*="fullscreen"]'
        ).first();
        try {
            await overlay.waitFor({ state: 'visible', timeout: 3000 });
            // Wait for it to auto-dismiss (login overlay disappears on its own)
            await overlay.waitFor({ state: 'hidden', timeout: 8000 });
        } catch {
            // No overlay present — continue normally.
        }
    }

    /**
     * Open the sidebar/drawer to make Deposit and Withdrawal wallet buttons visible.
     */
    async openSidebar() {
        await this.sidebarToggle.click();
        // Wait until the Deposit button inside the sidebar becomes visible
        await this.depositButton.waitFor({ state: 'visible', timeout: 5000 });
    }

    /**
     * Dismiss an announcement/modal dialog (e.g. promo pop-up) that may appear on page load.
     * Looks specifically inside a modal container to avoid accidentally closing other UI.
     */
    async dismissAnnouncementModal() {
        const modalCloseBtn = this.page.locator(
            '[role="dialog"] button, [class*="modal"] [class*="close"], [class*="popup"] [class*="close"]'
        ).first();
        try {
            await modalCloseBtn.waitFor({ state: 'visible', timeout: 3000 });
            await modalCloseBtn.click();
        } catch {
            // No announcement modal — continue.
        }
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
}
