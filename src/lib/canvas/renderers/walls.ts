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

		// 直接按相机变换绘制到主 ctx（不经过中间画布）
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
 * 以彩色栅格表示的墙体：每个掩码像素按材质颜色绘制，导出供其他视图共用，
 * 避免显示不一致。
 * 虚拟隔断使用斜线纹理，以区别于同材质颜色的真实墙体。
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
	 * 必须通过 `getMaterial` 取色：用户自定义材质的 id 不在内置表中，
	 * 直接索引会回退到默认颜色。
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
