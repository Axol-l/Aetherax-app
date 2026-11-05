/**
 * 优化器内部各处交换的数据结构。
 *
 * 搜索、评估器和布点工具共用这一套类型（`EvalContext` 一个就牵涉到 AP 消息数据、
 * 固定源、跨层路径和穿墙损耗）。集中放这里，三者才能各自成文件又互不引用运行时代码。
 */
import type { Band, ChannelWidth } from '@aetherax/channels';
import type { AntennaProfile } from '../../rf/antenna.js';
import type { SlabCrossing } from '../../rf/cross-floor.js';
import type { OverlapLookup } from '../../rf/interference.js';
import type { SurfaceRect } from '../../rf/surface-height.js';

export interface ApInput {
	id: string;
	x: number;
	y: number;
	interferenceRadius: number;
	band: Band;
	/**
	 * 求解器给这个 AP 分配的信道，没分配就是 null。
	 *
	 * 只有干扰项读它（见 `rf/interference.ts`）。只要有源还没分配，就按全同频的最坏
	 * 情况算——求解器跑之前，方案就处在这个状态。
	 */
	assignedChannel?: number | null;
	/**
	 * 用户锁定的信道。锁定是约束，不是建议：搜索怎么挪这个 AP，信道都不变，
	 * 和主线程求解器的规则一致。
	 */
	fixedChannel?: number | null;
	/**
	 * 信道宽度，用来生成这个 AP 可用的不重叠信道表，见 `planningChannels`。
	 * 不传就是 20 MHz：最窄，也是每个频段信道都互不重叠的唯一宽度。
	 */
	channelWidth?: ChannelWidth;
	/**
	 * 这个 AP 到客户端的垂直距离，世界坐标单位。
	 *
	 * 开了安装高度后同层路径也不平，路径损耗按三维距离算。由调用方算好传进来
	 * （Worker 没有楼层几何），和 AP 一一对应。传 0 就当路径是平的。
	 */
	verticalGap?: number;
	/**
	 * 这个 AP 垂直天线切面的 −3 dB 波束宽度，单位度。
	 *
	 * 方向图随射线仰角变化，所以 Worker 每个采样点现算一次（见 `rf/antenna.ts`）。
	 * 不传也不猜频段默认值，调用方传什么就是什么。
	 */
	beamwidthDeg?: number;
	aimDeg?: number;
	/**
	 * 安装方式；壁挂时还包括朝向。
	 *
	 * 由调用方直接传，不靠推断：壁挂 AP 用水平切面、立式全向不用，判断规则
	 * （`rf/antenna.ts`）必须拿到安装方式。不传就是全向。
	 */
	mount?: string;
	facingDeg?: number;
}

/**
 * AP 所在楼层的墙体掩码，仅当它和正在优化的楼层不是同一层时才用。
 *
 * 跨层路径是两段：射线先从 AP 那层穿出去，过楼板，再落到目标层。
 * 以前把整段水平路程都算在客户端那层墙上，结论会整个错位。
 */
export interface SourceFloorMask {
	data: Uint8Array;
	width: number;
	height: number;
	materialMask: Uint8Array | null;
	/** 这层没标材料的墙体像素用的材料 id。 */
	defaultMaterial: number;
	/**
	 * 这个掩码的原点，换算到被优化楼层的掩码坐标系里。
	 *
	 * Worker 里所有坐标都是被优化楼层的掩码像素；楼层对齐后两张掩码原点不一致，
	 * 所以直接传平移好的掩码，省得 Worker 再维护一套坐标。
	 */
	originX: number;
	originY: number;
}

export interface FixedApInput {
	x: number;
	y: number;
	interferenceRadius: number;
	signalScale: number; // 楼板衰减系数（0-1）
	/**
	 * 这个 AP 到被优化楼层的垂直距离，世界坐标单位。
	 *
	 * 跨层路径按三维算：高两层就是更远，不只是衰减更多。
	 */
	verticalGap: number;
	band: Band;
	/**
	 * 垂直天线切面，单位度。见 `ApInput.beamwidthDeg`。
	 *
	 * 固定 AP 的方向图一样重要：「楼上的 AP 斜着打到楼下比直下更好」就是这一项。
	 */
	beamwidthDeg?: number;
	aimDeg?: number;
	/** 这个固定 AP 的安装方式和朝向。见 `ApInput.mount`。 */
	mount?: string;
	facingDeg?: number;
	/** 这个固定 AP 的信道，或 null。见 `ApInput.assignedChannel`。 */
	assignedChannel?: number | null;
	/** 用户锁定的信道，没锁就是空。见 `ApInput.fixedChannel`。 */
	fixedChannel?: number | null;
	/**
	 * 信道宽度，用来生成这个 AP 可用的不重叠信道表，见 `planningChannels`。
	 * 不传就是 20 MHz：最窄，也是每个频段信道都互不重叠的唯一宽度。
	 */
	channelWidth?: ChannelWidth;
	/**
	 * AP 自己那层的墙体掩码，用来在楼板处把路径劈成两段。
	 *
	 * 调用方拿不到那层的掩码就不传（或传 null），路径只按被优化楼层的墙算。
	 */
	source?: SourceFloorMask | null;
	/** 射线在哪一段离开 AP 自己那层（按比例）。见 `cross-floor.ts`。 */
	sourceT?: number;
	/** 射线在哪一段进入被优化楼层（按比例）。 */
	targetT?: number;
	/**
	 * 这条路径穿过的每层楼板，带各层所属房间的类型。
	 *
	 * 标成 `Void / Atrium` 的是楼板上的洞，射线在那儿碰不到混凝土。每条还带它在
	 * 总楼板损耗里占的份额，所以中间某层是洞只免那一份。空数组就是到处都算，偏保守。
	 */
	slabs?: SlabCrossing[] | null;
}

// ─── 预计算的穿墙缓存 ──────────────────────────────────────────────
// 优化开始前只建一次：把固定网格上的源位置映射到采样点。
// AP 位置用 O(1) 网格查找对齐到最近的源，不用线性扫描。

/**
 * 按需计算、算过就缓存的穿墙损耗表。
 *
 * 以前在搜索开始前把所有内部网格点（8 像素一格）×所有采样点全算一遍，1500x1200
 * 的户型要几百万次射线步进，进度条才会长时间卡在 0。搜索实际只走几百个量化位置，
 * 所以改成用到哪行现算哪行，算法和结果都没变。
 */
export interface WallCache {
	/** 采样点到 (x, y) 处源的 dB 值，源按网格取整。 */
	tableFor(x: number, y: number): Float32Array;
	band: Band;
}

/**
 * 壁挂 AP 能装在哪儿，以及那面墙朝哪边。
 *
 * 其他安装方式会特意剔掉靠墙一圈（见 `computeBuildingInterior`），而那圈正好是
 * 壁挂的位置，所以这里从墙体像素往地面做广度优先扩散、深度约一个支架，单独生成一条带。
 * 每个点记下背离墙的方向，量化成 22.5° 一格（一字节），存的就是朝向；AP 沿墙滑或
 * 拐弯时水平切面跟着转，方向图要按落点重建（`resolveApProfiles`）。
 */
export interface WallPlacement {
	/** 壁挂 AP 能放的位置为 1。 */
	band: Uint8Array;
	/** 把跑偏的位置拉回这条带上。 */
	field: InteriorField;
	/** 每个掩码像素的朝向，22.5° 一格；不在带上为 255。 */
	facingStep: Uint8Array;
}

/**
 * 搜索过程中一个接入点的位置。
 *
 * `radius` 是关联范围，按 3D 距离算；搜索移动的是水平位置，所以每次评估都要
 * 用 `sourceMargin` 换算回水平距离。
 */
export interface Position {
	id: string;
	x: number;
	y: number;
	radius: number;
	band: Band;
}

/**
 * 跨层 AP 的路径按采样点劈成的两段。
 *
 * 固定 AP 不动，所以整轮里两段都是常量：`source` 是 AP 自己那层、从 AP 到楼板交点，
 * `suffix` 是被优化楼层、从交点到采样点。按采样点而非按 AP 存，因为交点随采样点变。
 */
export interface SplitRows {
	source: Float32Array;
	suffix: Float32Array;
}

/** 固定 AP 路径里与搜索无关的部分。 */
export interface FixedPath {
	/** 在楼板处劈开时的穿墙损耗；null 表示用投影出来的那一段。 */
	split: SplitRows | null;
	/**
	 * 每个采样点上，总楼板损耗要乘的系数：默认全是 1，楼板是洞的地方更小。
	 *
	 * 用份额而不是开关，因为隔得高会穿好几层楼板，其中可能只有几层是空的。
	 */
	slabFactor: Float32Array | null;
}

export interface EvalContext {
	samples: Array<{ x: number; y: number }>;
	mask: Uint8Array;
	w: number;
	h: number;
	wallAttenuation: number;
	fixedAps: FixedApInput[];
	sampleDensity: number[];
	materialMask: Uint8Array | null;
	defaultMaterial: number;
	/**
	 * 每个固定 AP 的路径数据：墙体的两段拆分，以及每个采样点要不要算楼板损耗（洞就不算）。
	 *
	 * 每轮由 `buildFixedPaths` 建一次放这儿，所有评估——Lloyd 迭代、PSO 打分、
	 * 最后的精确评估——读的都是同一份数，不各自再算。
	 */
	fixedPaths: FixedPath[];
	/**
	 * 评估器能看到的所有源的信道，顺序就是它们出现的顺序：先候选位置，再 `fixedAps`。
	 *
	 * 只有干扰项读。`resolveChannels` 已经把「有源没分配」并成全同频上界，
	 * 所以评估器不用再判断。
	 */
	sourceChannels: number[];
	/**
	 * 每个源可选的信道，让 Worker 自己给布局着色时用：候选在前、`fixedAps` 在后，
	 * 和 `sourceChannels` 对齐。只有一个元素就是锁定。没给监管区域时为 null，
	 * 这时直接用 `sourceChannels`。
	 */
	sourceAllowed: number[][] | null;
	/**
	 * 每个源的频段，顺序和 `sourceChannels` 一致。
	 *
	 * 干扰项是按频段算的：信道号在不同频段会重复（6 GHz 用 1/5/9…，2.4 GHz 用 1-13），
	 * 只有同频段才可能同频。见 `violatesAt`。
	 */
	sourceBands: string[];
	/**
	 * 每个待布点 AP 到客户端的垂直距离，世界坐标单位，和 `positions` 对齐。
	 * 项目没开安装高度时全是 0。见 `ApInput.verticalGap`。
	 */
	apGaps: Float64Array;
	/**
	 * 每个采样点上客户端站多高，世界坐标单位，和 `samples` 对齐。
	 * 楼层没有抬升面时为 null，平的户型就不为这个特性付代价。
	 *
	 * 这是间距里属于采样点的那一半：夹层上的客户端离吊顶 AP 更近。见 `rf/surface-height.ts`。
	 */
	sampleLift: Float64Array | null;
	/**
	 * 抬升面本身，用来判断路径有没有穿平台。
	 *
	 * `sampleLift` 说客户端多高，这里说从下面来的路径要不要穿过平台、穿一次多少损耗。
	 * 留成几何数据，是因为答案还取决于源自己的高度。
	 */
	surfaces: SurfaceRect[];
	/** 每米多少世界坐标单位，用来把平台厚度（米）和世界坐标单位的间隔对上。 */
	wupm: number;
	/**
	 * 每个已布点 AP 的垂直天线切面，和 `positions`、`apGaps` 对齐。
	 * 见 `ApInput.beamwidthDeg`。
	 */
	apProfiles: AntennaProfile[];
	/** 同上，固定 AP 的，顺序按 `fixedAps`。 */
	fixedProfiles: AntennaProfile[];
	/**
	 * 目标函数里干扰那一项的权重。设成 0 就完全回到只看覆盖的目标，
	 * A/B 对比实验就是这么做的。
	 */
	interferenceWeight: number;
	/**
	 * 采样点低于覆盖阈值多少 dB 以内还能拿到一点效用。
	 *
	 * 设 0 就是硬阈值，2026-09-23 之前的测量都是这么做的；为什么目标函数需要一段过渡、
	 * 测量结果如何，见 `DEFAULT_COVERAGE_SOFTNESS_DB`。
	 */
	coverageSoftnessDb: number;
	/**
	 * 同层路径的垂直落差，世界坐标单位。路径损耗故意把同层当二维算，
	 * 但穿墙步进不能，它要算射线穿过的材料长度。见 `OptimizeMessage.localVerticalDrop`。
	 */
	localVerticalDropWu: number;
	/**
	 * 结果必须达到的覆盖比例，0-1。0 表示不约束。见 `COVERAGE_FLOOR_MULTIPLIER`。
	 */
	coverageFloor: number;
	/**
	 * 整轮里最窄的信道宽度，单位 MHz。
	 *
	 * 它决定 CCA 阈值：前导检测的灵敏度跟接收方听的宽度有关，20 MHz 的终端不管邻居
	 * 用不用 80 MHz，都在 −82 dBm 退让，所以混宽度的场景按最灵敏的那个阈值打分。
	 * 见 `ccaThresholdDbm`。
	 */
	minChannelWidthMhz: number;
	/** 为 true 表示 `sourceChannels` 是真的分配结果，不是最坏情况。 */
	channelsKnown: boolean;
	/**
	 * 两个源分到的频谱重叠程度，用来算分级的干扰值。每轮按源的频段和宽度建一次，
	 * 见 `makeOverlapLookup` 和 `interferenceAt`。
	 */
	overlap: OverlapLookup;
	/**
	 * 调用方传进来的 AP 原始数据，和 `positions` 对齐。
	 *
	 * 留着是为了壁挂 AP 被挪动时，能按它自己的参数重建方向图，见 `resolveApProfiles`。
	 */
	apSources: ApInput[];
	/**
	 * 哪些待布点 AP 是壁挂的，和 `positions` 对齐。
	 *
	 * 壁挂是另一种搜索：位置是沿墙一圈而不是整个内部，方向图也跟着所在的墙转，
	 * 所以它的天线方向图是位置的函数。
	 */
	wallMounted: boolean[];
	/**
	 * 壁挂带：能装在哪、墙朝哪边。没有壁挂 AP 或楼层没有墙时为 null。
	 */
	wallPlacement: WallPlacement | null;
}

/** 一次精确评估的结果。 */
export interface ExactEval {
	/**
	 * 按密度加权的平均覆盖效用，减去 `interferenceWeight · interference`，
	 * 就是要优化的那个量。
	 */
	score: number;
	/**
	 * 被同频的第二个源压到 `COCHANNEL_REUSE_DB` 以内的采样点占比（按密度加权）。
	 * 没有任何 AP 同频时为 0；权重设 0 时对 `score` 没影响。
	 */
	interference: number;
	/**
	 * 被覆盖的采样点占比（按密度加权），也就是最好的源达到了覆盖阈值。
	 *
	 * 用 `best > 0` 判断，不另算一遍余量：`coverageUtility` 在阈值及以下返回 0、
	 * 之上才涨，所以最佳值大于 0 就是被覆盖，和 `updateCoverage` 报的定义一致。
	 */
	coverage: number;
	/**
	 * 方案离 ε 约束下限还差多少，0-1。没有下限或已经达标就是 0。
	 */
	shortfall: number;
	/** 算这个结果用了多少采样点，还没按密度加权。 */
	samples: number;
	/**
	 * 两个 AP 信道重叠、且都高于 CCA 阈值的区域占比——不管电平差得够不够让干扰项在意，
	 * 这部分空口时间都要分掉。只上报、不参与优化，默认 0。
	 * 见 `contentionShare`、`ROADMAP.md` B4/B5。
	 */
	contention: number;
}

/**
 * 每个源在每个采样点上的余量，以及由这些余量推出的冲突图。一份数据两处用。
 *
 * 从 `evaluateExactDetailed` 里拆出来给分配图（`buildConflictGraph`）用：主线程求解器
 * 必须给目标函数打分的同一张图着色，唯一可靠的办法就是两边都读这一个字段。以前求解器
 * 按圆重叠加 AP 间距猜边、目标函数用这些余量，同一个布局能得出不同结论。
 *
 * 源覆盖不到的地方余量是 `-Infinity`，所以服务不了的源也干扰不到。
 */
export interface MarginField {
	/** `samples.length * count`，每个采样点一行 `count` 个值，在覆盖域里。 */
	allMargins: Float64Array;
	/**
	 * 同样的余量，但保留到覆盖阈值以下 `CCA_BELOW_THRESHOLD_DB`，不直接在阈值处截断。
	 *
	 * 只有竞争度那个指标读它。目标函数的范围是覆盖圈：没人覆盖的采样点既没效用也没
	 * 干扰，但空口时间在圈外照样分，所以报表要这份更宽的，得分不能用。
	 */
	ccaMargins: Float64Array;
	/** `count x count`，一对源不能共用信道的地方为 1。见 `markSampleConflicts`。 */
	conflicts: Uint8Array;
	/**
	 * 同一批冲突对，按它们毁掉多少密度加权采样点加权。
	 *
	 * 着色器读它：信道不够时要决定留下哪个冲突。见 `conflictWeights`。
	 */
	weights: Float32Array;
	/** 每个采样点上的最佳余量，也就是最好的服务源。 */
	bestBySample: Float64Array;
	/** 每个采样点上覆盖效用读的余量，值和 `bestBySample` 相同。 */
	utilityMargin: Float64Array;
	/** 这份数据覆盖的源数：先待布点，再固定 AP。 */
	count: number;
}

/** 一个 AP 过完 TPC 之后的功率，单位 dBm，以及对应的覆盖半径。 */
export interface PowerChoice {
	id: string;
	power: number;
	radius: number;
}

export interface InteriorField {
	nearest: Int32Array; // 最近的内部像素下标，没有就是 -1
	w: number;
	h: number;
}
