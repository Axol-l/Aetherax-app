import type { Layer, RenderContext } from '../types.js';

// 平面图目标宽度，世界单位（1 倍缩放下的像素）
const TARGET_WIDTH = 800;

export class FloorplanLayer implements Layer {
	id = 'floorplan';
	visible = true;
	private image: HTMLImageElement | null = null;
	private imageReady = false;
	private onReady: (() => void) | null = null;
	private drawWidth = 0;
	private drawHeight = 0;
	opacity = 0.8;

	/**
	 * 图像原点在世界坐标中的位置。
	 * 对齐值由 `Floor.floorplanOffsetX/Y` 承担，`translateFloor` 以相同位移移动掩码和 AP，使楼层保持刚性。
	 */
	offsetX = 0;
	offsetY = 0;

	get imageWidth(): number {
		return this.drawWidth;
	}
	get imageHeight(): number {
		return this.drawHeight;
	}
	/** 原始图像像素到世界单位的缩放系数 */
	get scaleFactor(): number {
		const natW = this.image?.naturalWidth || this.image?.width || 1;
		return this.drawWidth > 0 ? this.drawWidth / natW : 1;
	}

	loadImage(url: string, onReady?: () => void): void {
		// 已在显示该 URL 时跳过重载，避免重复创建 blob URL
		if (this.image && this.imageReady && this.image.src === url) {
			if (onReady) onReady();
			return;
		}
		this.clearImage();
		this.onReady = onReady ?? null;
		this.image = new Image();
		this.image.onload = () => {
			this.imageReady = true;
			// 缩放到合适的世界尺寸
			const natW = this.image!.naturalWidth || this.image!.width;
			const natH = this.image!.naturalHeight || this.image!.height;
			if (natW > 0 && natH > 0) {
				const s = TARGET_WIDTH / natW;
				this.drawWidth = natW * s;
				this.drawHeight = natH * s;
			} else {
				this.drawWidth = TARGET_WIDTH;
				this.drawHeight = TARGET_WIDTH;
			}
			if (this.onReady) this.onReady();
		};
		this.image.src = url;
	}

	clearImage(): void {
		// 此处不要释放 blob URL：它属于楼层状态，切回该楼层时仍会用到。释放由替换或删除
		// 平面图的调用方负责。
		this.image = null;
		this.imageReady = false;
		this.onReady = null;
		this.drawWidth = 0;
		this.drawHeight = 0;
	}

	render(rc: RenderContext): void {
		if (!this.image || !this.imageReady) return;
		const { ctx, camera } = rc;
		const transform = camera.getTransform();
		const [a, b, c, d, e, f] = transform;
		ctx.transform(a, b, c, d, e, f);
		ctx.globalAlpha = this.opacity;
		ctx.drawImage(this.image, this.offsetX, this.offsetY, this.drawWidth, this.drawHeight);
		ctx.globalAlpha = 1;
	}
}
