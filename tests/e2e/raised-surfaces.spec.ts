/**
 * Raised surfaces: a mezzanine, a stair, a ramp.
 *
 * The shape is a fact about a floor that a plan cannot state, and the model now reads it:
 * a client inside one is measured from its own walking surface. This spec is about the
 * part a user does — draw it, see it, persist it, remove it — and about the two heights
 * meaning what the card says they mean. The height field itself is unit-tested in
 * `rf/surface-height.test.ts`, where a rectangle can be read without a canvas.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupCleanState } from './helpers';

/** The saved project's first floor, as the app last wrote it. */
async function savedFloor(page: Page): Promise<{
	surfaces?: Array<{
		kind: string;
		ax: number;
		ay: number;
		bx: number;
		by: number;
		heightM: number;
		topHeightM: number;
		attenuationDb?: number;
		material?: string;
		thicknessM?: number;
	}>;
}> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		if (!raw) return {};
		return (JSON.parse(raw) as { floors?: Array<Record<string, unknown>> }).floors?.[0] ?? {};
	});
}

/** Draw one surface with the tool, using two clicks on the canvas. */
async function drawSurface(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Draw raised area' }).click();
	const canvas = page.locator('canvas');
	const box = (await canvas.boundingBox())!;
	await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.3 } });
	await canvas.click({ position: { x: box.width * 0.65, y: box.height * 0.6 } });
	// The surface tool's own Done, inside its card.
	await page
		.locator('.planning-area')
		.filter({ hasText: 'Raised surfaces' })
		.getByRole('button', { name: 'Done' })
		.click();
	await page.waitForTimeout(400);
}

test.describe('Raised surfaces', () => {
	test.beforeEach(async ({ page }) => {
		await setupCleanState(page);
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.getByRole('tab', { name: 'Floorplan' }).click();
		/*
		 * A blank project has no plan and no frame, and the floor-editing cards appear with
		 * one. "Draw from Scratch" is what makes it — it also arms the wall tool, which is
		 * a mode and is left before anything else is drawn.
		 */
		await page.getByRole('button', { name: 'Draw from Scratch' }).click();
		await page.waitForTimeout(300);
		// The wall tool has its own Done in the toolbar now; this one leaves that tool.
		await page.getByRole('toolbar', { name: 'Wall tools' }).getByRole('button', { name: 'Done' }).click();
		await page.waitForTimeout(300);
	});

	test('right-click cancels a half-drawn surface and leaves the tool armed', async ({ page }) => {
		await page.getByRole('button', { name: 'Draw raised area' }).click();
		const canvas = page.locator('canvas');
		const box = (await canvas.boundingBox())!;
		await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.3 } });
		await expect(page.getByText('Click the opposite corner.')).toBeVisible();

		await canvas.click({
			button: 'right',
			position: { x: box.width * 0.35, y: box.height * 0.3 }
		});
		await expect(page.getByText('Click one corner of the raised area, then the other.')).toBeVisible();
		expect((await savedFloor(page)).surfaces?.length ?? 0).toBe(0);
	});

	test('a platform is drawn, saved and counted', async ({ page }) => {
		await drawSurface(page);

		await expect.poll(
			async () => (await savedFloor(page)).surfaces?.length ?? 0,
			{ timeout: 20_000 }
		).toBe(1);
		const surface = (await savedFloor(page)).surfaces![0]!;
		expect(surface.kind).toBe('platform');
		// A platform is level: one height, not two that happen to be equal.
		expect(surface.heightM).toBeCloseTo(2);
		expect(surface.topHeightM).toBeCloseTo(2);
		// The rectangle is the two clicks, in world units.
		expect(Math.abs(surface.bx - surface.ax)).toBeGreaterThan(1);
		expect(Math.abs(surface.by - surface.ay)).toBeGreaterThan(1);
	});

	test('a stair carries a rise, and the card derives its steps', async ({ page }) => {
		await page.getByRole('button', { name: 'Stair', exact: true }).click();
		// The rise is a parameter like any other now, and the step count follows from it.
		const upper = page.locator('.param-row', { hasText: 'Upper height' });
		await expect(upper).toBeVisible();
		await upper.locator('input').fill('3.5');
		await upper.locator('input').blur();
		// 1.5 m of rise at the standard 0.3 m tread is five steps.
		await expect(page.locator('.param-row', { hasText: 'N of steps' })).toContainText('5');

		await drawSurface(page);

		await expect.poll(
			async () => (await savedFloor(page)).surfaces?.length ?? 0,
			{ timeout: 20_000 }
		).toBe(1);
		const surface = (await savedFloor(page)).surfaces![0]!;
		expect(surface.kind).toBe('stair');
		expect(surface.heightM).toBeCloseTo(2);
		expect(surface.topHeightM).toBeCloseTo(3.5);
		// The deck's own parameters travel with it: they are what the 3D view and the
		// attenuation test read.
		expect(surface.attenuationDb).toBeCloseTo(15);
		expect(surface.thicknessM).toBeCloseTo(0.2);
	});

	test('a selected surface is removed with Delete', async ({ page }) => {
		await drawSurface(page);
		// Drawing it selected it, so the delete key has a target without another click.
		await page.keyboard.press('Delete');
		await expect.poll(
			async () => (await savedFloor(page)).surfaces?.length ?? 0,
			{ timeout: 20_000 }
		).toBe(0);
	});

	test('a selected surface is edited from the card, not redrawn', async ({ page }) => {
		await drawSurface(page);
		/*
		 * Drawing leaves the deck selected, but the card is the drawing card until the tool
		 * is left. Clicking the outline after Done is the gesture from the report: the card
		 * has to switch from "the next surface" to "this one".
		 */
		const canvas = page.locator('canvas');
		const box = (await canvas.boundingBox())!;
		await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.45 } });

		const card = page
			.locator('.planning-area')
			.filter({ hasText: 'Editing the selected raised area' });
		await expect(card).toBeVisible();

		// The deck's own material, not the next deck's: Steel writes its 30 dB into the deck.
		await card.locator('.select-wrapper .trigger').click();
		await page.getByRole('option', { name: 'Steel' }).click();
		await expect(card.locator('.param-row', { hasText: 'Attenuation' })).toContainText('30 dB');

		// A platform has one height; editing it keeps the level pair equal.
		const height = card.locator('.param-row', { hasText: 'Height' }).locator('input');
		await height.fill('4');
		await height.blur();
		const thickness = card.locator('.param-row', { hasText: 'Thickness' }).locator('input');
		await thickness.fill('0.35');
		await thickness.blur();

		await expect
			.poll(async () => (await savedFloor(page)).surfaces?.[0]?.material, { timeout: 20_000 })
			.toBe('steel');
		await expect
			.poll(async () => (await savedFloor(page)).surfaces?.[0]?.attenuationDb)
			.toBeCloseTo(30);
		await expect
			.poll(async () => (await savedFloor(page)).surfaces?.[0]?.heightM)
			.toBeCloseTo(4);
		await expect
			.poll(async () => (await savedFloor(page)).surfaces?.[0]?.topHeightM)
			.toBeCloseTo(4);
		await expect
			.poll(async () => (await savedFloor(page)).surfaces?.[0]?.thicknessM)
			.toBeCloseTo(0.35);

		// Removing this deck from its own editor ends the selection with it.
		await card.getByRole('button', { name: 'Delete raised area' }).click();
		await expect(page.getByText('Editing the selected raised area')).toHaveCount(0);
		await expect
			.poll(async () => (await savedFloor(page)).surfaces?.length ?? 0, { timeout: 20_000 })
			.toBe(0);
	});

	test('the surface is painted on the plan and removed with Delete', async ({ page }) => {
		const coloured = async () =>
			page.evaluate(() => {
				const c = document.querySelector('canvas') as HTMLCanvasElement;
				const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
				let n = 0;
				for (let i = 0; i < d.length; i += 4) {
					const r = d[i]!;
					const g = d[i + 1]!;
					const b = d[i + 2]!;
					// The surface tint is amber: red above green above blue, and not the
					// near-black of the plan.
					if (r > 90 && r > g + 20 && g > b + 10) n++;
				}
				return n;
			});

		const before = await coloured();
		await drawSurface(page);
		await page.waitForTimeout(600);
		const after = await coloured();
		await page.screenshot({ path: 'test-results/surfaces/drawn.png' });
		expect(after).toBeGreaterThan(before + 500);

		await page.keyboard.press('Delete');
		await page.waitForTimeout(600);
		expect(await coloured()).toBeLessThan(after * 0.4);
	});

	test('the toolbar picks the deck material, and the loss follows it', async ({ page }) => {
		await page.getByRole('button', { name: 'Draw raised area' }).click();
		const toolbar = page.getByRole('toolbar', { name: 'Raised surfaces' });
		await expect(toolbar).toBeVisible();

		// The bar's material control is one button opening a list, like the wall tool's.
		await toolbar.locator('.material').click();
		await page.getByRole('option', { name: 'Steel' }).click();
		await page.screenshot({ path: 'test-results/surfaces/material-card.png' });
		// A preset's loss is its own, so the field is a readout and not an input.
		const attenuation = page.locator('.param-row', { hasText: 'Attenuation' });
		await expect(attenuation).toContainText('30 dB');
		await expect(attenuation.locator('input')).toHaveCount(0);

		const canvas = page.locator('canvas');
		const box = (await canvas.boundingBox())!;
		await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.3 } });
		await canvas.click({ position: { x: box.width * 0.65, y: box.height * 0.6 } });
		// Done in the floating bar ends the tool; the card's own Done is the same action.
		await toolbar.getByRole('button', { name: 'Done' }).click();

		await expect.poll(
			async () => (await savedFloor(page)).surfaces?.length ?? 0,
			{ timeout: 20_000 }
		).toBe(1);
		const surface = (await savedFloor(page)).surfaces![0]!;
		expect(surface.material).toBe('steel');
		expect(surface.attenuationDb).toBeCloseTo(30);
		await page.screenshot({ path: 'test-results/surfaces/material-drawn.png' });
		await expect(toolbar).toHaveCount(0);
	});
});
