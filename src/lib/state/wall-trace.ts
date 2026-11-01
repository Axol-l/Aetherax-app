/**
 * Deriving line segments from a painted wall mask.
 *
 * The vector model is only usable if a plan does not have to be redrawn by hand: nobody will
 * trace a six-storey building twice. So the mask — which detection already produces, and
 * which every existing project has — is read for its centre lines instead.
 *
 * The method is deliberately simple and orthogonal: a wall band is a run of wall pixels, so
 * the *middle* of a run is a centre line. Horizontal runs give horizontal segments, vertical
 * runs give vertical segments, and a thick band collapses because the runs across it are
 * shorter than the minimum length — one long segment per band, not one per row.
 *
 * Runs on the same line are merged, so a wall interrupted by a door frame or a text label
 * becomes one segment rather than three. That is a choice worth stating: the merge is what
 * makes the output usable, and it costs the ability to represent a genuine short gap. A gap
 * that matters can be re-cut by hand afterwards.
 *
 * Everything here is in mask pixels, which are world units; the caller adds the mask origin.
 */
import type { WallMaterialId } from '$lib/domain/materials.js';
import { getFloorMask } from './floor-mask.js';
import { floorState } from './floor-state.svelte.js';

export interface TracedWall {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: WallMaterialId;
}

export interface TraceOptions {
	/** Runs shorter than this are cross-sections, not walls. */
	minLength?: number;
	/** Runs within this many rows/columns of each other, and overlapping, are one wall. */
	mergeGap?: number;
	/** Ends closer than this are joined, so corners and T junctions close up. */
	joinGap?: number;
}

interface Run {
	/** Row for a horizontal run, column for a vertical one. */
	line: number;
	from: number;
	to: number;
	material: WallMaterialId;
}

/** The most common material in a run, with zero (unpainted) replaced by the default. */
function modeMaterial(
	material: Uint8Array | null,
	base: number,
	stride: number,
	from: number,
	to: number,
	defaultMaterial: WallMaterialId
): WallMaterialId {
	if (!material) return defaultMaterial;
	const counts = new Map<number, number>();
	for (let i = from; i <= to; i++) {
		const id = material[base + i * stride] || defaultMaterial;
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	let best = defaultMaterial as number;
	let bestCount = -1;
	for (const [id, count] of counts) {
		if (count > bestCount) {
			best = id;
			bestCount = count;
		}
	}
	return best as WallMaterialId;
}

/** Every wall run along one axis, long enough to be a wall rather than a cross-section. */
function runsAlong(
	wall: Uint8Array,
	material: Uint8Array | null,
	width: number,
	height: number,
	horizontal: boolean,
	minLength: number,
	defaultMaterial: WallMaterialId
): Run[] {
	const runs: Run[] = [];
	const lines = horizontal ? height : width;
	const span = horizontal ? width : height;
	for (let line = 0; line < lines; line++) {
		let start = -1;
		for (let i = 0; i <= span; i++) {
			const inside = i < span && wall[horizontal ? line * width + i : i * width + line];
			if (inside && start < 0) start = i;
			if (!inside && start >= 0) {
				const end = i - 1;
				if (end - start + 1 >= minLength) {
					const base = horizontal ? line * width : line;
					runs.push({
						line,
						from: start,
						to: end,
						material: modeMaterial(material, base, horizontal ? 1 : width, start, end, defaultMaterial)
					});
				}
				start = -1;
			}
		}
	}
	return runs;
}

/**
 * Merge runs that lie on the same wall.
 *
 * Two runs join when they are on adjacent lines and their spans overlap substantially. The
 * result keeps the longer span and the most common material, so a band painted in two
 * materials becomes one segment in the majority material — visible in the output, and a
 * hand edit away from being right.
 */
function mergeRuns(runs: Run[], mergeGap: number): Run[] {
	const sorted = [...runs].sort((a, b) => a.line - b.line || a.from - b.from);
	const merged: Run[] = [];
	for (const run of sorted) {
		const host = merged.find((candidate) => {
			if (Math.abs(candidate.line - run.line) > mergeGap) return false;
			/*
			 * Only runs of the same material are one wall.
			 *
			 * Detection paints windows and doors into their own material, and merging across
			 * materials turned a run of windows into the room's whole top wall: one long line at
			 * the wall's material, with the openings gone. A window band stays a window segment,
			 * and the wall it sits in stays the wall.
			 */
			if (candidate.material !== run.material) return false;
			const overlap = Math.min(candidate.to, run.to) - Math.max(candidate.from, run.from);
			const shortest = Math.min(candidate.to - candidate.from, run.to - run.from);
			// The two cases this has to catch: the rows of one thick band overlap almost
			// exactly, and the halves of a wall interrupted by a door frame barely touch at
			// all. Both are one wall, so a small gap along the run counts as contiguous.
			const alongGap = Math.max(candidate.from, run.from) - Math.min(candidate.to, run.to);
			if (overlap > shortest * 0.5 && shortest >= 0) return true;
			return alongGap <= mergeGap * 2;
		});
		if (!host) {
			merged.push({ ...run });
			continue;
		}
		host.from = Math.min(host.from, run.from);
		host.to = Math.max(host.to, run.to);
		// The merged line averages the two, so a thick band lands mid-thickness.
		host.line = Math.round((host.line + run.line) / 2);
	}
	return merged;
}

/** The wall's thickness at a point, measured across its own normal. */
function thicknessAt(
	wall: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	horizontal: boolean,
	maxProbe = 24
): number {
	let count = 0;
	for (let d = -maxProbe; d <= maxProbe; d++) {
		const px = horizontal ? Math.round(x) : Math.round(x) + d;
		const py = horizontal ? Math.round(y) + d : Math.round(y);
		if (px < 0 || py < 0 || px >= width || py >= height) continue;
		if (wall[py * width + px]) count++;
	}
	return count;
}

/**
 * Clean up what tracing produced.
 *
 * Three passes, each removing a way the raw output over-states the walls — and over-stating
 * them is not cosmetic: every extra segment is another crossing a ray is charged for, so a
 * plan traced this way came out at 5.98 dB where the mask charges 4.60.
 *
 * 1. **Cross-sections out.** A run along the *short* axis of a thick band is as long as the
 *    band is thick; a wall is much longer than it is thick. Both passes produce candidates,
 *    so this is what stops a band being traced twice.
 * 2. **Parallel overlaps merged.** Two collinear segments covering the same stretch are one
 *    wall; the raw output can produce them where a band is slightly stepped.
 * 3. **Ends joined.** Two segments whose ends are within a few units meet at their midpoint,
 *    and an end that lands on another segment is projected onto it — a T junction snaps shut
 *    instead of leaving the sliver a ray slips through.
 */
export function pruneWalls(
	walls: readonly TracedWall[],
	wall: Uint8Array,
	width: number,
	height: number,
	options: TraceOptions = {}
): TracedWall[] {
	const joinGap = options.joinGap ?? 6;
	const kept: TracedWall[] = [];

	// 1. Drop cross-sections: length must exceed the band's thickness a few times over.
	for (const candidate of walls) {
		const horizontal = Math.abs(candidate.ay - candidate.by) < Math.abs(candidate.ax - candidate.bx);
		const length = Math.hypot(candidate.bx - candidate.ax, candidate.by - candidate.ay);
		const midX = (candidate.ax + candidate.bx) / 2;
		const midY = (candidate.ay + candidate.by) / 2;
		const thickness = thicknessAt(wall, width, height, midX, midY, horizontal);
		if (length < Math.max(12, thickness * 2.5)) continue;
		kept.push({ ...candidate });
	}

	// 2. Merge collinear overlaps.
	const merged: TracedWall[] = [];
	for (const candidate of kept) {
		const horizontal = candidate.ay === candidate.by;
		const host = merged.find((other) => {
			const otherHorizontal = other.ay === other.by;
			if (otherHorizontal !== horizontal) return false;
			const sameLine = horizontal
				? Math.abs(other.ay - candidate.ay) <= 3
				: Math.abs(other.ax - candidate.ax) <= 3;
			if (!sameLine) return false;
			if (horizontal) {
				const overlap = Math.min(other.bx, candidate.bx) - Math.max(other.ax, candidate.ax);
				return overlap > 0;
			}
			const overlap = Math.min(other.by, candidate.by) - Math.max(other.ay, candidate.ay);
			return overlap > 0;
		});
		if (!host) {
			merged.push({ ...candidate });
			continue;
		}
		if (horizontal) {
			host.ax = Math.min(host.ax, candidate.ax);
			host.bx = Math.max(host.bx, candidate.bx);
			host.ay = host.by = Math.round((host.ay + candidate.ay) / 2);
		} else {
			host.ay = Math.min(host.ay, candidate.ay);
			host.by = Math.max(host.by, candidate.by);
			host.ax = host.bx = Math.round((host.ax + candidate.ax) / 2);
		}
	}

	// 3. Join the ends: first two loose ends that nearly meet, then any end resting on a wall.
	const near = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
	for (let i = 0; i < merged.length; i++) {
		for (let j = i + 1; j < merged.length; j++) {
			const a = merged[i]!;
			const b = merged[j]!;
			const pairs: Array<[ 'ax' | 'bx', 'ax' | 'bx' ]> = [
				['ax', 'ax'],
				['ax', 'bx'],
				['bx', 'ax'],
				['bx', 'bx']
			];
			for (const [pa, pb] of pairs) {
				const ax = pa === 'ax' ? a.ax : a.bx;
				const ay = pa === 'ax' ? a.ay : a.by;
				const bx = pb === 'ax' ? b.ax : b.bx;
				const by = pb === 'ax' ? b.ay : b.by;
				if (near(ax, ay, bx, by) > joinGap) continue;
				const mx = (ax + bx) / 2;
				const my = (ay + by) / 2;
				if (pa === 'ax') {
					a.ax = mx;
					a.ay = my;
				} else {
					a.bx = mx;
					a.by = my;
				}
				if (pb === 'ax') {
					b.ax = mx;
					b.ay = my;
				} else {
					b.bx = mx;
					b.by = my;
				}
			}
		}
	}

	return merged;
}

/** Wall segments traced from the painted mask, in mask pixels. */
export function traceWallsFromMask(
	wall: Uint8Array,
	material: Uint8Array | null,
	width: number,
	height: number,
	defaultMaterial: WallMaterialId,
	options: TraceOptions = {}
): TracedWall[] {
	if (width <= 0 || height <= 0) return [];
	// A cross-section is as wide as the band; a wall is much longer. Twelve units is a bit
	// more than the widest brush the raster tool offers, so a stroke's cross-section cannot
	// pass as a wall while even a short real wall can.
	const minLength = options.minLength ?? 12;
	const mergeGap = options.mergeGap ?? 3;

	const horizontal = mergeRuns(
		runsAlong(wall, material, width, height, true, minLength, defaultMaterial),
		mergeGap
	);
	const vertical = mergeRuns(
		runsAlong(wall, material, width, height, false, minLength, defaultMaterial),
		mergeGap
	);

	const walls: TracedWall[] = [];
	for (const run of horizontal) {
		walls.push({ ax: run.from, ay: run.line, bx: run.to, by: run.line, material: run.material });
	}
	for (const run of vertical) {
		walls.push({ ax: run.line, ay: run.from, bx: run.line, by: run.to, material: run.material });
	}
	return pruneWalls(walls, wall, width, height, options);
}

/**
 * Write a floor's walls from geometry a vector reader produced.
 *
 * The exact path: the drawing said where its walls are, so nothing is traced and nothing is
 * approximated. Returns how many segments were written — zero means the caller should fall back to
 * tracing the mask (a drawing whose elements are all curves).
 */
export function setFloorWallsFromSegments(
	floorId: string,
	segments: ReadonlyArray<{ ax: number; ay: number; bx: number; by: number; material: number }>
): number {
	const floor = floorState.floors.find((candidate) => candidate.id === floorId);
	if (!floor) return 0;
	floor.walls = segments.map((segment) => ({
		id: crypto.randomUUID(),
		ax: segment.ax,
		ay: segment.ay,
		bx: segment.bx,
		by: segment.by,
		material: segment.material as WallMaterialId
	}));
	floor.columns = [];
	return floor.walls.length;
}

/**
 * Trace a floor's current mask into its wall segments.
 *
 * **Every** path that produces a mask has to run this, or the floor is left with geometry the
 * drawing cannot show: the vector layer paints segments, so a mask-only floor draws nothing (or,
 * worse, the raster band) and cannot be edited. It was wired into Re-detect only, which is why an
 * *import* still came out as a picture — the import sets its mask on a different code path
 * (`importFloorplanFile`, and `runBoundaryDetection` in the sidebar). One helper called from all
 * three is the only way they stay in step.
 *
 * The mask is read through `getFloorMask`, so the caller must have cleared `floor.walls` first: a
 * floor with segments derives its mask *from* them rather than from the detection.
 *
 * Returns how many segments were written (0 means the mask had no long runs to trace, and the
 * raster mask is all the floor has).
 */
export async function traceFloorWalls(floorId: string): Promise<number> {
	const floor = floorState.floors.find((candidate) => candidate.id === floorId);
	if (!floor) return 0;
	const decoded = await getFloorMask(floorId);
	if (!decoded) return 0;
	const traced = traceWallsFromMask(
		decoded.wallData,
		decoded.materialMap,
		decoded.width,
		decoded.height,
		floor.wallMaterial as WallMaterialId,
		/*
		 * Long enough to be a wall, not a piece of furniture.
		
		 * The default minimum is twelve pixels, which is right for a hand-painted mask (a brush
		 * stroke's cross-section) but too permissive for a detected plan: a desk, a table or a
		 * row of hatching in a drawing is a run of twenty or thirty pixels, and every one of them
		 * became a wall — a stub in the drawing, and a narrow shadow in the heatmap. Twenty-four
		 * pixels is about a door's width at the import's target size, so a real partition still
		 * survives and furniture does not.
		 */
		{ minLength: 24 }
	);
	floor.walls = traced.map((wall) => ({
		id: crypto.randomUUID(),
		ax: wall.ax + decoded.originX,
		ay: wall.ay + decoded.originY,
		bx: wall.bx + decoded.originX,
		by: wall.by + decoded.originY,
		material: wall.material
	}));
	floor.columns = [];
	return floor.walls.length;
}
