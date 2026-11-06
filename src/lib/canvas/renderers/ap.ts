import type { Layer, RenderContext } from '../types.js';
import type { AccessPoint } from '$state/ap-state.svelte.js';
import { channelColor } from '@aetherax/channels';
import { ACCENT } from '../accents.js';

const UNASSIGNED_COLOR = '#6b7185';
const LABEL_COLOR = '#8b8fa3';
const BADGE_BG = 'rgba(0, 0, 0, 0.6)';
const BADGE_TEXT = '#ffffff';
const WALL_LINK_COLOR = 'rgba(75, 227, 160, 0.65)';
const WALL_LINK_TEXT = '#7fd7ae';
/**
 * 被固定 AP 上挂锁的颜色。
 *
 * 用琥珀色而非界面绿色：本画布上的绿色表示信道，挂锁只用于表达优化器相关的状态。
 */
const PIN_COLOR = '#f0b429';

/**
 * 接入点标记的颜色，平面图与两个总览共用。
 *
 * 颜色表示信道，因此未分配信道的 AP 在所有视图中都是灰色。
 */
export function apMarkerColor(ap: { assignedChannel: number | null; band: string }): string {
	return ap.assignedChannel != null
		? channelColor(ap.assignedChannel, ap.band as Parameters<typeof channelColor>[1])
		: UNASSIGNED_COLOR;
}

/**
 * 接入点相对最近墙体的位置标注。
 * `x`、`y` 为最近墙体点的世界单位坐标，`text` 为界面当前单位制的文字，均由视图提供。
 */
export interface WallDistanceAnnotation {
	x: number;
	y: number;
	text: string;
}

export class ApLayer implements Layer {
	id = 'aps';
	visible = true;
	showLabels: boolean = true;

	aps: AccessPoint[] = [];
	selectedIds: string[] = [];
	hoveredId: string | null = null;
	/**
	 * 按接入点 id 索引的最近墙体标注，只包含有标注的接入点。
	 *
	 * 标注关闭时为空；是否开启由视图决定，见 `WallDistanceAnnotation`。
	 */
	wallDistances: Map<string, WallDistanceAnnotation> = new Map();

	render(rc: RenderContext): void {
		const { ctx, camera } = rc;
		const transform = camera.getTransform();
		const zoom = camera.state.zoom;
		const [a, b, c, d, e, f] = transform;
		ctx.transform(a, b, c, d, e, f);

		const screenScale = 1 / zoom;
		const selectedSet = new Set(this.selectedIds);

		for (const ap of this.aps) {
			const isSelected = selectedSet.has(ap.id);
			const isHovered = this.hoveredId === ap.id;

			const color = apMarkerColor(ap);
			/**
			 * 壁挂设备按其支架形状绘制：沿墙的一段短厚板，
			 * 并带一条指向朝向的短线；圆形会被理解为吸顶安装。
			 */
			const onWall = ap.mount === 'wall';

			const radius = 7 * screenScale;

			if (onWall) {
				const facing = (ap.facingDeg * Math.PI) / 180;
				ctx.save();
				ctx.translate(ap.x, ap.y);
				ctx.rotate(facing);
				/*
				 * 局部 +x 为朝向，因此板在朝向方向较薄、沿墙方向较长，
				 * 与面板中的绘制形状一致，按标记尺寸缩放。
				 */
				ctx.beginPath();
				ctx.roundRect(-4 * screenScale, -9 * screenScale, 8 * screenScale, 18 * screenScale, 2 * screenScale);
				ctx.fillStyle = color;
				ctx.fill();
				ctx.lineWidth = isSelected ? 2.5 * screenScale : 1.5 * screenScale;
				ctx.strokeStyle = isSelected
					? ACCENT
					: isHovered
						? 'rgba(255, 255, 255, 0.15)'
						: 'rgba(255, 255, 255, 0.3)';
				ctx.stroke();
				// 朝向短线：指示设备朝向，由墙体指向房间一侧。
				ctx.beginPath();
				ctx.moveTo(4 * screenScale, 0);
				ctx.lineTo(12 * screenScale, 0);
				ctx.lineWidth = 1.5 * screenScale;
				ctx.strokeStyle = WALL_LINK_COLOR;
				ctx.stroke();
				ctx.restore();
			} else {
				// 选中光晕
				if (isSelected) {
					ctx.save();
					ctx.shadowBlur = 12 * screenScale;
					ctx.shadowColor = ACCENT;
					ctx.beginPath();
					ctx.arc(ap.x, ap.y, radius, 0, Math.PI * 2);
					ctx.fillStyle = color;
					ctx.fill();
					ctx.restore();
				}

				// 实心圆
				ctx.beginPath();
				ctx.arc(ap.x, ap.y, radius, 0, Math.PI * 2);
				ctx.fillStyle = color;
				ctx.fill();

				// 描边圆环
				ctx.beginPath();
				ctx.arc(ap.x, ap.y, radius, 0, Math.PI * 2);
				ctx.lineWidth = 1.5 * screenScale;

				if (isSelected) {
					ctx.strokeStyle = ACCENT;
				} else if (isHovered) {
					ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
				} else {
					ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
				}
				ctx.stroke();

				// 悬停时的外层增亮圆环
				if (isHovered && !isSelected) {
					ctx.beginPath();
					ctx.arc(ap.x, ap.y, radius + 2 * screenScale, 0, Math.PI * 2);
					ctx.lineWidth = 1 * screenScale;
					ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
					ctx.stroke();
				}
			}

			// 最近墙体连线及其测量值。
			const wall = this.wallDistances.get(ap.id);
			if (wall) {
				const dx = wall.x - ap.x;
				const dy = wall.y - ap.y;
				const span = Math.hypot(dx, dy);
				const ux = span > 0 ? dx / span : 0;
				const uy = span > 0 ? dy / span : 1;

				// 比标记本身还短的连线会在标记上糊成一团而不像线，因此不画，文字仍显示。
				if (span > radius * 1.5) {
					ctx.save();
					ctx.setLineDash([3 * screenScale, 3 * screenScale]);
					ctx.beginPath();
					ctx.moveTo(ap.x + ux * radius, ap.y + uy * radius);
					ctx.lineTo(wall.x, wall.y);
					ctx.lineWidth = 1 * screenScale;
					ctx.strokeStyle = WALL_LINK_COLOR;
					ctx.stroke();
					ctx.restore();

					/*
					 * 在墙体一端画一条短线作为测量的可见端点，
					 * 否则虚线会止于墙体厚度内的某处，看不出标的是哪面墙的哪一点。
					 */
					const tick = 4 * screenScale;
					ctx.beginPath();
					ctx.moveTo(wall.x - uy * tick, wall.y + ux * tick);
					ctx.lineTo(wall.x + uy * tick, wall.y - ux * tick);
					ctx.lineWidth = 1.5 * screenScale;
					ctx.strokeStyle = WALL_LINK_TEXT;
					ctx.stroke();
				}

				if (this.showLabels) {
					/*
					 * 数值放在名称下方的第二行，与接入点文字始终同一位置；
					 * 连线仍指明该数值对应哪面墙。
					 */
					ctx.font = `${9 * screenScale}px monospace`;
					ctx.textAlign = 'center';
					ctx.textBaseline = 'top';
					ctx.fillStyle = WALL_LINK_TEXT;
					ctx.fillText(wall.text, ap.x, ap.y + radius + 16 * screenScale);
				}
			}

			// 圆点下方的名称标签
			if (this.showLabels) {
				const fontSize = 10 * screenScale;
				ctx.font = `${fontSize}px monospace`;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'top';
				ctx.fillStyle = LABEL_COLOR;
				ctx.fillText(ap.name, ap.x, ap.y + radius + 4 * screenScale);
			}

			/*
			 * 被固定的 AP 绘制挂锁，表示优化器不会移动它。
			 * 锁画在标记左侧，避开右上方的信道徽标和下方的名称。
			 */
			if (this.showLabels && ap.pinned) {
				const lockW = 7 * screenScale;
				const lockH = 10 * screenScale;
				const bodyH = 6.2 * screenScale;
				const bodyY = ap.y - radius - lockH + (lockH - bodyH);
				const lx = ap.x - radius - lockW - 3 * screenScale;
				const bodyR = 1.6 * screenScale;
				ctx.beginPath();
				ctx.roundRect(lx, bodyY, lockW, bodyH, bodyR);
				ctx.fillStyle = BADGE_BG;
				ctx.fill();
				ctx.lineWidth = 1.2 * screenScale;
				ctx.strokeStyle = PIN_COLOR;
				ctx.stroke();
				// 锁梁：立在锁体上的半圆，比锁体窄。
				ctx.beginPath();
				ctx.arc(lx + lockW / 2, bodyY, lockW * 0.3, Math.PI, 0);
				ctx.stroke();
			}

			// 已分配信道时，在右上方绘制信道徽标
			if (this.showLabels && ap.assignedChannel !== null) {
				const badgeText = String(ap.assignedChannel);
				const badgeFontSize = 8 * screenScale;
				ctx.font = `bold ${badgeFontSize}px monospace`;
				const textMetrics = ctx.measureText(badgeText);
				const badgePadX = 3 * screenScale;
				const badgePadY = 2 * screenScale;
				const badgeW = textMetrics.width + badgePadX * 2;
				const badgeH = badgeFontSize + badgePadY * 2;
				const badgeX = ap.x + radius + 2 * screenScale;
				const badgeY = ap.y - radius - badgeH;
				const badgeRadius = 3 * screenScale;

				// 圆角矩形
				ctx.beginPath();
				ctx.moveTo(badgeX + badgeRadius, badgeY);
				ctx.lineTo(badgeX + badgeW - badgeRadius, badgeY);
				ctx.arcTo(badgeX + badgeW, badgeY, badgeX + badgeW, badgeY + badgeRadius, badgeRadius);
				ctx.lineTo(badgeX + badgeW, badgeY + badgeH - badgeRadius);
				ctx.arcTo(
					badgeX + badgeW,
					badgeY + badgeH,
					badgeX + badgeW - badgeRadius,
					badgeY + badgeH,
					badgeRadius
				);
				ctx.lineTo(badgeX + badgeRadius, badgeY + badgeH);
				ctx.arcTo(badgeX, badgeY + badgeH, badgeX, badgeY + badgeH - badgeRadius, badgeRadius);
				ctx.lineTo(badgeX, badgeY + badgeRadius);
				ctx.arcTo(badgeX, badgeY, badgeX + badgeRadius, badgeY, badgeRadius);
				ctx.closePath();
				ctx.fillStyle = BADGE_BG;
				ctx.fill();

				// 徽标文字
				ctx.fillStyle = BADGE_TEXT;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2);
			}
		}
	}
}
