/**
 * A raster reading of the same ray, for the comparison harness.
 *
 * The app's own wall march is a large piece of machinery wrapped around the heatmap's texel
 * generation; this is the same *idea* in thirty lines — walk the ray on the drawn grid and
 * charge each material band it passes through — so the comparison can produce a number today
 * without the heatmap being rewired first.
 *
 * It is deliberately labelled as a re-implementation rather than "the march": when the real
 * switch goes in, the harness should be handed the real one, and this can go.
 */
import { getFlatAttenuation, type WallMaterialId } from '../canvas/materials.js';
import type { Band } from '@aetherax/channels';

/**
 * Wall loss along a ray, measured by walking the material mask.
 *
 * `material` is the per-pixel material id from the mask (0 where nothing was painted), and
 * `originX/originY` map world coordinates onto it. Each *transition* into a band of a
 * material costs that material's figure once, which is how the drawn band becomes one
 * crossing rather than a loss per pixel.
 */
export function rasterRayLossDb(
	from: { x: number; y: number },
	to: { x: number; y: number },
	material: Uint8Array | null,
	width: number,
	height: number,
	originX: number,
	originY: number,
	band: Band,
	defaultMaterial: WallMaterialId
): number {
	if (!material || width <= 0 || height <= 0) return 0;
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	if (length <= 0) return 0;

	// Half a pixel steps: fine enough that a one-pixel band cannot be stepped over.
	const steps = Math.max(1, Math.ceil(length * 2));
	let previous = -1;
	let total = 0;

	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const px = Math.round(from.x + dx * t - originX);
		const py = Math.round(from.y + dy * t - originY);
		if (px < 0 || py < 0 || px >= width || py >= height) {
			previous = -1;
			continue;
		}
		const id = material[py * width + px] ?? 0;
		if (id === previous) continue;
		previous = id;
		// The mask's zero is "nothing painted", which costs nothing; a painted pixel costs
		// its material figure, and a virtual partition's figure is zero.
		if (id === 0) continue;
		total += getFlatAttenuation(id as WallMaterialId, band);
	}
	return total;
}
