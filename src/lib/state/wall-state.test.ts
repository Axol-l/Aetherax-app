import { beforeEach, describe, expect, it } from 'vitest';
import { floorState } from './floor-state.svelte.js';
import { wallState, type VectorReview } from './wall-state.svelte.js';

const review = (walls: number): VectorReview => ({
	summary: { walls, windows: 0, doors: 0, ignored: 0, unknown: 0, total: walls },
	elements: [],
	overrides: new Map(),
	source: 'data:image/svg+xml,<svg/>',
	targetWidth: 800
});

describe('per-floor wall review', () => {
	beforeEach(() => {
		floorState.floors = [
			{ id: 'floor-a', name: 'Floor 1' },
			{ id: 'floor-b', name: 'Floor 2' }
		] as unknown as typeof floorState.floors;
		floorState.currentFloorId = 'floor-a';
	});

	it('does not show a review from another floor', () => {
		floorState.currentFloorId = 'floor-b';
		wallState.vectorReview = review(29);

		floorState.currentFloorId = 'floor-a';
		expect(wallState.vectorReview).toBeNull();
	});

	it('keeps a review with its own floor', () => {
		floorState.currentFloorId = 'floor-b';
		wallState.vectorReview = review(29);

		floorState.currentFloorId = 'floor-a';
		expect(wallState.vectorReview).toBeNull();

		floorState.currentFloorId = 'floor-b';
		expect(wallState.vectorReview?.summary.walls).toBe(29);
	});
});
