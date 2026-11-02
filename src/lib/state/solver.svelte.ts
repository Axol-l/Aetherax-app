import { debug } from '$lib/log.js';
import { buildInterferenceGraph } from '@aetherax/geometry';
import { planningChannels, planningCandidates, estimateThroughput } from '@aetherax/channels';
import type { ChannelWidth, ThroughputEstimate, ThroughputInput } from '@aetherax/channels';
import type { Band } from '@aetherax/channels';
import type { SolverResult, ComparisonResult } from '@aetherax/solver';
import { updateAp, clearAssignments } from './ap-state.svelte.js';
import { SolverBridge } from '../workers/solver-bridge.js';
import { floorState, getFloorSlabAttenuation } from './floor-state.svelte.js';
import { getMaterialDbTable, getFlatAttenuation, type WallMaterialId } from '$lib/domain/materials.js';
import { rayMarchWallAtten } from '../rf/propagation.js';
import { balanceAssignment, widenAssignment } from '../rf/interference.js';
import { makeOverlapLookup } from '../rf/channel-overlap.js';
import { wallState } from './wall-state.svelte.js';
import {
	getFloorMask,
	type DecodedFloorMask
} from './floor-mask.js';
import { buildAssignmentConflictEdges, updateCoverage } from './optimizer.svelte.js';
import { scheduleSave } from './persistence.svelte.js';
import { findModel } from '$lib/data/ap-models.js';

type Algorithm = 'greedy' | 'dsatur' | 'welsh-powell' | 'backtracking';

const bridge = new SolverBridge();

/**
 * The last conflict graph and the geometry it was built from.
 *
 * See `buildSerializedGraph`: building the graph runs the optimiser's margin pass and costs
 * hundreds of milliseconds, so an unchanged plan must not pay for it twice.
 */
let lastGraph: { signature: string; graph: Awaited<ReturnType<typeof buildGraphUncached>> } | null =
	null;

/** Everything the conflict graph is a function of, as a string. */
function graphSignature(): string {
	const aps = apState.aps
		.map(
			(ap) =>
				`${ap.id}:${Math.round(ap.x)}:${Math.round(ap.y)}:${ap.floorId}:${ap.band}:${ap.interferenceRadius}:${ap.channelWidth}:${ap.mount ?? ''}:${ap.mountHeightM}:${ap.facingDeg ?? ''}`
		)
		.join('|');
	const walls = floorState.floors
		.map(
			(floor) =>
				`${floor.id}:${(floor.walls ?? [])
					.map((w) => `${Math.round(w.ax)},${Math.round(w.ay)},${Math.round(w.bx)},${Math.round(w.by)},${w.heightM ?? 0},${w.material}`)
					.join(';')}`
		)
		.join('|');
	return `${aps}##${walls}##${wallState.wallMaterial}##${projectMeta.clientHeight}`;
}

/** Attenuated signal between AP pairs: "apIdA:apIdB" 鈫?signal (0-1). */
export const edgeSignals = new Map<string, number>();

export const solverState = $state({
	algorithm: 'dsatur' as Algorithm,
	isRunning: false,
	lastResult: null as SolverResult | null,
	comparisonResults: null as ComparisonResult | null,
	lastTiming: 0,
	error: null as string | null,
	autoSolve: true,
	throughputEstimates: [] as ThroughputEstimate[]
});

/** Compute cumulative z-position (in world units) for each floor level. */
function getFloorZ(): Map<string, number> {
	const wupm = wupmForFloor(floorState.currentFloorId);
	const sorted = [...floorState.floors].sort((a, b) => a.level - b.level);
	const zMap = new Map<string, number>();
	let z = 0;
	for (const floor of sorted) {
		zMap.set(floor.id, z * wupm);
		z += floor.ceilingHeight;
	}
	return zMap;
}

function getApPositions() {
	const floorZ = getFloorZ();
	const reference = floorState.currentFloorId;
	return apState.aps.map((ap) => {
		// Positions, radii and z are compared across floors, so everything is brought into
		// the current floor's units: a storey calibrated at twice the resolution would
		// otherwise look twice as far away, and its AP twice as large.
		const k = scaleBetween(ap.floorId, reference);
		return {
			id: ap.id,
			x: ap.x * k,
			y: ap.y * k,
			z: floorZ.get(ap.floorId) ?? 0,
			interferenceRadius: ap.interferenceRadius * k
		};
	});
}

// 鈹€鈹€鈹€ Decoded wall mask cache (per floor) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * The cache lives in `floor-mask.ts` now: the optimiser's payload needs it too,
 * and while it lived here `optimizer.svelte.ts` had to import this module, which
 * is the wrong way round once the solver needs the optimiser's margin pass to
 * build its conflict graph (see `buildAssignmentConflictEdges`). Re-exported so
 * every existing importer keeps working.
 */
export {
	getFloorMask,
	invalidateSolverMaskCache,
	type DecodedFloorMask
} from './floor-mask.js';
import { apState, wupmForFloor } from '$state/ap-state.svelte.js';
import { scaleBetween } from './floor-scale.js';
import { projectMeta } from '$state/project-meta.svelte.js';


// 鈹€鈹€鈹€ Attenuation helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/** Floor-by-ID lookup, built once per solve. */
let floorByIdCache = new Map<string, (typeof floorState.floors)[0]>();

function prepareSortedFloors(): void {
	floorByIdCache = new Map(floorState.floors.map((f) => [f.id, f]));
}

/** Wall attenuation between two APs on the same floor: one flat figure per crossing,
 *  out of the material table, exactly as the objective and the heatmap charge it. */
function getWallLoss(
	mask: DecodedFloorMask,
	ax: number,
	ay: number,
	bx: number,
	by: number,
	defaultMaterial: number,
	wupm: number,
	band: Band
): number {
	const matDb = getMaterialDbTable(band);
	const defaultDb = getFlatAttenuation(defaultMaterial as WallMaterialId, band) || 5;
	// Convert world coords to mask-local for ray march
	const ox = mask.originX ?? 0;
	const oy = mask.originY ?? 0;
	return rayMarchWallAtten(
		mask.wallData,
		mask.width,
		mask.height,
		mask.materialMap,
		matDb,
		defaultDb,
		ax - ox,
		ay - oy,
		bx - ox,
		by - oy,
		3,
		defaultMaterial
	);
}

// 鈹€鈹€鈹€ Graph building 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * What must not share a channel, and how strong each pair's coupling is.
 *
 * Two products, deliberately separate:
 *
 * - **The edges** are the optimiser's own conflict graph, asked for through
 *   `buildAssignmentConflictEdges`: a pair is an edge when, at some sample, one of
 *   them is the best server and the other is within `COCHANNEL_REUSE_DB` of it.
 *   The solver used to build its own graph here 鈥?circle overlap plus an AP-to-AP
 *   distance heuristic, `1/(1+r鈦?` filtered at a CCI threshold 鈥?which is a
 *   *different* question, and on the measured four-AP floor the two disagreed: the
 *   assignment that graph produced scored 14.75% on the objective's graph while a
 *   proper colouring of that graph scored 0%. Colouring what the objective
 *   measures is the only way the figure in the panel can describe the plan on
 *   screen.
 * - **`edgeSignals`** stays as it was: an attenuated coupling figure per pair, for
 *   the AP editor's readout and the throughput estimate. It is a *display and
 *   throughput* input, not a conflict criterion, so it keeps its own definition 鈥?
 *   and it is now filled for every pair, because the pairs the old filter dropped
 *   are exactly the ones whose signal a user may still want to see.
 *
 * Falls back to the old geometric graph when the optimiser cannot build one (no
 * enclosed interior to sample: walls that do not close, or a plan with none at
 * all). Auto-assignment still has to do something sensible there, and a plan with
 * no interior is still a plan with APs on it.
 */
async function buildSerializedGraph() {
	/*
	 * The graph is a function of the plan, so it is cached against the plan.
	 *
	 * Building it means running the optimiser's own margin pass over a fine sample grid 鈥?
	 * measured at 344鈥?12 ms on a two-AP floor 鈥?and an auto-solve is scheduled on every
	 * change of the key. When nothing about the geometry changed, rebuilding it produced the
	 * same adjacency for half a second of blocked main thread. See `graphSignature`.
	 */
	const signature = graphSignature();
	if (lastGraph && lastGraph.signature === signature) return lastGraph.graph;
	const graph = await buildGraphUncached();
	lastGraph = { signature, graph };
	return graph;
}

async function buildGraphUncached() {
	prepareSortedFloors();
	edgeSignals.clear();
	const aps = getApPositions();
	const apMap = new Map(apState.aps.map((ap) => [ap.id, ap]));

	// Pre-decode wall masks for floors that have APs (parallel decode)
	const apFloorIds = new Set(apState.aps.map((ap) => ap.floorId));
	const maskPromises = [...apFloorIds].map(async (fid) => [fid, await getFloorMask(fid)] as const);
	const masks = new Map(await Promise.all(maskPromises));

	// Build z-position lookup for O(1) access in the loop
	const apZMap = new Map(aps.map((a) => [a.id, a.z ?? 0]));

	// Coupling figure for every pair, whatever the conflict graph says. Computed
	// first and unconditionally: it feeds the AP editor and the throughput model,
	// and both want the number for pairs that are not edges.
	for (let i = 0; i < aps.length; i++) {
		for (let j = i + 1; j < aps.length; j++) {
			const apA = aps[i]!;
			const apB = aps[j]!;
			const entityA = apMap.get(apA.id);
			const entityB = apMap.get(apB.id);
			if (!entityA || !entityB) continue;

			let totalDb = 0;
			if (entityA.floorId === entityB.floorId) {
				// Same floor: wall attenuation
				const mask = masks.get(entityA.floorId);
				if (mask) {
					// Use wallState for current floor (always up-to-date), floor entity for others
					const defMat =
						entityA.floorId === floorState.currentFloorId
							? wallState.wallMaterial
							: (floorByIdCache.get(entityA.floorId)?.wallMaterial ?? 0);
					totalDb = getWallLoss(
						mask,
						entityA.x,
						entityA.y,
						entityB.x,
						entityB.y,
						defMat,
						// The mask is this floor's, in this floor's pixels.
						wupmForFloor(entityA.floorId),
						entityA.band as Band
					);
				}
			} else {
				// Cross-floor: slab attenuation (use worst-case band for conservative estimate)
				totalDb = getFloorSlabAttenuation(entityA.floorId, entityB.floorId, entityA.band as Band);
			}

			// Attenuated signal between this AP pair. Inverse-quartic in distance,
			// then the wall/slab loss as a power factor.
			const dx = apA.x - apB.x;
			const dy = apA.y - apB.y;
			const dz = (apZMap.get(apA.id) ?? 0) - (apZMap.get(apB.id) ?? 0);
			const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
			const r = Math.max(entityA.interferenceRadius, entityB.interferenceRadius);
			const ratio = dist / r;
			const r4 = ratio * ratio * ratio * ratio;
			const signal = 1 / (1 + r4);
			const attenFactor = totalDb > 0 ? Math.pow(10, -totalDb / 10) : 1;
			edgeSignals.set([apA.id, apB.id].sort().join(':'), signal * attenFactor);
		}
	}

	const graph = await buildAssignmentConflictEdges();
	let conflicting: Array<[string, string]>;
	/** What each conflicting pair costs. See `buildAssignmentConflictEdges`. */
	let conflictWeights: Map<string, number>;
	if (graph.complete) {
		conflicting = graph.edges;
		conflictWeights = graph.weights;
	} else {
		// No interior to sample. Fall back to circle overlap for the pairs the old
		// filter kept, so a plan whose walls do not close still gets channels.
		console.warn(
			'[solver] no enclosed interior to build a conflict graph from; ' +
				'falling back to circle overlap. Coverage and interference are not ' +
				'measurable on this plan until the walls close.'
		);
		const { edges } = buildInterferenceGraph(aps);
		conflicting = edges
			.filter((edge) => (edgeSignals.get([edge.a, edge.b].sort().join(':')) ?? 0) >= 0.005)
			.map((edge) => [edge.a, edge.b] as [string, string]);
		// The fallback graph has no sample counts behind it, so every edge weighs the
		// same 鈥?which is exactly the unweighted behaviour.
		conflictWeights = new Map();
	}

	// Convert to adjacency list format for the worker
	const nodes = aps.map((ap) => ap.id);
	const adjacency = new Map<string, string[]>();
	for (const node of nodes) {
		adjacency.set(node, []);
	}
	for (const [a, b] of conflicting) {
		adjacency.get(a)?.push(b);
		adjacency.get(b)?.push(a);
	}

	return {
		nodes,
		edges: Array.from(adjacency.entries()),
		// What each edge costs, carried out with the graph: the colourers below need it
		// to know which conflict to leave standing. See `buildAssignmentConflictEdges`.
		weights: conflictWeights
	};
}

/**
 * The widest channel width in use on a band, which is what a non-overlapping palette
 * has to be built from: a set that does not overlap at 80 MHz does not overlap at 20
 * either. See `planningChannels`.
 */
function widestWidthOn(band: Band): ChannelWidth {
	const widths = apState.aps.filter((ap) => ap.band === band).map((ap) => ap.channelWidth);
	return (widths.length > 0 ? Math.max(...widths) : 20) as ChannelWidth;
}

/** Channels the planner may assign on a band: non-overlapping, so `number_a === number_b` means "interferes". */
function planningChannelNumbers(band: Band): number[] {
	return planningChannels(band, apState.regulatoryDomain, widestWidthOn(band)).map(
		(ch) => ch.number
	);
}

function getColorOptions(): number[] {
	// Use the most common band among APs, falling back to project default
	const bandCounts = new Map<string, number>();
	for (const ap of apState.aps) {
		bandCounts.set(ap.band, (bandCounts.get(ap.band) ?? 0) + 1);
	}
	let primaryBand = apState.band;
	let maxCount = 0;
	for (const [band, count] of bandCounts) {
		if (count > maxCount) {
			maxCount = count;
			primaryBand = band as typeof apState.band;
		}
	}
	return planningChannelNumbers(primaryBand);
}

function getFixedAssignments(): [string, number][] {
	const fixed: [string, number][] = [];
	for (const ap of apState.aps) {
		if (ap.fixedChannel !== null) {
			fixed.push([ap.id, ap.fixedChannel]);
		}
	}
	return fixed;
}

function applyAssignments(assignment: Map<string, number>): void {
	for (const [apId, channel] of assignment) {
		updateAp(apId, { assignedChannel: channel });
	}
	/*
	 * The interference figure is measured over the channels the plan actually has, so it has to
	 * be re-measured when they change.
	 *
	 * It used to keep whatever the optimiser run reported, which was measured under the
	 * colouring the *worker* chose for that layout 鈥?a different assignment from the one applied
	 * here, because the worker may colour with the whole band while this hands out the
	 * non-overlapping palette. On a plan with more access points than channels the figure read
	 * 0% while two units shared one. See `optimizer-coverage.svelte.ts`.
	 */
	void updateCoverage();
}

function computeThroughput(): void {
	const inputs: ThroughputInput[] = apState.aps.map((ap) => {
		// Use real attenuated signal from edgeSignals (computed during graph build
		// with wall + floor attenuation), not geometric overlap
		const coChannelOverlaps: number[] = [];
		for (const other of apState.aps) {
			if (other.id === ap.id) continue;
			if (other.assignedChannel !== ap.assignedChannel || ap.assignedChannel === null) continue;
			const pairKey = [ap.id, other.id].sort().join(':');
			const signal = edgeSignals.get(pairKey);
			if (signal !== undefined && signal > 0) {
				coChannelOverlaps.push(signal);
			}
		}
		// Look up model specs for accurate PHY rate
		const model = ap.modelId ? findModel(ap.modelId) : null;
		const bandSpec = model?.bands.find((b) => b.band === ap.band);
		return {
			apId: ap.id,
			band: ap.band,
			channelWidth: ap.channelWidth,
			assignedChannel: ap.assignedChannel,
			coChannelOverlaps,
			wifiStandard: model?.wifiStandard,
			streams: bandSpec?.streams
		};
	});

	solverState.throughputEstimates = estimateThroughput(inputs, {
		ispSpeed: projectMeta.ispSpeed,
		targetThroughput: projectMeta.targetThroughput
	});
}

export async function runSolver(): Promise<void> {
	if (apState.aps.length === 0) return;
	if (solverState.isRunning) return;

	solverState.isRunning = true;
	solverState.error = null;
	const started = performance.now();

	try {
		const graph = await buildSerializedGraph();
		const fixedAssignments = getFixedAssignments();
		debug(`[solve] graph built in ${Math.round(performance.now() - started)} ms`);

		// Solve each band independently 鈥?different bands don't interfere
		const bands = new Set(apState.aps.map((ap) => ap.band));
		const mergedAssignment = new Map<string, number>();
		let totalConflicts: [string, string][] = [];
		let totalColors = 0;
		let totalTime = 0;

		for (const band of bands) {
			const bandApIds = new Set(
				apState.aps.filter((ap) => ap.band === band).map((ap) => ap.id)
			);
			// Filter graph to only this band's APs
			const bandNodes = graph.nodes.filter((id) => bandApIds.has(id));
			const bandEdges = graph.edges
				.filter(([id]) => bandApIds.has(id))
				.map(
					([id, neighbors]) => [id, neighbors.filter((n) => bandApIds.has(n))] as [string, string[]]
				);

			const availableColors = planningChannelNumbers(band as Band);
			const bandFixed = fixedAssignments.filter(([id]) => bandApIds.has(id));

			const result = await bridge.solve(
				{ nodes: bandNodes, edges: bandEdges },
				{
					algorithm: solverState.algorithm,
					availableColors,
					fixedAssignments: bandFixed.length > 0 ? bandFixed : undefined,
					timeout: 5000
				}
			);

			// Two passes over the worker's colouring, both app-side because the worker
			// only knows channel *numbers*:
			//
			// 1. `widenAssignment` moves any source that shares spectrum with something
			//    it conflicts with onto a clearer centre. With a non-overlapping palette
			//    that only happens when the palette ran out 鈥?more mutually conflicting
			//    APs than channels 鈥?and the band may still hold a narrower centre that
			//    is genuinely clear of everything this source conflicts with. That is
			//    the case B3's palette approximation used to get wrong.
			// 2. `balanceAssignment` spreads the palette over what the graph leaves free,
			//    because a greedy colourer puts a whole band on channel 1 and those
			//    channels are not equivalent for airtime.
			//
			// Neither can create interference: both only ever move onto a candidate with
			// no overlap against the neighbours that matter.
			const bandIndex = new Map(bandNodes.map((id, i) => [id, i]));
			const neighbours = new Map(bandEdges);
			const pinnedIds = new Set(bandFixed.map(([id]) => id));
			const adjacency = bandNodes.map((id) =>
				(neighbours.get(id) ?? [])
					.map((n) => bandIndex.get(n))
					.filter((n): n is number => n !== undefined)
			);
			// Named `bandNames`, not `bands`: the outer loop iterates a `Set` called
			// `bands`, and shadowing it inside the body worked only because the loop head
			// is evaluated before the body's binding exists 鈥?a trap for the next edit.
			const bandNames = bandNodes.map(() => band as string);
			const widths = bandNodes.map(
				(id) => apState.aps.find((ap) => ap.id === id)?.channelWidth ?? 20
			);
			const overlap = makeOverlapLookup(bandNames, widths);
			// The graph's weights, in this band's own index space, so the widening pass
			// can tell a cheap shared channel from an expensive one. Zero where the two
			// do not conflict at all, which is every pair it is not an edge for.
			const weightMatrix = new Float32Array(bandNodes.length * bandNodes.length);
			for (let i = 0; i < bandNodes.length; i++) {
				for (const j of adjacency[i] ?? []) {
					const key = [bandNodes[i]!, bandNodes[j]!].sort().join(':');
					weightMatrix[i * bandNodes.length + j] = graph.weights.get(key) ?? 0;
				}
			}
			const pinnedFlags = bandNodes.map((id) => pinnedIds.has(id));
			const candidates = bandNodes.map((id) => {
				const ap = apState.aps.find((a) => a.id === id);
				// A pin is a single-element list, exactly as in the worker's colourer.
				if (!ap || ap.fixedChannel !== null) return [ap?.fixedChannel ?? availableColors[0]!];
				return planningCandidates(
					ap.band,
					apState.regulatoryDomain,
					ap.channelWidth
				).map((ch) => ch.number);
			});
			const order = bandNodes.map((id) => result.assignment.get(id) ?? availableColors[0]!);
			const widened = widenAssignment(order, adjacency, candidates, overlap, pinnedFlags, weightMatrix);
			// Balance over the palette alone, as before: the widened candidates are for
			// escaping a forced overlap, not for spreading traffic up the band.
			const spread = balanceAssignment(
				widened,
				adjacency,
				bandNodes.map(() => availableColors),
				pinnedFlags,
				overlap
			);
			bandNodes.forEach((id, i) => mergedAssignment.set(id, spread[i]!));
			for (const [id, ch] of result.assignment) {
				// Pinned APs keep exactly what the worker was told to keep.
				if (pinnedIds.has(id)) mergedAssignment.set(id, ch);
			}
			totalConflicts = [...totalConflicts, ...result.conflicts];
			totalColors += result.colorCount;
			totalTime += result.timeMs;
		}

		solverState.lastResult = {
			assignment: mergedAssignment,
			colorCount: totalColors,
			conflicts: totalConflicts,
			timeMs: totalTime
		};
		solverState.lastTiming = totalTime;
		clearAssignments();
		applyAssignments(mergedAssignment);
		apState.aps = [...apState.aps];
		// The assignment is part of the project, so it has to be persisted like any
		// other change to it. It used to be written to state and never saved: the only
		// save in flight when the automatic solver ran was the one the *optimiser* had
		// scheduled for its new positions, 2 s earlier 鈥?so the file that landed
		// carried the channels the solver had computed for the *previous* positions
		// whenever the solve had not finished inside that window. Reloading such a
		// project showed different channels than the session had, and the stored
		// assignment could be improper on its own plan (measured: the same seeded run,
		// same positions, persisted 1, 6, 11, 1 on a loaded machine and 1, 6, 11, 11
		// idle 鈥?14.75% interference on the objective's graph against 0%). See
		// `ROADMAP.md` B6, whose "the two paths meet" claim the measurement checks.
		// `keep`: the solve is background work, so it must not push back a save the
		// user's own edit has already scheduled.
		scheduleSave(true);
		computeThroughput();
		debug(`[solve] done in ${Math.round(performance.now() - started)} ms`);
	} catch (err) {
		solverState.error = err instanceof Error ? err.message : 'Solver failed';
	} finally {
		solverState.isRunning = false;
	}
}

export async function runComparison(): Promise<void> {
	if (apState.aps.length === 0) return;
	if (solverState.isRunning) return;

	solverState.isRunning = true;
	solverState.error = null;

	try {
		const graph = await buildSerializedGraph();
		const availableColors = getColorOptions();
		const fixedAssignments = getFixedAssignments();

		const result = await bridge.compare(graph, {
			availableColors,
			fixedAssignments: fixedAssignments.length > 0 ? fixedAssignments : undefined,
			timeout: 5000
		});

		solverState.comparisonResults = result;

		// Apply the best result (fewest colors, fastest time)
		if (result.results.length > 0) {
			const best = result.results[0]!;
			solverState.lastResult = best;
			solverState.lastTiming = best.timeMs;
			solverState.algorithm = best.algorithm as Algorithm;
			clearAssignments();
			applyAssignments(best.assignment);
			apState.aps = [...apState.aps];
			// Same reason as in `runSolver`: the assignment is project state, and the
			// comparison's winning colouring used not to be saved at all.
			scheduleSave(true);
			computeThroughput();
		}
	} catch (err) {
		solverState.error = err instanceof Error ? err.message : 'Comparison failed';
	} finally {
		solverState.isRunning = false;
	}
}

