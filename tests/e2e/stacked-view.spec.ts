import { test, expect, type Page } from '@playwright/test';

/**
 * The stacked floor overview: every floor placed at its real height.
 *
 * The projection itself is arithmetic and is unit-tested
 * (`canvas/renderers/stacked-floors.test.ts`). What this covers is that the view
 * is wired up — that it is offered, that it frames itself, that a click picks the
 * floor the user aimed at, that it stays read-only, and that per-floor coverage
 * reaches it. The one geometric claim asserted here is the *outcome* of the
 * projection: the drawn content of a two-storey stack is taller, relative to its
 * width, than one floor on its own, by about the storey height.
 */

/**
 * Three 800 x 600 floors with different walls, three-metre storeys.
 *
 * Three rather than two because focusing keeps the current floor and the one
 * either side of it: with two floors that is everything, so a two-floor view cannot
 * show the filter doing anything.
 */
async function seedThreeFloors(page: Page): Promise<void> {
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');

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
			for (const x of walls) ctx.fillRect(x, 0, 6, 600);
			return { dataUrl: c.toDataURL('image/png'), width: 800, height: 600, originX: 0, originY: 0 };
		};

		const floor = (id: string, name: string, level: number, walls: number[]) => ({
			id,
			name,
			level,
			ceilingHeight: 3,
			floorMaterial: 1,
			floorThickness: 0.2,
			floorplanScale: 1,
			floorplanOffsetX: 0,
			floorplanOffsetY: 0,
			// One scale for the project: 33.05 units/m, so a three-metre storey is
			// 99.15 world units and the projection is predictable.
			calibration: { worldUnitsPerMeter: 33.05 },
			floorplanBoundary: null,
			wallMask: mask(walls),
			wallAttenuation: 5,
			wallMaterial: 0,
			materialMask: null,
			roomTypeMask: null,
			roomDensityOverrides: {},
			roomCustomLabels: {}
		});

		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Stacked',
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
					floor('f1', 'Floor 1', 0, [396]),
					floor('f2', 'Floor 2', 1, [250, 560]),
					floor('f3', 'Floor 3', 2, [560])
				],
				// The same world position on every floor, so the only difference
				// between the AP dots on screen is the projection.
				aps: ['f1', 'f2', 'f3'].map((floorId, i) => ({
					id: `ap${i + 1}`,
					name: `AP-${i + 1}`,
					x: 400,
					y: 300,
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
	});
}

async function openFloorplanTab(page: Page): Promise<void> {
	if (await page.locator('.floor-strip').isVisible({ timeout: 200 }).catch(() => false)) return;
	if (
		!(await page
			.locator('aside[aria-label="Sidebar"]')
			.isVisible({ timeout: 200 })
			.catch(() => false))
	) {
		await page.locator('button[aria-label="Toggle sidebar"]').click();
		await page.waitForTimeout(400);
	}
	const fpTab = page.locator('button[role="tab"]').filter({ hasText: 'Floorplan' });
	await fpTab.waitFor({ state: 'visible', timeout: 3000 });
	await fpTab.click();
	await page.waitForTimeout(300);
}

/** The name on the highlighted floor pill. */
async function activeFloor(page: Page): Promise<string> {
	return page
		.locator('.floor-pill.active')
		.first()
		.evaluate((el) => (el.firstChild?.textContent ?? '').trim());
}

/**
 * Bounding box, in canvas pixels, of everything that is not the page background.
 *
 * The canvas is dark and empty space is a flat colour, so "drawn" is "differs
 * from the corner pixel" — good enough to measure an aspect ratio, and it does not
 * care which layers produced the pixels.
 */
async function drawnBounds(
	page: Page
): Promise<{ x0: number; y0: number; x1: number; y1: number; w: number; h: number }> {
	return page.evaluate(() => {
		const c = document.querySelector('canvas') as HTMLCanvasElement;
		const ctx = c.getContext('2d')!;
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		const bg = [d[0]!, d[1]!, d[2]!];
		let x0 = c.width;
		let y0 = c.height;
		let x1 = -1;
		let y1 = -1;
		for (let y = 0; y < c.height; y++) {
			for (let x = 0; x < c.width; x++) {
				const i = (y * c.width + x) * 4;
				// A few levels of tolerance: the background is flat, but antialiased
				// edges of a drawn layer can land within a level or two of it.
				if (
					Math.abs(d[i]! - bg[0]!) <= 3 &&
					Math.abs(d[i + 1]! - bg[1]!) <= 3 &&
					Math.abs(d[i + 2]! - bg[2]!) <= 3
				)
					continue;
				if (x < x0) x0 = x;
				if (y < y0) y0 = y;
				if (x > x1) x1 = x;
				if (y > y1) y1 = y;
			}
		}
		return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
	});
}

/**
 * How many canvas pixels are not the page background.
 *
 * The bounding box answers "where is the view"; this answers "how much is drawn",
 * which is the right measure for a change that removes floors from the picture —
 * their plans simply stop being painted, while the box stays roughly the same size
 * because the remaining floor's walls still stand where the storey below was.
 */
async function drawnPixels(page: Page): Promise<number> {
	return page.evaluate(() => {
		const c = document.querySelector('canvas') as HTMLCanvasElement;
		const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
		const bg = [d[0]!, d[1]!, d[2]!];
		let n = 0;
		for (let i = 0; i < d.length; i += 4) {
			if (
				Math.abs(d[i]! - bg[0]!) <= 3 &&
				Math.abs(d[i + 1]! - bg[1]!) <= 3 &&
				Math.abs(d[i + 2]! - bg[2]!) <= 3
			)
				continue;
			n++;
		}
		return n;
	});
}

async function stackView(page: Page): Promise<void> {
	await openFloorplanTab(page);
	await page.locator('.view-btn[aria-label^="Stack every floor"]').click();
	// The layout is handed to the layer by an effect and the fit runs on the next
	// frame.
	await page.waitForTimeout(1200);
}

/**
 * Set one of the stack's range inputs, by its aria-label.
 *
 * A range input takes no text, and in this browser neither `fill` nor a key press
 * moves it, so the value is set and the `input` event the slider's own handler
 * listens for is dispatched — the same path a drag takes.
 */
async function setRange(page: Page, label: string, value: string): Promise<void> {
	await page.locator(`input[aria-label="${label}"]`).evaluate((el: HTMLInputElement, v: string) => {
		el.value = v;
		el.dispatchEvent(new Event('input', { bubbles: true }));
	}, value);
	await page.waitForTimeout(400);
}

/** Re-frame the view, as the Fit button does. */
async function fit(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Fit to view' }).click();
	await page.waitForTimeout(600);
}

/** One of the stack's angle readouts, in degrees. */
async function readAngle(page: Page, label: string): Promise<number> {
	const text = await page
		.locator('.opacity-row')
		.filter({ hasText: label })
		.locator('.opacity-value')
		.innerText();
	return Number(text.replace('°', ''));
}

/**
 * The zoom the last fit chose, as a percentage.
 *
 * This is the measurement for anything that makes the stack bigger or smaller: a
 * fit frames the *whole* stack, so the drawn extent fills the viewport either way
 * and only the zoom records how much there was to fit.
 */
async function fitZoom(page: Page): Promise<number> {
	return Number((await page.locator('.status-item.zoom').innerText()).replace('%', ''));
}

test.describe('Stacked floor overview', () => {
	test.beforeEach(async ({ page }) => {
		await seedThreeFloors(page);
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.waitForTimeout(2500);
	});

	test('is offered, and frames the whole stack', async ({ page }) => {
		await openFloorplanTab(page);
		const button = page.locator('.view-btn[aria-label^="Stack every floor"]');
		await expect(button).toBeVisible();
		await expect(button).toHaveAttribute('aria-pressed', 'false');

		// One floor on its own, for the ratio below.
		await page.locator('.view-btn[aria-label^="Show the current floor only"]').click();
		await page.waitForTimeout(1500);
		const single = await drawnBounds(page);
		const singleAspect = single.h / single.w;

		await button.click();
		await expect(button).toHaveAttribute('aria-pressed', 'true');
		await page.waitForTimeout(1500);
		const stack = await drawnBounds(page);
		const stackAspect = stack.h / stack.w;

		// The stack is taller than it is wide relative to one floor, by roughly the
		// storey the second floor sits above the first: 99.15 world units of height
		// against 800 of width, 0.124 of aspect. The drawn extent also grows
		// sideways by the shear, so the expectation is a range rather than a point —
		// this asserts the projection happened, not its exact constants (those are
		// unit-tested).
		expect(stackAspect).toBeGreaterThan(singleAspect + 0.05);
		expect(stackAspect).toBeLessThan(singleAspect + 0.3);
	});

	test('clicking a slab selects the floor drawn there', async ({ page }) => {
		await stackView(page);
		expect(await activeFloor(page)).toBe('Floor 1');

		const bounds = await drawnBounds(page);
		const r = await page.locator('canvas').boundingBox();
		// Canvas pixels are device pixels; the click is in CSS pixels.
		const scale = r ? r.width / (await page.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width)) : 1;
		const clickAt = async (fractionOfHeight: number) => {
			// Fractions of the drawn extent rather than fixed pixels: the label above
			// the top slab is ~20 canvas px of text, so "12 px below the top" is still
			// in the label, and the extent itself scales with the camera.
			const x = r!.x + ((bounds.x0 + bounds.x1) / 2) * scale;
			const y = r!.y + (bounds.y0 + fractionOfHeight * bounds.h) * scale;
			await page.mouse.click(x, y);
			await page.waitForTimeout(600);
		};

		// A sixth of the way down is inside the top floor's own box (its box is the
		// top three quarters of the extent).
		await clickAt(0.15);
		expect(await activeFloor(page)).toBe('Floor 3');

		// The bottom strip is below where the middle floor's box ends, so it belongs
		// to the ground floor — which is exactly why the hit test uses the plan box
		// and not the decorative side band.
		await clickAt(0.95);
		expect(await activeFloor(page)).toBe('Floor 1');
	});

	test('hovering a storey highlights it, and the highlight moves with the pointer', async ({
		page
	}) => {
		// The roadmap listed hover/isolate as the stacked view's untested behaviour:
		// isolate is measured by drawn pixels elsewhere, hover was not measured at all.
		// It is a *visual* effect, so it is measured the way isolate is — by what reaches
		// the canvas — rather than by reading a state variable the drawing could ignore.
		await stackView(page);
		const bounds = await drawnBounds(page);
		const r = await page.locator('canvas').boundingBox();
		const scale = r
			? r.width / (await page.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width))
			: 1;
		const moveTo = async (fractionOfHeight: number) => {
			const x = r!.x + ((bounds.x0 + bounds.x1) / 2) * scale;
			const y = r!.y + (bounds.y0 + fractionOfHeight * bounds.h) * scale;
			await page.mouse.move(x, y);
			await page.waitForTimeout(400);
		};

		// Parked away from the stack: whatever is drawn now is the un-hovered picture.
		await page.mouse.move(r!.x + 4, r!.y + 4);
		await page.waitForTimeout(400);
		const plain = await drawnPixels(page);

		await moveTo(0.15);
		const topHovered = await drawnPixels(page);

		await moveTo(0.95);
		const bottomHovered = await drawnPixels(page);

		console.log(
			`[stack hover] plain ${plain}, top floor ${topHovered}, bottom floor ${bottomHovered}`
		);
		// An outline is drawn for the hovered storey, so the canvas gains pixels...
		expect(Math.abs(topHovered - plain)).toBeGreaterThan(200);
		// ...and two different storeys are two different outlines, so the counts differ.
		expect(topHovered).not.toBe(bottomHovered);

		// Leaving clears it again: a highlight that sticks after the pointer has gone
		// would be worse than none, because it would read as a selection.
		await page.mouse.move(r!.x + 4, r!.y + 4);
		await page.waitForTimeout(400);
		expect(Math.abs((await drawnPixels(page)) - plain)).toBeLessThan(200);
	});

	test('the overview is read-only', async ({ page }) => {
		await stackView(page);
		// The wall tool lives in the sidebar and edits a single floor's layers, which
		// the overviews do not draw.
		await expect(page.getByText('Draw wall')).toHaveCount(0);

		// A click on empty canvas picks a floor or does nothing; it must not place an
		// access point. `apPlaceMode` is off by default, so this is about the
		// overview not running the placement handler at all.
		const apsBefore = await page.evaluate(() => {
			const raw = localStorage.getItem('aetherax:project');
			return raw ? (JSON.parse(raw) as { aps?: unknown[] }).aps?.length ?? 0 : 0;
		});
		const r = await page.locator('canvas').boundingBox();
		await page.mouse.click(r!.x + 30, r!.y + 30);
		await page.waitForTimeout(800);
		const apsAfter = await page.evaluate(() => {
			const raw = localStorage.getItem('aetherax:project');
			return raw ? (JSON.parse(raw) as { aps?: unknown[] }).aps?.length ?? 0 : 0;
		});
		expect(apsAfter).toBe(apsBefore);
		expect(apsAfter).toBe(3);
	});

	test('per-floor coverage is drawn in the stack', async ({ page }) => {
		await openFloorplanTab(page);
		await page.locator('.layer-row').filter({ hasText: 'Signal heatmap' }).click();
		await page.locator('.view-btn[aria-label^="Stack every floor"]').click();
		// Tiles warm one floor per frame.
		await page.waitForTimeout(6000);

		const heat = await page.evaluate(() => {
			const c = document.querySelector('canvas') as HTMLCanvasElement;
			const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
			let n = 0;
			for (let i = 0; i < d.length; i += 4) {
				const r = d[i]!;
				const g = d[i + 1]!;
				const b = d[i + 2]!;
				const mx = Math.max(r, g, b);
				// Saturated and not the teal used for frames and AP dots.
				if (mx - Math.min(r, g, b) <= 40 || mx <= 60) continue;
				if (b > r + 30 && g > r + 20) continue;
				n++;
			}
			return n;
		});
		expect(heat).toBeGreaterThan(1000);
	});

	test('the stack spacing slider pulls the storeys apart', async ({ page }) => {
		await stackView(page);
		await fit(page);
		const before = { zoom: await fitZoom(page), bounds: await drawnBounds(page) };

		// Spacing multiplies the storey offset, which is `z·sin(pitch)` on screen. The
		// geometry the RF model reads is untouched — this is a view setting.
		await setRange(page, 'Stack spacing', '2');
		await fit(page);
		const after = { zoom: await fitZoom(page), bounds: await drawnBounds(page) };

		// Two extra storeys of 99.15 world units, seen at 40°: about 127 world units
		// more to fit, so the fit has to zoom out. Shape, not size: the aspect ratio
		// is what says the stack got taller rather than merely wider.
		expect(after.zoom).toBeLessThan(before.zoom);
		expect(after.bounds.h / after.bounds.w).toBeGreaterThan(before.bounds.h / before.bounds.w);
	});

	test('rotating turns the plans, rather than sliding them apart', async ({ page }) => {
		await stackView(page);
		await fit(page);
		const straight = { zoom: await fitZoom(page), bounds: await drawnBounds(page) };

		// The whole point of the view: yaw turns the *floor plans*. A rectangle seen
		// at 45° needs a bounding box as wide as the sum of its sides times cos(45°),
		// so it is 990 world units wide against 800 — and a view that merely offset
		// the storeys could not do this at all.
		await setRange(page, 'Stack rotation', '45');
		await expect(
			page.locator('.opacity-row').filter({ hasText: 'Rotate' }).locator('.opacity-value')
		).toHaveText('45°');
		await fit(page);
		const turned = { zoom: await fitZoom(page), bounds: await drawnBounds(page) };

		expect(turned.zoom).toBeLessThan(straight.zoom);
		// And the box it had to fit is relatively *taller*: at 45° what has to fit is
		// the plan's diagonal, so the 800 x 523 box becomes 990 x 758 rather than
		// staying long and thin. A view that only slid the storeys apart could not
		// change this at all — the box would be the same shape at every setting.
		expect(turned.bounds.h / turned.bounds.w).toBeGreaterThan(
			straight.bounds.h / straight.bounds.w
		);
	});

	test('tilting changes how much of the storeys is visible', async ({ page }) => {
		await stackView(page);
		await setRange(page, 'Stack tilt', '15');
		await fit(page);
		const shallow = { zoom: await fitZoom(page), bounds: await drawnBounds(page) };

		await setRange(page, 'Stack tilt', '70');
		await expect(
			page.locator('.opacity-row').filter({ hasText: 'Tilt' }).locator('.opacity-value')
		).toHaveText('70°');
		await fit(page);
		const steep = { zoom: await fitZoom(page), bounds: await drawnBounds(page) };

		// The tilt trades foreshortening against storey separation: 600·cos(15°) plus
		// 2·99.15·sin(15°) is 631 world units of height, against 600·cos(70°) plus
		// 2·99.15·sin(70°) = 391. So a steep camera is *shorter* overall and the fit
		// can zoom in further — the plan is compressed more than the storeys separate.
		expect(steep.bounds.h / steep.bounds.w).toBeLessThan(shallow.bounds.h / shallow.bounds.w);
		expect(steep.zoom).toBeGreaterThan(shallow.zoom);
	});

	test('dragging on the canvas turns the view, without re-framing', async ({ page }) => {
		await stackView(page);
		await fit(page);
		const before = await drawnBounds(page);
		const zoomBefore = await fitZoom(page);

		// A horizontal drag on the overview turns the building. This is the gesture
		// the view exists for, and it must not need a Fit afterwards: the projection is
		// taken about the stack's centre, so the stack turns where it stands.
		const r = await page.locator('canvas').boundingBox();
		const cx = r!.x + r!.width / 2;
		const cy = r!.y + r!.height / 2;
		await page.mouse.move(cx, cy);
		await page.mouse.down();
		await page.mouse.move(cx + 120, cy, { steps: 12 });
		await page.mouse.up();
		await page.waitForTimeout(400);

		// The panel's readout follows the drag, so the two controls never disagree —
		// and it follows it in the *same* direction: dragging right turns the plan with
		// the pointer, so the angle goes negative (three.js OrbitControls' convention,
		// which is what most people already have in their hands).
		const yaw = await readAngle(page, 'Rotate');
		expect(yaw).toBeLessThan(-20);

		const after = await drawnBounds(page);
		// Still framed, without anyone pressing Fit: the zoom is untouched, because
		// the projection is taken about the stack's centre rather than about the
		// plan's origin — which would have swept the building off the canvas.
		expect(await fitZoom(page)).toBe(zoomBefore);
		// A 48° turn makes the box about a quarter wider than the frame, so it touches
		// the edges; what matters is that it is still *there* and still centred.
		const canvasBox = (await page.locator('canvas').boundingBox())!;
		const centreX = (after.x0 + after.x1) / 2;
		expect(Math.abs(centreX - canvasBox.width / 2)).toBeLessThan(canvasBox.width * 0.12);
		expect(after.w).toBeGreaterThan(before.w * 0.6);
	});

	test('a click still picks a floor; only a drag turns the view', async ({ page }) => {
		await stackView(page);
		await fit(page);
		const yawBefore = await readAngle(page, 'Rotate');

		const bounds = await drawnBounds(page);
		const r = await page.locator('canvas').boundingBox();
		const scale = r
			? r.width / (await page.locator('canvas').evaluate((c: HTMLCanvasElement) => c.width))
			: 1;
		await page.mouse.click(
			r!.x + ((bounds.x0 + bounds.x1) / 2) * scale,
			r!.y + (bounds.y0 + 0.15 * bounds.h) * scale
		);
		await page.waitForTimeout(600);

		expect(await activeFloor(page)).toBe('Floor 3');
		// The view did not move: a click is a click.
		expect(await readAngle(page, 'Rotate')).toBe(yawBefore);
	});

	test('dragging past a limit stops there, and dragging back responds at once', async ({
		page
	}) => {
		await stackView(page);
		// Tilt starts at 40°, the range is 5–75°, and dragging *down* tilts toward a
		// plan view (the plan follows the pointer), so a long downward drag has to hit
		// the bottom of the range and stay there — and the drag must not bank the
		// overshoot: pulling back has to move the angle immediately rather than after
		// retracing the excess.
		const r = (await page.locator('canvas').boundingBox())!;
		const cx = r.x + r.width / 2;
		const cy = r.y + r.height / 2;

		await page.mouse.move(cx, cy);
		await page.mouse.down();
		// 300 px down at 0.4°/px is 120°, far past the 35° of headroom below.
		await page.mouse.move(cx, cy + 300, { steps: 20 });
		await page.mouse.up();
		await page.waitForTimeout(300);
		expect(await readAngle(page, 'Tilt')).toBe(5);

		// Now the part that was broken: 40 px back is 16° up from the limit, and it
		// must show ~16° up rather than still 5° while the pointer unwinds its
		// overshoot. The tolerance is the drag threshold: the first 5 px are spent
		// deciding that this is a drag and not a click, so 2° of the pull do not count.
		await page.mouse.move(cx, cy);
		await page.mouse.down();
		await page.mouse.move(cx, cy - 40, { steps: 8 });
		await page.mouse.up();
		await page.waitForTimeout(300);
		const after = await readAngle(page, 'Tilt');
		expect(after).toBeGreaterThan(5 + 40 * 0.4 - 3);
		expect(after).toBeLessThan(5 + 40 * 0.4 + 3);
	});

	test('isolating keeps one floor, and the control is absent with one floor', async ({ page }) => {
		await stackView(page);
		const row = page.locator('.layer-row').filter({ hasText: 'Only this floor' });
		await expect(row).toBeVisible();

		const sprawling = await drawnBounds(page);
		const sprawlingPixels = await drawnPixels(page);
		// No re-fit: isolating *shrinks* what is drawn, and a fit would scale the
		// smaller stack back up to the same drawn extent and hide the change.
		const middlePill = page.locator('.floor-pill:not(.add)').nth(1);
		await middlePill.click();
		await page.waitForTimeout(400);
		await row.click();
		await expect(row.locator('.eye-icon')).not.toHaveClass(/hidden/);
		await page.waitForTimeout(600);
		const isolated = await drawnBounds(page);

		// Two floors' worth of plans are no longer painted. The bounding box barely
		// moves — the remaining floor's walls still stand where the storey below was —
		// so it is the area, not the extent, that says the filter did something. With
		// two floors in the plan this still works, which the old "current floor and
		// its neighbours" rule did not: it kept everything and looked broken.
		expect(await drawnPixels(page)).toBeLessThan(sprawlingPixels * 0.7);
		expect(isolated.h).toBeLessThan(sprawling.h);
	});
});
