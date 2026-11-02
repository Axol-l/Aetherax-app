import type { Layer, RenderContext } from '../types.js';
import { ACCENT_STROKE, ACCENT_TEXT } from '../accents.js';
import type { FloorCardCache} from './floor-card.js';
import { type FloorCardSource, type FloorHeatmap } from './floor-card.js';

/** Gap between tiles, in world units. */
const GAP = 120;
/** Slop around a tile that still counts as a hit, so clicking a card is easy. */
const HIT_PAD = 24;

interface TileLayout {
	id: string;
	/** World-space rectangle of the tile's frame. */
	x: number;
	y: number;
	w: number;
	h: number;
	/**
	 * This floor's own content box, in world units — the mask, when it has one.
	 *
	 * The frame is one cell size for every tile so the grid lines up, but a floor
	 * smaller than the largest one leaves empty margin inside its frame. Content is
	 * clipped to this box rather than to the frame: the coverage image is generated
	 * for the plan plus each AP's reach, so clipping to the frame let a small
	 * floor's heat spill into that margin as a hard-edged rectangle, floating
	 * outside the plan it belongs to.
	 */
	boxW: number;
	boxH: number;
	/** World-space shift that puts this floor's content inside the frame. */
	dx: number;
	dy: number;
}

/**
 * Read-only overview of every floor, laid out side by side.
 *
 * Editing a tiled view would mean running the wall editor, the heatmap and the
 * AP interactions once per floor, each against its own tile origin. That is a
 * lot of machinery for a view whose job is to let you see all the floors at once
 * and jump to one. So this draws a contact sheet — underlay, wall silhouette,
 * AP dots, floor name — and a click switches floors. `StackedFloorsLayer` is the
 * other layout of the same card; `floor-card.ts` holds what they share.
 *
 * The layout is recomputed on every render rather than cached. It is a few
 * floors of arithmetic, and a cached layout would have to be invalidated from
 * four different kinds of change (floor list, mask, plan, image load) with no way
 * to notice a missed one; a stale layout would put a tile's content under the
 * neighbouring tile's click target.
 */
export class FloorTilesLayer implements Layer {
	id = 'floor-tiles';
	visible = false;
	currentFloorId: string | null = null;
	/**
	 * Layer toggles, applied to every tile.
	 *
	 * The LAYERS panel has to mean the same thing in every view. It used to do
	 * nothing here: the single-floor layers are hidden while tiled, so flipping
	 * them changed nothing on screen and the panel looked broken.
	 */
	showPlan = true;
	showWalls = true;
	showAPs = true;
	showHeatmap = false;
	/** Underlay alpha, shared with the single-floor view. */
	planOpacity = 0.8;
	/** The sheet's reference scale, which every floor's drawing is converted into. */
	wupm = 1;

	private sources: FloorCardSource[] = [];

	constructor(private readonly cards: FloorCardCache) {}

	/** Per-floor coverage images. Owned by the shared cache, filled in by the caller. */
	get heatmaps(): Map<string, FloorHeatmap> {
		return this.cards.heatmaps;
	}

	/** Called once a plan image finishes loading, so the engine can repaint. */
	set onLoad(fn: (() => void) | null) {
		this.cards.onLoad = fn;
	}

	setFloors(sources: FloorCardSource[], currentFloorId: string | null, wupm: number): void {
		this.currentFloorId = currentFloorId;
		this.wupm = wupm;
		this.cards.sync(sources);
		this.sources = sources;
	}

	/** World-space rectangle each tile occupies, in world units. */
	computeLayout(): TileLayout[] {
		if (this.sources.length === 0) return [];

		// One cell size for every tile, so the grid lines up. Sizing each row
		// independently left the columns ragged, which reads as a mistake rather
		// than as a layout.
		let cellW = 0;
		let cellH = 0;
		const boxes = this.sources.map((s) => {
			const box = this.cards.contentBox(s, this.wupm);
			cellW = Math.max(cellW, box.w);
			cellH = Math.max(cellH, box.h);
			return { s, box };
		});

		// Square-ish grid. One or two floors read better in a single row.
		const n = boxes.length;
		const cols = n <= 2 ? n : Math.ceil(Math.sqrt(n));

		return boxes.map((m, i) => {
			const x = (i % cols) * (cellW + GAP);
			const y = Math.floor(i / cols) * (cellH + GAP);
			// Each floor's own content is aligned on the tile's top-left, so a small
			// floor is not stretched to match a large one.
			return {
				id: m.s.id,
				x,
				y,
				w: cellW,
				h: cellH,
				boxW: m.box.w,
				boxH: m.box.h,
				dx: x - m.box.minX,
				dy: y - m.box.minY
			};
		});
	}

	/** Which floor a world-space point falls on, or null. */
	tileAt(worldX: number, worldY: number): string | null {
		for (const t of this.computeLayout()) {
			if (
				worldX >= t.x - HIT_PAD &&
				worldX <= t.x + t.w + HIT_PAD &&
				worldY >= t.y - HIT_PAD &&
				worldY <= t.y + t.h + HIT_PAD
			) {
				return t.id;
			}
		}
		return null;
	}

	/** Bounds of the whole sheet, for fitting the camera. */
	contentBounds(): Array<{ x: number; y: number }> {
		const tiles = this.computeLayout();
		if (tiles.length === 0) return [];
		let maxX = 0;
		let maxY = 0;
		for (const t of tiles) {
			maxX = Math.max(maxX, t.x + t.w);
			maxY = Math.max(maxY, t.y + t.h);
		}
		return [
			{ x: 0, y: 0 },
			{ x: maxX, y: maxY }
		];
	}

	render(rc: RenderContext): void {
		if (!this.visible) return;
		const { ctx, camera } = rc;
		const tiles = this.computeLayout();
		if (tiles.length === 0) return;

		const [a, b, c, d, e, f] = camera.getTransform();
		const zoom = camera.state.zoom || 1;

		ctx.save();
		ctx.transform(a, b, c, d, e, f);

		for (const tile of tiles) {
			const src = this.sources.find((s) => s.id === tile.id);
			if (!src) continue;

			// Frame and label are drawn at constant screen size; only the floor's
			// own content scales with the camera.
			const isCurrent = src.id === this.currentFloorId;

			ctx.fillStyle = 'rgba(255,255,255,0.03)';
			ctx.fillRect(tile.x, tile.y, tile.w, tile.h);

			ctx.strokeStyle = isCurrent ? ACCENT_STROKE : 'rgba(255,255,255,0.18)';
			ctx.lineWidth = (isCurrent ? 2 : 1) / zoom;
			ctx.strokeRect(tile.x, tile.y, tile.w, tile.h);

			ctx.font = `${13 / zoom}px sans-serif`;
			ctx.fillStyle = isCurrent ? ACCENT_TEXT : 'rgba(255,255,255,0.55)';
			ctx.textBaseline = 'bottom';
			ctx.fillText(src.name, tile.x, tile.y - 6 / zoom);

			ctx.save();
			ctx.beginPath();
			// This floor's own box, not the frame: see `TileLayout.boxW`.
			ctx.rect(tile.x, tile.y, tile.boxW, tile.boxH);
			ctx.clip();
			ctx.translate(tile.dx, tile.dy);
			this.cards.draw(ctx, src, {
				showPlan: this.showPlan,
				showWalls: this.showWalls,
				showAPs: this.showAPs,
				showHeatmap: this.showHeatmap,
				planOpacity: this.planOpacity,
				zoom,
				wupm: this.wupm
			});
			ctx.restore();
		}

		ctx.restore();
	}
}
