/**
 * The placement optimiser: the run, its worker, and the public entry points.
 *
 * The evaluator itself is in `workers/optimizer-worker.ts`; this module assembles one
 * floor’s payload, runs the search (possibly from several seeds), and commits the winner.
 * The shared state is in `optimizer-state.svelte.ts` and the real-time coverage estimate —
 * a different pass over a different evaluator — in `optimizer-coverage.svelte.ts`.
 *
 * The name and the exports are unchanged on purpose: everything that used to import
 * `optimizer.svelte.ts` still does, and this is the module that knows what the optimiser
 * *does* rather than where its numbers are kept.
 */
import { debug } from '$lib/log.js';
import { apHeightAboveFloor, apSplitFor, apVerticalOffsetTo, getEffectiveWupm } from './ap-state.svelte.js';
import type { Band, ChannelWidth } from '@aetherax/channels';
import { scheduleSave } from './persistence.svelte.js';
import { t } from './i18n.svelte.js';
import { buildRoomDomain } from '$canvas/rooms.js';
import type { SlabCrossing } from '$lib/rf/cross-floor.js';
import { isVoidRoomType } from '$canvas/room-types.js';
import { OptimizerBridge, type OptimizeProgress } from '../workers/optimizer-bridge.js';
import { floorState, getFloor, getFloorSlabAttenuation } from './floor-state.svelte.js';
import { getFloorMask } from './floor-mask.js';
import { projectMeta } from './project-meta.svelte.js';
import { WALL_BAND_M, wallSnapForFloor } from './wall-snap.js';
import { minRoomRadiusWu } from './room-domain.js';
import { isUsablePlanningArea } from './planning-area.js';
import type { ApInput } from '../workers/optimizer-protocol.js';
import { apState } from '$state/ap-state.svelte.js';
import { coverageBasis, optimizerState, floorCoverage } from './optimizer-state.svelte.js';
import { applyPositions, applyPowers, buildDensityMap, crossingSlabsFor, localVerticalDropFor, powerLevelsFor, sourceFloorMaskFor, toApInput, type FloorOutcome, type FloorRunOptions } from './optimizer-support.js';



const bridge = new OptimizerBridge();

/**
 * A second worker, used only for conflict-graph requests.
 *
 * The two must not share one: `OptimizerBridge` rejects a request that is still
 * pending when the next one arrives ("Superseded"), which is right for runs of the
 * same kind — a new placement run should replace an old one — and wrong across
 * kinds. Auto-assignment asks for a graph on every AP move, so a solve landing
 * while a run was in flight would kill the run, and the user would see a click on
 * Optimize Placement do nothing but report "Superseded".
 */
const graphBridge = new OptimizerBridge();

/**
 * Set for the duration of a run, and aborted by `cancelOptimizer`.
 *
 * Cancellation used to be one `bridge.cancel()` and nothing else: the worker stopped the
 * request it was executing, `optimizeFloor` turned the rejection into `ok: false`, and every
 * loop above it read that as "this restart bought nothing" and carried on — so the remaining
 * restarts, floors and passes ran to completion and the panel kept saying it was running.
 *
 * One controller per run, so a cancel from the last run cannot stop the next one.
 */
let runAbort: AbortController | null = null;

/**
 * Run one floor's optimisation.
 *
 * `floorId` is explicit rather than read from `floorState.currentFloorId`
 * because the all-floor run optimises floors other than the one on screen. Every
 * per-floor input — wall mask, material mask, default material, wall
 * attenuation, room types, density overrides — is read from that floor rather
 * than from the `wallState` properties, which describe the current one.
 */
async function optimizeFloor(
	floorId: string,
	opts: FloorRunOptions = {},
	signal?: AbortSignal
): Promise<FloorOutcome> {
	const apply = opts.apply !== false;
	const floor = getFloor(floorId);
	const nothing: FloorOutcome = {
		floorId,
		coverage: 0,
		interference: 0,
		contention: 0,
		interferenceKnown: true,
		samples: 0,
		score: 0,
		ok: false,
		positions: []
	};

	if (apState.aps.length === 0) return nothing;
	// Asked before the expensive part — the mask decode, the density map and the payload
	// assembly — so a cancel does not spend one more floor's work to find out it was one.
	if (signal?.aborted) return nothing;
	/*
	 * The floor's geometry, from whichever model states it.
	 *
	 * A floor with drawn segments has its mask derived on the spot — the segments are the
	 * model, and this is the one accessor the worker's payload and the solver's graph both
	 * go through, so a floor that was never opened (and therefore has a stored mask from
	 * before its walls were drawn, or none at all) is optimised against its *segments*.
	 * The stored mask, when there is one, is only the frame.
	 */
	const hasWalls = (floor?.walls ?? []).length > 0;
	if (!floor || (!floor.wallMask && !hasWalls)) {
		// Only worth surfacing when it is the floor on screen; during an all-floor
		// run a floor that has no plan is simply skipped.
		if (floorId === floorState.currentFloorId) optimizerState.error = t('Load a floorplan first');
		return nothing;
	}

	try {
		const decodedFloor = await getFloorMask(floorId);
		if (!decodedFloor) return nothing;
		const mask = {
			width: decodedFloor.width,
			height: decodedFloor.height,
			originX: decodedFloor.originX,
			originY: decodedFloor.originY
		} as { width: number; height: number; originX: number; originY: number };
		const curFloorId = floorId;

		// The wall mask is indexed from (originX, originY) in world space, not from
		// zero: TiledMask materialises on a 256 px tile lattice which can extend
		// into negative coordinates. Everything handed to the worker must be
		// shifted into mask-local space, and everything coming back shifted out.
		// The heatmap already does this; the optimiser did not, so its results were
		// offset from the geometry the canvas draws by exactly this amount.
		const originX = mask.originX ?? 0;
		const originY = mask.originY ?? 0;

		// Only optimize APs on the current floor (or all APs if single floor)
		const singleFloor = floorState.floors.length === 1;
		const onThisFloor = apState.aps.filter((ap) => singleFloor || ap.floorId === curFloorId);
		/*
		 * A **pinned** AP is not the optimiser's to move. It is handed over as a fixed
		 * source instead — the same shape another floor's AP arrives in, minus the slab
		 * crossing — so it still serves clients, is still scored, and is still coloured;
		 * it simply keeps its place. Everything else is a movable AP, wall mounts
		 * included: their domain is the band along the walls (`wallBandWu` below).
		 */
		const pinnedAps = onThisFloor.filter((ap) => ap.pinned);
		const localAps: ApInput[] = onThisFloor
			.filter((ap) => !ap.pinned)
			.map((ap) => toApInput(ap, { originX, originY, floorId: curFloorId }));

		if (localAps.length === 0) {
			if (floorId === floorState.currentFloorId) {
				optimizerState.error =
					pinnedAps.length > 0
						? t(
								'Every access point on this floor is pinned in place: there is nothing for the optimiser to move.'
							)
						: t('No APs on this floor');
			}
			return nothing;
		}

		// Virtual APs from other floors — fixed signal sources (not moved)
		const fixedAps: Array<{
			/** Carried so a graph request can name both ends of an edge. */
			id: string;
			x: number;
			y: number;
			interferenceRadius: number;
			signalScale: number;
			/** Vertical distance to this floor, in world units. */
			verticalGap: number;
			/** This AP's antenna cuts. See `ApInput.beamwidthDeg` in the worker. */
			beamwidthDeg: number;
			aimDeg: number;
			mount: string;
			facingDeg: number;
			band: Band;
			/** Channel of this AP, or null. Read by the interference term. */
			assignedChannel: number | null;
			/** Pinned channel, if the user set one. A constraint on the colouring. */
			fixedChannel: number | null;
			/** Channel width, for the non-overlapping palette. See `planningChannels`. */
			channelWidth: ChannelWidth;
			source?: {
				data: Uint8Array;
				width: number;
				height: number;
				materialMask: Uint8Array | null;
				defaultMaterial: number;
				originX: number;
				originY: number;
			} | null;
			sourceT?: number;
			targetT?: number;
			/** Every storey boundary this path crosses; empty when none can be tested. */
			slabs: SlabCrossing[];
		}> = [];
		const wupmForGap = getEffectiveWupm();
		/*
		 * This floor's pinned APs, as fixed sources.
		 *
		 * A same-floor path crosses no slab, so these carry no `source`, no `slabs` and a
		 * `signalScale` of 1 — the shape a local AP has in the coverage pass, with the one
		 * difference that the worker may not move it. The colourer still sees it, because
		 * a pinned AP competes for airtime exactly like any other.
		 */
		for (const ap of pinnedAps) {
			fixedAps.push({
				// The same fields, from the same mapper the movable APs use, plus the ones
				// that only a fixed source carries: a slab factor of 1 (a same-floor path
				// crosses nothing) and no wall-split data.
				...toApInput(ap, { originX, originY, floorId: curFloorId }),
				signalScale: 1,
				slabs: []
			});
		}
		// Decoded before the loop: the slab check needs this floor's own room types
		// when the AP is the lower of the two floors.
		const densityResult = await buildDensityMap(mask.width, mask.height, floor);
		for (const otherFloor of floorState.floors) {
			if (otherFloor.id === curFloorId) continue;
			const otherAps = apState.aps.filter((ap) => ap.floorId === otherFloor.id);
			if (otherAps.length === 0) continue;
			// Decoded once per other floor, not once per AP: the ray split needs the
			// AP's own floor's walls, and a PNG decode per AP would be absurd.
			const source = await sourceFloorMaskFor(otherFloor.id, originX, originY);
			// A void is a hole in a slab, so the ray pays that boundary's share of the
			// aggregate loss less. Every boundary the path crosses is tested at its
			// own crossing point, so a two-storey atrium waives one of the two rather
			// than all or nothing.
			//
			// Per band, because the shares are built from the slab loss and that is band
			// dependent — concrete reads 75 dB/m at 2.4 GHz and 100 at 5 GHz. Per mount
			// height too, because the ray's slope decides which planes it meets and
			// where. Building them once from the first AP would charge every other AP
			// that AP's geometry, and make the result depend on the order of the list.
			const slabsByKey = new Map<string, SlabCrossing[]>();
			// The vertical gap and the split are per AP for the same reason: an AP on
			// a desk is lower than one on the ceiling, and the two are not the same
			// distance from the client.
			for (const ap of otherAps) {
				const apHeightM = apHeightAboveFloor(ap);
				const key = `${ap.band}|${apHeightM}`;
				if (!slabsByKey.has(key)) {
					slabsByKey.set(
						key,
						(await crossingSlabsFor(
							otherFloor.id,
							curFloorId,
							projectMeta.clientHeight,
							ap.band,
							originX,
							originY,
							densityResult?.roomTypeData ?? null,
							apHeightM
						)) ?? []
					);
				}
			}
			for (const ap of otherAps) {
				const key = `${ap.band}|${apHeightAboveFloor(ap)}`;
				const split = apSplitFor(ap, curFloorId, projectMeta.clientHeight);
				const slabDb = getFloorSlabAttenuation(curFloorId, otherFloor.id, ap.band);
				fixedAps.push({
					id: ap.id,
					x: ap.x - originX,
					y: ap.y - originY,
					interferenceRadius: ap.interferenceRadius,
					signalScale: Math.pow(10, -slabDb / 10),
					verticalGap:
						apVerticalOffsetTo(ap, curFloorId, projectMeta.clientHeight) * wupmForGap,
					// A fixed AP's pattern counts as much as a placed one's: it is what
					// says an AP on the storey above reaches the floor below better out
					// to the side than straight down — and a wall-mounted one on that
					// storey has a front and a back on this floor too.
					beamwidthDeg: ap.beamwidthDeg,
					aimDeg: ap.aimDeg,
					mount: ap.mount,
					facingDeg: ap.facingDeg,
					band: ap.band,
					assignedChannel: ap.assignedChannel,
					fixedChannel: ap.fixedChannel,
					channelWidth: ap.channelWidth,
					source,
					sourceT: split.sourceT,
					targetT: split.targetT,
					slabs: slabsByKey.get(key) ?? []
				});
			}
		}

		/*
		 * The mask itself, already decoded: `getFloorMask` either derived it from the
		 * segments or decoded the stored PNG, so there is no second decode here — and the
		 * geometry the worker receives is the same one every other consumer reads.
		 */
		const decoded = { data: decodedFloor.wallData, width: decodedFloor.width, height: decodedFloor.height };

		// Material-aware wall loss: the per-pixel material map on this floor's own grid,
		// so the worker applies each material's per-crossing attenuation for the band.
		const materialMask = decodedFloor.materialMap;

		// Graph request: hand the worker the same payload a run would get and take
		// back the conflict graph, so the solver colours exactly what the objective
		// will afterwards measure. Everything above this line — the mask-local
		// positions, the cross-floor fixed APs and their splits, the density map —
		// is the assembly a real run uses, which is the point: a graph built from a
		// second, parallel construction is how the two criteria drifted apart.
		if (opts.graphOnly) {
			const graphResult = await graphBridge.optimize(
				localAps,
				decoded.data,
				mask.width,
				mask.height,
				floor.wallAttenuation,
				{
					fixedAps,
					densityMap: densityResult?.map ?? null,
					medianDensity: densityResult?.medianDensity ?? 0,
					materialMask,
					roomTypeMask: densityResult?.roomTypeData ?? null,
					defaultMaterial: floor.wallMaterial,
					metersPerPixel: 1 / getEffectiveWupm(),
					allowOutside: projectMeta.allowOutsideRooms,
					regulatoryDomain: apState.regulatoryDomain,
					coverageSoftnessDb: projectMeta.coverageSoftnessDb,
					pathLossScenario: projectMeta.pathLossScenario,
					// The graph the solver colours is built from the same margins the run
					// will score, so the geometry a client's height depends on belongs here
					// too — otherwise the two disagree exactly where a mezzanine is.
					surfaces: (floor.surfaces ?? []).map((surface) => ({
						ax: surface.ax - originX,
						ay: surface.ay - originY,
						bx: surface.bx - originX,
						by: surface.by - originY,
						heightM: surface.heightM,
						topHeightM: surface.topHeightM
					})),
					graphOnly: true
				}
			);
			if (graphResult.error) {
				if (floorId === floorState.currentFloorId) optimizerState.error = graphResult.error;
				return nothing;
			}
			return {
				...nothing,
				ok: true,
				samples: graphResult.sampleCount ?? 0,
				graph: graphResult.graph,
				// The worker's source order: this floor's APs, then the fixed APs.
				sourceIds: [...localAps.map((a) => a.id), ...fixedAps.map((f) => f.id ?? '')]
			};
		}

		const result = await bridge.optimize(
			localAps,
			decoded.data,
			mask.width,
			mask.height,
			floor.wallAttenuation,
			{
				fixedAps,
				densityMap: densityResult?.map ?? null,
				medianDensity: densityResult?.medianDensity ?? 0,
				materialMask,
				roomTypeMask: densityResult?.roomTypeData ?? null,
				defaultMaterial: floor.wallMaterial,
				metersPerPixel: 1 / getEffectiveWupm(),
				allowOutside: projectMeta.allowOutsideRooms,
				// B4: power is a decision variable, offered as reductions from each AP's
				// configured maximum. The pass can only lower it — raising it would
				// invent a capability the user did not configure — and only when the
				// exact objective strictly improves, so an AP whose power buys nothing
				// keeps it. See `refinePower`.
				powerLevelsDbm: localAps.map((ap) =>
					powerLevelsFor(apState.aps.find((a) => a.id === ap.id)?.power ?? 20)
				),
				worldUnitsPerMeter: getEffectiveWupm(),
				// The drop a same-floor path has and the path loss deliberately ignores. The
				// wall march cannot ignore it: it charges the material the ray walks through.
				localVerticalDrop: localVerticalDropFor(floor),
				// The band a wall-mounted AP is placed in, as a physical depth: the worker
				// indexes the mask in world units and has no calibration of its own. The
				// face itself is where `wallSnapForFloor` puts the AP afterwards.
				wallBandWu: WALL_BAND_M * getEffectiveWupm(),
				// What counts as a room, so the worker's placement domain agrees with the
				// app's own "is this point inside?" guard. See `room-domain.ts` — a domain
				// the two do not share is how an optimised AP ends up in a wall cavity.
				minRoomRadiusWu: minRoomRadiusWu(),
				/*
				 * The planning area, in the mask's own coordinates, when the user has drawn
				 * one. The worker clips its placement domain to it — the same clip the app's
				 * guard applies — so "draw the floor" reaches the optimiser as well as the
				 * warnings, and the two cannot disagree about where the floor is.
				 */
				planningArea: isUsablePlanningArea(floor.planningArea)
					? floor.planningArea!.map((point) => ({
							x: point.x - originX,
							y: point.y - originY
						}))
					: null,
				/*
				 * Raised surfaces, in the same mask frame as the planning area. The worker
				 * reads the client's height at each of its own samples from this, because
				 * a mezzanine changes a sample's vertical gap to every AP and it builds the
				 * sample grid itself.
				 */
				surfaces: (floor.surfaces ?? []).map((surface) => ({
					ax: surface.ax - originX,
					ay: surface.ay - originY,
					bx: surface.bx - originX,
					by: surface.by - originY,
					heightM: surface.heightM,
					topHeightM: surface.topHeightM,
					thicknessM: surface.thicknessM,
					attenuationDb: surface.attenuationDb
				})),
				// The user's own materials, so the worker charges their figures rather than the
				// built-in fallback for an id it has never seen.
				customMaterials: projectMeta.customMaterials.map((material) => ({
					id: material.id,
					name: material.name,
					dbPerMeter: {
						'2.4ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
						'5ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM),
						'6ghz': material.dbPerCrossing / Math.max(0.01, material.thicknessM)
					},
					typicalThickness: material.thicknessM,
					color: material.color
				})),
				// F3's ε-constraint. Zero means no constraint, which is the objective every
				// figure recorded before it was measured on. The per-floor switch changes who
				// the requirement is about, not how it is enforced: this block scores one
				// floor's samples, so the number here is always that floor's own.
				coverageFloor: (opts.floorPct ?? projectMeta.coverageFloorPct) / 100,
				onProgress: (p: OptimizeProgress) => {
					if (!apply) return; // a restart being scored is not the run on screen
					optimizerState.progress = Math.round((p.iteration / p.totalIterations) * 100);
					optimizerState.score = Math.round(p.score * 100);
				},
				seed: opts.seed,
				// One weight for the whole run, from the project settings, so a run
				// and its A/B twin differ in nothing else.
				interferenceWeight: projectMeta.interferenceWeight,
				// The objective's threshold: how far below the coverage threshold a
				// sample still earns utility. See `DEFAULT_COVERAGE_SOFTNESS_DB`.
				coverageSoftnessDb: projectMeta.coverageSoftnessDb,
				// The distance term's environment. The worker cannot read project state, so
				// every run carries it.
				pathLossScenario: projectMeta.pathLossScenario,
				// Handing the domain over is what makes the worker re-colour: it then
				// knows every band's channel list and every pin, so each layout it
				// scores is measured under its own best assignment rather than under
				// the assignment left over from before the search moved anything.
				regulatoryDomain: apState.regulatoryDomain
			}
		);

		// The worker reports a reason when it could not place anything (for
		// example no enclosed interior was detected). Surface it: without this the
		// user just sees the APs sitting where they were and no explanation.
		if (result.error) {
			if (floorId === floorState.currentFloorId) {
				optimizerState.error = result.error;
				optimizerState.progress = 0;
			}
			return nothing;
		}

		// The optimiser is stochastic, so record the seed it ran with. Without it
		// a different result on the next run is indistinguishable from a change
		// in the model, which makes before/after comparisons meaningless.
		debug(
			`[optimizer] seed ${result.seed}, score ${result.score.toFixed(4)}, improvement ${result.improvement.toFixed(2)}%` +
				`, coverage ${(result.coverage * 100).toFixed(1)}%` +
				`, co-channel interference ${((result.interference ?? 0) * 100).toFixed(1)}%` +
				`, contended (CCA) ${((result.contention ?? 0) * 100).toFixed(1)}%` +
				(result.channelsKnown === false ? ' (all-co-channel bound: no assignment yet)' : '') +
				(result.reverted ? ' — the search scored worse than its own input, input kept' : '')
		);
		// The ε-constraint's outcome, when one was set: a constraint the user set but
		// the run says nothing about is indistinguishable from one that was ignored.
		if (projectMeta.coverageFloorPct > 0) {
			const floor = projectMeta.coverageFloorPct;
			const covered = (result.coverage * 100).toFixed(1);
			debug(
				(result.shortfall ?? 0) > 0
					? `[optimizer] coverage floor ${floor}%, reached ${covered}% — short by ${((result.shortfall ?? 0) * 100).toFixed(1)} points`
					: `[optimizer] coverage floor ${floor}%, reached ${covered}% — met`
			);
		}
		// What the transmit-power pass decided, and why nothing changed when nothing
		// did. Reporting the *declined* case matters as much as the applied one: the
		// interference criterion compares levels *relative* to the best server, so
		// lowering power slides the band where two APs are within the reuse distance of
		// each other rather than narrowing it, and a cut that buys nothing is correctly
		// refused. Silence here would look like the pass did not run.
		{
			const powers = result.powers ?? [];
			const lowered = powers.filter((p) => {
				const ap = apState.aps.find((a) => a.id === p.id);
				return ap && p.power < ap.power;
			});
			if (powers.length === 0) {
				debug('[optimizer] transmit power: not offered to this run');
			} else if (lowered.length === 0) {
				debug(
					`[optimizer] transmit power: every level tested was a tie or worse, so all ` +
						`${powers.length} AP(s) keep their configured power`
				);
			} else {
				debug(
					`[optimizer] transmit power lowered on ${lowered.length} of ${powers.length} AP(s): ` +
						lowered.map((p) => `${p.id}→${p.power} dBm`).join(', ')
				);
			}
		}
		// The diagnostic that answers "this coverage number looks wrong": how big
		// is one AP's coverage circle compared with the floor it sits on? If the
		// radius is comparable to the whole plan, a high coverage figure is
		// arithmetic, not a bug — and an uncalibrated plan is the usual cause of a
		// radius that large.
		{
			const wupm = getEffectiveWupm();
			const floorAps = apState.aps.filter((a) => a.floorId === curFloorId);
			const maxRadius = floorAps.length
				? Math.max(...floorAps.map((a) => a.interferenceRadius))
				: 0;
			debug(
				`[optimizer] ${floorAps.length} AP(s) on this floor; largest coverage radius ` +
					`${(maxRadius / (wupm || 1)).toFixed(1)} m = ${maxRadius} world units at ${wupm} units/m`
			);
		}

		// Independently verify the result against the same interior the worker
		// used, and report the geometry when an AP lands outside it. The failure
		// mode this guards against is invisible otherwise: the optimiser reports
		// success and the APs simply sit somewhere unexpected.
		if (!projectMeta.allowOutsideRooms) {
			// Same domain the worker placed into, or this check would be comparing an AP
			// against a different interior from the one it was placed in — including which
			// regions count as rooms. See `canvas/rooms.ts`.
			const { interior: check } = buildRoomDomain(decoded.data, mask.width, mask.height, {
				minRegionRadius: minRoomRadiusWu(),
				trimWallAdjacent: true
			});
			// Mirror the worker's void exclusion, or a void reads as "AP landed
			// outside the interior" when the worker deliberately placed it there.
			const rtData = densityResult?.roomTypeData;
			if (rtData && rtData.length === check.length) {
				for (let i = 0; i < check.length; i++) {
					if (check[i] && isVoidRoomType(rtData[i]!)) check[i] = 0;
				}
			}
			let count = 0;
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -1;
			let maxY = -1;
			for (let i = 0; i < check.length; i++) {
				if (!check[i]) continue;
				count++;
				const x = i % mask.width;
				const y = (i / mask.width) | 0;
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
			const outside = result.positions.filter((p) => {
				// A wall-mounted AP is *meant* to be against a wall, and the trimmed
				// interior the check reads excludes exactly that ring. Its domain is the
				// band, which the worker enforced.
				const ap = apState.aps.find((a) => a.id === p.id);
				if (ap?.mount === 'wall') return false;
				const ix = Math.round(p.x);
				const iy = Math.round(p.y);
				if (ix < 0 || ix >= mask.width || iy < 0 || iy >= mask.height) return true;
				return check[iy * mask.width + ix] !== 1;
			});
			if (outside.length > 0) {
				optimizerState.error =
					`${outside.length} of ${result.positions.length} AP(s) ended up outside the detected interior. ` +
					`Mask is ${mask.width}x${mask.height}; interior covers ${count} px` +
					(count > 0 ? ` in [${minX},${minY}]-[${maxX},${maxY}]` : '') +
					`. See the console for details.`;
			}
		}

		// Optimized positions, shifted back out of mask-local space into world
		// coordinates and rounded, so they clearly differ from the originals and
		// trigger reactive updates.
		const worldPositions: Array<{ id: string; x: number; y: number; facingDeg?: number }> = [];
		for (const pos of result.positions) {
			const x = Math.round(pos.x) + originX;
			const y = Math.round(pos.y) + originY;
			/*
			 * The band is a *domain* rather than a placement, so a wall-mounted AP is put
			 * exactly on the wall face here — by the same measurement the editor uses when
			 * the mounting is chosen, which gives it the direction as well. What the
			 * optimiser leaves behind is then a position and a facing the user could have
			 * picked by hand, rather than a spot a bracket's depth off a wall.
			 */
			const ap = apState.aps.find((a) => a.id === pos.id);
			if (ap?.mount === 'wall') {
				const snap = await wallSnapForFloor(floorId, x, y, getEffectiveWupm());
				if (snap) {
					worldPositions.push({
						id: pos.id,
						x: Math.round(snap.apX),
						y: Math.round(snap.apY),
						facingDeg: Math.round(snap.facingDeg)
					});
					continue;
				}
			}
			worldPositions.push({ id: pos.id, x, y });
		}

		// A multi-start run scores several restarts before committing to one, so
		// applying is the caller's decision rather than a side effect of running.
		if (apply) {
			applyPositions(worldPositions);
			applyPowers(result.powers);
			optimizerState.score = Math.round(result.score * 100);
			scheduleSave();
		}

		return {
			floorId,
			coverage: result.coverage,
			interference: result.interference ?? 0,
			contention: result.contention ?? 0,
			interferenceKnown: result.channelsKnown ?? true,
			samples: result.sampleCount,
			score: result.score,
			ok: true,
			positions: worldPositions
		};
	} catch (err) {
		if (err instanceof Error && err.message === 'Cancelled') {
			// User cancelled - no error
		} else {
			optimizerState.error = err instanceof Error ? err.message : t('Optimization failed');
		}
		return nothing;
	}
}

/**
 * The conflict graph the automatic channel assignment must colour.
 *
 * Built one floor at a time through the optimiser's own payload and its own
 * margin pass (`fillMargins` in `optimizer-worker.ts`), so the edges the solver
 * sees are the edges the objective will afterwards measure against. That is the
 * whole point: the solver used to build its own graph from circle overlap plus an
 * AP-to-AP distance heuristic, and on the measured four-AP floor the two
 * disagreed — the solver's assignment scored 14.75% interference on the
 * objective's graph while a proper colouring of that same graph scored 0%.
 *
 * A floor whose graph cannot be built (no enclosed interior to sample, no
 * floorplan) is reported as `complete: false`, and the caller decides what to do;
 * this does not invent a graph it could not measure.
 *
 * Edges are undirected and named by AP id. A floor with no APs on it contributes
 * nothing: it is not a floor the optimiser ever scores, so including it would make
 * the assignment graph a different graph from the objective's again.
 */
export async function buildAssignmentConflictEdges(): Promise<{
	edges: Array<[string, string]>;
	/**
	 * What each edge costs, keyed as the edges are (`"a:b"` with the ids sorted).
	 *
	 * A pair that meets at one corner of a corridor and a pair whose whole served area
	 * overlaps are both edges, and the colourers had no way to tell them apart. This is
	 * the missing number: the density-weighted count of samples at which one source is
	 * within the reuse threshold of the other. See `conflictWeights`.
	 */
	weights: Map<string, number>;
	complete: boolean;
	floors: number;
	samples: number;
}> {
	const edges = new Map<string, [string, string]>();
	const weights = new Map<string, number>();
	let complete = true;
	let floors = 0;
	let samples = 0;
	const multiFloor = floorState.floors.length > 1;
	for (const floor of floorState.floors) {
		// Single-floor plans optimise every AP in one pass (see `optimizeFloor`), so
		// the first floor is the whole graph. Multi-floor plans are scored a floor at
		// a time, and a floor with no APs on it is never scored at all.
		if (multiFloor && !apState.aps.some((ap) => ap.floorId === floor.id)) continue;
		const outcome = await optimizeFloor(floor.id, { apply: false, graphOnly: true });
		if (!outcome.ok || !outcome.graph || !outcome.sourceIds) {
			complete = false;
			if (!multiFloor) break;
			continue;
		}
		floors++;
		samples += outcome.samples;
		const ids = outcome.sourceIds;
		const pairWeights = outcome.graph.weights;
		const count = outcome.graph.count;
		for (const [i, j] of outcome.graph.pairs) {
			const a = ids[i];
			const b = ids[j];
			if (!a || !b) continue;
			const key = [a, b].sort().join(':');
			edges.set(key, [a, b]);
			// A pair on two floors appears in both floors' graphs; the heavier reading
			// wins rather than the two being added, which would double-count the shared
			// samples between them.
			const w = pairWeights ? (pairWeights[i * count + j] ?? 0) : 1;
			weights.set(key, Math.max(weights.get(key) ?? 0, w));
		}
		if (!multiFloor) break;
	}
	return { edges: [...edges.values()], weights, complete, floors, samples };
}

/**
 * Guard and progress bookkeeping shared by the single-floor and all-floor runs.
 *
 * `isRunning` is set here rather than inside `optimizeFloor` because the
 * all-floor run calls that repeatedly — a guard down there would abort the run
 * on its second floor.
 */
async function withOptimizerRun(body: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
	if (optimizerState.isRunning) return;
	optimizerState.isRunning = true;
	optimizerState.progress = 0;
	optimizerState.score = 0;
	optimizerState.error = null;
	optimizerState.status = '';
	const abort = new AbortController();
	runAbort = abort;
	try {
		await body(abort.signal);
		// Stamped here rather than inside `body`, so it dates *any* completed run —
		// the single-floor button and the all-floor one alike. The placement advice
		// panel keys off this to know a fresh measurement exists to advise on. A
		// cancelled run is not one: it stopped wherever it had got to, and what it
		// left on the plan is not what the last figure describes.
		if (!abort.signal.aborted) optimizerState.lastRunAt = Date.now();
	} finally {
		if (runAbort === abort) runAbort = null;
		optimizerState.isRunning = false;
		optimizerState.status = '';
	}
}

/** Commit a floor's winning outcome and refresh the figures that describe it. */
function commitFloorOutcome(floorId: string, outcome: FloorOutcome): void {
	applyPositions(outcome.positions);
	optimizerState.score = Math.round(outcome.score * 100);
	// The panel's figure describes the floor on screen. During an alternating run
	// most floors are not that one, and writing their numbers here would label the
	// panel with the wrong storey.
	if (floorId === floorState.currentFloorId) {
		optimizerState.coverage = Math.round(outcome.coverage * 100);
		optimizerState.interference = Math.round(outcome.interference * 100);
		optimizerState.contention = Math.round(outcome.contention * 100);
		optimizerState.interferenceKnown = outcome.interferenceKnown;
		optimizerState.interferenceMeasured = true;
	}
	floorCoverage.set(floorId, {
		coverage: Math.round(outcome.coverage * 100),
		samples: outcome.samples,
		// The run measured this floor, so its figure describes the plan it just committed.
		basis: coverageBasis(floorId)
	});
	scheduleSave();
}

/**
 * Optimise one floor, optionally repeating from several seeds and keeping the
 * best.
 *
 * This is the cheapest improvement on the table. Oustry et al. (Networks 81(1),
 * 2023) report that merely *restarting* a greedy placer — their GH1 to GH2, a
 * mechanical change carrying no modelling content at all — gained 11% mean and
 * 6% median, against 7% mean and **0% median** for the far more expensive
 * business of alternating placement with channel assignment. In their results the
 * restart was worth more than the model. This optimiser is stochastic behind a
 * fixed seed, so repeating it from other seeds is the same trick.
 *
 * The spread across restarts is printed, not just the winner. It is the only
 * headroom measurement this project has, and without it a restart count is a
 * guess: if every restart lands on the same score the extra runs buy nothing, and
 * if they scatter, the search is leaving something on the table.
 *
 * Both entry points go through here, so a per-floor optimise means the same thing
 * whether it was asked for by the single-floor button or by the alternating run.
 */
async function optimizeFloorBest(
	floorId: string,
	restarts: number,
	apply: boolean,
	extra: FloorRunOptions = {},
	signal?: AbortSignal
): Promise<FloorOutcome | null> {
	const n = Math.max(1, Math.floor(restarts));

	if (n === 1) {
		const one = await optimizeFloor(floorId, { ...extra, apply }, signal);
		if (!one.ok) return null;
		if (apply) commitFloorOutcome(floorId, one);
		return one;
	}

	const scores: number[] = [];
	let best: FloorOutcome | null = null;
	for (let i = 0; i < n; i++) {
		if (signal?.aborted) break;
		optimizerState.status = t('Restart {index} of {count}', { index: i + 1, count: n });
		// Seeds are 1..n rather than random, so a multi-start run is exactly as
		// reproducible as a single-start one.
		const outcome = await optimizeFloor(floorId, { ...extra, seed: i + 1, apply: false }, signal);
		if (!outcome.ok) continue;
		scores.push(outcome.score);
		if (!best || outcome.score > best.score) best = outcome;
	}

	if (scores.length > 0) {
		const lo = Math.min(...scores);
		const hi = Math.max(...scores);
		const spread = lo > 0 ? ((hi - lo) / lo) * 100 : 0;
		debug(
			`[optimizer] ${scores.length} restarts: ${scores.map((s) => s.toFixed(4)).join(', ')}` +
				` — best ${hi.toFixed(4)}, spread ${spread.toFixed(2)}%`
		);
	}

	if (best && apply) commitFloorOutcome(floorId, best);
	return best;
}

/** Optimise the floor currently on screen. */
export async function runOptimizer(): Promise<void> {
	await withOptimizerRun((signal) =>
		optimizeFloorBest(floorState.currentFloorId, optimizerState.restarts, true, {}, signal)
	);
}

/**
 * Optimise every floor in turn, repeating until the building figure stops
 * improving.
 *
 * Floors go one at a time with the others held fixed — block coordinate descent.
 * Each pass leaves every floor at least as good as it was, so the sequence is
 * monotone and the run can stop when a pass stops gaining. There is no
 * convergence guarantee beyond that: the objective is not convex, and a later
 * pass may move APs to a different, equally good arrangement.
 *
 * The building figure is the density-weighted mean of the floors' covered-area
 * shares, weighted by the samples each floor contributed, so a small floor does
 * not count for as much as a large one.
 */
async function runAlternatingPasses(signal: AbortSignal): Promise<void> {
	const order = [...floorState.floors].sort((a, b) => a.level - b.level);
	const runnable = order.filter(
		(f) => f.wallMask && apState.aps.some((ap) => ap.floorId === f.id)
	);
	if (runnable.length === 0) {
		optimizerState.error = t('No floors with both a floorplan and APs to place');
		return;
	}

	/** Gain below which another pass is not worth the time it costs, as a fraction. */
	const MIN_GAIN = 0.002;
	/** Hard stop. Each pass is a full optimisation per floor, so this bounds the wait. */
	const MAX_PASSES = 4;

	let best = -1;
	let passes = 0;

	for (let pass = 1; pass <= MAX_PASSES; pass++) {
		if (signal.aborted) break;
		let weighted = 0;
		let weight = 0;
		const perFloor: Array<{ id: string; name: string; coverage: number }> = [];

		for (let i = 0; i < runnable.length; i++) {
			if (signal.aborted) break;
			const f = runnable[i]!;
			optimizerState.status = t('Pass {pass}/{total} · {floor} ({index}/{count})', {
				pass,
				total: MAX_PASSES,
				floor: f.name,
				index: i + 1,
				count: runnable.length
			});
			// The same per-floor path the single-floor button uses, so restarts apply
			// here too. The readout is refreshed by `commitFloorOutcome` from the very
			// figure the objective uses, so the panel and the run cannot disagree.
			const outcome = await optimizeFloorBest(
				f.id,
				optimizerState.restarts,
				true,
				{},
				signal
			);
			if (!outcome) continue;

			perFloor.push({ id: f.id, name: f.name, coverage: outcome.coverage });
			weighted += outcome.coverage * outcome.samples;
			weight += outcome.samples;
		}

		passes = pass;
		if (weight <= 0) break;
		const building = weighted / weight;
		optimizerState.buildingCoverage = Math.round(building * 100);

		// Name the weakest floor. Reported, never optimised for: a min-max objective
		// is far sharper to search and buys little, while the mean is what the
		// per-floor runs actually improve.
		if (perFloor.length > 0) {
			const worst = perFloor.reduce((a, b) => (b.coverage < a.coverage ? b : a));
			optimizerState.worstFloor = {
				id: worst.id,
				name: worst.name,
				coverage: Math.round(worst.coverage * 100)
			};
		}

		if (building - best < MIN_GAIN) break;
		best = building;
	}

	// A1's per-floor guarantee, as one extra block.
	//
	// The loop above names the weakest floor and never optimises for it, which is right for
	// the *objective* — min-max is far sharper to search and buys little on average — but it
	// means a floor can sit arbitrarily far below a requirement with nothing acting on it.
	// When the user asks for a per-floor floor, the weakest floor gets one more pass with
	// that floor as its own ε-constraint: the same F3 mechanism, on the one block that needs
	// it, with the others held where they are.
	//
	// One extra block rather than a constraint inside every block, on purpose: the constraint
	// has to be the *building's* weakest floor to mean anything, and inside a pass nobody
	// knows which floor that is until every floor has been scored.
	if (
		!signal.aborted &&
		projectMeta.coverageFloorEveryFloor &&
		projectMeta.coverageFloorPct > 0 &&
		optimizerState.worstFloor
	) {
		const worst = optimizerState.worstFloor;
		if (worst.coverage < projectMeta.coverageFloorPct) {
			const target = runnable.find((f) => f.id === worst.id);
			if (target) {
				debug(
					`[optimizer] per-floor floor: ${target.name} is at ${worst.coverage}%, below the ` +
						`${projectMeta.coverageFloorPct}% requirement — one more pass with it as the ε`
				);
				optimizerState.status = t('Per-floor floor · {floor}', { floor: target.name });
				const outcome = await optimizeFloorBest(
					target.id,
					optimizerState.restarts,
					true,
					{ floorPct: projectMeta.coverageFloorPct },
					signal
				);
				if (outcome) {
					optimizerState.worstFloor = {
						id: target.id,
						name: target.name,
						coverage: Math.round(outcome.coverage * 100)
					};
					debug(
						`[optimizer] per-floor floor: ${target.name} now at ${Math.round(outcome.coverage * 100)}%`
					);
				}
			}
		} else {
			debug(
				`[optimizer] per-floor floor: weakest floor is ${worst.name} at ${worst.coverage}%, ` +
					`at or above the ${projectMeta.coverageFloorPct}% requirement — no extra pass`
			);
		}
	}

	// A cancel stops here too: the figures the panel shows describe the plan on screen, and
	// a run that stopped half way has not finished producing them.
	if (signal.aborted) return;
	optimizerState.passes = passes;
	optimizerState.progress = 100;
	scheduleSave();
}

/** Optimise every floor, alternating until the building figure stops improving. */
export async function optimizeAllFloors(): Promise<void> {
	await withOptimizerRun((signal) => runAlternatingPasses(signal));
}

/**
 * Stop the run in flight.
 *
 * Three things, because cancellation lives at three levels: the worker that is searching,
 * the loops on this thread that would otherwise treat a cancelled floor as "this restart
 * bought nothing" and start the next one, and the graph request a run may be waiting on.
 */
export function cancelOptimizer(): void {
	runAbort?.abort();
	bridge.cancel();
	graphBridge.cancel();
}


// The public surface, unchanged: the state and the coverage pass used to live here and
// callers should not have to know which module a number moved to.
export { optimizerState, floorCoverage };
export { apsOutsideInterior, getBuildingCoverage } from './optimizer-state.svelte.js';
export { updateCoverage } from './optimizer-coverage.svelte.js';