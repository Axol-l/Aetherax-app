/**
 * Notes left on the plan, and the geometry that lets the pointer find them.
 *
 * A note is a pin with a sentence attached: "the lift lobby has a steel door", "do not put
 * an AP here". Survey tools carry them because the plan is not only a drawing — half of what
 * decides where an access point goes never made it into the CAD file.
 *
 * Kept per floor, at world coordinates, and drawn by a canvas layer. The hit test lives here
 * rather than in the renderer because it is the only part worth testing on its own: the
 * renderer needs a canvas, this needs two points and a radius.
 */
import type { Layer, RenderContext } from '../types.js';

export interface Note {
	id: string;
	x: number;
	y: number;
	text: string;
}

/** How close the pointer has to be, in *screen* pixels, to catch a pin. */
export const NOTE_HIT_PX = 12;

/**
 * The note under a world point, if any.
 *
 * `toleranceWorld` is the screen tolerance divided by the zoom — a pin is a fixed size on
 * screen, so at 4x zoom it is a quarter as large in world units and the tolerance has to
 * follow, or the same pin would need a much more careful click on a zoomed plan.
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
 * The pins, and the text of the one under the pointer.
 *
 * Notes are drawn last, over the heatmap and the walls: they are annotations *about* the
 * plan, and an annotation under the thing it annotates is unreadable. The hover bubble is
 * canvas-drawn with the pin because a DOM tooltip would have to track the camera on every
 * pan and zoom for the same effect.
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

			// The pin: a filled circle with a ring, so it reads on a green heatmap.
			ctx.beginPath();
			ctx.arc(note.x, note.y, radius, 0, Math.PI * 2);
			ctx.fillStyle = selected ? 'rgba(255, 190, 60, 1)' : 'rgba(20, 24, 34, 0.92)';
			ctx.fill();
			ctx.strokeStyle = selected ? 'rgba(255, 190, 60, 1)' : 'rgba(255, 214, 120, 0.95)';
			ctx.lineWidth = 1.5 / zoom;
			ctx.stroke();

			// A dot in the middle, so the pin has a direction even at a glance.
			ctx.beginPath();
			ctx.arc(note.x, note.y, 1.6 / zoom, 0, Math.PI * 2);
			ctx.fillStyle = selected ? 'rgba(20, 24, 34, 0.9)' : 'rgba(255, 214, 120, 0.95)';
			ctx.fill();

			if (!hovered && !selected) continue;

			// The bubble: the note's first line, clipped by hand because canvas text has no
			// wrapping. Two lines is what fits over a plan without covering it.
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

/** Split a note into at most `maxLines` lines of roughly `width` characters. */
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
