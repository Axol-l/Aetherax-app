/**
 * AP 状态：AP 列表的增删改，以及安装高度、天线方向图和干扰半径的推导。
 *
 * 热力图、优化器和 worker 都从这里取 AP 的几何和射频参数。
 */
import type { Band, ChannelWidth, RegulatoryDomain } from '@aetherax/channels';
import { pushState } from './history.svelte.js';
import { scheduleSave } from './persistence.svelte.js';
import { rangeFromPower } from '../rf/propagation.js';
import { crossFloorSplitFor, crossFloorVerticalGap, floorState, getFloor } from './floor-state.svelte.js';
import {
	antennaProfileForMount,
	defaultAntenna,
	normaliseBearing,
	type AntennaProfile
} from '../rf/antenna.js';

/**
 * AP 的安装方式，只从高度这个角度区分。
 *
 * 壁挂和另外两种不一样：它从墙上往房间里辐射，除了高度还有平面上的朝向（`facingDeg`），
 * 而且必须贴着一面墙才有意义。
 */
export type ApMount = 'ceiling' | 'floor' | 'wall';

/** 安装高度预设，单位是米，从所在楼层的地面算起。 */
export interface MountPreset {
	mount: ApMount;
	label: string;
	/**
	 * 预设高度；null 表示跟着楼层走。
	 */
	metres: number | null;
}

/**
 * 安装预设，顺序就是界面上列出的顺序。
 */
export const MOUNT_PRESETS: readonly MountPreset[] = [
	{ mount: 'ceiling', label: 'Ceiling mount', metres: null },
	{ mount: 'floor', label: 'Floor mount', metres: 0.8 },
	// 壁挂支架，取支架常见的安装高度——高过家具和走过的人，又低于天花板。
	// 高度仍然可改；朝向是 `facingDeg`，不属于预设的一部分。
	{ mount: 'wall', label: 'Wall mount', metres: 2 }
];

/** 吸顶安装时 AP 挂在天花板下方多远，单位米。 */
export const CEILING_MOUNT_DROP_M = 0.1;

/**
 * 某个预设在这个天花板高度的楼层上对应多高，单位米。
 */
export function defaultMountHeight(mount: ApMount, ceilingHeightM: number): number {
	const preset = MOUNT_PRESETS.find((p) => p.mount === mount) ?? MOUNT_PRESETS[0]!;
	const metres = preset.metres ?? ceilingHeightM - CEILING_MOUNT_DROP_M;
	// 不能低于地面，也不能穿到楼上的板里。
	return Math.min(Math.max(metres, 0), Math.max(ceilingHeightM, 0));
}

export interface AccessPoint {
	id: string;
	name: string;
	x: number;
	y: number;
	band: Band;
	channelWidth: ChannelWidth;
	fixedChannel: number | null;
	assignedChannel: number | null;
	interferenceRadius: number;
	power: number;
	modelId: string | null;
	modelLabel: string | null;
	floorId: string;
	/**
	 * AP 装在哪里、离本层地面多高。
	 */
	mount: ApMount;
	mountHeightM: number;
	/**
	 * 天线的垂直切面
	 */
	beamwidthDeg: number;
	aimDeg: number;
	/**
	 * 壁挂AP 朝哪个方向，单位是平面角度：0 是 +x，正方向转向 +y
	 */
	facingDeg: number;
	/**
	 * 优化器是否必须让这个 AP 原地不动
	 */
	pinned: boolean;
	/**
	 * 这个 AP 计划承载的并发终端数。null 表示沿用工程默认值。
	 */
	clients?: number | null;
}

let nextApNumber = 1;

function createId(): string {
	return crypto.randomUUID();
}

/** 平面图没有标定时的默认比例（约每英尺 10 个世界坐标单位）。 */
export const DEFAULT_WUPM = 10 * 3.28084;

/**
 * 某个楼层的世界坐标单位每米（wupm）。
 */
export function wupmForFloor(floorId: string | null | undefined): number {
	const floor = floorId ? getFloor(floorId) : undefined;
	return floor?.calibration?.worldUnitsPerMeter ?? DEFAULT_WUPM;
}

/**
 * 当前楼层的世界坐标单位每米（wupm）。
 */
export function getEffectiveWupm(): number {
	return wupmForFloor(floorState.currentFloorId);
}

/** 按发射功率和频段算出干扰半径（世界坐标单位）。 */
export function radiusFromPower(
	power: number,
	band: string,
	wupm: number = getEffectiveWupm()
): number {
	const meters = rangeFromPower(power, band);
	return Math.round(meters * wupm);
}

/**
 * 按每台 AP 的功率和频段重算干扰半径。
 */
export function refreshApRanges(): void {
	for (const ap of apState.aps) {
		ap.interferenceRadius = radiusFromPower(ap.power, ap.band, wupmForFloor(ap.floorId));
	}
}

export const apState = $state({
	band: '5ghz' as Band,
	channelWidth: 20 as ChannelWidth,
	regulatoryDomain: 'fcc' as RegulatoryDomain,
	aps: [] as AccessPoint[]
});

/**
 * AP 在它所在楼层上的建模高度，从本层地面量起，单位米。
 */
export function apHeightAboveFloor(ap: Pick<AccessPoint, 'floorId' | 'mountHeightM'>): number {
	const ceiling = getFloor(ap.floorId)?.ceilingHeight ?? 0;
	return Math.min(Math.max(ap.mountHeightM, 0), Math.max(ceiling, 0));
}

/**
 * AP 到位于 `clientFloorId` 的客户端的垂直距离，单位米。
 */
export function apVerticalOffsetTo(
	ap: Pick<AccessPoint, 'floorId' | 'mountHeightM'>,
	clientFloorId: string,
	clientHeight: number
): number {
	if (ap.floorId === clientFloorId) {
		return Math.abs(apHeightAboveFloor(ap) - clientHeight);
	}
	return crossFloorVerticalGap(
		ap.floorId,
		clientFloorId,
		clientHeight,
		apHeightAboveFloor(ap)
	);
}

/**
 * AP 的跨层路径在哪一层换层（两个比例）。
 */
export function apSplitFor(
	ap: Pick<AccessPoint, 'floorId' | 'mountHeightM'>,
	clientFloorId: string,
	clientHeight: number
): { sourceT: number; targetT: number } {
	return crossFloorSplitFor(
		ap.floorId,
		clientFloorId,
		clientHeight,
		apHeightAboveFloor(ap)
	);
}

/**
 * 新 AP 的初始安装方式
 */
function initialMount(prev: AccessPoint | null): { mount: ApMount; mountHeightM: number } {
	const mount = prev?.mount ?? 'ceiling';
	const ceiling = getFloor(floorState.currentFloorId)?.ceilingHeight ?? 3;
	return {
		mount,
		mountHeightM: prev ? prev.mountHeightM : defaultMountHeight(mount, ceiling)
	};
}

/**
 * 模型给某台 AP 用的天线方向图
 */
export function antennaProfileFor(ap: {
	band: string;
	beamwidthDeg: number;
	aimDeg: number;
	mount: ApMount;
	facingDeg: number;
}): AntennaProfile {
	return antennaProfileForMount(ap);
}

/**
 * 新 AP 的初始天线参数：取频段的默认值，保持水平。
 */
function initialAntenna(
	prev: AccessPoint | null,
	band: string
): { beamwidthDeg: number; aimDeg: number; facingDeg: number } {
	if (prev) {
		return { beamwidthDeg: prev.beamwidthDeg, aimDeg: prev.aimDeg, facingDeg: prev.facingDeg };
	}
	const defaults = defaultAntenna(null, band);
	return { beamwidthDeg: defaults.beamwidthDeg, aimDeg: defaults.aimDeg, facingDeg: 0 };
}

export function addAp(
	x: number,
	y: number,
	/**
	 * 新 AP 的朝向：只有继承来的安装方式是壁挂、而且调用方能从靠着的墙算出来时才用。
	 * 其他安装方式忽略它；调用方不知道就给 0。
	 */
	facingDeg = 0,
	/**
	 * 放置工具栏里选的安装方式；null 表示沿用上一台 AP 的。
	 */
	mountOverride: ApMount | null = null
): AccessPoint {
	pushState();
	const prev: AccessPoint | null =
		apState.aps.length > 0 ? (apState.aps[apState.aps.length - 1] ?? null) : null;
	const ceiling = getFloor(floorState.currentFloorId)?.ceilingHeight ?? 3;
	const mount = mountOverride
		? { mount: mountOverride, mountHeightM: defaultMountHeight(mountOverride, ceiling) }
		: initialMount(prev);
	const band = prev?.band ?? apState.band;
	const antenna = initialAntenna(prev, band);

	const ap: AccessPoint = {
		id: createId(),
		name: `AP-${nextApNumber++}`,
		x,
		y,
		band,
		channelWidth: prev?.channelWidth ?? apState.channelWidth,
		fixedChannel: null,
		assignedChannel: null,
		interferenceRadius:
			prev && prev.floorId === floorState.currentFloorId
				? prev.interferenceRadius
				: radiusFromPower(
						prev?.power ?? 20,
						prev?.band ?? apState.band,
						wupmForFloor(floorState.currentFloorId)
					),
		power: prev?.power ?? 20,
		modelId: prev?.modelId ?? null,
		modelLabel: prev?.modelLabel ?? null,
		floorId: floorState.currentFloorId,
		mount: mount.mount,
		mountHeightM: mount.mountHeightM,
		beamwidthDeg: antenna.beamwidthDeg,
		aimDeg: antenna.aimDeg,
		// 放上去就贴着调用方测到的墙时，用那面墙的方向；否则沿用上一台的。
		facingDeg: normaliseBearing(
			mount.mount === 'wall' && facingDeg !== 0 ? facingDeg : antenna.facingDeg
		),
		pinned: false,
		clients: prev?.clients ?? null
	};
	apState.aps.push(ap);
	scheduleSave();
	return ap;
}

export function removeAp(id: string): void {
	const idx = apState.aps.findIndex((ap) => ap.id === id);
	if (idx !== -1) {
		pushState();
		apState.aps.splice(idx, 1);
		if (apState.aps.length === 0) {
			nextApNumber = 1;
		}
		scheduleSave();
	}
}

export function removeAps(ids: string[]): void {
	pushState();
	const idSet = new Set(ids);
	apState.aps = apState.aps.filter((ap) => !idSet.has(ap.id));
	if (apState.aps.length === 0) {
		nextApNumber = 1;
	}
	scheduleSave();
}

/**
 * 改一台 AP 的属性，并确保写进存储
 */
export function updateAp(id: string, changes: Partial<AccessPoint>): void {
	const ap = apState.aps.find((a) => a.id === id);
	if (ap) {
		Object.assign(ap, changes);
		scheduleSave(true);
	}
}

export function beginMove(): void {
	pushState();
}

export function moveAp(id: string, x: number, y: number): void {
	const ap = apState.aps.find((a) => a.id === id);
	if (ap) {
		ap.x = x;
		ap.y = y;
	}
}

/**
 * 转动一台 AP，不安排保存。
 *
 * 拖动时每次指针移动都会写（壁挂 AP 会跟着墙转），
 * 保存统一在松手时安排一次。
 */
export function faceAp(id: string, facingDeg: number): void {
	const ap = apState.aps.find((a) => a.id === id);
	if (ap) ap.facingDeg = normaliseBearing(facingDeg);
}

export function clearAssignments(): void {
	for (const ap of apState.aps) {
		ap.assignedChannel = null;
	}
}

/** 重置 AP 编号（清空工程时调用） */
export function resetApNumbering(): void {
	nextApNumber = 1;
}
