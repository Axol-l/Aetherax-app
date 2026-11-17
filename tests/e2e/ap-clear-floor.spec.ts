import { test, expect, type Page } from '@playwright/test';

/**
 * Clear is scoped to the floor named in its confirmation.
 *
 * The AP list groups every floor, so `Clear` deleting `apState.aps` removed the whole
 * building while the prompt said “on this floor”. A two-storey project makes the difference
 * observable without any other feature.
 */

async function seed(page: Page): Promise<void> {
	await page.addInitScript(() => {
		localStorage.setItem('aetherax:welcomed', '1');
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
			calibration: { worldUnitsPerMeter: 32.8 },
			floorplanBoundary: null,
			wallMask: null,
			walls: [],
			columns: [],
			wallAttenuation: 5,
			wallMaterial: 0,
			materialMask: null,
			roomTypeMask: null,
			roomDensityOverrides: {},
			roomCustomLabels: {},
			planningArea: null,
			surfaces: [],
			notes: []
		});
		const ap = (id: string, name: string, floorId: string, x: number) => ({
			id,
			name,
			x,
			y: 200,
			floorId,
			band: '5ghz',
			channelWidth: 20,
			fixedChannel: null,
			assignedChannel: null,
			interferenceRadius: 988,
			power: 20,
			modelId: null,
			modelLabel: null
		});
		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Clear scope',
				band: '5ghz',
				channelWidth: 20,
				regulatoryDomain: 'fcc',
				unitSystem: 'metric',
				ispSpeed: 0,
				targetThroughput: 25,
				allowOutsideRooms: false,
				clientHeight: 1.5,
				floors: [floor('f1', 'Floor 1', 0), floor('f2', 'Floor 2', 1)],
				aps: [ap('a1', 'AP-1', 'f1', 200), ap('a2', 'AP-2', 'f2', 300)]
			})
		);
	});
}

test('Clear removes only the current floor’s access points', async ({ page }) => {
	test.setTimeout(90_000);
	await seed(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(1500);

	await page.getByRole('tab', { name: 'APs' }).click();
	await expect(page.getByText('AP-1')).toBeVisible();
	await expect(page.getByText('AP-2')).toBeVisible();

	await page.getByRole('button', { name: 'Clear' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Delete' }).click();

	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const raw = localStorage.getItem('aetherax:project');
					const aps = raw ? (JSON.parse(raw) as { aps?: Array<{ id: string; floorId: string }> }).aps : [];
					return (aps ?? []).map((ap) => ({ id: ap.id, floorId: ap.floorId }));
				}),
			{ timeout: 20_000 }
		)
		.toEqual([{ id: 'a2', floorId: 'f2' }]);

	await expect(page.getByText('AP-1')).toHaveCount(0);
	await expect(page.getByText('AP-2')).toBeVisible();
});
