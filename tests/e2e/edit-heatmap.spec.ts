import { test, expect, type Page } from '@playwright/test';

/**
 * The heatmap stands down while walls are edited, and comes back afterwards.
 *
 * Every brush dab rewrites the wall mask and the heatmap is rebuilt from it — one
 * attenuation field marched per AP over the whole plan, on the main thread, inside
 * the same frame as the stroke — which is what made drawing with the heatmap on
 * stutter.
 *
 * The proxy is the canvas itself: the heatmap ramp is the only saturated thing the
 * canvas draws (walls, grid and labels are neutral grey), so counting coloured
 * pixels tells whether the layer is being drawn at all. The LAYERS panel is hidden
 * during an edit, so its legend cannot be the signal.
 */

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
				name: 'Edit perf',
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

test('heatmap stands down while editing walls', async ({ page }) => {
	page.on('pageerror', (e) => console.log('[edit:pageerror]', String(e).slice(0, 400)));
	await seed(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(2000);

	await page.locator('.layer-row').filter({ hasText: 'Signal heatmap' }).click();
	await page.waitForTimeout(2500);
	const withHeatmap = await colouredPixels(page);

	await page.getByText('Edit Walls').click();
	await page.waitForTimeout(2000);
	const whileEditing = await colouredPixels(page);
	await page.screenshot({ path: 'test-results/edit-perf/editing.png' });

	await page.locator('.wall-toolbar').locator('text=Done').click();
	await page.waitForTimeout(2500);
	const afterDone = await colouredPixels(page);
	await page.screenshot({ path: 'test-results/edit-perf/after-done.png' });

	console.log(
		`[edit] coloured px: with heatmap=${withHeatmap} while editing=${whileEditing} after done=${afterDone}`
	);
	expect(withHeatmap).toBeGreaterThan(1000);
	// Off while editing: only the neutral walls, grid and labels are left.
	expect(whileEditing).toBeLessThan(withHeatmap * 0.05);
	// And back afterwards.
	expect(afterDone).toBeGreaterThan(withHeatmap * 0.5);
});
