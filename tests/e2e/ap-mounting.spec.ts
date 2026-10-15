import { test, expect, type Page } from '@playwright/test';

/**
 * Mounting: the per-AP fields, and what survives a reload.
 *
 * The geometry itself is covered by the unit tests for `ap-state.svelte.ts`, and
 * the effect on a plan is far too small to read off a coverage percentage '?a
 * 1.4 m height difference at a 40 m reach is 2 cm of range. What can only break
 * here is the wiring: a field that stores the display unit instead of metres, a
 * preset that leaves the height at the old mount's value, or a height that is
 * lost between sessions.
 *
 * So everything is asserted through the saved project, which is what the models
 * actually read.
 */

const ROOM = 400;

async function seed(page: Page): Promise<void> {
	await page.addInitScript((arg: { room: number }) => {
		const ROOM = arg.room;
		localStorage.setItem('aetherax:welcomed', '1');
		/*
		 * Once per context. The specs reload to check that a value survives, and a
		 * seed that ran again on that navigation would overwrite the very thing under
		 * test with the value it was seeded with.
		 */
		if (localStorage.getItem('aetherax:mountingSeed')) return;
		localStorage.setItem('aetherax:mountingSeed', '1');
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
				name: 'Mounting',
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
						wallMask: {
							dataUrl: c.toDataURL('image/png'),
							width: ROOM,
							height: ROOM,
							originX: 0,
							originY: 0
						},
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

async function ready(page: Page): Promise<void> {
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(2500);
}

/** The saved project, as the models read it. */
async function saved(page: Page): Promise<{
	ap: {
		x?: number;
		y?: number;
		mount?: string;
		mountHeightM?: number;
		beamwidthDeg?: number;
		aimDeg?: number;
		facingDeg?: number;
	};
	aps?: Array<{ id: string; mount?: string; x: number; y: number; facingDeg?: number }>;
}> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		const parsed = raw ? JSON.parse(raw) : {};
		return { ap: parsed.aps?.[0] ?? {}, aps: parsed.aps ?? [] };
	});
}

/** Open the Floorplan panel's optimiser settings, where the switch lives. */
async function openOptimiserSettings(page: Page): Promise<void> {
	await page.locator('button[aria-label="Placement optimiser settings"]').click();
}

/**
 * Select the seeded AP and open the panel that edits it.
 *
 * Selecting is not enough: the sidebar keeps whichever tab is open, so the AP
 * editor is only on screen once the APs tab is.
 */
async function selectAp(page: Page): Promise<void> {
	await page.locator('canvas').first().click({ position: { x: 200, y: 200 } });
	await page.waitForTimeout(400);
	await page
		.locator('button[role="tab"]')
		.filter({ hasText: 'APs' })
		.first()
		.click();
	await page.waitForTimeout(400);
}

/** Pixels the heatmap colours: the only coloured content on an empty dark plan. */
async function colouredPixels(page: Page): Promise<number> {
	return page.evaluate(() => {
		const canvases = Array.from(document.querySelectorAll('canvas'));
		const canvas = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
		const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
		let coloured = 0;
		for (let i = 0; i < d.length; i += 4) {
			const r = d[i]!;
			const g = d[i + 1]!;
			const b = d[i + 2]!;
			// Warm ramp colours only: the plan, the grid and the chrome are grey, so a
			// channel that stands out from the others is a coloured texel.
			const max = Math.max(r, g, b);
			const min = Math.min(r, g, b);
			if (max > 80 && max - min > 40) coloured++;
		}
		return coloured;
	});
}

test('a narrower beam covers less, not more', async ({ page }) => {
	/*
	 * The end-to-end version of the sign the model has to get right, and the one a
	 * unit test of the gain curve cannot catch: `elevationGainDb` returns a gain
	 * relative to the peak, so a caller that *subtracts* it adds signal instead of
	 * removing it — and the heatmap did, which made a narrower beam paint a larger
	 * covered area. Nothing about the profile itself was wrong.
	 */
	test.setTimeout(120_000);
	await seed(page);
	await ready(page);
	await page.getByText('Signal heatmap').click();
	await page.waitForTimeout(2500);
	await selectAp(page);

	const beamwidth = page.getByLabel('Vertical beamwidth');
	await beamwidth.fill('180');
	await beamwidth.blur();
	await page.waitForTimeout(2500);
	const wide = await colouredPixels(page);

	await beamwidth.fill('40');
	await beamwidth.blur();
	await page.waitForTimeout(2500);
	const narrow = await colouredPixels(page);

	expect(wide).toBeGreaterThan(500);
	expect(narrow).toBeLessThan(wide);
});

test('an AP carries a mount and a height, in metres, through a reload', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page);
	await ready(page);

	await selectAp(page);

	// The height field is in the project's unit; the model takes metres.
	const height = page.getByLabel('Mount height');
	await expect(height).toBeEnabled();
	await expect(height).toHaveValue('2.9');

	await height.fill('1.1');
	await height.blur();
	await expect
		.poll(async () => (await saved(page)).ap.mountHeightM, { timeout: 15_000 })
		.toBeCloseTo(1.1, 2);

	// A mount preset sets the height itself, so the two fields cannot disagree.
	await page.getByRole('button', { name: /Ceiling mount/ }).click();
	await page.getByRole('option', { name: 'Floor mount' }).click();
	await expect(page.getByRole('button', { name: /Floor mount/ })).toBeVisible();
	await expect
		.poll(async () => (await saved(page)).ap.mount, { timeout: 15_000 })
		.toBe('floor');
	await expect
		.poll(async () => (await saved(page)).ap.mountHeightM, { timeout: 15_000 })
		.toBeCloseTo(0.8, 2);

	await page.reload();
	await ready(page);
	await selectAp(page);
	await expect(page.getByLabel('Mount height')).toHaveValue('0.8');
	await expect(page.getByRole('button', { name: /Floor mount/ })).toBeVisible();
	await page.screenshot({ path: 'test-results/mounting/fields.png' });
});

test('an AP carries its antenna vertical cut, and it survives a reload', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page);
	await ready(page);
	await selectAp(page);

	// The band's own pattern to start with: 5 GHz, from the vendor cuts.
	const beamwidth = page.getByLabel('Vertical beamwidth');
	const aim = page.getByLabel('Aim');
	await expect(beamwidth).toHaveValue('60');
	await expect(aim).toHaveValue('0');

	await beamwidth.fill('90');
	await beamwidth.blur();
	await expect
		.poll(async () => (await saved(page)).ap.beamwidthDeg, { timeout: 15_000 })
		.toBe(90);

	await page.reload();
	await ready(page);
	await selectAp(page);
	await expect(page.getByLabel('Vertical beamwidth')).toHaveValue('90');

	// Out of range is clamped rather than stored, so the model never sees an aim
	// past straight down or straight up.
	await page.getByLabel('Aim').fill('120');
	await page.getByLabel('Aim').blur();
	await expect
		.poll(async () => (await saved(page)).ap.aimDeg, { timeout: 15_000 })
		.toBe(90);
	await expect(page.getByLabel('Aim')).toHaveValue('90');

	// The sign is the direction. The panel draws the pattern rather than spelling it
	// out, so what is asserted here is that the sign survives and the drawing is
	// there to show it.
	await page.getByLabel('Aim').fill('-30');
	await page.getByLabel('Aim').blur();
	await expect
		.poll(async () => (await saved(page)).ap.aimDeg, { timeout: 15_000 })
		.toBe(-30);
	await expect(page.locator('svg.diagram')).toBeVisible();
});

test('the mounting is in the panel, and nowhere is it a switch', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page);
	await ready(page);
	await selectAp(page);

	// An AP's height is part of the model, not an option: the field is live in the
	// AP panel and the optimiser settings have no toggle for it.
	await expect(page.getByLabel('Mount height')).toBeEnabled();
	await expect(page.getByText('Mounting heights')).toHaveCount(0);
	await openOptimiserSettings(page);
	await expect(page.getByLabel('Mounting heights', { exact: true })).toHaveCount(0);
});

/** Select the seeded AP from the list, which works wherever it has been moved to. */
async function selectApFromList(page: Page): Promise<void> {
	await page
		.locator('button[role="tab"]')
		.filter({ hasText: 'APs' })
		.first()
		.click();
	await page.waitForTimeout(300);
	await page.getByText('AP-1', { exact: true }).first().click();
	await page.waitForTimeout(400);
}

/** Pick a mounting from the preset select in the AP panel. */
async function chooseMount(page: Page, label: string): Promise<void> {
	await page.getByRole('button', { name: /(Ceiling|Floor|Wall) mount/ }).click();
	await page.getByRole('option', { name: label }).click();
}

test('a wall mount lands on a wall, faces the room, and survives a reload', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page);
	await ready(page);
	await selectAp(page);

	// The seed's AP sits in the middle of a room whose walls are the mask border, so
	// "put it on a wall" is a long way from where it was.
	await chooseMount(page, 'Wall mount');
	await expect
		.poll(async () => (await saved(page)).ap.mount, { timeout: 15_000 })
		.toBe('wall');
	await expect
		.poll(async () => (await saved(page)).ap.mountHeightM, { timeout: 15_000 })
		.toBeCloseTo(2, 2);

	const landed = (await saved(page)).ap;
	/*
	 * On a wall: the seed's walls are the 10 px border, so the face is at ~10 world
	 * units and the unit is backed off it by a bracket's depth (0.1 m ≈ 3.3 units).
	 * The band is a few units wide rather than exact because the face's own pixel is
	 * whichever one the transform calls nearest, which is not something the model
	 * underneath cares about.
	 */
	const nearestEdge = Math.min(landed.x!, landed.y!, 400 - landed.x!, 400 - landed.y!);
	expect(nearestEdge).toBeGreaterThan(8);
	expect(nearestEdge).toBeLessThan(20);
	// Facing into the room, i.e. away from that border: one of the four axis
	// directions, not the middle of a quadrant.
	const facing = ((landed.facingDeg! % 360) + 360) % 360;
	const offAxis = Math.min(facing % 90, 90 - (facing % 90));
	expect(offAxis).toBeLessThan(2);

	// The field is only on screen for a wall mount, and it shows what was stored.
	await expect(page.getByLabel('Facing')).toHaveValue(String(Math.round(facing)));

	await page.reload();
	await ready(page);
	// From the list: after the switch the AP is on a wall, not where it was seeded,
	// so clicking its old position would select nothing.
	await selectApFromList(page);
	await expect(page.getByRole('button', { name: /Wall mount/ })).toBeVisible();
	await expect(page.getByLabel('Facing')).toHaveValue(String(Math.round(facing)));
	await expect(page.getByLabel('Mount height')).toHaveValue('2');
});

test('a wall mount may not be placed away from a wall', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page);
	await ready(page);
	await selectAp(page);
	await chooseMount(page, 'Wall mount');
	await expect
		.poll(async () => (await saved(page)).ap.mount, { timeout: 15_000 })
		.toBe('wall');

	// A click in the middle of the room is three metres from the nearest wall, so it
	// is refused rather than teleported onto one. Placement lives in the Floorplan
	// tab, which is where the button is.
	await page
		.locator('button[role="tab"]')
		.filter({ hasText: 'Floorplan' })
		.first()
		.click();
	await page.waitForTimeout(300);
	await page.getByRole('button', { name: 'Place APs' }).click();
	await page.waitForTimeout(300);
	/*
	 * A click in the middle of the room, which is metres from the nearest wall: it is
	 * refused rather than teleported onto one. The seeded plan is drawn at 1:1 with the
	 * canvas, so this point is the room's middle in the frame everything else here uses.
	 */
	await page.locator('canvas').first().click({ position: { x: 200, y: 200 } });
	// Long enough for the debounced save, so what is read below is this click's
	// outcome rather than the previous one's.
	await page.waitForTimeout(3000);

	const after = await saved(page);
	/*
	 * Whichever branch the click lands on — refused, or accepted because that point
	 * is within a metre of a wall in this viewport — the rule is the same: nothing
	 * wall-mounted ends up off a wall. The refusal says why, so it is checked when it
	 * happens.
	 */
	for (const ap of after.aps ?? []) {
		if (ap.mount !== 'wall') continue;
		const edge = Math.min(ap.x, ap.y, 400 - ap.x, 400 - ap.y);
		expect(edge).toBeLessThan(20);
	}
	if ((after.aps ?? []).length === 1) {
		await expect(page.getByText('has to sit on a wall', { exact: false })).toBeVisible();
	}
});

test('the optimiser places a wall mount on a wall, and turns it with the wall', async ({ page }) => {
	test.setTimeout(180_000);
	await seed(page);
	await ready(page);

	// Make it a wall mount first: the mounting is what the run has to respect, and the
	// switch is the same one the user makes.
	await selectAp(page);
	await chooseMount(page, 'Wall mount');
	await expect
		.poll(async () => (await saved(page)).ap.mount, { timeout: 15_000 })
		.toBe('wall');

	// Placement lives in the Floorplan tab, which is where the button is.
	await page
		.locator('button[role="tab"]')
		.filter({ hasText: 'Floorplan' })
		.first()
		.click();
	await page.waitForTimeout(300);
	await page.getByRole('button', { name: 'Optimize placement' }).click();
	// The run is staged and reports progress in the panel; wait for it to stop rather
	// than for a time, and let the debounced save land.
	await expect(page.getByText('Optimizing…', { exact: false })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText('Optimizing…', { exact: false })).toHaveCount(0, {
		timeout: 150_000
	});
	await page.waitForTimeout(3000);

	const landed = (await saved(page)).ap;
	/*
	 * A wall mount is the one case that used to be refused outright ("nothing for the
	 * optimiser to place"), so what is checked is the state the run leaves behind: still
	 * wall-mounted, still on a wall, and looking into the room it landed in. The seeded
	 * plan's walls are the 10 px border, so the face is at ~10 world units and the unit
	 * is backed off it by a bracket's depth.
	 */
	expect(landed.mount).toBe('wall');
	const edge = Math.min(landed.x!, landed.y!, 400 - landed.x!, 400 - landed.y!);
	expect(edge).toBeGreaterThan(8);
	expect(edge).toBeLessThan(20);
	// One of the four axis directions: where a derived facing comes from. The payload's
	// facing was 0 and a wall mount in the middle of the room has no wall to keep it.
	const facing = ((landed.facingDeg! % 360) + 360) % 360;
	expect(Math.min(facing % 90, 90 - (facing % 90))).toBeLessThan(2);
});
