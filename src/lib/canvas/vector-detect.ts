/**
 * Turn a classified vector floorplan into the two masks the rest of the app runs
 * on: the wall mask, and the per-pixel material mask.
 *
 * `vector-elements.ts` decides *what each element is*. This turns that decision
 * into geometry, and the shape of the output is dictated by everything downstream:
 *
 * - **Walls, windows and doors all go into the wall mask.** Not just walls. The mask
 *   is not only an RF barrier map — `computeBuildingInterior` treats every set pixel
 *   as a barrier, morphologically closes the gaps, floods from the border and calls
 *   what is left "inside". That interior is the optimiser's placement domain and the
 *   coverage denominator. Punch holes where the doors are and every room whose only
 *   opening is a door stops being enclosed: no room labels, no density regions, no
 *   coverage samples there. So an opening keeps the wall's topology and changes only
 *   its *material*.
 * - **Everything else is left out**, which is the whole point of classifying
 *   fixtures and lettering: a sink is not a barrier, and neither is the word
 *   "KITCHEN".
 * - **The material mask carries the difference.** Windows take `Glass` (already in
 *   the table), doors take `Door` (added with this feature, ~5 dB a crossing), and
 *   the rest of the wall keeps the floor's default material — which is what the
 *   existing paint brush writes, so a detected plan and a hand-painted one are the
 *   same kind of object.
 *
 * The rasterisation is three passes over the same drawing with the other roles
 * hidden, rather than one pass with the roles colour-coded. Colour-coding would be
 * faster but it puts the classification at the mercy of anti-aliasing: every edge
 * pixel is a blend of the stroke colour and the paper, and deciding "is this the
 * door red or the wall black" at 40 % opacity is a threshold nobody can tune. Three
 * alpha passes have no such question — a pixel is in a role or it is not.
 */

import { WALL_MATERIALS, type WallMaterialId } from './materials.js';
import { fillParallelGaps } from './morphology.js';
import { segmentsFromSvg, collapseOpenings, mergeOpeningsIntoWalls } from './svg-walls.js';
import type { WallMaskData } from '$state/wall-state.svelte.js';
import {
	classifyVectorElements,
	describeSvgElements,
	planAreaOf,
	selectDrawableElements,
	type ClassifiedElement,
	type ElementRole
} from './vector-elements.js';
/** The material a window is painted with. */
export const WINDOW_MATERIAL: WallMaterialId = 2; // Glass

/**
 * How wide a gap between a window's two strokes the fill bridges, in mask pixels.
 *
 * The gap is the wall's thickness at the working resolution — a 200 mm wall on a plan
 * rasterised at ~50 px/m is about 10 px — so 6 covers it with room for a thick facade and
 * stays well under a narrow room. Too small and the sandwich remains; too large and two
 * windows across a thin room would merge.
 */
const WINDOW_FILL_RADIUS = 6;

/** The material a door is painted with. */
export const DOOR_MATERIAL: WallMaterialId = 7; // Door

/** What a detection found, for the review line in the sidebar. */
export interface VectorDetectionSummary {
	/** Elements in the wall mask, by the role that put them there. */
	walls: number;
	windows: number;
	doors: number;
	/** Elements deliberately left out: fixtures, lettering, room fills. */
	ignored: number;
	/** Elements no rule could place. Left out, but counted so the user can see them. */
	unknown: number;
	/** Total drawable elements, so the counts above have a denominator. */
	total: number;
}

export interface VectorDetection {
	wallMask: WallMaskData;
	/** Null when nothing but walls was found — no window or door to record. */
	materialMask: WallMaskData | null;
	summary: VectorDetectionSummary;
	/** Every element the reader looked at, for the review panel. */
	elements: ReviewableElement[];
	/**
	 * The walls as **geometry**, read from the drawing's own elements.
	 *
	 * In the mask's frame (mask pixels = world units), each with the material its role gives it.
	 * Empty when the drawing's elements are all curves, which is the case the raster trace exists
	 * for.
	 */
	segments: Array<{
		ax: number;
		ay: number;
		bx: number;
		by: number;
		material: WallMaterialId;
	}>;
}

/**
 * One element as the review panel sees it.
 *
 * Carries the classification *and* the evidence behind it, because the panel's job is
 * to let a user disagree with the classifier, and disagreeing needs the reason. The
 * box is in render pixels so a highlight can be drawn over the plan without going back
 * to the drawing.
 */
export interface ReviewableElement {
	/** Index in the drawing's element order. Stable for one source. */
	id: number;
	role: ElementRole;
	/** The rule that decided this element's role. */
	reason: string;
	/** `path`, `line`, `rect`, … */
	tag: string;
	/** The names the file gave it, or empty. The strongest evidence there is. */
	name: string;
	box: { x: number; y: number; w: number; h: number };
}

/** Roles that belong in the wall mask, and the material each one paints. */
const MASK_ROLES: ReadonlyArray<{ role: ElementRole; material: WallMaterialId | null }> = [
	{ role: 'wall', material: null },
	{ role: 'window', material: WINDOW_MATERIAL },
	{ role: 'door', material: DOOR_MATERIAL }
];

/**
 * Compose the masks from one pixel buffer per role.
 *
 * Pure, so the composition can be tested without a canvas. `defaultMaterial` is
 * what a wall pixel gets when no opening claims it.
 *
 * **Openings win ties.** A door drawn overlapping the wall it sits in is the norm,
 * not an exception — the arc and the leaf are stroked over the wall run — so where
 * both are set, the material is the opening's. The mask itself is a union, because
 * a hole is not wanted (see the module comment).
 */
export function composeRoleMasks(
	roleBuffers: ReadonlyArray<{ material: WallMaterialId | null; pixels: Uint8Array }>,
	defaultMaterial: WallMaterialId
): { wall: Uint8Array; material: Uint8Array } {
	const length = roleBuffers[0]?.pixels.length ?? 0;
	const wall = new Uint8Array(length);
	const material = new Uint8Array(length);
	material.fill(defaultMaterial);

	// Specific first: a role that names a material beats one that does not, which is
	// what "openings win ties" means once the buffers are separate.
	const ordered = [...roleBuffers].sort(
		(a, b) => (a.material === null ? 1 : 0) - (b.material === null ? 1 : 0)
	);

	for (const { material: id, pixels } of ordered) {
		for (let i = 0; i < length; i++) {
			if (!pixels[i]) continue;
			wall[i] = 1;
			if (id !== null) material[i] = id;
		}
	}

	return { wall, material };
}

/**
 * Detect a vector floorplan from its markup.
 *
 * `overrides` replaces the classifier's verdict for individual elements, keyed by the
 * same index the returned `elements` carry. Re-reading the whole drawing is the cheapest
 * *correct* response to an override: patching the mask instead cannot express "this
 * element is now a door" for an element that was never drawn into it.
 *
 * Returns null when there is nothing to detect — no drawable elements, or nothing
 * that looks like a wall. The caller falls back to the raster pipeline in that
 * case, which is the honest behaviour: a plan whose walls this classifier cannot
 * see is exactly the plan the pixel path was written for.
 */
export async function detectVectorFloorplan(
	svgText: string,
	targetWidth: number,
	overrides: ReadonlyMap<number, ElementRole> = new Map()
): Promise<VectorDetection | null> {
	const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
	const source = doc.querySelector('svg');
	if (!source) return null;

	// `<use>` renders geometry the classifier would never see: the referenced nodes live
	// in `<defs>`, which `selectDrawableElements` skips, and the `<use>` element itself is
	// not a shape. On the shipped sample with its walls moved behind a `<use>`, the reader
	// reported 2 walls instead of 15 — and the mask was still 31,912 pixels, so nothing
	// tripped the "no walls found, use the pixels" guard. A confidently wrong mask is the
	// worst outcome this reader has, so the references are resolved first.
	expandUse(source);

	// A live copy in the document, because `getComputedStyle` — which is what makes
	// this work on a file that paints through a `<style>` block — needs layout.
	const host = document.createElement('div');
	host.style.cssText = 'position:absolute;left:-10000px;top:0;width:1px;height:1px;overflow:hidden';
	document.body.appendChild(host);

	try {
		host.appendChild(document.importNode(source, true));
		const svg = host.querySelector('svg')!;
		// The drawing's own extent, in user units, and the one place it is worked out.
		//
		// `viewBox` when the file has one. When it does not — an export that carries only
		// `width`/`height`, which is common — the root's own bounding box stands in for it.
		// Two things need this and both were wrong without it: the scale the element boxes
		// are reported at, and the render (`renderRolePass`), which sets `width`/`height`
		// on the copy but can only make the content *fill* them if a `viewBox` is present.
		// Without one the drawing rasterised at its own user units into the corner of the
		// mask — 9,415 wall pixels on the shipped sample against 31,580 with the viewBox
		// restored, a mask at 30 % scale while the sidebar happily reported its 15 walls.
		const contentBox = contentBoxOf(svg);
		const scale = targetWidth / (contentBox.width || targetWidth);
		const width = targetWidth;
		const height = Math.max(1, Math.round((contentBox.height || targetWidth) * scale));

		// One shared query, so `roles[i]` really is the role of `drawables[i]`.
		const drawables = selectDrawableElements(svg);
		// The drawing's own area, so "big enough to be a wall" is scale-free. In user
		// units, because that is what the facts' bounding boxes are in — see `planAreaOf`.
		const classified = classifyVectorElements(describeSvgElements(svg), {
			planArea: planAreaOf(svg)
		});
		if (drawables.length === 0) return null;

		const roles = drawables.map((_, i) => overrides.get(i) ?? classified[i]?.role ?? 'unknown');
		// The drawing as markup, so each role pass can rasterise its own *copy* with the
		// other roles removed. Styling the live tree instead is what wrote the room
		// labels into the door material: `<text>` is not in `drawables`, so no pass ever
		// hid it and every pass picked it up as ink. Removal has no such gap — a pass is
		// the elements it kept, and nothing else.
		const markup = new XMLSerializer().serializeToString(svg);

		const buffers: Array<{ material: WallMaterialId | null; pixels: Uint8Array }> = [];
		for (const { role, material } of MASK_ROLES) {
			const rendered = await renderRolePass(markup, role, roles, width, height, contentBox);
			const pixels = await alphaToBuffer(rendered, width, height);
			/*
			 * A window is a **band**, and a drawing strokes its two edges rather than
			 * filling it. Rasterising the strokes alone gives a glass *outline* with the
			 * wall's own drywall still showing between the lines — so the panel says
			 * "window" and the RF model charges a wall, on the one boundary that matters
			 * most for coverage.
			 *
			 * `fillParallelGaps` bridges the two strokes one axis at a time, which is the
			 * only version of this that does not also thicken the band (see its comment for
			 * the two that did). Doors are left alone — a leaf and its swing arc are not
			 * solid, and filling those would paint the quarter circle as glass.
			 */
			const solid =
				role === 'window' ? fillParallelGaps(pixels, width, height, WINDOW_FILL_RADIUS) : pixels;
			buffers.push({ material, pixels: solid });
		}

		// No render for the boundary pass: `detectFloorplanMasks` gives that step the
		// drawing at its intrinsic size instead, because `detectBoundary` derives its
		// working scale from `naturalWidth` and a render at working width halved every
		// polygon coordinate.

		const defaultMaterial = WALL_MATERIALS[0]!.id;
		const { wall, material } = composeRoleMasks(buffers, defaultMaterial);

		let wallPixels = 0;
		for (let i = 0; i < wall.length; i++) wallPixels += wall[i]!;
		// Nothing wall-shaped: let the raster path have it.
		if (wallPixels < 50) return null;

		// The summary and the review list describe the roles *in force*, overrides
		// included: a panel that reported the classifier's opinion while the mask carried
		// the user's would be lying about the thing it exists to explain.
		const effective: ClassifiedElement[] = classified.map((c, i) => ({
			...c,
			role: roles[i] ?? c.role
		}));

		const summary: VectorDetectionSummary = {
			walls: countRole(effective, 'wall'),
			windows: countRole(effective, 'window'),
			doors: countRole(effective, 'door'),
			ignored: countRole(effective, 'fixture') + countRole(effective, 'text'),
			unknown: countRole(effective, 'unknown'),
			total: effective.length
		};

		// Element boxes in render pixels, so a highlight lands on the plan.
		const elements: ReviewableElement[] = effective.map((c, i) => ({
			id: i,
			role: c.role,
			reason: c.reason,
			tag: c.tag,
			name: c.name,
			box: {
				x: Math.round(c.x * scale),
				y: Math.round(c.y * scale),
				w: Math.round(c.width * scale),
				h: Math.round(c.height * scale)
			}
		}));

		const materialMask = material.some((m) => m !== defaultMaterial)
			? {
					dataUrl: encodeMaterial(material, width, height),
					width,
					height,
					originX: 0,
					originY: 0
				}
			: null;

		/*
		 * The walls as geometry, not only as a mask.
		 *
		 * `segmentsFromSvg` reads the drawing's own lines, so a diagonal survives and an opening
		 * keeps its material — things the raster trace cannot do. Built here, where the roles,
		 * the content box and the render scale are all in scope, and returned with the masks so a
		 * caller can prefer the exact geometry and fall back to the mask only if there is none.
		 */
		const segments = segmentsFromSvg(svg as unknown as SVGElement, drawables, {
			roles,
			contentBox,
			scale,
			minLength: 2
		}).map((segment) => {
			const role = roles[segment.element] ?? 'unknown';
			return {
				...segment,
				material:
					role === 'window' ? WINDOW_MATERIAL : role === 'door' ? DOOR_MATERIAL : defaultMaterial
			};
		});
		/*
		 * One line that goes wall → glass → wall, not a wall with two glass lines over it.
		 *
		 * The drawing strokes a window as two parallel lines inside the wall's own long strokes, so
		 * read literally it yields two glass walls and an uninterrupted wall behind them — the
		 * double glass line and the wall that never breaks, as reported. The opening's strokes are
		 * collapsed to one centre line and then *cut into* the wall, giving its piece the opening's
		 * material.
		 */
		const wallRuns = segments.filter((segment) => segment.material === defaultMaterial);
		const openingRuns = collapseOpenings(
			segments.filter((segment) => segment.material !== defaultMaterial)
		);
		const merged = mergeOpeningsIntoWalls(wallRuns, openingRuns);

		return {
			wallMask: {
				dataUrl: encodeBinary(wall, width, height),
				width,
				height,
				originX: 0,
				originY: 0
			},
			materialMask,
			summary,
			elements,
			segments: merged.map((segment) => ({
				ax: segment.ax,
				ay: segment.ay,
				bx: segment.bx,
				by: segment.by,
				material: segment.material as WallMaterialId
			}))
		};
	} finally {
		host.remove();
	}
}

function countRole(classified: ClassifiedElement[], role: ElementRole): number {
	return classified.filter((c) => c.role === role).length;
}

/**
 * Replace every `<use>` with a copy of what it references, in place.
 *
 * The referenced nodes normally live in `<defs>`, which the classifier skips because
 * defs content is not drawn where it sits — so without this the geometry a drawing
 * reuses through `<use>` is invisible, and the plan can come back with a mask that is
 * wrong in a way nothing catches (see the caller).
 *
 * The clone goes inside a `<g>` carrying the `use` element's own `x`/`y`/`transform` and
 * presentation attributes, which is what those attributes mean on a `use`. A reference to
 * a `<symbol>` is left alone on purpose: a symbol carries its own `viewBox`, so copying
 * its children without honouring that would place them wrongly, and placing them wrongly
 * is worse than leaving them out.
 *
 * Repeated passes resolve a `<use>` that points at a group containing another `<use>`,
 * up to a small cap that also stops a reference cycle from hanging the import.
 */
function expandUse(svg: SVGSVGElement): void {
	const SVG_NS = 'http://www.w3.org/2000/svg';
	for (let pass = 0; pass < 4; pass++) {
		let expanded = 0;
		for (const use of Array.from(svg.querySelectorAll('use'))) {
			const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
			if (!href.startsWith('#')) continue;
			let target: Element | null = null;
			try {
				target = svg.querySelector(href);
			} catch {
				// An id querySelector cannot express; nothing to resolve.
				continue;
			}
			if (!target || target.tagName.toLowerCase() === 'symbol') continue;

			const group = svg.ownerDocument.createElementNS(SVG_NS, 'g');
			const x = use.getAttribute('x') ?? '0';
			const y = use.getAttribute('y') ?? '0';
			const transform = use.getAttribute('transform');
			group.setAttribute('transform', `${transform ? `${transform} ` : ''}translate(${x},${y})`);
			for (const attr of Array.from(use.attributes)) {
				if (/^(x|y|href|xlink:href|transform|id)$/.test(attr.name)) continue;
				group.setAttribute(attr.name, attr.value);
			}
			group.appendChild(target.cloneNode(true));
			use.replaceWith(group);
			expanded++;
		}
		if (expanded === 0) return;
	}
}

/**
 * The drawing's extent in user units, which is the coordinate space its geometry is in.
 *
 * In order: its `viewBox`; failing that its `width`/`height`, which *are* the viewport
 * when there is no viewBox; and only failing that the root's own bounding box.
 *
 * The order matters and a pinned plan proved it. `state-floor.svg` has no viewBox, so the
 * first version of this fell through to `getBBox()` — which reports the **unclipped**
 * extent of every child, and that file carries elements far outside its 550x360 viewport.
 * The content box came out the wrong shape, the mask came back at a different scale, and
 * the plan's wall share jumped from 6.4 % to 14.4 % with every count in the sidebar
 * unchanged. The viewport is what the drawing is clipped to; the bbox is not it.
 *
 * A percentage width is ignored because it resolves against the 1x1 measuring host rather
 * than against whatever the file will be displayed at.
 */
function contentBoxOf(svg: SVGSVGElement): { x: number; y: number; width: number; height: number } {
	const box = svg.viewBox?.baseVal;
	if (box && box.width > 0 && box.height > 0) {
		return { x: box.x, y: box.y, width: box.width, height: box.height };
	}

	const widthAttr = svg.getAttribute('width') ?? '';
	const heightAttr = svg.getAttribute('height') ?? '';
	if (widthAttr && heightAttr && !widthAttr.includes('%') && !heightAttr.includes('%')) {
		// `baseVal.value` rather than the attribute text, so `297mm` resolves to px.
		const w = svg.width?.baseVal?.value ?? 0;
		const h = svg.height?.baseVal?.value ?? 0;
		if (w > 0 && h > 0) return { x: 0, y: 0, width: w, height: h };
	}

	try {
		const own = svg.getBBox();
		if (own.width > 0 && own.height > 0) {
			return { x: own.x, y: own.y, width: own.width, height: own.height };
		}
	} catch {
		// Detached or unrenderable: the caller falls back to the target width.
	}
	return { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * Rasterise one role from the drawing's markup.
 *
 * Everything that is not the role is **removed** from a copy, including the elements
 * the classifier never sees: lettering, images, anything that is not a shape. Those
 * are the leak this fixes (see the caller), and a rule expressed as "remove what is
 * not this role" cannot leak by omission the way "hide what is not this role" did.
 */
async function renderRolePass(
	markup: string,
	role: ElementRole,
	roles: ElementRole[],
	width: number,
	height: number,
	contentBox: { x: number; y: number; width: number; height: number }
): Promise<HTMLImageElement> {
	const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
	const svg = doc.querySelector('svg');
	if (!svg) throw new Error('no svg in markup');

	for (const el of Array.from(svg.querySelectorAll('text, tspan, image, foreignObject'))) {
		el.remove();
	}

	const drawables = selectDrawableElements(svg);
	drawables.forEach((el, i) => {
		if ((roles[i] ?? 'unknown') !== role) el.remove();
	});

	// A copy is detached, so it cannot measure itself — the caller measured the live one.
	// Without this, `width`/`height` resize the canvas but not the drawing: an SVG with no
	// `viewBox` draws at its own user units, so everything lands in the corner at the wrong
	// scale and the mask no longer lines up with the plan.
	if (!svg.getAttribute('viewBox') && contentBox.width > 0 && contentBox.height > 0) {
		svg.setAttribute(
			'viewBox',
			`${contentBox.x} ${contentBox.y} ${contentBox.width} ${contentBox.height}`
		);
	}
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	const serialized = new XMLSerializer().serializeToString(svg);
	const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }));
	try {
		return await new Promise<HTMLImageElement>((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error('vector render failed'));
			img.src = url;
		});
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** 1 where the image has ink, 0 elsewhere, at exactly `width x height`. */
async function alphaToBuffer(
	image: HTMLImageElement,
	width: number,
	height: number
): Promise<Uint8Array> {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(image, 0, 0, width, height);
	const data = ctx.getImageData(0, 0, width, height).data;
	const out = new Uint8Array(width * height);
	for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3]! > 128 ? 1 : 0;
	return out;
}

/** Binary mask as a PNG data URL, white on transparent — the format `decodeMask` reads. */
function encodeBinary(mask: Uint8Array, w: number, h: number): string {
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(w, h);
	for (let i = 0; i < mask.length; i++) {
		if (!mask[i]) continue;
		const j = i * 4;
		img.data[j] = img.data[j + 1] = img.data[j + 2] = 255;
		img.data[j + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
	return canvas.toDataURL('image/png');
}

/**
 * Material ids as a PNG, the id in the red channel.
 *
 * Deliberately the same encoding as `region-labels.encodeMaterialMask`, which is
 * what the paint brush writes. Importing it here would drag a module that also
 * labels rooms into this path; the duplication is four lines and is checked by the
 * test that round-trips both.
 */
function encodeMaterial(mask: Uint8Array, w: number, h: number): string {
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(w, h);
	for (let i = 0; i < mask.length; i++) {
		const j = i * 4;
		img.data[j] = mask[i]!;
		img.data[j + 1] = 0;
		img.data[j + 2] = 0;
		img.data[j + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
	return canvas.toDataURL('image/png');
}
