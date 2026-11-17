import type { Layer, RenderContext } from '../types.js';

/** 底层图宽度，单位为世界单位。与 `FloorplanLayer` 一致，使两者缩放相同。 */
const TARGET_WIDTH = 800;

/**
 * 另一楼层的半透明残影，叠加参考层的底层图和墙体掩码，用于在调整对齐时看出两个平面图的错位。
 * 墙体掩码无需解码，存储的 PNG 可直接绘制；残影绘制在当前楼层之上，以免被不透明的底层图遮住。
 */
export class ReferenceFloorLayer implements Layer {
	id = 'reference-floor';
	visible = false;
	opacity = 0.3;

	/**
	 * 图片加载完成后调用，使引擎可以重绘；否则残影会一直空白，直到画布被其他操作标记为脏。
	 */
	onLoad: (() => void) | null = null;

	/**
	 * 仅作用于残影的额外世界空间位移。
	 *
	 * 拖动对齐时相机跟随当前楼层，残影需反向平移同样的量，才能保持锚定在其所属楼层上。
	 */
	compensateX = 0;
	compensateY = 0;

	/**
	 * 参考层单位 → 当前楼层单位。
	 * 残影绘制在当前楼层的世界坐标系中，以不同分辨率标定的参考平面图按此比例缩放，偏移量一并缩放。
	 */
	scale = 1;

	private planImage: HTMLImageElement | null = null;
	private planKey: string | null = null;
	private planX = 0;
	private planY = 0;
	private planW = 0;
	private planH = 0;

	private maskImage: HTMLImageElement | null = null;
	private maskKey: string | null = null;
	private maskX = 0;
	private maskY = 0;

	/** 显示参考层的底层图。传入 null 可清除。 */
	setPlan(url: string | null, offsetX: number, offsetY: number): void {
		const key = url ? `${url}|${offsetX}|${offsetY}` : null;
		if (key === this.planKey) return;
		this.planKey = key;
		if (!url) {
			this.planImage = null;
			this.planW = 0;
			this.planH = 0;
			return;
		}
		this.planX = offsetX;
		this.planY = offsetY;
		if (this.planImage?.src !== url) {
			const img = new Image();
			img.onload = () => {
				const natW = img.naturalWidth || 1;
				const natH = img.naturalHeight || 1;
				this.planW = TARGET_WIDTH;
				this.planH = (natH / natW) * TARGET_WIDTH;
				this.onLoad?.();
			};
			img.src = url;
			this.planImage = img;
		}
	}

	/** 显示参考层的墙体轮廓。传入 null 可清除。 */
	setMask(url: string | null, originX: number, originY: number): void {
		const key = url ? `${url}|${originX}|${originY}` : null;
		if (key === this.maskKey) return;
		this.maskKey = key;
		if (!url) {
			this.maskImage = null;
			return;
		}
		this.maskX = originX;
		this.maskY = originY;
		if (this.maskImage?.src !== url) {
			const img = new Image();
			img.onload = () => this.onLoad?.();
			img.src = url;
			this.maskImage = img;
		}
	}

	render(rc: RenderContext): void {
		if (!this.visible) return;
		const { ctx, camera } = rc;
		const [a, b, c, d, e, f] = camera.getTransform();

		ctx.save();
		ctx.transform(a, b, c, d, e, f);
		ctx.globalAlpha = this.opacity;
		if (this.planImage && this.planW > 0) {
			ctx.drawImage(
				this.planImage,
				this.planX * this.scale + this.compensateX,
				this.planY * this.scale + this.compensateY,
				this.planW * this.scale,
				this.planH * this.scale
			);
		}
		if (this.maskImage) {
			ctx.drawImage(
				this.maskImage,
				this.maskX * this.scale + this.compensateX,
				this.maskY * this.scale + this.compensateY,
				(this.maskImage.naturalWidth || 0) * this.scale,
				(this.maskImage.naturalHeight || 0) * this.scale
			);
		}
		ctx.restore();
	}
}
