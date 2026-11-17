import { test, expect, type Page } from '@playwright/test';

/**
 * The scale card, on the floor being looked at.
 *
 * Two things changed here: measuring a line is the default route (the area field is the
 * alternative), and the scale a calibration writes belongs to one floor rather than to the
 * whole project. The second is pinned in `state/floor-scale.test.ts`; this spec covers the
 * first end to end and checks the value reaches the document.
 */

const ROOM = 400;

async function seedUncalibrated(page: Page): Promise<void> {
	await page.addInitScript((arg: { room: number }) => {
		const ROOM = arg.room;
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');
		const c = document.createElement('canvas');
		c.width = ROOM;
		c.height = ROOM;
		const ctx = c.getContext('2d')!;
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, ROOM, 10);
		ctx.fillRect(0, ROOM - 10, ROOM, 10);
		ctx.fillRect(0, 0, 10, ROOM);
		ctx.fillRect(ROOM - 10, 0, 10, ROOM);
		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Calibration',
				band: '5ghz',
				channelWidth: 20,
				regulatoryDomain: 'fcc',
				unitSystem: 'metric',
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
						wallMask: {
							dataUrl: c.toDataURL('image/png'),
							width: ROOM,
							height: ROOM,
							originX: 0,
							originY: 0
						},
						wallAttenuation: 5,
						wallMaterial: 0,
						materialMask: null,
						roomTypeMask: null,
						roomDensityOverrides: {},
						roomCustomLabels: {}
					}
				],
				aps: []
			})
		);
	}, { room: ROOM });
}

async function savedWupm(page: Page): Promise<number | null> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		const project = raw ? (JSON.parse(raw) as { floors?: Array<{ calibration?: { worldUnitsPerMeter?: number } | null }> }) : null;
		return project?.floors?.[0]?.calibration?.worldUnitsPerMeter ?? null;
	});
}

test('the scale card measures, and explains itself only while armed', async ({ page }) => {
	test.setTimeout(120_000);
	await seedUncalibrated(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(1500);

	// Measuring is the only route: its button is there, and there is no area field.
	await expect(page.getByRole('button', { name: 'Measure a distance' })).toBeVisible();
	await expect(page.getByPlaceholder('e.g. 200')).toHaveCount(0);
	// The instructions only exist once the canvas is armed for them, so the page must
	// not tell the user to click a plan that would ignore the click.
	await expect(page.getByText('Click the two ends of a distance you know')).toHaveCount(0);

	// Measuring: two clicks on the plan, then the real length.
	await page.getByRole('button', { name: 'Measure a distance' }).click();
	await expect(page.getByText('Click the two ends of a distance you know')).toBeVisible();
	const canvas = page.locator('canvas').first();
	await canvas.click({ position: { x: 100, y: 200 } });
	await canvas.click({ position: { x: 300, y: 200 } });
	const length = page.getByPlaceholder('e.g. 12');
	await expect(length).toBeVisible();
	await length.fill('12');
	await length.press('Enter');

	await expect
		.poll(() => savedWupm(page), { timeout: 20_000 })
		.toBeGreaterThan(0);
	const wupm = (await savedWupm(page))!;
	// 200 screen pixels at 1:1 is 200 world units over 12 m.
	expect(wupm).toBeGreaterThan(5);
	expect(wupm).toBeLessThan(40);
});
