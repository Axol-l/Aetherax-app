import type { Layer, RenderContext } from '../types.js';

/**
 * 标定过程中绘制的测量线段。
 * 两次点击连成直线，两端各带一个端点标记，虚线使其读作测量而非图纸上的对象。
 */
export class CalibrationLineLayer implements Layer {
	id = 'calibration-line';
	visible = true;

	/** 第一次和第二次点击的世界坐标。 */
	a: { x: number; y: number } | null = null;
	b: { x: number; y: number } | null = null;

	render(rc: RenderContext): void {
		if (!this.a) return;
		const { ctx, camera } = rc;
		const [m0, m1, m2, m3, m4, m5] = camera.getTransform();
		ctx.transform(m0, m1, m2, m3, m4, m5);

		const zoom = camera.state.zoom;
		const end = this.b ?? this.a;

		ctx.strokeStyle = 'rgba(0, 200, 200, 0.95)';
		ctx.lineWidth = 2 / zoom;
		ctx.setLineDash([6 / zoom, 4 / zoom]);
		ctx.beginPath();
		ctx.moveTo(this.a.x, this.a.y);
		ctx.lineTo(end.x, end.y);
		ctx.stroke();
		ctx.setLineDash([]);

		// 两端各画一个实心圆点，使短线段在任意缩放下都可见。
		for (const point of [this.a, this.b]) {
			if (!point) continue;
			ctx.beginPath();
			ctx.arc(point.x, point.y, 3.5 / zoom, 0, Math.PI * 2);
			ctx.fillStyle = 'rgba(0, 200, 200, 1)';
			ctx.fill();
			ctx.strokeStyle = 'rgba(10, 12, 18, 0.9)';
			ctx.lineWidth = 1 / zoom;
			ctx.stroke();
		}
	}
}
