import { Page, Locator } from '@playwright/test';

export class LoginPage {
    readonly page: Page;
    readonly loginButtonTop: Locator;
    readonly usernameInput: Locator;
    readonly passwordInput: Locator;
    readonly loginSubmitButton: Locator;
    readonly avatarImg: Locator;
    readonly signOutButton: Locator;
    readonly confirmSignOutButton: Locator;

    constructor(page: Page) {
        this.page = page;
        this.loginButtonTop = page.getByRole('banner').getByText('Login');
        this.usernameInput = page.getByRole('textbox', { name: 'Email/Phone/Account' });
        this.passwordInput = page.getByRole('textbox', { name: 'Password' });
        this.loginSubmitButton = page.locator('form').getByRole('button', { name: 'Login' });
        this.avatarImg = page.getByRole('banner').getByRole('img', { name: 'Avatar' });
        this.signOutButton = page.getByText('Sign out');
        this.confirmSignOutButton = page.getByRole('button', { name: 'Confirm' });
    }

    async goto() {
        await this.page.goto('/');
    }

    async login(username: string, password: string) {
        console.log('[LoginPage] Taking debug screenshot...');
        await this.page.screenshot({ path: 'playwright-debug-login.png' });
        console.log('[LoginPage] Clicking loginButtonTop...');
        await this.loginButtonTop.click({ timeout: 10000 }).catch(e => {
            console.error('[LoginPage] loginButtonTop click failed. Page URL:', this.page.url());
            throw e;
        });
        console.log('[LoginPage] Clicking usernameInput...');
        await this.usernameInput.click();
        await this.usernameInput.fill(username);
        console.log('[LoginPage] Clicking passwordInput...');
        await this.passwordInput.click();
        await this.passwordInput.fill(password);
        console.log('[LoginPage] Clicking loginSubmitButton...');
        await this.loginSubmitButton.click();
        console.log('[LoginPage] Login steps complete.');
    }

    async logout() {
        await this.avatarImg.click();
        await this.signOutButton.click();
        await this.confirmSignOutButton.click();
    }
}