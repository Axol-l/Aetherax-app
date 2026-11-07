/**
 * The 3D floor view: the current floor with its walls standing up.
 *
 * The claim this view makes is that the wall data the model already holds — segments and
 * their materials — comes back as geometry. The projection is the stacked view's, whose
 * arithmetic is unit-tested (`canvas/renderers/stacked-floors.test.ts`); what is covered
 * here is that the view is wired up, that a wall's *height* is what appears on screen,
 * that dragging turns it, that the floor arrows step storeys, and that it stays read-only.
 *
 * Seeded with segments rather than a raster: the extrusion is built from them, so a spec
 * that seeded a mask would test the fallback instead.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupCleanState } from './helpers';

/** One floor whose walls are four segments around a 200 × 150 room. */
async function seedWalledFloor(
	page: Page,
	options: { floors?: number; wallHeightM?: number } = {}
): Promise<void> {
	await page.addInitScript(
		(seed: { floors: number; wallHeightM?: number }) => {
			localStorage.setItem('aetherax:welcomed', '1');
			const rect = [
				{ id: 'w1', ax: 100, ay: 100, bx: 300, by: 100, material: 3 },
				{ id: 'w2', ax: 300, ay: 100, bx: 300, by: 250, material: 3 },
				{ id: 'w3', ax: 300, ay: 250, bx: 100, by: 250, material: 3 },
				{ id: 'w4', ax: 100, ay: 250, bx: 100, by: 100, material: 3 }
			].map((wall) => ({ ...wall, ...(seed.wallHeightM ? { heightM: seed.wallHeightM } : {}) }));
			const floor = (level: number) => ({
				id: `f${level + 1}`,
				name: `Floor ${level + 1}`,
				level,
				ceilingHeight: 3,
				floorMaterial: 1,
				floorThickness: 0.2,
				floorplanScale: 1,
				floorplanOffsetX: 0,
				floorplanOffsetY: 0,
				// Ten units to the metre, so a three-metre wall is thirty units wide on the plan.
				calibration: { worldUnitsPerMeter: 10 },
				floorplanBoundary: null,
				wallMask: null,
				wallAttenuation: 5,
				wallMaterial: 0,
				materialMask: null,
				roomTypeMask: null,
				roomDensityOverrides: {},
				roomCustomLabels: {},
				walls: rect,
				notes: [],
				planningArea: null,
				surfaces: []
			});
			localStorage.setItem(
				'aetherax:project',
				JSON.stringify({
					version: 3,
					name: '3D',
					band: '5ghz',
					channelWidth: 20,
					regulatoryDomain: 'fcc',
					unitSystem: 'metric',
					ispSpeed: 0,
					targetThroughput: 25,
					allowOutsideRooms: true,
					clientHeight: 1.5,
					floors: Array.from({ length: seed.floors }, (_, i) => floor(i)),
					aps: []
				})
			);
		},
		{ floors: options.floors ?? 1, wallHeightM: options.wallHeightM }
	);
}

/** Saturated pixels on the canvas: the walls' own colours, not the plan's greys. */
async function colouredPixels(page: Page): Promise<number> {
	return page.evaluate(() => {
		const c = document.querySelector('canvas') as HTMLCanvasElement;
		const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) {
			const r = d[i]!;
			const g = d[i + 1]!;
			const b = d[i + 2]!;
			const mx = Math.max(r, g, b);
			if (mx > 40 && mx - Math.min(r, g, b) > 24) n++;
		}
		return n;
	});
}

/** Enter the 3D view from the status bar's view switch. */
async function view3d(page: Page): Promise<void> {
	await page.locator('.view-btn').nth(3).click();
	await page.waitForTimeout(1200);
}

test.describe('3D floor view', () => {
	test.beforeEach(async ({ page }) => {
		await setupCleanState(page);
	});

	/**
	 * A wall's own height is what the view shows.
	 *
	 * The same plan twice: once with four-centimetre walls, once with four-metre ones. The
	 * view frames what it draws, so both fit the canvas — and the tall walls then cover a
	 * far larger share of it. That is the extrusion, measured.
	 */
	test('a wall stands as tall as its height', async ({ page }) => {
		await seedWalledFloor(page, { wallHeightM: 0.04 });
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.waitForTimeout(1200);
		await view3d(page);
		const low = await colouredPixels(page);
		await page.screenshot({ path: 'test-results/floor-3d/low.png' });

		await seedWalledFloor(page, { wallHeightM: 4 });
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.waitForTimeout(1200);
		await view3d(page);
		const tall = await colouredPixels(page);
		await page.screenshot({ path: 'test-results/floor-3d/tall.png' });
		console.log(`[3d] saturated px: low walls=${low} tall walls=${tall}`);

		expect(tall).toBeGreaterThan(low * 3);
	});

	test('dragging turns the view', async ({ page }) => {
		await seedWalledFloor(page, { wallHeightM: 3 });
		await page.goto('/');
		await page.waitForSelector('canvas');
		await view3d(page);

		// The viewpoint is in the LAYERS panel, so the turn is readable from the DOM
		// rather than inferred from pixels.
		const rotation = page.locator('.opacity-value').first();
		const before = (await rotation.textContent()) ?? '';
		expect(before).toMatch(/\d+°/);

		const r = (await page.locator('canvas').boundingBox())!;
		await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
		await page.mouse.down();
		await page.mouse.move(r.x + r.width / 2 + 160, r.y + r.height / 2, { steps: 6 });
		await page.mouse.up();
		await page.waitForTimeout(700);

		await expect(rotation).not.toHaveText(before);
		await page.screenshot({ path: 'test-results/floor-3d/turned.png' });
	});

	test('the arrows step storeys, and the view is read-only', async ({ page }) => {
		await seedWalledFloor(page, { floors: 2, wallHeightM: 3 });
		await page.goto('/');
		await page.waitForSelector('canvas');
		await view3d(page);

		const activeFloor = () =>
			page.locator('.floor-pill.active').first().textContent({ timeout: 1000 });
		expect(await activeFloor()).toContain('Floor 1');

		await page.getByRole('button', { name: 'Floor above' }).click();
		await page.waitForTimeout(900);
		expect(await activeFloor()).toContain('Floor 2');
		await page.screenshot({ path: 'test-results/floor-3d/floor-2.png' });

		await page.getByRole('button', { name: 'Floor below' }).click();
		await page.waitForTimeout(900);
		expect(await activeFloor()).toContain('Floor 1');

		// Read-only, like the overviews: the editing layers are not drawn here.
		await expect(page.getByText('Draw wall')).toHaveCount(0);
	});
});

/**
 * The arrows play the storey change instead of cutting to it: the old floor fades away,
 * the next one fades in.
 *
 * Motion is pinned here rather than inherited: the suite may run with reduced motion (the
 * dialogs settle at once either way), but this test is about the animation, so it asks for
 * the animation explicitly.
 * Counting distinct canvases is what separates an animation from an instant switch: an
 * instant switch settles after one repaint (the re-fit), while an animation repaints every
 * frame for `FLOOR_SWAP_MS`.
 */
test.describe('3D floor view — storey animation', () => {
	test.use({ contextOptions: { reducedMotion: 'no-preference' } });

	test('the arrows animate the change instead of cutting', async ({ page }) => {
		await seedWalledFloor(page, { floors: 2, wallHeightM: 3 });
		await page.goto('/');
		await page.waitForSelector('canvas');
		await view3d(page);

		const frames = await page.evaluate(
			() =>
				new Promise<number>((resolve) => {
					const canvas = document.querySelector('canvas') as HTMLCanvasElement;
					const seen = new Set<string>();
					const started = performance.now();
					const tick = () => {
						seen.add(canvas.toDataURL());
						if (performance.now() - started < 520) requestAnimationFrame(tick);
						else resolve(seen.size);
					};
					// 先挂上采样再点箭头，第一帧也不漏；点页面内的按钮，省掉一次往返延迟。
					(document.querySelector('[aria-label="Floor above"]') as HTMLButtonElement).click();
					requestAnimationFrame(tick);
				})
		);

		// 瞬间切换只会出现两三种画面；动画在 400 ms 内几乎每帧都不同。
		expect(frames).toBeGreaterThan(4);
	});
});
