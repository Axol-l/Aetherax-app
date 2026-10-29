import { expect, test, type Page } from '@playwright/test';

/**
 * Pinning an access point in place.
 *
 * The pin is a constraint on the *optimiser*, not on the user: a pinned AP still
 * serves clients, still counts for interference and channel planning, and can still be
 * dragged. What it must not do is move when the optimiser runs — which is the property
 * tested here, on a floor with one pinned AP and one free one so that "nothing moved"
 * cannot pass by accident.
 */

const ROOM = 400;

async function seed(page: Page): Promise<void> {
	await page.addInitScript((arg: { room: number }) => {
		const ROOM = arg.room;
		localStorage.setItem('aetherax:welcomed', '1');
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
		const ap = (id: string, name: string, x: number, y: number, pinned: boolean) => ({
			id,
			name,
			x,
			y,
			floorId: 'f1',
			band: '5ghz',
			channelWidth: 20,
			fixedChannel: null,
			assignedChannel: null,
			/**
			 * A reach that cannot cover the room with two units.
			 *
			 * The test is about the pinned constraint, and it needs a plan where the optimiser
			 * *wants* to move something: with the wide reach this seed used, reflection and
			 * diffraction now serve every sample from the free unit's original spot, coverage
			 * arrived at 100 % and the optimiser correctly left both access points alone. A
			 * tighter reach keeps some of the floor uncovered, so "the free AP moved and the
			 * pinned one did not" still means what it says.
			 */
			interferenceRadius: 620,
			power: 14,
			modelId: null,
			modelLabel: null,
			mount: 'ceiling',
			mountHeightM: 2.9,
			beamwidthDeg: 60,
			aimDeg: 0,
			facingDeg: 0,
			pinned
		});
		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Pin',
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
						calibration: { worldUnitsPerMeter: 32.8084, areaSqm: 150 },
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
				aps: [ap('ap0', 'AP-1', 120, 320, true), ap('ap1', 'AP-2', 200, 200, false)]
			})
		);
	}, { room: ROOM });
}

async function ready(page: Page): Promise<void> {
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(2500);
}

/** The saved project's APs, by name. */
async function savedAps(
	page: Page
): Promise<Record<string, { x: number; y: number; pinned?: boolean }>> {
	return page.evaluate(() => {
		const parsed = JSON.parse(localStorage.getItem('aetherax:project') ?? '{}');
		const out: Record<string, { x: number; y: number; pinned?: boolean }> = {};
		for (const ap of parsed.aps ?? []) out[ap.name] = { x: ap.x, y: ap.y, pinned: ap.pinned };
		return out;
	});
}

test('a pinned AP is not moved by the optimiser, and the others still are', async ({ page }) => {
	test.setTimeout(180_000);
	await seed(page);
	await ready(page);

	const before = await savedAps(page);
	expect(before['AP-1']!.pinned).toBe(true);

	await page.getByRole('button', { name: 'Optimize placement' }).click();
	await expect(page.getByText('Optimizing…', { exact: false })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText('Optimizing…', { exact: false })).toHaveCount(0, {
		timeout: 150_000
	});
	// The result is applied and then saved on a debounce (five seconds since the save delay was
	// lengthened, so a gesture does not trigger a write mid-drag), so poll rather than waiting a
	// fixed three.
	const after = await (async () => {
		await expect
			.poll(
				async () => {
					const now = await savedAps(page);
					return Math.hypot(now['AP-2']!.x - before['AP-2']!.x, now['AP-2']!.y - before['AP-2']!.y);
				},
				{ timeout: 20_000 }
			)
			.toBeGreaterThan(10);
		return savedAps(page);
	})();
	// Exactly where it was, to the world unit: not "close to" it.
	expect(after['AP-1']!.x).toBe(before['AP-1']!.x);
	expect(after['AP-1']!.y).toBe(before['AP-1']!.y);
	expect(after['AP-1']!.pinned).toBe(true);
});
