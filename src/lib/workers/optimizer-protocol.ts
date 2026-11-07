/**
 * 主线程和优化器 Worker 之间约定收发的消息格式。
 */
import type { RegulatoryDomain } from '@aetherax/channels';
import type { AccessPoint } from '../state/ap-state.svelte.js';
import type { PathLossScenario } from '../rf/propagation.js';
import type { FixedApInput } from './optimizer/types.js';

/**
 * 消息数据的“含义”变了才加一，单纯加字段不用加。
 *
 * Worker 是打包出来的独立资源，主线程是围着它的应用，开发时缓存的 Worker 可能比调用它的代码还旧。
 * 版本对不上时 `assertApPayload` 会直接报错。
 */
export const OPTIMIZER_PAYLOAD_VERSION = 3;

/**
 * 搜索需要知道的状态字段
 *
 * 几何（`x`、`y`）、由此决定的覆盖范围（`interferenceRadius`、`band`、`channelWidth`）、
 * 可用信道（`assignedChannel`、`fixedChannel`）和天线参数（`beamwidthDeg`、`aimDeg`、`mount`、`facingDeg`）。
 */
type ApPayloadField =
	| 'id'
	| 'x'
	| 'y'
	| 'interferenceRadius'
	| 'band'
	| 'channelWidth'
	| 'assignedChannel'
	| 'fixedChannel'
	| 'beamwidthDeg'
	| 'aimDeg'
	| 'mount'
	| 'facingDeg';

/**
 * Worker 视角下的一个已布点 AP。
 */
export type ApInput = { [K in ApPayloadField]: AccessPoint[K] } & {
	/** 这个 AP 到客户端的垂直距离，单位是世界坐标；0 表示同一平面上的路径。 */
	verticalGap: number;
};

/** 开跑之前调用方必须填好的字段。 */
const REQUIRED_AP_FIELDS = [
	'id',
	'x',
	'y',
	'interferenceRadius',
	'band',
	'channelWidth',
	'assignedChannel',
	'fixedChannel',
	'beamwidthDeg',
	'aimDeg',
	'mount',
	'facingDeg',
	'verticalGap'
] as const;

/**
 * 消息数据少了模型要读的字段时直接抛错。
 */
export function assertApPayload(aps: ReadonlyArray<Record<string, unknown>>): void {
	for (const [index, ap] of aps.entries()) {
		for (const field of REQUIRED_AP_FIELDS) {
			if (ap[field] === undefined) {
				throw new Error(
					`optimiser payload ${OPTIMIZER_PAYLOAD_VERSION}: AP ${index} is missing "${field}"`
				);
			}
		}
	}
}

/**
 * 优化器 Worker 接收的消息
 */
export interface OptimizeMessage {
	type: 'optimize';
	runId: string;
	aps: ApInput[];
	fixedAps: FixedApInput[];
	wallMask: Uint8Array;
	maskWidth: number;
	maskHeight: number;
	wallAttenuation: number;
	/** 解码后的逐像素墙体材质 id；没有标注就是 null。 */
	materialMask: Uint8Array | null;
	/** 没有显式材质标签的像素用的材质 id。 */
	defaultMaterial: number;
	/** 每个像素对应多少米，用于覆盖和关联距离；0 表示未标定。 */
	metersPerPixel: number;
	/**
	 * 为 false（默认）时 AP 只能放在识别出的建筑内部；为 true 时可以放在图上任何位置。
	 */
	allowOutside: boolean;
	/** 逐像素的设备密度（台/平方米）。-1 表示未标注，null 表示没有房间数据。 */
	densityMap: Float32Array | null;
	/** 有标注房间的密度中位数，用作未标注像素的基准。 */
	medianDensity: number;
	/**
	 * 原始房间类型 id，尺寸和墙掩码一致。空洞也记在这里。
	 */
	roomTypeMask: Uint8Array | null;
	/**
	 * PRNG 的随机种子。不传就随机取一个。
	 */
	seed?: number;
	/**
	 * 同频干扰占比在目标函数里的权重：`score = coverageUtility − interferenceWeight · interferenceShare`。
	 *
	 * 取 0 就只剩覆盖，也就是这一项加进来之前优化器的行为。
	 */
	interferenceWeight?: number;
	/**
	 * 监管域，让 Worker 自己给布局做信道着色。
	 */
	regulatoryDomain?: RegulatoryDomain;
	/**
	 * 采样点比覆盖门限还低多少 dB 以内，仍然算有收益。
	 * 不传就用 `DEFAULT_COVERAGE_SOFTNESS_DB`。
	 */
	coverageSoftnessDb?: number;
	/**
	 * 这次运行的距离项按哪个 ITU-R P.1238 环境算。不传就用默认的 `closedPlan`。
	 */
	pathLossScenario?: PathLossScenario;
	/**
	 * 覆盖门限，单位 dBm。不传就用默认的 −70 dBm。
	 */
	coverageThresholdDbm?: number;
	/**
	 * 这次运行允许给每个 AP 的发射功率档位，单位 dBm，降序；按消息里 AP 的顺序，一个 AP 一个列表（见 `ApInput`）。
	 *
	 * 不传就表示功率不是决策变量，每个 AP 保留消息里给的半径。
	 */
	powerLevelsDbm?: number[][];
	/**
	 * 每个像素对应多少世界坐标，用来把功率换算成覆盖半径。
	 * 为 0 或没传就完全不碰功率。
	 */
	worldUnitsPerMeter?: number;
	/**
	 * 同层路径在竖直方向下降的高度，世界坐标：`(ceilingHeight − clientHeight) × worldUnitsPerMeter`。
	 *
	 * 斜着往下穿墙的射线，穿过的墙体厚度是平面路径的 `1/cos φ` 倍，只按平面坐标走的步进会少算，取 0 就不做这个修正。
	 */
	localVerticalDrop?: number;
	/**
	 * 沿墙那条可布置带子有多宽，世界坐标——壁挂 AP 只能放在这个范围里。
	 */
	wallBandWu?: number;
	/**
	 * 一个封闭区域的内切半径至少要有这么大才允许布点，世界坐标。
	 *
	 * 不传就是所有封闭区域都算，布置域可能会包含墙里的小空腔和绘图缝隙。
	 */
	minRoomRadiusWu?: number;
	/**
	 * 用户画了规划区域的话，这里是它在掩码坐标下的范围。
	 */
	planningArea?: Array<{ x: number; y: number }> | null;
	/**
	 * 这一层的抬升面（夹层之类），掩码坐标。
	 *
	 * 夹层上的客户端离吊顶的 AP 更近，而两层之间还有台阶，所以垂直距离既要按 AP 算、也要按采样点算。
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
	 * 用户自定义的墙体材质。
	 */
	customMaterials?: Array<{
		id: number;
		name: string;
		dbPerMeter: Record<string, number>;
		typicalThickness: number;
		color: [number, number, number];
	}>;
	/**
	 * 这条消息是按哪个协议版本拼的
	 */
	payloadVersion?: number;
	/**
	 * ε-约束：结果必须达到的覆盖占比，0-1 之间的小数。取 0（默认）就是不设约束。
	 */
	coverageFloor?: number;
	/**
	 * 只把冲突图返回，不做任何布点。
	 */
	graphOnly?: boolean;
}
/**
 * 消息里重的那一半：掩码和跨层源。
 */
export type WireGeometry = Pick<
	OptimizeMessage,
	| 'wallMask'
	| 'maskWidth'
	| 'maskHeight'
	| 'materialMask'
	| 'densityMap'
	| 'medianDensity'
	| 'roomTypeMask'
	| 'fixedAps'
>;

export type WireMessage = Omit<OptimizeMessage, keyof WireGeometry> &
	Partial<WireGeometry> & { geometryId?: string; geometryReused?: boolean };

/*
 * 一次运行结束后发回去的东西
 */
export interface OptimizeResult {
	positions: Array<{ id: string; x: number; y: number }>;
	score: number;
	improvement: number;
	/**
	 * 运行干不了活时设置（比如没识别出封闭内部）。这时位置就是原样返回的输入。
	 */
	error?: string;
	/**
	 * 这次运行实际用的 PRNG 随机种子。想精确复现，就把它从 `options.seed` 传回去。
	 */
	seed: number;
	/**
	 * 密度加权后被覆盖的地面占比，定义和覆盖读数一致。按层上报，
	 * 多层运行才能拼出整栋楼的数、指出最差的一层，而不用再实现一遍这个定义。
	 */
	coverage: number;
	/**
	 * 密度加权后，最强服务 AP 被同频的次强信号压到 `COCHANNEL_REUSE_DB` 以内的地面占比。
	 * 可以看成“质量”口径下覆盖的补集，目标函数在两者之间权衡。走错误路径、没有布局时没有这个字段。
	 */
	interference?: number;
	/**
	 * 同一层上，两个信道重叠的 AP 都高于 CCA 门限（20 MHz 下约 −82 dBm）的地面占比。
	 */
	contention?: number;
	/**
	 * 选出来的方案离 ε-约束下限还差多少，0-1 的小数。没设下限或者达到了下限就是 0。
	 */
	shortfall?: number;
	/**
	 * 为 false 表示 `interference` 是按全同频的上界算的，因为有 AP 还没有信道，
	 * 那个数只是上界。
	 */
	channelsKnown?: boolean;
	/** 覆盖数字是由多少个采样点算出来的，多层加权时用。 */
	sampleCount: number;
	/**
	 * 为 true 表示搜索出的布局在精确评估器上比输入还差，所以保留了输入。
	 */
	reverted: boolean;
	/**
	 * 消息里那些位置隐含的冲突图，只有 `graphOnly` 请求才会带。
	 */
	graph?: {
		pairs: Array<[number, number]>;
		count: number;
		/**
		 * 每一对的代价，按行优先 `count × count` 排，下标方式和 pairs 一致：
		 * 密度加权后，有多少采样点落在一个源距另一个源不超过复用门限的位置上。见 `conflictWeights`。
		 */
		weights?: number[];
	};
	/**
	 * 调用方给了功率档位时，这次运行最终定下来的每个 AP 的发射功率。见 `refinePower`；
	 * 应用位置时也要一并应用，否则显示出来的方案不是被评分的那一个。
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
 * Worker 发回去的消息
 */
export type WorkerReply =
	| ({ type: 'progress'; runId: string } & OptimizeProgress)
	| ({ type: 'result'; runId: string } & OptimizeResult)
	| { type: 'cancelled'; runId: string }
	| { type: 'busy'; runId: string };