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
        // Only click the header "Login" button if we are NOT already on the login page.
        // When tests navigate directly to /login the header button does not exist.
        const onLoginPage = this.page.url().includes('/login');
        if (!onLoginPage) {
            console.log('[LoginPage] Clicking loginButtonTop...');
            await this.loginButtonTop.click({ timeout: 10000 });
            // Wait for the login form to appear after navigation
            await this.usernameInput.waitFor({ state: 'visible', timeout: 10000 });
        }
        console.log('[LoginPage] Filling usernameInput...');
        await this.usernameInput.click();
        await this.usernameInput.fill(username);
        console.log('[LoginPage] Filling passwordInput...');
        await this.passwordInput.click();
        await this.passwordInput.fill(password);
        console.log('[LoginPage] Clicking loginSubmitButton...');
        await this.loginSubmitButton.click();
        console.log('[LoginPage] Login steps complete.');
    }

    async logout() {
        await this.avatarImg.click();
        await this.signOutButton.waitFor({ state: 'visible', timeout: 8000 });
        await this.signOutButton.click();
        await this.confirmSignOutButton.waitFor({ state: 'visible', timeout: 8000 });
        await this.confirmSignOutButton.click();
    }
}