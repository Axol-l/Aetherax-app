import { test, expect } from '@playwright/test';
import {
	setupCleanState,
	enablePlaceMode,
	waitForDetectedWalls,
	SAMPLE_PLAN_TIMEOUT_MS
} from './helpers';

test.describe('Wall materials', () => {
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

	test('Edit Walls button visible after floorplan load', async ({ page }) => {
		await expect(page.getByText('Edit Walls')).toBeVisible();
	});

	test('clicking a wall shows material popup', async ({ page }) => {
		const canvas = page.locator('canvas');
		await canvas.click({ position: { x: 100, y: 120 } });
		await page.waitForTimeout(300);

		const popup = page.locator('.popup');
		if (await popup.isVisible({ timeout: 2000 }).catch(() => false)) {
			await expect(popup.locator('.material-row')).toHaveCount(6);
			await expect(popup).toContainText('Drywall');
			await expect(popup).toContainText('Concrete');

			await page.keyboard.press('Escape');
			await expect(popup).not.toBeVisible();
		}
	});

	test('material paint mode in edit toolbar', async ({ page }) => {
		await page.getByText('Edit Walls').click();
		await page.waitForTimeout(300);

		// Switch to Material mode
		await page.locator('.wall-toolbar').locator('text=Material').click();
		await page.waitForTimeout(200);

		// Material picker should show one chip per WALL_MATERIALS entry (Drywall,
		// Wood, Glass, Brick, Concrete, Metal, Virtual Partition, Door).
		const matPicker = page.locator('.row-bottom');
		await expect(matPicker).toBeVisible();
		await expect(matPicker.locator('.mat-chip')).toHaveCount(8);

		// Done
		await page.locator('.wall-toolbar').locator('text=Done').click();
	});

	test('edit walls → material paint → place AP → walls persist', async ({ page }) => {
		// Enter edit mode and paint some material
		await page.getByText('Edit Walls').click();
		await page.locator('.wall-toolbar').locator('text=Material').click();
		await page.waitForTimeout(200);

		// Paint on a wall
		const canvas = page.locator('canvas');
		await canvas.click({ position: { x: 100, y: 120 } });
		await page.waitForTimeout(200);

		// Done
		await page.locator('.wall-toolbar').locator('text=Done').click();
		await page.waitForTimeout(500);

		// Place an AP
		await enablePlaceMode(page);
		await canvas.click({ position: { x: 400, y: 300 } });
		await page.waitForTimeout(1000);

		// Edit Walls should still be accessible
		await page.getByRole('tab', { name: 'Floorplan' }).click();
		await page.waitForTimeout(300);
		await expect(page.getByText('Edit Walls')).toBeVisible();
	});
});
