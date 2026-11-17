import { test, expect } from '@playwright/test';

/*
 * Ctrl+S is the app's own save, not Save As.
 *
 * It must answer visibly and put the project in local storage, and it must not open a file
 * dialog or download anything: handing the user a file is File → Export Project File, a
 * separate action with its own toast.
 */
test('Ctrl+S saves to the app store without opening a file dialog', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
		// Count picker calls rather than letting the native dialog hang headless Chromium.
		const w = window as unknown as { pickerCalls: number };
		w.pickerCalls = 0;
		Object.defineProperty(window, 'showSaveFilePicker', {
			configurable: true,
			value: () => {
				w.pickerCalls++;
				return Promise.reject(new DOMException('cancelled', 'AbortError'));
			}
		});
	});
	await page.goto('/');
	await page.waitForSelector('canvas');

	const downloads: string[] = [];
	page.on('download', (d) => downloads.push(d.suggestedFilename()));

	await page.keyboard.press('Control+s');
	await expect(page.getByText('Project saved')).toBeVisible();

	expect(await page.evaluate(() => localStorage.getItem('aetherax:project'))).not.toBeNull();

	// The save really was the direct one: no Save dialog, no file leaving the app.
	await page.waitForTimeout(500);
	expect(
		await page.evaluate(() => (window as unknown as { pickerCalls: number }).pickerCalls)
	).toBe(0);
	expect(downloads).toEqual([]);
});
