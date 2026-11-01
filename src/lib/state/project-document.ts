/**
 * The project as a **document**: one shape, one migration, one reader and one writer.
 *
 * There used to be three. `persistence.svelte.ts` wrote a shape into localStorage,
 * `export/json.ts` wrote a second shape into a file, and `history.svelte.ts` snapshotted a
 * third — and the three copies of the schema drifted. The file format never learned about
 * vector walls, columns, raised surfaces, notes or the planning area, so exporting a
 * project and importing it back silently dropped all of them; `SavedFloor` was missing the
 * same fields while the saver wrote them anyway, which is why the loader reads them back
 * through `as any`. A schema that exists four times is a schema that is wrong three times.
 *
 * Everything that crosses the storage boundary — a save, a restore, an export, an import —
 * now goes through:
 *
 *   `toDocument()`    state  → document      (write)
 *   `migrate()`       unknown → document     (read, any version)
 *   `applyDocument()` document → state       (read, after migrate)
 *
 * `migrate` is the only place that knows how an old file was shaped; `applyDocument` is the
 * only place that knows which atom owns a field. Adding a field to a floor means adding it
 * to `DocumentFloor` (which is derived from `Floor`, so it is hard to forget) and to the two
 * functions below — and the round-trip test in `project-document.test.ts` fails until the
 * field survives both directions.
 *
 * The document is also the *only* description of the file format: `export/json.ts` no longer
 * declares its own.
 */
import type { Band, ChannelWidth, RegulatoryDomain } from '@aetherax/channels';
import type { FloorMaterialId } from '$canvas/floor-materials.js';
import type { WallMaterialId } from '$canvas/materials.js';
import { defaultAntenna } from '../rf/antenna.js';
import {
	DEFAULT_COVERAGE_SOFTNESS_DB,
	DEFAULT_PATH_LOSS_SCENARIO,
	setPathLossScenario,
	type PathLossScenario
} from '../rf/propagation.js';
import {
	apState,
	defaultMountHeight,
	refreshApRanges,
	type AccessPoint,
	type ApMount
} from './ap-state.svelte.js';
import { floorState, type Floor } from './floor-state.svelte.js';
import { floorplanState } from './floorplan-state.svelte.js';
import { clearHistory } from './history.svelte.js';
import { projectMeta } from './project-meta.svelte.js';

/** The version this module writes. Bumped when a stored field changes meaning. */
export const DOCUMENT_VERSION = 3;

export type UnitSystem = 'imperial' | 'metric';

/**
 * A mask as a document may carry it.
 *
 * The origin is optional because documents written before a mask recorded its own frame do
 * not have one; everything read is normalised to `{ originX: 0, originY: 0 }` in that case.
 */
export interface StoredMask {
	dataUrl: string;
	width: number;
	height: number;
	originX?: number;
	originY?: number;
}

/** A mask in a normalised document: the frame is always known. */
export type DocumentMask = NonNullable<Floor['wallMask']>;

/**
 * A floor in a normalised document.
 *
 * Derived from `Floor` minus the two things the document cannot carry cheaply or at all:
 * the underlay's session URL (the file inlines it as `floorplanImage`, storage keeps it
 * under its own key) and the geometry lists, which are made *required* here because that is
 * exactly what the duplicated schemas forgot.
 */
export type DocumentFloor = Omit<
	Floor,
	'floorplanUrl' | 'planningArea' | 'notes' | 'walls' | 'columns' | 'surfaces'
> & {
	planningArea: NonNullable<Floor['planningArea']> | null;
	notes: NonNullable<Floor['notes']>;
	walls: NonNullable<Floor['walls']>;
	columns: NonNullable<Floor['columns']>;
	surfaces: NonNullable<Floor['surfaces']>;
	/** The underlay as a data URL. Present in a file, absent in storage. */
	floorplanImage?: string;
};

/**
 * A floor as a document *may* carry it: every field optional but the identity.
 *
 * This is the reading type. `migrate` turns it into a `DocumentFloor` by filling defaults —
 * the defaults are the reading rules for a format that has gained fields over time.
 */
export type StoredFloor = Partial<
	Omit<DocumentFloor, 'wallMask' | 'materialMask' | 'roomTypeMask'>
> & {
	id: string;
	wallMask?: StoredMask | null;
	materialMask?: StoredMask | null;
	roomTypeMask?: StoredMask | null;
};

/**
 * An access point as a document may carry it.
 *
 * Mounting, the antenna cuts, the facing and the pin are all optional because documents
 * written before each of them exist do not have it; `normalizeAp` fills in the value that
 * model would have used.
 */
export type StoredAp = Partial<AccessPoint> & Pick<AccessPoint, 'id'>;

/** A wall material the user added, in the shape the project stores. */
export interface DocumentCustomMaterial {
	id: number;
	name: string;
	dbPerCrossing: number;
	thicknessM: number;
	color: [number, number, number];
}

/** One floor's measured coverage, as the optimiser's cache reports it. */
export interface FloorCoverageEntry {
	coverage: number;
	samples: number;
}

/** A normalised project document — what this module writes, and what it hands back. */
export interface ProjectDocumentV3 {
	version: 3;
	name: string;
	band: Band;
	channelWidth: ChannelWidth;
	regulatoryDomain: RegulatoryDomain;
	unitSystem: UnitSystem;
	ispSpeed: number;
	targetThroughput: number;
	allowOutsideRooms: boolean;
	heatmapRssiFloor: number;
	clientHeight: number;
	interferenceWeight: number;
	coverageSoftnessDb: number;
	coverageFloorPct: number;
	coverageFloorEveryFloor: boolean;
	pathLossScenario: PathLossScenario;
	customMaterials: DocumentCustomMaterial[];
	floorCoverage: Record<string, FloorCoverageEntry>;
	floors: DocumentFloor[];
	aps: AccessPoint[];
}

/**
 * Anything `JSON.parse` produced.
 *
 * One cast at the boundary, then the normalisers below do the work: the alternative is
 * `(data as any)` at fifteen call sites, which is how the missing fields went unnoticed.
 */
type RawDocument = Partial<
	Omit<ProjectDocumentV3, 'version' | 'floors' | 'aps' | 'customMaterials' | 'floorCoverage'>
> & {
	version?: number;
	floors?: StoredFloor[];
	aps?: StoredAp[];
	customMaterials?: DocumentCustomMaterial[];
	floorCoverage?: Record<string, Partial<FloorCoverageEntry>>;
	/* Version 2 kept a single floor at the top level. */
	floorplanImage?: string;
	floorplanScale?: number;
	floorplanOffsetX?: number;
	floorplanOffsetY?: number;
	calibration?: { worldUnitsPerMeter: number } | null;
	floorplanBoundary?: Array<{ x: number; y: number }> | null;
	wallMask?: StoredMask | null;
	materialMask?: StoredMask | null;
	wallAttenuation?: number;
	wallMaterial?: number;
};

/** A destination for a document's per-floor coverage. */
export interface CoverageSink {
	clear(): void;
	set(floorId: string, entry: FloorCoverageEntry): void;
}

export interface ToDocumentOptions {
	/** Measured coverage per floor, from the optimiser's cache. */
	floorCoverage?: ReadonlyMap<string, FloorCoverageEntry>;
}

export interface ApplyDocumentOptions {
	/** Where to put the document's per-floor coverage, when the caller keeps a cache. */
	floorCoverage?: CoverageSink;
}

/* ── Writing ───────────────────────────────────────────────────────────────────────────── */

/**
 * The whole project, as a document.
 *
 * Synchronous and image-free: a file export inlines each floor's underlay afterwards
 * (`export/json.ts`), and storage keeps the underlay under a per-floor key. That split is
 * why `floorplanImage` is optional on `DocumentFloor`.
 */
export function toDocument(options: ToDocumentOptions = {}): ProjectDocumentV3 {
	/*
	 * Coverage is not in the document.
	 *
	 * It is a measurement of the plan as it stands, not a property of the project, and a file
	 * that carries it outlives the plan it describes: the report then prints a figure for a
	 * building that no longer exists, and a reload restores it as if it were data. The field
	 * stays in the *reader* (`migrate` still accepts files that have it) so old projects open;
	 * nothing writes it, and nothing applies it. See `coverageBasis` for how a figure is
	 * invalidated in memory instead.
	 */
	const floorCoverage: Record<string, FloorCoverageEntry> = {};
	void options.floorCoverage;

	return {
		version: DOCUMENT_VERSION,
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
		customMaterials: projectMeta.customMaterials.map(cloneMaterial),
		floorCoverage,
		floors: floorState.floors.map(toDocumentFloor),
		aps: apState.aps.map(toDocumentAp)
	};
}

function toDocumentFloor(floor: Floor): DocumentFloor {
	return {
		id: floor.id,
		name: floor.name,
		level: floor.level,
		ceilingHeight: floor.ceilingHeight,
		floorThickness: floor.floorThickness,
		floorMaterial: floor.floorMaterial,
		floorplanScale: floor.floorplanScale,
		floorplanOffsetX: floor.floorplanOffsetX,
		floorplanOffsetY: floor.floorplanOffsetY,
		calibration: floor.calibration ? { ...floor.calibration } : null,
		floorplanBoundary: floor.floorplanBoundary
			? floor.floorplanBoundary.map((point) => ({ x: point.x, y: point.y }))
			: null,
		wallMask: cloneMask(floor.wallMask),
		wallAttenuation: floor.wallAttenuation,
		wallMaterial: floor.wallMaterial,
		materialMask: cloneMask(floor.materialMask),
		roomTypeMask: cloneMask(floor.roomTypeMask),
		roomDensityOverrides: { ...(floor.roomDensityOverrides ?? {}) },
		roomCustomLabels: { ...(floor.roomCustomLabels ?? {}) },
		planningArea: floor.planningArea
			? floor.planningArea.map((point) => ({ x: point.x, y: point.y }))
			: null,
		notes: (floor.notes ?? []).map((note) => ({ ...note })),
		walls: (floor.walls ?? []).map((wall) => ({ ...wall })),
		columns: (floor.columns ?? []).map((column) => ({ ...column })),
		surfaces: (floor.surfaces ?? []).map((surface) => ({ ...surface }))
	};
}

/**
 * One access point, field by field.
 *
 * Written out rather than spread so that adding a field to `AccessPoint` shows up here as a
 * type error — which is the same reason `optimizer-protocol.ts` derives its payload type
 * from `AccessPoint` instead of restating it.
 */
function toDocumentAp(ap: AccessPoint): AccessPoint {
	return {
		id: ap.id,
		name: ap.name,
		x: ap.x,
		y: ap.y,
		band: ap.band,
		channelWidth: ap.channelWidth,
		fixedChannel: ap.fixedChannel,
		assignedChannel: ap.assignedChannel,
		interferenceRadius: ap.interferenceRadius,
		power: ap.power,
		modelId: ap.modelId,
		modelLabel: ap.modelLabel,
		floorId: ap.floorId,
		mount: ap.mount,
		mountHeightM: ap.mountHeightM,
		beamwidthDeg: ap.beamwidthDeg,
		aimDeg: ap.aimDeg,
		facingDeg: ap.facingDeg,
		pinned: ap.pinned
	};
}

/* ── Reading ──────────────────────────────────────────────────────────────────────────── */

/**
 * Turn anything a store or a file handed back into a normalised document, or null.
 *
 * Version 2 is the single-floor format: its fields sat at the top level and one is turned
 * into the one floor of a version 3 document. Anything older than 2 (or with no version at
 * all) is refused, which is what both callers already did.
 */
/**
 * Was this document written by a version of the app that is newer than this one?
 *
 * `migrate` cannot read such a document, and the caller must not treat it as corrupt: deleting it
 * is the difference between "this build cannot open your project" and "your project is gone". The
 * check is separate from `migrate` because the two answers lead to different actions — one removes
 * the record, the other keeps it and says why.
 */
export function isFromNewerVersion(raw: unknown): boolean {
	if (!raw || typeof raw !== 'object') return false;
	const version = (raw as RawDocument).version;
	return typeof version === 'number' && version > DOCUMENT_VERSION;
}
export function migrate(raw: unknown): ProjectDocumentV3 | null {
	if (!raw || typeof raw !== 'object') return null;
	const data = raw as RawDocument;
	const version = typeof data.version === 'number' ? data.version : 0;
	// Anything outside 2..CURRENT is not a document this build can honestly rewrite: below 2 there
	// is no migration, and above it the fields are unknown, so writing back would drop them.
	const documentVersion = DOCUMENT_VERSION;
	if (version < 2 || version > documentVersion) return null;

	const storedFloors: StoredFloor[] =
		version === 2
			? [
					{
						id: crypto.randomUUID(),
						name: 'Floor 1',
						level: 0,
						ceilingHeight: 3,
						floorMaterial: 1,
						floorThickness: 0.2,
						floorplanImage: data.floorplanImage,
						floorplanScale: data.floorplanScale,
						floorplanOffsetX: data.floorplanOffsetX,
						floorplanOffsetY: data.floorplanOffsetY,
						calibration: data.calibration ?? null,
						floorplanBoundary: data.floorplanBoundary ?? null,
						wallMask: data.wallMask ?? null,
						materialMask: data.materialMask ?? null,
						roomTypeMask: null,
						wallAttenuation: data.wallAttenuation,
						// A stored material id is a wall material id by construction; the raw
						// document only knows it as a number.
						wallMaterial: data.wallMaterial as WallMaterialId | undefined
					}
				]
			: (data.floors ?? []);

	// A document with no floors is not a project: both callers treat it as "nothing to load".
	if (storedFloors.length === 0) return null;

	const floors = storedFloors.map(normalizeFloor);
	const band = data.band ?? '5ghz';
	const channelWidth = data.channelWidth ?? 20;
	const fallbackFloorId = floors[0]!.id;

	return {
		version: DOCUMENT_VERSION,
		name: data.name || 'Untitled Project',
		band,
		channelWidth,
		regulatoryDomain: data.regulatoryDomain ?? 'fcc',
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
		customMaterials: (data.customMaterials ?? []).map(cloneMaterial),
		floorCoverage: filterCoverage(data.floorCoverage, floors),
		floors,
		aps: (data.aps ?? []).map((ap) =>
			normalizeAp(ap, floors, ap.floorId || fallbackFloorId, band, channelWidth)
		)
	};
}

function normalizeFloor(stored: StoredFloor, index: number): DocumentFloor {
	return {
		id: stored.id,
		name: stored.name ?? `Floor ${index + 1}`,
		level: stored.level ?? index,
		ceilingHeight: stored.ceilingHeight ?? 3,
		floorThickness: stored.floorThickness ?? 0.2,
		floorMaterial: (stored.floorMaterial ?? 1) as FloorMaterialId,
		floorplanScale: stored.floorplanScale ?? 0.4,
		floorplanOffsetX: stored.floorplanOffsetX ?? 0,
		floorplanOffsetY: stored.floorplanOffsetY ?? 0,
		calibration: stored.calibration
			? { worldUnitsPerMeter: stored.calibration.worldUnitsPerMeter }
			: null,
		floorplanBoundary: stored.floorplanBoundary
			? stored.floorplanBoundary.map((point) => ({ x: point.x, y: point.y }))
			: null,
		wallMask: normalizeMask(stored.wallMask),
		wallAttenuation: stored.wallAttenuation ?? 5,
		wallMaterial: (stored.wallMaterial ?? 0) as WallMaterialId,
		materialMask: normalizeMask(stored.materialMask),
		roomTypeMask: normalizeMask(stored.roomTypeMask),
		roomDensityOverrides: { ...(stored.roomDensityOverrides ?? {}) },
		roomCustomLabels: { ...(stored.roomCustomLabels ?? {}) },
		planningArea: stored.planningArea
			? stored.planningArea.map((point) => ({ x: point.x, y: point.y }))
			: null,
		notes: (stored.notes ?? []).map((note) => ({ ...note })),
		walls: (stored.walls ?? []).map((wall) => ({ ...wall })),
		columns: (stored.columns ?? []).map((column) => ({ ...column })),
		surfaces: (stored.surfaces ?? []).map((surface) => ({ ...surface })),
		floorplanImage: stored.floorplanImage
	};
}

function normalizeMask(mask: StoredMask | null | undefined): DocumentMask | null {
	if (!mask || !mask.dataUrl) return null;
	return {
		dataUrl: mask.dataUrl,
		width: mask.width,
		height: mask.height,
		originX: mask.originX ?? 0,
		originY: mask.originY ?? 0
	};
}

/**
 * The document's floor as the state's floor: the one field the two shapes disagree about.
 *
 * A document carries the underlay as a data URL (`floorplanImage`) because that is what a
 * file can hold; the state carries it as a URL (`floorplanUrl`) because the canvas draws
 * from one. Nothing else differs, and the two are named apart on purpose — a `floorplanUrl`
 * in a document would be a `blob:` URL that dies with the session that wrote it.
 */
function toStateFloor(floor: DocumentFloor): Floor {
	const { floorplanImage, ...rest } = floor;
	return { ...rest, floorplanUrl: floorplanImage ?? null };
}

/**
 * One access point with the fields older documents could not have.
 *
 * The defaults are the reading rules, and each one is the value that model would have used:
 * a document written before mounting heights existed put every AP on the ceiling, one
 * written before the antenna cuts had the band's own pattern, and so on. They used to be
 * spelled out twice — once for a stored project, once for an imported file — with small
 * differences that were not decisions (the file path defaulted a name to `AP`, the store
 * path did not).
 */
function normalizeAp(
	stored: StoredAp,
	floors: ReadonlyArray<Pick<Floor, 'id' | 'ceilingHeight'>>,
	floorId: string,
	fallbackBand: Band,
	fallbackChannelWidth: ChannelWidth
): AccessPoint {
	const band = stored.band ?? fallbackBand;
	const ceiling = floors.find((floor) => floor.id === floorId)?.ceilingHeight ?? 3;
	const storedMount = stored.mount;
	const mount: ApMount =
		storedMount === 'floor' || storedMount === 'ceiling' || storedMount === 'wall'
			? storedMount
			: 'ceiling';
	// The band's own antenna, for a document written before the vertical cut existed or
	// with a band the AP has since changed to.
	const antenna = defaultAntenna(stored.beamwidthDeg ?? null, band);

	return {
		id: stored.id,
		name: stored.name || 'AP',
		x: stored.x ?? 0,
		y: stored.y ?? 0,
		band,
		channelWidth: stored.channelWidth ?? fallbackChannelWidth,
		fixedChannel: stored.fixedChannel ?? null,
		assignedChannel: stored.assignedChannel ?? null,
		interferenceRadius: stored.interferenceRadius ?? 150,
		power: stored.power ?? 20,
		modelId: stored.modelId ?? null,
		modelLabel: stored.modelLabel ?? null,
		floorId,
		mount,
		mountHeightM: stored.mountHeightM ?? defaultMountHeight(mount, ceiling),
		beamwidthDeg: stored.beamwidthDeg ?? antenna.beamwidthDeg,
		aimDeg: stored.aimDeg ?? antenna.aimDeg,
		// Facing +x. A document written before wall mounts cannot say which way the unit
		// looked, and the band's antenna is an omni with no direction at all.
		facingDeg: stored.facingDeg ?? 0,
		// A document written before pinning described APs the optimiser was free to move.
		pinned: stored.pinned ?? false
	};
}

/* ── Applying ─────────────────────────────────────────────────────────────────────────── */

/**
 * Write a normalised document into the state atoms.
 *
 * The order matters and is the order a load has always needed: floors before access points,
 * because a ceiling-mounted AP's default height and the project's scale both come from the
 * floors; the path-loss scenario before the radii, because a radius is derived from it.
 *
 * **Opening a document ends the undo history.** Undo snapshots hold floors and access points
 * and nothing else, so a snapshot from before a load would restore one project's geometry
 * into another project's name, band, unit system and materials — a combination that never
 * existed, autosaved into place five seconds later. Every caller that replaced the document
 * had to remember this, and `export/json.ts` did not: importing a file and pressing Ctrl+Z
 * put the *previous* project's plan inside the imported project's settings. It is done here
 * now, where the document is applied, so no caller has to know.
 */
export function applyDocument(
	doc: ProjectDocumentV3,
	options: ApplyDocumentOptions = {}
): void {
	clearHistory();

	// The document is already normalised (`migrate` or `toDocument` built it); the only
	// translation left is the underlay's storage shape.
	const floors: Floor[] = doc.floors.map(toStateFloor);
	if (floors.length === 0) throw new Error('a project document needs at least one floor');

	projectMeta.name = doc.name;
	projectMeta.ispSpeed = doc.ispSpeed;
	projectMeta.targetThroughput = doc.targetThroughput;
	projectMeta.allowOutsideRooms = doc.allowOutsideRooms;
	projectMeta.heatmapRssiFloor = doc.heatmapRssiFloor;
	projectMeta.clientHeight = doc.clientHeight;
	projectMeta.interferenceWeight = doc.interferenceWeight;
	projectMeta.coverageSoftnessDb = doc.coverageSoftnessDb;
	projectMeta.coverageFloorPct = doc.coverageFloorPct;
	projectMeta.coverageFloorEveryFloor = doc.coverageFloorEveryFloor;
	projectMeta.pathLossScenario = doc.pathLossScenario;
	// The user's own wall materials before the floors, so a wall painted with one of these
	// is read back with the material it was painted with.
	projectMeta.customMaterials = doc.customMaterials.map(cloneMaterial);

	apState.band = doc.band;
	apState.channelWidth = doc.channelWidth;
	apState.regulatoryDomain = doc.regulatoryDomain;
	floorplanState.unitSystem = doc.unitSystem;

	floorState.floors = floors;
	floorState.currentFloorId = floors[0]!.id;
	apState.aps = doc.aps.map((ap) =>
		normalizeAp(ap, floors, ap.floorId || floors[0]!.id, doc.band, doc.channelWidth)
	);

	// The stored radii describe whichever propagation model was in force when the document
	// was written, so select the model first and then derive them again.
	setPathLossScenario(projectMeta.pathLossScenario);
	refreshApRanges();

	/*
	 * No coverage is applied, even when the file carries it.
	 *
	 * A figure from the file was measured by a previous session against a plan this one has
	 * not verified, and applying it means the panel and the report show a number for a
	 * building that may not be the one now open. The pass that runs after this produces a
	 * real one; until then the interface says it has none.
	 */
	void options.floorCoverage;
}

/* ── Shared helpers ───────────────────────────────────────────────────────────────────── */

function cloneMask(mask: DocumentMask | null): DocumentMask | null {
	return mask
		? {
				dataUrl: mask.dataUrl,
				width: mask.width,
				height: mask.height,
				originX: mask.originX,
				originY: mask.originY
			}
		: null;
}

function cloneMaterial(material: DocumentCustomMaterial): DocumentCustomMaterial {
	return {
		id: material.id,
		name: material.name,
		dbPerCrossing: material.dbPerCrossing,
		thicknessM: material.thicknessM,
		color: [material.color[0], material.color[1], material.color[2]]
	};
}

/**
 * Keep only the coverage rows that describe a floor the document still has.
 *
 * A row for a deleted floor would otherwise come back as a phantom in the building mean.
 */
function filterCoverage(
	raw: Record<string, Partial<FloorCoverageEntry>> | undefined,
	floors: ReadonlyArray<{ id: string }>
): Record<string, FloorCoverageEntry> {
	const out: Record<string, FloorCoverageEntry> = {};
	if (!raw) return out;
	for (const floor of floors) {
		const entry = raw[floor.id];
		if (!entry || typeof entry.coverage !== 'number') continue;
		out[floor.id] = {
			coverage: entry.coverage,
			samples: typeof entry.samples === 'number' ? entry.samples : 1
		};
	}
	return out;
}
