import {
	apState,
	defaultMountHeight,
	refreshApRanges,
	resetApNumbering,
	type ApMount,
	type AccessPoint
} from './ap-state.svelte.js';
import { defaultAntenna } from '../rf/antenna.js';
import { floorCoverage as floorCoverageState } from './optimizer.svelte.js';
import { floorplanState } from './floorplan-state.svelte.js';
import { wallState } from './wall-state.svelte.js';
import { projectMeta } from './project-meta.svelte.js';
import { floorState, type Floor } from './floor-state.svelte.js';
import { clearHistory } from './history.svelte.js';
import type { Band, ChannelWidth, RegulatoryDomain } from '@aetherax/channels';
import type { WallMaterialId } from '$canvas/materials.js';
import type { FloorMaterialId } from '$canvas/floor-materials.js';
import {
	DEFAULT_COVERAGE_SOFTNESS_DB,
	DEFAULT_PATH_LOSS_SCENARIO,
	setPathLossScenario,
	type PathLossScenario
} from '../rf/propagation.js';
import { appState } from './app.svelte.js';
import { t } from './i18n.svelte.js';
import {
	indexDbStore,
	localStore,
	migrateInto,
	type KeyValueStore,
	type StorageBackend
} from './storage.js';

/**
 * Every key this app writes starts with this. Exported because `WelcomeDialog` has to
 * consult the same prefix before the app restores anything.
 */
export const STORAGE_PREFIX = 'aetherax:';
/** The prefix the app carried before it was renamed. Read-only, and never written. */
const LEGACY_PREFIX = 'deconflict:';

const STORAGE_KEY = `${STORAGE_PREFIX}project`;
const FLOORPLAN_KEY = `${STORAGE_PREFIX}floorplan`;
const SAVE_DELAY = 2000;

/**
 * Copy every stored key from the old prefix to the new one, once.
 *
 * A prefix sweep rather than a list of keys, because per-floor floorplans are stored as
 * `<prefix>floorplan:<floorId>` — one key per floor, with ids that only exist at runtime.
 * Nothing is deleted, so a rollback to the previous build still finds the project, and an
 * existing key under the new prefix is never overwritten.
 *
 * Safe to call more than once and safe to call before anything else has run: it only
 * copies, and a failure to reach localStorage leaves the app working, just forgetful.
 */
export function migrateLegacyStorageKeys(): void {
	try {
		const moves: Array<[string, string]> = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key && key.startsWith(LEGACY_PREFIX)) {
				moves.push([key, STORAGE_PREFIX + key.slice(LEGACY_PREFIX.length)]);
			}
		}
		for (const [oldKey, newKey] of moves) {
			if (localStorage.getItem(newKey) !== null) continue;
			const value = localStorage.getItem(oldKey);
			if (value !== null) localStorage.setItem(newKey, value);
		}
	} catch {
		// Private mode or a full quota: the app still runs, it just starts fresh.
	}
}

// v2 (legacy single-floor)
interface SavedStateV2 {
	version: 2;
	name: string;
	band: Band;
	channelWidth: ChannelWidth;
	regulatoryDomain: RegulatoryDomain;
	aps: Array<Omit<SavedAp, 'floorId'> & { floorId?: string }>;
	floorplanScale: number;
	floorplanOffsetX: number;
	floorplanOffsetY: number;
	unitSystem?: 'imperial' | 'metric';
	ispSpeed: number;
	targetThroughput: number;
	allowOutsideRooms?: boolean;
	heatmapRssiFloor?: number;
	clientHeight?: number;
	/** Weight of the co-channel interference share in the optimizer objective. */
	interferenceWeight?: number;
	/** How far below the coverage threshold a sample still earns utility, in dB. */
	coverageSoftnessDb?: number;
	/** ε-constraint: the minimum covered share the optimiser must reach, in percent. */
	coverageFloorPct?: number;
	/** Apply that floor to every floor rather than to the one being optimised. */
	coverageFloorEveryFloor?: boolean;
	/** ITU-R P.1238 environment the distance term assumes. Default: closed plan. */
	pathLossScenario?: PathLossScenario;
	/**
	 * Wall materials the user added. Absent on projects saved before materials were
	 * customisable, which reads as none.
	 */
	customMaterials?: Array<{
		id: number;
		name: string;
		dbPerCrossing: number;
		thicknessM: number;
		color: [number, number, number];
	}>;
	wallMask?: {
		dataUrl: string;
		width: number;
		height: number;
		originX?: number;
		originY?: number;
	} | null;
	wallAttenuation?: number;
	wallMaterial?: number;
	materialMask?: {
		dataUrl: string;
		width: number;
		height: number;
		originX?: number;
		originY?: number;
	} | null;
	floorplanBoundary?: Array<{ x: number; y: number }> | null;
	calibration: { worldUnitsPerMeter: number } | null;
}

// v3 (multi-floor)
/**
 * An access point as a *file* may carry it.
 *
 * Mounting is optional because every project written before it existed has no
 * such field, and the model those files were saved under put every AP on the
 * ceiling — which is what `normalizeAp` loads them as.
 */
type SavedAp = Omit<
	AccessPoint,
	'mount' | 'mountHeightM' | 'beamwidthDeg' | 'aimDeg' | 'facingDeg' | 'pinned'
> & {
	mount?: ApMount;
	mountHeightM?: number;
	/** The antenna's vertical cut. Absent in files written before it existed. */
	beamwidthDeg?: number;
	aimDeg?: number;
	/** Which way a wall mount faces. Absent in files written before wall mounts. */
	facingDeg?: number;
	/** Absent in files written before pinning existed, which is "not pinned". */
	pinned?: boolean;
};

interface SavedFloor {
	id: string;
	name: string;
	level: number;
	ceilingHeight: number;
	floorMaterial: FloorMaterialId;
	floorThickness: number;
	floorplanScale: number;
	floorplanOffsetX: number;
	floorplanOffsetY: number;
	calibration: { worldUnitsPerMeter: number } | null;
	floorplanBoundary: Array<{ x: number; y: number }> | null;
	wallMask: {
		dataUrl: string;
		width: number;
		height: number;
		originX?: number;
		originY?: number;
	} | null;
	wallAttenuation: number;
	wallMaterial: number;
	materialMask: {
		dataUrl: string;
		width: number;
		height: number;
		originX?: number;
		originY?: number;
	} | null;
	roomTypeMask?: {
		dataUrl: string;
		width: number;
		height: number;
		originX?: number;
		originY?: number;
	} | null;
	roomDensityOverrides?: Record<string, number>;
	roomCustomLabels?: Record<string, string>;
}

interface SavedStateV3 {
	version: 3;
	name: string;
	band: Band;
	channelWidth: ChannelWidth;
	regulatoryDomain: RegulatoryDomain;
	unitSystem: 'imperial' | 'metric';
	ispSpeed: number;
	targetThroughput: number;
	allowOutsideRooms: boolean;
	heatmapRssiFloor?: number;
	clientHeight?: number;
	/** Weight of the co-channel interference share in the optimizer objective. */
	interferenceWeight?: number;
	/** How far below the coverage threshold a sample still earns utility, in dB. */
	coverageSoftnessDb?: number;
	/**
	 * ε-constraint: the minimum covered share the optimiser must reach, as a
	 * percentage. Zero means no constraint.
	 */
	coverageFloorPct?: number;
	/** Apply that floor to every floor rather than to the one being optimised. */
	coverageFloorEveryFloor?: boolean;
	/** ITU-R P.1238 environment the distance term assumes. Default: closed plan. */
	pathLossScenario?: PathLossScenario;
	/**
	 * Wall materials the user added. Absent on projects saved before materials were
	 * customisable, which reads as none.
	 */
	customMaterials?: Array<{
		id: number;
		name: string;
		dbPerCrossing: number;
		thicknessM: number;
		color: [number, number, number];
	}>;
	/**
	 * Ignored, and no longer written.
	 *
	 * An earlier build of this file carried a switch for whether an AP's mounting
	 * height was modelled at all. It is always modelled now — a ceiling mount is the
	 * preset an AP starts from, not a mode — so a file that still has the key loads
	 * exactly as one that does not.
	 */
	mountHeights?: boolean;
	/**
	 * Last measured coverage per floor, as a percentage, keyed by floor id.
	 *
	 * Persisted so the building-wide readout and its weakest floor survive a reload: the
	 * live estimator only ever measures the floor on screen, so a stacked project would
	 * otherwise come back with every other floor unmeasured.
	 */
	floorCoverage?: Record<string, { coverage: number; samples: number }>;
	floors: SavedFloor[];
	aps: SavedAp[];
}

type SavedState = SavedStateV2 | SavedStateV3;

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
export const persistenceState = $state({ lastSaved: null as Date | null });

/**
 * An access point from a file, with the fields a file may not have.
 *
 * A project saved before mounting heights existed carries neither `mount` nor
 * `mountHeightM`, and the model those files were written under put every AP on the
 * ceiling of its storey — so that is what they load as, and turning the setting on
 * afterwards gives them a height instead of a zero. The floor is filled in too, for
 * the v2 files whose APs predate floors entirely.
 */
function normalizeAp(ap: SavedAp, fallbackFloorId: string): AccessPoint {
	const floorId = ap.floorId || fallbackFloorId;
	/*
	 * `wall` was a third mount preset whose only effect was a 1.5 m default height,
	 * before the horizontal antenna cut existed; it is a real mounting again now, and
	 * a file that says `wall` meant a unit on a wall, so it loads as one. Its facing
	 * is not in those files and there is nothing here that can work it out — the
	 * nearest wall needs the mask decoded — so it loads facing +x and can be turned.
	 */
	const storedMount = ap.mount;
	const mount: ApMount =
		storedMount === 'floor' || storedMount === 'ceiling' || storedMount === 'wall'
			? storedMount
			: 'ceiling';
	const ceiling = floorState.floors.find((f) => f.id === floorId)?.ceilingHeight ?? 3;
	// The band's own antenna, for a file written before the vertical cut existed or
	// with a band the AP has since changed to.
	const antenna = defaultAntenna(ap.beamwidthDeg ?? null, ap.band);
	return {
		...ap,
		floorId,
		mount,
		mountHeightM: ap.mountHeightM ?? defaultMountHeight(mount, ceiling),
		beamwidthDeg: ap.beamwidthDeg ?? antenna.beamwidthDeg,
		aimDeg: ap.aimDeg ?? antenna.aimDeg,
		// Facing +x. A file written before wall mounts cannot say which way the unit
		// looked, and the band's antenna is an omni with no direction at all.
		facingDeg: ap.facingDeg ?? 0,
		// A file written before pinning existed describes APs the optimiser was free to
		// move, which is what "not pinned" means.
		pinned: ap.pinned ?? false
	};
}

function syncCurrentFloorFromLegacy(): void {
	const cur = floorState.floors.find((f) => f.id === floorState.currentFloorId);
	if (!cur) return;
	cur.floorplanUrl = floorplanState.floorplanUrl;
	cur.floorplanScale = floorplanState.floorplanScale;
	cur.calibration = floorplanState.calibration;
	cur.floorplanBoundary = floorplanState.floorplanBoundary;
	cur.wallMask = wallState.wallMask;
	cur.wallAttenuation = wallState.wallAttenuation;
	cur.wallMaterial = wallState.wallMaterial;
	cur.materialMask = wallState.materialMask;
	cur.roomTypeMask = wallState.roomTypeMask;
}

/**
 * Write the project to whichever store is in use.
 *
 * Asynchronous because the backend is: IndexedDB, with localStorage as the fallback for a
 * browser that has none (see `state/storage.ts`). The debounced caller fires and forgets —
 * a failure is not silent, it lands in `appState.storageNotice`, which is the whole point
 * of the notice: with a five-megabyte quota and a PNG mask per floor, "saved nothing and
 * said nothing" is the failure mode that loses work.
 */
async function saveToStorage(): Promise<void> {
	/*
	 * The timer has fired, so nothing is pending any more.
	 *
	 * Leaving the handle set made every later `scheduleSave(true)` return early
	 * forever — the `keep` callers thought a save was on its way and no save was
	 * ever scheduled again, so an access point's mounting (and anything else that
	 * only ever asks for `keep`) reached storage once and never again.
	 */
	saveTimeout = null;
	syncCurrentFloorFromLegacy();
	const store = await ensureStore();
	try {
		const data: SavedStateV3 = {
			version: 3,
			name: projectMeta.name,
			band: apState.band,
			channelWidth: apState.channelWidth,
			regulatoryDomain: apState.regulatoryDomain,
			unitSystem: floorplanState.unitSystem,
			ispSpeed: projectMeta.ispSpeed,
			targetThroughput: projectMeta.targetThroughput,
			allowOutsideRooms: projectMeta.allowOutsideRooms,
			heatmapRssiFloor: projectMeta.heatmapRssiFloor,
			clientHeight: projectMeta.clientHeight,
			interferenceWeight: projectMeta.interferenceWeight,
			coverageSoftnessDb: projectMeta.coverageSoftnessDb,
			coverageFloorPct: projectMeta.coverageFloorPct,
			coverageFloorEveryFloor: projectMeta.coverageFloorEveryFloor,
			pathLossScenario: projectMeta.pathLossScenario,
			// The user's own wall materials: part of how this plan was planned, so they travel
			// with the project rather than with the machine.
			customMaterials: JSON.parse(JSON.stringify(projectMeta.customMaterials)),
			// Only floors that still exist: a deleted floor's figure would otherwise come
			// back as a phantom in the building mean.
			floorCoverage: Object.fromEntries(
				floorState.floors
					.map((f) => [f.id, floorCoverageState.get(f.id)] as const)
					.filter((pair): pair is [string, { coverage: number; samples: number }] => !!pair[1])
			),
			floors: floorState.floors.map((f) => ({
				id: f.id,
				name: f.name,
				level: f.level,
				ceilingHeight: f.ceilingHeight,
				floorMaterial: f.floorMaterial,
				floorThickness: f.floorThickness,
				floorplanScale: f.floorplanScale,
				floorplanOffsetX: f.floorplanOffsetX,
				floorplanOffsetY: f.floorplanOffsetY,
				calibration: f.calibration ? JSON.parse(JSON.stringify(f.calibration)) : null,
				floorplanBoundary: f.floorplanBoundary
					? JSON.parse(JSON.stringify(f.floorplanBoundary))
					: null,
				wallMask: f.wallMask ? JSON.parse(JSON.stringify(f.wallMask)) : null,
				wallAttenuation: f.wallAttenuation,
				wallMaterial: f.wallMaterial,
				materialMask: f.materialMask ? JSON.parse(JSON.stringify(f.materialMask)) : null,
				roomTypeMask: f.roomTypeMask ? JSON.parse(JSON.stringify(f.roomTypeMask)) : null,
				roomDensityOverrides: f.roomDensityOverrides ?? {},
				roomCustomLabels: f.roomCustomLabels ?? {},
				// The drawn planning area is part of the project: it is the user's statement
				// about where the floor is, and re-drawing it after every reload would make
				// the feature useless.
				planningArea: f.planningArea ? JSON.parse(JSON.stringify(f.planningArea)) : null,
				// Notes are part of the plan's meaning, not its presentation: what the
				// drawing cannot say about a place on a floor.
				notes: f.notes ? JSON.parse(JSON.stringify(f.notes)) : []
			})),
			aps: JSON.parse(JSON.stringify(apState.aps))
		};
		await store.write(STORAGE_KEY, JSON.stringify(data));
		persistenceState.lastSaved = new Date();
		// A later save that works clears the warning: storage was full, and is not any
		// more.
		appState.storageNotice = null;
	} catch {
		appState.storageNotice = t(
			'The project could not be saved: the browser storage is full or unavailable. Export it to a file (File → Export JSON), then remove a floorplan or a floor to make room.'
		);
	}

	// Persist floorplan images per floor
	try {
		for (const floor of floorState.floors) {
			if (floor.floorplanUrl && floor.floorplanUrl.startsWith('blob:')) {
				const key = `${FLOORPLAN_KEY}:${floor.id}`;
				const canvas = document.createElement('canvas');
				const img = new Image();
				img.onload = () => {
					canvas.width = img.naturalWidth;
					canvas.height = img.naturalHeight;
					const ctx = canvas.getContext('2d')!;
					ctx.drawImage(img, 0, 0);
					void store.write(key, canvas.toDataURL('image/png')).catch(() => {
						// too large: the project document is what has to land
					});
				};
				img.src = floor.floorplanUrl;
			}
		}
	} catch {
		// Ignore
	}
}

/** Migrate v2 (single floor) to v3 (multi-floor). */
function migrateV2(data: SavedStateV2): SavedStateV3 {
	const floorId = crypto.randomUUID();
	return {
		version: 3,
		name: data.name || 'Untitled Project',
		band: data.band || '5ghz',
		channelWidth: data.channelWidth || 20,
		regulatoryDomain: data.regulatoryDomain || 'fcc',
		unitSystem: data.unitSystem ?? 'imperial',
		ispSpeed: data.ispSpeed ?? 0,
		targetThroughput: data.targetThroughput ?? 25,
		allowOutsideRooms: data.allowOutsideRooms ?? false,
		heatmapRssiFloor: data.heatmapRssiFloor ?? -70,
		clientHeight: data.clientHeight ?? 1.5,
		interferenceWeight: data.interferenceWeight ?? 0.2,
		coverageSoftnessDb: data.coverageSoftnessDb ?? DEFAULT_COVERAGE_SOFTNESS_DB,
		coverageFloorPct: data.coverageFloorPct ?? 0,
		coverageFloorEveryFloor: data.coverageFloorEveryFloor ?? false,
			pathLossScenario: data.pathLossScenario ?? DEFAULT_PATH_LOSS_SCENARIO,
		floors: [
			{
				id: floorId,
				name: 'Floor 1',
				level: 0,
				ceilingHeight: 3.0,
				floorMaterial: 1,
				floorplanScale: data.floorplanScale ?? 0.4,
				floorplanOffsetX: data.floorplanOffsetX ?? 0,
				floorplanOffsetY: data.floorplanOffsetY ?? 0,
				floorThickness: 0.2,
				calibration: data.calibration ?? null,
				floorplanBoundary: data.floorplanBoundary ?? null,
				wallMask: data.wallMask
					? {
							...data.wallMask,
							originX: data.wallMask.originX ?? 0,
							originY: data.wallMask.originY ?? 0
						}
					: null,
				wallAttenuation: data.wallAttenuation ?? 5,
				wallMaterial: data.wallMaterial ?? 0,
				materialMask: data.materialMask
					? {
							...data.materialMask,
							originX: data.materialMask.originX ?? 0,
							originY: data.materialMask.originY ?? 0
						}
					: null,
				roomTypeMask: null,
				roomDensityOverrides: {},
				roomCustomLabels: {}
			}
		],
		aps: (data.aps || []).map((ap) => ({
			...ap,
			floorId,
			modelId: (ap as any).modelId ?? null,
			modelLabel: (ap as any).modelLabel ?? null
		})) as AccessPoint[]
	};
}

/**
 * Which store the project is kept in.
 *
 * `localstorage` today, on purpose, and the seam exists so that turning the other one on
 * is a one-line change rather than a rewrite. The reason it is still the old one: every
 * test helper that asks "what did the app save?" reads `localStorage`, and so may any tool
 * a user has around their projects. Moving the project into IndexedDB therefore has to
 * move those readers with it, and that is a change of its own — measured, not assumed.
 * `indexeddb` is implemented and unit-tested behind this switch; see `state/storage.ts`
 * for why it is the destination (a five-megabyte quota against a PNG mask per floor).
 */
const BACKEND: StorageBackend = 'localstorage';

/**
 * The store the project is kept in, opened once.
 *
 * Whichever backend is selected, any record that only exists in localStorage is carried
 * over first, so a project saved by an older build is found by this one.
 */
let projectStore: KeyValueStore | null = null;
async function ensureStore(): Promise<KeyValueStore> {
	if (projectStore) return projectStore;
	let store: KeyValueStore = localStore;
	if (BACKEND === 'indexeddb') {
		try {
			// A round trip rather than a feature test: a private window can expose
			// `indexedDB` and refuse to open a database.
			await indexDbStore.keys();
			store = indexDbStore;
		} catch {
			store = localStore;
		}
	}
	try {
		await migrateInto(store, [STORAGE_KEY, FLOORPLAN_KEY]);
	} catch {
		// The legacy copy is still there and still readable: carry on with what we have
		// rather than starting the app with no project at all.
	}
	projectStore = store;
	return store;
}

/** Which backend the project is in, for the storage notice. Exported for diagnostics. */
export function storageBackend(): StorageBackend | null {
	return projectStore?.backend ?? null;
}

export async function restoreFromStorage(): Promise<boolean> {
	// First thing: a project saved before the rename lives under the old prefix, and that
	// is a localStorage concern — it runs before anything is read.
	migrateLegacyStorageKeys();
	const store = await ensureStore();
	try {
		const raw = await store.read(STORAGE_KEY);
		if (!raw) return false;

		let parsed: SavedState = JSON.parse(raw);
		if (!parsed.version || parsed.version < 2) {
			await store.remove(STORAGE_KEY);
			await store.remove(FLOORPLAN_KEY);
			return false;
		}

		// Migrate v2 → v3
		const data: SavedStateV3 = parsed.version === 2 ? migrateV2(parsed) : parsed;

		if (!data.floors || data.floors.length === 0) return false;

		// Project meta
		projectMeta.name = data.name || 'Untitled Project';
		projectMeta.ispSpeed = data.ispSpeed ?? 0;
		projectMeta.targetThroughput = data.targetThroughput ?? 25;
		projectMeta.allowOutsideRooms = data.allowOutsideRooms ?? false;
		// Projects saved before this setting became an RSSI floor stored an
		// abstract dB window instead. There is nothing to convert it from
		// without knowing each AP's power and band, so fall back to sensitivity.
		projectMeta.heatmapRssiFloor = data.heatmapRssiFloor ?? -70;
		projectMeta.clientHeight = data.clientHeight ?? 1.5;
		projectMeta.interferenceWeight = data.interferenceWeight ?? 0.2;
		projectMeta.coverageSoftnessDb = data.coverageSoftnessDb ?? DEFAULT_COVERAGE_SOFTNESS_DB;
		projectMeta.coverageFloorPct = data.coverageFloorPct ?? 0;
		projectMeta.coverageFloorEveryFloor = data.coverageFloorEveryFloor ?? false;
		projectMeta.pathLossScenario = data.pathLossScenario ?? DEFAULT_PATH_LOSS_SCENARIO;
		// Restored before the floors, so a wall painted with one of these is read back with
		// the material it was painted with.
		projectMeta.customMaterials = Array.isArray((data as any).customMaterials)
			? (data as any).customMaterials
			: [];
		floorCoverageState.clear();
		for (const [id, entry] of Object.entries(data.floorCoverage ?? {})) {
			if (!data.floors.some((f) => f.id === id)) continue;
			if (typeof entry?.coverage !== 'number') continue;
			floorCoverageState.set(id, {
				coverage: entry.coverage,
				samples: typeof entry.samples === 'number' ? entry.samples : 1
			});
		}

		// AP defaults
		apState.band = data.band || '5ghz';
		apState.channelWidth = data.channelWidth || 20;
		apState.regulatoryDomain = data.regulatoryDomain || 'fcc';

		// Unit system (global)
		floorplanState.unitSystem = data.unitSystem ?? 'imperial';

		// Floors
		floorState.floors = data.floors.map((f) => ({
			id: f.id,
			name: f.name,
			level: f.level,
			ceilingHeight: f.ceilingHeight ?? 3.0,
			floorMaterial: (f.floorMaterial ?? 1) as FloorMaterialId,
			floorThickness: (f as any).floorThickness ?? 0.2,
			floorplanUrl: null,
			floorplanScale: f.floorplanScale ?? 0.4,
			floorplanOffsetX: f.floorplanOffsetX ?? 0,
			floorplanOffsetY: f.floorplanOffsetY ?? 0,
			calibration: f.calibration ?? null,
			floorplanBoundary: f.floorplanBoundary ?? null,
			wallMask: f.wallMask
				? { ...f.wallMask, originX: f.wallMask.originX ?? 0, originY: f.wallMask.originY ?? 0 }
				: null,
			wallAttenuation: f.wallAttenuation ?? 5,
			wallMaterial: (f.wallMaterial ?? 0) as WallMaterialId,
			materialMask: f.materialMask
				? {
						...f.materialMask,
						originX: f.materialMask.originX ?? 0,
						originY: f.materialMask.originY ?? 0
					}
				: null,
			roomTypeMask: f.roomTypeMask
				? {
						...f.roomTypeMask,
						originX: f.roomTypeMask.originX ?? 0,
						originY: f.roomTypeMask.originY ?? 0
					}
				: null,
			roomDensityOverrides: (f as any).roomDensityOverrides ?? {},
			roomCustomLabels: (f as any).roomCustomLabels ?? {},
			planningArea: Array.isArray((f as any).planningArea) ? (f as any).planningArea : null,
			notes: Array.isArray((f as any).notes) ? (f as any).notes : []
		}));
		floorState.currentFloorId = floorState.floors[0]!.id;

		/*
		 * Access points after the floors, not before.
		 *
		 * Two things read the floors: a ceiling-mounted AP's default height comes
		 * from its storey, and a radius comes from `rangeFromPower` times the
		 * project's world units per metre, which lives on the first floor's
		 * calibration. Refreshing the radii before the floors were restored measured
		 * an uncalibrated project's scale against every stored AP, so a calibrated
		 * plan came back with radii 60% too long until something else happened to
		 * refresh them.
		 */
		apState.aps = (data.aps || []).map((ap) =>
			normalizeAp(ap, floorState.floors[0]!.id)
		);
		// The stored radii were computed under whichever propagation model was in
		// force when the project was saved, so refresh them from power and band. The
		// radii below are derived from the coefficient, so it is selected first.
		setPathLossScenario(projectMeta.pathLossScenario);
		refreshApRanges();

		// Sync current floor to legacy atoms (for backward compat with components not yet migrated)
		const cur = floorState.floors[0]!;
		floorplanState.floorplanScale = cur.floorplanScale;
		floorplanState.floorplanBoundary = cur.floorplanBoundary;
		floorplanState.calibration = cur.calibration;
		wallState.wallMask = cur.wallMask;
		wallState.wallAttenuation = cur.wallAttenuation;
		wallState.wallMaterial = cur.wallMaterial;
		wallState.materialMask = cur.materialMask;
		wallState.roomTypeMask = cur.roomTypeMask;

		// Restore floorplan images
		for (const floor of floorState.floors) {
			const perFloorKey = `${FLOORPLAN_KEY}:${floor.id}`;
			const perFloorData = await store.read(perFloorKey);
			if (perFloorData) {
				floor.floorplanUrl = perFloorData;
			}
		}
		// Legacy: single floorplan key (v2 migration)
		if (!floorState.floors[0]!.floorplanUrl) {
			const legacyFloorplan = await store.read(FLOORPLAN_KEY);
			if (legacyFloorplan) {
				floorState.floors[0]!.floorplanUrl = legacyFloorplan;
			}
		}
		// Sync to legacy atom
		floorplanState.floorplanUrl = floorState.floors[0]!.floorplanUrl;

		clearHistory();
		return true;
	} catch {
		return false;
	}
}

export async function clearSavedState(): Promise<void> {
	const store = await ensureStore();
	await store.remove(STORAGE_KEY);
	await store.remove(FLOORPLAN_KEY);
	// Clear per-floor floorplan keys
	for (const floor of floorState.floors) {
		await store.remove(`${FLOORPLAN_KEY}:${floor.id}`);
	}
	persistenceState.lastSaved = null;
}

/**
 * Save after the debounce, replacing any save already pending.
 *
 * `keep` is for callers whose change is **background work** rather than a user edit: their
 * change still has to reach storage, but it must not push back a save the user's own edit
 * already scheduled. The automatic solver and the comparison's winning colouring both need
 * it — each used to write state and never save it, so what landed on disk was whatever the
 * optimiser had scheduled two seconds earlier, computed for the *previous* positions.
 */
/**
 * Save now, because the user asked — and say so.
 *
 * The debounced `scheduleSave` is right for an edit and wrong for a keystroke or a menu
 * click: the user is watching for an answer, and a save that happens two seconds later in
 * silence reads as a button that does nothing. This writes immediately, cancels the
 * pending timer so the same write does not happen twice, and shows the acknowledgment for
 * a moment.
 */
export async function saveNow(): Promise<void> {
	if (saveTimeout) {
		clearTimeout(saveTimeout);
		saveTimeout = null;
	}
	await saveToStorage();
	appState.savedNotice = t('Project saved');
	if (savedNoticeTimer) clearTimeout(savedNoticeTimer);
	savedNoticeTimer = setTimeout(() => {
		appState.savedNotice = null;
		savedNoticeTimer = null;
	}, 2500);
}

let savedNoticeTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSave(keep = false): void {
	if (keep && saveTimeout) return;
	if (saveTimeout) clearTimeout(saveTimeout);
	// `saveToStorage` opens the store itself and reports its own failures; the debounce
	// only has to decide *when*.
	saveTimeout = setTimeout(() => void saveToStorage(), SAVE_DELAY);
}

export async function hasSavedState(): Promise<boolean> {
	const store = await ensureStore();
	return (await store.read(STORAGE_KEY)) !== null;
}
