import { Page, Locator } from '@playwright/test';

export class ChatPage {
    readonly page: Page;

    readonly messageList: Locator;
    readonly messageItems: Locator;
    readonly textInput: Locator;
    readonly sendButton: Locator;

    constructor(page: Page) {
        this.page = page;

        this.messageList  = page.locator('[class*="chat-list"], [class*="message-list"]').first();
        this.messageItems = page.locator('[class*="message-item"], [class*="chat-item"]');
        // Use placeholder-based selector first; fall back to the last textbox (chat input is usually at the bottom)
        this.textInput    = page.getByPlaceholder(/message|chat|say/i)
            .or(page.locator('[class*="chat"] input[type="text"], [class*="chat"] textarea'))
            .or(page.getByRole('textbox').last())
            .first();
        this.sendButton   = page.getByRole('button', { name: /send/i });
    }

    async goto() {
        await this.page.goto('/chatroom');
        await this.page.waitForLoadState('networkidle');
    }

    async sendMessage(text: string) {
        await this.textInput.fill(text);
        await this.sendButton.click();
        await this.page.waitForTimeout(500);
    }

    async getLastMessage(): Promise<string> {
        const count = await this.messageItems.count();
        if (count === 0) return '';
        return (await this.messageItems.nth(count - 1).textContent()) ?? '';
    }

    async getMessageCount(): Promise<number> {
        return this.messageItems.count();
    }
}
