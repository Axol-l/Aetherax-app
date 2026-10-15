import type { Layer, RenderContext } from '../types.js';
import type { DecodedWallMask } from '../wall-detect.js';
import { WALL_MATERIALS, isVirtualMaterial, type WallMaterialId } from '../materials.js';

export class WallLayer implements Layer {
	id = 'walls';
	visible = true;
	mask: DecodedWallMask | null = null;
	materialMap: Uint8Array | null = null;
	defaultMaterial: WallMaterialId = 0;

	private cachedImage: HTMLCanvasElement | null = null;
	private cachedMaskRef: Uint8Array | null = null;
	private cachedMatRef: Uint8Array | null = null;
	private cachedDefaultMat: WallMaterialId = -1 as WallMaterialId;

	invalidateCache(): void {
		this.cachedMaskRef = null;
	}

	render(rc: RenderContext): void {
		if (!this.mask) return;
		if (!this.cachedImage && !this.mask.data.some((v) => v)) return;
		const { ctx, camera, dpr } = rc;

		const needsRegen =
			this.mask.data !== this.cachedMaskRef ||
			this.materialMap !== this.cachedMatRef ||
			this.defaultMaterial !== this.cachedDefaultMat;

		if (needsRegen) {
			this.cachedImage = colorize(this.mask, this.materialMap, this.defaultMaterial);
			this.cachedMaskRef = this.mask.data;
			this.cachedMatRef = this.materialMap;
			this.cachedDefaultMat = this.defaultMaterial;
		}

		// Draw directly to main ctx with camera transform (no intermediate canvas)
		const transform = camera.getTransform();
		const [a, b, c, d, e, f] = transform;

		ctx.save();
		ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
		ctx.globalAlpha = 0.6;
		ctx.drawImage(this.cachedImage!, this.mask!.originX, this.mask!.originY);
		ctx.restore();
	}
}

function colorize(
	mask: DecodedWallMask,
	materialMap: Uint8Array | null,
	defaultMaterial: WallMaterialId
): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = mask.width;
	canvas.height = mask.height;
	const ctx = canvas.getContext('2d')!;
	const imgData = ctx.createImageData(mask.width, mask.height);
	const defaultColor = WALL_MATERIALS[defaultMaterial]?.color ?? WALL_MATERIALS[0]!.color;

	for (let i = 0; i < mask.data.length; i++) {
		if (!mask.data[i]) continue;
		const j = i * 4;
		const matId = materialMap ? materialMap[i]! : defaultMaterial;
		const color = WALL_MATERIALS[matId]?.color ?? defaultColor;
		let r = color[0];
		let g = color[1];
		let b = color[2];

		if (isVirtualMaterial(matId as WallMaterialId)) {
			// Diagonal hatch. A virtual partition attenuates nothing, and a plain
			// fill would make it look identical to a real wall in the material's
			// colour — the one thing the user must be able to tell apart.
			// Cheap to do here: this runs once per mask change, not per frame.
			const x = i % mask.width;
			const y = (i / mask.width) | 0;
			if ((x + y) % 8 < 4) {
				r = Math.round(r * 0.32);
				g = Math.round(g * 0.32);
				b = Math.round(b * 0.32);
			}
		}

		imgData.data[j] = r;
		imgData.data[j + 1] = g;
		imgData.data[j + 2] = b;
		imgData.data[j + 3] = 255;
	}
	ctx.putImageData(imgData, 0, 0);
	return canvas;
}
