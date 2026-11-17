import { test, expect, type Page } from '@playwright/test';
import { setupCleanState } from './helpers';

/**
 * Co-channel interference in the placement objective.
 *
 * Two access points on the same channel, close enough that one is within the
 * 10 dB reuse distance of the other over most of the plan. The optimiser must
 * both *score* that (the weight is a project setting, and zero restores the
 * coverage-only objective) and *report* it, because the figure is the other half
 * of what the objective trades off and a number the user can act on.
 *
 * The scenario is deliberately a small room: one 2.4 GHz AP already covers it, so
 * spreading the pair apart costs no coverage and reducing interference is the
 * only improvement available. See MODEL_NOTES.md §6 for the measurement.
 */

const CHANNEL = 1;

async function seedCoChannelPair(page: Page, weight: number): Promise<void> {
	await page.addInitScript(
		(arg: { channel: number; weight: number }) => {
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
					name: 'Co-channel pair',
					band: '2.4ghz',
					channelWidth: 20,
					regulatoryDomain: 'fcc',
					unitSystem: 'metric',
					ispSpeed: 0,
					targetThroughput: 25,
					allowOutsideRooms: false,
					clientHeight: 1.5,
					heatmapRssiFloor: -70,
					interferenceWeight: arg.weight,
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
						{ x: 220, y: 300 },
						{ x: 280, y: 320 }
					].map((p, i) => ({
						id: `ap${i + 1}`,
						name: `AP-${i + 1}`,
						x: p.x,
						y: p.y,
						floorId,
						band: '2.4ghz',
						channelWidth: 20,
						// Pinned, so the pair really is co-channel: without this the
						// solver spreads them over the eleven *overlapping* 2.4 GHz
						// channels and no two APs ever share one.
						fixedChannel: arg.channel,
						assignedChannel: arg.channel,
						interferenceRadius: 1414,
						power: 20,
						modelId: null,
						modelLabel: null
					}))
				})
			);
		},
		{ channel: CHANNEL, weight }
	);
}

/**
 * The two figures one optimiser run reports, read off its console line.
 *
 * They are deliberately not on the coverage panel any more: they are per-plan model outputs
 * rather than things you steer, the weight that trades them against coverage is in the
 * optimiser settings, and the PDF cover repeats them for the record. The run's line is
 * therefore the interface this test reads, and it is the same string the measurement suite
 * parses — one format, two consumers.
 */
interface ReportedRun {
	sir: number;
	cca: number;
	/** False when the figure is the all-co-channel bound rather than a real assignment. */
	known: boolean;
}

function parseRunLine(text: string): ReportedRun | null {
	const hit = /co-channel interference ([\d.]+)%, contended \(CCA\) ([\d.]+)%/.exec(text);
	if (!hit) return null;
	return {
		sir: Number(hit[1]),
		cca: Number(hit[2]),
		known: !text.includes('all-co-channel bound')
	};
}

/**
 * The panel must not carry the two interference readings.
 *
 * Asserted rather than assumed: they were on this panel once, and a change that puts them
 * back would otherwise only fail wherever a reading happened to be non-zero.
 */
async function expectInterferenceOffThePanel(page: Page): Promise<void> {
	await expect(page.locator('.metric', { hasText: 'Co-channel' })).toHaveCount(0);
	await expect(page.locator('.metric', { hasText: 'airtime' })).toHaveCount(0);
}

/**
 * Two 5 GHz APs at 80 MHz, pinned 20 MHz apart: 36 and 40 share 60 of their 80 MHz.
 *
 * This is the case B3's first stage could not see. That stage made the *palette*
 * non-overlapping so that "same channel number" meant "interferes", which is right
 * for anything the planner chooses itself and wrong for anything the user pins:
 * 36 and 40 are different numbers and overlap by 75%, and the panel used to report
 * 0% for them.
 */
async function seedOverlappingPair(page: Page): Promise<void> {
	await page.addInitScript(
		(arg: { channels: [number, number] }) => {
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
					name: 'Overlapping 80 MHz pair',
					band: '5ghz',
					channelWidth: 80,
					regulatoryDomain: 'fcc',
					unitSystem: 'metric',
					ispSpeed: 0,
					targetThroughput: 25,
					allowOutsideRooms: false,
					clientHeight: 1.5,
					heatmapRssiFloor: -70,
					interferenceWeight: 0.2,
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
						{ x: 280, y: 200 },
						{ x: 360, y: 200 }
					].map((p, i) => ({
						id: `ap${i + 1}`,
						name: `AP-${i + 1}`,
						x: p.x,
						y: p.y,
						floorId,
						band: '5ghz',
						channelWidth: 80,
						fixedChannel: arg.channels[i],
						assignedChannel: arg.channels[i],
						// Rewritten from the power on load; 20 dBm at 5 GHz derives ~980 px.
						interferenceRadius: 980,
						power: 20,
						modelId: null,
						modelLabel: null
					}))
				})
			);
		},
		{ channels: [36, 40] as [number, number] }
	);
}

test('a pinned partial overlap is measured, not called clean', async ({ page }) => {
	test.setTimeout(180_000);
	await setupCleanState(page);

	let reported: ReportedRun | null = null;
	const finished = new Promise<void>((resolve) => {
		page.on('console', (m) => {
			const line = m.text();
			if (!/\[optimizer\] seed \d+/.test(line)) return;
			reported = parseRunLine(line);
			resolve();
		});
	});

	await seedOverlappingPair(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(3000);

	await page.getByRole('button', { name: /optimize (placement|all floors)/i }).click();
	await finished;

	// 36 and 40 at 80 MHz share three quarters of their spectrum, and the pinned
	// pair cannot be separated by any colouring, so the term has something to
	// report. Before the interval model this read 0%: the two numbers differ, and
	// "a different number means no interference" was the whole test.
	expect(reported).not.toBeNull();
	const { sir: interference, cca: contention, known } = reported!;
	console.log(`[interference] pinned 80 MHz pair 36/40 reports ${interference}%`);
	expect(interference).toBeGreaterThan(10);

	// The other half of the picture, and the one this pair illustrates best: two
	// pinned APs at 80 MHz on 36 and 40 are both above the CCA threshold almost
	// everywhere on the floor, so stations defer to each other across all of it —
	// 100%, where the relative figure above is only a fraction. Reported, not
	// optimised: see `ROADMAP.md` B4/B5.
	console.log(`[interference] pinned 80 MHz pair 36/40 is contended over ${contention}%`);
	expect(contention).toBeGreaterThan(interference);
	// Both APs have a channel here, so the figure is a measurement rather than the
	// all-co-channel bound.
	expect(known).toBe(true);
	await expectInterferenceOffThePanel(page);
});

test('reports co-channel interference, and scores it against coverage', async ({ page }) => {
	test.setTimeout(180_000);
	await setupCleanState(page);

	// The optimiser logs one line when a run finishes, with the seed so the run is
	// repeatable. The panel's coverage readout updates in real time, so its presence
	// says nothing about whether a run has happened — this does.
	let reported: ReportedRun | null = null;
	const finished = new Promise<void>((resolve) => {
		page.on('console', (m) => {
			const line = m.text();
			if (!/\[optimizer\] seed \d+/.test(line)) return;
			reported = parseRunLine(line);
			resolve();
		});
	});

	await seedCoChannelPair(page, 0.2);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(3000);

	// The weight is in the optimiser settings, and it is what makes the term
	// reachable for a Pareto curve rather than one baked-in operating point.
	await page.getByRole('button', { name: 'Placement optimiser settings' }).click();
	await page.waitForTimeout(200);
	await expect(
		page.locator('.settings-popup .slider-row', { hasText: 'Interference' }).locator('input')
	).toBeVisible();

	await page.getByRole('button', { name: /optimize (placement|all floors)/i }).click();
	await finished;

	// A co-channel pair this close cannot be interference-free, and the figure is
	// reported rather than left at the sentinel.
	expect(reported).not.toBeNull();
	expect(reported!.sir).toBeGreaterThan(0);
	// A real assignment rather than the all-co-channel bound: every AP has a channel here.
	expect(reported!.known).toBe(true);
	await expectInterferenceOffThePanel(page);
});

test('the interference figures stay off the panel, before and after a run', async ({ page }) => {
	// They used to be two more bars here, reading 0% on most plans — which reads as
	// "nothing to see" rather than "nothing wrong". The figures are reported by the run's
	// console line and repeated on the PDF cover; the panel carries coverage and the
	// building block. This pins both states, because a row that never appeared would pass
	// a test that only checked the absent case.
	test.setTimeout(180_000);
	await setupCleanState(page);
	await seedCoChannelPair(page, 0.2);
	await page.goto('/');
	await page.waitForSelector('canvas');
	// Long enough for the live coverage estimator to have run: coverage is up, so the
	// panel is rendered and the only thing missing is the interference figures.
	await page.waitForTimeout(4000);
	// The coverage reading is there once a plan exists, and stays the only metric row.
	await expect(page.locator('.metric').first()).toBeVisible();
	await expectInterferenceOffThePanel(page);

	let reported: ReportedRun | null = null;
	const finished = new Promise<void>((resolve) => {
		page.on('console', (m) => {
			const line = m.text();
			if (!/\[optimizer\] seed \d+/.test(line)) return;
			reported = parseRunLine(line);
			resolve();
		});
	});
	await page.getByRole('button', { name: /optimize (placement|all floors)/i }).click();
	await finished;

	// Measured — and still off the panel, which is the point.
	expect(reported).not.toBeNull();
	await expectInterferenceOffThePanel(page);
});

test('the scarce-channel warning counts non-overlapping channels', async ({ page }) => {
	// 2.4 GHz permits eleven channels and only three do not overlap. The warning is
	// about the latter: eleven usable channels is not the regime where joint
	// placement and assignment pays. See ROADMAP.md B2/B3.
	await setupCleanState(page);
	await seedCoChannelPair(page, 0);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(3000);

	await expect(page.locator('.channel-warning')).toContainText('3 non-overlapping channels', {
		timeout: 15_000
	});
});
