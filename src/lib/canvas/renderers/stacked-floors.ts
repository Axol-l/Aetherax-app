import type { Layer, RenderContext } from '../types.js';
import { ACCENT_STROKE, ACCENT_TEXT } from '../accents.js';
import { apMarkerColor } from './ap.js';
import { FloorCardCache, type FloorCardSource } from './floor-card.js';

/**
 * A parallel-projection camera for the stacked view: yaw around the vertical axis,
 * pitch down onto the floors, and no perspective divide.
 *
 * Three things follow from that choice, and they are the reason it is this and not
 * a WebGL scene:
 *
 * - **It is affine**, so a floor — which is a flat plane at one height — maps to a
 *   parallelogram that canvas 2D can draw with a single `ctx.transform`. No
 *   texture-mapping tricks, no per-scanline work, and the plans, masks and coverage
 *   images that the single-floor view already draws all keep working.
 * - **Yaw is what makes it read as a viewpoint.** An earlier version of this view
 *   only *offset* each floor sideways (`x - oblique·z`), which slides the storeys
 *   apart but leaves every plan drawn from straight above — so turning the knob
 *   looked like the frames moving and nothing else. Rotating the *plane* is what
 *   the eye reads as walking around the building.
 * - **Pitch is what separates the storeys.** Looking straight down the floors
 *   coincide however much spacing is set; the vertical gap on screen is
 *   `z·sin(pitch)`.
 *
 * Still no perspective, no wall height (each floor is a flat slab) and no
 * volumetric field: see `docs/ROADMAP.md` A3 for why walls with height is a
 * separate, much larger piece of work.
 */
export interface StackCamera {
	/** Rotation about the vertical axis, in radians. 0 looks at the plan as drawn. */
	yaw: number;
	/** Tilt down onto the floors, in radians. 0 is straight down, π/2 is level. */
	pitch: number;
	/**
	 * Multiplier on the storey spacing.
	 *
	 * Screen only: the RF model reads `floorElevation`, so pulling a stack apart to
	 * see into it cannot change a single figure the planner reports.
	 */
	spacing: number;
	/** World units per metre, for turning elevations into world heights. */
	wupm: number;
}

/** Pitch beyond this is nearly level, where a floor is a line and cannot be read. */
export const MAX_PITCH = (78 * Math.PI) / 180;

export const DEFAULT_STACK_CAMERA: StackCamera = {
	yaw: 0,
	pitch: (40 * Math.PI) / 180,
	spacing: 1,
	wupm: 1
};

/** Slop around a slab that still counts as a hit, in world units. */
const HIT_PAD = 10;

/** One floor's place in the stack, in world units. */
export interface StackedSlab {
	id: string;
	name: string;
	/** World-space box of the floor's content, on its own floor's plane. */
	boxX: number;
	boxY: number;
	boxW: number;
	boxH: number;
	/**
	 * Height of this floor's walking surface, in world units — elevation in metres
	 * times `wupm` times `spacing`. This is the z the plane is projected at.
	 */
	z: number;
	/**
	 * How far this floor's walls reach below its own plane, in world units: the
	 * storey it stands on. Zero for the bottom floor, which stands on nothing.
	 */
	depth: number;
	/** Alpha to draw this floor's content with. */
	alpha: number;
	/** True for the floor the single-floor view is showing. */
	isCurrent: boolean;
	/** True while the pointer is over this slab. */
	isHovered: boolean;
	/** Height of this floor above the lowest one, in metres, for the label. */
	elevation: number;
}

export interface StackLayoutOptions extends StackCamera {
	currentFloorId: string | null;
	/**
	 * Draw only the current floor and its immediate neighbours.
	 *
	 * Plans stacked up are mud, and the question the view is usually asked is about
	 * one floor and the one below it. Filtering happens here, in the layout, so the
	 * reduced stack is also what the fit and the hit test see — a slab that is not
	 * drawn must not be clickable.
	 */
	focus: boolean;
	/** Floor to highlight because the pointer is over it, or null. */
	hoverFloorId: string | null;
}

/** A point in the plane the stacked layer draws in, after projection. */
export interface PlanePoint {
	x: number;
	y: number;
}

/**
 * Project one point on a floor's plane into the layer's drawing plane.
 *
 * Relative to `pivot` — the stack's centre, which is what the view turns around —
 * then yaw, then pitch:
 *
 *     dx = x − pivot.x,  dy = y − pivot.y,  dz = z − pivot.z
 *     x1 =  dx·cos(yaw) − dy·sin(yaw)
 *     y1 =  dx·sin(yaw) + dy·cos(yaw)
 *     X  =  x1
 *     Y  =  y1·cos(pitch) − dz·sin(pitch)
 *
 * `Y` grows downwards, as canvas y does, so a taller floor moves *up* the screen.
 * Note what `sin(pitch)` implies: **looking straight down, height does not appear
 * at all** and the storeys coincide, which is what a plan view of a stack really
 * looks like. The height is only visible because the camera is tilted; the default
 * 40° is what makes a stack read as one.
 *
 * The pivot maps to the origin at every yaw and pitch, so turning the view leaves
 * the stack where it is: no re-fit, and nothing to chase.
 */
export function projectPoint(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	x: number,
	y: number,
	z: number,
	pivot: { x: number; y: number; z: number } = ORIGIN_PIVOT
): PlanePoint {
	const dx = x - pivot.x;
	const dy = y - pivot.y;
	const dz = z - pivot.z;
	const cosYaw = Math.cos(camera.yaw);
	const sinYaw = Math.sin(camera.yaw);
	const cosPitch = Math.cos(camera.pitch);
	const sinPitch = Math.sin(camera.pitch);
	return {
		x: cosYaw * dx - sinYaw * dy,
		y: (sinYaw * dx + cosYaw * dy) * cosPitch - dz * sinPitch
	};
}

const ORIGIN_PIVOT = { x: 0, y: 0, z: 0 };

/**
 * The inverse of `projectPoint` *on one floor's plane*: which point of that floor a
 * point in the drawing plane came from.
 *
 * Pitch does not enter the inverse as a rotation — it only scales the plan's y —
 * but it does enter as the division by `cos(pitch)`, which is why a nearly level
 * camera cannot be inverted (and why `MAX_PITCH` is short of π/2).
 */
export function unprojectPoint(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	X: number,
	Y: number,
	z: number,
	pivot: { x: number; y: number; z: number } = ORIGIN_PIVOT
): PlanePoint {
	const cosPitch = Math.cos(camera.pitch);
	const cosYaw = Math.cos(camera.yaw);
	const sinYaw = Math.sin(camera.yaw);
	const dz = z - pivot.z;
	const y1 = cosPitch === 0 ? 0 : (Y + dz * Math.sin(camera.pitch)) / cosPitch;
	// Inverse of the yaw rotation, which is its transpose, then back off the pivot.
	return {
		x: cosYaw * X + sinYaw * y1 + pivot.x,
		y: -sinYaw * X + cosYaw * y1 + pivot.y
	};
}

/** The four corners of a floor's content box, projected at that floor's height. */
export function projectBox(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	box: { x: number; y: number; w: number; h: number },
	z: number,
	pivot: { x: number; y: number; z: number } = ORIGIN_PIVOT
): [PlanePoint, PlanePoint, PlanePoint, PlanePoint] {
	return [
		projectPoint(camera, box.x, box.y, z, pivot),
		projectPoint(camera, box.x + box.w, box.y, z, pivot),
		projectPoint(camera, box.x + box.w, box.y + box.h, z, pivot),
		projectPoint(camera, box.x, box.y + box.h, z, pivot)
	];
}

/** Where each floor sits in the stack. Sorted bottom-up, which is the draw order. */
export function stackedLayout(
	sources: FloorCardSource[],
	boxes: Map<string, { minX: number; minY: number; w: number; h: number }>,
	opts: StackLayoutOptions
): StackedSlab[] {
	// Sorted by elevation, not by array order: the view's whole claim is that the
	// floors are where the building puts them, and `floorElevation` is the only
	// authority on that.
	const ordered = [...sources].sort((a, b) => a.elevation - b.elevation);
	const visible = opts.focus ? isolateCurrent(ordered, opts.currentFloorId) : ordered;
	return visible.map((s, i) => {
		const box = boxes.get(s.id) ?? { minX: 0, minY: 0, w: 0, h: 0 };
		const z = storeyHeight(s.elevation, opts.wupm, opts.spacing);
		// The storey underneath, taken from the *whole* stack rather than the focused
		// one: hiding a floor in between must not silently change the height a storey
		// is drawn at.
		const below = storeyBelow(ordered, s.id);
		const belowZ = storeyHeight(below?.elevation ?? 0, opts.wupm, opts.spacing);
		const isCurrent = s.id === opts.currentFloorId;
		return {
			id: s.id,
			name: s.name,
			boxX: box.minX,
			boxY: box.minY,
			boxW: box.w,
			boxH: box.h,
			z,
			depth: below ? Math.max(0, z - belowZ) : 0,
			alpha: i === 0 ? 1 : isCurrent ? 0.9 : 0.6,
			isCurrent,
			isHovered: s.id === opts.hoverFloorId,
			elevation: s.elevation
		};
	});
}

/**
 * Height in world units of a floor's plane.
 *
 * `elevation` is already cumulative in metres (`floorElevation`), so the pixels are
 * too; `spacing` scales only the visual separation.
 */
export function storeyHeight(elevation: number, wupm: number, spacing: number): number {
	return elevation * wupm * spacing;
}

/** The floor immediately below this one in the whole stack, or null. */
function storeyBelow(ordered: FloorCardSource[], id: string): FloorCardSource | null {
	const i = ordered.findIndex((s) => s.id === id);
	return i > 0 ? ordered[i - 1]! : null;
}

/**
 * Only the current floor, when isolating.
 *
 * This used to keep the current floor and its two neighbours, which meant that on a
 * two-storey plan — the common case — the toggle kept everything and did *nothing*,
 * and a control that appears to do nothing reads as broken. Isolating exactly one
 * floor always has a visible effect, which is what the label promises.
 *
 * With no current floor (nothing selected yet) everything is kept: an empty view
 * would look like a bug rather than like a filter.
 */
function isolateCurrent(
	ordered: FloorCardSource[],
	currentFloorId: string | null
): FloorCardSource[] {
	const current = ordered.filter((s) => s.id === currentFloorId);
	return current.length > 0 ? current : ordered;
}

/**
 * The stack's centre, in world units: the point the view turns around.
 *
 * Rotating about the plan's origin instead would sweep the building across the
 * screen — the origin is a corner of the mask — so every camera change (yaw, pitch,
 * spacing) is applied *relative to this point* and the stack stays where it is.
 * That is what makes turning the view need no re-fit, and what keeps a stack that
 * grows with spacing growing symmetrically rather than off the top of the canvas.
 *
 * Derived from the slabs rather than passed in, so the projection, the bounds and
 * the hit test cannot disagree about where the centre is.
 */
export function stackPivot(slabs: StackedSlab[]): { x: number; y: number; z: number } {
	if (slabs.length === 0) return { x: 0, y: 0, z: 0 };
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	let minZ = Infinity;
	let maxZ = -Infinity;
	for (const s of slabs) {
		minX = Math.min(minX, s.boxX);
		minY = Math.min(minY, s.boxY);
		maxX = Math.max(maxX, s.boxX + s.boxW);
		maxY = Math.max(maxY, s.boxY + s.boxH);
		minZ = Math.min(minZ, s.z);
		maxZ = Math.max(maxZ, s.z);
	}
	return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
}

/**
 * The stack's extent in the drawing plane, for fitting the camera.
 *
 * Centred on the pivot by construction, so a fit at one yaw is still a reasonable
 * frame at another — the box grows when the plan turns diagonal, but it grows about
 * the middle rather than away from it.
 */
export function stackedBounds(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	slabs: StackedSlab[]
): Array<{ x: number; y: number }> {
	if (slabs.length === 0) return [];
	const pivot = stackPivot(slabs);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const s of slabs) {
		const box = { x: s.boxX, y: s.boxY, w: s.boxW, h: s.boxH };
		for (const p of projectBox(camera, box, s.z, pivot)) {
			if (p.x < minX) minX = p.x;
			if (p.y < minY) minY = p.y;
			if (p.x > maxX) maxX = p.x;
			if (p.y > maxY) maxY = p.y;
		}
	}
	return [
		{ x: minX, y: minY },
		{ x: maxX, y: maxY }
	];
}

/**
 * Front-most floor whose *plan* contains a point of the drawing plane, or null.
 *
 * Top-down, because that is the order the slabs are painted in: the floor the user
 * can see at a point is the last one drawn over it. The test un-projects the point
 * onto each floor's own plane and asks whether it lands inside that floor's box,
 * which is exact for a parallel projection and needs no polygon test.
 *
 * Only the content box counts, not the walls below it: a storey's worth of wall
 * covers most of the floor beneath, so including it would make that floor
 * unselectable wherever it is still visible. What the user aims at is a plan.
 */
export function slabAt(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	slabs: StackedSlab[],
	planeX: number,
	planeY: number
): string | null {
	const pivot = stackPivot(slabs);
	for (let i = slabs.length - 1; i >= 0; i--) {
		const s = slabs[i]!;
		const p = unprojectPoint(camera, planeX, planeY, s.z, pivot);
		if (
			p.x >= s.boxX - HIT_PAD &&
			p.x <= s.boxX + s.boxW + HIT_PAD &&
			p.y >= s.boxY - HIT_PAD &&
			p.y <= s.boxY + s.boxH + HIT_PAD
		) {
			return s.id;
		}
	}
	return null;
}

/** One face of a floor's walls, as a projected quad. */
interface WallFace {
	points: PlanePoint[];
	/** Shading, so the two visible sides of a box read as different surfaces. */
	shade: number;
}

/**
 * The four walls under a floor's own plane, as projected quads.
 *
 * Filled back-to-front by the caller. With translucent floor planes over them, the
 * walls are what make the stack read as a building rather than as a pile of
 * drawings, and the shading is what makes a corner visible.
 */
function wallFaces(
	camera: Pick<StackCamera, 'yaw' | 'pitch'>,
	slab: StackedSlab,
	pivot: { x: number; y: number; z: number }
): WallFace[] {
	if (slab.depth <= 0) return [];
	const top = slab.z;
	const bottom = slab.z - slab.depth;
	const corners: Array<[number, number]> = [
		[slab.boxX, slab.boxY],
		[slab.boxX + slab.boxW, slab.boxY],
		[slab.boxX + slab.boxW, slab.boxY + slab.boxH],
		[slab.boxX, slab.boxY + slab.boxH]
	];
	const faces: WallFace[] = [];
	for (let i = 0; i < 4; i++) {
		const a = corners[i]!;
		const b = corners[(i + 1) % 4]!;
		faces.push({
			points: [
				projectPoint(camera, a[0], a[1], top, pivot),
				projectPoint(camera, b[0], b[1], top, pivot),
				projectPoint(camera, b[0], b[1], bottom, pivot),
				projectPoint(camera, a[0], a[1], bottom, pivot)
			],
			// Opposite walls share a shade, so a corner is a visible edge and the two
			// pairs read as the same surface seen twice.
			shade: i % 2 === 0 ? 0.42 : 0.28
		});
	}
	return faces;
}

/**
 * Every floor at once, stacked by its real elevation, seen from a rotatable
 * viewpoint.
 *
 * Read-only, like the contact sheet, and for the same reason: editing would mean
 * running the wall editor and the AP interactions once per floor against its own
 * origin. The difference is what it answers — the sheet answers "what is on each
 * floor", this answers "how do the storeys line up", which is the question a
 * multi-floor coverage plan is actually about.
 */
export class StackedFloorsLayer implements Layer {
	id = 'stacked-floors';
	visible = false;
	currentFloorId: string | null = null;
	showPlan = true;
	showWalls = true;
	showAPs = true;
	showHeatmap = false;
	planOpacity = 0.8;
	/** Viewpoint. See `StackCamera`. */
	camera: StackCamera = { ...DEFAULT_STACK_CAMERA };
	/** Draw only the current floor and its immediate neighbours. */
	focus = false;
	/** Floor the pointer is over, drawn highlighted. Set by the caller. */
	hoverFloorId: string | null = null;

	private sources: FloorCardSource[] = [];

	constructor(private readonly cards: FloorCardCache) {}

	/** Called once a plan image finishes loading, so the engine can repaint. */
	set onLoad(fn: (() => void) | null) {
		this.cards.onLoad = fn;
	}

	setFloors(
		sources: FloorCardSource[],
		currentFloorId: string | null,
		wupm: number
	): void {
		this.currentFloorId = currentFloorId;
		this.camera.wupm = wupm;
		this.cards.sync(sources);
		this.sources = sources;
	}

	/** Where each slab sits. Sorted bottom-up, which is also the draw order. */
	layout(): StackedSlab[] {
		if (this.sources.length === 0) return [];
		const boxes = new Map(this.sources.map((s) => [s.id, this.cards.contentBox(s)]));
		return stackedLayout(this.sources, boxes, {
			...this.camera,
			currentFloorId: this.currentFloorId,
			focus: this.focus,
			hoverFloorId: this.hoverFloorId
		});
	}

	/**
	 * Which floor a point of the *drawing plane* falls on, or null.
	 *
	 * The caller hands over a point from `camera.screenToWorld`, so the un-projecting
	 * is this layer's business and nobody above it has to know the view can rotate.
	 */
	floorAt(planeX: number, planeY: number): string | null {
		return slabAt(this.camera, this.layout(), planeX, planeY);
	}

	/** Bounds of the whole stack, for fitting the camera. */
	contentBounds(): Array<{ x: number; y: number }> {
		return stackedBounds(this.camera, this.layout());
	}

	render(rc: RenderContext): void {
		if (!this.visible) return;
		const { ctx, camera } = rc;
		const slabs = this.layout();
		if (slabs.length === 0) return;

		const [a, b, c, d, e, f] = camera.getTransform();
		const zoom = camera.state.zoom || 1;
		const view = this.camera;
		// Everything is projected relative to the stack's centre, so turning the view
		// leaves the stack where it is instead of sweeping it across the canvas.
		const pivot = stackPivot(slabs);
		const cosYaw = Math.cos(view.yaw);
		const sinYaw = Math.sin(view.yaw);
		const cosPitch = Math.cos(view.pitch);
		const sinPitch = Math.sin(view.pitch);

		ctx.save();
		ctx.transform(a, b, c, d, e, f);

		/** Markers wait for every floor, so none is hidden by the storey above it. */
		const markers: Array<{ src: FloorCardSource; slab: StackedSlab }> = [];

		for (const slab of slabs) {
			const src = this.sources.find((s) => s.id === slab.id);
			if (!src) continue;

			// The walls first, then this floor's own plane over them, so the floor
			// caps the storey it stands on.
			for (const face of wallFaces(view, slab, pivot)) {
				ctx.globalAlpha = 1;
				ctx.fillStyle = `rgba(0,0,0,${face.shade})`;
				ctx.beginPath();
				ctx.moveTo(face.points[0]!.x, face.points[0]!.y);
				for (let i = 1; i < face.points.length; i++) {
					ctx.lineTo(face.points[i]!.x, face.points[i]!.y);
				}
				ctx.closePath();
				ctx.fill();
			}

			// One floor, one affine transform: off the pivot, yaw, then pitch, then its
			// own height. Drawing the content through this is what rotates the *plan*
			// rather than sliding it, and it is why every existing per-floor drawing
			// routine keeps working unchanged. The translation terms are the pivot's
			// own projection, which keeps it at the origin for every yaw and pitch.
			const dz = slab.z - pivot.z;
			ctx.save();
			ctx.transform(
				cosYaw,
				sinYaw * cosPitch,
				-sinYaw,
				cosYaw * cosPitch,
				-cosYaw * pivot.x + sinYaw * pivot.y,
				-cosPitch * (sinYaw * pivot.x + cosYaw * pivot.y) - sinPitch * dz
			);
			// The clip is the box in the floor's own coordinates, so a coverage image
			// generated past the plan cannot spill onto the floor below.
			ctx.beginPath();
			ctx.rect(slab.boxX, slab.boxY, slab.boxW, slab.boxH);
			ctx.clip();
			ctx.globalAlpha = slab.alpha;
			this.cards.draw(ctx, src, {
				showPlan: this.showPlan,
				showWalls: this.showWalls,
				// The markers are drawn below instead, in the *drawing* plane: their
				// whole point in this view is that they sit at a height of their own,
				// and a height is not expressible inside a floor's own transform.
				showAPs: false,
				showHeatmap: this.showHeatmap,
				planOpacity: this.planOpacity,
				zoom
			});
			ctx.restore();

			// Outline and label in the *drawing* plane, i.e. unrotated, so the text
			// stays readable and the edge stays crisp at any yaw.
			const quad = projectBox(
				view,
				{ x: slab.boxX, y: slab.boxY, w: slab.boxW, h: slab.boxH },
				slab.z,
				pivot
			);
			ctx.globalAlpha = 1;
			ctx.strokeStyle = slab.isHovered
				? 'rgba(255,255,255,0.95)'
				: slab.isCurrent
					? ACCENT_STROKE
					: 'rgba(255,255,255,0.22)';
			ctx.lineWidth = (slab.isHovered ? 3 : slab.isCurrent ? 2 : 1) / zoom;
			ctx.beginPath();
			ctx.moveTo(quad[0]!.x, quad[0]!.y);
			for (let i = 1; i < quad.length; i++) ctx.lineTo(quad[i]!.x, quad[i]!.y);
			ctx.closePath();
			ctx.stroke();

			// The label carries the height, which is the one thing the stack knows and
			// the contact sheet cannot show: where the floor sits.
			ctx.font = `${13 / zoom}px sans-serif`;
			ctx.fillStyle = slab.isHovered
				? 'rgba(255,255,255,0.95)'
				: slab.isCurrent
					? ACCENT_TEXT
					: 'rgba(255,255,255,0.6)';
			ctx.textBaseline = 'bottom';
			// Anchored on whichever corner is topmost on screen, so the label is never
			// drawn inside the floor it names.
			const anchor = quad.reduce((best, p) => (p.y < best.y ? p : best), quad[0]!);
			ctx.fillText(`${slab.name} · +${slab.elevation.toFixed(1)} m`, anchor.x, anchor.y - 6 / zoom);

			// Access points are collected rather than drawn here: see `markers`.
			if (this.showAPs) markers.push({ src, slab });
		}

		// Every floor is down, so the markers can go over all of them.
		for (const marker of markers) {
			this.drawAccessPoints(ctx, marker.src, marker.slab, view, pivot, zoom);
		}

		ctx.restore();
	}

	/**
	 * This floor's access points, each at its own mounting height.
	 *
	 * This is the one thing the stacked view can show that no other view can: an AP
	 * on a desk and one on the ceiling of the same storey are in *different places*,
	 * and on a plan they are the same dot. Here each marker is projected at
	 * `slab.z + height`, with a short stem down to the floor it is mounted on so the
	 * height reads as height rather than as a wrong position.
	 *
	 * Every floor's markers are drawn after *all* the floors, so one can never be
	 * hidden under the slab of the storey above it — the point of the marker is to be
	 * found, and an AP under a ceiling is what this view is for.
	 *
	 * The height is scaled by the camera's `spacing` like the storey heights are: a
	 * stack pulled apart to be read must not show an AP floating further above its
	 * floor than the storey it is in is tall.
	 *
	 * The marker's *shape* is the plan's, not this view's: a wall-mounted unit is the
	 * plate it is, laid in the floor's own plane (see `drawWallPlate`). It used to be a
	 * dot here whatever the mount, which made the one view that separates an AP from
	 * its ceiling the one view that said every AP hangs from it.
	 */
	private drawAccessPoints(
		ctx: CanvasRenderingContext2D,
		src: FloorCardSource,
		slab: StackedSlab,
		view: StackCamera,
		pivot: { x: number; y: number; z: number },
		zoom: number
	): void {
		const dotR = 4 / zoom;
		for (const ap of src.aps) {
			const heightWu = (ap.mountHeightM ?? 0) * view.wupm * view.spacing;
			const onFloor = projectPoint(view, ap.x, ap.y, slab.z, pivot);
			const at = projectPoint(view, ap.x, ap.y, slab.z + heightWu, pivot);
			ctx.globalAlpha = 1;
			// The stem: the floor end is a ghost, the marker end is the solid dot, so
			// the line reads as "this high above that point".
			if (heightWu > 0) {
				ctx.strokeStyle = 'rgba(255,255,255,0.35)';
				ctx.lineWidth = 1 / zoom;
				ctx.beginPath();
				ctx.moveTo(onFloor.x, onFloor.y);
				ctx.lineTo(at.x, at.y);
				ctx.stroke();
			}
			ctx.fillStyle = apMarkerColor({
				assignedChannel: ap.assignedChannel ?? null,
				band: ap.band ?? '5ghz'
			});
			if (ap.mount === 'wall') {
				this.drawWallPlate(ctx, view, ap, slab.z + heightWu, pivot, dotR, zoom);
				continue;
			}
			ctx.beginPath();
			ctx.arc(at.x, at.y, dotR, 0, Math.PI * 2);
			ctx.fill();
			// A ring, so a marker against a pale plan still reads as a marker.
			ctx.strokeStyle = 'rgba(255,255,255,0.6)';
			ctx.lineWidth = 1 / zoom;
			ctx.stroke();
		}
	}

	/**
	 * A wall-mounted unit here: the plan's plate, lying in the floor's own plane.
	 *
	 * The plate's own axes are projected rather than its outline being drawn in screen
	 * space, so it stays on the wall as the stack is turned and tilted — at a shallow
	 * pitch it foreshortens exactly as the floor it hangs on does, and at a yaw it
	 * turns with the room. It is a quad rather than the plan's rounded plate because
	 * the radius is a couple of screen pixels and the projection would shear it anyway.
	 *
	 * Local +x is the facing direction: the plate is thin across it and long along the
	 * wall, which is what makes "hung the other way round" legible in this view too.
	 */
	private drawWallPlate(
		ctx: CanvasRenderingContext2D,
		view: StackCamera,
		ap: FloorCardSource['aps'][number],
		z: number,
		pivot: { x: number; y: number; z: number },
		dotR: number,
		zoom: number
	): void {
		const facing = ((ap.facingDeg ?? 0) * Math.PI) / 180;
		const fx = Math.cos(facing);
		const fy = Math.sin(facing);
		// Same proportions as `ap.ts` and the overview: 2×dotR across, 4.4×dotR along.
		const HALF_ACROSS = dotR;
		const HALF_ALONG = dotR * 2.2;
		/** A corner of the plate, in the floor's plane, projected into the drawing plane. */
		const corner = (across: number, along: number) =>
			projectPoint(
				view,
				ap.x + across * fx - along * fy,
				ap.y + across * fy + along * fx,
				z,
				pivot
			);

		const corners = [
			corner(-HALF_ACROSS, -HALF_ALONG),
			corner(HALF_ACROSS, -HALF_ALONG),
			corner(HALF_ACROSS, HALF_ALONG),
			corner(-HALF_ACROSS, HALF_ALONG)
		];
		ctx.beginPath();
		ctx.moveTo(corners[0]!.x, corners[0]!.y);
		for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i]!.x, corners[i]!.y);
		ctx.closePath();
		ctx.fill();
		ctx.strokeStyle = 'rgba(255,255,255,0.6)';
		ctx.lineWidth = 1 / zoom;
		ctx.lineJoin = 'round';
		ctx.stroke();
	}
}
