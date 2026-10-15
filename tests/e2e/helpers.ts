import { expect, type Page } from '@playwright/test';

/** Dismiss welcome dialog and clear saved state for a clean test */
export async function setupCleanState(page: Page): Promise<void> {
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');
	});
}

/**
 * Pixels in the *saved* wall mask of one floor, or 0 when that floor has none.
 *
 * The saved PNG is the thing that survives the session, so reading it back is the
 * only way to assert on a mask without reaching into app internals.
 *
 * The floor is indexed, not searched: with more than one walled floor, "the first
 * one that has a mask" answers about a floor the test never touched, which is
 * exactly the assertion that then passes for free.
 */
export async function savedWallPixels(page: Page, floorIndex = 0): Promise<number> {
	return page.evaluate(async (index: number) => {
		const raw = localStorage.getItem('aetherax:project');
		if (!raw) return 0;
		const floors =
			(
				JSON.parse(raw) as {
					floors?: Array<{
						wallMask?: { dataUrl: string; width: number; height: number } | null;
					}>;
				}
			).floors ?? [];
		const mask = floors[index]?.wallMask;
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
	}, floorIndex);
}

/**
 * How long a spec that loads a sample plan needs.
 *
 * Detecting walls on the 48 sqm apartment is ~5 s of tesseract on an idle machine,
 * and several such specs starting at once multiply that: every worker runs its own
 * OCR, so the wall clock of each one stretches with the number of workers. The
 * 30 s default was sized for neither, which is why these files failed in a full
 * parallel run while passing one at a time. CI avoids the pile-up by running a
 * single worker; locally the timeout has to absorb it instead.
 *
 * One budget, used for both the test and the wait inside it. They were two — a
 * 90 s test whose wall poll gave up at its own 30 s default — and the poll then
 * failed the test with "no walls" while the test still had a minute left, which
 * looks exactly like a wall-detection bug and is not one.
 */
export const SAMPLE_PLAN_TIMEOUT_MS = 120_000;

/** The share of that budget a wall-detection wait may spend. */
const SAMPLE_PLAN_WAIT_MS = SAMPLE_PLAN_TIMEOUT_MS - 15_000;

/**
 * Wait until a floor's detected walls are in the saved project.
 *
 * Wall detection runs OCR, so the specs that load a sample plan used to wait a
 * flat `waitForTimeout(6000)`. That is not a wait for anything: under load the
 * detection finishes later and the spec fails somewhere unrelated, with the button
 * it wanted missing or a mask that "has no walls". Both of this suite's
 * long-standing flakes were that shape. Polling the saved mask is the condition
 * those specs actually depend on.
 */
export async function waitForDetectedWalls(
	page: Page,
	floorIndex = 0,
	timeout = SAMPLE_PLAN_WAIT_MS
): Promise<void> {
	await expect.poll(() => savedWallPixels(page, floorIndex), { timeout }).toBeGreaterThan(1000);
}

/**
 * Turn on placement mode, so a canvas click creates an access point.
 *
 * Placing an AP is a mode and it is **off** by default: with it always on, every
 * stray click — deselecting, starting a marquee, fumbling a pan — left an AP on
 * the plan. Specs that place APs by clicking therefore have to ask for the mode
 * first; before it existed, the click was enough on its own.
 *
 * The toggle is pinned above the sidebar's panel content, so it is reachable from
 * either tab, and the mode survives tab and floor changes — one call per test is
 * enough.
 */
export async function enablePlaceMode(page: Page): Promise<void> {
	const sidebarVisible = await page
		.locator('aside[aria-label="Sidebar"]')
		.isVisible({ timeout: 200 })
		.catch(() => false);
	if (!sidebarVisible) {
		await page.locator('button[aria-label="Toggle sidebar"]').click();
		await page.waitForTimeout(500);
	}
	const toggle = page.getByRole('button', { name: /Place APs/ });
	await toggle.waitFor({ state: 'visible', timeout: 3000 });
	if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
	await toggle.page().waitForTimeout(150);
}

/**
 * Seed a project whose access points are already placed.
 *
 * For specs that need APs on the canvas but are not about placing them — the
 * screenshot audits, and anything running on a phone viewport where the placement
 * toggle sits behind the sidebar. Call it after `setupCleanState` and before
 * `goto`, so it wins over the project removal that helper installs.
 */
export async function seedAps(
	page: Page,
	points: Array<{ x: number; y: number }>
): Promise<void> {
	await page.addInitScript((pts: Array<{ x: number; y: number }>) => {
		localStorage.setItem('aetherax:welcomed', '1');
		const floorId = 'f1';
		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Audit',
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
						calibration: null,
						floorplanBoundary: null,
						wallMask: null,
						wallAttenuation: 5,
						wallMaterial: 0,
						materialMask: null,
						roomTypeMask: null,
						roomDensityOverrides: {},
						roomCustomLabels: {}
					}
				],
				aps: pts.map((p, i) => ({
					id: `ap${i + 1}`,
					name: `AP-${i + 1}`,
					x: p.x,
					y: p.y,
					floorId,
					band: '5ghz',
					channelWidth: 20,
					fixedChannel: null,
					assignedChannel: null,
					interferenceRadius: 988,
					power: 20,
					modelId: null,
					modelLabel: null
				}))
			})
		);
	}, points);
}
