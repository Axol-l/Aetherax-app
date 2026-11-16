import { test, expect, type Page } from '@playwright/test';

/**
 * A1's per-floor guarantee, enforced by A2's block-coordinate run.
 *
 * "No floor below X%" is not something a weighted sum can say, and A1 says so — but the
 * ε-constraint F3 added *can* say it one floor at a time, and one floor at a time is exactly
 * what a block of the alternating run sees.
 *
 * **The weakest-floor retry is automatic, and bounded.**
 * The floor is applied per block: an all-floor run scores one floor at a time, so
 * "coverage ≥ X" is always that block's own floor. The retry is a separate, budgeted loop
 * because inside a pass nobody knows which floor is weakest until every floor has been
 * scored. Each pass draws new seeds, because a deterministic search re-run on the same
 * layout and seeds only replays itself — see `state/optimizer-floor-passes.ts`.
 *
 * The scene is two storeys with deliberately unequal floors: a small 12 m floor that two APs
 * cover well and a wide 30 m floor they do not. So the weakest floor is predetermined, and a
 * reachable requirement can be put on it — a scene that could not meet the requirement at all
 * would make "the gap closed" untestable.
 *
 * The run's end is detected by the **number of blocks that reported a result**, not by a
 * particular sentence appearing: each floor optimisation prints exactly one seed line.
 */

const BLOCKS = 4;

async function seedTwoFloors(page: Page, opts: { floorPct: number }): Promise<void> {
	await page.addInitScript((arg: { floorPct: number }) => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.removeItem('aetherax:project');
		const mask = (w: number, h: number): string => {
			const c = document.createElement('canvas');
			c.width = w;
			c.height = h;
			const ctx = c.getContext('2d')!;
			// White is wall and transparent is passable, as `encodeMask` writes it. Filling the
			// canvas white first inverted the plan: the room became wall and the frame floor.
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, w, 8);
			ctx.fillRect(0, h - 8, w, 8);
			ctx.fillRect(0, 0, 8, h);
			ctx.fillRect(w - 8, 0, 8, h);
			return c.toDataURL('image/png');
		};
		const floor = (id: string, name: string, level: number, size: { w: number; h: number }) => ({
			id,
			name,
			level,
			ceilingHeight: 3,
			floorMaterial: 1,
			floorThickness: 0.2,
			floorplanScale: 1,
			floorplanOffsetX: 0,
			floorplanOffsetY: 0,
			calibration: null,
			floorplanBoundary: null,
			wallMask: {
				dataUrl: mask(size.w, size.h),
				width: size.w,
				height: size.h,
				originX: 0,
				originY: 0
			},
			wallAttenuation: 5,
			wallMaterial: 0,
			materialMask: null,
			roomTypeMask: null,
			roomDensityOverrides: {},
			roomCustomLabels: {}
		});
		const ap = (id: string, x: number, y: number, floorId: string) => ({
			id,
			name: id,
			x,
			y,
			floorId,
			band: '5ghz',
			channelWidth: 20,
			fixedChannel: null,
			assignedChannel: null,
			interferenceRadius: 700,
			power: 8,
			modelId: null,
			modelLabel: null
		});
		localStorage.setItem(
			'aetherax:project',
			JSON.stringify({
				version: 3,
				name: 'Per-floor floor',
				band: '5ghz',
				channelWidth: 20,
				regulatoryDomain: 'fcc',
				unitSystem: 'metric',
				ispSpeed: 0,
				targetThroughput: 25,
				allowOutsideRooms: false,
				clientHeight: 1.5,
				heatmapRssiFloor: -70,
				interferenceWeight: 0,
				coverageSoftnessDb: 0,
				coverageFloorPct: arg.floorPct,
				floors: [
					floor('f1', 'Floor 1', 0, { w: 400, h: 400 }),
					floor('f2', 'Floor 2', 1, { w: 1000, h: 500 })
				],
				// Floor 2's pair starts **clustered in the middle** on purpose. Spread along the
				// floor's axis it is already at a local optimum, so the enforcement pass would have
				// nothing to repair and the test could not tell "the pass works" from "the pass ran".
				aps: [
					ap('ap1', 120, 200, 'f1'),
					ap('ap2', 280, 200, 'f1'),
					ap('ap3', 460, 250, 'f2'),
					ap('ap4', 560, 250, 'f2')
				]
			})
		);
	}, opts);
}

/**
 * Run the all-floor optimiser, wait for the expected number of blocks, and wait for the run
 * itself to end before returning the console lines.
 */
async function optimizeAllFloors(page: Page, blocks: number): Promise<string[]> {
	const lines: string[] = [];
	page.on('console', (m) => lines.push(m.text()));
	const blockLines = (): number => lines.filter((l) => l.includes('[optimizer] seed ')).length;

	await page.getByRole('button', { name: 'Optimize all floors' }).click();
	await expect.poll(blockLines, { timeout: 420_000 }).toBeGreaterThanOrEqual(blocks);
	await expect(page.getByRole('button', { name: 'Cancel' })).toBeHidden({ timeout: 180_000 });
	return lines;
}

test('the weakest floor is retried on fresh seeds, within a budget', async ({ page }) => {
	test.setTimeout(900_000);
	await seedTwoFloors(page, { floorPct: 75 });
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(4000);

	// Four blocks for the loop, then at least one retry for the weakest floor.
	const lines = await optimizeAllFloors(page, BLOCKS + 1);
	const joined = lines.join('\n');
	console.log(
		joined
			.split('\n')
			.filter((l) => l.includes('[optimizer] seed') || l.includes('per-floor floor'))
			.join('\n')
	);

	// The mechanism fired, named the weak floor, and reported where it ended up.
	expect(joined).toMatch(/per-floor floor: .* is at \d+%, below the 75% requirement/);
	expect(joined).toMatch(/per-floor floor: .* now at \d+%/);

	const starts = [
		...joined.matchAll(/is at (\d+)%, below the 75% requirement — pass (\d+)\/2/g)
	];
	const ends = [...joined.matchAll(/now at (\d+)% \(pass (\d+)\/2\)/g)];
	expect(starts.length).toBeGreaterThanOrEqual(1);
	expect(starts.length).toBeLessThanOrEqual(2);
	expect(ends.length).toBe(starts.length);
	// Pass numbers count up from 1: a third pass is over budget, a repeat is a bug.
	expect(starts.map((m) => m[2])).toEqual(starts.map((_, i) => String(i + 1)));

	// A retry must explore new seeds. Replaying the seeds the alternating loop already used
	// reproduces its result exactly, which is what this mechanism used to do — the block it
	// paid for could not change anything.
	const seeds = lines
		.filter((l) => l.includes('[optimizer] seed '))
		.map((l) => Number(/seed (\d+)/.exec(l)?.[1]));
	expect(seeds.length).toBeGreaterThanOrEqual(BLOCKS + 1);
	expect(seeds[BLOCKS]).not.toBe(seeds[0]);
	if (starts.length === 2) {
		expect(seeds[BLOCKS + 1]).not.toBe(seeds[BLOCKS]);
	}

	// A second retry only follows a pass that actually lifted the floor.
	if (starts.length === 2) {
		expect(Number(starts[1]![1])).toBeGreaterThan(Number(starts[0]![1]));
	}

	// No retry lowers the panel number: the worker keeps its input layout when the search
	// scores worse, and with the interference weight at 0 the score is monotone in coverage.
	for (let i = 0; i < ends.length; i++) {
		expect(Number(ends[i]![1])).toBeGreaterThanOrEqual(Number(starts[i]![1]));
	}
	console.log(
		starts.map((s, i) => `${s[1]}% -> ${ends[i]?.[1]}%`).join(', ') +
			` (${starts.length} retry pass(es), seeds ${seeds.slice(BLOCKS).join(', ')})`
	);

	// The run must state how the retries ended, and must not claim a floor it did not reach.
	expect(joined).toMatch(
		/per-floor floor: .* (?:requirement is met|no gain, stopping|budget spent|produced no result, stopping)/
	);
	const met = /reached (\d+)% — the 75% requirement is met/.exec(joined);
	if (met) {
		expect(Number(met[1])).toBeGreaterThanOrEqual(75);
	} else {
		expect(Number(ends.at(-1)?.[1])).toBeLessThan(75);
	}

	// The badge under "Whole building" reads the project's requirement, not a fixed 70%, so a
	// floor that fell short of it has to look like a warning. Paired with the next test, where
	// the same ~53% floor clears a 5% requirement: the old constant could not tell them apart.
	await expect(page.locator('.worst')).toHaveClass(/below/);
});

test('says so and spends nothing when the requirement is already met', async ({ page }) => {
	test.setTimeout(600_000);
	await seedTwoFloors(page, { floorPct: 5 });
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(4000);

	const lines = await optimizeAllFloors(page, BLOCKS);
	const joined = lines.join('\n');

	expect(joined).toContain('at or above the 5% requirement');
	expect(joined).not.toContain('with it as the ε');
	expect(lines.filter((l) => l.includes('[optimizer] seed ')).length).toBe(BLOCKS);

	// The weakest floor is around 53%: below the old hard-coded 70, above this project's 5%.
	// The badge must follow the requirement and stay neutral, or the two tests disagree.
	await expect(page.locator('.worst')).not.toHaveClass(/below/);
});

test('the building row follows an all-floor run, not the first render', async ({ page }) => {
	test.setTimeout(600_000);
	await seedTwoFloors(page, { floorPct: 0 });
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(4000);

	// One floor has been measured — the one on screen — so the building card is a one-floor
	// average until the all-floor run has measured the other storey.
	const meta = page.locator('.building-meta');
	await expect(meta).toBeVisible();
	console.log('building meta before the run: ' + ((await meta.textContent()) ?? '').trim());

	await optimizeAllFloors(page, BLOCKS);

	// The bug this pins: `floorCoverage` was a plain `Map`, which is invisible to `$derived`.
	// The per-floor figures moved with every block, and the building row — the mean, the weakest
	// floor and the measured count, all derived from that cache — stayed at whatever it read on
	// the first render. A count is the honest assertion here: the mean depends on each floor's
	// sample count, while "both storeys are measured" is exactly what the run changed.
	await expect(meta).toContainText('2 floors measured');
	await expect(page.locator('.building-value')).not.toHaveText('0%');
	await expect(page.locator('.worst')).toContainText('at');
	// No requirement is set (0 = off), so there is nothing to judge the weakest floor against:
	// it is a number, not a warning. A fixed 70% would paint it either way.
	await expect(page.locator('.worst')).not.toHaveClass(/below/);
	console.log('building meta after the run: ' + ((await meta.textContent()) ?? '').trim());
});
