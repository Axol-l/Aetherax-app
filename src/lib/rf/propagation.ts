/**
 * 共享的 RF 传播模块，heatmap 与 optimizer 两个 worker 共用；纯计算，不使用 DOM API。
 *
 * 内含信号功率模型、穿墙射线步进、预计算穿墙损耗场与基础速率查表。
 */

// ─── 信号模型 ─────────────────────────────────────────────────────

/**
 * 室内传播：四次方衰减，路径损耗指数 n=4。
 *
 * 返回形如 1 / (1 + (d²/r²)²) 的相对功率，无开方，只有乘除。
 */
export function signalPower(distSq: number, radiusSq: number): number {
	if (radiusSq <= 0) return 0;
	const ratioSq = distSq / radiusSq;
	return 1 / (1 + ratioSq * ratioSq);
}

// ─── 穿墙射线步进 ─────────────────────────────────────────────────

/**
 * DDA 射线步进，步长可配置。
 *
 * 每穿过一段材质计一次穿墙损耗，取 `materialDb[matId]`；`stride` 为每几个像素采样一次。
 */
export function rayMarchWallAtten(
	wallData: Uint8Array,
	w: number,
	h: number,
	materialMap: Uint8Array | null,
	materialDb: number[],
	defaultDb: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	stride = 3,
	defaultMaterialId = 0
): number {
	const ix0 = Math.round(x0),
		iy0 = Math.round(y0);
	const lenX = Math.round(x1) - ix0;
	const lenY = Math.round(y1) - iy0;
	const steps = Math.max(Math.abs(lenX), Math.abs(lenY));
	const n = Math.ceil(steps / stride);
	if (n <= 0) return 0;
	const dx = lenX / n;
	const dy = lenY / n;

	let total = 0;
	/** 当前正在穿过的墙体材质，墙体之外为 -1。 */
	let runMaterial = -1;
	for (let s = 0; s <= n; s++) {
		const px = (ix0 + s * dx + 0.5) | 0;
		const py = (iy0 + s * dy + 0.5) | 0;
		if (px >= 0 && px < w && py >= 0 && py < h) {
			const idx = py * w + px;
			if (wallData[idx] === 1) {
				const matId = materialMap ? (materialMap[idx] ?? defaultMaterialId) : defaultMaterialId;
				// 每段材质只计一次：进入墙体时，或跨到墙体上另一种材质时。
				if (matId !== runMaterial) {
					/*
					 * `defaultDb` 用于材质 id 已失效的墙体——材质被删除但掩膜上仍留有该 id。
					 * 它不是整层的衰减：有材质的墙体始终按该材质的取值计算。
					 */
					total += materialDb[matId] ?? defaultDb;
					runMaterial = matId;
				}
			} else {
				runMaterial = -1;
			}
		} else {
			runMaterial = -1;
		}
	}
	return total;
}

/**
 * 统计一条射线上的穿墙次数（0→1 跳变），`stride` 默认 1。
 * optimizer 用该计数乘以固定 dB 得到损耗。
 */
export function countWallCrossings(
	wallData: Uint8Array,
	w: number,
	h: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	stride = 1
): number {
	const ix0 = Math.round(x0),
		iy0 = Math.round(y0);
	const lenX = Math.round(x1) - ix0;
	const lenY = Math.round(y1) - iy0;
	const steps = Math.max(Math.abs(lenX), Math.abs(lenY));
	const n = stride > 1 ? Math.ceil(steps / stride) : steps;
	if (n <= 0) return 0;
	const dx = lenX / n;
	const dy = lenY / n;

	let count = 0;
	let wasWall = false;
	for (let s = 0; s <= n; s++) {
		const px = (ix0 + s * dx + 0.5) | 0;
		const py = (iy0 + s * dy + 0.5) | 0;
		if (px >= 0 && px < w && py >= 0 && py < h) {
			const isWall = wallData[py * w + px] === 1;
			if (isWall && !wasWall) count++;
			wasWall = isWall;
		} else {
			wasWall = false;
		}
	}
	return count;
}

// ─── 预计算穿墙损耗场 ─────────────────────────────────────────────

/** 预计算损耗场的网格步长，单位为墙体掩膜的像素。 */
export const ATTEN_GRID_STEP = 6;

/**
 * 极坐标穿墙损耗场：按相对 AP 的角度与距离存储累计墙体 dB。
 *
 * 由沿径向切片向外步进构建，查询为 O(1)，超出最大距离的像素取末端值。
 */
export interface AttenField {
	/** 累计 dB，索引为 [angle * distBuckets + distIdx]。 */
	data: Float32Array;
	angles: number;
	distBuckets: number;
	distStep: number; // 每个距离桶对应的世界坐标单位
	apX: number;
	apY: number;
	/** 每个角度的末端衰减，用于超出 maxDist 的像素。 */
	edgeAtten: Float32Array;
}

const POLAR_ANGLES_FULL = 720; // 每个切片 0.5°
const POLAR_ANGLES_FAST = 360; // 每个切片 1°（拖拽模式）

/**
 * 从 AP 沿径向切片向外步进，构建极坐标穿墙损耗场。
 * 每个切片增量累加墙体 dB，不重复做射线步进。
 */
export function buildAttenField(
	apX: number,
	apY: number,
	maxDist: number,
	wallData: Uint8Array,
	wallW: number,
	wallH: number,
	materialMap: Uint8Array | null,
	materialDb: number[],
	defaultDb: number,
	gridStep = ATTEN_GRID_STEP,
	maskOriginX = 0,
	maskOriginY = 0
): AttenField {
	const fast = gridStep > ATTEN_GRID_STEP;
	const angles = fast ? POLAR_ANGLES_FAST : POLAR_ANGLES_FULL;
	const distStep = fast ? 6 : 3; // 每个距离桶对应的世界坐标单位
	const distBuckets = Math.ceil(maxDist / distStep);
	const data = new Float32Array(angles * distBuckets);
	const edgeAtten = new Float32Array(angles);

	// AP 在掩膜局部坐标中的位置
	const apLX = apX - maskOriginX;
	const apLY = apY - maskOriginY;
	const angleStep = (2 * Math.PI) / angles;

	for (let a = 0; a < angles; a++) {
		const theta = a * angleStep;
		const cosT = Math.cos(theta);
		const sinT = Math.sin(theta);

		let cumDb = 0;
		let wasWall = false;
		const base = a * distBuckets;

		// 逐像素步进，避免漏掉薄墙；累计 dB 按桶分辨率存放，便于紧凑查询。
		let nextBucket = 0;
		const totalPixels = Math.ceil(maxDist);
		for (let p = 0; p < totalPixels; p++) {
			const px = (apLX + cosT * p + 0.5) | 0;
			const py = (apLY + sinT * p + 0.5) | 0;

			if (px >= 0 && px < wallW && py >= 0 && py < wallH) {
				const idx = py * wallW + px;
				const isWall = wallData[idx] === 1;
				if (isWall && !wasWall) {
					if (materialMap) {
						const matId = materialMap[idx] ?? 0;
						cumDb += materialDb[matId] ?? defaultDb;
					} else {
						cumDb += defaultDb;
					}
				}
				wasWall = isWall;
			} else {
				wasWall = false;
			}

			// 跨过桶边界时写入该桶的累计值
			while (nextBucket < distBuckets && p >= (nextBucket + 0.5) * distStep) {
				data[base + nextBucket] = cumDb;
				nextBucket++;
			}
		}
		// 补齐剩余的距离桶
		while (nextBucket < distBuckets) {
			data[base + nextBucket] = cumDb;
			nextBucket++;
		}
		edgeAtten[a] = cumDb;
	}

	/*
	 * 三个相邻角度的中值滤波：去掉单个切片漏过墙体形成的孤立亮刺。
	 *
	 * 只漏一个像素的切片不是阴影边界，而是空洞；真实阴影横跨多个切片，取中值后仍然保留。
	 */
	const smoothed = new Float32Array(data.length);
	for (let a = 0; a < angles; a++) {
		const prev = (a + angles - 1) % angles;
		const next = (a + 1) % angles;
		const base = a * distBuckets;
		const basePrev = prev * distBuckets;
		const baseNext = next * distBuckets;
		for (let d = 0; d < distBuckets; d++) {
			const v0 = data[basePrev + d]!;
			const v1 = data[base + d]!;
			const v2 = data[baseNext + d]!;
			// 三值取中：min(max(a,b), max(min(a,b), c))。
			const lo = v0 < v1 ? v0 : v1;
			const hi = v0 < v1 ? v1 : v0;
			smoothed[base + d] = v2 < lo ? lo : v2 > hi ? hi : v2;
		}
	}
	data.set(smoothed);

	return { data, angles, distBuckets, distStep, apX, apY, edgeAtten };
}

/**
 * 极坐标损耗场的 O(1) 查询，在角度与距离两个方向做双线性插值。
 *
 * 在相邻切片与相邻距离桶之间插值，使阴影边界保持渐变；距离小于 0.5 时返回 0。
 */
export function lookupAtten(field: AttenField, wx: number, wy: number): number {
	const dx = wx - field.apX;
	const dy = wy - field.apY;
	const dist = Math.sqrt(dx * dx + dy * dy);
	if (dist < 0.5) return 0;

	// 角度：atan2 → [0, 2π) → [0, angles)，并给出切片内的小数部分。
	let theta = Math.atan2(dy, dx);
	if (theta < 0) theta += 2 * Math.PI;
	const anglePos = (theta / (2 * Math.PI)) * field.angles;
	const a0 = Math.min(field.angles - 1, anglePos | 0);
	const a1 = (a0 + 1) % field.angles;
	const at = anglePos - a0;

	// 距离：桶序号加桶内小数部分。
	const distPos = dist / field.distStep;
	const d0 = distPos | 0;
	if (d0 + 1 >= field.distBuckets) {
		return field.edgeAtten[a0]! * (1 - at) + field.edgeAtten[a1]! * at;
	}
	const dt = distPos - d0;
	const base0 = a0 * field.distBuckets + d0;
	const base1 = a1 * field.distBuckets + d0;
	const near = field.data[base0]! * (1 - dt) + field.data[base0 + 1]! * dt;
	const far = field.data[base1]! * (1 - dt) + field.data[base1 + 1]! * dt;
	return near * (1 - at) + far * at;
}

// ─── 穿墙损耗场缓存 ───────────────────────────────────────────────

const attenCache = new Map<string, AttenField>();
let wallGeneration = 0;
let cachedGeneration = -1;

/** 缓存字段的最大数量。每个字段约为 720 × distBuckets 个浮点数。 */
const ATTEN_CACHE_MAX = 10;

/**
 * 墙体或材质数据变更时调用，用于失效已缓存的损耗场。
 *
 * 用单一全局代数计数器，会一次清掉所有楼层；按楼层细分需调用方传入楼层键。
 */
export function invalidateAttenCache(): void {
	wallGeneration++;
}

/**
 * 取某个 AP 的缓存损耗场，未命中则构建。
 *
 * `fast` 用 12 px 网格与 12 px 量化换取拖拽响应，`full` 用 6 px 网格与 4 px 量化。
 */
export function getAttenField(
	apX: number,
	apY: number,
	radius: number,
	wallData: Uint8Array,
	wallW: number,
	wallH: number,
	materialMap: Uint8Array | null,
	materialDb: number[],
	defaultDb: number,
	fast = false,
	maskOriginX = 0,
	maskOriginY = 0,
	/**
	 * 缓存键之外的判别标记。
	 * 缓存键只含位置与半径，而场还取决于材质表与掩膜，跨楼层时同一 AP 会有两个场。
	 */
	cacheTag = '',
	/**
	 * 损耗场步进的最大距离，为 `radius` 的倍数，默认 3。
	 *
	 * 步进长度与该倍数线性相关；heatmap 只读到 1.5 个半径，需要更远的调用方保留默认值。
	 */
	maxDistFactor = 3
): AttenField {
	if (cachedGeneration !== wallGeneration) {
		attenCache.clear();
		cachedGeneration = wallGeneration;
	}

	const q = fast ? 12 : 4;
	const qx = (apX / q) | 0;
	const qy = (apY / q) | 0;
	const key = `${fast ? 'f' : 'a'}:${qx}:${qy}:${(radius / 4) | 0}:${maxDistFactor}:${cacheTag}`;

	const hit = attenCache.get(key);
	if (hit) {
		// 刷新使用顺序。`Map` 保持插入顺序，不刷新会按 FIFO 淘汰，常用字段可能被删。
		attenCache.delete(key);
		attenCache.set(key, hit);
		return hit;
	}

	const gridStep = fast ? 12 : ATTEN_GRID_STEP;
	const field = buildAttenField(
		apX,
		apY,
		radius * maxDistFactor,
		wallData,
		wallW,
		wallH,
		materialMap,
		materialDb,
		defaultDb,
		gridStep,
		maskOriginX,
		maskOriginY
	);
	attenCache.set(key, field);
	while (attenCache.size > ATTEN_CACHE_MAX) {
		const oldest = attenCache.keys().next().value!;
		attenCache.delete(oldest);
	}
	return field;
}

// ─── 由发射功率推算距离 ──────────────────────────────────────────

/**
 * 各频段 1 m 处的参考路径损耗，单位 dB。
 *
 * 按 ITU-R P.1238 的 `PL0 = 20·log10(f_MHz) − 28` 计算，键为小写频段名。
 */
const PL0: Record<string, number> = {
	'2.4ghz': 39.6,
	'5ghz': 46,
	'6ghz': 47.5
};

/**
 * 290 K 下的热噪声功率谱密度：`k·T`，单位 dBm/Hz，取值 −173.98。
 *
 * 模型中所有功率电平最终都以它为基准，其余量都是在此之上的要求。
 */
const THERMAL_NOISE_DBM_PER_HZ = -173.98;

/**
 * 20 MHz 下的灵敏度，作为模型的零点。
 *
 * 下方噪声系数由它反解，因此该值精确；其它宽度按每倍频 3 dB 折算。
 */
const SENSITIVITY_20MHZ_DBM = -85;

/**
 * 20 MHz 下的系统等效噪声系数（dB），反解使噪声底恰好等于该灵敏度。
 *
 * 该系数包含接收机噪声与实现余量，参见 `docs/PHYSICAL_MODELS.md` §A4。
 */
const NOISE_FIGURE_DB = SENSITIVITY_20MHZ_DBM - (THERMAL_NOISE_DBM_PER_HZ + 10 * Math.log10(20e6));

/**
 * 给定信道宽度下的热噪声底，单位 dBm，公式为 `k·T·B + NF`。
 *
 * 随带宽变化，宽度每翻一倍噪声底抬高 3 dB；宽度非正时按 20 MHz 处理。
 */
export function thermalNoiseFloorDbm(
	channelWidthMhz: number,
	noiseFigureDb = NOISE_FIGURE_DB
): number {
	const width = channelWidthMhz > 0 ? channelWidthMhz : 20;
	return THERMAL_NOISE_DBM_PER_HZ + 10 * Math.log10(width * 1e6) + noiseFigureDb;
}

/**
 * 给定信道宽度下的接收灵敏度阈值，单位 dBm。
 *
 * 由噪声系数构造，20 MHz 时等于热噪声底；信道越宽噪声底越高，灵敏度越差。
 */
export function sensitivityDbm(channelWidthMhz = 20, noiseFigureDb = NOISE_FIGURE_DB): number {
	return thermalNoiseFloorDbm(channelWidthMhz, noiseFigureDb);
}

/** 20 MHz 下的接收灵敏度，历史数值均在该宽度下取得。 */
const SENSITIVITY = sensitivityDbm(20);

/**
 * 室内距离功率损耗系数，写作 N = 10·n，`n` 为路径损耗指数。
 *
 * ITU-R P.1238-13 的取值已隐含穿墙余量，参见 `docs/PHYSICAL_MODELS.md` §A3。
 */

/**
 * ITU-R P.1238-13 给出距离功率损耗系数的几种环境。
 *
 * 表中的 `N` 已含穿墙与绕障的平均余量，取值需与平面图是否显式绘制墙体对应，避免重复计入。
 */
export type PathLossScenario = 'lineOfSight' | 'office' | 'closedPlan';

export interface PathLossScenarioInfo {
	/** `PL(d) = PL0 + 10·n·log10(d)` 中的 `n`，即 ITU 的 `N` 除以十。 */
	n: number;
	/** 表中的 `N` 本身，便于对照标准。 */
	ituN: number;
	/**
	 * 为 true 时该 ITU 取值已含穿墙余量，此时再叠加射线步进会重复计算。
	 */
	includesWallAllowance: boolean;
}

export const PATH_LOSS_SCENARIOS: Record<PathLossScenario, PathLossScenarioInfo> = {
	lineOfSight: { n: 2.0, ituN: 20, includesWallAllowance: false },
	office: { n: 3.0, ituN: 30, includesWallAllowance: true },
	closedPlan: { n: 4.0, ituN: 40, includesWallAllowance: true }
};

/**
 * 项目未指定环境时采用的默认值，取 `closedPlan`。
 *
 * 与引入该设置之前记录的数值保持一致。
 */
export const DEFAULT_PATH_LOSS_SCENARIO: PathLossScenario = 'closedPlan';

let currentScenario: PathLossScenario = DEFAULT_PATH_LOSS_SCENARIO;
let currentN: number = PATH_LOSS_SCENARIOS[DEFAULT_PATH_LOSS_SCENARIO].n;

/**
 * 当前建模使用的路径损耗指数 `n`。
 *
 * 放在模块作用域而非参数，避免在传播热循环里逐层传递；app 与 optimizer worker 各持一份。
 */
export function pathLossN(): number {
	return currentN;
}

/** `pathLossN()` 对应的场景名。 */
export function pathLossScenario(): PathLossScenario {
	return currentScenario;
}

/**
 * 选择场景。缓存了派生量（AP 半径、已渲染的场）的调用方需自行重建，此函数无法触达那些缓存。
 */
export function setPathLossScenario(scenario: PathLossScenario): void {
	if (!(scenario in PATH_LOSS_SCENARIOS)) {
		throw new Error(`unknown path loss scenario: ${scenario}`);
	}
	currentScenario = scenario;
	currentN = PATH_LOSS_SCENARIOS[scenario].n;
}

/** 直接设置 `n`，供测试与测量工具使用。 */
export function setPathLossN(n: number): void {
	if (!(n > 0)) throw new Error(`path loss coefficient must be positive, got ${n}`);
	currentN = n;
}

/**
 * 第一菲涅尔区折断点，单位米，取 10。
 *
 * 超过该距离后距离功率损耗指数由约 20 过渡到约 40，参见 ITU-R P.1238-13 系数表下的注释。
 */
const FRESNEL_BREAKPOINT_M = 10;

/** 折断点之后的指数：穿墙、封闭场景，ITU N = 40。 */
const FAR_FIELD_N = 4.0;

/**
 * 过渡区的半宽，单位为距离的十倍程。
 *
 * 指数在折断点两侧 ±0.2 个十倍程内线性过渡，避免曲线出现折角。
 */
const BREAKPOINT_BLEND_DECADES = 0.2;

const BREAKPOINT_LOG10 = Math.log10(FRESNEL_BREAKPOINT_M);

/**
 * 指数过渡段的积分，自变量为 `u = log10(d)`，从 1 m 起算。
 *
 * 损耗为 `10 · ∫ n(x) dx`，分段线性的 `n` 给出连续、单调且斜率连续的损耗曲线。
 */
function rampIntegral(u: number): number {
	const lo = BREAKPOINT_LOG10 - BREAKPOINT_BLEND_DECADES;
	const hi = BREAKPOINT_LOG10 + BREAKPOINT_BLEND_DECADES;
	if (u <= lo) return 0;
	if (u >= hi) return BREAKPOINT_BLEND_DECADES + (u - hi);
	const t = (u - lo) / (2 * BREAKPOINT_BLEND_DECADES);
	return t * t * BREAKPOINT_BLEND_DECADES;
}

/** `relativePathLossDb` 在 `u = log10(d)` 处的取值，供二分解反使用。 */
function relativeLossAtLog10(u: number): number {
	const n = pathLossN();
	if (n >= FAR_FIELD_N) return 10 * n * u;
	return 10 * (n * u + (FAR_FIELD_N - n) * rampIntegral(u));
}

/**
 * 相对损耗达到 `lossDb` 时的距离，单位米。
 *
 * 用二分法反解；每个 AP 每帧调用一次，逐样本的路径只做损耗相减。
 */
function distanceForRelativeLoss(lossDb: number): number {
	if (!(lossDb > 0)) return 1;
	let lo = 0; // 下界 log10(1 m)
	let hi = 8; // 上界 log10(100 km)，远超室内模型的使用范围
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (relativeLossAtLog10(mid) < lossDb) lo = mid;
		else hi = mid;
	}
	return Math.pow(10, (lo + hi) / 2);
}

/**
 * 由发射功率与频段估算室内覆盖距离，单位米。
 *
 * 使用对数距离路径损耗模型 `PL(d) = PL₀ + 10·n·log₁₀(d)`；频段不在表中时 `PL0` 取 47。
 */
export function rangeFromPower(txPowerDbm: number, band: string): number {
	const pl0 = PL0[band] ?? 47;
	const budget = txPowerDbm - pl0 - SENSITIVITY; // 链路预算，单位 dB
	return distanceForRelativeLoss(budget);
}


/**
 * 给定频段与距离的路径损耗，单位 dB，与 `rangeFromPower` 使用同一对数距离模型。
 *
 * 距离钳制到 1 m，因为 1 m 参考损耗 `PL₀` 只在该距离之外有效。
 */
export function pathLossDb(band: string, distanceMeters: number): number {
	const pl0 = PL0[band] ?? 47;
	return pl0 + relativePathLossDb(distanceMeters);
}

/** 距离模型使用的接收灵敏度，单位 dBm。 */
export const RECEIVER_SENSITIVITY_DBM = SENSITIVITY;

/**
 * 给定距离处高于覆盖阈值的余量，单位 dB。
 * `radius` 为自由空间电平等于接收灵敏度的距离；距离 0 返回 +Infinity，半径非正返回 -Infinity。
 */
export function coverageMarginDb(distance: number, radius: number): number {
	if (radius <= 0) return -Infinity;
	if (distance <= 0) return Infinity;
	// 两个相对损耗之差，因此无论指数如何随距离变化，覆盖半径处的余量恰好为 0。
	return relativePathLossDb(radius) - relativePathLossDb(distance);
}

/**
 * 判定客户端被覆盖的信号门限，单位 dBm，取 −70。
 *
 * 该值高于接收灵敏度，是室内数据覆盖的常用设计门限；`coverageReach` 与 optimizer 目标都以它为界。
 */
export const COVERAGE_THRESHOLD_DBM = -70;

/**
 * 覆盖门限高于灵敏度的量，单位 dB；样本余量达到该值即视为被覆盖。
 */
export const COVERAGE_MARGIN_DB = COVERAGE_THRESHOLD_DBM - SENSITIVITY;

/**
 * 覆盖门限高于热噪声底的量，单位 dB，取 15。
 *
 * 以 SNR 表述是本模型的设计基准，也便于核对。
 */
export const COVERAGE_SNR_DB = COVERAGE_THRESHOLD_DBM - thermalNoiseFloorDbm(20);

/**
 * 给定信道宽度下的空闲信道评估（CCA）前导检测门限，单位 dBm，20 MHz 时为 −82 dBm。
 *
 * 取自标准而非由噪声底推导；宽度每翻一倍提高 3 dB。参见 `docs/PHYSICAL_MODELS.md` §E3。
 */
export function ccaThresholdDbm(channelWidthMhz: number): number {
	const width = channelWidthMhz > 0 ? channelWidthMhz : 20;
	// 20 MHz 时 −82 dBm，每翻一倍 +3 dB，不低于标准给定值。
	const doublings = Math.max(0, Math.log2(width / 20));
	return -82 + 3 * doublings;
}

/**
 * 样本计为完全覆盖所需的余量，单位 dB，取 10。
 *
 * 使单元格内保留真实梯度，而不是非覆盖即满分的阶跃。
 */
export const OPTIMIZER_FULL_MARGIN_DB = 10;

/**
 * 低于覆盖阈值仍计入少量效用的范围，单位 dB，取 10。
 *
 * 取 0 即退化为硬阈值；效用从阈值下方 `S` dB 处线性升到上方 `OPTIMIZER_FULL_MARGIN_DB` 处。
 */
export const DEFAULT_COVERAGE_SOFTNESS_DB = 10;

/**
 * 从信号源出发仍可能被覆盖的最大距离，单位米，可附加固定的额外损耗。
 *
 * 损耗只会缩小余量，超出该距离的样本在步进射线前即可判定为未覆盖。
 */
export function coverageReach(radius: number, lossDb = 0): number {
	if (radius <= 0) return 0;
	return distanceForRelativeLoss(relativePathLossDb(radius) - COVERAGE_MARGIN_DB - lossDb);
}


/**
 * 信号源余量降到阈值以上 `marginDb` 处的水平距离，单位米。
 *
 * 垂直方向已消耗的距离由 `verticalGap` 扣除，用于跨楼层的范围裁剪。
 */
export function coverageHorizontalReach(
	radius: number,
	lossDb = 0,
	verticalGap = 0,
	marginDb = 0
): number {
	const reach = reachAtMargin(radius, lossDb, marginDb);
	if (verticalGap <= 0) return reach;
	return Math.sqrt(Math.max(0, reach * reach - verticalGap * verticalGap));
}

/**
 * 信号源余量降到阈值以上 `marginDb` 处的距离，单位米；`coverageReach` 即 `marginDb` 为 0 的情形。
 *
 * `marginDb` 为负时范围更远，干扰模型需要用它覆盖低于阈值的样本。
 */
export function reachAtMargin(radius: number, lossDb = 0, marginDb = 0): number {
	if (radius <= 0) return 0;
	return distanceForRelativeLoss(
		relativePathLossDb(radius) - COVERAGE_MARGIN_DB - marginDb - lossDb
	);
}

/**
 * AP 自由空间电平降到 `floorDbm` 处的距离，单位米。
 * `referenceDbm` 为该 AP 在 1 m 处的电平；用于按热图色阶下限确定绘图范围。
 */
export function reachAtLevel(referenceDbm: number, floorDbm: number): number {
	const headroomDb = referenceDbm - floorDbm;
	if (!(headroomDb > 0)) return 0;
	return distanceForRelativeLoss(headroomDb);
}

/**
 * 把高于灵敏度的余量映射为优化器使用的 [0, 1] 效用值。
 *
 * 覆盖阈值的偏移在此处统一扣除；按 dB 线性，使优化目标、覆盖百分比与热图度量同一量。
 */
export function coverageUtility(marginAboveSensitivityDb: number, softnessDb = 0): number {
	return coverageUtilityAboveThreshold(marginAboveSensitivityDb - COVERAGE_MARGIN_DB, softnessDb);
}

/**
 * 输入余量已相对覆盖阈值时计算效用。
 *
 * `softnessDb` 为 0 即硬阈值；是否计为覆盖仍由 `marginDb > 0` 决定，覆盖百分比是样本占比而非效用之和。
 */
export function coverageUtilityAboveThreshold(marginDb: number, softnessDb = 0): number {
	if (softnessDb > 0) {
		const value = (marginDb + softnessDb) / (OPTIMIZER_FULL_MARGIN_DB + softnessDb);
		if (value <= 0) return 0;
		return value >= 1 ? 1 : value;
	}
	if (!(marginDb > 0)) return 0;
	if (marginDb >= OPTIMIZER_FULL_MARGIN_DB) return 1;
	return marginDb / OPTIMIZER_FULL_MARGIN_DB;
}

/**
 * 由线性功率系数 `10^(-db/10)` 反算楼板损耗，单位 dB。
 *
 * 反算为 dB 后，跨楼层贡献可与其它损耗一样直接从覆盖余量中减去；系数非正时返回 Infinity。
 */
export function slabDbOf(signalScale: number): number {
	return signalScale > 0 ? -10 * Math.log10(signalScale) : Infinity;
}

/**
 * 超出 1 m 参考损耗的部分，单位 dB；覆盖色阶使用该量，0 dB 对应 1 m 处。
 *
 * 单指数区为 `10·n·log10(d)`，越过菲涅尔折断点后为指数过渡段的积分；距离钳制到 1 m。
 */
export function relativePathLossDb(distanceMeters: number): number {
	const d = distanceMeters > 1 ? distanceMeters : 1;
	return relativeLossAtLog10(Math.log10(d));
}
