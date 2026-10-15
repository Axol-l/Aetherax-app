/**
 * Classify the elements of a **vector** floorplan into walls, openings and everything
 * else — without any pixel thresholding.
 *
 * Why this exists at all: the raster pipeline flattens an SVG to a bitmap and then
 * asks which pixels look like walls. That discards the file's own structure. On the
 * plans this project ships, that is measurably expensive — `office-300sqm.svg` comes
 * back with 8 doors, 8 windows and 11 desks all inside the wall mask, and
 * `little-white-house.svg` (an Illustrator export) comes back with the whole drawing
 * inverted until the alpha fix, and its room labels as walls even after it.
 *
 * The insight that makes this cheap: a vector drawing is a list of **objects**, so
 * "which of these is a wall" is a classification problem over a handful of items,
 * not a segmentation problem over a million pixels. And it can be answered three
 * ways, in decreasing order of how much the file tells you:
 *
 * 1. **It names them.** `class="door"`, `inkscape:label="Walls"`, `id="window-3"`.
 *    The shipped samples do exactly this and it is exact. `NAME_RULES`.
 * 2. **It paints them distinguishably.** A wall is a *line* (stroke, no fill); a room
 *    is an *area* (fill, no stroke); a window is two parallel thin lines; a door is an
 *    arc. `little-white-house.svg` has no names at all, and this is enough: 2 of its
 *    185 drawable elements carry the entire wall network as strokes.
 * 3. **It neither names nor separates them.** Then relative geometry is all that is
 *    left: `state-floor.svg` gives every element a 1 px stroke except 13 at 6.8 px,
 *    and those 13 are the walls. `WIDTH_CLUSTER_RATIO`.
 *
 * Anything past that — a plan whose walls and labels are the same path, which is what
 * `little-white-house.svg` turns out to be — cannot be separated per element and needs
 * per-subpath work. This module reports `unknown` rather than guessing, which is what
 * the review UI is for.
 *
 * Pure: `classifyVectorElements` takes plain facts and returns roles, so it is unit
 * testable without a DOM. `describeSvgElements` is the thin browser-side adapter that
 * produces those facts (it resolves *computed* style, which is what makes it work on
 * a file that paints through a `<style>` block rather than attributes), and
 * `describeSvgElements`'s caller passes the drawing's area so a filled shape can be
 * judged against the plan rather than against a pixel count.
 */

export type ElementRole =
	| 'wall'
	/** Glass in a wall: keeps the wall's topology, takes the glass material. */
	| 'window'
	/** A leaf or swing arc: topology as a wall, a low-loss material. */
	| 'door'
	/** Lettering and dimension text: dropped, it is not a barrier. */
	| 'text'
	/** Sanitary ware, furniture, appliances: dropped. */
	| 'fixture'
	/** Looked like nothing in particular. The caller decides; dropping is safest. */
	| 'unknown';

/** Everything the classifier is allowed to look at. No DOM, no canvas. */
export interface VectorElementFacts {
	tag: string;
	/**
	 * Every name the element carries, lowercased and space-joined: class names, id,
	 * and a non-standard label attribute (`inkscape:label`, `data-name`). This is the
	 * highest-value input — a file that names its walls needs no heuristics.
	 */
	name: string;
	strokeWidth: number;
	hasStroke: boolean;
	hasFill: boolean;
	/** Computed `stroke`, e.g. `rgb(26, 26, 26)`, or `none`. */
	stroke: string;
	/** Computed `fill`, or `none`. */
	fill: string;
	/** Path length in user units, from `getTotalLength()`. 0 when unavailable. */
	length: number;
	/** Bounding box in user units. `getBBox()` is local, so this is pre-transform. */
	x: number;
	y: number;
	/** Axis-aligned extent in user units. */
	width: number;
	height: number;
	/** Arc or bezier present — a door swing is the usual reason. */
	curved: boolean;
	/**
	 * The arc a curve actually traces, measured. Null for anything that is not one open
	 * curve — see `measureArc` for why this is sampled rather than parsed.
	 */
	arc: ArcMeasurement | null;
	/** Subpath count: `M` commands. Lettering is many tiny closed subpaths. */
	subpaths: number;
}

/**
 * What a stroked curve actually is: how far apart its ends are, how far it bulges, and
 * the circle that bulge implies.
 *
 * `chord` is the load-bearing one. A swing arc is an **open** curve whose ends meet the
 * two jambs of an opening; a curve whose ends coincide is a loop — a basin, a round
 * table, an arched portico — and calling that a door was the false positive this exists
 * to remove: `state-floor.svg`'s only "door" was a closed 424-unit outline with a chord
 * of zero.
 */
export interface ArcMeasurement {
	/** Distance between the two ends. Zero for a closed curve. */
	chord: number;
	/** Radius of the circle the bulge implies, or null when there is no bulge. */
	radius: number | null;
	/** How much of the circle the curve covers, in degrees, or null without a radius. */
	sweep: number | null;
	/** The curve changes side relative to its chord: an S, not an arc. */
	sShaped: boolean;
}

export interface ClassifiedElement extends VectorElementFacts {
	role: ElementRole;
	/** Which rule decided, for the review UI and for the tests. */
	reason: string;
}

/**
 * How much wider the widest stroke class must be than the next one before width is
 * treated as evidence at all.
 *
 * A drawing's stroke widths are picked from a handful of values — 5 px outer walls,
 * 3.5 px partitions, 1.5 px openings, 1 px fixtures — so the wall set is whatever
 * sits above the widest gap in that list, and a list with no gap in it carries no
 * information about walls. `little-white-house.svg` is the case that sets the
 * number: one 2 px stroke against five at 1 px, a ratio of exactly 2.
 */
const WIDTH_SPREAD_MIN = 1.5;

/** Long-thin enough to be a filled wall (poché) rather than a room. */
const POCHÉ_ASPECT = 6;

/**
 * How big a filled shape must be, as a share of the drawing, before it can be a wall.
 *
 * The poché problem: `state-floor.svg` draws its walls as ~56 small filled blocks,
 * none of them long and thin, so the aspect rule above drops the lot and only the
 * perimeter survives. The blocks carry the drawing's own dark wall brown, which looks
 * like the answer — until `little-white-house.svg`, whose room labels are outlined
 * lettering **in that same brown**. Measured on both files:
 *
 * | | poché blocks | lettering glyphs | room fills |
 * |---|---|---|---|
 * | share of drawing | 0.5 %–6.5 % | 0.01 %–0.1 % | 0.7 %–8 % |
 * | brightest channel | 138 | 138 | 193–255 |
 *
 * Size alone separates lettering from blocks by a factor of five. It does **not**
 * separate blocks from rooms — those overlap completely — which is what the brightness
 * test below is for. Stroke width separates nothing here: the blocks are 1 px while
 * one *room* fill is 6.8 px.
 *
 * The cost of the threshold: the smaller blocks (0.2 %–0.5 %) stay dropped. That is the
 * safe direction — a wall missed under-reports coverage, a glyph admitted invents a
 * barrier across a room.
 */
const POCHÉ_MIN_AREA_SHARE = 0.005;

/**
 * The brightest channel a filled shape may have and still be wall-coloured.
 *
 * Runs of wall poché are dark in *every* channel (138, 121, 88), while a room is a
 * colour with a bright one — cream (255, 241, 218), red (233, 86, 82), blue (71, 117,
 * 209), green (125, 193, 68). Luminance would not do it: the red room computes to 129
 * against the walls' 122, a 7-point margin. The brightest channel puts every wall
 * colour under 160 and every room colour over 190.
 *
 * The known risk, stated rather than hidden: a drawing whose *rooms* are filled dark
 * — a night-mode plan, a parking level rendered solid grey — would have those rooms
 * recovered as walls. The size threshold keeps furniture out, and a wall wrongly
 * added is visible (a solid block where a room was) in a way a wall wrongly missed is
 * not, which is the direction this whole rule leans.
 */
const POCHÉ_MAX_CHANNEL = 160;

/**
 * Whether a thin curve is a door swing, and the reason to report if it is.
 *
 * The old rule was "thin, unfilled and curved", which called every arc in the drawing a
 * door — stair rails, arched porticos, the curve of a basin. Measured against the three
 * samples that name their doors, a real swing is:
 *
 * | | true doors (18 of them) | `state-floor.svg`'s one false door |
 * |---|---|---|
 * | chord | 40–50 | **0** |
 * | radius | 40–50 | — |
 * | sweep | 60° | — |
 * | path length | 42–52 | 424 |
 *
 * So the test is the shape of an arc, not the presence of a curve: **open** (the ends do
 * not meet — a swing spans an opening, a loop spans nothing), a single bulge rather than
 * an S, and between `SWING_MIN_SWEEP` and `SWING_MAX_SWEEP` of a circle. Real plans draw
 * a swing as a quarter circle; these samples simplify it to 60°, which is why the band is
 * generous in both directions rather than pinned at 90.
 *
 * The plan-relative radius bound is the second line of defence, for a curve that is
 * open and arc-shaped but simply too big to be a door leaf — a bowed wall, a curved
 * balcony rail. It is relative because a drawing is in no particular unit.
 *
 * A curve that fails is left `unknown`, not a wall: it appears in the review panel as a
 * question, where a wrong "door" would have quietly put a 5 dB hole in a wall.
 */
function swingArcOf(fact: VectorElementFacts, planArea: number): string | null {
	const arc = fact.arc;
	if (!arc) return null;
	if (arc.chord <= 0) return null;
	if (arc.sShaped) return null;
	if (arc.sweep === null || arc.radius === null) return null;
	if (arc.sweep < SWING_MIN_SWEEP || arc.sweep > SWING_MAX_SWEEP) return null;

	// Relative to the drawing, so it holds whatever the units are: the plan's own width
	// is the square root of its area, and a door leaf is a small fraction of a building.
	const radiusShareOfPlan = planArea > 0 ? arc.radius / Math.sqrt(planArea) : 0;
	if (radiusShareOfPlan > SWING_MAX_RADIUS_SHARE) return null;

	return `swing arc (${arc.sweep.toFixed(0)}° of r=${arc.radius.toFixed(0)})`;
}

/**
 * The sweep a door swing may cover.
 *
 * A quarter circle is the convention and these samples draw 60°; below 40° the curve is
 * too flat to be a swing and looks like a leader line or a slightly bowed wall, and above
 * 135° it is most of a loop — a basin, a round fixture.
 */
const SWING_MIN_SWEEP = 40;
const SWING_MAX_SWEEP = 135;

/**
 * The largest radius a swing may have, as a share of the plan's own width.
 *
 * A door leaf is roughly 0.8–1.2 m; a building is tens of metres across, so a swing's
 * radius is a few percent of the plan's width. Measured: 40 / 440 = 9 % on
 * `apartment-48sqm.svg`, 50 / 700 = 7 % on `office-300sqm.svg`. The cut sits at 25 %, so
 * it rejects only curves that are plainly structure rather than a leaf.
 */
const SWING_MAX_RADIUS_SHARE = 0.25;

/**
 * The most subpaths a filled shape may hold and still be a wall block.
 *
 * A poché block is one rectangle or one simple outline — measured 1–3 subpaths on
 * `state-floor.svg`. Its room labels are the exception that makes this necessary: each
 * *word* is a single filled path holding 11–21 letter outlines, and a word's bounding
 * box is big enough to pass the size test, which left "CROSS HALL" and friends standing
 * as thin walls across their rooms.
 *
 * The shape of the risk on the other side: a wall drawn as one path with many dashed
 * subpaths would now be dropped by this rule. That drawing exists in principle; it has
 * not appeared in the corpus, and it is the failure this rule trades against the one
 * that did.
 */
const POCHÉ_MAX_SUBPATHS = 6;

/**
 * Painter's colours, normalised for comparison: `rgb(138, 121, 88)` and
 * `rgb(138,121,88)` are the same brown and must compare equal.
 */
function colourKey(value: string | undefined): string | null {
	if (!value) return null;
	const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
	if (!m) return null;
	return `${m[1]},${m[2]},${m[3]}`;
}

/** The brightest channel of a colour, or null when it is not a plain `rgb()`. */
function brightestChannel(value: string | undefined): number | null {
	const key = colourKey(value);
	if (!key) return null;
	return Math.max(...key.split(',').map(Number));
}

/**
 * Two thin parallel lines closer than this multiple of their own stroke width are
 * one window rather than two walls. The shipped samples draw them 4 px apart at
 * 1.5 px stroke; a wall pair would be a room's two sides, orders of magnitude apart.
 */
const WINDOW_PAIR_GAP = 8;

/** Name fragments, checked in order. First match wins, so `door` beats `wall`. */
const NAME_RULES: ReadonlyArray<{ role: ElementRole; match: RegExp }> = [
	// Openings first: "door-wall" or "wall-window" should read as the opening.
	{ role: 'door', match: /(^|[\s_-])(door|doors|doorway|opening|gate|entry)([\s_-]|$)/ },
	{ role: 'window', match: /(^|[\s_-])(window|windows|glaz|glass|wind)([\s_-]|$)/ },
	{
		role: 'text',
		match:
			/(^|[\s_-])(text|label|labels|dim|dims|dimension|dimensions|annotation|roomname|title|name)([\s_-]|$)/
	},
	{
		role: 'fixture',
		match:
			/(^|[\s_-])(fixture|fixtures|furniture|desk|desks|chair|chairs|table|tables|sanitary|toilet|sink|basin|bath|shower|appliance|equipment|stair|stairs|staircase)([\s_-]|$)/
	},
	{
		role: 'wall',
		match: /(^|[\s_-])(wall|walls|iwall|iwalls|partition|partitions|muro|wand)([\s_-]|$)/
	}
];

/** The role a name claims, or null when no fragment matches. */
export function roleFromName(name: string): { role: ElementRole; reason: string } | null {
	for (const rule of NAME_RULES) {
		if (rule.match.test(name)) {
			return { role: rule.role, reason: `named "${name.trim()}"` };
		}
	}
	return null;
}

/**
 * Assign a role to every element.
 *
 * Order is deliberate: a name beats geometry, because a name is the draughtsman's
 * own statement and geometry is an inference. Within the geometry pass, a *line*
 * (stroke, no fill) can be a wall, a window or a door; an *area* (fill) with a thin
 * stroke is a room and is dropped unless it is long and thin enough to be poché.
 */
export function classifyVectorElements(
	facts: VectorElementFacts[],
	context: { planArea?: number } = {}
): ClassifiedElement[] {
	const planArea = context.planArea ?? 0;
	const stroked = facts.filter((f) => f.hasStroke && f.strokeWidth > 0);
	const thickAt = wallWidthThreshold(stroked);

	// Windows are pairs, which cannot be decided one element at a time.
	const paired = findWindowPairs(facts, thickAt);

	// First pass: everything whose role can be decided on its own. A bare fill is left
	// for the second pass, which needs to know what colour this drawing's walls are.
	const prelim = facts.map((fact, index): { role: ElementRole; reason: string } | null => {
		const named = roleFromName(fact.name);
		if (named) return named;

		if (!fact.hasStroke && fact.hasFill) return null;

		if (paired.has(index)) {
			return { role: 'window', reason: 'parallel twin of a thin line' };
		}

		if (fact.hasStroke) {
			if (fact.strokeWidth >= thickAt) {
				return { role: 'wall', reason: `stroke ${fact.strokeWidth} is above the width cut` };
			}
			// A thin line that is not paired: a door swing, if it is shaped like one.
			if (fact.curved && !fact.hasFill) {
				const swing = swingArcOf(fact, planArea);
				if (swing) return { role: 'door', reason: swing };
			}
			return { role: 'unknown', reason: `thin stroke ${fact.strokeWidth}` };
		}

		return { role: 'unknown', reason: 'nothing to classify' };
	});

	// Second pass: a bare fill. A long thin one is poché on its shape alone. A blocky
	// one needs two things together — dark enough to be wall poché rather than a room,
	// and big enough to be structure rather than lettering. Either test alone is wrong
	// on a plan this project ships; see `POCHÉ_MIN_AREA_SHARE`.
	return facts.map((fact, index) => {
		const decided = prelim[index];
		if (decided) return { ...fact, ...decided };

		const aspect = thinAspect(fact);
		if (aspect >= POCHÉ_ASPECT) {
			return { ...fact, role: 'wall' as const, reason: `filled poché (${aspect.toFixed(0)}:1)` };
		}

		const area = fact.width * fact.height;
		const share = planArea > 0 ? area / planArea : 0;
		const brightest = brightestChannel(fact.fill);
		if (
			brightest !== null &&
			brightest < POCHÉ_MAX_CHANNEL &&
			fact.subpaths <= POCHÉ_MAX_SUBPATHS &&
			planArea > 0 &&
			area >= planArea * POCHÉ_MIN_AREA_SHARE
		) {
			return {
				...fact,
				role: 'wall' as const,
				reason: `dark filled block (${(share * 100).toFixed(1)} % of the plan)`
			};
		}

		return { ...fact, role: 'fixture' as const, reason: 'filled area, not wall-shaped' };
	});
}

/**
 * The stroke width at or above which a stroke is a wall, or `Infinity` when the
 * drawing's strokes are too uniform for width to distinguish anything.
 *
 * The cut is placed at the **largest relative gap** in the drawing's own stroke
 * widths, not at a fixed fraction of the widest one. A fraction was tried first and
 * the anonymous-file experiment broke it: `house-120sqm.svg` draws 6 px outer walls,
 * 5 px walls and 3.5 px partitions, so `0.6 × 6` puts the threshold at 3.6 and drops
 * every partition by a tenth of a pixel — recovering 11 of its 25 walls once the
 * class names that would have saved them are removed. The gap cut lands at 2.5 and
 * keeps all of them. On the same rule the other four shipped plans land correctly
 * too (`state-floor.svg` cuts between 6.8 and 1.9, `little-white-house.svg` between
 * 2 and 1, the samples between 3.5 and 1.5).
 */
function wallWidthThreshold(stroked: VectorElementFacts[]): number {
	// Distinct widths, widest first. Rounded because a computed style carries float
	// noise (6.80000019) that would otherwise look like a gap of its own.
	const widths = [...new Set(stroked.map((f) => Math.round(f.strokeWidth * 1000) / 1000))].sort(
		(a, b) => b - a
	);
	if (widths.length < 2) return Infinity;

	let widestRatio = 0;
	let cut = Infinity;
	for (let i = 0; i < widths.length - 1; i++) {
		const hi = widths[i]!;
		const lo = widths[i + 1]!;
		if (lo <= 0) continue;
		const ratio = hi / lo;
		if (ratio > widestRatio) {
			widestRatio = ratio;
			cut = (hi + lo) / 2;
		}
	}

	// No gap worth cutting at: width is not evidence, and the rules below get their
	// turn. This is the plan whose only strokes are its window lines.
	if (widestRatio < WIDTH_SPREAD_MIN) return Infinity;
	return cut;
}

/** Longest side over shortest side, 1 for a square, ∞ for a degenerate line. */ function thinAspect(
	fact: VectorElementFacts
): number {
	const long = Math.max(fact.width, fact.height);
	const short = Math.min(fact.width, fact.height);
	if (short <= 0.01) return long > 0.01 ? Infinity : 1;
	return long / short;
}

/**
 * Indices of thin stroked elements that have **exactly one** parallel twin a few
 * stroke widths away: the double-line convention for a window.
 *
 * Length within 25 %, same orientation, their runs overlapping along that axis, and
 * a gap across it of between 1 and `WINDOW_PAIR_GAP` times the element's *own*
 * stroke width. The shipped samples draw windows as two lines 4 px apart at 1.5 px
 * stroke; a room's two facing walls are orders of magnitude further apart.
 *
 * **Exactly one** is the load-bearing word, and it was measured into place. A run of
 * parallel lines satisfies every pairwise test above, and staircases are drawn as
 * exactly that: without this, `state-floor.svg` reported 19 windows, most of them
 * the treads of its two stair flights. A window is a pair; three or more lines in a
 * row are hatching, treads or a ladder.
 *
 * A curve that actually bulges is excluded outright, on both sides of the comparison. A
 * window is two **straight** parallel lines; nothing else in a plan is drawn as a pair of
 * arcs. Without this the test ran first and took door swings for windows: stripping the
 * names from `apartment-48sqm.svg` left 8 windows and 3 doors, because a swing arc and
 * its straight leaf are the same length, sit a few stroke widths apart, and overlap —
 * every condition the pair test asks for.
 */
function findWindowPairs(facts: VectorElementFacts[], wallWidth: number): Set<number> {
	const candidates = facts
		.map((fact, index) => ({ fact, index }))
		.filter(
			({ fact }) =>
				fact.hasStroke &&
				!fact.hasFill &&
				fact.strokeWidth > 0 &&
				// Thinner than a wall. When the drawing has no width spread `wallWidth`
				// is Infinity, so every stroked line is a candidate and the pair test
				// alone decides — which is the right answer for a plan whose only
				// strokes are its windows.
				fact.strokeWidth < wallWidth &&
				fact.length > 0 &&
				// A real bulge, not merely a curve command in the path.
				!(fact.arc && fact.arc.radius !== null)
		);

	const twins = new Map<number, number[]>();
	for (let i = 0; i < candidates.length; i++) {
		for (let j = i + 1; j < candidates.length; j++) {
			const a = candidates[i]!;
			const b = candidates[j]!;
			if (!isParallelTwin(a.fact, b.fact)) continue;
			(twins.get(a.index) ?? twins.set(a.index, []).get(a.index)!).push(b.index);
			(twins.get(b.index) ?? twins.set(b.index, []).get(b.index)!).push(a.index);
		}
	}

	const pairs = new Set<number>();
	for (const [index, partners] of twins) {
		if (partners.length === 1) pairs.add(index);
	}
	return pairs;
}

function isParallelTwin(a: VectorElementFacts, b: VectorElementFacts): boolean {
	// Similar length.
	const long = Math.max(a.length, b.length);
	const short = Math.min(a.length, b.length);
	if (long <= 0 || short / long < 0.75) return false;

	// Which way round they run. A degenerate extent means the element *is* a line
	// along the other axis.
	const horizontal = a.width >= a.height;
	if (horizontal !== b.width >= b.height) return false;

	// Overlap along the run, so two collinear segments are not paired.
	const startA = horizontal ? a.x : a.y;
	const endA = startA + (horizontal ? a.width : a.height);
	const startB = horizontal ? b.x : b.y;
	const endB = startB + (horizontal ? b.width : b.height);
	const overlap = Math.min(endA, endB) - Math.max(startA, startB);
	if (overlap < Math.min(endA - startA, endB - startB) * 0.75) return false;

	// Gap across the run, measured between the elements' own lines.
	const acrossA = horizontal ? a.y : a.x;
	const acrossB = horizontal ? b.y : b.x;
	const gap = Math.abs(acrossA - acrossB);
	const stroke = Math.min(a.strokeWidth, b.strokeWidth);
	return gap >= stroke && gap <= stroke * WINDOW_PAIR_GAP;
}

// ─── Browser adapter ────────────────────────────────────────────────────────

/**
 * The drawing's own area, in the same units as the facts' `width`/`height`.
 *
 * Those come from `getBBox()`, which is **user space** — before the viewBox is scaled
 * to the raster width. So this must be user space too: a viewBox of 1200×786 rendered
 * at 800 px wide shrinks every block by 0.44 in each axis, and comparing a user-space
 * block against a pixel-space plan understated every poché share by more than half.
 * That is the bug this function exists to prevent, so it takes the viewBox rather than
 * the render size.
 */
export function planAreaOf(svg: SVGSVGElement): number {
	const box = svg.viewBox?.baseVal;
	if (box && box.width > 0 && box.height > 0) return box.width * box.height;
	try {
		const own = svg.getBBox();
		if (own.width > 0 && own.height > 0) return own.width * own.height;
	} catch {
		// A detached root: fall through to "unknown", which the caller treats as "cannot
		// judge size", leaving blocks unclassified rather than calling them walls.
	}
	return 0;
}

/**
 * The elements this module reasons about, in document order.
 *
 * Exported so a caller can keep its own list index-aligned with
 * `describeSvgElements`' output. Two matching queries would drift apart the moment
 * either changes, and the drift would be silent: `vector-detect.ts` maps roles onto
 * elements by index, so one extra element on one side rewrites every role after it.
 *
 * Elements inside `<defs>` and friends are excluded. They are not drawn by
 * themselves — only where something references them — and counting them made
 * `little-white-house` report 103 "fill-only elements" that are the insides of a
 * polka-dot pattern.
 */
export function selectDrawableElements(svg: SVGSVGElement): SVGElement[] {
	const selector = 'path, line, rect, polygon, polyline, circle, ellipse';
	const deferred =
		'defs, clipPath, mask, marker, pattern, symbol, linearGradient, radialGradient, filter';
	return Array.from(svg.querySelectorAll<SVGElement>(selector)).filter(
		(el) => !el.closest(deferred)
	);
}

/**
 * Facts for every drawable element under `svg`, using **computed** style.
 *
 * Computed rather than attribute values, because half the files in the wild paint
 * through a `<style>` block: `state-floor.svg` has not one `fill=` attribute on its
 * 101 drawable elements, and an attribute-based reader sees them all as unpainted.
 */
export function describeSvgElements(svg: SVGSVGElement): VectorElementFacts[] {
	const out: VectorElementFacts[] = [];

	for (const el of selectDrawableElements(svg)) {
		const style = getComputedStyle(el);
		const stroke = style.stroke;
		const fill = style.fill;
		const hasStroke = !!stroke && stroke !== 'none' && style.strokeWidth !== '0px';
		const hasFill = !!fill && fill !== 'none';

		let length = 0;
		let x = 0;
		let y = 0;
		let width = 0;
		let height = 0;
		try {
			const geometry = el as SVGGeometryElement;
			if (typeof geometry.getTotalLength === 'function') length = geometry.getTotalLength();
			const box = geometry.getBBox();
			x = box.x;
			y = box.y;
			width = box.width;
			height = box.height;
		} catch {
			// A detached or zero-sized element: leave the geometry at zero, which the
			// classifier treats as "no evidence" rather than as a measurement.
		}

		const d = el.getAttribute('d') ?? '';
		out.push({
			tag: el.tagName.toLowerCase(),
			name: namesOf(el),
			strokeWidth: parseFloat(style.strokeWidth) || 0,
			hasStroke,
			hasFill,
			stroke,
			fill,
			length,
			x,
			y,
			width,
			height,
			curved:
				/[CcSsQqTtAa]/.test(d) ||
				el.tagName.toLowerCase() === 'circle' ||
				el.tagName.toLowerCase() === 'ellipse',
			arc: measureArc(el, d, hasFill),
			subpaths: d ? (d.match(/[Mm]/g) ?? []).length || 1 : 1
		});
	}

	return out;
}

/**
 * Measure the arc a stroked curve traces, by walking it.
 *
 * Sampling `getTotalLength`/`getPointAtLength` rather than parsing `d`: the same arc can
 * arrive as an `A` command, as beziers, or as a chain of short segments, and the browser
 * already knows how to walk all three. Parsing would mean re-implementing the path
 * grammar to learn the same thing less reliably.
 *
 * Only stroked, unfilled curves are measured — that is the only shape a door swing can
 * be, and walking 33 points of every path in a 3,000-element CAD export is not free.
 * Returns null when the element is not such a curve, or is not walkable.
 */
function measureArc(el: Element, d: string, hasFill: boolean): ArcMeasurement | null {
	const tag = el.tagName.toLowerCase();
	const isCurve = /[CcSsQqTtAa]/.test(d) || tag === 'circle' || tag === 'ellipse';
	if (!isCurve || hasFill) return null;
	const geometry = el as SVGGeometryElement;
	if (typeof geometry.getTotalLength !== 'function') return null;

	let total = 0;
	try {
		total = geometry.getTotalLength();
	} catch {
		return null;
	}
	if (!(total > 0)) return null;

	const SAMPLES = 32;
	const points: Array<[number, number]> = [];
	try {
		for (let i = 0; i <= SAMPLES; i++) {
			const p = geometry.getPointAtLength((total * i) / SAMPLES);
			points.push([p.x, p.y]);
		}
	} catch {
		return null;
	}

	const [ax, ay] = points[0]!;
	const [bx, by] = points[SAMPLES]!;
	const chord = Math.hypot(bx - ax, by - ay);
	if (chord < 1e-6) {
		// The ends meet: a loop, not an arc. Whether it is closed by a `Z` or simply
		// curves back to where it started, it cannot be a swing.
		return { chord: 0, radius: null, sweep: null, sShaped: false };
	}

	// Signed perpendicular deviation from the chord, both ways.
	let maxPositive = 0;
	let maxNegative = 0;
	for (const [px, py] of points) {
		const deviation = ((px - ax) * (by - ay) - (py - ay) * (bx - ax)) / chord;
		if (deviation > maxPositive) maxPositive = deviation;
		if (deviation < maxNegative) maxNegative = deviation;
	}
	const bulge = Math.max(maxPositive, -maxNegative);
	if (bulge < 1e-6) {
		// Straight in disguise: a curve command that drew a line.
		return { chord, radius: null, sweep: null, sShaped: false };
	}

	// Sagitta to radius, for a circular arc: r = s/2 + c^2 / (8s).
	const radius = bulge / 2 + (chord * chord) / (8 * bulge);
	const sweep =
		radius >= chord / 2 ? (2 * Math.asin(Math.min(1, chord / (2 * radius))) * 180) / Math.PI : null;

	return {
		chord,
		radius,
		sweep,
		sShaped: maxPositive > bulge * 0.2 && maxNegative < -bulge * 0.2
	};
}

/** Class and id and any label attribute, lowercased and space-joined. */
function namesOf(el: Element): string {
	const parts: string[] = [];
	const cls = el.getAttribute('class');
	if (cls) parts.push(cls);
	const id = el.getAttribute('id');
	if (id) parts.push(id);
	for (const attr of ['inkscape:label', 'data-name', 'serif:master-page-name']) {
		const value = el.getAttribute(attr);
		if (value) parts.push(value);
	}
	return parts.join(' ').toLowerCase().replace(/[\s]+/g, ' ');
}
