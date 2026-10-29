import { test, expect, type Page } from '@playwright/test';

/**
 * Getting a floorplan *into* the app, which had no test at all.
 *
 * "The interface is there but nothing loads" is what a user says when one of these
 * three paths fails, and none of them was covered: the e2e suite seeded a project
 * into `localStorage` and worked from there, so the sample plans, the floorplan
 * import and the project round trip were only ever exercised by hand. The first is
 * what the welcome screen offers a new user; the other two are File → Open Project
 * and Import Floorplan.
 */

/** Dismiss the welcome dialog, which covers the canvas for the first half second. */
async function dismissWelcome(page: Page): Promise<void> {
	const overlay = page.locator('[aria-label="Welcome to Aetherax"]');
	await expect(overlay).toBeVisible({ timeout: 10_000 });
	await page.getByRole('button', { name: 'Get Started' }).click();
	await expect(overlay).toBeHidden();
}

/** Painted pixels on the canvas: an empty grid is a few thousand, a plan is far more. */
async function paintedPixels(page: Page): Promise<number> {
	return page.evaluate(() => {
		const canvas = document.querySelector('canvas');
		const ctx = canvas?.getContext('2d');
		if (!canvas || !ctx) return -1;
		const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
		let lit = 0;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i]! + data[i + 1]! + data[i + 2]! > 120) lit++;
		}
		return lit;
	});
}

test('a sample floorplan loads from the welcome screen', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await dismissWelcome(page);

	const before = await paintedPixels(page);
	await page.locator('.sample-btn', { hasText: 'Apartment' }).first().click();
	// Wall detection is OCR and takes seconds; the floorplan itself is drawn at once,
	// which is what this asserts.
	await page.waitForTimeout(12_000);

	expect(await paintedPixels(page)).toBeGreaterThan(before * 4);
	await expect(page.getByText('Floorplan loaded')).toBeVisible();
});

test('importing a floorplan file loads it', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await dismissWelcome(page);

	const before = await paintedPixels(page);
	// Any real image will do: the app decodes what it is handed and treats the dark
	// pixels as walls.
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 600;
		canvas.height = 400;
		const ctx = canvas.getContext('2d')!;
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, 600, 400);
		ctx.strokeStyle = '#000000';
		ctx.lineWidth = 12;
		ctx.strokeRect(6, 6, 588, 388);
		ctx.beginPath();
		ctx.moveTo(300, 6);
		ctx.lineTo(300, 394);
		ctx.stroke();
		return canvas.toDataURL('image/png').split(',')[1]!;
	});

	// Hand the input a real `File` from inside the page. Doing it here rather than
	// through `setInputFiles` keeps the spec free of Node globals: the e2e specs are
	// typechecked by svelte-check with the app's tsconfig, which has no Node types,
	// and `Buffer`/`node:fs` in a spec are compile errors even though Playwright
	// itself runs in Node.
	await page.evaluate((base64: string) => {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*="png"]');
		if (!input) throw new Error('no floorplan file input');
		const transfer = new DataTransfer();
		transfer.items.add(new File([bytes], 'my-plan.png', { type: 'image/png' }));
		input.files = transfer.files;
		input.dispatchEvent(new Event('change', { bubbles: true }));
	}, png);
	await page.waitForTimeout(15_000);
	expect(await paintedPixels(page)).toBeGreaterThan(before * 4);
	await expect(page.getByText('Floorplan loaded')).toBeVisible();

	/*
	 * The import also detects the walls, and the detection has to survive.
	 *
	 * A floor whose segment list is empty is exactly the case a detected raster mask exists for;
	 * the mask was being emptied by the segment sync on the way in, so an import drew a plan with
	 * no walls on it and Re-detect walls appeared to do nothing.
	 */
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const raw = localStorage.getItem('aetherax:project');
					if (!raw) return 0;
					const project = JSON.parse(raw) as {
						floors?: Array<{ wallMask?: { dataUrl?: string } | null }>;
					};
					return project.floors?.[0]?.wallMask?.dataUrl?.length ?? 0;
				}),
			{ timeout: 20_000 }
		)
		.toBeGreaterThan(1000);
});

test('a saved project round-trips through File → Save and Open', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto('/');
	await page.waitForSelector('canvas');
	await dismissWelcome(page);

	await page.locator('.sample-btn', { hasText: 'Apartment' }).first().click();
	await page.waitForTimeout(12_000);

	await page.getByRole('button', { name: 'File' }).click();
	const download = page.waitForEvent('download', { timeout: 15_000 });
	await page.getByText('Export Project File...', { exact: true }).click();
	const file = await download;
	// The download's own path is what the import is given back: no Node globals in the
	// spec, and it is closer to what a user does than re-reading the bytes.
	const savedPath = await file.path();
	expect(savedPath).toBeTruthy();

	// Wipe the stored project so the import is the only thing that can put a plan
	// back, then reload: this is the state a returning user is in.
	await page.evaluate(() => localStorage.removeItem('aetherax:project'));
	await page.reload();
	await page.waitForSelector('canvas');
	await dismissWelcome(page).catch(() => undefined);
	const before = await paintedPixels(page);

	await page.getByRole('button', { name: 'File' }).click();
	const chooser = page.waitForEvent('filechooser', { timeout: 10_000 });
	await page.getByText('Open Project...', { exact: true }).click();
	await (await chooser).setFiles(savedPath!);
	await page.waitForTimeout(10_000);

	expect(await paintedPixels(page)).toBeGreaterThan(before * 4);
	await expect(page.getByText('Floorplan loaded')).toBeVisible();
});
