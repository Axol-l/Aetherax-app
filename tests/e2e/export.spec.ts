import { test, expect } from '@playwright/test';
import { setupCleanState, enablePlaceMode } from './helpers';

test.describe('Export', () => {
	test.beforeEach(async ({ page }) => {
		await setupCleanState(page);
		await page.goto('/');
		await page.waitForSelector('canvas');
	});

	test('file dropdown contains export and project actions', async ({ page }) => {		// Open the File dropdown in the toolbar
		await page.locator('header .dropdown-trigger').click();

		// Export options should be visible in the dropdown
		await expect(page.getByText('Export as PNG')).toBeVisible();
		await expect(page.getByText('Export as PDF')).toBeVisible();

		// Project actions should also be in the dropdown
		await expect(page.getByText('New Project')).toBeVisible();
		await expect(page.getByText('Open Project...')).toBeVisible();
		await expect(page.getByText('Export Project File...')).toBeVisible();
	});

	test('save project JSON via file dropdown', async ({ page }) => {
		// Place 2 APs
		await enablePlaceMode(page);
		const canvas = page.locator('canvas');
		await canvas.click({ position: { x: 200, y: 200 } });
		await canvas.click({ position: { x: 400, y: 300 } });

		// Intercept the download - Save is now in the File dropdown
		const downloadPromise = page.waitForEvent('download');
		await page.locator('header .dropdown-trigger').click();
		await page.getByText('Export Project File...').click();
		const download = await downloadPromise;

		// Verify file was downloaded
		expect(download.suggestedFilename()).toContain('.aetherax.json');
		// ...and that the app said so: the file goes to the download folder, which in the
		// desktop window is somewhere the user cannot see.
		await expect(page.getByText('Project exported as a file', { exact: false })).toBeVisible();
	});

	test('Ctrl+S saves to the app store and says so', async ({ page }) => {
		// Autosave is silent by two seconds' delay; the key the user pressed has to answer,
		// or the shortcut reads as broken.
		await page.keyboard.press('Control+s');
		await expect(page.getByText('Project saved')).toBeVisible();
		// ...and the project really is in storage, not just a toast.
		const saved = await page.evaluate(() =>
			window.localStorage.getItem('aetherax:project')
		);
		expect(saved).not.toBeNull();
	});
});
