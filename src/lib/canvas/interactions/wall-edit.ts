import type { CanvasEngine } from '../engine.js';
import type { WallMaterialId } from '../materials.js';
import { TiledMask } from '../tiled-mask.js';
import type { ShapePreviewLayer } from '../renderers/shape-preview.js';
import { appState } from '$state/app.svelte.js';

const TAU = Math.PI * 2;

/** Wrap an angle into (-PI, PI] so cumulative sweeps stay continuous. */
function normalizeAngle(a: number): number {
	return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

export class WallEditHandler {
	private engine: CanvasEngine;
	private painting = false;
	private lastX = 0;
	private lastY = 0;

	/** Held shift constrains the pending shape. Tracked from pointer events. */
	private shiftKey = false;

	// Unconstrained drag endpoint for line/rect; both the preview and the commit
	// derive from this, so toggling shift mid-drag behaves predictably.
	private rawEndX = 0;
	private rawEndY = 0;

	// Arc drag state. `arcStartAngle` stays null until the pointer has moved far
	// enough from the centre to define a direction.
	private arcStartAngle: number | null = null;
	private arcLastAngle = 0;
	private arcSweep = 0;

	// Latest pointer position in world space and the key state that goes with it,
	// so a modifier pressed between two pointer events can still refresh the
	// preview (see setShift).
	private lastWorldX = 0;
	private lastWorldY = 0;

	/** Tiled mask for infinite-canvas wall drawing. */
	tiledMask: TiledMask | null = null;
	activeMaterial: WallMaterialId = 0;
	defaultMaterial: WallMaterialId = 0;

	/** Outline shown while a shape is being dragged. */
	preview: ShapePreviewLayer | null = null;

	// Called after edits to update renderers
	onEdit: (() => void) | null = null;

	constructor(engine: CanvasEngine) {
		this.engine = engine;
	}

	private shapeMode(): 'line' | 'rect' | 'arc' | null {
		const m = appState.wallEditMode;
		return m === 'line' || m === 'rect' || m === 'arc' ? m : null;
	}

	handlePointerDown(e: PointerEvent): void {
		if (!appState.wallEditMode || !this.tiledMask) {
			// Without this, editing with no mask is completely silent: every stroke
			// returns at this line and the canvas simply does not respond. The mask
			// is built after the floorplan decode, so a persistent version of this
			// means the decode is never completing for this floor.
			if (appState.wallEditMode && !this.tiledMask) {
				console.warn(
					'[walls] edit mode is on but the editor has no mask, so strokes are ignored. ' +
						'The mask is built once the floorplan decode finishes.'
				);
			}
			return;
		}
		this.painting = true;
		this.shiftKey = e.shiftKey;
		const rect = this.engine.canvas.getBoundingClientRect();
		const sx = e.clientX - rect.left;
		const sy = e.clientY - rect.top;
		const world = this.engine.camera.screenToWorld({ x: sx, y: sy });

		// Print both frames when they plainly disagree. "Editing does nothing" and
		// "erasing wipes the layer" are both what a coordinate-frame mismatch looks
		// like, and the two numbers make the difference obvious instead of guessed.
		const b = this.tiledMask.bounds;
		if (b) {
			const pad = 1024;
			if (
				world.x < b.originX - pad ||
				world.x > b.originX + b.width + pad ||
				world.y < b.originY - pad ||
				world.y > b.originY + b.height + pad
			) {
				console.warn(
					`[walls] brush at world ${Math.round(world.x)},${Math.round(world.y)} but the mask ` +
						`covers x ${b.originX}..${b.originX + b.width}, y ${b.originY}..${b.originY + b.height}. ` +
						'A stroke here cannot land on the mask.'
				);
			}
		}

		this.lastX = world.x;
		this.lastY = world.y;
		this.lastWorldX = world.x;
		this.lastWorldY = world.y;
		this.rawEndX = world.x;
		this.rawEndY = world.y;

		const shape = this.shapeMode();
		if (shape) {
			// Shapes are rubber-banded: nothing is written until pointer up.
			const p = this.preview;
			if (p) {
				p.kind = shape;
				p.startX = world.x;
				p.startY = world.y;
				p.endX = world.x;
				p.endY = world.y;
				p.centerX = world.x;
				p.centerY = world.y;
				p.radius = 0;
				p.startAngle = 0;
				p.sweep = 0;
				p.strokeWidth = appState.wallBrushSize * 2;
				p.active = true;
			}
			this.arcStartAngle = null;
			this.arcLastAngle = 0;
			this.arcSweep = 0;
			this.engine.markDirty();
			return;
		}

		this.stampAt(world.x, world.y);
		this.flushEdit();
	}

	handlePointerMove(e: PointerEvent): void {
		if (!this.painting || !this.tiledMask) return;
		this.shiftKey = e.shiftKey;
		const rect = this.engine.canvas.getBoundingClientRect();
		const sx = e.clientX - rect.left;
		const sy = e.clientY - rect.top;
		const world = this.engine.camera.screenToWorld({ x: sx, y: sy });
		this.lastWorldX = world.x;
		this.lastWorldY = world.y;

		const shape = this.shapeMode();
		if (shape === 'arc') {
			this.updateArc(world.x, world.y);
			this.engine.markDirty();
			return;
		}
		if (shape) {
			this.rawEndX = world.x;
			this.rawEndY = world.y;
			this.syncShapePreview(shape);
			this.engine.markDirty();
			return;
		}

		// Interpolate between last and current position for smooth strokes
		const dx = world.x - this.lastX;
		const dy = world.y - this.lastY;
		const dist = Math.sqrt(dx * dx + dy * dy);
		const step = Math.max(1, appState.wallBrushSize / 3);
		const steps = Math.ceil(dist / step);

		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			this.stampAt(this.lastX + dx * t, this.lastY + dy * t);
		}

		this.lastX = world.x;
		this.lastY = world.y;

		// Notify ONCE per event, not once per interpolated step.
		//
		// This call used to sit inside the per-step stamp helper. Because stamping
		// marks the tiled mask dirty, every invocation forced a full
		// re-materialisation of the raster (clear width*height bytes, then copy
		// every 256x256 tile, twice over when material data exists). A fast drag
		// resolves to tens of steps, so a single pointermove could rebuild the
		// whole mask tens of times and move hundreds of megabytes. That was the
		// wall-drawing jank.
		this.flushEdit();
	}

	/**
	 * Track Shift presses that land between two pointer events. Without this the
	 * preview would only re-constrain on the next mouse move, so holding Shift
	 * after positioning a shape would look like it did nothing until release.
	 */
	setShift(down: boolean): void {
		if (this.shiftKey === down) return;
		this.shiftKey = down;
		if (!this.painting) return;

		const shape = this.shapeMode();
		if (shape === 'arc') {
			// Re-running with the same point adds a zero angle delta, so the
			// accumulated sweep is preserved and only the snapping changes.
			this.updateArc(this.lastWorldX, this.lastWorldY);
		} else if (shape) {
			this.rawEndX = this.lastWorldX;
			this.rawEndY = this.lastWorldY;
			this.syncShapePreview(shape);
		} else {
			return;
		}
		this.engine.markDirty();
	}

	/**
	 * Abandon the edit in progress, leaving nothing behind.
	 *
	 * Shape tools rasterise on release, so discarding one is free — the mask was
	 * never touched. A freehand stroke has already written to the mask by the
	 * time this is called, so it stops where it is rather than being reverted;
	 * undoing it is the undo stack's job, not this method's.
	 *
	 * Clearing `painting` is what makes the following pointerup a no-op, so the
	 * cancelled shape cannot be committed after the fact.
	 */
	cancelEdit(): void {
		this.painting = false;
		this.shiftKey = false;
		this.arcStartAngle = null;
		this.arcLastAngle = 0;
		this.arcSweep = 0;
		if (this.preview) this.preview.active = false;
		this.engine.markDirty();
	}

	handlePointerUp(e?: PointerEvent): void {
		if (!this.painting) return;
		if (e) this.shiftKey = e.shiftKey;
		this.painting = false;
		const p = this.preview;
		const shape = this.shapeMode();

		if (shape === 'arc') {
			// An arc thinner than the brush is just a dot, so ignore it — the same
			// threshold the preview uses to decide whether to draw anything.
			if (p?.active && this.arcStartAngle !== null && p.radius > p.strokeWidth / 2) {
				this.stampArc(this.arcStartAngle, p.radius, this.effectiveSweep());
			}
			if (p) p.active = false;
			this.flushEdit();
			return;
		}

		if (shape && p?.active) {
			this.syncShapePreview(shape);
			this.stampShape(shape, p.startX, p.startY, p.endX, p.endY);
			p.active = false;
		}
		this.flushEdit();
	}

	/** Run the edit callback and mark the canvas dirty exactly once. */
	private flushEdit(): void {
		this.onEdit?.();
		this.engine.markDirty();
	}

	/**
	 * The sweep that is both previewed and committed. Shift snaps it to 15 degree
	 * steps; a sweep that never got going means "closed circle", so a drag
	 * straight out from the centre produces a circle rather than nothing.
	 *
	 * This is the single source of truth for that rule, so the drag preview can
	 * never disagree with what lands in the mask on release.
	 */
	private effectiveSweep(): number {
		let sweep = this.arcSweep;
		if (this.shiftKey) {
			const step = Math.PI / 12;
			sweep = Math.round(sweep / step) * step;
		}
		return Math.abs(sweep) < 0.15 ? TAU : sweep;
	}

	/**
	 * Apply the shift constraint and push it into the preview, so what is shown
	 * during the drag is exactly what gets committed.
	 */
	private syncShapePreview(kind: 'line' | 'rect'): void {
		const p = this.preview;
		if (!p) return;
		const end = this.constrain(kind, p.startX, p.startY, this.rawEndX, this.rawEndY);
		p.endX = end.x;
		p.endY = end.y;
	}

	/**
	 * Shift constraints: rectangles become squares, lines snap to the nearest
	 * 45 degrees at constant length.
	 */
	private constrain(
		kind: 'line' | 'rect',
		x0: number,
		y0: number,
		x1: number,
		y1: number
	): { x: number; y: number } {
		if (!this.shiftKey) return { x: x1, y: y1 };
		const dx = x1 - x0;
		const dy = y1 - y0;

		if (kind === 'rect') {
			const size = Math.max(Math.abs(dx), Math.abs(dy));
			return {
				x: x0 + (dx < 0 ? -size : size),
				y: y0 + (dy < 0 ? -size : size)
			};
		}

		const len = Math.sqrt(dx * dx + dy * dy);
		if (len === 0) return { x: x1, y: y1 };
		const step = Math.PI / 4;
		const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
		return { x: x0 + Math.cos(snapped) * len, y: y0 + Math.sin(snapped) * len };
	}

	/**
	 * Arc dragging: the pointer distance from the centre sets the radius, and the
	 * direction the pointer first left the centre fixes the start angle. Rotating
	 * from there accumulates a signed sweep, so going all the way round produces a
	 * full circle.
	 */
	private updateArc(wx: number, wy: number): void {
		const p = this.preview;
		if (!p) return;
		const dx = wx - p.centerX;
		const dy = wy - p.centerY;
		const radius = Math.sqrt(dx * dx + dy * dy);
		const angle = Math.atan2(dy, dx);

		// Ignore the first few pixels: near the centre the angle is pure noise.
		if (this.arcStartAngle === null) {
			if (radius <= appState.wallBrushSize) {
				p.radius = radius;
				return;
			}
			this.arcStartAngle = angle;
			this.arcLastAngle = angle;
			this.arcSweep = 0;
		} else {
			this.arcSweep += normalizeAngle(angle - this.arcLastAngle);
			this.arcLastAngle = angle;
		}

		p.radius = radius;
		p.startAngle = this.arcStartAngle;
		p.sweep = this.effectiveSweep();
	}

	/** Rasterise a pending line or rectangle. Called once, on release. */
	private stampShape(kind: 'line' | 'rect', x0: number, y0: number, x1: number, y1: number): void {
		if (kind === 'line') {
			this.stampSegment(x0, y0, x1, y1);
			return;
		}
		// Rectangle outline: four edges, so it produces a room boundary rather
		// than a filled block.
		const minX = Math.min(x0, x1);
		const maxX = Math.max(x0, x1);
		const minY = Math.min(y0, y1);
		const maxY = Math.max(y0, y1);
		this.stampSegment(minX, minY, maxX, minY);
		this.stampSegment(maxX, minY, maxX, maxY);
		this.stampSegment(maxX, maxY, minX, maxY);
		this.stampSegment(minX, maxY, minX, minY);
	}

	private stampSegment(x0: number, y0: number, x1: number, y1: number): void {
		const dx = x1 - x0;
		const dy = y1 - y0;
		const dist = Math.sqrt(dx * dx + dy * dy);
		const step = Math.max(1, appState.wallBrushSize / 3);
		const steps = Math.max(1, Math.ceil(dist / step));
		for (let i = 0; i <= steps; i++) {
			const t = i / steps;
			this.stampAt(x0 + dx * t, y0 + dy * t);
		}
	}

	private stampArc(startAngle: number, radius: number, sweep: number): void {
		const p = this.preview;
		if (!p) return;
		const stepLen = Math.max(1, appState.wallBrushSize / 3);
		const arcLen = Math.abs(radius * sweep);
		const steps = Math.max(2, Math.ceil(arcLen / stepLen));
		for (let i = 0; i <= steps; i++) {
			const a = startAngle + sweep * (i / steps);
			this.stampAt(p.centerX + Math.cos(a) * radius, p.centerY + Math.sin(a) * radius);
		}
	}

	/** Write the brush footprint once, at a world position. */
	private stampAt(wx: number, wy: number): void {
		if (!this.tiledMask) return;

		const r = appState.wallBrushSize;
		const cx = Math.round(wx);
		const cy = Math.round(wy);
		const mode = appState.wallEditMode;
		const mask = this.tiledMask;

		if (mode === 'erase') {
			mask.paintCircle(cx, cy, r, 0);
			return;
		}

		// Shape modes lay down walls with the active material, exactly as freehand
		// draw does; only the path differs.
		if (mode === 'draw' || mode === 'line' || mode === 'rect' || mode === 'arc') {
			mask.paintCircle(cx, cy, r, 1, this.activeMaterial);
			return;
		}

		if (mode === 'material') {
			// Only paint material on existing wall pixels
			const x0 = cx - r;
			const y0 = cy - r;
			const x1 = cx + r;
			const y1 = cy + r;
			const r2 = r * r;
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > r2) continue;
					if (mask.getPixel(x, y)) {
						mask.setMaterial(x, y, this.activeMaterial);
					}
				}
			}
			// setMaterial already flags the mask dirty; no extra markDirty needed.
		}
	}
}
