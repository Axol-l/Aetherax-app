/**
 * Helpers shared by the visual specs.
 *
 * Not a spec itself: Playwright collects `*.spec.ts`, so this file is imported rather
 * than run.
 */
import type { Page } from '@playwright/test';

/**
 * The saved wall mask's data URL, as a value that changes when the mask is replaced.
 *
 * The URL itself rather than a pixel count: decoding a mask per poll is a canvas
 * round-trip several times a second, and two different masks of the same plan can carry
 * the same number of set pixels.
 *
 * This is also the signal to wait on after anything that rewrites the mask. The app
 * writes it through `scheduleSave`'s debounce, so a UI state that changes immediately —
 * a panel clearing its report, a button going quiet — is *not* evidence that the new
 * mask has landed. Waiting on the wrong one of those produced a photogenic test failure:
 * a raster mask compared against a vector mask, IoU 0.83, looking exactly like a
 * detector regression.
 */
export async function savedMask(page: Page): Promise<string> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('aetherax:project');
		if (!raw) return '';
		return (JSON.parse(raw).floors?.[0]?.wallMask?.dataUrl as string) ?? '';
	});
}
