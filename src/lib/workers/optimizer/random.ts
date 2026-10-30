/**
 * The optimiser's seeded PRNG.
 *
 * A run is stochastic, and every before/after comparison of a model change is meaningless
 * if two runs on identical input cannot be repeated. The seed is reported back in the
 * result so a run can be replayed exactly.
 */
/**
 * Seeded PRNG (mulberry32).
 *
 * The optimiser used bare `Math.random()` in three places — the k-means++ seed
 * pick, the PSO position jitter and the PSO velocity update — with no way to
 * set or recover the stream. Two runs on identical input could therefore return
 * different placements, which makes every before/after comparison of a model
 * change meaningless: you cannot tell an improvement from a lucky draw.
 *
 * The seed actually used is reported back in the result message, so a run can be
 * repeated exactly by passing that seed in again.
 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
