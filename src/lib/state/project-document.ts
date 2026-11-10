/**
 * 工程文档：统一的结构、迁移、读入和写出。
 */
import type { Band, ChannelWidth, RegulatoryDomain } from '@aetherax/channels';
import type { FloorMaterialId } from '$canvas/floor-materials.js';
import type { WallMaterialId } from '$lib/domain/materials.js';
import { defaultAntenna } from '../rf/antenna.js';
import {
	setCoverageThresholdDbm,
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
import { resetRunHistory } from './optimizer-state.svelte.js';
import { DEFAULT_SETTINGS } from './project-settings.js';

/** 本模块写出的版本号。存储字段的含义一变就要加一。 */
export const DOCUMENT_VERSION = 3;

export type UnitSystem = 'imperial' | 'metric';

/**
 * 文档里可能带的遮罩。
 *
 * 原点是可选的：早期文档里遮罩还没记自己的坐标系。
 * 读进来时统一补成 `{ originX: 0, originY: 0 }`。
 */
export interface StoredMask {
	dataUrl: string;
	width: number;
	height: number;
	originX?: number;
	originY?: number;
}

/** 规范化文档里的遮罩：坐标系一定已知。 */
export type DocumentMask = NonNullable<Floor['wallMask']>;

/**
 * 规范化文档里的一个楼层。
 *
 * 从 `Floor` 减掉两样文档带不了（或带起来太贵）的东西：底板图的会话 URL
 *（文件里内联成 `floorplanImage`，存储里单独一个键）和几何列表。
 * 几何在这里改成必填，因为以前复制出来的几份结构正好漏了它们。
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
	/** 底板图存成 data URL。文件里有，存储里没有。 */
	floorplanImage?: string;
};

export type StoredFloor = Partial<
	Omit<DocumentFloor, 'wallMask' | 'materialMask' | 'roomTypeMask'>
> & {
	id: string;
	wallMask?: StoredMask | null;
	materialMask?: StoredMask | null;
	roomTypeMask?: StoredMask | null;
};

/**
 * 文档「可能」带的接入点。
 */
export type StoredAp = Partial<AccessPoint> & Pick<AccessPoint, 'id'>;

/** 用户自己加的墙体材质，按工程里的存储形状。 */
export interface DocumentCustomMaterial {
	id: number;
	name: string;
	dbPerCrossing: number;
	thicknessM: number;
	color: [number, number, number];
}

/** 某层实测覆盖率，按优化器缓存的报法。 */
export interface FloorCoverageEntry {
	coverage: number;
	samples: number;
}

/** 规范化后的工程文档：本模块写出的、也是交回来的东西。 */
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
	coverageThresholdDbm: number;
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
 * `JSON.parse` 出来的任何东西。
 *
 * 只在边界上转一次类型，后面交给下面的规范化函数；否则就是十几个地方各写一次 `(data as any)`，
 * 字段漏了也没人发现。
 */
type RawDocument = Partial<
	Omit<ProjectDocumentV3, 'version' | 'floors' | 'aps' | 'customMaterials' | 'floorCoverage'>
> & {
	version?: number;
	floors?: StoredFloor[];
	aps?: StoredAp[];
	customMaterials?: DocumentCustomMaterial[];
	floorCoverage?: Record<string, Partial<FloorCoverageEntry>>;
	/* 版本 2 把单层数据放在顶层。 */
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

/** 存放文档里各层覆盖率的地方。 */
export interface CoverageSink {
	clear(): void;
	set(floorId: string, entry: FloorCoverageEntry): void;
}

export interface ToDocumentOptions {
	/** 各层实测覆盖率，来自优化器缓存。 */
	floorCoverage?: ReadonlyMap<string, FloorCoverageEntry>;
}

export interface ApplyDocumentOptions {
	/** 调用方自己维护缓存时，文档里的各层覆盖率放哪。 */
	floorCoverage?: CoverageSink;
}

/* ── 写出 ─────────────────────────────────────────────────────────────────────────────── */

/**
 * 整个工程，写成文档。
 *
 * 同步且不含图片：导出文件时由 `export/json.ts` 事后把每层底板图内联进去，
 * 存储则每层单独一个键——所以 `floorplanImage` 在 `DocumentFloor` 上才是可选的。
 */
export function toDocument(options: ToDocumentOptions = {}): ProjectDocumentV3 {
	/*
	 * 覆盖率不写进文档。
	 *
	 * 它是「当前这张图」的测量值，不是工程的属性。写进文件会活得比图还久：
	 * 报告给一栋已经不存在的楼打分，重载时又当成数据恢复回来。
	 * 读入端还留着这个字段（`migrate` 接受带它的旧文件），但没人写、也没人应用——
	 * 内存里怎么让数字失效，见 `coverageBasis`。
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
		coverageThresholdDbm: projectMeta.coverageThresholdDbm,
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
 * 一个接入点，逐字段写。
 *
 * 一个个列出来而不是展开对象：这样 `AccessPoint` 加了字段，这里会直接报类型错。
 * `optimizer-protocol.ts` 从 `AccessPoint` 推导载荷类型而不是重写一遍，也是这个原因。
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
		polarizationAngleDeg: ap.polarizationAngleDeg ?? 0,
		pinned: ap.pinned,
		clients: ap.clients ?? null
	};
}

/* ── 读取 ─────────────────────────────────────────────────────────────────────────────── */

/**
 * 把存储或文件交回来的任何东西，变成规范化文档；不行就返回 null。
 *
 * 版本 2 是单层格式：字段都放在顶层，这里把它变成版本 3 文档里的那一层。
 * 比 2 更老的（或者没有版本号的）一律拒绝，两个调用方本来就是这么做的。
 */
/**
 * 这份文档是不是比当前版本更新的应用写的？
 *
 * `migrate` 读不了它，但调用方不能当成损坏删掉：删不删，就是「这版打不开」和「工程没了」的区别。
 * 单独一个函数而不是塞进 `migrate`，因为两种结果对应两种动作：一个删记录，一个留着并说明原因。
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
	// 版本不在 2..CURRENT 之间，就不是这个版本能老实重写的东西：低于 2 没有迁移，
	// 高于它字段未知，写回去会丢字段。
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
						// 存下来的材质 id 按构造就是墙体材质 id，原始文档只把它当数字。
						wallMaterial: data.wallMaterial as WallMaterialId | undefined
					}
				]
			: (data.floors ?? []);

	// 没有楼层的文档不算工程：两个调用方都当成「没有可加载的东西」。
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
		allowOutsideRooms: data.allowOutsideRooms ?? DEFAULT_SETTINGS.allowOutsideRooms,
		coverageThresholdDbm: data.coverageThresholdDbm ?? DEFAULT_SETTINGS.coverageThresholdDbm,
		clientHeight: data.clientHeight ?? DEFAULT_SETTINGS.clientHeight,
		interferenceWeight: data.interferenceWeight ?? DEFAULT_SETTINGS.interferenceWeight,
		coverageSoftnessDb: data.coverageSoftnessDb ?? DEFAULT_SETTINGS.coverageSoftnessDb,
		coverageFloorPct: data.coverageFloorPct ?? DEFAULT_SETTINGS.coverageFloorPct,
		coverageFloorEveryFloor:
			data.coverageFloorEveryFloor ?? DEFAULT_SETTINGS.coverageFloorEveryFloor,
		pathLossScenario: data.pathLossScenario ?? DEFAULT_SETTINGS.pathLossScenario,
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
 * 文档里的楼层转成状态里的楼层：两种形状只差一个字段。
 *
 * 文档里底板图是 data URL（`floorplanImage`），因为文件只能存这个；
 * 状态里是 URL（`floorplanUrl`），因为画布要拿它画。别的都一样。
 * 两个名字故意分开：文档里要是有 `floorplanUrl`，那就是个 `blob:`，写完它的会话一结束就失效。
 */
function toStateFloor(floor: DocumentFloor): Floor {
	const { floorplanImage, ...rest } = floor;
	return { ...rest, floorplanUrl: floorplanImage ?? null };
}

/**
 * 补上老文档不可能有的字段，得到一个接入点。
 *
 * 这些默认值就是读取规则，每个都是「当时的模型会取的值」：
 * 安装高度出现之前的文档，AP 全算吸顶；天线方向图出现之前的，用频段自带的方向图，等等。
 * 以前存工程和导文件两条路各写一遍，还写出了不是故意的小差别
 *（导入那边默认名字是 `AP`，存储那边不是）。
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
	// 用频段自带的天线：文档可能写于垂直方向图出现之前，也可能 AP 后来换了频段。
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
		// 朝 +x。壁挂出现之前的文档说不出设备朝哪，而频段自带的天线是全向的，根本没有方向。
		facingDeg: stored.facingDeg ?? 0,
		polarizationAngleDeg: stored.polarizationAngleDeg ?? 0,
		// 固定位置出现之前的文档，描述的 AP 都是优化器可以随便挪的。
		pinned: stored.pinned ?? false,
		clients: stored.clients ?? null
	};
}

/* ── 应用 ─────────────────────────────────────────────────────────────────────────────── */

/**
 * 把规范化文档写进各个状态。
 */
export function applyDocument(
	doc: ProjectDocumentV3,
	options: ApplyDocumentOptions = {}
): void {
	clearHistory();

	// 文档已经是规范化的（`migrate` 或 `toDocument` 建的），只剩底板图的存储形状要转。
	const floors: Floor[] = doc.floors.map(toStateFloor);
	if (floors.length === 0) throw new Error('a project document needs at least one floor');

	/*
	 * 上一次运行的标记属于上一份工程。不清掉的话，布点建议会拿另一栋楼的测量结果
	 * 给这栋楼开药方，「设置已改」也会把它误报成旧设置。
	 */
	resetRunHistory();

	projectMeta.name = doc.name;
	projectMeta.ispSpeed = doc.ispSpeed;
	projectMeta.targetThroughput = doc.targetThroughput;
	projectMeta.allowOutsideRooms = doc.allowOutsideRooms;
	projectMeta.coverageThresholdDbm = doc.coverageThresholdDbm;
	projectMeta.clientHeight = doc.clientHeight;
	projectMeta.interferenceWeight = doc.interferenceWeight;
	projectMeta.coverageSoftnessDb = doc.coverageSoftnessDb;
	projectMeta.coverageFloorPct = doc.coverageFloorPct;
	projectMeta.coverageFloorEveryFloor = doc.coverageFloorEveryFloor;
	projectMeta.pathLossScenario = doc.pathLossScenario;
	// 用户自定义材质要排在楼层前面，这样用这些材质刷的墙，读回来还是那个材质。
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

	// 存下来的半径是按写文档时的传播模型算的，所以先选模型，再把半径重新推一遍。
	setPathLossScenario(projectMeta.pathLossScenario);
	setCoverageThresholdDbm(projectMeta.coverageThresholdDbm);
	refreshApRanges();

	/*
	 * 不应用覆盖率，哪怕文件里带着。
	 *
	 * 文件里的数字是上一次会话按那张图量的，这次还没验证过；应用它，
	 * 面板和报告就会给一栋可能不是当前这栋的楼报数。这一步之后会跑一遍真的计算，
	 * 在那之前界面就说「还没有」。
	 */
	void options.floorCoverage;
}

/* ── 共用的小工具 ─────────────────────────────────────────────────────────────────────── */

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
 * 只留下文档里还有的楼层的覆盖率。
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
