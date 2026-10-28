/**
 * A material belongs to a wall, not to the pixels under it.
 *
 * The old version of this file drove the paint brush: enter edit mode, pick the
 * material tool, dab, done. There is no brush any more, so the whole matrix runs
 * through the popup on a drawn segment — which is a stricter test, because what it
 * asserts is the wall's own field and the mask that was derived from it.
 *
 * Seeded geometry, and the wall is drawn by clicking twice on the canvas: the
 * midpoint of those two clicks is on the segment by construction, so nothing here
 * depends on where the camera put the plan.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupCleanState } from './helpers';

/** Draw one wall across the middle of the canvas, and leave the tool. */
async function drawWall(page: Page): Promise<void> {
	// A blank project has no plan and no mask, so there is no frame to draw into yet;
	// this creates one and arms the wall tool.
	await page.getByRole('button', { name: 'Draw from Scratch' }).click();
	await page.waitForTimeout(400);
	const canvas = page.locator('canvas');
	const box = (await canvas.boundingBox())!;
	const y = Math.round(box.height * 0.5);
	await canvas.click({ position: { x: 300, y } });
	await canvas.click({ position: { x: 620, y } });
	await page.getByRole('button', { name: 'Done' }).click();
	await page.waitForTimeout(400);
}

/** The first wall's material, as saved. */
async function savedWallMaterial(page: Page): Promise<number | undefined> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		if (!raw) return undefined;
		return (
			JSON.parse(raw) as { floors?: Array<{ walls?: Array<{ material?: number }> }> }
		).floors?.[0]?.walls?.[0]?.material;
	});
}

test.describe('Wall materials', () => {
	test.beforeEach(async ({ page }) => {
		await setupCleanState(page);
		await page.goto('/');
		await page.waitForSelector('canvas');
		await page.getByRole('tab', { name: 'Floorplan' }).click();
		await drawWall(page);
	});

	test('right-clicking a drawn wall offers every material', async ({ page }) => {
		const canvas = page.locator('canvas');
		await canvas.click({ button: 'right', position: { x: 450, y: (await canvas.boundingBox())!.height * 0.5 } });

		const popup = page.locator('.popup');
		await expect(popup).toBeVisible();
		// One row per material: the eight built-ins, since no custom one exists yet.
		await expect(popup.locator('.material-row')).toHaveCount(8);
		await expect(popup).toContainText('Drywall');
		await expect(popup).toContainText('Concrete');
		await expect(popup).toContainText('Virtual Partition');

		await page.keyboard.press('Escape');
		await expect(popup).not.toBeVisible();
	});

	test('choosing a material writes it to the wall', async ({ page }) => {
		const canvas = page.locator('canvas');
		await canvas.click({ button: 'right', position: { x: 450, y: (await canvas.boundingBox())!.height * 0.5 } });
		await page.locator('.popup').getByText('Brick', { exact: true }).click();

		// Brick is id 3.
		await expect.poll(() => savedWallMaterial(page), { timeout: 20_000 }).toBe(3);
	});

	test('a custom material can be added and used', async ({ page }) => {
		const canvas = page.locator('canvas');
		await canvas.click({ button: 'right', position: { x: 450, y: (await canvas.boundingBox())!.height * 0.5 } });
		const popup = page.locator('.popup');

		// The add form is collapsed until asked for; a custom material is not a built-in
		// entry, so this is the only way it can appear in the list.
		await popup.getByRole('button', { name: /Custom material/ }).click();
		await popup.getByPlaceholder(/Lead-lined door|e\.g\./).fill('Test board');
		await popup.getByRole('button', { name: 'Add', exact: true }).click();

		// Adding it selects it, so the wall is already painted with it; its id is the first
		// custom one.
		await expect.poll(() => savedWallMaterial(page), { timeout: 20_000 }).toBe(100);
		await expect
			.poll(
				async () =>
					page.evaluate(() => {
						const raw = localStorage.getItem('aetherax:project');
						return raw
							? (
									JSON.parse(raw) as { customMaterials?: Array<{ name: string }> }
								).customMaterials?.[0]?.name
							: undefined;
					}),
				{ timeout: 20_000 }
			)
			.toBe('Test board');

		// And it is in the list when the popup is reopened, not just in the one render that
		// created it.
		await page.keyboard.press('Escape');
		await canvas.click({ button: 'right', position: { x: 450, y: (await canvas.boundingBox())!.height * 0.5 } });
		await expect(page.locator('.popup')).toContainText('Test board');
	});
});
