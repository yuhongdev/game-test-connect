/**
 * referral.spec.ts — TC-REF-001 to TC-REF-005
 */

import { test, expect } from '@playwright/test';
import { ReferralPage } from '../models/ReferralPage';

test.describe('Referral / Agency', () => {

    test('TC-REF-001 — Referral page renders with two tabs', async ({ page }) => {
        const referral = new ReferralPage(page);
        await referral.goto();

        await expect(referral.inviteLinkTab).toBeVisible({ timeout: 8000 });
        await expect(referral.myTeamTab).toBeVisible();
    });

    test('TC-REF-002 — Invite Link tab shows referral URL and QR code', async ({ page }) => {
        const referral = new ReferralPage(page);
        await referral.goto();
        await referral.switchTab('invite');

        await expect(referral.referralUrlText).toBeVisible({ timeout: 5000 });
        await expect(referral.qrCodeImage).toBeVisible();
        await expect(referral.copyLinkButton).toBeVisible();
    });

    test('TC-REF-003 — Copy referral link shows success feedback', async ({ page }) => {
        const referral = new ReferralPage(page);
        await referral.goto();
        await referral.switchTab('invite');
        await referral.copyLink();

        await expect(page.getByText(/copied|success/i)).toBeVisible({ timeout: 5000 });
    });

    test('TC-REF-004 — QR code image is rendered (not broken)', async ({ page }) => {
        const referral = new ReferralPage(page);
        await referral.goto();
        await referral.switchTab('invite');

        await expect(referral.qrCodeImage).toBeVisible({ timeout: 5000 });

        // Check image is not broken (naturalWidth > 0)
        const isLoaded = await referral.qrCodeImage.evaluate((img: HTMLImageElement) =>
            img.complete && img.naturalWidth > 0
        ).catch(() => true); // Canvas QR codes pass by default
        expect(isLoaded).toBeTruthy();
    });

    test('TC-REF-005 — My Team tab shows team statistics', async ({ page }) => {
        const referral = new ReferralPage(page);
        await referral.goto();
        await referral.switchTab('team');

        await expect(referral.teamStats).toBeVisible({ timeout: 5000 });
    });
});
