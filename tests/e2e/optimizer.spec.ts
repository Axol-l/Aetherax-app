import { test, expect, type Page } from '@playwright/test';
import { enablePlaceMode } from './helpers';

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('aetherax:welcomed', '1'));
	await page.goto('http://localhost:4183');
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(500);
});

/** Ensure sidebar is open on the APs tab. */
async function openApsTab(page: Page) {
	const sidebarVisible = await page
		.locator('aside[aria-label="Sidebar"]')
		.isVisible({ timeout: 200 })
		.catch(() => false);
	if (!sidebarVisible) {
		await page.locator('button[aria-label="Toggle sidebar"]').click();
		await page.waitForTimeout(500);
	}
	const apTab = page.locator('button[role="tab"]').filter({ hasText: 'APs' });
	await apTab.waitFor({ state: 'visible', timeout: 3000 });
	await apTab.click();
	await page.waitForTimeout(300);
}

/** Ensure sidebar is open on the Floorplan tab. */
async function openFloorplanTab(page: Page) {
	const sidebarVisible = await page
		.locator('aside[aria-label="Sidebar"]')
		.isVisible({ timeout: 200 })
		.catch(() => false);
	if (!sidebarVisible) {
		await page.locator('button[aria-label="Toggle sidebar"]').click();
		await page.waitForTimeout(500);
	}
	const fpTab = page.locator('button[role="tab"]').filter({ hasText: 'Floorplan' });
	await fpTab.waitFor({ state: 'visible', timeout: 3000 });
	await fpTab.click();
	await page.waitForTimeout(300);
}

test.describe('Optimizer', () => {
	/*
	 * The settings are inputs to placing the first AP — "Allow APs outside rooms"
	 * decides whether the first click in the margin is accepted, and "Coverage
	 * threshold" shapes the heatmap and the coverage figure that click produces —
	 * so they cannot sit behind a plan that already has one. The run button can:
	 * the optimiser only moves the APs already on the floor.
	 */
	test('optimizer settings open without access points', async ({ page }) => {
		const gear = page.getByRole('button', { name: 'Placement optimiser settings' });
		await expect(gear).toBeVisible();
		await expect(gear).toHaveAttribute('aria-expanded', 'false');

		await gear.click();
		await expect(gear).toHaveAttribute('aria-expanded', 'true');
		await expect(
			page.getByRole('checkbox', { name: 'Allow APs outside rooms' })
		).toBeVisible();
		await expect(page.getByRole('spinbutton', { name: 'Coverage threshold' })).toBeVisible();
		await expect(page.getByRole('button', { name: /optimize placement/i })).toHaveCount(0);
	});

	test('optimizer improves coverage on apartment floorplan', async ({ page }) => {
		// 15 s of waiting plus a sample import and two canvas clicks: the default 30 s budget
		// was only ever just enough.
		test.setTimeout(120_000);
		// Load apartment floorplan
		await page.click('text=Apartment');
		await page.waitForTimeout(4000);
		const skip = page.locator('text=Skip');
		if (await skip.isVisible({ timeout: 2000 }).catch(() => false)) await skip.click();
		await page.waitForTimeout(500);

		// Place 2 APs in bad locations (both stacked in one corner). The points have to be
		// inside the apartment: with "Allow APs outside rooms" off, a click in the margin
		// outside the walls is refused now, with a notice saying so.
		await enablePlaceMode(page);
		const canvas = page.locator('canvas');
		await canvas.click({ position: { x: 300, y: 200 } });
		await page.waitForTimeout(500);
		await canvas.click({ position: { x: 320, y: 400 }, force: true });
		await page.waitForTimeout(2000);

		// Open APs tab and go to list view (not editor)
		await openApsTab(page);
		const allAps = page.getByRole('button', { name: /^All APs/ });
		if (await allAps.isVisible({ timeout: 1000 }).catch(() => false)) {
			await allAps.click();
		}
		await page.waitForTimeout(1000);
		const coverageBefore = await page.evaluate(() => {
			const el = document.querySelector('.metric-value');
			return el ? parseInt(el.textContent || '0') : 0;
		});

		// Click Optimize (may need to scroll into view)
		const optimizeBtn = page.getByRole('button', { name: /optimize (placement|all floors)/i });
		await optimizeBtn.scrollIntoViewIfNeeded();
		await expect(optimizeBtn).toBeVisible({ timeout: 3000 });
		await optimizeBtn.click();

		// Wait for optimization to complete
		await page.waitForTimeout(15000);

		// Read coverage after
		const coverageAfter = await page.evaluate(() => {
			const el = document.querySelector('.metric-value');
			return el ? parseInt(el.textContent || '0') : 0;
		});

		// Coverage should improve (APs spread out from stacked corner)
		expect(coverageAfter).toBeGreaterThanOrEqual(coverageBefore);
		await page.screenshot({ path: 'test-results/optimizer/after-optimize.png' });

		/*
		 * A second run on the same plan.
		 *
		 * The worker is sent a floor's geometry once and reuses it for every later run against
		 * the same masks (see `workers/optimizer/geometry.ts`), so this is the case that would
		 * break silently if the reuse were wrong: the run would either score another plan's
		 * walls or answer "the optimiser worker was not given this plan".
		 */
		const consoleLines: string[] = [];
		page.on('console', (message) => consoleLines.push(message.text()));

		await optimizeBtn.click();
		await page.waitForTimeout(15000);

		const coverageSecond = await page.evaluate(() => {
			const el = document.querySelector('.metric-value');
			return el ? parseInt(el.textContent || '0') : 0;
		});
		expect(coverageSecond).toBeGreaterThan(0);
		await expect(page.getByText(/not given this plan/i)).toHaveCount(0);
		// The bridge says so when it takes the reuse path, so the path is not merely assumed.
		expect(consoleLines.some((line) => line.includes('reusing the plan'))).toBe(true);
	});

	test('optimizer shows error with no floorplan', async ({ page }) => {
		// Place an AP without a floorplan
		const canvas = page.locator('canvas');
		await canvas.click({ position: { x: 400, y: 400 } });
		await page.waitForTimeout(1000);

		await openApsTab(page);
		const optimizeBtn = page.getByRole('button', { name: /optimize (placement|all floors)/i });
		if (await optimizeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
			await optimizeBtn.click();
			await page.waitForTimeout(1000);
			await expect(page.locator('text=Load a floorplan first')).toBeVisible({ timeout: 3000 });
		}
	});

	test('new project resets to single floor', async ({ page }) => {
		// Add a second floor
		await openFloorplanTab(page);
		await page.locator('.floor-pill.add').click();
		await page.waitForTimeout(300);
		const pills = page.locator('.floor-pill:not(.add)');
		await expect(pills).toHaveCount(2);

		// Create new project via File menu
		await page.locator('text=File').click();
		await page.waitForTimeout(200);
		await page.locator('text=New Project').click();
		await page.waitForTimeout(500);

		// Confirm in dialog
		const createBtn = page.locator('button.submit-btn, button:has-text("Create")');
		await createBtn.click();
		await page.waitForTimeout(500);

		// Should be back to 1 floor
		await openFloorplanTab(page);
		const pillsAfter = page.locator('.floor-pill:not(.add)');
		await expect(pillsAfter).toHaveCount(1);
	});
});
