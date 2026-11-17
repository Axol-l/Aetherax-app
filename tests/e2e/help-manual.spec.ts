import { test, expect } from '@playwright/test';

/**
 * The Help button opens the user manual as a page.
 *
 * The manual lives outside the app's Svelte bundle (`static/manual.html`), so this checks the
 * parts that can actually break: the dialog opening, the iframe receiving the built page, and
 * the manual's Chinese headings rendering — not Playwright looking at a blank frame.
 */
test('the Help button opens the Chinese manual and closes again', async ({ page }) => {
	test.setTimeout(60_000);
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');
	});
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(500);

	await page.getByRole('button', { name: 'Help' }).click();
	const dialog = page.getByRole('dialog', { name: 'Aetherax 使用手册' });
	await expect(dialog).toBeVisible();

	const manual = page.frameLocator('#help-manual-frame');
	await expect(manual.locator('h1')).toHaveText('Aetherax 使用说明书');
	await expect(manual.getByText('比例标定', { exact: true }).first()).toBeVisible();
	await expect(manual.getByText('18.2 AP 放不下去', { exact: true })).toBeVisible();

	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toHaveCount(0);
});
