#!/usr/bin/env node
/**
 * Exhaustive-placement baseline for the optimiser's own objective.
 *
 * The optimiser is stochastic, so "the best of four restarts" only ever says how
 * much the *search* varies on a plan — not how far it is from the best placement
 * that exists. This script answers the second question for a scenario small enough
 * to enumerate: an open rectangular floor, one band, one radius per AP, and the
 * utility formula the optimiser actually maximises (H1/H3 in
 * `docs/PHYSICAL_MODELS.md`, `coverageUtilityAboveThreshold` in
 * `src/lib/rf/propagation.ts`):
 *
 *     margin(d) = 10·n·log10(R/d) − 15      n = 4 (closed plan), R = association radius
 *     utility   = clamp(margin / 10, 0, 1)  over the best (nearest) AP
 *     score     = mean utility over the floor
 *
 * No walls, because the interior of a convex room has no wall between any two of
 * its own points, so this is exactly the app's model for a plan like the one the
 * `limited` scenario in `interference-alternation.spec.ts` seeds.
 *
 * Usage:
 *   node tests/measure/lattice-optimum.mjs --search --size 1000x667 --radius 700
 *   node tests/measure/lattice-optimum.mjs --score "221,318;812,340" --size 1000x667 --radius 700
 *
 * `--score` takes the app's own answer and scores it here, which is the check that
 * this model reproduces the app's: the two figures should agree to within the
 * sampling noise of the app's 400 samples.
 */

const PATH_LOSS_N = 4;
const COVERAGE_MARGIN_DB = 15;
const FULL_MARGIN_DB = 10;
/** Below this margin a sample is uncovered, i.e. outside the AP's coverage reach. */
const REACH_FACTOR = Math.pow(10, -COVERAGE_MARGIN_DB / (10 * PATH_LOSS_N));

function parseArgs(argv) {
	const opts = {
		size: [1000, 667],
		border: 8,
		radius: 700,
		/** Lattice pitch of the exhaustive pass, in px. */
		pitch: 32,
		/** Sampling pitch of the utility field, in px. */
		sample: 8,
		/**
		 * Objective threshold softness in dB: 0 is the hard threshold, and `S` ramps
		 * the utility from 0 at `S` dB below the threshold to 1 at +10 dB. Matches
		 * `coverageUtilityAboveThreshold` in `src/lib/rf/propagation.ts`.
		 */
		softness: 0,
		score: null,
		search: false
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === '--search') opts.search = true;
		else if (flag === '--score') opts.score = value, i++;
		else if (flag === '--size') opts.size = value.split('x').map(Number), i++;
		else if (flag === '--border') opts.border = Number(value), i++;
		else if (flag === '--radius') opts.radius = Number(value), i++;
		else if (flag === '--pitch') opts.pitch = Number(value), i++;
		else if (flag === '--sample') opts.sample = Number(value), i++;
		else if (flag === '--softness') opts.softness = Number(value), i++;
		else throw new Error(`unknown argument ${flag}`);
	}
	return opts;
}

/** Margin in dB above the coverage threshold at distance `d` from an AP. */
function marginDb(d, radius) {
	if (d <= 0) return Infinity;
	return 10 * PATH_LOSS_N * Math.log10(radius / d) - COVERAGE_MARGIN_DB;
}

/** The optimiser's per-sample utility: 0 at the threshold, 1 at +10 dB. */
function utility(margin, softness = 0) {
	if (softness > 0) {
		const value = (margin + softness) / (FULL_MARGIN_DB + softness);
		if (value <= 0) return 0;
		return value >= 1 ? 1 : value;
	}
	if (!(margin > 0)) return 0;
	if (margin >= FULL_MARGIN_DB) return 1;
	return margin / FULL_MARGIN_DB;
}

/** Interior sample points of the open room, inset by the wall border. */
function samples([width, height], border, pitch) {
	const out = [];
	for (let y = border; y < height - border; y += pitch) {
		for (let x = border; x < width - border; x += pitch) out.push([x, y]);
	}
	return out;
}

/** Candidate AP positions on the exhaustive lattice. */
function lattice([width, height], border, pitch) {
	const out = [];
	for (let y = border; y < height - border; y += pitch) {
		for (let x = border; x < width - border; x += pitch) out.push([x, y]);
	}
	return out;
}

/** Utility and covered share of one placement, over the fine sample set. */
function evaluate(aps, pts, opts) {
	let sum = 0;
	let covered = 0;
	for (const [sx, sy] of pts) {
		// The best *margin* decides both figures: the utility is monotone in it, and
		// covered is the margin's sign, which softness must not move.
		let best = -Infinity;
		for (const [ax, ay] of aps) {
			const m = marginDb(Math.hypot(sx - ax, sy - ay), opts.radius);
			if (m > best) best = m;
		}
		if (best > 0) covered++;
		sum += utility(best, opts.softness);
	}
	return { score: sum / pts.length, coverage: covered / pts.length };
}

/** Utility at every sample for one AP position: the inner loop, precomputed. */
function fieldFor(ap, pts, opts) {
	const field = new Float32Array(pts.length);
	for (let i = 0; i < pts.length; i++) {
		field[i] = utility(
			marginDb(Math.hypot(pts[i][0] - ap[0], pts[i][1] - ap[1]), opts.radius),
			opts.softness
		);
	}
	return field;
}

/**
 * Best two-AP placement: every lattice pair, scored from the precomputed fields.
 *
 * Two APs is what the measurement scenario needs and what keeps this exhaustive
 * rather than heuristic — the pair count is what would blow up for more.
 */
function bestPair(opts) {
	const pts = samples(opts.size, opts.border, opts.sample);
	const sites = lattice(opts.size, opts.border, opts.pitch);
	const fields = sites.map((ap) => fieldFor(ap, pts, opts));
	let best = { score: -1, aps: null };
	for (let i = 0; i < sites.length; i++) {
		const fi = fields[i];
		for (let j = i; j < sites.length; j++) {
			const fj = fields[j];
			let sum = 0;
			for (let k = 0; k < pts.length; k++) sum += fi[k] > fj[k] ? fi[k] : fj[k];
			const score = sum / pts.length;
			if (score > best.score) best = { score, aps: [sites[i], sites[j]] };
		}
	}
	// The exhaustive pass walks a coarse lattice, so what it finds is a lower bound
	// on the continuous optimum. A hill climb on a finer lattice closes most of the
	// remaining gap and costs nothing at this size.
	const refined = hillClimb(best.aps, pts, opts);
	return {
		sites: sites.length,
		coarse: best,
		refined,
		pairs: (sites.length * (sites.length + 1)) / 2,
		samples: pts.length
	};
}

/** Coordinate descent on a pitch/4 lattice, from a starting placement. */
function hillClimb(aps, pts, opts) {
	const step = Math.max(1, Math.round(opts.pitch / 4));
	const [width, height] = opts.size;
	const border = opts.border;
	let current = aps.map((p) => [...p]);
	let currentScore = evaluate(current, pts, opts).score;
	for (let pass = 0; pass < 200; pass++) {
		let improved = false;
		for (let a = 0; a < current.length; a++) {
			for (const [dx, dy] of [
				[step, 0],
				[-step, 0],
				[0, step],
				[0, -step],
				[step, step],
				[-step, step],
				[step, -step],
				[-step, -step]
			]) {
				const x = current[a][0] + dx;
				const y = current[a][1] + dy;
				if (x < border || y < border || x >= width - border || y >= height - border) continue;
				const candidate = current.map((p, i) => (i === a ? [x, y] : p));
				const score = evaluate(candidate, pts, opts).score;
				if (score > currentScore + 1e-9) {
					current = candidate;
					currentScore = score;
					improved = true;
				}
			}
		}
		if (!improved) break;
	}
	return { score: currentScore, aps: current, ...evaluate(current, pts, opts) };
}

function parseAps(text) {
	return text.split(';').map((pair) => {
		const [x, y] = pair.split(',').map(Number);
		if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`bad AP ${pair}`);
		return [x, y];
	});
}

const opts = parseArgs(process.argv.slice(2));
const pts = samples(opts.size, opts.border, opts.sample);
const out = { size: opts.size, radius: opts.radius, softness: opts.softness, reach: opts.radius * REACH_FACTOR };

if (opts.score) {
	const aps = parseAps(opts.score);
	out.scored = { aps, ...evaluate(aps, pts, opts), samples: pts.length };
}
if (opts.search) {
	const result = bestPair(opts);
	out.search = {
		latticePitch: opts.pitch,
		sites: result.sites,
		pairs: result.pairs,
		samples: result.samples,
		coarseScore: result.coarse.score,
		coarseAps: result.coarse.aps,
		best: result.refined
	};
}
console.log(JSON.stringify(out, null, 2));
