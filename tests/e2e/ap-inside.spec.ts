import { test, expect, type Page } from '@playwright/test';

/**
 * "Allow APs outside rooms" means what it says.
 *
 * The optimiser has always respected it, but two other paths could put an access point in
 * the margin outside the walls and said nothing about it: a click on the canvas in placement
 * mode, and a project saved by a build whose detection disagreed with this one. The guard
 * asks the same question the optimiser's verifier asks — against the same interior domain —
 * and reports it in the panel.
 *
 * Placement is asserted through the saved project rather than a panel row: the list lives
 * behind a tab, and the save is debounced, so a poll is both simpler and less brittle.
 */

async function seed(
	page: Page,
	opts: { aps: Array<{ x: number; y: number }>; allowOutside: boolean }
): Promise<void> {
	await page.addInitScript((arg: { aps: Array<{ x: number; y: number }>; allowOutside: boolean }) => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');

		// A closed 400x400 room: the walls are the border, so the interior is the middle.
		const c = document.createElement('canvas');
		c.width = 400;
		c.height = 400;
		const ctx = c.getContext('2d')!;
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, 400, 10);
		ctx.fillRect(0, 390, 400, 10);
		ctx.fillRect(0, 0, 10, 400);
		ctx.fillRect(390, 0, 10, 400);

		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Guard',
				band: '5ghz',
				channelWidth: 20,
				regulatoryDomain: 'fcc',
				unitSystem: 'metric',
				ispSpeed: 0,
				targetThroughput: 25,
				allowOutsideRooms: arg.allowOutside,
				clientHeight: 1.5,
				heatmapRssiFloor: -70,
				interferenceWeight: 0.2,
				coverageSoftnessDb: 0,
				coverageFloorPct: 0,
				coverageFloorEveryFloor: false,
				floors: [
					{
						id: 'f1',
						name: 'Floor 1',
						level: 0,
						ceilingHeight: 3,
						floorMaterial: 1,
						floorThickness: 0.2,
						floorplanScale: 1,
						floorplanOffsetX: 0,
						floorplanOffsetY: 0,
						calibration: null,
						floorplanBoundary: null,
						wallMask: { dataUrl: c.toDataURL('image/png'), width: 400, height: 400, originX: 0, originY: 0 },
						wallAttenuation: 5,
						wallMaterial: 0,
						materialMask: null,
						roomTypeMask: null,
						roomDensityOverrides: {},
						roomCustomLabels: {}
					}
				],
				aps: arg.aps.map((ap, i) => ({
					id: `ap${i}`,
					name: `AP-${i + 1}`,
					x: ap.x,
					y: ap.y,
					floorId: 'f1',
					band: '5ghz',
					channelWidth: 20,
					fixedChannel: null,
					assignedChannel: null,
					interferenceRadius: 100,
					power: 20,
					modelId: null,
					modelLabel: null
				}))
			})
		);
	}, opts);
}

async function ready(page: Page): Promise<void> {
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(3000);
}

async function placedCount(page: Page): Promise<number> {
	const raw = await page.evaluate(() => localStorage.getItem('aetherax:project'));
	if (!raw) return -1;
	return ((JSON.parse(raw) as { aps?: unknown[] }).aps ?? []).length;
}

test('refuses a click outside the walls, and says why', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page, { aps: [], allowOutside: false });
	await ready(page);

	await page.getByRole('button', { name: 'Place APs' }).click();
	await page.waitForTimeout(500);

	// Well outside the 400x400 plan, which sits at the view's origin.
	await page.locator('canvas').first().click({ position: { x: 700, y: 500 } });
	await expect(page.getByText('Outside the building', { exact: false })).toBeVisible({ timeout: 15_000 });
	await page.waitForTimeout(1500);
	expect(await placedCount(page)).toBe(0);

	// A click in the middle of the room still places one, and clears the message.
	await page.locator('canvas').first().click({ position: { x: 200, y: 200 } });
	await expect.poll(() => placedCount(page), { timeout: 15_000 }).toBe(1);
});

test('places anywhere when the setting is on', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page, { aps: [], allowOutside: true });
	await ready(page);

	await page.getByRole('button', { name: 'Place APs' }).click();
	await page.waitForTimeout(500);
	await page.locator('canvas').first().click({ position: { x: 700, y: 500 } });
	await expect.poll(() => placedCount(page), { timeout: 15_000 }).toBe(1);
});

test('warns when a loaded project carries an AP outside the walls', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page, { aps: [{ x: 5, y: 5 }], allowOutside: false });
	await ready(page);
	await expect(page.getByText('outside the building', { exact: false })).toBeVisible({ timeout: 15_000 });

	/*
	 * Where it appears matters as much as that it does. It used to be a paragraph inside the
	 * coverage panel: only visible on one tab, and it pushed that panel's own content down
	 * when it turned up. A corner notice is what was asked for, so the corner is asserted.
	 */
	const notice = page.locator('.notice');
	const box = (await notice.boundingBox())!;
	const viewport = page.viewportSize()!;
	expect(box.x + box.width).toBeGreaterThan(viewport.width * 0.6);
	expect(box.y).toBeGreaterThan(viewport.height * 0.6);
	// It must not take clicks away from the canvas underneath it.
	await expect(notice).toHaveCSS('pointer-events', 'none');
});