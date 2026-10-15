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

/** AP count as the app last saved it. `scheduleSave` debounces by 2 s. */
async function savedApCount(page: Page): Promise<number> {
	await page.waitForTimeout(2600);
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		const proj = raw ? (JSON.parse(raw) as { aps?: unknown[] }) : null;
		return proj?.aps?.length ?? 0;
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
	expect(await savedApCount(page)).toBe(0);
	await expect(placeToggle).toHaveAttribute('aria-pressed', 'false');
	await page.screenshot({ path: 'test-results/place-mode/off.png' });

	// On: a click adds one.
	await placeToggle.click();
	await expect(placeToggle).toHaveAttribute('aria-pressed', 'true');
	await page.screenshot({ path: 'test-results/place-mode/on.png' });
	await canvas.click({ position: { x: 400, y: 300 } });
	expect(await savedApCount(page)).toBe(1);

	// Escape leaves the mode, so the next click adds nothing.
	await page.keyboard.press('Escape');
	await expect(placeToggle).toHaveAttribute('aria-pressed', 'false');
	await canvas.click({ position: { x: 600, y: 400 } });
	expect(await savedApCount(page)).toBe(1);
});
