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

		// Headless Chromium exposes the native picker but cannot show it, so the call never
		// settles. Force the download fallback the app uses when the picker is unavailable —
		// the same stub `ctrl-s-save.spec.ts` makes.
		await page.evaluate(() => {
			Object.defineProperty(window, 'showSaveFilePicker', {
				value: undefined,
				configurable: true
			});
		});

		// Intercept the download - Save is now in the File dropdown
		const downloadPromise = page.waitForEvent('download');
		await page.locator('header .dropdown-trigger').click();
		await page.getByText('Export Project File...').click();
		const download = await downloadPromise;

		// Verify file was downloaded
		expect(download.suggestedFilename()).toContain('.aetherax.json');
		// ...and that the app said so: the file goes to the download folder, which in the
		// desktop window is somewhere the user cannot see.
		await expect(page.getByText('Project exported as a JSON file')).toBeVisible();
	});

	test('closing the Save dialog is not reported as an export', async ({ page }) => {
		// Stub the native picker with the one thing it does on cancel. Chromium headless has
		// no picker, so without this the app takes the download fallback and the case the bug
		// lived in never runs.
		await page.evaluate(() => {
			Object.defineProperty(window, 'showSaveFilePicker', {
				configurable: true,
				value: () => Promise.reject(new DOMException('cancelled', 'AbortError'))
			});
		});

		await page.locator('header .dropdown-trigger').click();
		await page.getByText('Export Project File...').click();
		// The handler is async: give the rejected picker time to settle before asserting.
		await page.waitForTimeout(500);
		await expect(page.getByText('Project exported as a JSON file')).toHaveCount(0);
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
