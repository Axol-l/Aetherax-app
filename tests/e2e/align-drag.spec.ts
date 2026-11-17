import { test, expect, type Page } from '@playwright/test';

/**
 * Dragging to align has to survive the release.
 *
 * The drag moves the camera while the pointer is down and the *floor* on release, so a bug here
 * looks like the plan snapping back to where it started — which is what the report says. This
 * seeds two floors and reads the alignment out of the saved project after the gesture.
 */
async function seed(page: Page): Promise<void> {
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
		const room = 400;
		const canvas = document.createElement('canvas');
		canvas.width = room;
		canvas.height = room;
		const ctx = canvas.getContext('2d')!;
		ctx.strokeStyle = '#000000';
		ctx.lineWidth = 8;
		ctx.strokeRect(4, 4, room - 8, room - 8);
		const mask = { dataUrl: canvas.toDataURL('image/png'), width: room, height: room, originX: 0, originY: 0 };
		const floor = (id: string, name: string, level: number) => ({
			id,
			name,
			level,
			ceilingHeight: 3,
			floorMaterial: 1,
			floorThickness: 0.2,
			floorplanScale: 1,
			floorplanOffsetX: 0,
			floorplanOffsetY: 0,
			calibration: { worldUnitsPerMeter: 40, areaSqm: 100 },
			floorplanBoundary: null,
			wallMask: mask,
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
				name: 'Align',
				band: '5ghz',
				channelWidth: 20,
				regulatoryDomain: 'fcc',
				unitSystem: 'metric',
				ispSpeed: 0,
				targetThroughput: 25,
				allowOutsideRooms: true,
				clientHeight: 1.5,
				heatmapRssiFloor: -70,
				floors: [floor('f1', 'Floor 1', 0), floor('f2', 'Floor 2', 1)],
				aps: []
			})
		);
	});
}

test('an alignment drag leaves the floor where it was dropped', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(2500);

	// Show floor 2, which is the one an alignment moves — the control is hidden on the bottom
	// floor, where there is nothing below to align to.
	await page.getByRole('tab', { name: 'Floorplan' }).click();
	await page.getByRole('button', { name: 'Floor 2', exact: true }).click();
	await page.waitForTimeout(800);
	const before = await page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		const project = JSON.parse(raw!) as { floors: Array<{ id: string; floorplanOffsetX: number }> };
		return project.floors.map((floor) => floor.floorplanOffsetX);
	});

	await page.getByRole('button', { name: 'Drag to align' }).click();
	// The mode is on when the button says so; if it does not, the drag below is just a pan.
	await expect(page.getByRole('button', { name: 'Drag on canvas…' })).toBeVisible();
	const canvas = page.locator('canvas');
	const box = (await canvas.boundingBox())!;
	// Zoom in first: an alignment must not re-frame the view, and at fit zoom a reset is
	// invisible.
	await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
	await page.mouse.wheel(0, -500);
	await page.waitForTimeout(400);
	const zoomText = async (): Promise<string> =>
		(await page.locator('.status-item.zoom').innerText()).trim();
	const zoomBefore = await zoomText();
	await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.5 + 80, box.y + box.height * 0.5 + 40, { steps: 8 });
	await page.mouse.up();
	await page.waitForTimeout(600);
	expect(await zoomText()).toBe(zoomBefore);

	// The save is debounced; poll the stored project.
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const raw = localStorage.getItem('aetherax:project');
					const project = JSON.parse(raw!) as {
						floors: Array<{ id: string; floorplanOffsetX: number; floorplanOffsetY: number }>;
					};
					const floor = project.floors.find((candidate) => candidate.id === 'f2')!;
					return Math.hypot(floor.floorplanOffsetX, floor.floorplanOffsetY);
				}),
			{ timeout: 20_000 }
		)
		.toBeGreaterThan(1);

	// And it must still be there a repaint later: this is the "snaps back" report.
	await page.waitForTimeout(1500);
	const after = await page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		const project = JSON.parse(raw!) as {
			floors: Array<{ id: string; floorplanOffsetX: number; floorplanOffsetY: number }>;
		};
		const floor = project.floors.find((candidate) => candidate.id === 'f2')!;
		return { x: floor.floorplanOffsetX, y: floor.floorplanOffsetY };
	});
	expect(Math.hypot(after.x, after.y)).toBeGreaterThan(1);
	expect(before.length).toBe(2);
});
