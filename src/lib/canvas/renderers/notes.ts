/**
 * 平面图上的标注，以及让指针命中它们的几何计算。
 * 标注是放置在世界坐标上、带一句话的图钉，按楼层保存并由画布图层绘制；
 * 命中检测只依赖点和半径，因此放在这里以便单独测试。
 */
import type { Layer, RenderContext } from '../types.js';

export interface Note {
	id: string;
	x: number;
	y: number;
	text: string;
}

/** 指针命中标注点所需的最大距离，单位为*屏幕*像素。 */
export const NOTE_HIT_PX = 12;

/**
 * 世界坐标点下的标注，没有则为 null。
 *
 * `toleranceWorld` 是屏幕容差除以缩放比例；标注点在屏幕上的大小固定，容差必须随缩放变化。
 */
export function noteAtPoint(
	notes: readonly Note[],
	point: { x: number; y: number },
	toleranceWorld: number
): Note | null {
	let best: Note | null = null;
	let bestDistance = Infinity;
	for (const note of notes) {
		const distance = Math.hypot(note.x - point.x, note.y - point.y);
		if (distance <= toleranceWorld && distance < bestDistance) {
			best = note;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * 标注点，以及指针下标注的文本。
 *
 * 标注最后绘制，覆盖在热力图和墙体之上；悬停气泡与标注点一起由画布绘制，避免 DOM 提示框跟踪相机。
 */
export class NotesLayer implements Layer {
	id = 'notes';
	visible = true;

	notes: readonly Note[] = [];
	hoverId: string | null = null;
	selectedId: string | null = null;

	render(rc: RenderContext): void {
		if (this.notes.length === 0) return;
		const { ctx, camera } = rc;
		const [m0, m1, m2, m3, m4, m5] = camera.getTransform();
		ctx.transform(m0, m1, m2, m3, m4, m5);
		const zoom = camera.state.zoom;

		for (const note of this.notes) {
			const selected = note.id === this.selectedId;
			const hovered = note.id === this.hoverId;
			const radius = (selected || hovered ? 7 : 6) / zoom;

			// 标注点：带圆环的实心圆，使其在绿色热力图上仍可辨认。
			ctx.beginPath();
			ctx.arc(note.x, note.y, radius, 0, Math.PI * 2);
			ctx.fillStyle = selected ? 'rgba(255, 190, 60, 1)' : 'rgba(20, 24, 34, 0.92)';
			ctx.fill();
			ctx.strokeStyle = selected ? 'rgba(255, 190, 60, 1)' : 'rgba(255, 214, 120, 0.95)';
			ctx.lineWidth = 1.5 / zoom;
			ctx.stroke();

			// 中心小圆，用于在快速扫视时强调标注点的位置。
			ctx.beginPath();
			ctx.arc(note.x, note.y, 1.6 / zoom, 0, Math.PI * 2);
			ctx.fillStyle = selected ? 'rgba(20, 24, 34, 0.9)' : 'rgba(255, 214, 120, 0.95)';
			ctx.fill();

			if (!hovered && !selected) continue;

			// 气泡：标注文本，最多两行，因画布文本不自动换行而手动裁剪，以免遮挡平面图。
			const lines = wrapText(note.text || '…', 42, 2);
			ctx.font = `${11 / zoom}px 'Inter', system-ui, sans-serif`;
			const padding = 6 / zoom;
			const lineHeight = 14 / zoom;
			let width = 0;
			for (const line of lines) width = Math.max(width, ctx.measureText(line).width);
			const boxX = note.x + 10 / zoom;
			const boxY = note.y - (lines.length * lineHeight) / 2;
			const boxW = width + padding * 2;
			const boxH = lines.length * lineHeight + padding * 1.4;

			ctx.beginPath();
			ctx.roundRect(boxX, boxY, boxW, boxH, 3 / zoom);
			ctx.fillStyle = 'rgba(16, 20, 28, 0.94)';
			ctx.fill();
			ctx.strokeStyle = 'rgba(255, 214, 120, 0.55)';
			ctx.lineWidth = 1 / zoom;
			ctx.stroke();

			ctx.fillStyle = 'rgba(240, 240, 245, 0.96)';
			ctx.textBaseline = 'middle';
			lines.forEach((line, index) => {
				ctx.fillText(line, boxX + padding, boxY + padding * 0.7 + lineHeight * (index + 0.5));
			});
		}
	}
}

/** 将标注文本拆成最多 `maxLines` 行，每行约 `width` 个字符。 */
export function wrapText(text: string, width: number, maxLines: number): string[] {
	const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length <= width) {
			current = candidate;
			continue;
		}
		if (current) lines.push(current);
		current = word;
		if (lines.length === maxLines - 1) break;
	}
	if (current && lines.length < maxLines) lines.push(current);
	if (lines.length === maxLines && words.length > 0) {
		const last = lines[lines.length - 1]!;
		const consumed = lines.join(' ').length;
		if (consumed < text.trim().length && last.length > 1) {
			lines[lines.length - 1] = `${last.slice(0, last.length - 1)}…`;
		}
	}
	return lines.length > 0 ? lines : ['…'];
}
