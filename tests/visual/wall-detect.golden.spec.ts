/**
 * Golden-image regression for the **pixel** wall detector.
 *
 * `wall-detect.ts` has no unit tests and cannot have them: it needs a real canvas
 * and, for rasters, a real OCR worker, neither of which exists in the vitest
 * (node) environment this project runs. The e2e suite asserts only that walls
 * appear at all, which is not enough to protect a chain of heuristics whose every
 * stage — OCR masking, adaptive threshold, blob filtering, exterior flood fill —
 * moves together when one threshold changes.
 *
 * So each plan the project ships is pinned by its **output mask**. Every pixel of
 * it, plus a few invariants that hold whatever a future threshold does.
 *
 * **This pins the pixel detector, not the import flow.** Since the vector reader
 * landed, an SVG import goes through `vector-elements.ts` instead, and the only way
 * to reach this detector on a vector plan is the sidebar's escape hatch — which is
 * what these tests press. Deliberate: the escape hatch is a feature ("this plan was
 * read wrongly, draw every drawn line instead") and this is the only test covering
 * it, while `vector-detect.spec.ts` pins the reader used by default.
 *
 * On the two real-world exports (`state-floor.svg`, `little-white-house.svg`), read
 * the pinned mask as "the alpha bug is fixed and here is where the pixel path
 * stands", not as "this is correct": the rasteriser still over-reports a thick
 * filled poché and traces room-fill boundaries. Their *default* result now comes
 * from the vector reader; these goldens are what a fallback produces.
 *
 * Regenerate with `UPDATE_GOLDEN=1` and **look at the diff images**. Updating a
 * golden without looking is how a regression gets committed as the baseline.
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { savedMask } from './helpers';

/** Relative to the Playwright config's directory (`apps/web`). */
const GOLDEN_DIR = 'tests/visual/golden';
const UPDATE = process.env.UPDATE_GOLDEN === '1';

interface Plan {
	file: string;
	/** Why this plan is in the set. */
	why: string;
	/**
	 * Bounds the covered share of the image must sit inside, in percent.
	 *
	 * Wide on purpose: these catch a mask that has collapsed to nothing or blown
	 * up to the whole image — the two failure modes a wall detector actually has —
	 * without failing on a legitimate threshold refinement.
	 */
	wallShare: [number, number];
	/** OCR runs on rasters, not on vector input. See `runBoundaryDetection`. */
	expectOcr: boolean;
}

const PLANS: Plan[] = [
	{
		file: 'apartment-48sqm.svg',
		why: 'the shipped demo plan: semantic SVG, thin walls and door/window gaps',
		wallShare: [3, 12],
		expectOcr: false
	},
	{
		file: 'house-120sqm.svg',
		why: 'the same authoring style at a larger footprint, 12 windows',
		wallShare: [3, 12],
		expectOcr: false
	},
	{
		file: 'office-300sqm.svg',
		why: 'the same authoring style with glass, desks and 8 doors',
		wallShare: [4, 14],
		expectOcr: false
	},
	{
		file: 'apartment-48sqm.png',
		why: 'the same plan as a raster: the only case that needs OCR',
		wallShare: [2, 10],
		expectOcr: true
	},
	{
		file: 'state-floor.svg',
		why: 'Inkscape export, no classes, thick filled poché — the alpha-bug case',
		wallShare: [8, 26],
		expectOcr: false
	},
	{
		file: 'little-white-house.svg',
		why: 'Illustrator export, no classes, labels as outlines — the alpha-bug case',
		wallShare: [4, 16],
		expectOcr: false
	}
];

/** Per-plan budget: a raster import pays a tesseract worker start-up. */
const PLAN_TIMEOUT_MS = 120_000;

test.describe('wall detection is pinned per plan', () => {
	test.describe.configure({ timeout: PLAN_TIMEOUT_MS });

	for (const plan of PLANS) {
		test(`${plan.file} — ${plan.why}`, async ({ page }) => {
			await page.addInitScript(() => {
				localStorage.setItem('aetherax:welcomed', '1');
				localStorage.removeItem('aetherax:project');
			});
			await page.goto('/');
			await page.waitForSelector('canvas');
			await page.waitForTimeout(500);

			await page
				.locator('input[type="file"][accept*=".svg"]')
				.setInputFiles(`static/samples/${plan.file}`);

			// Detection is asynchronous and the app writes it through `scheduleSave`.
			await expect.poll(() => detected(page), { timeout: PLAN_TIMEOUT_MS - 15_000 }).toBe(true);

			// A vector plan was read by the object classifier first. Press the escape
			// hatch so this test measures the detector it is named after.
			//
			// Wait on the **saved** mask changing, not on the report disappearing: the
			// report is cleared the instant the button is pressed, while the new mask
			// reaches storage through `scheduleSave`'s debounce seconds later. Polling
			// the wrong one of those read the vector mask and failed against a raster
			// golden by IoU 0.83 — a mismatch that looks like a detector regression and
			// is a race in the test.
			const escape = page.locator('[data-action="raster-detect"]');
			if (await escape.isVisible().catch(() => false)) {
				const before = await savedMask(page);
				await escape.click();
				await expect
					.poll(() => savedMask(page), { timeout: PLAN_TIMEOUT_MS - 15_000 })
					.not.toBe(before);
				await expect.poll(() => page.locator('.review').count()).toBe(0);
			}

			// Let the last write settle before reading the mask back.
			await page.waitForTimeout(1500);

			const result = await page.evaluate(() => {
				const floor = JSON.parse(localStorage.getItem('aetherax:project')!).floors[0];
				const mask = floor.wallMask as {
					dataUrl: string;
					width: number;
					height: number;
				} | null;
				return {
					mask,
					boundaryPoints: (floor.floorplanBoundary as unknown[] | null)?.length ?? 0
				};
			});

			expect(result.mask, 'no wall mask was produced').not.toBeNull();
			const mask = result.mask!;

			// The mask as black/white pixels, plus the covered share, measured in the
			// page because Node cannot decode a PNG here.
			const stats = await page.evaluate(
				async ({ dataUrl, width, height }) => {
					const img = await new Promise<HTMLImageElement>((resolve, reject) => {
						const i = new Image();
						i.onload = () => resolve(i);
						i.onerror = () => reject(new Error('mask did not decode'));
						i.src = dataUrl;
					});
					const canvas = document.createElement('canvas');
					canvas.width = width;
					canvas.height = height;
					const ctx = canvas.getContext('2d')!;
					ctx.drawImage(img, 0, 0);
					const data = ctx.getImageData(0, 0, width, height).data;

					let on = 0;
					const bits = new Uint8Array(width * height);
					for (let i = 0; i < bits.length; i++) {
						const isWall = data[i * 4]! > 128;
						bits[i] = isWall ? 1 : 0;
						if (isWall) on++;
					}

					// Re-encode as a hard black/white PNG so the golden is stable against
					// a renderer's anti-aliasing of the mask's own edges.
					const out = ctx.createImageData(width, height);
					for (let i = 0; i < bits.length; i++) {
						const v = bits[i] ? 255 : 0;
						out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
						out.data[i * 4 + 3] = 255;
					}
					ctx.putImageData(out, 0, 0);
					return {
						width,
						height,
						on,
						share: (on / bits.length) * 100,
						binary: Array.from(bits),
						png: canvas.toDataURL('image/png')
					};
				},
				{ dataUrl: mask.dataUrl, width: mask.width, height: mask.height }
			);

			// ── invariants: true whatever a later threshold does ──────────────
			expect(
				stats.share,
				`wall share ${stats.share.toFixed(1)}% is outside ${plan.wallShare.join('–')}%`
			).toBeGreaterThanOrEqual(plan.wallShare[0]);
			expect(stats.share).toBeLessThanOrEqual(plan.wallShare[1]);
			expect(stats.width).toBeGreaterThan(200);
			expect(result.boundaryPoints, 'no floorplan boundary was detected').toBeGreaterThanOrEqual(3);

			// ── the golden ───────────────────────────────────────────────────
			mkdirSync(GOLDEN_DIR, { recursive: true });
			const goldenPath = join(GOLDEN_DIR, `${plan.file}.png`);

			if (!existsSync(goldenPath)) {
				if (!UPDATE) {
					throw new Error(
						`no golden at ${goldenPath}. Run \`UPDATE_GOLDEN=1 pnpm test:visual\`, then ` +
							`look at the generated images before committing them.`
					);
				}
				writeFileSync(goldenPath, Buffer.from(stats.png.split(',')[1]!, 'base64'));
				test.info().annotations.push({ type: 'golden', description: `created ${goldenPath}` });
				return;
			}

			const goldenUrl = `data:image/png;base64,${readFileSync(goldenPath).toString('base64')}`;
			const diff = await page.evaluate(
				async ({ goldenUrl, bits, width, height }) => {
					const img = await new Promise<HTMLImageElement>((resolve, reject) => {
						const i = new Image();
						i.onload = () => resolve(i);
						i.onerror = () => reject(new Error('golden did not decode'));
						i.src = goldenUrl;
					});
					const canvas = document.createElement('canvas');
					canvas.width = width;
					canvas.height = height;
					const ctx = canvas.getContext('2d')!;
					ctx.drawImage(img, 0, 0, width, height);
					const data = ctx.getImageData(0, 0, width, height).data;

					let intersection = 0;
					let union = 0;
					let differing = 0;
					for (let i = 0; i < bits.length; i++) {
						const a = bits[i] === 1;
						const b = data[i * 4]! > 128;
						if (a && b) intersection++;
						if (a || b) union++;
						if (a !== b) differing++;
					}
					return {
						iou: union > 0 ? intersection / union : 1,
						differingShare: (differing / bits.length) * 100
					};
				},
				{ goldenUrl, bits: stats.binary, width: stats.width, height: stats.height }
			);

			if (UPDATE) {
				writeFileSync(goldenPath, Buffer.from(stats.png.split(',')[1]!, 'base64'));
				test.info().annotations.push({
					type: 'golden',
					description: `updated ${goldenPath} (was IoU ${diff.iou.toFixed(4)})`
				});
				return;
			}

			// 0.98 rather than 1: the mask is deterministic in one browser, but path
			// rasterisation and PNG re-encoding are not identical across platforms, so
			// the pin is "the same plan came out", not "the same bytes came out".
			expect(
				diff.iou,
				`mask differs from ${goldenPath} (IoU ${diff.iou.toFixed(4)}, ` +
					`${diff.differingShare.toFixed(2)} % of pixels). If the change is intended, ` +
					`regenerate with UPDATE_GOLDEN=1 and look at the images.`
			).toBeGreaterThan(0.98);
		});
	}
});

/** True once the saved project carries a non-empty wall mask. */
async function detected(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		if (!raw) return false;
		const mask = JSON.parse(raw).floors?.[0]?.wallMask;
		return !!mask && mask.width > 0;
	});
}
