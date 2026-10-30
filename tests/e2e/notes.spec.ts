import { test, expect, type Page } from '@playwright/test';
import { waitForSavedProject } from './helpers';

/**
 * The notes card in the floorplan panel.
 *
 * Notes are the one part of the plan that is pure prose: no geometry, no model, just a
 * sentence attached to a spot. The card that lists and edits them is now its own component
 * (`FloorplanNotes.svelte`), and nothing else in the suite would notice if it stopped
 * rendering — the sidebar would still load, just without the card.
 *
 * The card only renders on a floor that has a plan, so the seed gives it a one-pixel
 * underlay; the note itself is what the assertions are about.
 */

const ONE_PIXEL_PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function seedNote(page: Page): Promise<void> {
	await page.addInitScript(
		(arg: { png: string }) => {
			localStorage.setItem('aetherax:welcomed', '1');
			localStorage.removeItem('aetherax:project');
			localStorage.setItem(
				'aetherax:project',
				JSON.stringify({
					version: 3,
					name: 'Notes',
					band: '5ghz',
					channelWidth: 20,
					regulatoryDomain: 'fcc',
					unitSystem: 'metric',
					floors: [
						{
							id: 'f1',
							name: 'Floor 1',
							level: 0,
							ceilingHeight: 3,
							floorThickness: 0.2,
							floorMaterial: 1,
							floorplanUrl: arg.png,
							floorplanImage: arg.png,
							floorplanScale: 1,
							floorplanOffsetX: 0,
							floorplanOffsetY: 0,
							calibration: { worldUnitsPerMeter: 40 },
							floorplanBoundary: null,
							wallMask: null,
							wallAttenuation: 5,
							wallMaterial: 0,
							materialMask: null,
							roomTypeMask: null,
							roomDensityOverrides: {},
							roomCustomLabels: {},
							notes: [{ id: 'n1', x: 40, y: 40, text: 'steel door' }]
						}
					],
					aps: []
				})
			);
		},
		{ png: ONE_PIXEL_PNG }
	);
}

test('a note is listed, edited and deleted from the floorplan panel', async ({ page }) => {
	await seedNote(page);
	await page.goto('/');
	await page.waitForSelector('canvas');

	// The Notes card lists the floor's notes; the row is the note's text.
	const row = page.getByRole('button', { name: 'steel door' });
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.click();

	// Selecting it opens the editor, prefilled.
	const editor = page.locator('textarea.note-input');
	await expect(editor).toHaveValue('steel door');
	await editor.fill('steel door — 2 h fire rating');
	await editor.blur();

	await waitForSavedProject(
		page,
		(project) => project.floors[0]?.notes?.[0]?.text === 'steel door — 2 h fire rating'
	);

	// Deleting clears the list and the selection.
	await page.getByRole('button', { name: 'Delete note' }).click();
	await expect(page.locator('textarea.note-input')).toBeHidden();
	await waitForSavedProject(page, (project) => (project.floors[0]?.notes ?? []).length === 0);
});
