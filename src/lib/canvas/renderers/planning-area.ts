import type { Layer, RenderContext } from '../types.js';

/**
 * 规划区域绘制在它所描述的平面图上，共用一层表现两种状态：
 * 已确认的多边形（虚线环加半透明填充，保持墙体可读）和正在绘制的环（穿过已点击点的实线，每点带圆点）。
 * 点为世界坐标，绘制随相机变换缩放并跟随平面图。
 */
export class PlanningAreaLayer implements Layer {
	id = 'planning-area';
	visible = true;

	/** 已确认的区域；楼层没有时为 null。 */
	area: Array<{ x: number; y: number }> | null = null;
	/** 正在绘制、尚未确认的环。 */
	draft: Array<{ x: number; y: number }> = [];
	/**
	 * 草稿已在首个角点闭合，等待确认栏确认。
	 *
	 * 它仍是草稿：确认替换之前旧区域继续显示。
	 */
	draftClosed = false;
	/**
	 * 绘制时指针的世界坐标。
	 *
	 * 用于预览最后一点到光标的边以及闭合边。
	 */
	cursor: { x: number; y: number } | null = null;

	render(rc: RenderContext): void {
		const hasArea = this.area && this.area.length >= 3;
		if (!hasArea && this.draft.length === 0) return;

		const { ctx, camera } = rc;
		const [m0, m1, m2, m3, m4, m5] = camera.getTransform();
		ctx.transform(m0, m1, m2, m3, m4, m5);
		const zoom = camera.state.zoom;

		if (hasArea) {
			const area = this.area!;
			ctx.beginPath();
			ctx.moveTo(area[0]!.x, area[0]!.y);
			for (let i = 1; i < area.length; i++) ctx.lineTo(area[i]!.x, area[i]!.y);
			ctx.closePath();
			// 使用淡色填充而非实色，避免遮住区域内部的墙体。
			ctx.fillStyle = 'rgba(0, 200, 200, 0.06)';
			ctx.fill();
			ctx.strokeStyle = 'rgba(0, 200, 200, 0.55)';
			ctx.lineWidth = 1.5 / zoom;
			ctx.setLineDash([8 / zoom, 5 / zoom]);
			ctx.stroke();
			ctx.setLineDash([]);
		}

		if (this.draft.length > 0 && this.draftClosed && this.draft.length >= 3) {
			// 已闭合、等待确认的形状：在当前区域上绘制虚线环，表示这是提案而非已生效的新楼层。
			ctx.beginPath();
			ctx.moveTo(this.draft[0]!.x, this.draft[0]!.y);
			for (let i = 1; i < this.draft.length; i++) {
				ctx.lineTo(this.draft[i]!.x, this.draft[i]!.y);
			}
			ctx.closePath();
			ctx.fillStyle = 'rgba(0, 220, 220, 0.05)';
			ctx.fill();
			ctx.strokeStyle = 'rgba(0, 220, 220, 0.95)';
			ctx.lineWidth = 2 / zoom;
			ctx.setLineDash([8 / zoom, 5 / zoom]);
			ctx.stroke();
			ctx.setLineDash([]);
			for (const point of this.draft) {
				ctx.beginPath();
				ctx.arc(point.x, point.y, 3.5 / zoom, 0, Math.PI * 2);
				ctx.fillStyle = 'rgba(0, 220, 220, 1)';
				ctx.fill();
				ctx.strokeStyle = 'rgba(10, 12, 18, 0.9)';
				ctx.lineWidth = 1 / zoom;
				ctx.stroke();
			}
			return;
		}

		if (this.draft.length > 0) {
			const last = this.draft[this.draft.length - 1]!;
			const target = this.cursor ?? last;

			// 已提交的边。
			ctx.beginPath();
			ctx.moveTo(this.draft[0]!.x, this.draft[0]!.y);
			for (let i = 1; i < this.draft.length; i++) ctx.lineTo(this.draft[i]!.x, this.draft[i]!.y);
			ctx.strokeStyle = 'rgba(0, 220, 220, 0.95)';
			ctx.lineWidth = 2 / zoom;
			ctx.stroke();

			// 正在绘制的边，以及将闭合环路的边。
			if (this.cursor && this.draft.length >= 2) {
				ctx.beginPath();
				ctx.moveTo(last.x, last.y);
				ctx.lineTo(target.x, target.y);
				ctx.lineTo(this.draft[0]!.x, this.draft[0]!.y);
				ctx.strokeStyle = 'rgba(0, 220, 220, 0.45)';
				ctx.lineWidth = 1.5 / zoom;
				ctx.setLineDash([6 / zoom, 5 / zoom]);
				ctx.stroke();
				ctx.setLineDash([]);
			} else if (this.cursor) {
				ctx.beginPath();
				ctx.moveTo(last.x, last.y);
				ctx.lineTo(target.x, target.y);
				ctx.strokeStyle = 'rgba(0, 220, 220, 0.45)';
				ctx.lineWidth = 1.5 / zoom;
				ctx.setLineDash([6 / zoom, 5 / zoom]);
				ctx.stroke();
				ctx.setLineDash([]);
			}

			for (const point of this.draft) {
				ctx.beginPath();
				ctx.arc(point.x, point.y, 3.5 / zoom, 0, Math.PI * 2);
				ctx.fillStyle = 'rgba(0, 220, 220, 1)';
				ctx.fill();
				ctx.strokeStyle = 'rgba(10, 12, 18, 0.9)';
				ctx.lineWidth = 1 / zoom;
				ctx.stroke();
			}
		}
	}
}
