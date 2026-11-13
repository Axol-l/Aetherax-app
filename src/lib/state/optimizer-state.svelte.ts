/**
 * 优化器对外暴露的状态
 */
import { SvelteMap } from 'svelte/reactivity';
import { apState, wupmForFloor } from './ap-state.svelte.js';
import { floorState } from './floor-state.svelte.js';
import { isInsideInterior } from './ap-interior.js';
import { projectMeta } from './project-meta.svelte.js';
import { isUsablePlanningArea, pointInPlanningArea } from './planning-area.js';
import { antennaSignature } from '$lib/rf/antenna.js';



export const optimizerState = $state({
	isRunning: false,
	progress: 0,
	score: 0,
	coverage: 0, // 实时覆盖百分比，AP 或掩膜变化时更新
	error: null as string | null,
	/** 多楼层运行当前在干什么 */
	status: '',
	/**
	 * 上一次全楼运行得到的整栋覆盖率：按各层样本数加权平均。
	 */
	buildingCoverage: null as number | null,
	/** 上次全楼运行里最差的楼层：百分比和名称。 */
	worstFloor: null as { id: string; name: string; coverage: number } | null,
	/**
	 * 当前布局的同频干扰占比（百分比），取自最近一次评估它的运行。
	 * 它是目标函数里和覆盖做权衡的另一半：分数 = `coverageUtility − interferenceWeight · interference`。
	 */
	interference: 0,
	/**
	 * 本层上有两个信道重叠的 AP 都高于 CCA 门限（20 MHz 时约 −82 dBm）的面积占比，百分比。
	 */
	contention: 0,
	/**
	 * 是否已经对屏幕上这份布局真正测过干扰。
	 */
	interferenceMeasured: false,
	interferenceKnown: true,
	/** 上次全楼运行交替跑了几轮。 */
	passes: 0,
	/**
	 * 一层上把优化器跑几遍、取最好的一次。
	 *
	 * 默认 1 。大于 1 时每次用不同种子
	 */
	restarts: 1,
	/**
	 * 上次运行结束的时间戳（epoch 毫秒），没跑过为 null。
	 */
	lastRunAt: null as number | null,
	/**
	 * 上次运行开始时的评分设置，见 `scoringSettingsSignature`。
	 *
	 * 和 `lastRunAt` 一起记：只留时间戳的话，用户改完权重再回来看，面板上的数字没有任何
	 * 东西说明它来自旧设置——而那个布局确实是按旧设置选出来的。
	 */
	settingsAtRun: null as string | null
});

/**
 * 按楼层缓存的覆盖结果：floorId → { 覆盖百分比, 样本数（当作面积的近似） }。
 */
export const floorCoverage = new SvelteMap<string, FloorCoverageEntry>();

/**
 * 一个覆盖数字，以及它是在哪份方案上测出来的。
 */
export interface FloorCoverageEntry {
	coverage: number;
	samples: number;
	/** 估算的并发终端数；没有房间密度数据时为 0。 */
	devices?: number;
	/** 粗粒度业务容量规划；没有房间类型/密度数据时缺省。 */
	traffic?: {
		demandMbps: number;
		supplyMbps: number;
		perApCapacityMbps: number;
		requiredAps: number;
		apCount: number;
		utilization: number;
		activityFactor: number;
		medianEdgeSnrDb: number;
	};
	/** 这个数字对应的方案。从文件恢复的数据没有这一项。 */
	basis?: string;
}

/** 给掩膜对象一个身份编号，供下面的 basis 用。 */
const maskIds = new WeakMap<object, number>();
let nextMaskId = 1;
function maskId(mask: object | null | undefined): string {
	if (!mask) return '0';
	let id = maskIds.get(mask);
	if (id === undefined) {
		id = nextMaskId++;
		maskIds.set(mask, id);
	}
	return String(id);
}

/**
 * 某层的覆盖数字是在哪份方案上测出来的
 */
export function coverageBasis(floorId: string): string {
	const floor = floorState.floors.find((f) => f.id === floorId);
	if (!floor) return 'missing';
	const aps = apState.aps
		.filter((ap) => ap.floorId === floorId)
		.map(
			(ap) =>
				`${ap.id}:${Math.round(ap.x)},${Math.round(ap.y)}:${ap.power}:` +
				`${ap.band}:${ap.channelWidth}:${ap.assignedChannel ?? ''}:${ap.mount}:` +
				`${ap.mountHeightM}:${antennaSignature(ap)}`
		)
		.sort()
		.join('|');
	const mask = floor.wallMask;
	return [
		maskId(mask),
		mask ? `${mask.width}x${mask.height}@${mask.originX ?? 0},${mask.originY ?? 0}` : 'no-mask',
		maskId(floor.materialMask),
		maskId(floor.roomTypeMask),
		floor.wallMaterial,
		Math.round(wupmForFloor(floorId) * 100),
		/*
		 * 影响这个数字的设置也要算进 basis。
		 *
		 * 少了门限这一项时，改门限只重算当前楼层，其余楼层缓存里的数字还是旧门限下量的，
		 * 切回去时 basis 又对得上、不会被丢弃——同一份工程里两层用了两个门限。
		 * 客户高度是同一类问题：它改变每个采样点的垂直距离。
		 * `coverageSoftnessDb` 不改覆盖率读数，但它是同一次评分的一部分；放进来，
		 * 「这个数字属于哪套设置」就只有一个答案。
		 */
		projectMeta.coverageThresholdDbm,
		Math.round(projectMeta.clientHeight * 100),
		projectMeta.coverageSoftnessDb,
		aps
	].join('~');
}

/**
 * 影响优化结果的那组设置，拼成一个可比较的签名。
 *
 * 只放真的会改变评分或可行域的量：显示相关的（热力图下限）不在其中，
 * 重启次数也不在——它决定下次能找到多好的解，不改变已经选出来的布局是否成立。
 */
export function scoringSettingsSignature(): string {
	return [
		projectMeta.allowOutsideRooms ? '1' : '0',
		projectMeta.coverageThresholdDbm,
		Math.round(projectMeta.clientHeight * 100),
		projectMeta.interferenceWeight,
		projectMeta.coverageSoftnessDb,
		projectMeta.coverageFloorPct,
		projectMeta.pathLossScenario
	].join('|');
}

/**
 * 屏幕上这个布局是不是按当前设置选出来的。
 *
 * 设置改过、又没重新跑，就是 true。它读的是响应式状态，所以可以直接放进 `$derived`。
 */
export function resultIsStale(): boolean {
	return (
		optimizerState.lastRunAt !== null &&
		optimizerState.settingsAtRun !== null &&
		optimizerState.settingsAtRun !== scoringSettingsSignature()
	);
}

/**
 * 把所有已经不能描述当前方案的覆盖数字删掉。
 */
export function dropStaleCoverage(): void {
	for (const [floorId, entry] of floorCoverage) {
		if (entry.basis !== coverageBasis(floorId)) floorCoverage.delete(floorId);
	}
}

/**
 * 落在本层识别出的室内区域之外的 AP 名称。
 */
export async function apsOutsideInterior(): Promise<string[]> {
	if (projectMeta.allowOutsideRooms) return [];
	const outside: string[] = [];
	for (const ap of apState.aps) {
		if (ap.mount === 'wall') continue;
		// The planning area belongs to the AP's own floor, not whichever floor is on screen.
		const planned = floorState.floors.find((floor) => floor.id === ap.floorId)?.planningArea;
		const hasPlan = isUsablePlanningArea(planned);
		const inside = hasPlan
			? pointInPlanningArea({ x: ap.x, y: ap.y }, planned!)
			: await isInsideInterior(ap.floorId, ap.x, ap.y);
		if (!inside) outside.push(ap.name);
	}
	return outside;
}

/**
 * 换工程时清掉上一次运行留下的东西。
 *
 * 时间戳和设置签名都是「这份工程的这次运行」的标记，跟着文件走就会指错工程：
 * 布点建议会按别的工程的布局开药方，「设置已改」也会立刻误报。
 */
export function resetRunHistory(): void {
	optimizerState.lastRunAt = null;
	optimizerState.settingsAtRun = null;
	optimizerState.buildingCoverage = null;
	optimizerState.worstFloor = null;
	optimizerState.passes = 0;
}

/** 有数据的各楼层覆盖率的加权平均。 */
export function getBuildingCoverage(): number {
	if (floorCoverage.size === 0) return 0;
	let totalWeighted = 0;
	let totalSamples = 0;
	for (const { coverage, samples } of floorCoverage.values()) {
		totalWeighted += coverage * samples;
		totalSamples += samples;
	}
	return totalSamples > 0 ? Math.round(totalWeighted / totalSamples) : 0;
}