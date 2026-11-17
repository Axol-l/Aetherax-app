/**
 * Drawing a wall keeps the heatmap drawn.
 *
 * The wall editor used to switch the heatmap off for the duration of an edit, because
 * every brush dab rewrote the mask and rebuilt a whole attenuation field in the same
 * frame. There is no brush any more: a wall is two clicks, and the mask is re-derived
 * once after them — so the layer stays up and simply repaints. This spec is the guard
 * on that: the canvas must not go blank while the geometry changes underneath it.
 *
 * The proxy is the canvas itself: the heatmap ramp is the only saturated thing the
 * canvas draws (walls, grid and labels are neutral grey), so counting coloured pixels
 * tells whether the layer is drawn at all.
 */
import { test, expect, type Page } from '@playwright/test';

async function seed(page: Page) {
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
		ctx.fillRect(396, 0, 6, 600);
		const wallMask = {
			dataUrl: c.toDataURL('image/png'),
			width: 800,
			height: 600,
			originX: 0,
			originY: 0
		};
		const floorBase = {
			ceilingHeight: 3,
			floorMaterial: 1,
			floorThickness: 0.2,
			floorplanScale: 1,
			floorplanOffsetX: 0,
			floorplanOffsetY: 0,
			calibration: null,
			floorplanBoundary: null,
			wallMask,
			wallAttenuation: 5,
			wallMaterial: 0,
			materialMask: null,
			roomTypeMask: null,
			roomDensityOverrides: {},
			roomCustomLabels: {}
		};
		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Draw perf',
				band: '5ghz',
				channelWidth: 20,
				regulatoryDomain: 'fcc',
				unitSystem: 'metric',
				ispSpeed: 0,
				targetThroughput: 25,
				allowOutsideRooms: true,
				clientHeight: 1.5,
				floors: [{ ...floorBase, id: 'f1', name: 'Floor 1', level: 0 }],
				aps: [
					{
						id: 'ap1',
						name: 'AP-1',
						x: 400,
						y: 300,
						floorId: 'f1',
						band: '5ghz',
						channelWidth: 20,
						fixedChannel: null,
						assignedChannel: null,
						interferenceRadius: 900,
						power: 20,
						modelId: null,
						modelLabel: null
					}
				]
			})
		);
	});
}

async function colouredPixels(page: Page): Promise<number> {
	return page.evaluate(() => {
		const c = document.querySelector('canvas') as HTMLCanvasElement;
		const ctx = c.getContext('2d')!;
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) {
			const r = d[i]!;
			const g = d[i + 1]!;
			const b = d[i + 2]!;
			const mx = Math.max(r, g, b);
			if (mx - Math.min(r, g, b) > 24 && mx > 40) n++;
		}
		return n;
	});
}

test('the heatmap stays drawn while a wall is added', async ({ page }) => {
	page.on('pageerror', (e) => console.log('[edit:pageerror]', String(e).slice(0, 400)));
	await seed(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(2000);

	await page.locator('.layer-row').filter({ hasText: 'Signal heatmap' }).click();
	await page.waitForTimeout(2500);
	const withHeatmap = await colouredPixels(page);
	expect(withHeatmap).toBeGreaterThan(1000);

	// Drawing a wall traces the detected plan first, so the mask is re-derived from the
	// segments rather than being left as the raster.
	await page.getByRole('tab', { name: 'Floorplan' }).click();
	await page.getByRole('button', { name: 'Draw wall' }).click();
	const canvas = page.locator('canvas');
	const box = (await canvas.boundingBox())!;
	await canvas.click({ position: { x: box.width * 0.55, y: box.height * 0.3 } });
	await canvas.click({ position: { x: box.width * 0.55, y: box.height * 0.7 } });
	await page.getByRole('toolbar', { name: 'Wall tools' }).getByRole('button', { name: 'Done' }).click();
	await page.waitForTimeout(2500);

	const after = await colouredPixels(page);
	await page.screenshot({ path: 'test-results/draw-wall/after.png' });
	console.log(`[draw] coloured px: before=${withHeatmap} after=${after}`);

	// Not blank, and the same layer is still the thing covering the plan.
	expect(after).toBeGreaterThan(withHeatmap * 0.3);
});
