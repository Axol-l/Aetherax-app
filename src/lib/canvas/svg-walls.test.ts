/**
 * Reading wall geometry out of an SVG, on cases whose answer is the drawing itself.
 *
 * The module is arithmetic over attributes, so the tests build minimal element objects rather than
 * a DOM: the rules are about coordinates, not about rendering.
 */
import { describe, expect, it } from 'vitest';
import { elementSegments, parseTransform, pathSegments, segmentsFromSvg } from './svg-walls.js';

interface FakeElement {
	tagName: string;
	parentElement: FakeElement | null;
	getAttribute(name: string): string | null;
}

/**
 * A minimal element: the module only ever calls `getAttribute` and walks `parentElement`, so a
 * plain object is enough and the rules can be tested without a DOM.
 */
function el(
	tagName: string,
	attributes: Record<string, string> = {},
	parent: FakeElement | null = null
): Element {
	const node: FakeElement = {
		tagName,
		parentElement: parent,
		getAttribute: (name) => attributes[name] ?? null
	};
	return node as unknown as Element;
}

const asSvg = (element: FakeElement): SVGElement => element as unknown as SVGElement;

describe('parseTransform', () => {
	const apply = (m: readonly number[], x: number, y: number) => ({
		x: m[0]! * x + m[2]! * y + m[4]!,
		y: m[1]! * x + m[3]! * y + m[5]!
	});

	it('translates and scales in order', () => {
		const m = parseTransform('translate(10,20) scale(2)');
		expect(apply(m, 1, 1)).toEqual({ x: 12, y: 22 });
	});

	it('rotates about a centre', () => {
		const m = parseTransform('rotate(90 50 50)');
		const p = apply(m, 60, 50);
		expect(p.x).toBeCloseTo(50, 6);
		expect(p.y).toBeCloseTo(60, 6);
	});

	it('is the identity for nothing and for an unknown keyword', () => {
		expect(parseTransform(null)).toEqual([1, 0, 0, 1, 0, 0]);
		expect(parseTransform('wobble(3)')).toEqual([1, 0, 0, 1, 0, 0]);
	});
});

describe('elementSegments', () => {
	it('reads a line exactly', () => {
		expect(elementSegments(el('line', { x1: '10', y1: '20', x2: '30', y2: '40' }))).toEqual([
			[10, 20, 30, 40]
		]);
	});

	it('reads a rectangle as its four edges', () => {
		const segments = elementSegments(el('rect', { x: '10', y: '10', width: '20', height: '30' }));
		expect(segments).toHaveLength(4);
		expect(segments[0]).toEqual([10, 10, 30, 10]);
	});

	it('keeps a diagonal polyline diagonal', () => {
		const segments = elementSegments(el('polyline', { points: '0,0 10,10 20,0' }));
		expect(segments).toEqual([
			[0, 0, 10, 10],
			[10, 10, 20, 0]
		]);
	});

	it('follows a path of moves and lines, absolute and relative', () => {
		expect(pathSegments('M10 10 L20 20 h10 v10 z')).toEqual([
			[10, 10, 20, 20],
			[20, 20, 30, 20],
			[30, 20, 30, 30],
			[30, 30, 10, 10]
		]);
	});

	it('refuses a curved path rather than approximating it', () => {
		expect(elementSegments(el('path', { d: 'M0 0 C10 10 20 10 30 0' }))).toEqual([]);
	});
});

describe('segmentsFromSvg', () => {
	const root = el('svg');

	it('maps into the rendered frame and keeps roles apart', () => {
		const elements = [
			el('line', { x1: '10', y1: '10', x2: '110', y2: '10' }, root),
			el('line', { x1: '10', y1: '20', x2: '110', y2: '20' }, root)
		];
		const segments = segmentsFromSvg(asSvg(root), elements as unknown as Element[], {
			roles: ['wall', 'fixture'],
			contentBox: { x: 0, y: 0, width: 200, height: 200 },
			scale: 0.5
		});
		// The fixture line is dropped; the wall lands at half size in the render's frame.
		expect(segments).toHaveLength(1);
		expect(segments[0]!.ax).toBeCloseTo(5, 6);
		expect(segments[0]!.bx).toBeCloseTo(55, 6);
		expect(segments[0]!.element).toBe(0);
	});

	it('applies an element transform before scaling', () => {
		const rootNode: FakeElement = {
			tagName: 'svg',
			parentElement: null,
			getAttribute: () => null
		};
		const parent: FakeElement = {
			tagName: 'g',
			parentElement: rootNode,
			getAttribute: (name) => (name === 'transform' ? 'translate(100,0)' : null)
		};
		const line = el('line', { x1: '0', y1: '0', x2: '50', y2: '0' }, parent);
		const segments = segmentsFromSvg(asSvg(rootNode), [line], {
			roles: ['wall'],
			contentBox: { x: 0, y: 0, width: 200, height: 200 },
			scale: 1
		});
		expect(segments[0]!.ax).toBeCloseTo(100, 6);
		expect(segments[0]!.bx).toBeCloseTo(150, 6);
	});

	it('drops segments shorter than the minimum', () => {
		const elements = [
			el('line', { x1: '0', y1: '0', x2: '1', y2: '0' }, root),
			el('line', { x1: '0', y1: '5', x2: '50', y2: '5' }, root)
		];
		const segments = segmentsFromSvg(asSvg(root), elements as unknown as Element[], {
			roles: ['wall', 'wall'],
			contentBox: { x: 0, y: 0, width: 100, height: 100 },
			scale: 1,
			minLength: 5
		});
		expect(segments).toHaveLength(1);
	});
});
