/**
 * deposit.spec.ts — TC-DEP-001 to TC-DEP-007
 *
 * Tests the Deposit page on s9.com (live feature).
 */

import { test, expect } from '@playwright/test';
import { DepositPage } from '../models/DepositPage';

const EXPECTED_NETWORKS = ['ERC-20', 'TRC-20', 'BEP-20', 'Arbitrum', 'Optimism', 'Polygon', 'Base'];

test.describe('Deposit', () => {

    test('TC-DEP-001 — Deposit page renders tabs and dropdowns', async ({ page }) => {
        const deposit = new DepositPage(page);
        await deposit.goto();

        // If feature is live, tabs should be visible
        const isUnavailable = await deposit.isFeatureUnavailable();
        if (isUnavailable) {
            // On staging — just assert the message
            await expect(deposit.featureUnavailableNotice).toBeVisible();
        } else {
            await expect(deposit.digitalWalletTab).toBeVisible({ timeout: 8000 });
            await expect(deposit.cryptoPaymentTab).toBeVisible();
        }
    });

    test('TC-DEP-002 — Digital Wallet > Wallet QR sub-tab shows QR and address', async ({ page }) => {
        const deposit = new DepositPage(page);
        await deposit.goto();
        if (await deposit.isFeatureUnavailable()) test.skip();

        await deposit.switchTab('digital');
        await deposit.switchSubTab('qr');

        await expect(deposit.qrCodeImage).toBeVisible({ timeout: 8000 });
        await expect(deposit.walletAddressText).toBeVisible();
        await expect(deposit.copyAddressButton).toBeVisible();
        await expect(deposit.rateNotice).toBeVisible();
    });

    test('TC-DEP-003 — Digital Wallet > Wallet Link sub-tab shows link and amount input', async ({ page }) => {
        const deposit = new DepositPage(page);
        await deposit.goto();
        if (await deposit.isFeatureUnavailable()) test.skip();

        await deposit.switchTab('digital');
        await deposit.switchSubTab('link');

        await expect(deposit.walletLinkButton).toBeVisible({ timeout: 5000 });
        await expect(deposit.depositAmountInput).toBeVisible();
    });

    test('TC-DEP-004 — Crypto Payment tab shows channel selector and amount input', async ({ page }) => {
        const deposit = new DepositPage(page);
        await deposit.goto();
        if (await deposit.isFeatureUnavailable()) test.skip();

        await deposit.switchTab('crypto');

        await expect(deposit.paymentChannelDropdown).toBeVisible({ timeout: 5000 });
        await expect(deposit.depositAmountInput).toBeVisible();
    });

    test('TC-DEP-005 — Network dropdown lists all 7 networks', async ({ page }) => {
        const deposit = new DepositPage(page);
        await deposit.goto();
        if (await deposit.isFeatureUnavailable()) test.skip();

        await deposit.switchTab('digital');
        await deposit.networkDropdown.click();

        for (const network of EXPECTED_NETWORKS) {
            await expect(
                page.getByText(new RegExp(network, 'i')).first()
            ).toBeVisible({ timeout: 5000 });
        }

        // Close dropdown
        await page.keyboard.press('Escape');
    });

    test('TC-DEP-006 — Copying wallet address shows success feedback', async ({ page }) => {
        const deposit = new DepositPage(page);
        await deposit.goto();
        if (await deposit.isFeatureUnavailable()) test.skip();

        await deposit.switchTab('digital');
        await deposit.switchSubTab('qr');
        await deposit.copyAddress();

        // Expect a success toast
        await expect(page.getByText(/copied|success/i)).toBeVisible({ timeout: 5000 });
    });

    test('TC-DEP-007 — Deposit warning notices are visible', async ({ page }) => {
        const deposit = new DepositPage(page);
        await deposit.goto();
        if (await deposit.isFeatureUnavailable()) test.skip();

        await deposit.switchTab('digital');
        await deposit.switchSubTab('qr');

        await expect(
            deposit.unregisteredWalletWarning.or(deposit.exchangeRateWarning).first()
        ).toBeVisible({ timeout: 5000 });
    });
});
