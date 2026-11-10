import { describe, expect, it } from 'vitest';
import { maskContentSignature } from './mask-registry.js';

describe('mask content signatures', () => {
	it('is stable across decoded copies of the same mask', () => {
		const data = new Uint8Array([0, 1, 0, 1]);
		const a = { data, width: 2, height: 2, originX: 3, originY: 4 };
		const b = { data: new Uint8Array(data), width: 2, height: 2, originX: 3, originY: 4 };
		expect(maskContentSignature(a)).toBe(maskContentSignature(b));
	});

	it('changes when a pixel changes', () => {
		const a = { data: new Uint8Array([0, 1, 0, 1]), width: 2, height: 2, originX: 0, originY: 0 };
		const b = { data: new Uint8Array([0, 1, 0, 0]), width: 2, height: 2, originX: 0, originY: 0 };
		expect(maskContentSignature(a)).not.toBe(maskContentSignature(b));
	});
});
