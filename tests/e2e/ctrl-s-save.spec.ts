import { test, expect } from '@playwright/test';

test('Ctrl+S downloads a project file', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
		// Force the download fallback; a native picker cannot be driven headlessly.
		Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
	});
	await page.goto('/');
	await page.waitForSelector('canvas');
	const downloadPromise = page.waitForEvent('download');
	await page.keyboard.press('Control+s');
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toMatch(/\.aetherax\.json$/);
});
