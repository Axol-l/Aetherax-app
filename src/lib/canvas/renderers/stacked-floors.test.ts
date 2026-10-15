import { describe, expect, it } from 'vitest';
import { FloorCardCache, type FloorCardSource } from './floor-card.js';
import type { RenderContext } from '../types.js';
import {
	DEFAULT_STACK_CAMERA,
	MAX_PITCH,
	projectBox,
	projectPoint,
	slabAt,
	stackPivot,
	stackedBounds,
	stackedLayout,
	StackedFloorsLayer,
	storeyHeight,
	unprojectPoint,
	type StackCamera
} from './stacked-floors.js';

/**
 * The stacked view is a camera plus arithmetic, and this is both.
 *
 * It is worth testing on its own because the whole claim of the view is geometric:
 * the floors are separated by their *real* storey heights, the plan is rotated and
 * tilted rather than slid sideways, and the topmost slab at a point is the one
 * drawn over it. A test that only looked at pixels would be asserting the drawing
 * code, not the projection the drawing is supposed to express.
 *
 * The history is in the first test: an earlier version offset each floor sideways
 * and drew every plan from straight above, so turning the knob looked like the
 * frames moving. Rotating the *plane* is the difference, and it is checkable.
 */

const WUPM = 33.05;
const DEG = Math.PI / 180;

const camera = (over: Partial<StackCamera> = {}): StackCamera => ({
	...DEFAULT_STACK_CAMERA,
	wupm: WUPM,
	...over
});

/** Floors with the same 800 x 600 mask, three-metre storeys. */
function sources(count = 2): FloorCardSource[] {
	const floor = (id: string, name: string, elevation: number): FloorCardSource => ({
		id,
		name,
		planUrl: null,
		planOffsetX: 0,
		planOffsetY: 0,
		maskUrl: `mask-${id}.png`,
		maskOriginX: 0,
		maskOriginY: 0,
		maskWidth: 800,
		maskHeight: 600,
		aps: [],
		elevation
	});
	const all = [floor('f1', 'Floor 1', 0), floor('f2', 'Floor 2', 3), floor('f3', 'Floor 3', 6)];
	// Deliberately in the wrong order: the layout sorts by elevation, and a view
	// that trusted array order would draw the building inside out.
	return count === 2 ? [all[1]!, all[0]!] : [all[2]!, all[0]!, all[1]!];
}

function layout(
	currentFloorId: string | null,
	over: Partial<StackCamera> & { focus?: boolean; hoverFloorId?: string | null; count?: number } = {}
) {
	const cards = new FloorCardCache();
	const list = sources(over.count ?? 2);
	const boxes = new Map(list.map((s) => [s.id, cards.contentBox(s)]));
	return stackedLayout(list, boxes, {
		...camera(over),
		currentFloorId,
		focus: over.focus ?? false,
		hoverFloorId: over.hoverFloorId ?? null
	});
}

describe('storeyHeight', () => {
	it('is metres in world units, scaled by the spread', () => {
		expect(storeyHeight(3, 33.05, 1)).toBeCloseTo(99.15, 9);
		expect(storeyHeight(3, 33.05, 1.5)).toBeCloseTo(148.725, 9);
		// The ground floor stands on nothing, so it has no height of its own.
		expect(storeyHeight(0, 33.05, 1)).toBe(0);
	});
});

describe('projectPoint', () => {
	it('is the plan unchanged in an unrotated top view', () => {
		const top = camera({ yaw: 0, pitch: 0 });
		expect(projectPoint(top, 100, 200, 0)).toEqual({ x: 100, y: 200 });
		// Height does *not* appear: looking straight down, the storeys coincide,
		// which is what a plan view of a stack really looks like. An earlier version
		// always offset by height here, which made the tilt knob look like it was
		// doing the projection's job.
		expect(projectPoint(top, 100, 200, 50)).toEqual({ x: 100, y: 200 });
	});

	it('rotates the plan with yaw, which is what a viewpoint does', () => {
		const turned = camera({ yaw: 90 * DEG, pitch: 0 });
		// A quarter turn maps +x onto +y: the *plan* turns, it is not slid sideways.
		const p = projectPoint(turned, 100, 0, 0);
		expect(p.x).toBeCloseTo(0, 9);
		expect(p.y).toBeCloseTo(100, 9);
	});

	it('foreshortens y with pitch and lifts a floor by its height', () => {
		const tilted = camera({ yaw: 0, pitch: 60 * DEG });
		const flat = projectPoint(tilted, 0, 100, 0);
		// cos(60°) = 0.5: distances away from the viewer halve.
		expect(flat.x).toBeCloseTo(0, 9);
		expect(flat.y).toBeCloseTo(100 * Math.cos(60 * DEG), 9);
		// sin(60°) = 0.866: a 100-unit height moves the floor up by that much.
		expect(projectPoint(tilted, 0, 0, 100).y).toBeCloseTo(-100 * Math.sin(60 * DEG), 9);
	});

	it('loses no information: unprojecting returns the point it came from', () => {
		for (const yaw of [0, 30 * DEG, 90 * DEG, -135 * DEG]) {
			for (const pitch of [10 * DEG, 40 * DEG, MAX_PITCH]) {
				const c = camera({ yaw, pitch });
				const z = 137.5;
				const p = projectPoint(c, 321.25, -47.5, z);
				const back = unprojectPoint(c, p.x, p.y, z);
				expect(back.x).toBeCloseTo(321.25, 6);
				expect(back.y).toBeCloseTo(-47.5, 6);
			}
		}
	});
});

describe('stackedLayout', () => {
	it('orders floors by elevation, not by array order', () => {
		expect(layout(null).map((s) => s.id)).toEqual(['f1', 'f2']);
	});

	it('separates the storeys by their real height', () => {
		const [ground, upper] = layout(null);
		expect(ground!.z).toBe(0);
		expect(upper!.z).toBeCloseTo(99.15, 6);
	});

	it('gives each upper floor walls down to the floor below it', () => {
		const [ground, upper] = layout(null);
		// The ground floor stands on nothing: no walls, and its hit area is its box.
		expect(ground!.depth).toBe(0);
		// One storey of building for the floor above.
		expect(upper!.depth).toBeCloseTo(99.15, 6);
	});

	it('spreads the storeys apart without changing the geometry it reports', () => {
		expect(layout(null, { spacing: 2 })[1]!.z).toBeCloseTo(198.3, 6);
	});

	it('draws the current floor nearly opaque and the others translucent', () => {
		// With full-size plans an opaque upper floor hides everything below it.
		expect(layout('f2')[1]!.alpha).toBeCloseTo(0.9, 6);
		expect(layout('f1')[1]!.alpha).toBeCloseTo(0.6, 6);
		// Nothing covers the bottom floor, so it is drawn solid either way.
		expect(layout('f2')[0]!.alpha).toBe(1);
		expect(layout('f2')[0]!.isCurrent).toBe(false);
		expect(layout('f2')[1]!.isCurrent).toBe(true);
	});

	it('reports each floor its own height, for the label', () => {
		expect(layout(null, { count: 3 }).map((s) => s.elevation)).toEqual([0, 3, 6]);
	});

	it('marks the floor the pointer is over', () => {
		const slabs = layout(null, { count: 3, hoverFloorId: 'f2' });
		expect(slabs.filter((s) => s.isHovered).map((s) => s.id)).toEqual(['f2']);
		expect(layout(null).every((s) => !s.isHovered)).toBe(true);
	});
});

describe('stackedLayout with focus', () => {
	it('keeps only the current floor', () => {
		// Not "the current floor and its neighbours": on a two-storey plan that kept
		// everything, so the toggle did nothing at all and read as broken.
		expect(layout('f2', { count: 3, focus: true }).map((s) => s.id)).toEqual(['f2']);
		expect(layout('f3', { count: 3, focus: true }).map((s) => s.id)).toEqual(['f3']);
		expect(layout('f1', { count: 3, focus: true }).map((s) => s.id)).toEqual(['f1']);
		// The common case: two floors, so it has to do something there too.
		expect(layout('f1', { focus: true }).map((s) => s.id)).toEqual(['f1']);
	});

	it('keeps every floor when nothing is selected', () => {
		// An empty view would read as a bug rather than as a filter.
		expect(layout(null, { count: 3, focus: true })).toHaveLength(3);
	});

	it('still stands the isolated floor on the storey below it', () => {
		// Its walls are one storey tall even with nothing drawn beneath: the building
		// underneath decides that, not the visible list.
		const focused = layout('f3', { count: 3, focus: true });
		expect(focused).toHaveLength(1);
		expect(focused[0]!.depth).toBeCloseTo(99.15, 6);
		expect(focused[0]!.z).toBeCloseTo(198.3, 6);
	});
});

describe('stackedBounds', () => {
	it('is centred on the pivot, and at a top view it is the plan\'s own box', () => {
		// The drawing plane is pivot-relative, so the plan of an 800 x 600 floor runs
		// from -400 to 400 and -300 to 300 whatever the viewpoint.
		const bounds = stackedBounds(camera({ yaw: 0, pitch: 0 }), layout(null));
		expect(bounds[0]!.x).toBeCloseTo(-400, 6);
		expect(bounds[0]!.y).toBeCloseTo(-300, 6);
		expect(bounds[1]!.x).toBeCloseTo(400, 6);
		expect(bounds[1]!.y).toBeCloseTo(300, 6);
	});

	it('grows with the tilt, symmetrically about the pivot', () => {
		const view = camera({ yaw: 0, pitch: 30 * DEG });
		const bounds = stackedBounds(view, layout(null));
		// The plans are foreshortened to 300·cos(30°) either side of the middle, and
		// the storeys are lifted ±(99.15/2)·sin(30°) about it: 259.8 + 24.8 = 284.6.
		const reach = 300 * Math.cos(30 * DEG) + (99.15 / 2) * Math.sin(30 * DEG);
		expect(bounds[0]!.y).toBeCloseTo(-reach, 6);
		expect(bounds[1]!.y).toBeCloseTo(reach, 6);
	});

	it('a yawed plan needs a wider box than the plan itself', () => {
		// A rectangle seen at 45° has a bounding box as wide as the sum of its sides
		// times cos(45°) — the visible proof that the view rotated rather than
		// translated. Sliding the floors sideways never changes this.
		const straight = stackedBounds(camera({ yaw: 0, pitch: 0 }), layout(null));
		const turned = stackedBounds(camera({ yaw: 45 * DEG, pitch: 0 }), layout(null));
		const width = (b: Array<{ x: number; y: number }>) => b[1]!.x - b[0]!.x;
		expect(width(turned)).toBeCloseTo((800 + 600) * Math.cos(45 * DEG), 6);
		expect(width(turned)).toBeGreaterThan(width(straight) * 1.2);
	});

	it('is empty with no floors, so the camera fit falls through', () => {
		expect(stackedBounds(camera(), [])).toEqual([]);
	});
});

describe('slabAt', () => {
	const view = camera({ yaw: 0, pitch: 40 * DEG });

	it('picks the floor drawn over a point of the tilted view', () => {
		const slabs = layout(null);
		const ground = slabs[0]!;
		const upper = slabs[1]!;

		// The middle of the upper floor's own plan is the upper floor: it is painted
		// last, so that is what the user sees there.
		const upperCentre = projectPoint(view, 400, 300, upper.z, stackPivot(slabs));
		expect(slabAt(view, slabs, upperCentre.x, upperCentre.y)).toBe('f2');

		// Far along the ground floor's plan, the upper floor's own plan has already
		// ended — un-projected onto the upper plane this point lands past its far
		// edge — so the ground floor is what is there.
		const groundEdge = projectPoint(view, 400, 580, ground.z, stackPivot(slabs));
		expect(slabAt(view, slabs, groundEdge.x, groundEdge.y)).toBe('f1');
	});

	it('picks the top floor in a top view, where the storeys coincide', () => {
		// Looking straight down there is only one plan on screen, and it is the one
		// drawn last. The floors below are simply behind it.
		const top = camera({ yaw: 0, pitch: 0 });
		expect(slabAt(top, layout(null), 0, 0)).toBe('f2');
	});

	it('still picks the right floor when the view is rotated and tilted', () => {
		const turned = camera({ yaw: -40 * DEG, pitch: 35 * DEG });
		const slabs = layout(null);
		const upper = slabs[1]!;
		const p = projectPoint(turned, 400, 300, upper.z, stackPivot(slabs));
		expect(slabAt(turned, slabs, p.x, p.y)).toBe('f2');
	});

	it('ignores a point outside every slab', () => {
		const slabs = layout(null);
		expect(slabAt(view, slabs, -5000, -5000)).toBeNull();
		expect(slabAt(view, slabs, 5000, 5000)).toBeNull();
	});

	it('has no floors to pick from when there are none', () => {
		expect(slabAt(camera(), [], 0, 0)).toBeNull();
	});

	it('narrows with focus, so a floor that is not drawn is not clickable', () => {
		// The same far edge of the ground floor's plan: the ground floor's when it is
		// drawn, and nothing at all once another floor is isolated.
		const sprawling = layout('f2', { count: 3 });
		const focused = layout('f2', { count: 3, focus: true });
		const point = projectPoint(view, 400, 580, 0, stackPivot(sprawling));
		expect(slabAt(view, sprawling, point.x, point.y)).toBe('f1');
		const focusedPoint = projectPoint(view, 400, 580, 0, stackPivot(focused));
		expect(slabAt(view, focused, focusedPoint.x, focusedPoint.y)).toBeNull();
	});
});

describe('the pivot', () => {
	it('is the middle of the stack, in all three axes', () => {
		const pivot = stackPivot(layout(null));
		expect(pivot.x).toBeCloseTo(400, 6);
		expect(pivot.y).toBeCloseTo(300, 6);
		// Two floors three metres apart: the middle is one storey up.
		expect(pivot.z).toBeCloseTo(99.15 / 2, 6);
	});

	it('stays at the origin for every viewpoint, which is what needs no re-fit', () => {
		const slabs = layout(null);
		const pivot = stackPivot(slabs);
		for (const yaw of [0, 30 * DEG, 90 * DEG, -150 * DEG]) {
			for (const pitch of [5 * DEG, 40 * DEG, MAX_PITCH]) {
				const p = projectPoint(camera({ yaw, pitch }), pivot.x, pivot.y, pivot.z, pivot);
				expect(p.x).toBeCloseTo(0, 9);
				expect(p.y).toBeCloseTo(0, 9);
			}
		}
	});

	it('keeps the bounds centred on the pivot however the view is turned', () => {
		// Rotating about a corner would sweep the stack across the canvas; this is the
		// property that makes turning the view need no fit.
		const slabs = layout(null);
		for (const yaw of [0, 45 * DEG, 120 * DEG]) {
			const bounds = stackedBounds(camera({ yaw, pitch: 40 * DEG }), slabs);
			const centreX = (bounds[0]!.x + bounds[1]!.x) / 2;
			expect(centreX).toBeCloseTo(0, 6);
		}
	});

	it('grows the storeys apart symmetrically when spacing changes', () => {
		// Spacing acts about the pivot too, so a stack pulled apart does not walk off
		// the top of the canvas.
		const slabs = layout(null, { spacing: 2 });
		const pivot = stackPivot(slabs);
		const zs = slabs.map((s) => s.z - pivot.z);
		expect(zs[0]!).toBeCloseTo(-zs[1]!, 6);
	});
});

describe('projectBox', () => {
	it('is the plan\'s own rectangle, unrotated and untilted', () => {
		const view = camera({ yaw: 0, pitch: 0 });
		const quad = projectBox(view, { x: 10, y: 20, w: 100, h: 50 }, 30);
		// The height does not appear at pitch 0; see `projectPoint`.
		expect(quad).toEqual([
			{ x: 10, y: 20 },
			{ x: 110, y: 20 },
			{ x: 110, y: 70 },
			{ x: 10, y: 70 }
		]);
	});

	it('turns into a parallelogram when the view is turned', () => {
		const view = camera({ yaw: 30 * DEG, pitch: 20 * DEG });
		const quad = projectBox(view, { x: 0, y: 0, w: 100, h: 100 }, 0);
		// Opposite sides stay parallel — that is what makes one `ctx.transform` per
		// floor exact rather than an approximation.
		const d1 = { x: quad[1]!.x - quad[0]!.x, y: quad[1]!.y - quad[0]!.y };
		const d2 = { x: quad[2]!.x - quad[3]!.x, y: quad[2]!.y - quad[3]!.y };
		expect(d1.x).toBeCloseTo(d2.x, 9);
		expect(d1.y).toBeCloseTo(d2.y, 9);
	});
});

/**
 * The marker each access point gets, which is where this view's own bug was: it drew
 * a dot for every mount, so the one view that exists to separate an AP from its
 * ceiling was the one view that said every AP hangs from it.
 *
 * A recording context rather than pixels, because the marker *is* its geometry: the
 * plan's shape for the mount, projected into the floor's own plane.
 */
class RecordingContext {
	arcs: Array<{ x: number; y: number; r: number }> = [];
	moves: Array<{ x: number; y: number }> = [];
	lines: Array<{ x: number; y: number }> = [];

	arc(x: number, y: number, r: number) {
		this.arcs.push({ x, y, r });
	}
	moveTo(x: number, y: number) {
		this.moves.push({ x, y });
	}
	lineTo(x: number, y: number) {
		this.lines.push({ x, y });
	}
	beginPath() {}
	closePath() {}
	save() {}
	restore() {}
	transform() {}
	rect() {}
	clip() {}
	fill() {}
	stroke() {}
	fillText() {}
	drawImage() {}
}

type MarkerAp = FloorCardSource['aps'][number];

/** Draw one floor with these access points, unrotated and untilted. */
function markers(aps: MarkerAp[], over: Partial<StackCamera> = {}): RecordingContext {
	const ctx = new RecordingContext();
	const layer = new StackedFloorsLayer(new FloorCardCache());
	layer.visible = true;
	// No plan and no mask: this is about the marker, and a mask URL would have the
	// card cache construct an `Image`, which a unit test has none of.
	const floor: FloorCardSource = {
		id: 'f1',
		name: 'Floor 1',
		planUrl: null,
		planOffsetX: 0,
		planOffsetY: 0,
		maskUrl: null,
		maskOriginX: 0,
		maskOriginY: 0,
		maskWidth: 0,
		maskHeight: 0,
		aps,
		elevation: 0
	};
	layer.setFloors([floor], floor.id, WUPM);
	layer.camera = camera({ yaw: 0, pitch: 0, ...over });
	layer.render({
		ctx: ctx as unknown as CanvasRenderingContext2D,
		camera: {
			getTransform: () => [1, 0, 0, 1, 0, 0],
			state: { zoom: 1 }
		}
	} as unknown as RenderContext);
	return ctx;
}

/**
 * What the *markers* drew: the same render with no access points, subtracted.
 *
 * The floor's own outline and label are paths too, and counting them in would make
 * every assertion about the marker's shape wrong by a constant.
 */
function markerDrawing(aps: MarkerAp[], over: Partial<StackCamera> = {}) {
	const full = markers(aps, over);
	const bare = markers([], over);
	return {
		arcs: full.arcs.length - bare.arcs.length,
		moves: full.moves.length - bare.moves.length,
		lines: full.lines.length - bare.lines.length,
		/** The last path drawn: the marker, since the markers go last. */
		first: full.moves[full.moves.length - 1]!,
		rest: full.lines.slice(full.lines.length - 3)
	};
}

const ap = (over: Partial<MarkerAp>): MarkerAp => ({
	x: 100,
	y: 100,
	band: '5ghz',
	assignedChannel: 36,
	...over
});

describe('stacked view: access point markers', () => {
	it('draws a ceiling unit as the dot it is, with no plate', () => {
		const drawn = markerDrawing([ap({ mount: 'ceiling', mountHeightM: 0 })]);
		expect(drawn.arcs).toBe(1);
		expect(drawn.moves).toBe(0);
		expect(drawn.lines).toBe(0);
	});

	it('draws a wall unit as a plate, not a circle', () => {
		const drawn = markerDrawing([ap({ mount: 'wall', mountHeightM: 0, facingDeg: 0 })]);
		expect(drawn.arcs).toBe(0);
		// One quad: a move and three lines, closed back to the first corner.
		expect(drawn.moves).toBe(1);
		expect(drawn.lines).toBe(3);
	});

	it('lies the plate along the wall, so the facing turns it', () => {
		const extents = (drawn: ReturnType<typeof markerDrawing>) => {
			const xs = [drawn.first, ...drawn.rest].map((p) => p.x);
			const ys = [drawn.first, ...drawn.rest].map((p) => p.y);
			return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
		};

		// Facing +x: thin across x, long along the wall, which is y.
		const alongX = extents(markerDrawing([ap({ mount: 'wall', mountHeightM: 0, facingDeg: 0 })]));
		expect(alongX.h).toBeGreaterThan(alongX.w * 2);

		// Facing +y: the same plate, turned a quarter turn.
		const alongY = extents(markerDrawing([ap({ mount: 'wall', mountHeightM: 0, facingDeg: 90 })]));
		expect(alongY.w).toBeGreaterThan(alongY.h * 2);
	});

	it('turns the plate with the room, not with the screen', () => {
		// A yawed view rotates the floor plane. A quad drawn in screen space would
		// keep its first edge level; this one is turned with the plan.
		const level = markerDrawing([ap({ mount: 'wall', mountHeightM: 0, facingDeg: 0 })]);
		expect(Math.abs(level.rest[0]!.y - level.first.y)).toBeCloseTo(0, 6);

		const turned = markerDrawing([ap({ mount: 'wall', mountHeightM: 0, facingDeg: 0 })], {
			yaw: 30 * DEG
		});
		expect(Math.abs(turned.rest[0]!.y - turned.first.y)).toBeGreaterThan(0.5);
	});
});
