import { test, expect, type Page } from '@playwright/test';

/**
 * Removing a plan must remove the data that was drawn in its frame.
 *
 * The floor card used to clear the image, mask, calibration and APs but leave the planning
 * area, raised surfaces, notes and wall segments behind. Their controls are hidden until a
 * plan exists, so the leftovers were invisible until the next import — and then clipped the
 * new heatmap or reappeared on the wrong drawing.
 */

async function seed(page: Page): Promise<void> {
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');
		const c = document.createElement('canvas');
		c.width = 400;
		c.height = 400;
		const ctx = c.getContext('2d')!;
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, 400, 10);
		ctx.fillRect(0, 390, 400, 10);
		ctx.fillRect(0, 0, 10, 400);
		ctx.fillRect(390, 0, 10, 400);
		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Remove plan',
				band: '5ghz',
				channelWidth: 20,
				regulatoryDomain: 'fcc',
				unitSystem: 'metric',
				ispSpeed: 0,
				targetThroughput: 25,
				allowOutsideRooms: false,
				clientHeight: 1.5,
				floors: [
					{
						id: 'f1',
						name: 'Floor 1',
						level: 0,
						ceilingHeight: 3,
						floorMaterial: 1,
						floorThickness: 0.2,
						floorplanScale: 1,
						floorplanOffsetX: 12,
						floorplanOffsetY: 8,
						calibration: { worldUnitsPerMeter: 32.8 },
						floorplanBoundary: null,
						wallMask: {
							dataUrl: c.toDataURL('image/png'),
							width: 400,
							height: 400,
							originX: 0,
							originY: 0
						},
						walls: [
							{ id: 'w1', ax: 10, ay: 10, bx: 390, by: 10, material: 0 },
							{ id: 'w2', ax: 390, ay: 10, bx: 390, by: 390, material: 0 }
						],
						planningArea: [
							{ x: 40, y: 40 },
							{ x: 300, y: 40 },
							{ x: 300, y: 300 },
							{ x: 40, y: 300 }
						],
						surfaces: [
							{
								id: 's1',
								kind: 'platform',
								ax: 80,
								ay: 80,
								bx: 160,
								by: 160,
								heightM: 1,
								topHeightM: 1,
								attenuationDb: 15,
								thicknessM: 0.2,
								solidBase: false
							}
						],
						notes: [{ id: 'n1', x: 200, y: 200, text: 'keep this spot clear' }],
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
						id: 'ap1',
						name: 'AP-1',
						x: 200,
						y: 200,
						floorId: 'f1',
						band: '5ghz',
						channelWidth: 20,
						fixedChannel: null,
						assignedChannel: null,
						interferenceRadius: 988,
						power: 20,
						modelId: null,
						modelLabel: null
					}
				]
			})
		);
	});
}

test('removing the plan clears everything that was drawn in its frame', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(1500);

	await page.getByRole('button', { name: 'Remove floorplan' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Delete' }).click();

	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const raw = localStorage.getItem('aetherax:project');
					const floor = raw ? (JSON.parse(raw) as { floors?: Array<Record<string, unknown>> }).floors?.[0] : null;
					return {
						area: floor?.planningArea ?? null,
						surfaces: Array.isArray(floor?.surfaces) ? floor.surfaces.length : -1,
						notes: Array.isArray(floor?.notes) ? floor.notes.length : -1,
						walls: Array.isArray(floor?.walls) ? floor.walls.length : -1,
						offsetX: floor?.floorplanOffsetX,
						offsetY: floor?.floorplanOffsetY,
						aps: (JSON.parse(raw ?? '{}') as { aps?: unknown[] }).aps?.length ?? -1
					};
				}),
			{ timeout: 20_000 }
		)
		.toEqual({ area: null, surfaces: 0, notes: 0, walls: 0, offsetX: 0, offsetY: 0, aps: 0 });

	await expect(page.getByRole('button', { name: 'Remove floorplan' })).toHaveCount(0);
});
