/**
 * Raised surfaces, drawn on the plan: a mezzanine, a stair, a ramp.
 *
 * The layer exists to make a thing that is invisible in a plan visible: a rectangle of
 * floor whose walking surface is *not* the slab. That is a fact the model now uses — every
 * client inside it is closer to the ceiling — and a fact nobody can check if it is only in
 * the model. So the shape is drawn where it is, at a tint that deepens with height, with
 * the rise written on it: `0 → 3.0 m` on a stair says at once which way it climbs and how
 * far, which is the pair of things a reader gets wrong from a rectangle alone.
 */
import type { Layer, RenderContext } from '../types.js';
import {
	surfaceBox,
	surfaceColor,
	surfaceCorners,
	type ElevatedSurface,
	type SurfaceKind,
	type SurfaceMaterialId
} from '$lib/rf/surface-height.js';

/**
 * The tint of a surface, from its material and its height.
 *
 * The hue is the material's — a steel deck reads blue-grey, a timber one brown — so the plan
 * shows what the card says. Height still shows: a taller deck is mixed slightly towards
 * white, which keeps the old "this one is higher" read without taking the colour over.
 */
function tintFor(
	material: SurfaceMaterialId | undefined,
	heightM: number,
	alpha: number
): string {
	const [r, g, b] = surfaceColor(material);
	const t = Math.max(0, Math.min(1, heightM / 4)) * 0.18;
	const mix = (channel: number) => Math.round(channel + (255 - channel) * t);
	return `rgba(${mix(r)},${mix(g)},${mix(b)},${alpha})`;
}

export class SurfacesLayer implements Layer {
	id = 'surfaces';
	visible = true;
	surfaces: ElevatedSurface[] = [];
	/** The one under the pointer or just drawn. Selected surfaces can be edited or deleted. */
	selectedId: string | null = null;
	/** The rectangle being drawn, as two opposite corners, in world units. */
	draft: { ax: number; ay: number; bx: number; by: number } | null = null;
	/** What the draft will become, so the preview says it before it exists. */
	draftKind: SurfaceKind = 'platform';
	draftHeightM = 2;
	draftTopHeightM = 3;
	/** The material the next surface will be drawn in, for the preview's colour. */
	draftMaterial: SurfaceMaterialId | null = null;

	render(rc: RenderContext): void {
		if (!this.visible) return;
		const { ctx, camera } = rc;
		const zoom = camera.state.zoom || 1;
		ctx.save();
		/*
		 * Into world space first, like every other layer that draws on the plan.
		 *
		 * Without this the shapes are drawn at raw world coordinates in *screen* pixels:
		 * they stay put when the plan is panned, do not grow with the zoom, and the label —
		 * sized `11 / zoom` for a screen-constant 11 px — grows as the plan is zoomed in.
		 * The draft cursor is the same bug seen while drawing: the rectangle follows the
		 * pan, not the pointer.
		 */
		const [m0, m1, m2, m3, m4, m5] = camera.getTransform();
		ctx.transform(m0, m1, m2, m3, m4, m5);

		for (const surface of this.surfaces) {
			this.drawSurface(ctx, surface, zoom, surface.id === this.selectedId);
		}
		if (this.draft) {
			this.drawSurface(
				ctx,
				{
					id: 'draft',
					kind: this.draftKind,
					ax: this.draft.ax,
					ay: this.draft.ay,
					bx: this.draft.bx,
					by: this.draft.by,
					heightM: this.draftHeightM,
					topHeightM: this.draftTopHeightM,
					material: this.draftMaterial ?? undefined
				},
				zoom,
				false,
				true
			);
		}

		ctx.restore();
	}

	private drawSurface(
		ctx: CanvasRenderingContext2D,
		surface: ElevatedSurface,
		zoom: number,
		selected: boolean,
		isDraft = false
	): void {
		const corners = surfaceCorners(surface);
		const flat = surface.heightM === surface.topHeightM ? surface.heightM : surface.topHeightM;
		ctx.beginPath();
		ctx.moveTo(corners[0]!.x, corners[0]!.y);
		for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i]!.x, corners[i]!.y);
		ctx.closePath();
		ctx.fillStyle = tintFor(surface.material, flat, isDraft ? 0.14 : 0.2);
		ctx.fill();
		ctx.strokeStyle = selected
			? 'rgba(255,255,255,0.95)'
			: tintFor(surface.material, flat, isDraft ? 0.5 : 0.75);
		ctx.lineWidth = (selected ? 2 : 1.25) / zoom;
		ctx.setLineDash(isDraft ? [6 / zoom, 4 / zoom] : []);
		ctx.stroke();
		ctx.setLineDash([]);

		// The run: an arrow along the longer side, low end to high end, so a ramp reads as
		// one rather than as a platform with a label on it.
		if (surface.heightM !== surface.topHeightM) {
			const low = this.runEnd(surface, 0);
			const high = this.runEnd(surface, 1);
			this.arrow(ctx, low, high, zoom, selected);
		}

		// The label, in the drawing plane so it stays readable at any zoom.
		const { x0, y0, x1, y1 } = surfaceBox(surface);
		const cx = (x0 + x1) / 2;
		const cy = (y0 + y1) / 2;
		const text =
			surface.heightM === surface.topHeightM
				? `${this.kindLabel(surface.kind)} · ${surface.heightM.toFixed(1)} m`
				: `${this.kindLabel(surface.kind)} · ${surface.heightM.toFixed(1)} → ${surface.topHeightM.toFixed(1)} m`;
		ctx.font = `${11 / zoom}px sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		// A dark plate behind it: the tint is pale and the plan underneath is not.
		const width = ctx.measureText(text).width;
		ctx.fillStyle = 'rgba(12,14,20,0.72)';
		ctx.fillRect(cx - width / 2 - 3 / zoom, cy - 8 / zoom, width + 6 / zoom, 16 / zoom);
		ctx.fillStyle = 'rgba(255,238,220,0.95)';
		ctx.fillText(text, cx, cy);
	}

	/** The centre of the surface's low (fraction 0) or high (1) edge, in world units. */
	private runEnd(surface: ElevatedSurface, fraction: number): { x: number; y: number } {
		const { x0, y0, x1, y1, width, height } = surfaceBox(surface);
		if (width >= height) {
			// A horizontal run climbs left-to-right, or right-to-left if drawn that way.
			const forward = surface.bx >= surface.ax;
			const t = forward ? fraction : 1 - fraction;
			return { x: x0 + width * t, y: (y0 + y1) / 2 };
		}
		const forward = surface.by >= surface.ay;
		const t = forward ? fraction : 1 - fraction;
		return { x: (x0 + x1) / 2, y: y0 + height * t };
	}

	private arrow(
		ctx: CanvasRenderingContext2D,
		low: { x: number; y: number },
		high: { x: number; y: number },
		zoom: number,
		selected: boolean
	): void {
		const dx = high.x - low.x;
		const dy = high.y - low.y;
		const length = Math.hypot(dx, dy);
		if (length < 8 / zoom) return;
		const ux = dx / length;
		const uy = dy / length;
		const head = 7 / zoom;
		ctx.strokeStyle = selected ? 'rgba(255,255,255,0.95)' : 'rgba(255,214,170,0.85)';
		ctx.lineWidth = 1.25 / zoom;
		ctx.beginPath();
		ctx.moveTo(low.x, low.y);
		ctx.lineTo(high.x, high.y);
		ctx.stroke();
		// Only the far end carries a head: the pair of ends is the direction.
		ctx.beginPath();
		ctx.moveTo(high.x, high.y);
		ctx.lineTo(high.x - ux * head - uy * head * 0.55, high.y - uy * head + ux * head * 0.55);
		ctx.moveTo(high.x, high.y);
		ctx.lineTo(high.x - ux * head + uy * head * 0.55, high.y - uy * head - ux * head * 0.55);
		ctx.stroke();
	}

	private kindLabel(kind: SurfaceKind): string {
		return kind === 'platform' ? 'Platform' : kind === 'stair' ? 'Stair' : 'Ramp';
	}
}

/** True when a world point is inside a surface, for selecting one. */
export function surfaceAtPoint(
	surfaces: readonly ElevatedSurface[],
	x: number,
	y: number
): ElevatedSurface | null {
	// Last drawn wins, which is the one the user just placed when they overlap.
	for (let i = surfaces.length - 1; i >= 0; i--) {
		const surface = surfaces[i]!;
		const { x0, y0, x1, y1 } = surfaceBox(surface);
		if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return surface;
	}
	return null;
}

/**
 * The surface whose *edge* is nearest, within `tolerance`.
 *
 * Selecting by the edge rather than the area is deliberate: a mezzanine covers a room's
 * worth of plan, and making every click inside it a selection would take the canvas away
 * from placing access points on the very floor the mezzanine is on. Its outline is the
 * part that means "this shape", and it is a small target that nothing else wants.
 */
export function surfaceEdgeNear(
	surfaces: readonly ElevatedSurface[],
	x: number,
	y: number,
	tolerance: number
): ElevatedSurface | null {
	let best: ElevatedSurface | null = null;
	let bestDistance = tolerance;
	for (const surface of surfaces) {
		const corners = surfaceCorners(surface);
		for (let i = 0; i < corners.length; i++) {
			const a = corners[i]!;
			const b = corners[(i + 1) % corners.length]!;
			const distance = distanceToEdge(x, y, a.x, a.y, b.x, b.y);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = surface;
			}
		}
	}
	return best;
}

function distanceToEdge(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);
	let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
