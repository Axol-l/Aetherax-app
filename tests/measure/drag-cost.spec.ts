/**
 * What a drag costs, and where.
 *
 * This is the instrument for "the canvas feels janky" reports, and it exists because four
 * earlier attempts measured the wrong thing and the mistakes are worth not repeating:
 *
 * - per-layer \`render\` cost alone said 0.15 ms per frame, which cannot explain a stutter;
 * - stepping the pointer with \`page.mouse.move\` and a sleep between steps reported a
 *   flawless 16.7 ms everywhere, because the browser is idle between round trips — a real
 *   drag delivers its events in the same frame as the render that follows them;
 * - measuring the stacked view right after switching to it caught a heatmap still
 *   generating behind the measurement, not the view;
 * - and comparing two separate sessions is unreliable on this machine, which drifted
 *   between 16.7 ms and 83 ms for the same code.
 *
 * So: the pointer burst is dispatched **inside the page**, in step with animation frames;
 * the CPU is throttled with CDP so the per-frame cost is visible at all; and every figure
 * is reported for more than one view, because they differ by an order of magnitude.
 *
 * Opt-in with \`MEASURE_DRAG=1\`. It is a measurement, not a gate.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupCleanState } from '../e2e/helpers';

const MEASURE =
	(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
		?.MEASURE_DRAG === '1';

/** A burst of pointer events per animation frame, with the frame interval recorded. */
async function burst(
	page: Page,
	from: { x: number; y: number },
	dx: number,
	dy: number,
	frames = 60,
	perFrame = 4
): Promise<string> {
	return page.evaluate(
		async (o) => {
			const canvas = document.querySelector('canvas')!;
			const rect = canvas.getBoundingClientRect();
			const gaps: number[] = [];
			const fire = (type: string, x: number, y: number) =>
				canvas.dispatchEvent(
					new PointerEvent(type, {
						pointerId: 1,
						pointerType: 'mouse',
						isPrimary: true,
						buttons: type === 'pointerup' ? 0 : 1,
						button: 0,
						clientX: rect.left + x,
						clientY: rect.top + y,
						bubbles: true,
						cancelable: true
					})
				);
			fire('pointerdown', o.from.x, o.from.y);
			let last = performance.now();
			for (let f = 0; f < o.frames; f++) {
				const now = await new Promise<number>((r) => requestAnimationFrame(r));
				gaps.push(now - last);
				last = now;
				for (let k = 0; k < o.perFrame; k++) {
					const p = (f + k / o.perFrame) / o.frames;
					fire('pointermove', o.from.x + o.dx * p, o.from.y + o.dy * p);
				}
			}
			fire('pointerup', o.from.x + o.dx, o.from.y + o.dy);
			const sorted = [...gaps].sort((a, b) => a - b);
			const q = (f: number) =>
				sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] ?? 0;
			return (
				'median=' +
				q(0.5).toFixed(1) +
				' p95=' +
				q(0.95).toFixed(1) +
				' max=' +
				(sorted[sorted.length - 1] ?? 0).toFixed(1) +
				' >25ms=' +
				gaps.filter((g) => g > 25).length +
				'/' +
				gaps.length
			);
		},
		{ from, dx, dy, frames, perFrame }
	);
}

/** Three similar floors, so the stacked overview is offered. */
async function seedThreeFloors(page: Page): Promise<void> {
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');
		const floors = [0, 1, 2].map((level) => {
			const c = document.createElement('canvas');
			c.width = 900;
			c.height = 600;
			const ctx = c.getContext('2d')!;
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, 900, 600);
			ctx.fillStyle = '#000000';
			ctx.fillRect(0, 0, 900, 10);
			ctx.fillRect(0, 590, 900, 10);
			ctx.fillRect(0, 0, 10, 600);
			ctx.fillRect(890, 0, 10, 600);
			for (let x = 120; x < 880; x += 120) ctx.fillRect(x, 10, 8, 580);
			for (let y = 120; y < 580; y += 120) ctx.fillRect(10, y, 880, 8);
			return {
				id: 'f' + (level + 1),
				name: 'Floor ' + (level + 1),
				level,
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
					width: 900,
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
			};
		});
		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Drag cost',
				band: '5ghz',
				channelWidth: 20,
				regulatoryDomain: 'fcc',
				unitSystem: 'metric',
				ispSpeed: 0,
				targetThroughput: 25,
				allowOutsideRooms: false,
				clientHeight: 1.5,
				heatmapRssiFloor: -70,
				floors,
				aps: floors.map((f, i) => ({
					id: 'ap' + (i + 1),
					name: 'AP-' + (i + 1),
					x: 200 + i * 200,
					y: 300,
					floorId: f.id,
					band: '5ghz',
					channelWidth: 20,
					fixedChannel: null,
					assignedChannel: null,
					interferenceRadius: 900,
					power: 20,
					modelId: null,
					modelLabel: null
				}))
			})
		);
	});
}

test.describe('drag cost', () => {
	test.skip(!MEASURE, 'set MEASURE_DRAG=1 to run the measurement');
	test.setTimeout(600_000);

	test('frame pacing per view, unthrottled and at 10x', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await setupCleanState(page);
		await seedThreeFloors(page);
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.waitForTimeout(8000);

		const box = (await page.locator('canvas').first().boundingBox())!;
		const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

		console.log('PACE single           ' + (await burst(page, c, 200, 120)));

		await page
			.getByTitle(/Stack every floor/i)
			.first()
			.click();
		await page.waitForTimeout(3000);
		console.log('PACE stacked          ' + (await burst(page, c, 200, 120)));

		await page
			.getByTitle(/Tile every floor/i)
			.first()
			.click();
		await page.waitForTimeout(3000);
		console.log('PACE tiled            ' + (await burst(page, c, 200, 120)));

		// Now with the CPU throttled, which is what makes the per-frame cost visible: the
		// stock engine holds 60 fps unthrottled on this machine either way.
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 10 });
		await page.waitForTimeout(4000);
		console.log('PACE tiled, 10x       ' + (await burst(page, c, 200, 120)));

		await page
			.getByTitle(/Stack every floor/i)
			.first()
			.click();
		await page.waitForTimeout(3000);
		console.log('PACE stacked, 10x     ' + (await burst(page, c, 200, 120)));

		await page
			.getByTitle(/Show the current floor only/i)
			.first()
			.click();
		await page.waitForTimeout(3000);
		console.log('PACE single, 10x      ' + (await burst(page, c, 200, 120)));

		expect(true).toBe(true);
	});
});
