import type { Layer, RenderContext } from '../types.js';
import type { DecodedWallMask } from '../mask-codec.js';
import { getMaterial, isVirtualMaterial, type WallMaterialId } from '$lib/domain/materials.js';

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
			this.cachedImage = colorizeWalls(
				this.mask.data,
				this.mask.width,
				this.mask.height,
				this.materialMap,
				this.defaultMaterial
			);
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

/**
 * Walls as a coloured raster: one pixel per mask pixel, in its material's colour.
 *
 * Exported because the plan is no longer the only view that needs it. The overviews
 * (the tiles sheet and the 2.5D stack) used to draw the encoded wall mask as it is —
 * white walls on transparent — which is why a glass door and a brick wall looked the
 * same up there while the plan told them apart. One function, so they cannot drift
 * again.
 *
 * A virtual partition gets a diagonal hatch: it attenuates nothing, and a plain fill
 * would make it look identical to a real wall in the same material's colour, which is
 * the one thing the user has to be able to tell apart. Cheap here because this runs
 * once per mask change rather than per frame.
 */
export function colorizeWalls(
	maskData: Uint8Array,
	width: number,
	height: number,
	materialMap: Uint8Array | null,
	defaultMaterial: WallMaterialId
): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d')!;
	const imgData = ctx.createImageData(width, height);
	/*
	 * Through `getMaterial`, not the built-in table: a wall painted with one of the user's own
	 * materials has an id the table does not contain, so indexing it directly fell back to the
	 * default colour — picking a custom material in the right-click menu changed the physics
	 * and left the wall looking exactly as it did.
	 */
	for (let i = 0; i < maskData.length; i++) {
		if (!maskData[i]) continue;
		const j = i * 4;
		const matId = materialMap ? materialMap[i]! : defaultMaterial;
		const color = getMaterial(matId as WallMaterialId).color;
		let r = color[0];
		let g = color[1];
		let b = color[2];

		if (isVirtualMaterial(matId as WallMaterialId)) {
			const x = i % width;
			const y = (i / width) | 0;
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
