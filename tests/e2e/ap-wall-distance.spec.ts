import { test, expect, type Page } from '@playwright/test';

/**
 * The nearest-wall annotation on the canvas.
 *
 * Every access point gets a dashed connector to the closest wall pixel and a
 * caption with the distance, in the interface's own length unit. The geometry is
 * covered exhaustively by the unit tests for `wall-distance.ts`; what can only
 * break here is the wiring — a mask that never reaches the annotation, a camera
 * that makes the connector point the wrong way, or a caption that never draws.
 *
 * Nothing is asserted through the DOM, because nothing about this annotation is
 * in the DOM: it is painted onto the canvas. So the probe reads the canvas back
 * and looks for the two colours the drawing uses, which pins the annotation to a
 * *position* rather than merely to its existence. The plan is the same 400x400
 * frame in both cases, so the camera is identical and the only thing that moves
 * between the two runs is the wall.
 */

type Layout = 'left' | 'right' | 'nowalls';

/** Point (34, 197, 94): the marker of an access point that holds a channel. */
const AP_GREEN = { r: [25, 45], g: [185, 210], b: [85, 105] } as const;

/** Point (127, 215, 174): the caption under the annotation. */
const CAPTION_MINT = { r: [100, 175], g: [195, 245], b: [150, 215] } as const;

async function seed(page: Page, layout: Layout): Promise<void> {
	await page.addInitScript((which: Layout) => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');

		/*
		 * A closed 400x400 room with a bar wall inside it.
		 *
		 * The frame is what keeps the mask bounds — and so the camera fit —
		 * identical whichever side the bar is on. The bar's 8 px thickness is the
		 * wall as the mask stores it, so the distance measured to it is the distance
		 * to the wall's near face, which is what the caption claims.
		 *
		 * The bars sit 152 units from the access point, because the caption is only
		 * written beside the connector once the connector is long enough to hold
		 * it; a shorter one gets its caption under the name instead, and this spec
		 * is about the side the measurement points at.
		 */
		const c = document.createElement('canvas');
		c.width = 400;
		c.height = 400;
		const ctx = c.getContext('2d')!;
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, 400, 8);
		ctx.fillRect(0, 392, 400, 8);
		ctx.fillRect(0, 0, 8, 400);
		ctx.fillRect(392, 0, 8, 400);
		if (which === 'left') ctx.fillRect(40, 60, 8, 280);
		if (which === 'right') ctx.fillRect(352, 60, 8, 280);
		const mask =
			which === 'nowalls'
				? null
				: {
						dataUrl: c.toDataURL('image/png'),
						width: 400,
						height: 400,
						originX: 0,
						originY: 0
					};

		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Wall distance',
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
						wallMask: mask,
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
						id: 'ap0',
						name: 'AP-1',
						x: 200,
						y: 200,
						floorId: 'f1',
						band: '5ghz',
						channelWidth: 20,
						fixedChannel: null,
						assignedChannel: 36,
						interferenceRadius: 100,
						power: 20,
						modelId: null,
						modelLabel: null
					}
				]
			})
		);
	}, layout);
}

async function ready(page: Page): Promise<void> {
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(3000);
}

/**
 * Where the pixels of one colour are, on the main canvas.
 *
 * `spread` is how far the outermost one sits from the mean, which is what tells
 * a caption drawn out by the wall apart from the marker's own antialiased rim —
 * the rim blends the green fill into its white border ring and lands in the same
 * colour family as the caption, a couple of dozen pixels of it, always within a
 * few pixels of the dot.
 */
async function colourStats(
	page: Page,
	range: { r: readonly number[]; g: readonly number[]; b: readonly number[] }
): Promise<{ count: number; meanX: number; spread: number; minX: number; maxX: number }> {
	return page.evaluate((r: { r: number[]; g: number[]; b: number[] }) => {
		const canvases = Array.from(document.querySelectorAll('canvas'));
		const canvas = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
		const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
		const xs: number[] = [];
		for (let i = 0; i < d.length; i += 4) {
			const red = d[i]!;
			const green = d[i + 1]!;
			const blue = d[i + 2]!;
			if (
				red >= r.r[0]! &&
				red <= r.r[1]! &&
				green >= r.g[0]! &&
				green <= r.g[1]! &&
				blue >= r.b[0]! &&
				blue <= r.b[1]!
			) {
				xs.push((i / 4) % canvas.width);
			}
		}
		if (xs.length === 0) return { count: 0, meanX: 0, spread: 0, minX: 0, maxX: 0 };
		const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
		return {
			count: xs.length,
			meanX,
			spread: Math.max(...xs.map((x) => Math.abs(x - meanX))),
			minX: Math.min(...xs),
			maxX: Math.max(...xs)
		};
	}, range as { r: number[]; g: number[]; b: number[] });
}

test('points at the wall on whichever side of the access point it lies', async ({ page }) => {
	test.setTimeout(120_000);

	await seed(page, 'right');
	await ready(page);
	const apRight = await colourStats(page, AP_GREEN);
	const captionRight = await colourStats(page, CAPTION_MINT);
	await page.screenshot({ path: 'test-results/wall-distance/right.png' });

	// Re-seeding and reloading replaces the project; both scripts run, the later
	// one wins. The mask bounds are unchanged, so the camera is too.
	await seed(page, 'left');
	await page.reload();
	await ready(page);
	const apLeft = await colourStats(page, AP_GREEN);
	const captionLeft = await colourStats(page, CAPTION_MINT);

	// The probe has to be able to find the access point at all, or "the tick is out
	// by the wall" would be an assertion about noise.
	expect(apRight.count).toBeGreaterThan(20);
	expect(apLeft.count).toBeGreaterThan(20);
	expect(captionRight.count).toBeGreaterThan(40);
	expect(captionLeft.count).toBeGreaterThan(40);

	// The figure is drawn under the marker's name, in the same place whatever the
	// nearest wall is doing: the two readings sit on their own access point. The
	// tolerance is wide because the tick at the far end of the connector is mint
	// too, and 152 units of it pull the mean a couple of dozen pixels out.
	expect(Math.abs(captionRight.meanX - apRight.meanX)).toBeLessThan(45);
	expect(Math.abs(captionLeft.meanX - apLeft.meanX)).toBeLessThan(45);

	// The measurement reaches the wall it names: the tick at the far end of the
	// connector is mint too, 152 units out — to the right in one layout and to the
	// left in the other. That is the assertion that the connector points at the
	// *nearest* wall rather than in some fixed direction.
	expect(captionRight.maxX - apRight.meanX).toBeGreaterThan(100);
	expect(apLeft.meanX - captionLeft.minX).toBeGreaterThan(100);
	// ... and not the other way: a right-hand wall must not put mint 100 px to the
	// left of the marker.
	expect(apRight.meanX - captionRight.minX).toBeLessThan(100);
	expect(captionLeft.maxX - apLeft.meanX).toBeLessThan(100);
});

test('draws no annotation on a floor whose mask never arrived', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page, 'nowalls');
	await ready(page);

	// The access point is still on the canvas — it is what the camera frames when
	// there is no plan — so the absence of the caption is the annotation declining
	// to measure, not the canvas being empty.
	const ap = await colourStats(page, AP_GREEN);
	const caption = await colourStats(page, CAPTION_MINT);
	expect(ap.count).toBeGreaterThan(20);

	// What is left of the caption colour is the marker's own rim: a couple of
	// dozen pixels, all of them hugging its centre.
	expect(caption.count).toBeLessThan(60);
	expect(caption.spread).toBeLessThan(15);
});
