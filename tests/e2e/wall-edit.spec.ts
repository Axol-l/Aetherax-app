import { test, expect, type Page } from '@playwright/test';
import {
	setupCleanState,
	enablePlaceMode,
	savedWallPixels,
	waitForDetectedWalls,
	SAMPLE_PLAN_TIMEOUT_MS
} from './helpers';

interface StoredFloor {
	wallMask?: { dataUrl: string; width: number; height: number } | null;
	floorplanOffsetX?: number;
	floorplanOffsetY?: number;
}

async function storedFloors(page: Page): Promise<StoredFloor[]> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		if (!raw) return [];
		return (JSON.parse(raw) as { floors?: unknown[] }).floors ?? [];
	}) as Promise<StoredFloor[]>;
}

/** Type a value into the Floorplan tab's Align X / Align Y field. */
async function fillAlign(page: Page, axis: 'x' | 'y', metres: string): Promise<void> {
	const row = page.locator('.prop-row').filter({ hasText: `Align ${axis.toUpperCase()}` });
	await row.locator('input[type="number"]').fill(metres);
	await row.locator('input[type="number"]').blur();
}

/**
 * Move the plan floor above an added empty one, and stay on it.
 *
 * The alignment controls need a floor *below* the one being moved, so they are not
 * offered on the bottom floor, and a test that aligns a floor needs its floor to be
 * the upper one. Reordering rather than importing the sample a second time keeps
 * this test free of the OCR pass — the walls are already there from the file's
 * setup, and a second detection would only add another fixed wait.
 *
 * Returns the index of the aligned (now upper) floor for `savedWallPixels`.
 */
async function moveFloorAboveAnEmptyOne(page: Page): Promise<number> {
	await page.locator('.floor-pill.add').click();
	await page.waitForTimeout(400);
	// `handleAddFloor` switches to the new floor; go back to the one with the plan.
	await page.locator('.floor-pill:not(.add)').first().click();
	await page.waitForTimeout(400);
	// On the bottom floor only the "move up" action exists beside delete.
	await page.locator('.floor-pill.active .floor-action:not(.delete)').click();
	await page.waitForTimeout(500);
	return 1;
}

test.describe('Wall editing', () => {
	test.describe.configure({ timeout: SAMPLE_PLAN_TIMEOUT_MS });
	test.beforeEach(async ({ page }) => {
		await setupCleanState(page);
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.getByRole('tab', { name: 'Floorplan' }).click();
		await page.waitForTimeout(300);
		// Match the name, not the area: the label's unit follows the ft/m switch.
		await page.locator('.sample-btn', { hasText: 'Apartment' }).click();
		await waitForDetectedWalls(page);
	});

	test('Edit Walls button enters edit mode with toolbar', async ({ page }) => {
		// Click Edit Walls
		await page.getByText('Edit Walls').click();
		await page.waitForTimeout(300);

		// Toolbar should appear with Erase, Draw, Material, Done
		const toolbar = page.locator('.wall-toolbar');
		await expect(toolbar).toBeVisible();
		await expect(toolbar.locator('text=Erase')).toBeVisible();
		await expect(toolbar.locator('text=Draw')).toBeVisible();
		await expect(toolbar.locator('text=Material')).toBeVisible();
		await expect(toolbar.locator('text=Done')).toBeVisible();

		await page.screenshot({ path: 'test-results/wall-edit/edit-mode.png' });

		// Click Done exits edit mode
		await toolbar.locator('text=Done').click();
		await page.waitForTimeout(300);
		await expect(toolbar).not.toBeVisible();
	});

	test('erase then draw walls, then place AP', async ({ page }) => {
		await page.screenshot({ path: 'test-results/wall-edit/01-before-edit.png' });

		// Enter edit mode
		await page.getByText('Edit Walls').click();
		await page.waitForTimeout(300);

		// Erase some walls (drag across a wall area)
		const canvas = page.locator('canvas');
		await canvas.click({ position: { x: 300, y: 120 } });
		await page.waitForTimeout(200);
		await page.screenshot({ path: 'test-results/wall-edit/02-after-erase.png' });

		// Switch to Draw mode
		await page.locator('.wall-toolbar').locator('text=Draw').click();
		await page.waitForTimeout(200);

		// Draw some wall pixels
		await canvas.click({ position: { x: 400, y: 300 } });
		await page.waitForTimeout(200);
		await page.screenshot({ path: 'test-results/wall-edit/03-after-draw.png' });

		// Done
		await page.locator('.wall-toolbar').locator('text=Done').click();
		await page.waitForTimeout(500);

		// Place an AP — should work normally after exiting edit mode
		await enablePlaceMode(page);
		await canvas.click({ position: { x: 300, y: 250 } });
		await page.waitForTimeout(500);
		await expect(page.locator('input[aria-label="AP name"]')).toBeVisible();
		await page.screenshot({ path: 'test-results/wall-edit/04-ap-after-edit.png' });
	});

	test('material paint mode shows material picker', async ({ page }) => {
		await page.getByText('Edit Walls').click();
		await page.waitForTimeout(300);

		// Switch to Material mode
		await page.locator('.wall-toolbar').locator('text=Material').click();
		await page.waitForTimeout(200);

		// Material picker dots should appear — one chip per WALL_MATERIALS entry
		// (Drywall, Wood, Glass, Brick, Concrete, Metal, Virtual Partition).
		const matPicker = page.locator('.row-bottom');
		await expect(matPicker).toBeVisible();
		await expect(matPicker.locator('.mat-chip')).toHaveCount(8);

		await page.screenshot({ path: 'test-results/wall-edit/material-paint-mode.png' });

		// Done
		await page.locator('.wall-toolbar').locator('text=Done').click();
	});

	test('full sequence: edit walls → paint material → place APs → re-edit', async ({ page }) => {
		// 1. Edit walls - erase a spot
		await page.getByText('Edit Walls').click();
		const canvas = page.locator('canvas');
		await canvas.click({ position: { x: 200, y: 120 } });

		// 2. Switch to material mode and paint
		await page.locator('.wall-toolbar').locator('text=Material').click();
		await page.waitForTimeout(200);
		await canvas.click({ position: { x: 300, y: 120 } });

		// 3. Done
		await page.locator('.wall-toolbar').locator('text=Done').click();
		await page.waitForTimeout(500);

		// 4. Place 2 APs
		await canvas.click({ position: { x: 300, y: 200 } });
		await canvas.click({ position: { x: 500, y: 350 } });
		await page.waitForTimeout(1000);

		// 5. Edit walls again - should work
		await page.getByRole('tab', { name: 'Floorplan' }).click();
		await page.waitForTimeout(300);
		await page.getByText('Edit Walls').click();
		await expect(page.locator('.wall-toolbar')).toBeVisible();
		await page.locator('.wall-toolbar').locator('text=Done').click();
	});

	/**
	 * Regression: an aligned floor's walls used to vanish on the first edit.
	 *
	 * Aligning a floor is a world-space translation, the offset is kept as a world
	 * origin for the wall mask, and it is not a whole number of pixels. A mask
	 * written at a fractional origin silently drops every pixel (a typed array
	 * ignores a fractional index), so the editor was handed an all-zero raster — and
	 * the first erase materialised and saved that blank raster over the detected
	 * walls. Reported as "erasing one wall makes every wall on the floor disappear".
	 *
	 * The aligned floor is the upper one: the control is not offered on the bottom
	 * floor, whose offset would be a shift of the building's own reference frame.
	 */
	test('an aligned floor keeps its walls through an edit', async ({ page }) => {
		const aligned = await moveFloorAboveAnEmptyOne(page);
		await fillAlign(page, 'x', '0.137');
		await fillAlign(page, 'y', '0.211');
		await page.waitForTimeout(2500);

		const offsets = (await storedFloors(page)).map((f) => f.floorplanOffsetX ?? 0);
		// The state under test really is a fractional offset — otherwise this test
		// proves nothing. `metres * worldUnitsPerMetre` is only whole by accident.
		expect(offsets[aligned]! % 1 !== 0).toBe(true);

		const before = await savedWallPixels(page, aligned);
		expect(before).toBeGreaterThan(1000);

		await page.getByText('Edit Walls').click();
		await page.waitForTimeout(300);
		await page.locator('canvas').click({ position: { x: 320, y: 200 } });
		await page.waitForTimeout(300);
		await page.locator('.wall-toolbar').locator('text=Done').click();
		await page.waitForTimeout(2500);

		// One brush dab cannot remove the plan; a blank mask is what it looked like.
		expect(await savedWallPixels(page, aligned)).toBeGreaterThan(before * 0.5);
	});

	/**
	 * Regression: "Clear all" left the floor uneditable.
	 *
	 * Clearing the mask left it with no pixels and no frame, so it materialised to
	 * null — which every consumer reads as "this floor has no floorplan". The editor
	 * included: it dropped the mask and swallowed every later stroke in silence.
	 */
	test('Clear all walls keeps the floor editable', async ({ page }) => {
		await page.getByText('Edit Walls').click();
		await page.waitForTimeout(300);
		await page.locator('.wall-toolbar').locator('text=Clear all').click();
		await page.waitForTimeout(300);
		await page.getByRole('button', { name: 'Clear walls' }).click();
		await page.waitForTimeout(2500);

		// The walls are gone, but the mask is still there — an empty raster.
		expect(await savedWallPixels(page)).toBe(0);
		await expect(page.locator('.wall-toolbar')).toBeVisible();

		// And drawing into it works, which is the part that used to fail.
		await page.locator('.wall-toolbar').locator('text=Draw').click();
		await page.waitForTimeout(200);
		await page.locator('canvas').click({ position: { x: 300, y: 250 } });
		await page.waitForTimeout(300);
		await page.locator('.wall-toolbar').locator('text=Done').click();
		await page.waitForTimeout(2500);

		expect(await savedWallPixels(page)).toBeGreaterThan(0);
	});
});
