import type { Layer, RenderContext } from '../types.js';

/**
 * 正在拖拽的直线、矩形或圆弧的轮廓。
 * 形状工具在抬起时才栅格化，这里先绘制待提交的几何，使掩码在提交前保持不变。
 */
export class ShapePreviewLayer implements Layer {
	id = 'shape-preview';
	visible = true;

	active = false;
	kind: 'line' | 'rect' | 'arc' = 'line';

	// 直线/矩形的端点。
	startX = 0;
	startY = 0;
	endX = 0;
	endY = 0;

	// 圆弧：圆心、半径与有符号扫掠角（弧度）。整圈扫掠表示闭合圆。
	centerX = 0;
	centerY = 0;
	radius = 0;
	startAngle = 0;
	sweep = 0;

	/** 完整描边宽度，世界单位，使预览与实际绘制一致。 */
	strokeWidth = 30;

	render(rc: RenderContext): void {
		if (!this.active) return;
		const { ctx, camera } = rc;
		const [a, b, c, d, e, f] = camera.getTransform();
		const zoom = camera.state.zoom;

		ctx.save();
		ctx.transform(a, b, c, d, e, f);

		const path = new Path2D();
		if (this.kind === 'line') {
			path.moveTo(this.startX, this.startY);
			path.lineTo(this.endX, this.endY);
		} else if (this.kind === 'rect') {
			path.rect(
				Math.min(this.startX, this.endX),
				Math.min(this.startY, this.endY),
				Math.abs(this.endX - this.startX),
				Math.abs(this.endY - this.startY)
			);
		} else if (this.radius > this.strokeWidth / 2) {
			path.arc(this.centerX, this.centerY, this.radius, this.startAngle, this.startAngle + this.sweep);
		}

		// 实心色带，显示实际笔刷覆盖范围……
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = Math.max(1, this.strokeWidth);
		ctx.strokeStyle = 'rgba(75, 227, 160, 0.28)';
		ctx.stroke(path);

		// ……再加一条细虚线中心线，使精确位置在任意笔宽下都清晰可辨。
		ctx.lineWidth = 1 / zoom;
		ctx.setLineDash([5 / zoom, 5 / zoom]);
		ctx.strokeStyle = 'rgba(214, 255, 235, 0.85)';
		ctx.stroke(path);
		ctx.setLineDash([]);

		// 圆弧辅助线：画出圆心和半径，使几何关系明确。
		if (this.kind === 'arc' && this.radius > this.strokeWidth / 2) {
			ctx.beginPath();
			ctx.moveTo(this.centerX, this.centerY);
			ctx.lineTo(
				this.centerX + Math.cos(this.startAngle) * this.radius,
				this.centerY + Math.sin(this.startAngle) * this.radius
			);
			ctx.lineWidth = 1 / zoom;
			ctx.setLineDash([3 / zoom, 3 / zoom]);
			ctx.strokeStyle = 'rgba(75, 227, 160, 0.5)';
			ctx.stroke();
			ctx.setLineDash([]);
		}

		ctx.restore();
	}
}
