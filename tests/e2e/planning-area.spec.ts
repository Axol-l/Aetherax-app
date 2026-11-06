import { test, expect, type Page } from '@playwright/test';

/**
 * The planning area: its toolbar, and the heatmap following a redraw.
 *
 * The clip the heatmap is drawn through was assigned only when the wall mask materialised,
 * so redrawing the area changed no wall pixel and left the old outline on the heatmap: the
 * new area looked like it had done nothing. The toolbar is tested here because the drawing
 * is done over the canvas, and the strip is where its close/undo/cancel live.
 */

const ROOM = 400;

async function seed(page: Page): Promise<void> {
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
				name: 'Planning',
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
						calibration: { worldUnitsPerMeter: 32.8 },
						floorplanBoundary: null,
						// Segments, not only a raster: the plan a user draws has them, and they
						// are what planning corners snap to.
						wallMask: { dataUrl: c.toDataURL('image/png'), width: ROOM, height: ROOM, originX: 0, originY: 0 },
						walls: [
							{ id: 'w-n', ax: 10, ay: 10, bx: ROOM - 10, by: 10, material: 0 },
							{ id: 'w-e', ax: ROOM - 10, ay: 10, bx: ROOM - 10, by: ROOM - 10, material: 0 },
							{ id: 'w-s', ax: ROOM - 10, ay: ROOM - 10, bx: 10, by: ROOM - 10, material: 0 },
							{ id: 'w-w', ax: 10, ay: ROOM - 10, bx: 10, by: 10, material: 0 }
						],
						// A small area to start from, so the redraw has something to grow out of.
						planningArea: [
							{ x: 150, y: 150 },
							{ x: 250, y: 150 },
							{ x: 250, y: 250 },
							{ x: 150, y: 250 }
						],
						wallAttenuation: 5,
						wallMaterial: 0,
						materialMask: null,
						roomTypeMask: null,
						roomDensityOverrides: {},
						roomCustomLabels: {}
					}
				],
				aps: [
					{
						id: 'ap1',
						name: 'AP-1',
						x: 200,
						y: 200,
						floorId: 'f1',
						band: '5ghz',
						channelWidth: 20,
						fixedChannel: null,
						assignedChannel: 36,
						interferenceRadius: 1300,
						power: 20,
						modelId: null,
						modelLabel: null
					}
				]
			})
		);
	}, { room: ROOM });
}

async function savedArea(page: Page): Promise<Array<{ x: number; y: number }> | null> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		const floor = raw ? (JSON.parse(raw) as { floors?: Array<{ planningArea?: Array<{ x: number; y: number }> | null }> }).floors?.[0] : null;
		return floor?.planningArea ?? null;
	});
}

/** Warm heatmap texels: coloured, and not the grey of the plan or the chrome. */
async function heatPixels(page: Page): Promise<number> {
	return page.evaluate(() => {
		const canvas = Array.from(document.querySelectorAll('canvas')).sort(
			(a, b) => b.width * b.height - a.width * a.height
		)[0]!;
		const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) {
			const r = d[i]!;
			const g = d[i + 1]!;
			const b = d[i + 2]!;
			const max = Math.max(r, g, b);
			if (max > 80 && max - Math.min(r, g, b) > 40) n++;
		}
		return n;
	});
}

/** Warm pixels inside a viewport-space rectangle. */
async function heatPixelsIn(
	page: Page,
	region: { x: number; y: number; w: number; h: number }
): Promise<number> {
	return page.evaluate((r) => {
		const canvas = Array.from(document.querySelectorAll('canvas')).sort(
			(a, b) => b.width * b.height - a.width * a.height
		)[0]!;
		const box = canvas.getBoundingClientRect();
		const sx = canvas.width / box.width;
		const sy = canvas.height / box.height;
		const x0 = Math.max(0, Math.round((r.x - box.left) * sx));
		const y0 = Math.max(0, Math.round((r.y - box.top) * sy));
		const x1 = Math.min(canvas.width, Math.round((r.x + r.w - box.left) * sx));
		const y1 = Math.min(canvas.height, Math.round((r.y + r.h - box.top) * sy));
		if (x1 <= x0 || y1 <= y0) return 0;
		const d = canvas.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0).data;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) {
			const max = Math.max(d[i]!, d[i + 1]!, d[i + 2]!);
			if (max > 80 && max - Math.min(d[i]!, d[i + 1]!, d[i + 2]!) > 40) n++;
		}
		return n;
	}, region);
}

test('redrawing the planning area moves the heatmap clip with it', async ({ page }) => {
	test.setTimeout(120_000);
	await seed(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(1500);

	// The seeded area is small; the heatmap must already be clipped to it.
	await page.getByText('Signal heatmap').click();
	await page.waitForTimeout(2500);
	const before = await heatPixels(page);
	expect(before).toBeGreaterThan(100);

	// The area is the statement of the floor; there is no button to hand it back to the
	// detector — redraw it instead.
	await expect(page.getByRole('button', { name: 'Use the detected area' })).toHaveCount(0);

	await page.getByRole('button', { name: 'Redraw planning area' }).click();
	const toolbar = page.getByRole('toolbar', { name: 'Planning area' });
	await expect(toolbar).toBeVisible();
	// The confirm only appears once there is a polygon to confirm.
	await expect(toolbar.getByRole('button', { name: 'Confirm area' })).toHaveCount(0);

	const canvas = page.locator('canvas').first();
	const box = (await canvas.boundingBox())!;
	// Beyond the mask's frame (400 wide) but inside the AP's reach and the new area: the
	// image used to be shrunk to the mask here, so this strip stayed empty.
	const strip = {
		x: box.x + box.width * 0.42,
		y: box.y + box.height * 0.3,
		w: box.width * 0.12,
		h: box.height * 0.5
	};
	const stripBefore = await heatPixelsIn(page, strip);

	// Four corners of a loop that extends past the plan, then close it from the bar.
	for (const point of [
		{ x: 0.2, y: 0.2 },
		{ x: 0.9, y: 0.2 },
		{ x: 0.9, y: 0.9 },
		{ x: 0.2, y: 0.9 }
	]) {
		await canvas.click({ position: { x: box.width * point.x, y: box.height * point.y } });
	}
	await expect(toolbar.getByRole('button', { name: 'Confirm area' })).toBeVisible();
	await toolbar.getByRole('button', { name: 'Confirm area' }).click();

	// The save is debounced, and the seeded area already has four corners — so wait for
	// the *new* size, not for a corner count that was true before the redraw.
	await expect
		.poll(
			async () => {
				const area = await savedArea(page);
				if (!area || area.length < 3) return 0;
				const xs = area.map((p) => p.x);
				return Math.max(...xs) - Math.min(...xs);
			},
			{ timeout: 20_000 }
		)
		.toBeGreaterThan(150);

	const area = (await savedArea(page))!;
	const xs = area.map((p) => p.x);
	const ys = area.map((p) => p.y);
	expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(150);
	expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(150);

	// The picture grew with the area: the old clip would have kept the small square.
	await expect.poll(() => heatPixels(page), { timeout: 20_000 }).toBeGreaterThan(before * 1.5);
	await expect
		.poll(() => heatPixelsIn(page, strip), { timeout: 20_000 })
		.toBeGreaterThan(stripBefore + 100);
	await expect(toolbar).toHaveCount(0);
});

test('clicking the first corner closes the loop as a proposal, then confirms', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(1500);

	await page.getByRole('button', { name: 'Redraw planning area' }).click();
	const toolbar = page.getByRole('toolbar', { name: 'Planning area' });
	await expect(toolbar).toBeVisible();

	const canvas = page.locator('canvas').first();
	const box = (await canvas.boundingBox())!;
	const corners = [
		{ x: box.width * 0.3, y: box.height * 0.3 },
		{ x: box.width * 0.7, y: box.height * 0.3 },
		{ x: box.width * 0.7, y: box.height * 0.7 }
	];
	for (const corner of corners) await canvas.click({ position: corner });

	// The first corner is still the corner it was snapped to; clicking it closes the loop
	// as a proposal — the bar stays up with the confirm, and the saved area is unchanged
	// until that confirm is pressed.
	await canvas.click({ position: corners[0]! });
	await expect(toolbar).toBeVisible();
	await expect(toolbar.getByRole('button', { name: 'Confirm area' })).toBeVisible();
	await expect.poll(async () => (await savedArea(page))?.length ?? 0).toBe(4);

	await toolbar.getByRole('button', { name: 'Confirm area' }).click();
	await expect.poll(async () => (await savedArea(page))?.length ?? 0, { timeout: 20_000 }).toBe(3);
	await expect(toolbar).toHaveCount(0);
});

