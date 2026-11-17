/**
 * Sidebar cards keep their fold state across the Floorplan / APs switch.
 *
 * The two panels are branches of one `{#if}`, so switching unmounts the other side. A card
 * that kept its fold in a local `$state` came back expanded; the fold lives in a shared
 * module-level store now, and this is the assertion that it survives the round trip.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupCleanState } from './helpers';

/** One floor whose walls make the Floorplan card render, with no APs on it. */
const PROJECT = {
	version: 3,
	name: 'sidebar',
	band: '5ghz',
	channelWidth: 20,
	regulatoryDomain: 'fcc',
	unitSystem: 'metric',
	ispSpeed: 0,
	targetThroughput: 25,
	allowOutsideRooms: true,
	clientHeight: 1.5,
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
			calibration: { worldUnitsPerMeter: 10 },
			floorplanBoundary: null,
			wallMask: null,
			wallAttenuation: 5,
			wallMaterial: 0,
			materialMask: null,
			roomTypeMask: null,
			roomDensityOverrides: {},
			roomCustomLabels: {},
			walls: [
				{ id: 'w1', ax: 100, ay: 100, bx: 300, by: 100, material: 3 },
				{ id: 'w2', ax: 300, ay: 100, bx: 300, by: 250, material: 3 },
				{ id: 'w3', ax: 300, ay: 250, bx: 100, by: 250, material: 3 },
				{ id: 'w4', ax: 100, ay: 250, bx: 100, by: 100, material: 3 }
			],
			notes: [],
			planningArea: null,
			surfaces: []
		}
	],
	aps: []
};

async function seed(page: Page): Promise<void> {
	await setupCleanState(page);
	await page.addInitScript((project) => {
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.setItem('aetherax:project', JSON.stringify(project));
	}, PROJECT);
}

test('a folded card stays folded when the panel is switched', async ({ page }) => {
	await seed(page);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await page.waitForTimeout(1200);

	const card = page.locator('.planning-area').first();
	const fold = card.locator('.card-collapse');
	const copyLayout = page.getByRole('button', { name: /Copy layout/ });
	await expect(fold).toHaveAttribute('aria-expanded', 'true');
	await expect(copyLayout).toBeVisible();

	await fold.click();
	await expect(fold).toHaveAttribute('aria-expanded', 'false');
	await expect(copyLayout).toHaveCount(0);

	await page.getByRole('tab', { name: 'APs' }).click();
	await page.waitForTimeout(300);
	await page.getByRole('tab', { name: 'Floorplan' }).click();
	await page.waitForTimeout(300);

	const foldAgain = page.locator('.planning-area').first().locator('.card-collapse');
	await expect(foldAgain).toHaveAttribute('aria-expanded', 'false');
	await expect(copyLayout).toHaveCount(0);

	// And it still opens: the state is shared, not stuck shut.
	await foldAgain.click();
	await expect(copyLayout).toBeVisible();
});
