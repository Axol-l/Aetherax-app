/**
 * Verify the packaged desktop application, not the browser build.
 *
 * Tauri's webview exposes a DevTools endpoint when WebView2 is started with
 * `--remote-debugging-port`, so a plain Playwright CDP connection can drive the real
 * window: seed a project into the webview's own local storage, run the optimiser (which
 * is a **module worker** compiled from a workspace package — the single riskiest part of
 * a Tauri port), and read back what it stored.
 *
 * Windows only, and only against a running build:
 *
 *   pnpm tauri build
 *   powershell -File scripts\verify-desktop.mjs   # launches, checks, closes
 *
 * Set AETHORAX_EXE to point at another executable.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

const EXE =
	process.env.AETHORAX_EXE ??
	'src-tauri/target/release/aetherax.exe';
const PORT = 9222;

if (!existsSync(EXE)) {
	throw new Error(`No application at ${EXE} — run "pnpm tauri build" first.`);
}

/** The same 400x400 walled room the e2e specs seed, in the app's project format. */
const project = {
	version: 3,
	name: 'Desktop check',
	band: '5ghz',
	channelWidth: 20,
	regulatoryDomain: 'fcc',
	unitSystem: 'metric',
	ispSpeed: 0,
	targetThroughput: 25,
	allowOutsideRooms: false,
	clientHeight: 1.5,
	heatmapRssiFloor: -70,
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
			calibration: { worldUnitsPerMeter: 32.8084, areaSqm: 150 },
			floorplanBoundary: null,
			// A 10 px border of wall, as a 1-bit PNG the app can decode.
			wallMask: null,
			wallAttenuation: 5,
			wallMaterial: 0,
			materialMask: null,
			roomTypeMask: null,
			roomDensityOverrides: {},
			roomCustomLabels: {}
		}
	],
	aps: [
		{
			id: 'ap0',
			name: 'AP-1',
			x: 200,
			y: 200,
			floorId: 'f1',
			band: '5ghz',
			channelWidth: 20,
			fixedChannel: null,
			assignedChannel: null,
			interferenceRadius: 1300,
			power: 20,
			modelId: null,
			modelLabel: null,
			mount: 'wall',
			mountHeightM: 2,
			facingDeg: 0,
			beamwidthDeg: 60,
			aimDeg: 0,
			pinned: false
		}
	]
};

console.log(`Launching ${EXE} with the DevTools port open…`);
const app = spawn(EXE, [], {
	env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
	stdio: 'ignore',
	detached: false
});

let failures = 0;
const check = (name, ok, detail = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures++;
};

try {
	// WebView2 needs a moment to open the port; it is up when the JSON endpoint answers.
	let pages = null;
	for (let attempt = 0; attempt < 40 && !pages; attempt++) {
		await new Promise((r) => setTimeout(r, 500));
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
			const list = await res.json();
			pages = list.filter((p) => p.type === 'page');
		} catch {
			/* not listening yet */
		}
	}
	if (!pages || pages.length === 0) throw new Error('The webview never opened a DevTools page.');

	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
	const context = browser.contexts()[0];
	const page = context.pages()[0] ?? (await context.waitForEvent('page'));

	await page.waitForSelector('canvas', { timeout: 30_000 });
	check('the planner renders in the desktop webview', true, await page.title());

	// A wall mask is a PNG data URL; build one in the page and store the project with it.
	await page.evaluate(async (seed) => {
		const c = document.createElement('canvas');
		c.width = 400;
		c.height = 400;
		const ctx = c.getContext('2d');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, 400, 10);
		ctx.fillRect(0, 390, 400, 10);
		ctx.fillRect(0, 0, 10, 400);
		ctx.fillRect(390, 0, 10, 400);
		seed.floors[0].wallMask = {
			dataUrl: c.toDataURL('image/png'),
			width: 400,
			height: 400,
			originX: 0,
			originY: 0
		};
		localStorage.setItem('aetherax:welcomed', '1');
		localStorage.setItem('aetherax:project', JSON.stringify(seed));
	}, project);

	await page.reload();
	await page.waitForSelector('canvas', { timeout: 30_000 });
	await page.waitForTimeout(2500);

	// The optimiser runs in a module worker that imports a workspace package: if the
	// port broke worker loading under the Tauri protocol, this is where it shows.
	await page.getByRole('button', { name: 'Optimize placement' }).click();
	await page
		.getByText('Optimizing…', { exact: false })
		.waitFor({ state: 'visible', timeout: 30_000 });
	check('the optimiser worker starts', true);

	await page
		.getByText('Optimizing…', { exact: false })
		.waitFor({ state: 'hidden', timeout: 180_000 });
	check('the optimiser worker finishes', true);
	await page.waitForTimeout(3000);

	const saved = await page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		return raw ? JSON.parse(raw) : null;
	});
	const ap = saved?.aps?.[0];
	const moved = Math.hypot((ap?.x ?? 200) - 200, (ap?.y ?? 200) - 200);
	check('the result was written back to the webview store', moved > 0, `moved ${moved.toFixed(0)} units`);
	const edge = Math.min(ap?.x ?? 0, ap?.y ?? 0, 400 - (ap?.x ?? 0), 400 - (ap?.y ?? 0));
	check('a wall mount was placed on a wall', edge > 8 && edge < 20, `edge ${edge.toFixed(1)}`);

	// Not under test-results: Playwright empties that directory at the start of every
	// run, so a screenshot kept there survives only until the next e2e run.
	await page.screenshot({ path: 'docs/screenshots/desktop-window.png' });
	console.log('screenshot: docs/screenshots/desktop-window.png');

	await browser.close();
} finally {
	app.kill();
}

console.log(failures === 0 ? '\nAll desktop checks passed.' : `\n${failures} desktop check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
