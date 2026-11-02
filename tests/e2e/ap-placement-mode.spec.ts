import { test, expect, type Page } from '@playwright/test';

/**
 * Placing an access point is a mode, and it is off by default.
 *
 * With it always on, the canvas added an AP to every stray click — clicking to
 * deselect, starting a marquee, fumbling a pan — so the plan collected APs nobody
 * asked for. Selecting and dragging an existing AP is unaffected either way.
 */

async function seedOneFloor(page: Page) {
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');
		const c = document.createElement('canvas');
		c.width = 800;
		c.height = 600;
		const ctx = c.getContext('2d')!;
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, 800, 8);
		ctx.fillRect(0, 592, 800, 8);
		ctx.fillRect(0, 0, 8, 600);
		ctx.fillRect(792, 0, 8, 600);
		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Place mode',
				band: '5ghz',
				channelWidth: 20,
				regulatoryDomain: 'fcc',
				unitSystem: 'metric',
				ispSpeed: 0,
				targetThroughput: 25,
				allowOutsideRooms: true,
				clientHeight: 1.5,
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
							width: 800,
							height: 600,
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
	});
}

/** AP count as the app last saved it. */
async function savedApCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		const proj = raw ? (JSON.parse(raw) as { aps?: unknown[] }) : null;
		return proj?.aps?.length ?? 0;
	});
}

/**
 * Wait for the debounced save to carry `expected` APs.
 *
 * `scheduleSave` waits five seconds after the last edit, so reading storage straight after a
 * click sees the previous record — the helper used to sleep 2.6 s against a two-second
 * debounce that has since been raised.
 */
async function waitForSavedApCount(page: Page, expected: number): Promise<void> {
	await expect.poll(() => savedApCount(page), { timeout: 15_000 }).toBe(expected);
}

/** Saved APs, as the models read them. */
async function savedAps(
	page: Page
): Promise<Array<{ x: number; y: number; mount?: string }>> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		const proj = raw ? (JSON.parse(raw) as { aps?: Array<{ x: number; y: number; mount?: string }> }) : null;
		return proj?.aps ?? [];
	});
}

test('a canvas click only adds an AP while placement mode is on', async ({ page }) => {
	await seedOneFloor(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(1500);
	await page.getByRole('tab', { name: 'APs' }).click();
	await page.waitForTimeout(300);

	const canvas = page.locator('canvas');
	const placeToggle = page.getByRole('button', { name: /Place APs/ });

	// Off by default: two clicks on empty canvas add nothing.
	await canvas.click({ position: { x: 400, y: 300 } });
	await canvas.click({ position: { x: 500, y: 350 } });
	await page.waitForTimeout(600);
	expect(await savedApCount(page)).toBe(0);
	await expect(placeToggle).toHaveAttribute('aria-pressed', 'false');
	await page.screenshot({ path: 'test-results/place-mode/off.png' });

	// On: a click adds one.
	await placeToggle.click();
	await expect(placeToggle).toHaveAttribute('aria-pressed', 'true');
	await page.screenshot({ path: 'test-results/place-mode/on.png' });
	await canvas.click({ position: { x: 400, y: 300 } });
	await waitForSavedApCount(page, 1);

	// Escape leaves the mode, so the next click adds nothing.
	await page.keyboard.press('Escape');
	await expect(placeToggle).toHaveAttribute('aria-pressed', 'false');
	await canvas.click({ position: { x: 600, y: 400 } });
	await page.waitForTimeout(600);
	expect(await savedApCount(page)).toBe(1);
});

test('the placement toolbar picks the mounting before the click', async ({ page }) => {
	await seedOneFloor(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(1500);

	await page.getByRole('button', { name: /Place APs/ }).click();
	const toolbar = page.getByRole('toolbar', { name: 'Access point placement' });
	await expect(toolbar).toBeVisible();

	// A wall mount has to land on a wall, and the click is within a metre of the
	// seeded border — so this is the wall band rather than a free placement.
	await toolbar.getByRole('button', { name: 'Wall mount' }).click();
	await page.locator('canvas').first().click({ position: { x: 20, y: 300 } });
	await expect
		.poll(async () => (await savedAps(page))[0]?.mount, { timeout: 20_000 })
		.toBe('wall');
	const wall = (await savedAps(page))[0]!;
	expect(Math.min(wall.x, wall.y, 800 - wall.x, 600 - wall.y)).toBeLessThan(80);

	// The pick is sticky, and choosing another mounting applies to the next click.
	await toolbar.getByRole('button', { name: 'Ceiling mount' }).click();
	await page.locator('canvas').first().click({ position: { x: 400, y: 300 } });
	await expect
		.poll(async () => (await savedAps(page))[1]?.mount, { timeout: 20_000 })
		.toBe('ceiling');
	expect(await savedAps(page)).toHaveLength(2);
});

test('placement is offered only in the single-floor view', async ({ page }) => {
	await seedOneFloor(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(1500);

	const place = page.getByRole('button', { name: 'Place APs' });
	const toolbar = page.getByRole('toolbar', { name: 'Access point placement' });
	await expect(place).toBeVisible();

	// Arm it, then leave the plan view: the overviews cannot place, so both the toggle
	// and the floating bar go away rather than leaving an invisible armed mode.
	await place.click();
	await expect(toolbar).toBeVisible();
	await page.getByTitle('Tile every floor side by side. Click a floor to select it.').click();
	await expect(place).toHaveCount(0);
	await expect(toolbar).toHaveCount(0);

	// Back to the plan: the toggle is back, and the mode did not survive the trip.
	await page.getByTitle('Show the current floor only').click();
	await expect(place).toBeVisible();
	await expect(place).toHaveAttribute('aria-pressed', 'false');
	await expect(toolbar).toHaveCount(0);
});
