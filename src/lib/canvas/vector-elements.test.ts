/**
 * The vector classifier decides what becomes a wall, an opening or nothing at all,
 * and it does so from evidence that weakens as you go down its rule order — a name,
 * then how the element is painted, then how wide it is relative to its neighbours.
 *
 * So each rule is pinned here against the pattern it was measured on, including the
 * two guards that were added because a real file broke the naive version:
 * `little-white-house.svg`, whose widest stroke is 2 px so a plain width ratio
 * promoted every 1 px line in the drawing, and `state-floor.svg`, whose two stair
 * flights satisfied the window test element-by-element and reported 19 windows.
 *
 * The facts below are hand-written from what `describeSvgElements` reports for those
 * files, because the adapter needs a live DOM and this project's vitest runs in node.
 */
import { describe, expect, it } from 'vitest';
import {
	classifyVectorElements,
	roleFromName,
	type ArcMeasurement,
	type ElementRole,
	type VectorElementFacts
} from './vector-elements.js';

/** One element, with the defaults a plain thin line would have. */
function fact(overrides: Partial<VectorElementFacts> = {}): VectorElementFacts {
	return {
		tag: 'line',
		name: '',
		strokeWidth: 1,
		hasStroke: true,
		hasFill: false,
		stroke: 'rgb(26, 26, 26)',
		fill: 'none',
		length: 100,
		x: 0,
		y: 0,
		width: 100,
		height: 0,
		curved: false,
		arc: null,
		subpaths: 1,
		...overrides
	};
}

/**
 * A door swing as the shipped plans draw it: an open arc, one bulge, 60° of a circle
 * whose radius matches its chord.
 */
function swing(overrides: Partial<ArcMeasurement> = {}): ArcMeasurement {
	return { chord: 40, radius: 40, sweep: 60, sShaped: false, ...overrides };
}

/** A thin stroked curve carrying the given measurement. */
function curve(arc: ArcMeasurement | null, overrides: Partial<VectorElementFacts> = {}) {
	return fact({ curved: true, arc, width: 40, height: 40, length: 42, tag: 'path', ...overrides });
}

/** A filled area, which is what poché and room fills both are. */
function filled(overrides: Partial<VectorElementFacts> = {}): VectorElementFacts {
	return fact({
		hasStroke: false,
		hasFill: true,
		stroke: 'none',
		fill: 'rgb(138, 121, 88)',
		...overrides
	});
}

/**
 * Roles for a list of facts, with the plan area the shipped sample reports.
 *
 * The area matters to the rules that are relative to the drawing rather than to pixels —
 * the poché size test and the door-swing radius bound — so it is passed by default
 * instead of being left at zero, which would silently disable both.
 */
const SAMPLE_PLAN_AREA = 440 * 360;
const roles = (facts: VectorElementFacts[], planArea = SAMPLE_PLAN_AREA): ElementRole[] =>
	classifyVectorElements(facts, { planArea }).map((c) => c.role);

describe('naming', () => {
	it('reads the fragments a draughtsman writes', () => {
		expect(roleFromName('wall')?.role).toBe('wall');
		expect(roleFromName('iwall')?.role).toBe('wall');
		expect(roleFromName('door')?.role).toBe('door');
		expect(roleFromName('window')?.role).toBe('window');
		expect(roleFromName('glass')?.role).toBe('window');
		expect(roleFromName('desk')?.role).toBe('fixture');
		expect(roleFromName('label')?.role).toBe('text');
		expect(roleFromName('dim')?.role).toBe('text');
	});

	it('does not match a fragment inside a longer word', () => {
		// `windowsill` is not a window, and `wallpaper` is not a wall.
		expect(roleFromName('windowsill')).toBeNull();
		expect(roleFromName('wallpaper')).toBeNull();
	});

	it('prefers the opening when a name says both', () => {
		expect(roleFromName('door-wall')?.role).toBe('door');
		expect(roleFromName('wall window')?.role).toBe('window');
	});

	it('beats geometry, because a name is the draughtsman speaking', () => {
		// A 1 px stroke would never be a wall by width; the name says otherwise.
		const classified = classifyVectorElements([
			fact({ name: 'wall', strokeWidth: 1 }),
			fact({ name: '', strokeWidth: 5 })
		]);
		expect(classified.map((c) => c.role)).toEqual(['wall', 'wall']);
		expect(classified[0]!.reason).toContain('named');
	});
});

describe('areas', () => {
	it('takes a long thin filled shape as poché', () => {
		expect(roles([fact({ hasStroke: false, hasFill: true, width: 200, height: 12 })])).toEqual([
			'wall'
		]);
	});

	it('drops a filled shape that is not wall-shaped', () => {
		// A room: 4 m by 3 m at this drawing's scale.
		expect(roles([fact({ hasStroke: false, hasFill: true, width: 400, height: 300 })])).toEqual([
			'fixture'
		]);
	});
});

/**
 * The door-swing rule.
 *
 * It used to be "thin, unfilled, curved", which called every arc in a drawing a door.
 * The measurements are the ones taken from the shipped plans: the eighteen elements the
 * three named samples draw as `class="door"` all measure chord 40–50, radius 40–50 and a
 * 60° sweep, and `state-floor.svg`'s one false door was a closed 424-unit outline whose
 * ends met.
 */
describe('door swings', () => {
	it('takes an open arc of a plausible sweep', () => {
		expect(roles([curve(swing())])).toEqual(['door']);
	});

	it('takes a quarter circle, which is what a plan actually draws', () => {
		expect(roles([curve(swing({ sweep: 90, chord: 57, radius: 40 }))])).toEqual(['door']);
	});

	it('rejects a closed curve, which is what state-floor reported as a door', () => {
		// 424 units of outline whose ends meet: an arched portico, not a swing.
		expect(roles([curve(swing({ chord: 0, radius: null, sweep: null }))])).toEqual(['unknown']);
	});

	it('rejects a shallow curve and a nearly-closed one', () => {
		expect(roles([curve(swing({ sweep: 25 }))])).toEqual(['unknown']);
		expect(roles([curve(swing({ sweep: 170 }))])).toEqual(['unknown']);
	});

	it('rejects an S-curve however it measures', () => {
		expect(roles([curve(swing({ sShaped: true }))])).toEqual(['unknown']);
	});

	it('rejects a curve too large to be a door leaf', () => {
		// A bowed wall: same shape, but the radius is most of the building.
		expect(roles([curve(swing({ radius: 4000, chord: 4000, sweep: 90 }))])).toEqual(['unknown']);
	});

	it('rejects a curve with no measurement at all', () => {
		// `describeSvgElements` could not walk it; no evidence is not evidence of a door.
		expect(roles([curve(null)])).toEqual(['unknown']);
	});

	it('still prefers a name over the shape', () => {
		expect(roles([curve(swing({ sShaped: true }), { name: 'door' })])).toEqual(['door']);
	});

	it('is not stolen by the window test', () => {
		// `apartment-48sqm.svg` draws a door as an arc plus its straight leaf: the same
		// length, a few stroke widths apart, overlapping along the run — every condition
		// the window-pair test asks for, which is why it used to report 8 windows and 3
		// doors once the names were stripped.
		const arc = curve(swing(), { x: 0, y: 0, width: 40, height: 10, length: 42 });
		// Same stroke width as the arc, so the width cut does not decide the pair before
		// the curve exclusion gets its turn.
		const leaf = fact({ x: 0, y: 5, width: 40, height: 0, length: 40 });
		const classified = classifyVectorElements([arc, leaf], { planArea: SAMPLE_PLAN_AREA });
		expect(classified[0]!.role, 'the arc is a swing').toBe('door');
		expect(classified[1]!.role, 'the leaf is not a window in its own right').not.toBe('window');

		// Control: the same pair with no bulge measured *is* a window pair, which is what
		// makes the assertion above about the arc rather than about the geometry.
		const flat = curve(null, { x: 0, y: 0, width: 40, height: 10, length: 42 });
		const control = classifyVectorElements([flat, leaf], { planArea: SAMPLE_PLAN_AREA });
		expect(control[0]!.role).toBe('window');
		expect(control[1]!.role).toBe('window');
	});
});

describe('poché built from blocks', () => {
	/**
	 * A drawing with a wall in it.
	 *
	 * The thin line matters: a width cut needs two widths to cut between, so a drawing
	 * whose only stroke is its wall has no identified wall — and the last test here
	 * pins that a block is still recovered on such a drawing, because the poché rule
	 * reads paint and size rather than comparing against a wall that was found.
	 */
	const wall = fact({ strokeWidth: 5, stroke: 'rgb(138, 121, 88)' });
	const detail = fact({ strokeWidth: 1, width: 40, height: 0, x: 0, y: 300 });
	const PLAN = 400_000;
	/** Role of the third fact, which the helpers below place a filled shape at. */
	const blockRole = (block: VectorElementFacts, planArea = PLAN) =>
		classifyVectorElements([wall, detail, block], { planArea })[2]!.role;

	it('takes a large dark block as wall', () => {
		// state-floor.svg: the walls are ~56 filled blocks and no long thin shapes.
		expect(blockRole(filled({ width: 100, height: 131 }))).toBe('wall');
	});

	it('leaves lettering alone even when it shares the wall colour', () => {
		// little-white-house.svg: the room labels are outlined letters in exactly the
		// wall's brown, one glyph per element. Their size is the only thing that
		// separates them.
		const glyphs = Array.from({ length: 8 }, (_, i) =>
			filled({ width: 13, height: 47, x: i * 14 })
		);
		const classified = classifyVectorElements([wall, detail, ...glyphs], { planArea: PLAN });
		expect(classified.slice(2).every((c) => c.role === 'fixture')).toBe(true);
	});

	it('leaves a word-shaped path alone even when it is big enough to be a block', () => {
		// state-floor.svg: each room label is one filled path holding a whole word's
		// letter outlines, so its bounding box clears the size test. The subpath count is
		// what gives it away.
		const word = filled({ width: 132, height: 30, subpaths: 17 });
		expect(blockRole(word)).toBe('fixture');
		// The same box as a single shape is a wall.
		expect(blockRole(filled({ width: 132, height: 30, subpaths: 1 }))).toBe('wall');
	});

	it('leaves a room fill alone however large it is, because it is not dark', () => {
		// The three room colours measured on the shipped plans, all with a bright
		// channel; the red one is the reason brightness is measured per channel rather
		// than as luminance (129 against the walls' 122).
		for (const fill of ['rgb(255, 241, 218)', 'rgb(233, 86, 82)', 'rgb(71, 117, 209)']) {
			expect(blockRole(filled({ width: 244, height: 143, fill })), fill).toBe('fixture');
		}
	});

	it('judges size against the plan, not against pixels', () => {
		// The same 100×131 block is structure on a small drawing and lettering-sized on a
		// huge one; only the share of the plan tells them apart.
		const block = filled({ width: 100, height: 131 });
		expect(blockRole(block, 100_000)).toBe('wall');
		expect(blockRole(block, 40_000_000)).toBe('fixture');
	});

	it('recovers a block even when no wall stroke was identified at all', () => {
		// A plan drawn entirely in poché: there is no wall colour to compare against, and
		// the rule does not need one.
		const classified = classifyVectorElements([filled({ width: 100, height: 131 })], {
			planArea: PLAN
		});
		expect(classified[0]!.role).toBe('wall');
	});

	it('needs a plan area to judge size against', () => {
		const classified = classifyVectorElements([wall, detail, filled({ width: 100, height: 131 })]);
		expect(classified[2]!.role).toBe('fixture');
	});
});

describe('windows are a pair, not a run', () => {
	const windowLine = (y: number) =>
		fact({ strokeWidth: 1.5, length: 80, x: 80, y, width: 80, height: 0 });

	it('pairs two parallel thin lines', () => {
		expect(roles([windowLine(18), windowLine(22)])).toEqual(['window', 'window']);
	});

	it('refuses a run of three, which is a staircase or hatching', () => {
		// state-floor.svg's stair flights: parallel treads, every pair of which passes
		// the pairwise test.
		const treads = [0, 20, 40, 60].map((y) =>
			fact({ strokeWidth: 1, length: 60, x: 200, y, width: 60, height: 0 })
		);
		expect(roles(treads)).not.toContain('window');
	});

	it('ignores lines that are far apart', () => {
		expect(roles([windowLine(0), windowLine(60)])).not.toContain('window');
	});

	it('ignores lines of different lengths', () => {
		const short = fact({ strokeWidth: 1.5, length: 30, x: 80, y: 22, width: 30, height: 0 });
		expect(roles([windowLine(18), short])).not.toContain('window');
	});
});

describe('the width cluster', () => {
	it('takes the thick minority as walls and leaves the thin majority alone', () => {
		// apartment-48sqm.svg: 5 outer walls at 5 px, 8 partitions at 3.5, openings at
		// 1.5, fixtures at 1. Only the walls and partitions are thick.
		const facts = [
			...Array.from({ length: 5 }, () => fact({ strokeWidth: 5 })),
			...Array.from({ length: 8 }, () => fact({ strokeWidth: 3.5 })),
			...Array.from({ length: 6 }, () => fact({ strokeWidth: 1.5 })),
			...Array.from({ length: 5 }, () => fact({ strokeWidth: 1 }))
		];
		const classified = classifyVectorElements(facts);
		expect(classified.filter((c) => c.role === 'wall')).toHaveLength(13);
	});

	it('does not promote the majority when the drawing has almost no width spread', () => {
		// little-white-house.svg: one 2 px path carries the whole wall network, and
		// five 1 px paths carry details. A plain ratio puts the threshold at 1 px and
		// makes those five walls too.
		const facts = [
			...Array.from({ length: 5 }, () => fact({ strokeWidth: 1 })),
			fact({ strokeWidth: 2, subpaths: 45, length: 3000 })
		];
		const classified = classifyVectorElements(facts);
		const walls = classified.filter((c) => c.role === 'wall');
		expect(walls).toHaveLength(1);
		expect(walls[0]!.strokeWidth).toBe(2);
	});

	it('leaves a file with no strokes at all without walls', () => {
		expect(roles([fact({ hasStroke: false, hasFill: true, width: 400, height: 300 })])).toEqual([
			'fixture'
		]);
	});
});

describe('doors', () => {
	it('does not call a curve a door on the curve alone', () => {
		// This is the old rule, kept as a test of what replaced it: a thin curve with no
		// arc measurement is an `unknown`, which the review panel asks about. The arc
		// tests above cover what earns the door role instead.
		expect(
			roles([fact({ curved: true, strokeWidth: 1.5, length: 63, width: 40, height: 40 })])
		).toEqual(['unknown']);
	});

	it('does not call a thick curve a door, because an arch is a wall', () => {
		// little-white-house.svg's sun-deck arch.
		const facts = [
			fact({ curved: true, strokeWidth: 2, length: 400, width: 200, height: 160 }),
			fact({ strokeWidth: 1 })
		];
		expect(roles(facts)[0]).toBe('wall');
	});
});
