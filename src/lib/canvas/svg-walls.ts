/**
 * Wall segments straight out of an SVG, instead of out of a rasterised picture.
 *
 * An SVG drawing knows where its walls are: a line is two points, a rectangle is four edges, a
 * polyline is a run of them. Going through a mask and tracing it back (as the raster path must)
 * loses that twice — once to the raster, once to the tracer's axis-aligned runs, which cannot
 * represent a diagonal wall at all. Reading the geometry is exact, keeps diagonals, and needs no
 * text masking: `<text>` is not a drawable, so room labels never enter.
 *
 * The roles come from `classifyVectorElements` (wall / window / door / fixture / text), so a
 * window stays a window and its material comes with it — the "windows merged into one long wall"
 * problem does not exist on this path.
 *
 * Coordinates come out in the same frame the mask is rendered in: user units minus the content
 * box's origin, times the scale the render used. The caller adds nothing; the result is already
 * in mask pixels, which are world units.
 */

export interface SvgSegment {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	/** The drawing element this came from, so a caller can map it back for editing. */
	element: number;
}

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const multiply = (m: Matrix, n: Matrix): Matrix => [
	m[0] * n[0] + m[2] * n[1],
	m[1] * n[0] + m[3] * n[1],
	m[0] * n[2] + m[2] * n[3],
	m[1] * n[2] + m[3] * n[3],
	m[0] * n[4] + m[2] * n[5] + m[4],
	m[1] * n[4] + m[3] * n[5] + m[5]
];

const apply = (m: Matrix, x: number, y: number): { x: number; y: number } => ({
	x: m[0] * x + m[2] * y + m[4],
	y: m[1] * x + m[3] * y + m[5]
});

/**
 * A `transform` attribute as a matrix.
 *
 * Only the forms an exporter writes into a floor plan appear here — matrix, translate, scale,
 * rotate and skew — and an unknown keyword is skipped rather than guessed at.
 */
export function parseTransform(value: string | null): Matrix {
	if (!value) return IDENTITY;
	let result = IDENTITY;
	const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
	for (const match of value.matchAll(pattern)) {
		const kind = match[1]!;
		const args = match[2]!
			.split(/[\s,]+/)
			.filter((part) => part.length > 0)
			.map(Number);
		if (args.some((n) => !Number.isFinite(n))) continue;
		let step: Matrix = IDENTITY;
		if (kind === 'matrix' && args.length >= 6) {
			step = [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
		} else if (kind === 'translate' && args.length >= 1) {
			step = [1, 0, 0, 1, args[0]!, args[1] ?? 0];
		} else if (kind === 'scale' && args.length >= 1) {
			step = [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0];
		} else if (kind === 'rotate' && args.length >= 1) {
			const radians = (args[0]! * Math.PI) / 180;
			const cos = Math.cos(radians);
			const sin = Math.sin(radians);
			const rotation: Matrix = [cos, sin, -sin, cos, 0, 0];
			if (args.length >= 3) {
				const cx = args[1]!;
				const cy = args[2]!;
				step = multiply(multiply([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy]);
			} else {
				step = rotation;
			}
		} else if (kind === 'skewX' && args.length >= 1) {
			step = [1, 0, Math.tan((args[0]! * Math.PI) / 180), 1, 0, 0];
		} else if (kind === 'skewY' && args.length >= 1) {
			step = [1, Math.tan((args[0]! * Math.PI) / 180), 0, 1, 0, 0];
		}
		result = multiply(result, step);
	}
	return result;
}

/**
 * True for a node that can answer `getAttribute`, which is all this module asks of an element.
 *
 * Deliberately structural rather than `instanceof SVGElement`: the geometry is pure arithmetic over
 * attributes, and typing it to the DOM would make every rule untestable outside a browser. The real
 * caller passes real SVG nodes; the tests pass objects with the same three members.
 */
function isElementLike(node: unknown): node is SVGElement {
	return !!node && typeof (node as SVGElement).getAttribute === 'function';
}

/** The transform from an element's own coordinates to the SVG root's user space. */
function matrixOf(element: SVGElement, stop: SVGElement): Matrix {
	let result = IDENTITY;
	let node: Element | null = element;
	const chain: SVGElement[] = [];
	while (node && node !== stop) {
		if (isElementLike(node)) chain.unshift(node);
		node = node.parentElement;
	}
	for (const item of chain) result = multiply(result, parseTransform(item.getAttribute('transform')));
	return result;
}

/** Numbers from a `points`/`d` attribute, in order. */
const numbersIn = (value: string): number[] =>
	(value.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);

/**
 * The segments one drawable element is made of, in its own coordinates.
 *
 * Anything that is not a straight line — a circle, an arc, a bezier — contributes nothing:
 * approximating it with a handful of chords would put walls where the drawing has curves, and a
 * curve in a floor plan is a fitting, not a partition. Lines, rectangles, polylines and paths made
 * of move/line/horizontal/vertical/close commands are read exactly.
 */
export function elementSegments(element: Element): Array<[number, number, number, number]> {
	const tag = element.tagName.toLowerCase();
	if (tag === 'line') {
		const x1 = Number(element.getAttribute('x1') ?? 0);
		const y1 = Number(element.getAttribute('y1') ?? 0);
		const x2 = Number(element.getAttribute('x2') ?? 0);
		const y2 = Number(element.getAttribute('y2') ?? 0);
		return [[x1, y1, x2, y2]];
	}
	if (tag === 'rect') {
		const x = Number(element.getAttribute('x') ?? 0);
		const y = Number(element.getAttribute('y') ?? 0);
		const w = Number(element.getAttribute('width') ?? 0);
		const h = Number(element.getAttribute('height') ?? 0);
		if (!(w > 0) || !(h > 0)) return [];
		return [
			[x, y, x + w, y],
			[x + w, y, x + w, y + h],
			[x + w, y + h, x, y + h],
			[x, y + h, x, y]
		];
	}
	if (tag === 'polyline' || tag === 'polygon') {
		const points = numbersIn(element.getAttribute('points') ?? '');
		const out: Array<[number, number, number, number]> = [];
		for (let i = 0; i + 3 < points.length; i += 2) {
			out.push([points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!]);
		}
		if (tag === 'polygon' && points.length >= 4) {
			out.push([
				points[points.length - 2]!,
				points[points.length - 1]!,
				points[0]!,
				points[1]!
			]);
		}
		return out;
	}
	if (tag === 'path') {
		const d = element.getAttribute('d') ?? '';
		// Only the straight-line vocabulary: a path with a curve is not a wall.
		if (/[csqta]/i.test(d)) return [];
		return pathSegments(d);
	}
	return [];
}

/**
 * Segments of a path made of M/L/H/V/Z, absolute or relative.
 *
 * The pen's position is tracked through relative commands, because the difference between `l` and
 * `L` is the whole meaning of the point, and closing a subpath is an edge like any other.
 */
export function pathSegments(d: string): Array<[number, number, number, number]> {
	const tokens = d.match(/[a-z][^a-z]*/gi) ?? [];
	const out: Array<[number, number, number, number]> = [];
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	for (const token of tokens) {
		const command = token[0]!;
		const args = numbersIn(token.slice(1));
		const relative = command === command.toLowerCase();
		const upper = command.toUpperCase();
		if (upper === 'M' && args.length >= 2) {
			x = (relative ? x : 0) + args[0]!;
			y = (relative ? y : 0) + args[1]!;
			startX = x;
			startY = y;
			// Extra coordinate pairs after a moveto are implicit linetos.
			for (let i = 2; i + 1 < args.length; i += 2) {
				const nx = (relative ? x : 0) + args[i]!;
				const ny = (relative ? y : 0) + args[i + 1]!;
				out.push([x, y, nx, ny]);
				x = nx;
				y = ny;
			}
		} else if (upper === 'L' && args.length >= 2) {
			for (let i = 0; i + 1 < args.length; i += 2) {
				const nx = (relative ? x : 0) + args[i]!;
				const ny = (relative ? y : 0) + args[i + 1]!;
				out.push([x, y, nx, ny]);
				x = nx;
				y = ny;
			}
		} else if (upper === 'H' && args.length >= 1) {
			for (const value of args) {
				const nx = (relative ? x : 0) + value;
				out.push([x, y, nx, y]);
				x = nx;
			}
		} else if (upper === 'V' && args.length >= 1) {
			for (const value of args) {
				const ny = (relative ? y : 0) + value;
				out.push([x, y, x, ny]);
				y = ny;
			}
		} else if (upper === 'Z') {
			if (x !== startX || y !== startY) out.push([x, y, startX, startY]);
			x = startX;
			y = startY;
		}
	}
	return out;
}

export interface SvgGeometryOptions {
	/** Role of each drawable, in the order the caller lists them. */
	roles: ReadonlyArray<string>;
	/** Which roles become walls. Windows and doors are walls too — they obstruct, at their own material. */
	wantedRoles?: ReadonlyArray<string>;
	/** The content box the raster pass used, and the scale it applied. */
	contentBox: { x: number; y: number; width: number; height: number };
	scale: number;
	/** Segments shorter than this (in output units) are noise. */
	minLength?: number;
}

/**
 * A window is two strokes in the drawing and one material change in the model.
 *
 * Exporters draw a window as two parallel lines (the pane's edges) inside the wall's long
 * strokes, so read literally it becomes two glass walls with the wall still running behind them:
 * the wall line is not interrupted, and the picture shows a double glass line. What the model
 * wants is one line that goes wall → glass → wall, which is what these two functions produce.
 *
 * `collapseOpenings` turns each pair of parallel, overlapping strokes into one centre line (the
 * same collapse the tracer does for a wall's two edges); `mergeOpeningsIntoWalls` then cuts the
 * wall where an opening sits and gives that piece the opening's material.
 */
export interface MaterialSegment {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: number;
}

const lengthOf = (s: MaterialSegment): number => Math.hypot(s.bx - s.ax, s.by - s.ay);

function perpendicularDistance(
	point: { x: number; y: number },
	segment: MaterialSegment
): number {
	const dx = segment.bx - segment.ax;
	const dy = segment.by - segment.ay;
	const len = Math.hypot(dx, dy);
	if (len < 1e-9) return Math.hypot(point.x - segment.ax, point.y - segment.ay);
	return Math.abs((point.x - segment.ax) * dy - (point.y - segment.ay) * dx) / len;
}

/** Position along a segment's direction, in the segment's own length units. */
function projectionAlong(point: { x: number; y: number }, segment: MaterialSegment): number {
	const dx = segment.bx - segment.ax;
	const dy = segment.by - segment.ay;
	const len = Math.hypot(dx, dy);
	if (len < 1e-9) return 0;
	return ((point.x - segment.ax) * dx + (point.y - segment.ay) * dy) / len;
}

/**
 * Collapse each pair of parallel strokes belonging to one opening into one centre line.
 *
 * Parallel by direction (cross product near zero) and close enough to be the two faces of the same
 * panes — `tolerance` in output units, so a few pixels of wall band. The longer of the pair keeps
 * its place; the shorter is dropped, and the result keeps the first one's material.
 */
export function collapseOpenings(
	openings: readonly MaterialSegment[],
	tolerance = 10
): MaterialSegment[] {
	const dropped = new Set<number>();
	for (let i = 0; i < openings.length; i++) {
		if (dropped.has(i)) continue;
		const a = openings[i]!;
		const lenA = lengthOf(a);
		if (lenA < 1e-6) continue;
		for (let j = i + 1; j < openings.length; j++) {
			if (dropped.has(j)) continue;
			const b = openings[j]!;
			const lenB = lengthOf(b);
			if (lenB < 1e-6) continue;
			// Parallel? Cross of the unit directions, scaled by the lengths.
			const cross = Math.abs((a.bx - a.ax) * (b.by - b.ay) - (a.by - a.ay) * (b.bx - b.ax));
			if (cross / (lenA * lenB) > 0.05) continue;
			// Same band, and overlapping along their own direction.
			const near = Math.max(
				perpendicularDistance({ x: b.ax, y: b.ay }, a),
				perpendicularDistance({ x: b.bx, y: b.by }, a)
			);
			if (near > tolerance) continue;
			const t0 = projectionAlong({ x: b.ax, y: b.ay }, a);
			const t1 = projectionAlong({ x: b.bx, y: b.by }, a);
			const overlap = Math.min(lenA, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
			if (overlap < Math.min(lenA, lenB) * 0.5) continue;
			// One opening, not two: drop whichever is shorter.
			dropped.add(lenB <= lenA ? j : i);
			if (lenB > lenA) break;
		}
	}
	return openings.filter((_, index) => !dropped.has(index));
}

/**
 * Cut walls where openings sit, and give the cut piece the opening's material.
 *
 * An opening that lies on no wall is returned unchanged (a freestanding pane), because dropping it
 * would delete geometry the drawing contains.
 */
export function mergeOpeningsIntoWalls(
	walls: readonly MaterialSegment[],
	openings: readonly MaterialSegment[],
	tolerance = 10
): MaterialSegment[] {
	const result: MaterialSegment[] = [];
	const remaining = [...openings];

	for (const wall of walls) {
		const len = lengthOf(wall);
		if (len < 1e-6) {
			result.push(wall);
			continue;
		}
		const cuts: Array<{ from: number; to: number; material: number }> = [];
		for (let i = remaining.length - 1; i >= 0; i--) {
			const opening = remaining[i]!;
			const far = Math.max(
				perpendicularDistance({ x: opening.ax, y: opening.ay }, wall),
				perpendicularDistance({ x: opening.bx, y: opening.by }, wall)
			);
			if (far > tolerance) continue;
			const t0 = projectionAlong({ x: opening.ax, y: opening.ay }, wall);
			const t1 = projectionAlong({ x: opening.bx, y: opening.by }, wall);
			const from = Math.max(0, Math.min(t0, t1));
			const to = Math.min(len, Math.max(t0, t1));
			if (to - from < tolerance * 0.5) continue;
			cuts.push({ from, to, material: opening.material });
			remaining.splice(i, 1);
		}
		if (cuts.length === 0) {
			result.push(wall);
			continue;
		}
		cuts.sort((a, b) => a.from - b.from);
		let cursor = 0;
		for (const cut of cuts) {
			if (cut.from > cursor + 1) result.push(piece(wall, cursor, cut.from, wall.material));
			result.push(piece(wall, Math.max(cursor, cut.from), cut.to, cut.material));
			cursor = Math.max(cursor, cut.to);
		}
		if (cursor < len - 1) result.push(piece(wall, cursor, len, wall.material));
	}
	return [...result, ...remaining];
}

/** A sub-segment of `wall` between two positions along it. */
function piece(wall: MaterialSegment, from: number, to: number, material: number): MaterialSegment {
	const len = lengthOf(wall);
	const ratioFrom = len < 1e-9 ? 0 : from / len;
	const ratioTo = len < 1e-9 ? 0 : to / len;
	return {
		ax: wall.ax + (wall.bx - wall.ax) * ratioFrom,
		ay: wall.ay + (wall.by - wall.ay) * ratioFrom,
		bx: wall.ax + (wall.bx - wall.ax) * ratioTo,
		by: wall.ay + (wall.by - wall.ay) * ratioTo,
		material
	};
}

/**
 * Every wall-shaped element of an SVG as world-unit segments.
 *
 * The caller passes the same `drawables` order the roles came from, so `roles[i]` is the role of
 * `elements[i]`; the returned `element` index is that `i`, which lets a UI map a wall back to the
 * drawing object it came from.
 */
export function segmentsFromSvg(
	root: SVGElement,
	elements: ReadonlyArray<Element>,
	options: SvgGeometryOptions
): SvgSegment[] {
	const wanted = options.wantedRoles ?? ['wall', 'window', 'door'];
	const minLength = options.minLength ?? 2;
	const out: SvgSegment[] = [];
	const { contentBox, scale } = options;

	for (let index = 0; index < elements.length; index++) {
		const element = elements[index]!;
		if (!wanted.includes(options.roles[index] ?? 'unknown')) continue;
		const matrix = matrixOf(element as SVGElement, root);
		for (const [x1, y1, x2, y2] of elementSegments(element)) {
			const a = apply(matrix, x1, y1);
			const b = apply(matrix, x2, y2);
			// Into the rendered frame: the render put contentBox's origin at (0,0) and scaled.
			const ax = (a.x - contentBox.x) * scale;
			const ay = (a.y - contentBox.y) * scale;
			const bx = (b.x - contentBox.x) * scale;
			const by = (b.y - contentBox.y) * scale;
			if (Math.hypot(bx - ax, by - ay) < minLength) continue;
			out.push({ ax, ay, bx, by, element: index });
		}
	}
	return out;
}
