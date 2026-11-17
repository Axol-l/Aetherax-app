import type { Layer, RenderContext } from '../types.js';

/**
 * 覆盖在平面图上的单个矩形，供矢量复核面板使用。
 * 指向列表某行时画出该元素的包围盒，便于对照图纸判断分类是否正确。
 */
export class ReviewHighlightLayer implements Layer {
	id = 'review-highlight';
	visible = true;

	/** 世界坐标中的矩形，为 null 时无内容可绘制。 */
	box: { x: number; y: number; w: number; h: number } | null = null;

	render(rc: RenderContext): void {
		if (!this.box) return;
		const { ctx, camera } = rc;
		const [a, b, c, d, e, f] = camera.getTransform();
		ctx.save();
		ctx.transform(a, b, c, d, e, f);

		const zoom = camera.state.zoom || 1;
		// 墙线是退化矩形，宽或高为零，绘制时没有面积。按屏幕像素留边可使每个元素在任意缩放下可见。
		const pad = 4 / zoom;
		const x = this.box.x - pad;
		const y = this.box.y - pad;
		const w = this.box.w + pad * 2;
		const h = this.box.h + pad * 2;

		ctx.fillStyle = 'rgba(255, 176, 32, 0.18)';
		ctx.fillRect(x, y, w, h);
		ctx.strokeStyle = 'rgba(255, 176, 32, 0.85)';
		ctx.lineWidth = 1.5 / zoom;
		ctx.strokeRect(x, y, w, h);
		ctx.restore();
	}
}
