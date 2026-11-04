/**
 * A raster reading of the same ray, for the comparison harness.
 */
import { getFlatAttenuation, type WallMaterialId } from '$lib/domain/materials.js';
import type { Band } from '@aetherax/channels';

/**
 * Wall loss along a ray, measured by walking the drawn grid.
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
