import { test, expect } from '@playwright/test';

/** Draw a segment and undo it without leaving the wall tool. */
test('ctrl+z removes the last segment while the wall tool is open, and keeps the zoom', async ({
	page
}) => {
	test.setTimeout(90_000);
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');
	});
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.getByRole('tab', { name: 'Floorplan' }).click();
	await page.getByRole('button', { name: 'Draw from Scratch' }).click();
	await page.waitForTimeout(500);

	// Zoom in first, so a reset to fit is visible. Read the status bar's own zoom, not any
	// percentage on the page: the sidebar has "100%" opacity labels too.
	const canvas = page.locator('canvas');
	const box = (await canvas.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, -400);
	await page.waitForTimeout(400);
	const zoomOf = async (): Promise<string> =>
		(await page.locator('.status-item.zoom').innerText()).trim();
	const zoomBefore = await zoomOf();

	await canvas.click({ position: { x: 200, y: 200 } });
	await canvas.click({ position: { x: 500, y: 200 } });
	await page.waitForTimeout(600);

	const savedWalls = async (): Promise<number> =>
		page.evaluate(() => {
			const raw = localStorage.getItem('aetherax:project');
			if (!raw) return -1;
			const project = JSON.parse(raw) as { floors?: Array<{ walls?: unknown[] }> };
			return project.floors?.[0]?.walls?.length ?? 0;
		});
	await expect.poll(savedWalls, { timeout: 20_000 }).toBe(1);

	await page.keyboard.press('Control+z');
	await expect.poll(savedWalls, { timeout: 20_000 }).toBe(0);

	// The view must not jump: an undo is a geometry edit, not a re-frame.
	expect(await zoomOf()).toBe(zoomBefore);
});
