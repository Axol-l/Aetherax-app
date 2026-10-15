import { test, expect } from '@playwright/test';
import { setupCleanState, enablePlaceMode } from './helpers';

test.describe('Solver', () => {
	test.beforeEach(async ({ page }) => {
		await setupCleanState(page);
		await page.goto('/');
		await page.waitForSelector('canvas');
	});

	test('auto-solve assigns channels to placed APs', async ({ page }) => {
		// Place 3 APs close together so they interfere
		await enablePlaceMode(page);
		const canvas = page.locator('canvas');
		await canvas.click({ position: { x: 300, y: 300 } });
		await canvas.click({ position: { x: 350, y: 300 } });
		await canvas.click({ position: { x: 325, y: 350 } });

		// Auto-solve should run; go to AP list and check channels assigned
		await page.waitForTimeout(2000);
		await page.getByText('All APs').click();
		await page.waitForTimeout(500);

		// At least one AP should have a channel number visible
		const apRows = page.locator('.row .channel:not(.unassigned)');
		await expect(apRows.first()).toBeVisible();
	});

	test('the automatic 2.4 GHz assignment only uses non-overlapping channels', async ({ page }) => {
		// Four close 2.4 GHz APs in a small plan. Before B3 the solver was handed all
		// eleven permitted channels and treated them as mutually independent, so it
		// gave four APs four *distinct* numbers — a plan that claims every pair is
		// fine while 1 and 2 overlap almost completely, and which left the optimiser's
		// interference term with nothing to score on an unpinned plan.
		await page.addInitScript(() => {
			localStorage.setItem('aetherax:welcomed', '1');
			localStorage.removeItem('aetherax:project');
			const c = document.createElement('canvas');
			c.width = 600;
			c.height = 400;
			const ctx = c.getContext('2d')!;
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, 600, 8);
			ctx.fillRect(0, 392, 600, 8);
			ctx.fillRect(0, 0, 8, 400);
			ctx.fillRect(592, 0, 8, 400);
			localStorage.setItem(
				'aetherax:project',
				JSON.stringify({
					version: 3,
					name: 'Palette',
					band: '2.4ghz',
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
						}
					],
					aps: [
						{ x: 260, y: 180 },
						{ x: 300, y: 180 },
						{ x: 260, y: 220 },
						{ x: 300, y: 220 }
					].map((p, i) => ({
						id: `ap${i + 1}`,
						name: `AP-${i + 1}`,
						x: p.x,
						y: p.y,
						floorId: 'f1',
						band: '2.4ghz',
						channelWidth: 20,
						fixedChannel: null,
						assignedChannel: null,
						interferenceRadius: 1414,
						power: 20,
						modelId: null,
						modelLabel: null
					}))
				})
			);
		});
		await page.goto('/');
		await page.waitForSelector('canvas');
		// The solver runs on load, debounced. Read the channels from the AP list
		// rather than from the saved project: the save is debounced too, so the
		// persisted copy lags the assignment the user is actually looking at.
		await page.waitForTimeout(3000);
		await page.getByRole('tab', { name: 'APs' }).click();
		await page.waitForTimeout(500);

		const channels = (await page.locator('.row .channel').allInnerTexts())
			.map((t) => Number(t.replace(/\D/g, '')))
			.filter((n) => Number.isFinite(n));
		expect(channels).toHaveLength(4);
		// 1, 6 and 11 are the only 2.4 GHz channels that do not overlap each other, so
		// they are the only ones an automatic assignment may use. Four APs and three
		// channels means one *must* be reused — which is the channel scarcity that
		// makes joint placement and assignment worth doing at all, and which the
		// optimiser's interference term could not see while the solver was handing out
		// eleven mutually-overlapping channels as if they were independent.
		expect(channels.every((c) => [1, 6, 11].includes(c))).toBe(true);
		expect(new Set(channels).size).toBeLessThanOrEqual(3);
	});

	test('a mixed-width plan uses the whole band, not just the widest palette', async ({ page }) => {
		// Three 80 MHz APs and one 20 MHz AP, all close enough to conflict with each
		// other. The non-DFS 5 GHz palette at 80 MHz is exactly {36, 149, 165}, so a
		// palette-only assignment has nothing left for the fourth AP and makes it share
		// a channel completely. The band is not actually that full: at 20 MHz there are
		// centres clear of both 80 MHz spans, and the interval model may use them. This
		// is the palette approximation B3's second stage removes.
		const WIDTHS = [80, 80, 80, 20];
		const CHANNELS_5 = [36, 149, 165];
		await page.addInitScript(
			(arg: { widths: number[] }) => {
				localStorage.setItem('aetherax:welcomed', '1');
				localStorage.removeItem('aetherax:project');
				const c = document.createElement('canvas');
				c.width = 600;
				c.height = 400;
				const ctx = c.getContext('2d')!;
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, 600, 8);
				ctx.fillRect(0, 392, 600, 8);
				ctx.fillRect(0, 0, 8, 400);
				ctx.fillRect(592, 0, 8, 400);
				const floorId = 'f1';
				localStorage.setItem(
					'aetherax:project',
					JSON.stringify({
						version: 3,
						name: 'Mixed widths',
						band: '5ghz',
						channelWidth: 80,
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
							}
						],
						aps: [
							{ x: 280, y: 180 },
							{ x: 320, y: 180 },
							{ x: 280, y: 220 },
							{ x: 320, y: 220 }
						].map((p, i) => ({
							id: `ap${i + 1}`,
							name: `AP-${i + 1}`,
							x: p.x,
							y: p.y,
							floorId,
							band: '5ghz',
							channelWidth: arg.widths[i],
							fixedChannel: null,
							assignedChannel: null,
							interferenceRadius: 980,
							power: 20,
							modelId: null,
							modelLabel: null
						}))
					})
				);
			},
			{ widths: WIDTHS }
		);
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.waitForTimeout(3000);
		await page.getByRole('tab', { name: 'APs' }).click();
		await page.waitForTimeout(500);

		const channels = (await page.locator('.row .channel').allInnerTexts())
			.map((t) => Number(t.replace(/\D/g, '')))
			.filter((n) => Number.isFinite(n));
		expect(channels).toHaveLength(4);
		console.log(`[solver] 3x80 MHz + 1x20 MHz assigned ${channels.join(', ')}`);

		const frequencyOf = (number: number): number => {
			const table: Record<number, number> = {
				36: 5180,
				40: 5200,
				44: 5220,
				48: 5240,
				149: 5745,
				153: 5765,
				157: 5785,
				161: 5805,
				165: 5825
			};
			return table[number] ?? NaN;
		};
		const spans = channels.map((n, i) => {
			const f = frequencyOf(n);
			return [f - WIDTHS[i]! / 2, f + WIDTHS[i]! / 2];
		});
		// The property that matters: no two of these APs, which all conflict with each
		// other, may share spectrum.
		for (let i = 0; i < spans.length; i++) {
			for (let j = i + 1; j < spans.length; j++) {
				const shared =
					Math.min(spans[i]![1]!, spans[j]![1]!) - Math.max(spans[i]![0]!, spans[j]![0]!);
				expect(shared, `channels ${channels[i]} and ${channels[j]}`).toBeLessThanOrEqual(0);
			}
		}
		// And the palette alone could not have produced that: three of the four APs are
		// 80 MHz wide and the widest-width palette has exactly three centres, so
		// pairwise-clear channels for all four need one channel outside it. Which AP
		// takes it is the walk order's business, not a modelling choice.
		expect(channels.every((c) => Number.isFinite(frequencyOf(c)))).toBe(true);
		expect(channels.some((c) => !CHANNELS_5.includes(c))).toBe(true);
	});
});
