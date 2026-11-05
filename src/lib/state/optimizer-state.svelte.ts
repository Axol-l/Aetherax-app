/**
 * 优化器对外暴露的状态。
 *
 * 单独成一个模块，是为了让"一次运行"和"实时覆盖计算"互不 import 也能读同一份数；
 * 按楼层缓存的覆盖结果也放这里，理由相同。
 */
import { SvelteMap } from 'svelte/reactivity';
import { apState, wupmForFloor } from './ap-state.svelte.js';
import { currentFloor, floorState } from './floor-state.svelte.js';
import { isInsideInterior } from './ap-interior.js';
import { projectMeta } from './project-meta.svelte.js';
import { isUsablePlanningArea, pointInPlanningArea } from './planning-area.js';



export const optimizerState = $state({
	isRunning: false,
	progress: 0,
	score: 0,
	coverage: 0, // 实时覆盖百分比，AP 或掩膜变化时更新
	error: null as string | null,
	/** 多楼层运行当前在干什么，例如 "Floor 2 of 3, pass 1"。 */
	status: '',
	/**
	 * 上一次全楼运行得到的整栋覆盖率：按各层样本数加权平均。
	 * 还没跑过全楼运行时为 null。
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
	 *
	 * 只报告、**不**优化，表示这份方案要共享多少空口时间。它是相对判据看不到的那一半：
	 * 两台同频 AP 的功率可能拉得够开，让干扰项读成 0%，而中间的终端仍在互相让路。
	 * 见 `ROADMAP.md` B4/B5。
	 */
	contention: 0,
	/**
	 * 是否已经对屏幕上这份布局真正测过干扰。
	 *
	 * 在那之前两个进度条都读 0%，那是默认值而不是测量值——对一个还没评过分的方案显示
	 * "干扰 0%"，比什么都不显示更糟。覆盖率条也用同样的门槛（`coverage > 0`）。
	 */
	interferenceMeasured: false,
	/**
	 * 为 false 表示有 AP 还没分信道，`interference` 是按"全部同频"的上界算的，
	 * 那是上界，不是当前方案的数。
	 */
	interferenceKnown: true,
	/** 上次全楼运行交替跑了几轮。 */
	passes: 0,
	/**
	 * 一层上把优化器跑几遍、取最好的一次。
	 *
	 * 默认 1（和以前一样）。大于 1 时每次用不同种子，比较的才是真正不同的尝试，
	 * 而不是把同一次重复几遍——PRNG 是有种子的，结果确定。
	 */
	restarts: 1,
	/**
	 * 上次运行结束的时间戳（epoch 毫秒），没跑过为 null。
	 *
	 * 用时间戳而不是布尔量："放置建议"面板要靠它区分两次运行——跑完弹出、可以关掉、
	 * 下一次运行后还得再弹。比一下这个值就知道"有新的测量结果"，不用再加一个容易过期的标志。
	 */
	lastRunAt: null as number | null
});

/**
 * 按楼层缓存的覆盖结果：floorId → { 覆盖百分比, 样本数（当作面积的近似） }。
 *
 * 用 `SvelteMap` 而不是普通 `Map`：面板要从这份缓存推整栋均值和最差楼层，而普通 `Map`
 * 不是响应式的，`$derived` 看不到依赖——跑完"优化所有楼层"后，分行数据是对的，
 * 整栋那行和最差楼层却还停在首次渲染的值。
 */
export const floorCoverage = new SvelteMap<string, FloorCoverageEntry>();

/**
 * 一个覆盖数字，以及它是在哪份方案上测出来的。
 *
 * `basis` 决定这个数字还能不能用：没有它，面板、整栋均值和 PDF 报告会一直打印一份已经
 * 不存在的方案的测量值。它故意不写盘（`toDocument` 只存数字和样本数），所以从磁盘读回来
 * 的数字没有 `basis`，下一轮就被丢掉——这是诚实的读法，因为那是上一个会话在本会话没验证过
 * 的状态上测的。
 */
export interface FloorCoverageEntry {
	coverage: number;
	samples: number;
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
 * 某层的覆盖数字是在哪份方案上测出来的（拼成 `basis` 字符串）。
 *
 * 把这一遍计算读到的东西拼成一个串：墙体和它光栅化出的掩膜、掩膜的位置、材质、标定
 * （结果是面积比，面积来自比例），以及本层每台 AP 连同评分时的功率和信道。
 * 两份状态拼出同样的串就得到同样的数字——这正是目的：一变就生成新串，旧数字被丢掉。
 */
export function coverageBasis(floorId: string): string {
	const floor = floorState.floors.find((f) => f.id === floorId);
	if (!floor) return 'missing';
	const aps = apState.aps
		.filter((ap) => ap.floorId === floorId)
		.map(
			(ap) =>
				`${ap.id}:${Math.round(ap.x)},${Math.round(ap.y)}:${ap.power}:` +
				`${ap.band}:${ap.channelWidth}:${ap.assignedChannel ?? ''}:${ap.mount}`
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
		aps
	].join('~');
}

/**
 * 把所有已经不能描述当前方案的覆盖数字删掉。
 *
 * 每一遍计算开始时调用。只有当前楼层能被编辑（它的墙、标定、上面的 AP），所以每次重算时
 * 扫一遍就覆盖了所有可能变过的楼层；没访问过的楼层本来就没有条目可删。
 */
export function dropStaleCoverage(): void {
	for (const [floorId, entry] of floorCoverage) {
		if (entry.basis !== coverageBasis(floorId)) floorCoverage.delete(floorId);
	}
}

/**
 * 落在本层识别出的室内区域之外的 AP 名称。
 *
 * 在检测规则统一之前存的方案，或者手工拖进去的 AP，可能落在墙外的边角，以前没有任何提示。
 * 由能显示它的组件来调用：状态模块不能 import 应用状态，因为 `app.svelte.ts` 会经持久化
 * 绕回这个模块，循环依赖会让优化器在载入时初始化到一半。
 *
 * 某层掩膜还没解码时返回空列表：没有墙可比，这个检查没意义；掩膜到位后会再跑一次。
 */
export async function apsOutsideInterior(): Promise<string[]> {
	if (projectMeta.allowOutsideRooms) return [];
	const outside: string[] = [];
	/*
	 * 画了规划区域时，以它为准。
	 *
	 * 那是用户自己声明"本层在哪"，落在它外面的点按定义就在本层之外——不用猜门口算不算
	 * 外面，不用做形态学处理，没什么可争的。没画时只能退回识别出的室内区域，
	 * 墙体的封闭处理也就用在那里。
	 */
	const planned = currentFloor().planningArea;
	const hasPlan = isUsablePlanningArea(planned);
	for (const ap of apState.aps) {
		/*
		 * 壁挂 AP 按定义就在墙上，而推断出的室内区域会刻意削掉贴着每面墙的那圈像素
		 * （`trimWallAdjacent`）——拿这个判它，会把整栋楼的每个支架都报成在外面。
		 * 以前就是这样：警告盯着壁挂 AP 不放，之后每次编辑（连改朝向都算）都再冒出来。
		 * 放置时已经不允许把壁挂 AP 放在远离墙的地方，这里也就没什么可补的了。
		 */
		if (ap.mount === 'wall') continue;
		const inside = hasPlan
			? pointInPlanningArea({ x: ap.x, y: ap.y }, planned!)
			: await isInsideInterior(ap.floorId, ap.x, ap.y);
		if (!inside) outside.push(ap.name);
	}
	return outside;
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