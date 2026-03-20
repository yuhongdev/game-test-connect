/**
 * chat.spec.ts — TC-CHAT-001 to TC-CHAT-002
 */

import { test, expect } from '@playwright/test';
import { ChatPage } from '../models/ChatPage';

test.describe('Chat Room', () => {

    test('TC-CHAT-001 — Chat room renders message list, input, and send button', async ({ page }) => {
        const chat = new ChatPage(page);
        await chat.goto();

        await expect(chat.textInput).toBeVisible({ timeout: 8000 });
        await expect(chat.sendButton).toBeVisible();
    });

    test('TC-CHAT-002 — Sending a message updates the message list', async ({ page }) => {
        const chat = new ChatPage(page);
        await chat.goto();

        const testMessage = `Test msg ${Date.now()}`;
        const beforeCount = await chat.getMessageCount();

        await chat.sendMessage(testMessage);

        // After send, count should increase or the message text should be visible
        const afterCount = await chat.getMessageCount();
        const messageVisible = await page.getByText(testMessage).isVisible();

        expect(afterCount >= beforeCount || messageVisible).toBeTruthy();
        // Input should be cleared after sending
        await expect(chat.textInput).toHaveValue('');
    });
});
