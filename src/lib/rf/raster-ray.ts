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
import { getFlatAttenuation, type WallMaterialId } from '$lib/domain/materials.js';
import type { Band } from '@aetherax/channels';

/**
 * Wall loss along a ray, measured by walking the drawn grid.
 *
 * `wall` decides what is wall and `material` decides what it costs, and the two are separate
 * on purpose: **material id 0 is Drywall**, and an unpainted pixel is also 0, so the id alone
 * cannot tell a drywall wall from empty floor. Gating on the wall mask is what makes the
 * distinction, and `defaultMaterial` is the material an unpainted wall pixel gets.
 *
 * Each *transition* into a run of wall costs that wall's figure once, which is how a drawn
 * band becomes one crossing rather than a loss per pixel.
 */
export function rasterRayLossDb(
	from: { x: number; y: number },
	to: { x: number; y: number },
	wall: Uint8Array | null,
	material: Uint8Array | null,
	width: number,
	height: number,
	originX: number,
	originY: number,
	band: Band,
	defaultMaterial: WallMaterialId
): number {
	if (!wall || width <= 0 || height <= 0) return 0;
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	if (length <= 0) return 0;

	// Half a pixel steps: fine enough that a one-pixel band cannot be stepped over.
	const steps = Math.max(1, Math.ceil(length * 2));
	let inside = false;
	let total = 0;

	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const px = Math.round(from.x + dx * t - originX);
		const py = Math.round(from.y + dy * t - originY);
		if (px < 0 || py < 0 || px >= width || py >= height) {
			inside = false;
			continue;
		}
		const index = py * width + px;
		if (!wall[index]) {
			inside = false;
			continue;
		}
		// Still in the same band: no new crossing.
		if (inside) continue;
		inside = true;
		// Zero in the material map means "not painted", so the floor's default applies —
		// which for a drywall wall is drywall, and for a concrete floor is concrete.
		const id = (material?.[index] ?? 0) || defaultMaterial;
		total += getFlatAttenuation(id as WallMaterialId, band);
	}
	return total;
}
