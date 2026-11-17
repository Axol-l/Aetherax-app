import { test, expect, type Page } from '@playwright/test';

/**
 * The propagation environment is a project setting, and it moves real numbers.
 *
 * ITU-R P.1238's coefficient already contains an average allowance for walls, so a high value
 * with fully drawn walls double-counts (20 dB at 10 m, 26 dB at 20 m on this project's own
 * numbers — `docs/PHYSICAL_MODELS.md` §A3a). What is asserted here is the wiring: the three
 * environments are offered, selecting one re-derives the AP radii, and the project keeps the
 * choice. The coefficient table itself is unit-tested in `src/lib/rf/path-loss.test.ts`.
 */

async function seedClosedFloor(page: Page): Promise<void> {
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
		ctx.fillRect(190, 0, 8, 160);
		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3, name: 'Propagation', band: '5ghz', channelWidth: 20, regulatoryDomain: 'fcc',
				unitSystem: 'metric', ispSpeed: 0, targetThroughput: 25, allowOutsideRooms: false,
				clientHeight: 1.5, heatmapRssiFloor: -70, interferenceWeight: 0.2, coverageSoftnessDb: 0,
				coverageFloorPct: 0,
				floors: [{
					id: 'f1', name: 'Floor 1', level: 0, ceilingHeight: 3, floorMaterial: 1, floorThickness: 0.2,
					floorplanScale: 1, floorplanOffsetX: 0, floorplanOffsetY: 0, calibration: null,
					floorplanBoundary: null,
					wallMask: { dataUrl: c.toDataURL('image/png'), width: 400, height: 400, originX: 0, originY: 0 },
					wallAttenuation: 5, wallMaterial: 0, materialMask: null, roomTypeMask: null,
					roomDensityOverrides: {}, roomCustomLabels: {}
				}],
				aps: [{
					id: 'ap1', name: 'AP-1', x: 200, y: 200, floorId: 'f1', band: '5ghz', channelWidth: 20,
					fixedChannel: null, assignedChannel: null, interferenceRadius: 100, power: 20,
					modelId: null, modelLabel: null
				}]
			})
		);
	});
}

async function savedProject(page: Page): Promise<Record<string, unknown> | null> {
	const raw = await page.evaluate(() => localStorage.getItem('aetherax:project'));
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

async function radiusOfFirstAp(page: Page): Promise<number> {
	const project = await savedProject(page);
	const aps = (project?.aps ?? []) as Array<{ interferenceRadius: number }>;
	return aps[0]?.interferenceRadius ?? -1;
}

test('offers the environments and keeps the choice', async ({ page }) => {
	test.setTimeout(120_000);
	await seedClosedFloor(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(3000);
	await page.getByRole('button', { name: 'Placement optimiser settings' }).click();
	const select = page.locator('.env-select');
	await expect(select).toBeVisible();
	await expect(select).toHaveValue('closedPlan');
	const options = await select.locator('option').allInnerTexts();
	expect(options).toEqual(['Walls drawn in full', 'Walls partly drawn', 'Walls barely drawn']);
	const before = await radiusOfFirstAp(page);
	expect(before).toBeGreaterThan(0);
	await select.selectOption('lineOfSight');
	await expect(select).toHaveValue('lineOfSight');
	await expect.poll(() => radiusOfFirstAp(page), { timeout: 20_000 }).toBeGreaterThan(before);
	await expect
		.poll(async () => (await savedProject(page))?.pathLossScenario ?? null, { timeout: 20_000 })
		.toBe('lineOfSight');
});