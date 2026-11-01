import type { Band, ChannelWidth, RegulatoryDomain } from '@aetherax/channels';
import type { PathLossScenario } from '../rf/propagation.js';
import { OPTIMIZER_PAYLOAD_VERSION } from './optimizer-protocol.js';

export interface OptimizeResult {
	positions: Array<{ id: string; x: number; y: number }>;
	score: number;
	improvement: number;
	/**
	 * Set when the run could not do its job (for example no enclosed interior was
	 * detected). The positions are then the inputs, unchanged. Callers must
	 * surface this — silently keeping the old positions looks like the optimiser
	 * simply did nothing.
	 */
	error?: string;
	/**
	 * PRNG seed this run actually used. Pass it back through `options.seed` to
	 * repeat the run exactly — the optimiser is stochastic, so without this an
	 * A/B comparison of two model versions cannot be distinguished from noise.
	 */
	seed: number;
	/**
	 * Share of density-weighted floor area that is covered, on the same definition
	 * the coverage readout uses. Reported per floor so a multi-floor run can build
	 * a building-wide figure and name the weakest floor without a second
	 * implementation of that definition.
	 */
	coverage: number;
	/**
	 * Share of density-weighted floor area whose best server is degraded by a
	 * co-channel secondary within `COCHANNEL_REUSE_DB` of it. The complement of
	 * coverage in "quality" terms: the objective trades the two off. Absent on the
	 * error paths, which report no layout.
	 */
	interference?: number;
	/**
	 * Share of the floor where two APs on overlapping channels are both above the CCA
	 * threshold (≈ −82 dBm at 20 MHz): airtime the plan shares, whatever the
	 * signal-to-interference ratios are. Reported, not optimised — it is the half of
	 * "interference" a purely relative criterion cannot see. See `ROADMAP.md` B4/B5.
	 */
	contention?: number;
	/**
	 * How far below the ε-constraint's floor the chosen plan fell, as a 0-1 fraction.
	 * Zero when no floor was set, or when the floor was met. See
	 * `projectMeta.coverageFloorPct`.
	 */
	shortfall?: number;
	/**
	 * False when `interference` was measured against the all-co-channel bound
	 * because some AP has no channel yet. The figure is then an upper bound.
	 */
	channelsKnown?: boolean;
	/** How many samples the coverage figure came from, used to weight floors. */
	sampleCount: number;
	/**
	 * True when the search produced a layout scoring worse than its input on the
	 * exact evaluator, so the input was kept instead. Stages 1 and 2 optimise a
	 * grid-snapped approximation, so this does happen; without the guard the worse
	 * layout would be applied and the run would report a negative improvement.
	 */
	reverted: boolean;
	/**
	 * The conflict graph the payload's own positions imply, present only on a
	 * `graphOnly` request. Edge indices are the payload's sources in order — its
	 * `aps` first, then its `fixedAps` — so the caller can name both ends.
	 *
	 * The graph is the one the objective scores, built by the same margin pass
	 * (`fillMargins`), which is what lets the main-thread solver colour what the
	 * optimiser will afterwards measure. See `optimizer-worker.ts`.
	 */
	graph?: {
		pairs: Array<[number, number]>;
		count: number;
		/**
		 * How much each pair costs, row-major `count × count`, the same indexing as the
		 * pairs: the density-weighted number of samples at which one source is within
		 * the reuse threshold of the other. See `conflictWeights`.
		 */
		weights?: number[];
	};
	/**
	 * Transmit power the run settled on, per AP, when the caller offered power
	 * levels. See `refinePower`; a caller that applies positions must apply these
	 * too, or the plan it shows is not the one that was scored.
	 */
	powers?: Array<{ id: string; power: number; radius: number }>;
}

export interface OptimizeProgress {
	positions: Array<{ id: string; x: number; y: number }>;
	score: number;
	iteration: number;
	totalIterations: number;
}

/**
 * What the worker sends back.
 *
 * Every reply carries the id of the run that produced it. Before it did, the bridge resolved
 * whichever promise happened to be outstanding when a message arrived, so a run that outran
 * its cancellation delivered its layout into the next run's promise — and the layout came
 * back labelled with the next run's seed.
 */
type WorkerReply =
	| ({ type: 'progress'; runId: string } & OptimizeProgress)
	| ({ type: 'result'; runId: string } & OptimizeResult)
	| { type: 'cancelled'; runId: string }
	| { type: 'busy'; runId: string };

/** A request in flight, and who to tell when the worker answers. */
interface PendingRun {
	runId: string;
	resolve: (value: OptimizeResult) => void;
	reject: (reason: unknown) => void;
	onProgress: ((progress: OptimizeProgress) => void) | null;
}

export class OptimizerBridge {
	private worker: Worker | null = null;
	private pending: PendingRun | null = null;

	private getWorker(): Worker {
		if (!this.worker) {
			this.worker = new Worker(new URL('./optimizer-worker.ts', import.meta.url), {
				type: 'module'
			});
			this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
				const message = event.data;
				const pending = this.pending;
				/*
				 * A reply nobody is waiting for belongs to a run that has already been
				 * superseded or cancelled. Dropping it is the whole point of the id: the
				 * alternative was delivering one run's result to another run's caller.
				 */
				if (!pending || message.runId !== pending.runId) return;
				if (message.type === 'progress') {
					pending.onProgress?.(message);
					return;
				}
				if (message.type === 'cancelled') {
					pending.reject(new Error('Cancelled'));
				} else if (message.type === 'busy') {
					pending.reject(new Error('Another optimisation is still running'));
				} else {
					pending.resolve(message);
				}
				this.cleanup();
			};
			this.worker.onerror = (err) => {
				this.pending?.reject(err);
				this.cleanup();
			};
		}
		return this.worker;
	}

	private cleanup(): void {
		this.pending = null;
	}

	optimize(
		aps: Array<{
			id: string;
			x: number;
			y: number;
			interferenceRadius: number;
			band: Band;
			/** Channel from the solver, or null. Read by the interference term. */
			assignedChannel?: number | null;
			/** Pinned channel, if the user set one. A constraint on the colouring. */
			fixedChannel?: number | null;
			/** Channel width, for the non-overlapping palette. See `planningChannels`. */
			channelWidth?: ChannelWidth;
		}>,
		wallMask: Uint8Array,
		maskWidth: number,
		maskHeight: number,
		wallAttenuation: number,
		options?: {
			fixedAps?: Array<{
				x: number;
				y: number;
				interferenceRadius: number;
				signalScale: number;
				/** Channel of this AP, or null. Read by the interference term. */
				assignedChannel?: number | null;
				/** Pinned channel, if the user set one. A constraint on the colouring. */
				fixedChannel?: number | null;
				/** Channel width, for the non-overlapping palette. */
				channelWidth?: ChannelWidth;
				/** Vertical distance to the floor being optimised, in world units. */
				verticalGap: number;
				band: Band;
				/**
				 * The wall mask of the floor this AP sits on, when the optimised floor
				 * is a different one. The path is then split at the slab: the run from
				 * the AP to the crossing is charged against this mask, and the rest
				 * against the optimised floor's.
				 */
				source?: {
					data: Uint8Array;
					width: number;
					height: number;
					materialMask: Uint8Array | null;
					defaultMaterial: number;
					/** This mask's origin in the optimised floor's mask frame. */
					originX: number;
					originY: number;
				} | null;
				/** Fraction along the ray where it leaves the AP's own floor. */
				sourceT?: number;
				/** Fraction along the ray where it enters the optimised floor. */
				targetT?: number;
				/**
				 * Every storey boundary this path crosses, with the room types of the
				 * floor that owns each slab, in the optimised floor's mask frame, and
				 * the share of the aggregate slab loss charged at that boundary. A void
				 * there is a hole, and the ray pays that share less.
				 */
				slabs?: Array<{
					t: number;
					lossShare: number;
					roomTypes: Uint8Array | null;
					width: number;
					height: number;
					originX: number;
					originY: number;
				}> | null;
			}>;
			onProgress?: (progress: OptimizeProgress) => void;
			densityMap?: Float32Array | null;
			medianDensity?: number;
			materialMask?: Uint8Array | null;
			/**
			 * Raw room type ids. Carries the voids: a hole contributes no density,
			 * so it cannot be recovered from the density map.
			 */
			roomTypeMask?: Uint8Array | null;
			defaultMaterial?: number;
			metersPerPixel?: number;
			/** Default false: APs are constrained to the detected building interior. */
			allowOutside?: boolean;
			/** Omit for a random seed; the seed used is returned on the result. */
			seed?: number;
			/**
			 * Weight of the co-channel interference share in the objective. Zero
			 * scores coverage alone, which is the previous behaviour and the A/B
			 * switch for measuring what the term is worth.
			 */
			interferenceWeight?: number;
			/**
			 * When set, the worker colours each evaluated layout itself and scores the
			 * interference that remains *after* the best assignment of that layout,
			 * instead of the assignment the payload happened to carry. Pins
			 * (`fixedChannel`) and the band's channel list then come from here rather
			 * than from `assignedChannel`. Omit to score the payload's own assignment.
			 */
			regulatoryDomain?: RegulatoryDomain;
			/**
			 * How far below the coverage threshold a sample still earns utility, in
			 * dB. Zero is the hard threshold; see `DEFAULT_COVERAGE_SOFTNESS_DB`.
			 */
			coverageSoftnessDb?: number;
			/** ITU-R P.1238 environment for the distance term. */
			pathLossScenario?: PathLossScenario;
			/**
			 * Ask for the conflict graph of the payload's own positions instead of a
			 * placement. The result then carries `graph` and nothing is moved: this is
			 * how the main-thread solver gets the same edges the objective scores.
			 */
			graphOnly?: boolean;
			/**
			 * Transmit power levels each AP may be given, in dBm, descending, one list
			 * per AP in payload order. Omitted ⇒ power is not a decision variable.
			 * See `refinePower` in `optimizer-worker.ts`.
			 */
			powerLevelsDbm?: number[][];
			/** World units per metre, so a power level can be turned into a radius. */
			worldUnitsPerMeter?: number;
			/**
			 * Vertical drop of a same-floor path, in world units: `(ceilingHeight −
			 * clientHeight) × worldUnitsPerMetre`. Feeds the wall march's material-path
			 * factor — a ray descending through a wall crosses more material than its plan
			 * path (`PHYSICAL_MODELS.md` §B1). Omit to leave the walk uncorrected.
			 */
			localVerticalDrop?: number;
			/**
			 * How deep the band of floor along a wall is, in world units: the domain a
			 * wall-mounted AP is placed in. Omit for a run with no wall mounts, or when the
			 * default of four world units is close enough.
			 */
			wallBandWu?: number;
			/**
			 * Smallest inscribed radius an enclosed region may have and still be placed in,
			 * in world units. Omit to count every enclosed region, which is the behaviour
			 * before wall cavities were understood to be a placement bug — see
			 * `minRegionRadius` in `computeBuildingInterior`, and `room-domain.ts`.
			 */
			minRoomRadiusWu?: number;
			/**
			 * The planning area in mask coordinates, when the user has drawn one.
			 *
			 * The worker clips its placement domain to this, exactly as the app's own guard
			 * does, so the optimiser and the warnings answer "inside" from the same shape
			 * instead of from two independent guesses about the drawing.
			 */
			planningArea?: Array<{ x: number; y: number }> | null;
			/**
			 * Raised walking surfaces on this floor, in **mask coordinates**.
			 *
			 * The client's height above the slab is what its vertical gap to an AP is made
			 * of, so a mezzanine is a different set of margins from the floor underneath
			 * it. Sent as geometry rather than as a per-sample height array because the
			 * worker builds its own sample grid — the heights have to follow *that* grid,
			 * and only the worker knows where its samples are. See `rf/surface-height.ts`.
			 */
			surfaces?: Array<{
				ax: number;
				ay: number;
				bx: number;
				by: number;
				heightM: number;
				topHeightM: number;
				thicknessM?: number;
				attenuationDb?: number;
			}>;
			/**
			 * The user's custom wall materials, in the table's own shape.
			 *
			 * The worker registers them before it scores anything, so a wall painted with one
			 * costs the figure the user typed rather than the built-in fallback. Sent every
			 * run rather than cached, because the same worker instance serves several projects.
			 */
			customMaterials?: Array<{
				id: number;
				name: string;
				dbPerMeter: Record<string, number>;
				typicalThickness: number;
				color: [number, number, number];
			}>;
			/**
			 * ε-constraint (F3): the covered share the result must reach, as a 0-1
			 * fraction. Zero is no constraint.
			 */
			coverageFloor?: number;
		}
	): Promise<OptimizeResult> {
		const runId = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			const previous = this.pending;
			if (previous) {
				/*
				 * Superseded on purpose: tell the worker to stop the run it is executing, and
				 * stop waiting for it. Its replies are dropped by the id check rather than
				 * landing in this promise.
				 */
				this.pending = null;
				this.getWorker().postMessage({ type: 'cancel', runId: previous.runId });
				previous.reject(new Error('Superseded'));
			}
			this.pending = { runId, resolve, reject, onProgress: options?.onProgress ?? null };

			// Copy buffers so we can transfer them
			const maskCopy = new Uint8Array(wallMask);
			const densityCopy = options?.densityMap ? new Float32Array(options.densityMap) : null;
			const materialCopy =
				options?.materialMask != null ? new Uint8Array(options.materialMask) : null;
			const roomTypeCopy =
				options?.roomTypeMask != null ? new Uint8Array(options.roomTypeMask) : null;
			const transferable: ArrayBuffer[] = [maskCopy.buffer];
			if (densityCopy) transferable.push(densityCopy.buffer);
			if (materialCopy) transferable.push(materialCopy.buffer);
			if (roomTypeCopy) transferable.push(roomTypeCopy.buffer);

			// Cross-floor source masks. Copied rather than transferred in place: the
			// caller caches decoded masks per floor, so handing the buffer over would
			// neuter a cache entry that the next run still expects to read. Room-type
			// ids appear once per *floor* in the caller's data but once per *crossing*
			// here, so a floor a path crosses twice is copied twice — never shared,
			// because transfer detaches the buffer.
			const fixedAps = (options?.fixedAps ?? []).map((fap) => {
				const src = fap.source;
				const slabs = fap.slabs;
				if (!src && (!slabs || slabs.length === 0)) return fap;
				const srcMaskCopy = src ? new Uint8Array(src.data) : null;
				const srcMaterialCopy = src?.materialMask != null ? new Uint8Array(src.materialMask) : null;
				if (srcMaskCopy) transferable.push(srcMaskCopy.buffer);
				if (srcMaterialCopy) transferable.push(srcMaterialCopy.buffer);
				const slabCopies = (slabs ?? []).map((slab) => {
					const copy = slab.roomTypes ? new Uint8Array(slab.roomTypes) : null;
					if (copy) transferable.push(copy.buffer);
					return { ...slab, roomTypes: copy };
				});
				return {
					...fap,
					source:
						src && srcMaskCopy
							? { ...src, data: srcMaskCopy, materialMask: srcMaterialCopy }
							: null,
					slabs: slabCopies.length > 0 ? slabCopies : null
				};
			});

			const msg = {
				type: 'optimize' as const,
				runId,
				aps,
				fixedAps,
				wallMask: maskCopy,
				maskWidth,
				maskHeight,
				wallAttenuation,
				materialMask: materialCopy,
				defaultMaterial: options?.defaultMaterial ?? 0,
				metersPerPixel: options?.metersPerPixel ?? 0,
				allowOutside: options?.allowOutside ?? false,
				densityMap: densityCopy,
				medianDensity: options?.medianDensity ?? 0,
				roomTypeMask: roomTypeCopy,
				seed: options?.seed,
				interferenceWeight: options?.interferenceWeight,
				regulatoryDomain: options?.regulatoryDomain,
				coverageSoftnessDb: options?.coverageSoftnessDb,
				pathLossScenario: options?.pathLossScenario,
				graphOnly: options?.graphOnly,
				powerLevelsDbm: options?.powerLevelsDbm,
				worldUnitsPerMeter: options?.worldUnitsPerMeter,
				localVerticalDrop: options?.localVerticalDrop ?? 0,
				wallBandWu: options?.wallBandWu,
				minRoomRadiusWu: options?.minRoomRadiusWu,
				planningArea: options?.planningArea ?? null,
				surfaces: options?.surfaces ?? [],
				customMaterials: options?.customMaterials ?? [],
				// The payload shape this bridge builds. See `optimizer-protocol.ts`: the
				// worker checks it when present, so a bundle left in a browser cache while
				// the app around it moved on fails loudly instead of scoring a different
				// model.
				payloadVersion: OPTIMIZER_PAYLOAD_VERSION,
				coverageFloor: options?.coverageFloor
			};
			this.getWorker().postMessage(msg, transferable);
		});
	}

	/**
	 * Stop the run in flight, and stop waiting for it.
	 *
	 * The promise is rejected here rather than when the worker acknowledges, so the caller
	 * (whose loops check the same cancellation) unwinds immediately instead of after a round
	 * trip. A cancel that names no run is dropped: sending it anyway would stop whichever run
	 * the worker had started in the meantime — the one the user has just asked for.
	 */
	cancel(): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = null;
		this.getWorker().postMessage({ type: 'cancel', runId: pending.runId });
		pending.reject(new Error('Cancelled'));
	}

	terminate(): void {
		this.worker?.terminate();
		this.worker = null;
		this.cleanup();
	}
}
