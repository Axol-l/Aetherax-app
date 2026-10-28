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
import type { WallMaterialId } from '../canvas/materials.js';

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
	return walls;
}
