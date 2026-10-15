/**
 * What the vector detector reads, plan by plan.
 *
 * These are **counts, not pixels**. The vectors reader's output is a classification
 * of named objects, so "15 walls, 6 windows, 5 doors" is the claim worth pinning —
 * a pixel golden would fail on an anti-aliasing change and say nothing about whether
 * the doors were still doors. `wall-detect.golden.spec.ts` covers the pixel reader,
 * which has no such intermediate language and can only be pinned by its mask.
 *
 * The plans are the ones this project ships, and between them they cover the three
 * routes the classifier takes: names (`apartment`, `office`), paint alone
 * (`little-white-house`), and a raster, where the vector reader must decline and let
 * the pixel one run (`apartment.png`).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { savedMask } from './helpers';

/**
 * Two transformations that real exports produce, and that used to change the mask while
 * leaving the sidebar report looking right — the worst shape a detector bug can take.
 *
 * - **No `viewBox`** (an export carrying only `width`/`height`). The role renders set
 *   `width`/`height` on their copy, and without a `viewBox` that resizes the canvas but
 *   not the drawing: everything rasterised at its own user units into the corner. The
 *   sample came back with 9,415 wall pixels against 31,580.
 * - **Geometry behind `<use>`.** The referenced nodes live in `<defs>`, which the
 *   classifier skips, so the walls vanish from the mask — 2 walls instead of 15 — while
 *   the mask stayed large enough that nothing fell back to the pixel reader.
 *
 * Both are asserted against the same file read unmodified, so the claim is "identical",
 * not "close".
 */
test.describe('svg shapes real exports produce', () => {
	const sample = readFileSync('static/samples/apartment-48sqm.svg', 'utf8');

	/** The sample with its viewBox removed. */
	const withoutViewBox = (svg: string): string => svg.replace(/\s*viewBox="[^"]+"/, '');

	/** The sample with every wall line moved into `<defs>` and referenced by `<use>`. */
	const wallsBehindUse = (svg: string): string => {
		const wallPattern = /<line[^>]*class="(?:wall|iwall)"[^>]*\/>/g;
		const walls = svg.match(wallPattern) ?? [];
		return svg
			.replace(wallPattern, '')
			.replace(
				'</svg>',
				`<defs><g id="walls">${walls.join('')}</g></defs><use href="#walls"/></svg>`
			);
	};

	test('a missing viewBox and <use> geometry read exactly like the plain file', async ({
		page
	}) => {
		test.setTimeout(300_000);

		await page.addInitScript(() => {
			localStorage.setItem('aetherax:welcomed', '1');
			localStorage.removeItem('aetherax:project');
		});

		mkdirSync('test-results/fixtures', { recursive: true });
		const variants = [
			['plain', sample],
			['no-viewbox', withoutViewBox(sample)],
			['walls-behind-use', wallsBehindUse(sample)]
		] as const;

		const readings: Array<{ label: string; report: string | null; wallPixels: number }> = [];

		for (const [label, text] of variants) {
			const file = `test-results/fixtures/${label}.svg`;
			writeFileSync(file, text);

			await page.goto('/');
			await page.waitForSelector('canvas');
			await page.waitForTimeout(400);
			await page.locator('input[type="file"][accept*=".svg"]').setInputFiles(file);
			await expect.poll(() => savedMask(page), { timeout: 120_000 }).not.toBe('');
			await page.waitForTimeout(1500);

			readings.push(
				await page.evaluate(async () => {
					const floor = JSON.parse(localStorage.getItem('aetherax:project')!).floors[0];
					const report =
						document.querySelector('.review')?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
					const mask = floor.wallMask as { dataUrl: string; width: number; height: number };
					const img = await new Promise<HTMLImageElement>((resolve, reject) => {
						const i = new Image();
						i.onload = () => resolve(i);
						i.onerror = () => reject(new Error('mask did not decode'));
						i.src = mask.dataUrl;
					});
					const canvas = document.createElement('canvas');
					canvas.width = mask.width;
					canvas.height = mask.height;
					const ctx = canvas.getContext('2d')!;
					ctx.drawImage(img, 0, 0);
					const data = ctx.getImageData(0, 0, mask.width, mask.height).data;
					let on = 0;
					for (let i = 0; i < mask.width * mask.height; i++) if (data[i * 4]! > 128) on++;
					return { label: '', report, wallPixels: on };
				})
			);
			readings[readings.length - 1]!.label = label;
		}

		const plain = readings[0]!;
		// The plain file must still read as the shipped plan does, or the comparison below
		// would be pinning a regression as the baseline.
		expect(plain.report).toContain('15 walls');
		expect(plain.wallPixels).toBeGreaterThan(1000);

		for (const reading of readings.slice(1)) {
			expect(reading.report, `${reading.label}: same classification`).toBe(plain.report);
			expect(reading.wallPixels, `${reading.label}: same mask`).toBe(plain.wallPixels);
		}
	});
});

interface Expectation {
	file: string;
	/** Read from the sidebar report. Null when the pixel reader ran instead. */
	vector: { walls: number; windows: number; doors: number; ignored: number } | null;
	/** Material ids that must be present in the material mask, if there is one. */
	materials: number[];
	/** Bounds for the wall mask's share of the image, in percent. */
	wallShare: [number, number];
}

const PLANS: Expectation[] = [
	{
		file: 'apartment-48sqm.svg',
		// The shipped demo plan names every element, so this is the exact answer.
		vector: { walls: 15, windows: 6, doors: 5, ignored: 6 },
		materials: [2, 7],
		wallShare: [3, 12]
	},
	{
		file: 'office-300sqm.svg',
		// Names again, plus 11 desks that must not become barriers.
		vector: { walls: 29, windows: 9, doors: 8, ignored: 21 },
		materials: [2, 7],
		wallShare: [3, 12]
	},
	{
		file: 'little-white-house.svg',
		// No names at all: one stroke carries the wall network, one filled block is
		// poché, the 75 remaining fills are rooms and labels, and no window or door is
		// drawn as such.
		vector: { walls: 2, windows: 0, doors: 0, ignored: 75 },
		materials: [],
		wallShare: [2, 12]
	},
	{
		file: 'state-floor.svg',
		// The poché case: no names, and the walls are ~56 filled blocks rather than
		// lines, of which the dark blocky ones are recovered. Before that rule this plan
		// reported 4 walls — the perimeter and the portico — with every interior
		// partition missing, which under-reports coverage twice over.
		vector: { walls: 22, windows: 0, doors: 0, ignored: 54 },
		// No door and therefore no material map: the element this plan used to report as a
		// door is a **closed** 424-unit outline — the arched portico — and a swing arc
		// spans an opening, so its ends cannot meet. Before the arc rule this file had one
		// door, which put 5 dB of "door" across a piece of the building's own outline.
		materials: [],
		// This plan is the only shipped one with **no `viewBox`** — `width="550"
		// height="360"` and nothing else — and it is the case that proved the content-box
		// rule. The mask used to come back 800x524 with the drawing at its own user units
		// in the top-left corner, 550x360 of it, which is 69 % of the canvas and **31 %
		// out of alignment** with the underlay the app draws at 800 world units wide. The
		// share was 6.4 % because the drawing only covered half the canvas, not because
		// there was half as much wall. It is 13.4 % now that the mask fills the canvas the
		// way the plan does.
		wallShare: [8, 20]
	},
	{
		file: 'apartment-48sqm.png',
		// A raster: the vector reader has nothing to read, falls through to pixels, and
		// the report stays empty rather than describing a detection that did not happen.
		vector: null,
		materials: [],
		wallShare: [1, 10]
	}
];

test.describe('vector detection', () => {
	for (const plan of PLANS) {
		test(`${plan.file}`, async ({ page }) => {
			test.setTimeout(180_000);

			await page.addInitScript(() => {
				localStorage.setItem('aetherax:welcomed', '1');
				localStorage.removeItem('aetherax:project');
			});
			await page.goto('/');
			await page.waitForSelector('canvas');
			await page.waitForTimeout(500);

			const started = Date.now();
			await page
				.locator('input[type="file"][accept*=".svg"]')
				.setInputFiles(`static/samples/${plan.file}`);
			await expect
				.poll(
					() =>
						page.evaluate(() => {
							const raw = localStorage.getItem('aetherax:project');
							if (!raw) return false;
							return !!JSON.parse(raw).floors?.[0]?.wallMask;
						}),
					{ timeout: 150_000 }
				)
				.toBe(true);
			// The masks and the report are written in the same tick; give the save a beat.
			await page.waitForTimeout(1500);
			void started;

			const result = await page.evaluate(async () => {
				const floor = JSON.parse(localStorage.getItem('aetherax:project')!).floors[0];
				const reportText =
					document.querySelector('.review')?.textContent?.replace(/\s+/g, ' ') ?? null;

				const pixels = async (mask: { dataUrl: string; width: number; height: number } | null) => {
					if (!mask) return null;
					const img = await new Promise<HTMLImageElement>((resolve, reject) => {
						const i = new Image();
						i.onload = () => resolve(i);
						i.onerror = () => reject(new Error('mask did not decode'));
						i.src = mask.dataUrl;
					});
					const canvas = document.createElement('canvas');
					canvas.width = mask.width;
					canvas.height = mask.height;
					const ctx = canvas.getContext('2d')!;
					ctx.drawImage(img, 0, 0);
					const data = ctx.getImageData(0, 0, mask.width, mask.height).data;
					let on = 0;
					const ids = new Set<number>();
					for (let i = 0; i < mask.width * mask.height; i++) {
						ids.add(data[i * 4]!);
						if (data[i * 4]! > 128) on++;
					}
					return { share: (on / (mask.width * mask.height)) * 100, ids: [...ids] };
				};

				return {
					wall: await pixels(floor.wallMask),
					material: await pixels(floor.materialMask),
					reportText
				};
			});

			expect(result.wall).not.toBeNull();
			expect(result.wall!.share).toBeGreaterThanOrEqual(plan.wallShare[0]);
			expect(result.wall!.share).toBeLessThanOrEqual(plan.wallShare[1]);

			if (plan.vector === null) {
				// The fallback must be silent about vectors, not report a stale count.
				expect(result.reportText).toBeNull();
				expect(result.material).toBeNull();
				return;
			}

			expect(result.reportText, 'the sidebar should report what was read').not.toBeNull();
			expect(result.reportText).toContain(
				`${plan.vector.walls} walls · ${plan.vector.windows} windows · ${plan.vector.doors} doors`
			);
			expect(result.reportText).toContain(`${plan.vector.ignored} fixtures and labels left out`);

			if (plan.materials.length === 0) {
				// Nothing but walls: no material map, rather than one that says "default"
				// everywhere and hides a hand-painted map under it.
				expect(result.material).toBeNull();
			} else {
				expect(result.material, 'a plan with openings needs a material mask').not.toBeNull();
				for (const id of plan.materials) {
					expect(result.material!.ids, `material ${id} missing`).toContain(id);
				}
			}
		});
	}
});

/**
 * The review panel, which is the answer to "the classifier is sometimes confidently
 * wrong".
 *
 * Three states are worth pinning, because they are three different code paths through
 * `detectVectorFloorplan` and only one of them is the initial read:
 *
 * - an opening told it is **not a barrier** must leave the mask entirely,
 * - the same element told it **is a wall** must stay in the mask but lose its material,
 * - **reset** must land back on the original mask byte for byte, or the panel is a
 *   one-way door and nobody will touch it twice.
 */
test.describe('vector detection review', () => {
	/**
	 * How long to wait for a mask the panel rewrote.
	 *
	 * Generous on purpose. `scheduleSave` is debounced by seconds, so an override lands in
	 * storage noticeably later than the click — measured between 1.5 s and 4.5 s on an idle
	 * machine, and past Playwright's 5 s default poll when five specs run at once. A
	 * too-tight poll here does not look like a timeout: it reports the *previous* mask as
	 * the received value, which reads as "reset does not restore the original".
	 */
	const SAVE_TIMEOUT_MS = 30_000;

	test('an override re-reads the drawing, and reset undoes it exactly', async ({ page }) => {
		test.setTimeout(180_000);

		await page.addInitScript(() => {
			localStorage.setItem('aetherax:welcomed', '1');
			localStorage.removeItem('aetherax:project');
		});
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.waitForTimeout(500);
		await page
			.locator('input[type="file"][accept*=".svg"]')
			.setInputFiles('static/samples/apartment-48sqm.svg');
		await expect.poll(() => savedMask(page), { timeout: 150_000 }).not.toBe('');

		/** Wall pixels, and the pixel count of each material id. */
		const measure = () =>
			page.evaluate(async () => {
				const floor = JSON.parse(localStorage.getItem('aetherax:project')!).floors[0];
				const count = async (mask: { dataUrl: string; width: number; height: number } | null) => {
					if (!mask) return { wall: 0, ids: {} as Record<number, number> };
					const img = await new Promise<HTMLImageElement>((resolve, reject) => {
						const i = new Image();
						i.onload = () => resolve(i);
						i.onerror = () => reject(new Error('mask did not decode'));
						i.src = mask.dataUrl;
					});
					const canvas = document.createElement('canvas');
					canvas.width = mask.width;
					canvas.height = mask.height;
					const ctx = canvas.getContext('2d')!;
					ctx.drawImage(img, 0, 0);
					const data = ctx.getImageData(0, 0, mask.width, mask.height).data;
					let wall = 0;
					const ids: Record<number, number> = {};
					for (let i = 0; i < mask.width * mask.height; i++) {
						if (data[i * 4]! > 128) wall++;
						ids[data[i * 4]!] = (ids[data[i * 4]!] ?? 0) + 1;
					}
					return { wall, ids };
				};
				const wall = await count(floor.wallMask);
				const material = await count(floor.materialMask);
				return {
					wallPixels: wall.wall,
					doorPixels: material.ids[7] ?? 0,
					glassPixels: material.ids[2] ?? 0,
					rows: document.querySelectorAll('.review .row').length,
					mask: floor.wallMask.dataUrl as string
				};
			});

		const initial = await measure();
		expect(initial.doorPixels, 'the demo plan should have doors to review').toBeGreaterThan(0);
		expect(initial.rows, 'doors and windows should be listed').toBeGreaterThan(0);

		// The panel waits on the saved mask changing; so does this.
		const row = page.locator('.review .row').first();
		await row.getByRole('button', { name: 'Not a barrier' }).click();
		await expect.poll(() => savedMask(page), { timeout: SAVE_TIMEOUT_MS }).not.toBe(initial.mask);

		const removed = await measure();
		expect(removed.wallPixels, 'a barrier removed must leave the mask').toBeLessThan(
			initial.wallPixels
		);
		expect(removed.doorPixels).toBeLessThan(initial.doorPixels);
		expect(removed.rows, 'the row leaves the list once it is no longer an opening').toBe(
			initial.rows - 1
		);

		// The same element, now called a wall: back in the mask, without its material.
		// Again, wait on the saved mask — the panel's re-read and `scheduleSave`'s
		// debounce both sit between the click and the numbers below.
		const beforeWall = await savedMask(page);
		await page.locator('.review .row').first().getByRole('button', { name: 'Wall' }).click();
		await expect.poll(() => savedMask(page), { timeout: SAVE_TIMEOUT_MS }).not.toBe(beforeWall);
		const asWall = await measure();
		expect(asWall.doorPixels, 'a wall is not a door').toBeLessThan(initial.doorPixels);
		expect(asWall.wallPixels).toBeGreaterThan(removed.wallPixels);

		await page.locator('.review-head').getByRole('button', { name: 'Reset' }).click();
		await expect.poll(() => savedMask(page), { timeout: SAVE_TIMEOUT_MS }).toBe(initial.mask);
		const reset = await measure();
		expect(reset.doorPixels).toBe(initial.doorPixels);
		expect(reset.rows).toBe(initial.rows);
	});

	/**
	 * Pointing at a row has to show *where* that element is.
	 *
	 * Without it the panel is a list of names — `path3603`, `thin curved line` — and a
	 * user cannot check any of them against the drawing, which is the entire reason the
	 * panel exists. Asserted as a canvas pixel difference rather than a golden image: the
	 * claim is "something was drawn, and it went away again", not "the highlight is this
	 * particular orange", and a golden here would fail on every palette change.
	 */
	test('pointing at a row draws the element on the canvas', async ({ page }) => {
		test.setTimeout(180_000);

		await page.addInitScript(() => {
			localStorage.setItem('aetherax:welcomed', '1');
			localStorage.removeItem('aetherax:project');
		});
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.waitForTimeout(500);
		await page
			.locator('input[type="file"][accept*=".svg"]')
			.setInputFiles('static/samples/office-300sqm.svg');
		await expect.poll(() => savedMask(page), { timeout: 150_000 }).not.toBe('');

		const canvas = page.locator('canvas').first();
		// A corner of the window that is neither the canvas nor the panel, so the only
		// thing that can change the canvas is the highlight.
		await page.mouse.move(0, 0);
		await page.waitForTimeout(300);
		const plain = await canvas.screenshot();

		await page.locator('.review .row').first().hover();
		await expect
			.poll(async () => Buffer.compare(plain, await canvas.screenshot()) !== 0, {
				message: 'hovering a row should draw its box on the plan'
			})
			.toBe(true);

		await page.mouse.move(0, 0);
		await expect
			.poll(async () => Buffer.compare(plain, await canvas.screenshot()) === 0, {
				message: 'the highlight should clear when the pointer leaves'
			})
			.toBe(true);
	});
});
