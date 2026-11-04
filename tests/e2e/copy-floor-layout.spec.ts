import { test, expect, type Page } from '@playwright/test';

/**
 * Copy layout is a floor-level operation: the source is the current floor and the target is
 * another floor (or a new one). Access points stay behind; the plan, walls, planning area,
 * raised surfaces and notes travel.
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
			floorplanScale: 0.4,
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
		const source = floor('f1', 'Floor 1', 0) as unknown as {
			walls: Array<{ id: string; ax: number; ay: number; bx: number; by: number; material: number }>;
			planningArea: Array<{ x: number; y: number }>;
			surfaces: Array<Record<string, unknown>>;
			notes: Array<{ id: string; x: number; y: number; text: string }>;
		};
		source.walls = [{ id: 'w1', ax: 10, ay: 10, bx: 110, by: 10, material: 0 }];
		source.planningArea = [
			{ x: 10, y: 10 },
			{ x: 110, y: 10 },
			{ x: 110, y: 110 }
		];
		source.surfaces = [
			{
				id: 's1',
				kind: 'platform',
				ax: 20,
				ay: 20,
				bx: 60,
				by: 60,
				heightM: 1,
				topHeightM: 1,
				thicknessM: 0.2,
				material: 'custom',
				attenuationDb: 15,
				solidBase: false
			}
		];
		source.notes = [{ id: 'n1', x: 40, y: 40, text: 'copy me' }];

		if (!localStorage.getItem('aetherax:project')) {
			localStorage.setItem(
				'aetherax:project',
				JSON.stringify({
					version: 3,
					name: 'Copy layout',
					band: '5ghz',
					channelWidth: 20,
					regulatoryDomain: 'fcc',
					unitSystem: 'metric',
					ispSpeed: 0,
					targetThroughput: 25,
					allowOutsideRooms: false,
					clientHeight: 1.5,
					floors: [source, floor('f2', 'Floor 2', 1)],
					aps: [
						{
							id: 'a1',
							name: 'AP-1',
							x: 50,
							y: 50,
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
		}
	});
}

test('a floor layout can be copied to another floor without its access points', async ({
	page
}) => {
	await seed(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.getByRole('tab', { name: 'Floorplan' }).click();

	// A real PNG import gives the source floor a blob URL, which is what the copy and the
	// per-floor underlay storage have to carry. A project-document URL is not persisted.
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 120;
		canvas.height = 120;
		const ctx = canvas.getContext('2d')!;
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, 120, 120);
		ctx.strokeStyle = '#000000';
		ctx.lineWidth = 6;
		ctx.strokeRect(3, 3, 114, 114);
		return canvas.toDataURL('image/png').split(',')[1]!;
	});
	await page.evaluate((base64: string) => {
		const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
		const input = document.querySelector<HTMLInputElement>('input[type="file"]');
		if (!input) throw new Error('no floorplan file input');
		const transfer = new DataTransfer();
		transfer.items.add(new File([bytes], 'layout.png', { type: 'image/png' }));
		input.files = transfer.files;
		input.dispatchEvent(new Event('change', { bubbles: true }));
	}, png);
	await expect(page.getByRole('button', { name: 'Remove floorplan' })).toBeVisible();

	await page.getByRole('button', { name: /Copy layout/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Copy floor layout' });
	await expect(dialog).toBeVisible();
	await dialog.locator('select').selectOption('f2');
	await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Remove floorplan' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Floor 2' })).toHaveClass(/active/);

	await page.waitForTimeout(6000);
	await page.reload();
	await page.waitForSelector('canvas');
	await page.getByRole('tab', { name: 'Floorplan' }).click();
	await expect(page.getByRole('button', { name: 'Remove floorplan' })).toBeVisible();

	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const raw = localStorage.getItem('aetherax:project');
					if (!raw) return null;
					const project = JSON.parse(raw) as {
						floors: Array<{
							id: string;
							floorplanUrl?: string | null;
							walls?: unknown[];
							planningArea?: unknown;
							surfaces?: unknown[];
							notes?: unknown[];
						}>;
						aps: Array<{ floorId: string }>;
					};
					const floor = project.floors.find((item) => item.id === 'f2');
					return {
						walls: floor?.walls?.length ?? 0,
						planningArea: Array.isArray(floor?.planningArea)
							? (floor.planningArea as unknown[]).length
							: 0,
						surfaces: floor?.surfaces?.length ?? 0,
						notes: floor?.notes?.length ?? 0,
						apsOnTarget: project.aps.filter((ap) => ap.floorId === 'f2').length
					};
				}),
			{ timeout: 20_000 }
		)
		.toEqual({ walls: 1, planningArea: 3, surfaces: 1, notes: 1, apsOnTarget: 0 });
});
