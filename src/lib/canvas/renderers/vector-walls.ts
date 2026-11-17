import type { Layer, RenderContext } from '../types.js';
import type { VectorColumn, VectorWall } from '../../state/vector-walls.js';
import { getMaterial, type WallMaterialId } from '$lib/domain/materials.js';

/**
 * 以线段绘制的墙体，绘制在平面图之上。
 * 线段按材质颜色描边，选中墙体加粗并提亮，线宽固定为几个像素而不表示墙体实际厚度；
 * 草稿线段跟随指针，使绘制中的墙体在第二次点击确认前可见。
 */
export class VectorWallsLayer implements Layer {
	id = 'vector-walls';
	visible = true;

	walls: readonly VectorWall[] = [];
	/**
	 * 柱：墙垛或圆柱。按材质颜色填充，因为其遮挡效果来自占位面积而非一条线。
	 */
	columns: readonly VectorColumn[] = [];
	selectedId: string | null = null;
	/** 选中柱时其 id，否则为 null。 */
	selectedColumnId: string | null = null;
	/** 正在绘制墙体的第一次点击位置，以及当前指针位置。 */
	draft: { x: number; y: number } | null = null;
	/** 正在绘制的矩形或圆形，用两个对角点表示（圆心 + 圆周点）。 */
	columnDraft: { shape: 'rect' | 'circle'; ax: number; ay: number; bx: number; by: number } | null =
		null;
	cursor: { x: number; y: number } | null = null;
	/**
	 * 下一次点击将吸附到的端点，没有可吸附端点时为 null。
	 *
	 * 点击前以圆环标出，避免吸附静默失败而让墙体留下缺口。
	 */
	snapTarget: { x: number; y: number } | null = null;
	/** 每米对应的世界单位，用于选中墙体的长度读数。 */
	wupm = 1;

	render(rc: RenderContext): void {
		if (this.walls.length === 0 && this.columns.length === 0 && !this.draft && !this.columnDraft)
			return;
		const { ctx, camera } = rc;
		const [m0, m1, m2, m3, m4, m5] = camera.getTransform();
		ctx.transform(m0, m1, m2, m3, m4, m5);
		const zoom = camera.state.zoom;

		// 绘制颜色：绿色，与应用表示“操作正常”的强调色一致。
		const DRAW = 'rgba(74, 222, 128, ';

		/*
		 * 描边宽度，单位为**世界**单位：取栅格工具提供的最小笔刷（半径 3，即直径 6）。
		 * 使矢量墙与手绘墙在平面图上厚度一致，并随缩放变化，而不是始终一条细线。
		 * 缩放到很小时保底为一个屏幕像素，保持可见。
		 */
		const stroke = Math.max(1 / zoom, 6);

		for (const wall of this.walls) {
			const material = getMaterial(wall.material);
			const selected = wall.id === this.selectedId;
			ctx.beginPath();
			ctx.moveTo(wall.ax, wall.ay);
			ctx.lineTo(wall.bx, wall.by);
			ctx.strokeStyle = `rgba(${material.color[0]}, ${material.color[1]}, ${material.color[2]}, ${selected ? 1 : 0.9})`;
			ctx.lineWidth = selected ? stroke * 1.4 : stroke;
			// 虚拟隔断是建模线而非实体表面：用虚线表示，无需图例说明。
			ctx.setLineDash(material.dbPerMeter['5ghz'] === 0 ? [5 / zoom, 4 / zoom] : []);
			ctx.stroke();
			ctx.setLineDash([]);

			// 绘制端点，使相接的墙体在视觉上确实相连。
			for (const point of [
				{ x: wall.ax, y: wall.ay },
				{ x: wall.bx, y: wall.by }
			]) {
				ctx.beginPath();
				ctx.arc(point.x, point.y, (selected ? 1.4 : 1) * stroke * 0.55, 0, Math.PI * 2);
				ctx.fillStyle = `rgba(${material.color[0]}, ${material.color[1]}, ${material.color[2]}, 1)`;
				ctx.fill();
			}

			// 选中墙体的长度：用于确认线段位置是否符合预期，也是核对平面图的数值。
			if (selected) {
				const metres = Math.hypot(wall.bx - wall.ax, wall.by - wall.ay) / (this.wupm || 1);
				const label = `${metres.toFixed(2)} m`;
				ctx.font = `${11 / zoom}px 'Inter', system-ui, sans-serif`;
				const midX = (wall.ax + wall.bx) / 2;
				const midY = (wall.ay + wall.by) / 2;
				const width = ctx.measureText(label).width;
				const padX = 4 / zoom;
				const padY = 3 / zoom;
				ctx.beginPath();
				ctx.roundRect(
					midX - width / 2 - padX,
					midY - 9 / zoom - padY,
					width + padX * 2,
					13 / zoom + padY,
					3 / zoom
				);
				ctx.fillStyle = 'rgba(16, 20, 28, 0.9)';
				ctx.fill();
				ctx.fillStyle = `${DRAW}0.98)`;
				ctx.textBaseline = 'middle';
				ctx.fillText(label, midX - width / 2, midY - 2 / zoom);
			}
		}

		// 柱绘制在线段之下：与墙垛相接的墙体应覆盖在其上。
		for (const column of this.columns) {
			this.drawColumn(
				ctx,
				column.shape,
				column.ax,
				column.ay,
				column.bx,
				column.by,
				column.material,
				column.id === this.selectedColumnId,
				stroke,
				zoom,
				false
			);
		}
		if (this.columnDraft) {
			this.drawColumn(
				ctx,
				this.columnDraft.shape,
				this.columnDraft.ax,
				this.columnDraft.ay,
				this.columnDraft.bx,
				this.columnDraft.by,
				0,
				false,
				stroke,
				zoom,
				true
			);
		}

		if (this.draft) {
			const end = this.cursor ?? this.draft;
			ctx.beginPath();
			ctx.moveTo(this.draft.x, this.draft.y);
			ctx.lineTo(end.x, end.y);
			ctx.strokeStyle = `${DRAW}0.95)`;
			ctx.lineWidth = stroke;
			ctx.setLineDash([6 / zoom, 4 / zoom]);
			ctx.stroke();
			ctx.setLineDash([]);

			ctx.beginPath();
			ctx.arc(this.draft.x, this.draft.y, stroke * 0.6, 0, Math.PI * 2);
			ctx.fillStyle = `${DRAW}1)`;
			ctx.fill();
		}

		// 本次点击将落到的端点，在落点前以圆环标出。
		if (this.snapTarget) {
			ctx.beginPath();
			ctx.arc(this.snapTarget.x, this.snapTarget.y, stroke * 1.6, 0, Math.PI * 2);
			ctx.strokeStyle = `${DRAW}0.95)`;
			ctx.lineWidth = Math.max(1 / zoom, stroke * 0.25);
			ctx.stroke();
		}
	}

	/**
	 * 单个柱：以材质颜色填充的矩形或圆形。
	 *
	 * 草稿使用与绘制墙体相同的绿色并设为虚线，避免被误认为模型已有的遮挡物。
	 */
	private drawColumn(
		ctx: CanvasRenderingContext2D,
		shape: 'rect' | 'circle',
		ax: number,
		ay: number,
		bx: number,
		by: number,
		material: number,
		selected: boolean,
		stroke: number,
		zoom: number,
		isDraft: boolean
	): void {
		const colour = getMaterial(material as WallMaterialId).color;
		ctx.beginPath();
		if (shape === 'circle') {
			const radius = Math.hypot(bx - ax, by - ay);
			ctx.arc(ax, ay, Math.max(radius, 0.5), 0, Math.PI * 2);
		} else {
			ctx.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
		}
		ctx.fillStyle = isDraft ? 'rgba(74, 222, 128, 0.22)' : `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${selected ? 0.55 : 0.4})`;
		ctx.fill();
		ctx.strokeStyle = isDraft
			? 'rgba(74, 222, 128, 0.95)'
			: `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${selected ? 1 : 0.9})`;
		ctx.lineWidth = selected ? stroke * 0.6 : stroke * 0.4;
		ctx.setLineDash(isDraft ? [6 / zoom, 4 / zoom] : []);
		ctx.stroke();
		ctx.setLineDash([]);
	}
}
