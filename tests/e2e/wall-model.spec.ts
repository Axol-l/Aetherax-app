/**
 * The segments are the wall model; the raster mask is their derivation.
 *
 * The brush is gone, so this file replaces the old wall-editor spec. What it has to
 * prove is the merge itself: a floor whose walls are only segments must get a mask
 * without anybody pressing a button, deleting the last wall must take the mask with
 * it, an access point inside a drawn room must be covered, and a wall's material must
 * be a property of *the wall* rather than of pixels under it.
 *
 * Seeded rather than detected, deliberately: the sample plan's OCR pass costs a
 * minute and this is not a test of detection.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupCleanState } from './helpers';

/** A 10 m × 8 m room, in world units at ten units to the metre. */
const WALLS = [
	{ id: 'w1', ax: 100, ay: 100, bx: 200, by: 100, material: 0 },
	{ id: 'w2', ax: 200, ay: 100, bx: 200, by: 180, material: 0 },
	{ id: 'w3', ax: 200, ay: 180, bx: 100, by: 180, material: 0 },
	{ id: 'w4', ax: 100, ay: 180, bx: 100, by: 100, material: 0 }
];

/** An access point in the middle of that room. */
const AP = { x: 150, y: 140 };

/**
 * Seed a floor whose walls are segments only — no mask, no plan image.
 *
 * The mask the rest of the app reads has to appear from these four lines, which is
 * exactly the claim under test.
 */
async function seedSegments(page: Page, walls = WALLS): Promise<void> {
	await page.addInitScript(
		(seed: { walls: typeof WALLS; ap: typeof AP }) => {
			localStorage.setItem('aetherax:welcomed', '1');
			const floorId = 'f1';
			localStorage.setItem(
				'aetherax:project',
				JSON.stringify({
					version: 3,
					name: 'Segments',
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
							id: floorId,
							name: 'Floor 1',
							level: 0,
							ceilingHeight: 3,
							floorMaterial: 1,
							floorThickness: 0.2,
							floorplanScale: 1,
							floorplanOffsetX: 0,
							floorplanOffsetY: 0,
							// Ten world units to the metre, so the seeded room is 10 m × 8 m.
							calibration: { worldUnitsPerMeter: 10 },
							floorplanBoundary: null,
							wallMask: null,
							wallAttenuation: 5,
							wallMaterial: 0,
							materialMask: null,
							roomTypeMask: null,
							roomDensityOverrides: {},
							roomCustomLabels: {},
							walls: seed.walls,
							notes: [],
							planningArea: null
						}
					],
					aps: [
						{
							id: 'ap1',
							name: 'AP-1',
							x: seed.ap.x,
							y: seed.ap.y,
							floorId,
							band: '5ghz',
							channelWidth: 20,
							fixedChannel: null,
							assignedChannel: null,
							interferenceRadius: 500,
							power: 20,
							modelId: null,
							modelLabel: null
						}
					]
				})
			);
		},
		{ walls, ap: AP }
	);
}

/** The saved project, as the app last wrote it. */
async function saved(page: Page): Promise<{
	floors: Array<{
		walls?: Array<{ id: string; material: number }>;
		wallMask?: { width: number; height: number } | null;
	}>;
}> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		return raw ? JSON.parse(raw) : { floors: [] };
	});
}

/** Pixels set in the saved wall mask of the first floor. */
async function savedWallPixels(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const raw = localStorage.getItem('aetherax:project');
		if (!raw) return 0;
		const mask = (
			JSON.parse(raw) as {
				floors?: Array<{ wallMask?: { dataUrl: string; width: number; height: number } | null }>;
			}
		).floors?.[0]?.wallMask;
		if (!mask) return 0;
		const img = new Image();
		await new Promise((resolve, reject) => {
			img.onload = () => resolve(null);
			img.onerror = () => reject(new Error('the saved wall mask did not decode'));
			img.src = mask.dataUrl;
		});
		const canvas = document.createElement('canvas');
		canvas.width = mask.width;
		canvas.height = mask.height;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(img, 0, 0);
		const data = ctx.getImageData(0, 0, mask.width, mask.height).data;
		let n = 0;
		for (let i = 0; i < data.length; i += 4) if (data[i]! > 128) n++;
		return n;
	});
}

/** Pixel values set in the saved *material* mask: the ids the derivation painted. */
async function savedMaterialIds(page: Page): Promise<number[]> {
	return page.evaluate(async () => {
		const raw = localStorage.getItem('aetherax:project');
		if (!raw) return [];
		const mask = (
			JSON.parse(raw) as {
				floors?: Array<{ materialMask?: { dataUrl: string; width: number; height: number } | null }>;
			}
		).floors?.[0]?.materialMask;
		if (!mask) return [];
		const img = new Image();
		await new Promise((resolve, reject) => {
			img.onload = () => resolve(null);
			img.onerror = () => reject(new Error('the saved material mask did not decode'));
			img.src = mask.dataUrl;
		});
		const canvas = document.createElement('canvas');
		canvas.width = mask.width;
		canvas.height = mask.height;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(img, 0, 0);
		const data = ctx.getImageData(0, 0, mask.width, mask.height).data;
		const ids = new Set<number>();
		// A material id lives in the red channel. The alpha channel is the wall: a pixel
		// with no alpha is outside the band and carries whatever id was left there.
		for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 128) ids.add(data[i]!);
		return [...ids].sort((a, b) => a - b);
	});
}

test.describe('Walls as segments', () => {
	test.beforeEach(async ({ page }) => {
		await setupCleanState(page);
	});

	test('the mask is derived from the segments on load', async ({ page }) => {
		await seedSegments(page);
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.getByRole('tab', { name: 'Floorplan' }).click();

		// Nothing was pressed: the four lines are the only statement of the geometry, so
		// the mask that appears is the derivation.
		await expect.poll(() => savedWallPixels(page), { timeout: 20_000 }).toBeGreaterThan(200);

		const project = await saved(page);
		const mask = project.floors[0]?.wallMask;
		expect(mask).toBeTruthy();
		// The frame is the room plus a margin, not the whole canvas: the derivation is
		// sized from the walls because there was no plan to take a frame from.
		expect(mask!.width).toBeLessThan(400);
		expect(mask!.height).toBeLessThan(400);

		// And the walls are still there, unchanged.
		expect(project.floors[0]?.walls?.map((w) => w.id)).toEqual(['w1', 'w2', 'w3', 'w4']);
	});

	test('the coverage figure follows the derived geometry', async ({ page }) => {
		await seedSegments(page);
		await page.goto('/');
		await page.waitForSelector('canvas');

		// Coverage only reads above zero when there is an interior to sample and the AP
		// reaches it — so a percentage here is the proof that the optimiser's domain came
		// from the segments rather than from a mask nobody wrote.
		await expect
			.poll(
				async () =>
					page
						.locator('.metric-value')
						.first()
						.textContent({ timeout: 1000 })
						.catch(() => null),
				{ timeout: 30_000 }
			)
			.toMatch(/\d+%/);
	});

	test('deleting the last wall empties the mask and keeps the frame', async ({ page }) => {
		await seedSegments(page);
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.getByRole('tab', { name: 'Floorplan' }).click();
		await expect.poll(() => savedWallPixels(page), { timeout: 20_000 }).toBeGreaterThan(200);
		const before = (await saved(page)).floors[0]!.wallMask!;

		await page.getByRole('button', { name: 'Clear walls' }).click();

		// The walls are gone, so the mask they produced must be gone too — otherwise every
		// consumer keeps measuring walls that no longer exist.
		await expect.poll(() => savedWallPixels(page), { timeout: 20_000 }).toBe(0);
		const after = (await saved(page)).floors[0]?.wallMask;
		expect(after).toBeTruthy();
		// But the frame stays: room labels and the plan's coordinates are addressed in it.
		expect(after!.width).toBe(before.width);
		expect(after!.height).toBe(before.height);
	});

	test('a drawn segment is saved and becomes the mask', async ({ page }) => {
		await setupCleanState(page);
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.getByRole('tab', { name: 'Floorplan' }).click();
		// No plan and no mask means no frame to draw into: this makes one and arms the
		// wall tool. It is the entry point the brush used to own.
		await page.getByRole('button', { name: 'Draw from Scratch' }).click();
		await page.waitForTimeout(400);

		const canvas = page.locator('canvas');
		const box = (await canvas.boundingBox())!;
		await canvas.click({ position: { x: box.width * 0.4, y: box.height * 0.4 } });
		await canvas.click({ position: { x: box.width * 0.6, y: box.height * 0.4 } });
		await page.waitForTimeout(500);
		await page.getByRole('button', { name: 'Done' }).click();

		await expect.poll(
			async () => (await saved(page)).floors[0]?.walls?.length ?? 0,
			{ timeout: 20_000 }
		).toBe(1);
		expect(await savedWallPixels(page)).toBeGreaterThan(0);
	});

	test('right-clicking a segment changes that wall\'s material', async ({ page }) => {
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.getByRole('tab', { name: 'Floorplan' }).click();
		await page.getByRole('button', { name: 'Draw from Scratch' }).click();
		await page.waitForTimeout(400);

		const canvas = page.locator('canvas');
		const box = (await canvas.boundingBox())!;
		const y = box.height * 0.5;
		await canvas.click({ position: { x: 300, y } });
		await canvas.click({ position: { x: 600, y } });
		await page.getByRole('button', { name: 'Done' }).click();
		await page.waitForTimeout(400);

		// The midpoint of the two clicks is on the segment by construction, so this does
		// not depend on where the camera happens to have put the plan.
		await canvas.click({ button: 'right', position: { x: 450, y } });
		const popup = page.locator('.popup');
		await expect(popup).toBeVisible();
		await popup.getByText('Concrete', { exact: true }).click();

		// Concrete is id 4. The wall is the model, so its own field changed…
		await expect
			.poll(
				async () => (await saved(page)).floors[0]?.walls?.[0]?.material,
				{ timeout: 20_000 }
			)
			.toBe(4);
		// …and the mask was re-derived from it rather than left as it was.
		await expect.poll(() => savedMaterialIds(page), { timeout: 20_000 }).toContain(4);
		expect(await savedWallPixels(page)).toBeGreaterThan(0);
	});
});
