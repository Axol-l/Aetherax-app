import { test, expect, type Page } from '@playwright/test';
import { setupCleanState } from './helpers';

/**
 * The stacked view has to leave the app as an image and a PDF.
 *
 * Both exporters re-render the engine's visible layers into an offscreen canvas
 * rather than snapshotting the screen, so whether the stack survives the trip is a
 * question about the stacked layer's own geometry: it lays out from its camera, not
 * from the viewport, which is what this checks.
 *
 * PNG dimensions are read out of the file's IHDR header and the stream is measured
 * rather than decoded: a blank 2x canvas compresses to a couple of kilobytes, a plan
 * with walls does not, and no image library is needed for either.
 */

/** Three floors, the minimum the stacked overview is offered for. */
async function seedThreeFloors(page: Page): Promise<void> {
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');
		const floors = [0, 1, 2].map((level) => {
			const c = document.createElement('canvas');
			c.width = 600;
			c.height = 400;
			const ctx = c.getContext('2d')!;
			// White is wall, transparent is passable — the same convention as `encodeMask`.
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, 600, 8);
			ctx.fillRect(0, 392, 600, 8);
			ctx.fillRect(0, 0, 8, 400);
			ctx.fillRect(592, 0, 8, 400);
			// An interior wall, so each storey has something to draw.
			ctx.fillRect(290, 8, 12, 250);
			return {
				id: `f${level + 1}`,
				name: `Floor ${level + 1}`,
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
					width: 600,
					height: 400,
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
				name: 'Stacked export',
				band: '5ghz',
				channelWidth: 20,
				regulatoryDomain: 'fcc',
				unitSystem: 'metric',
				ispSpeed: 0,
				targetThroughput: 25,
				allowOutsideRooms: false,
				clientHeight: 1.5,
				heatmapRssiFloor: -70,
				coverageSoftnessDb: 10,
				floors,
				aps: floors.map((f, i) => ({
					id: `ap${i + 1}`,
					name: `AP-${i + 1}`,
					x: 150 + i * 40,
					y: 200,
					floorId: f.id,
					band: '5ghz',
					channelWidth: 20,
					fixedChannel: null,
					assignedChannel: null,
					interferenceRadius: 300,
					power: 20,
					modelId: null,
					modelLabel: null
				}))
			})
		);
	});
}

interface PngStats {
	bytes: number;
	width: number;
	height: number;
}

/** Read a download's size and its IHDR dimensions, without an image library. */
async function readPng(download: {
	createReadStream: () => Promise<unknown>;
}): Promise<PngStats> {
	const stream = (await download.createReadStream()) as AsyncIterable<{ length: number }>;
	let bytes = 0;
	const head: number[] = [];
	for await (const chunk of stream) {
		bytes += chunk.length;
		if (head.length < 24) {
			for (const byte of chunk as unknown as Uint8Array) {
				if (head.length >= 24) break;
				head.push(byte);
			}
		}
	}
	const view = new DataView(new Uint8Array(head).buffer);
	return { bytes, width: view.getUint32(16), height: view.getUint32(20) };
}

test('the stacked view exports as an image', async ({ page }) => {
	test.setTimeout(120_000);
	await setupCleanState(page);
	await seedThreeFloors(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(3000);

	await page.locator('.view-btn[aria-label^="Stack every floor"]').click();
	await page.waitForTimeout(1500);

	// The exporter renders at 2x the *canvas* — which is the viewport minus the
	// chrome around it, not the browser window.
	const canvasSize = await page.evaluate(() => {
		const rect = document.querySelector('canvas')!.getBoundingClientRect();
		return { width: Math.round(rect.width), height: Math.round(rect.height) };
	});
	await page.getByRole('button', { name: 'File' }).click();
	const download = page.waitForEvent('download', { timeout: 20_000 });
	await page.getByText('Export as PNG', { exact: true }).click();
	const stats = await readPng(await download);

	// A single-floor render would be the same size but far emptier, which the byte count
	// catches: three storeys of walls do not fit in a couple of kilobytes.
	expect(stats.width).toBe(canvasSize.width * 2);
	expect(stats.height).toBe(canvasSize.height * 2);
	expect(stats.bytes).toBeGreaterThan(10_000);
	console.log(
		`[export] stacked PNG ${stats.width}x${stats.height} for a ${canvasSize.width}x${canvasSize.height} canvas, ${stats.bytes} bytes`
	);
});

test('the stacked view exports in the PDF report', async ({ page }) => {
	test.setTimeout(180_000);
	await setupCleanState(page);
	await seedThreeFloors(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(3000);

	await page.locator('.view-btn[aria-label^="Stack every floor"]').click();
	await page.waitForTimeout(1500);

	await page.getByRole('button', { name: 'File' }).click();
	const download = page.waitForEvent('download', { timeout: 60_000 });
	await page.getByText('Export as PDF', { exact: true }).click();
	const file = await download;
	const stream = (await file.createReadStream()) as AsyncIterable<{ length: number }>;
	let bytes = 0;
	const head: number[] = [];
	for await (const chunk of stream) {
		bytes += chunk.length;
		if (head.length < 5) {
			for (const byte of chunk as unknown as Uint8Array) {
				if (head.length >= 5) break;
				head.push(byte);
			}
		}
	}
	expect(String.fromCharCode(...head)).toBe('%PDF-');
	expect(bytes).toBeGreaterThan(20_000);
	console.log(`[export] PDF ${bytes} bytes`);
});
