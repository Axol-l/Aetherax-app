/**
 * 同一射线的栅格读数，供对比测试使用。
 */
import { getFlatAttenuation, type WallMaterialId } from '$lib/domain/materials.js';
import type { Band } from '@aetherax/channels';

/**
 * 沿射线按绘制的栅格逐点行进得到的墙体损耗，dB。
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

	// 以半像素为步长，避免宽度为一像素的墙体被跨过。
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
		// 仍在同一墙带内，不算新的穿越。
		if (inside) continue;
		inside = true;
		// 材质图中 0 表示未涂改，此时使用默认材质。
		const id = (material?.[index] ?? 0) || defaultMaterial;
		total += getFlatAttenuation(id as WallMaterialId, band);
	}
	return total;
}
