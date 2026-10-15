import { test, expect, type Page } from '@playwright/test';

/**
 * The tiled floor overview: two things a card must not do.
 *
 * 1. A click on a card switches the current floor, and that switch re-runs the
 *    underlay effect, which auto-fits the camera when a plan finishes loading. In
 *    the tiled overview every floor is laid out in one world frame starting at the
 *    origin — which is also where each floor's own plan is drawn — so the fit
 *    landed on the FIRST card whichever card was clicked, yanking the sheet out
 *    from under the pointer. The observable is the status bar's zoom readout: the
 *    tiled view frames the whole sheet itself (`setView` → `handleFit` →
 *    `FloorTilesLayer.contentBounds`), and a floor switch may not re-frame it.
 *
 * 2. A card's coverage is generated from ITS floor's calibration. Both the
 *    generation and the cache key used to take the *selected* floor's scale, so
 *    clicking one card rescaled every other card's coverage — and, because the
 *    image's bounds derive from that scale, it could push a tile past its texel
 *    budget and render it as flat colour blocks. The observable is the heat
 *    pixels: selecting a different floor changes no tile's inputs, so the picture
 *    must not move.
 */

const FLOOR_W = 800;
const FLOOR_H = 600;
/** Must match `GAP` in `canvas/renderers/floor-tiles.ts`. */
const GAP = 120;
/** Must match the default padding of `Camera.fitToBounds`. */
const PAD = 60;
const SHEET_W = FLOOR_W * 2 + GAP;

/** 5 GHz at 20 dBm reaches ~29.9 m at the association floor. */
const ASSOC_METRES = 29.9;

interface SeedOptions {
	/** `worldUnitsPerMeter` for each floor; null leaves it uncalibrated. */
	wupm1?: number | null;
	wupm2?: number | null;
	/** Internal wall x positions per floor (world units). Defaults differ by floor. */
	walls1?: number[];
	walls2?: number[];
	/** Thickness of the internal walls, in world units. */
	wallThickness?: number;
	/**
	 * Default wall material for both floors. Without a material mask the heatmap
	 * charges a flat dB per crossing (`dbPerMeter × typicalThickness`), which for
	 * drywall is ~3 dB — too little to shadow anything. Metal is ~20 dB.
	 */
	wallMaterial?: number;
	/** Place both floors' APs at this world x (stacked) instead of the default pair. */
	stackedX?: number;
	/** Association radius in world units for both APs; defaults to a real 5 GHz AP. */
	radius?: number;
}

async function seedTwoFloors(page: Page, options: SeedOptions = {}): Promise<void> {
	await page.addInitScript(
		(arg: {
			wupm1: number | null;
			wupm2: number | null;
			assoc: number;
			walls1: number[];
			walls2: number[];
			wallThickness: number;
			wallMaterial: number;
			stackedX: number | null;
			radius: number | null;
		}) => {
			localStorage.setItem('aetherax:welcomed', '1');
			localStorage.removeItem('aetherax:project');

			/**
			 * A closed 800 × 600 room plus the given internal walls. The walls are
			 * `wallThickness` world units thick, which matters: the ray march is
			 * thickness-aware, so a 6-unit wall at 33 units/m is 0.18 m of drywall
			 * (~5 dB) and casts almost no shadow.
			 */
			const mask = (walls: number[]) => {
				const c = document.createElement('canvas');
				c.width = 800;
				c.height = 600;
				const ctx = c.getContext('2d')!;
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, 800, 8);
				ctx.fillRect(0, 592, 800, 8);
				ctx.fillRect(0, 0, 8, 600);
				ctx.fillRect(792, 0, 8, 600);
				for (const x of walls) ctx.fillRect(x, 0, arg.wallThickness, 600);
				return {
					dataUrl: c.toDataURL('image/png'),
					width: 800,
					height: 600,
					originX: 0,
					originY: 0
				};
			};

			const floorBase = (wupm: number | null) => ({
				ceilingHeight: 3,
				floorMaterial: 1,
				floorThickness: 0.2,
				floorplanScale: 1,
				floorplanOffsetX: 0,
				floorplanOffsetY: 0,
				calibration: wupm === null ? null : { worldUnitsPerMeter: wupm },
				floorplanBoundary: null,
				wallAttenuation: 5,
				wallMaterial: arg.wallMaterial,
				materialMask: null,
				roomTypeMask: null,
				roomDensityOverrides: {},
				roomCustomLabels: {}
			});

			/** Radius in world units for the same physical AP on a floor. */
			const ap = (
				id: string,
				name: string,
				x: number,
				y: number,
				floorId: string,
				wupm: number | null
			) => ({
				id,
				name,
				x,
				y,
				floorId,
				band: '5ghz',
				channelWidth: 20,
				fixedChannel: null,
				assignedChannel: null,
				interferenceRadius: arg.radius ?? Math.round(arg.assoc * (wupm ?? 32.8)),
				power: 20,
				modelId: null,
				modelLabel: null
			});

			const walls1 = arg.walls1;
			const walls2 = arg.walls2;
			const stacked = arg.stackedX;
			const aps = [
				ap('ap1', 'AP-1', stacked ?? 400, 300, 'f1', arg.wupm1),
				ap('ap2', 'AP-2', stacked ?? 200, 300, 'f2', arg.wupm2)
			];

			localStorage.setItem(
				'aetherax:project',
				JSON.stringify({
					version: 3,
					name: 'Tiled',
					band: '5ghz',
					channelWidth: 20,
					regulatoryDomain: 'fcc',
					unitSystem: 'metric',
					ispSpeed: 0,
					targetThroughput: 25,
					allowOutsideRooms: false,
					clientHeight: 1.5,
					heatmapRssiFloor: -70,
					floors: [
						{
							...floorBase(arg.wupm1),
							id: 'f1',
							name: 'Floor 1',
							level: 0,
							wallMask: mask(walls1)
						},
						{
							...floorBase(arg.wupm2),
							id: 'f2',
							name: 'Floor 2',
							level: 1,
							wallMask: mask(walls2)
						}
					],
					aps
				})
			);
		},
		{
			wupm1: options.wupm1 ?? null,
			wupm2: options.wupm2 ?? null,
			assoc: ASSOC_METRES,
			walls1: options.walls1 ?? [396],
			walls2: options.walls2 ?? [250],
			wallThickness: options.wallThickness ?? 6,
			wallMaterial: options.wallMaterial ?? 0,
			stackedX: options.stackedX ?? null,
			radius: options.radius ?? null
		}
	);
}

/** The name on the highlighted floor pill. */
async function activeFloor(page: Page): Promise<string> {
	return page
		.locator('.floor-pill.active')
		.first()
		.evaluate((el) => (el.firstChild?.textContent ?? '').trim());
}

async function openFloorplanTab(page: Page): Promise<void> {
	if (
		await page
			.locator('.floor-strip')
			.isVisible({ timeout: 200 })
			.catch(() => false)
	)
		return;
	const sidebarVisible = await page
		.locator('aside[aria-label="Sidebar"]')
		.isVisible({ timeout: 200 })
		.catch(() => false);
	if (!sidebarVisible) {
		await page.locator('button[aria-label="Toggle sidebar"]').click();
		await page.waitForTimeout(500);
	}
	const fpTab = page.locator('button[role="tab"]').filter({ hasText: 'Floorplan' });
	await fpTab.waitFor({ state: 'visible', timeout: 3000 });
	await fpTab.click();
	await page.waitForTimeout(300);
}

/**
 * Pixels that look like coverage: saturated, and not the teal used for the
 * selected card's frame and the AP dots.
 */
async function heatPixels(page: Page): Promise<number> {
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
			if (mx - Math.min(r, g, b) <= 40 || mx <= 60) continue;
			if (b > r + 30 && g > r + 20) continue; // teal frame / AP dot
			n++;
		}
		return n;
	});
}

/** Centre of one card in viewport coordinates. */
async function cardCentre(page: Page, index: 1 | 2): Promise<{ x: number; y: number }> {
	const box = (await page.locator('canvas').boundingBox())!;
	const scale = Math.min((box.width - 2 * PAD) / SHEET_W, (box.height - 2 * PAD) / FLOOR_H);
	const sheetW = SHEET_W * scale;
	const sheetH = FLOOR_H * scale;
	const worldX = (index - 1) * (FLOOR_W + GAP) + FLOOR_W / 2;
	return {
		x: box.x + (box.width - sheetW) / 2 + worldX * scale,
		y: box.y + (box.height - sheetH) / 2 + (FLOOR_H / 2) * scale
	};
}

/** Viewport-space rectangle of one card's cell. */
async function cardRect(
	page: Page,
	index: 1 | 2
): Promise<{ x: number; y: number; w: number; h: number }> {
	const box = (await page.locator('canvas').boundingBox())!;
	const scale = Math.min((box.width - 2 * PAD) / SHEET_W, (box.height - 2 * PAD) / FLOOR_H);
	const sheetW = SHEET_W * scale;
	const sheetH = FLOOR_H * scale;
	return {
		x: box.x + (box.width - sheetW) / 2 + (index - 1) * (FLOOR_W + GAP) * scale,
		y: box.y + (box.height - sheetH) / 2,
		w: FLOOR_W * scale,
		h: FLOOR_H * scale
	};
}

/** Coverage pixels inside a viewport-space rectangle. */
async function heatPixelsIn(
	page: Page,
	region: { x: number; y: number; w: number; h: number }
): Promise<number> {
	return page.evaluate((r) => {
		const c = document.querySelector('canvas') as HTMLCanvasElement;
		const box = c.getBoundingClientRect();
		const sx = c.width / box.width;
		const sy = c.height / box.height;
		const x0 = Math.max(0, Math.round((r.x - box.left) * sx));
		const y0 = Math.max(0, Math.round((r.y - box.top) * sy));
		const x1 = Math.min(c.width, Math.round((r.x + r.w - box.left) * sx));
		const y1 = Math.min(c.height, Math.round((r.y + r.h - box.top) * sy));
		if (x1 <= x0 || y1 <= y0) return 0;
		const d = c.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0).data;
		let n = 0;
		for (let i = 0; i < d.length; i += 4) {
			const r0 = d[i]!;
			const g0 = d[i + 1]!;
			const b0 = d[i + 2]!;
			const mx = Math.max(r0, g0, b0);
			if (mx - Math.min(r0, g0, b0) <= 40 || mx <= 60) continue;
			if (b0 > r0 + 30 && g0 > r0 + 20) continue;
			n++;
		}
		return n;
	}, region);
}

/** Turn the heatmap on and enter the tiled view, with both tiles warmed. */
async function openTiledWithHeatmap(page: Page): Promise<void> {
	await openFloorplanTab(page);
	await page.locator('.layer-row').filter({ hasText: 'Signal heatmap' }).click();
	await page.waitForTimeout(2500);
	await page.locator('.view-btn[title^="Tile every floor"]').click();
	// Tiles warm one floor per frame.
	await page.waitForTimeout(6000);
}

test('clicking a floor card does not re-frame the tiled overview', async ({ page }) => {
	await seedTwoFloors(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(2000);
	await openFloorplanTab(page);

	await page.locator('.view-btn[title^="Tile every floor"]').click();
	await page.waitForTimeout(800);
	expect(await activeFloor(page)).toBe('Floor 1');
	const zoomBefore = await page.locator('.status-item.zoom').innerText();

	const second = await cardCentre(page, 2);
	await page.mouse.click(second.x, second.y);
	await page.waitForTimeout(1500);

	// The click has to land on the card, or the rest of the test means nothing.
	expect(await activeFloor(page)).toBe('Floor 2');
	expect(await page.locator('.status-item.zoom').innerText()).toBe(zoomBefore);
});

test('selecting another floor leaves every card’s coverage alone', async ({ page }) => {
	// Floors with different calibrations: this is what made the selected floor's
	// scale leak into the other cards.
	await seedTwoFloors(page, { wupm1: 33.05, wupm2: 66.1 });
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(2000);
	await openTiledWithHeatmap(page);

	expect(await activeFloor(page)).toBe('Floor 1');
	const before = await heatPixels(page);
	expect(before).toBeGreaterThan(1000);

	const second = await cardCentre(page, 2);
	await page.mouse.click(second.x, second.y);
	await page.waitForTimeout(4000);
	expect(await activeFloor(page)).toBe('Floor 2');

	// No tile's inputs changed, so the same pixels must be on screen.
	const after = await heatPixels(page);
	expect(Math.abs(after - before) / before).toBeLessThan(0.02);
});

test('one scale for the whole project, taken from floor 1', async ({ page }) => {
	// Identical geometry on both floors — same wall, same AP position, same radius —
	// and only the *stored* calibrations differ. The two cards must still match: the
	// project has one scale and it is floor 1's, wherever a per-floor read would
	// have used floor 2's.
	await seedTwoFloors(page, {
		wupm1: 33.05,
		wupm2: 66.1,
		stackedX: 300,
		radius: 988,
		walls1: [396],
		walls2: [396]
	});
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(2000);
	await openTiledWithHeatmap(page);

	const card1 = await heatPixelsIn(page, await cardRect(page, 1));
	const card2 = await heatPixelsIn(page, await cardRect(page, 2));
	expect(card1).toBeGreaterThan(1000);
	// Same walls, same AP position, same radius — so the same picture.
	expect(Math.abs(card1 - card2) / card1).toBeLessThan(0.05);
});

test('a card is drawn with its own floor’s walls', async ({ page }) => {
	// The two APs sit in the same 4-unit cell (stacked APs, the normal multi-floor
	// plan). Floor 1 is one open room; floor 2 has a 60-unit (≈1.8 m) wall a short
	// way from its AP, which shadows everything beyond it. The attenuation-field
	// cache is keyed on position and radius, so without a per-floor mask tag the
	// second card is marched against the first floor's walls — the reported
	// symptom: "single view on floor 1, then the tiled view shows floor 2 wrong".
	await seedTwoFloors(page, {
		stackedX: 150,
		radius: 988,
		walls1: [],
		walls2: [250],
		wallThickness: 60,
		wallMaterial: 5
	});
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(2000);
	await openTiledWithHeatmap(page);

	const card1 = await heatPixelsIn(page, await cardRect(page, 1));
	const card2 = await heatPixelsIn(page, await cardRect(page, 2));
	expect(card1).toBeGreaterThan(1000);
	// Floor 2's wall shadows most of its plan, so it must show far less coverage
	// than floor 1. Equal numbers here mean the two cards shared one field.
	expect(card2).toBeLessThan(card1 * 0.8);
});
