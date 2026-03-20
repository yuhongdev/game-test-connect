import { Page, Locator } from '@playwright/test';

/**
 * FundPasswordPage — helper for the randomized on-screen numeric keyboard.
 *
 * The fund password keyboard shuffles digit positions on every render,
 * so we CANNOT rely on fixed coordinates. We locate each digit button
 * by its visible text label at runtime.
 *
 * Strategy (per user confirmation):
 *   - The test fund password is always "111111"
 *   - We find the button labelled "1" and click it 6 times.
 */
export class FundPasswordPage {
    readonly page: Page;

    /** The keyboard container — scoped so we don't accidentally click other "1" elements */
    readonly keyboardContainer: Locator;

    /** Submit / Confirm button that appears after all 6 digits are entered */
    readonly submitButton: Locator;

    constructor(page: Page) {
        this.page = page;

        // The keyboard is rendered as a numeric pad — look for common class names
        this.keyboardContainer = page.locator(
            '[class*="keyboard"], [class*="numpad"], [class*="pin-pad"], [class*="fund-password"]'
        ).first();

        this.submitButton = page.getByRole('button', { name: /confirm|submit|ok/i });
    }

    /**
     * Returns the button element for a given digit character within the keyboard.
     * Uses exact text match so "1" doesn't collide with "10", "11", etc.
     */
    digitButton(digit: string): Locator {
        return this.keyboardContainer.getByText(digit, { exact: true });
    }

    /**
     * Enters a numeric PIN by clicking each digit's button by its label.
     * @param pin — e.g. "111111"
     */
    async enterPin(pin: string) {
        for (const digit of pin) {
            await this.digitButton(digit).click();
            // Small delay to let animation settle between digits
            await this.page.waitForTimeout(150);
        }
    }

    /**
     * Enters the test PIN (always 111111) and optionally clicks confirm.
     */
    async enterTestPin(clickConfirm = true) {
        await this.enterPin('111111');
        if (clickConfirm) {
            await this.submitButton.click();
        }
    }

    /**
     * Waits for the keyboard to become visible (use after triggering fund-password flow).
     */
    async waitForKeyboard() {
        await this.keyboardContainer.waitFor({ state: 'visible', timeout: 8000 });
    }
}
