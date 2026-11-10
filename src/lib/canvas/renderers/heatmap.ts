import { debug } from '$lib/log.js';
import type { Layer, RenderContext } from '../types.js';
import type { AccessPoint } from '$state/ap-state.svelte.js';

/** 带可选跨楼层参数的接入点，用于三维传播计算。 */
/** 主线程同步生成用 canvas，Worker 返回 ImageBitmap。 */
type HeatmapImage = HTMLCanvasElement | ImageBitmap;

type HeatmapAp = AccessPoint & {
	verticalOffset?: number; // 单位米：层高 × 间隔楼层数
	floorDbPerMeter?: number; // 单位 dB/m：穿过楼板材料的损耗
	floorThickness?: number; // 楼板厚度，单位米
	/**
	 * 接入点所在楼层，用于在楼板处拆分跨楼层路径。
	 * 为 null 或缺失时表示接入点在本层，或该楼层没有可用掩码，路径按单段处理。
	 */
	crossFloor?: {
		mask: DecodedWallMask;
		materialMap: Uint8Array | null;
		defaultMaterial: WallMaterialId;
		/** 射线离开接入点本层的位置，取射线长度的比例。 */
		sourceT: number;
		/** 射线进入当前楼层的位置，取射线长度的比例。 */
		targetT: number;
		/**
		 * 楼板所跨楼层（两层中的上层）的房间类型栅格。
		 * `Void / Atrium` 表示楼板开洞，射线穿过该处不计楼板损耗；为 null 时处处计入。
		 */
		slabRoomType?: {
			data: Uint8Array;
			width: number;
			height: number;
			originX: number;
			originY: number;
		} | null;
		/** 射线穿过楼板的位置，取射线长度的比例。 */
		slabT?: number;
	} | null;
};
import type { DecodedWallMask } from '../mask-codec.js';
import { computeBuildingInterior } from '../morphology.js';
import type { WallMaterialId } from '$lib/domain/materials.js';
import { getMaterialDbTable, getFlatAttenuation, getCrossPolarizationRatio } from '$lib/domain/materials.js';
import type { Band } from '@aetherax/channels';
import { crossFloorSegments, pointAlong, slabIsVoid } from '$lib/rf/cross-floor.js';
import { heatmapRegion } from './heatmap-region.js';
import {
	pathLossDb,
	relativePathLossDb,
	thermalNoiseFloorDbm,
	getAttenField,
	lookupAtten,
	invalidateAttenCache,
	type AttenField
} from '../../rf/propagation.js';
import { antennaRayLossDb, antennaSignature, type AntennaProfile } from '../../rf/antenna.js';
import { wallRunLoss } from '../../rf/link-budget.js';
import { surfaceHeightAt, deckCrossing, type ElevatedSurface as ElevatableSurface } from '../../rf/surface-height.js';
import { reflections, secondOrderReflection, reflectionCoefficients, type ReflectingWall, type ReflectionPair } from '../../rf/reflection.js';
import { cMul, linearPolarizationPower, pathPhase, sinrDb, type Complex } from '../../rf/field.js';import { BAND_FREQUENCY_GHZ } from '../../rf/material-itu.js';
import { diffractionPaths, bandWavelengthM, edgesOf, type DiffractionEdge } from '../../rf/diffraction.js';
import { rayWallLossDb } from '../../rf/wall-crossings.js';
import { diffuseLevelDb } from '../../rf/scattering.js';
import { productionDirectGpu, type ProductionDirectInput } from '../../gpu/production-direct.js';
import { pathLossN } from '../../rf/propagation.js';
import {
	diffractionCandidatesForAp,
	DIFFRACTION_MAX_CLEARANCE_M,
	DIFFRACTION_MAX_DISTANCE_M,
	reflectionCandidates,
	reflectionPairsForAp,
	scatterSamplesForAp,
	type ReflectionCandidateSet,
	type ScatterSample
} from '../../rf/path-candidates.js';

import { rampColorAt } from '../heatmap-ramp.js';
import { maskContentSignature, maskSignature } from '../mask-registry.js';
import { antennaProfileForMount } from '../../rf/antenna.js';

/**
 * 热力图每个纹素对应的世界坐标单位数。
 * 在世界坐标中生成，平移和缩放只需按相机变换绘制一次图像。
 */
/**
 * 热力图每个纹素对应的世界坐标单位数。
 * 单个纹素的代价是一次沿墙体的步进计算，因此取值需在轮廓平滑度与耗时之间折中。
 */
const TEXEL_FINE = 3;
const TEXEL_COARSE = 12;
/**
 * 一次重建允许填充的纹素数量上限。
 * 超过该值后按比例放宽纹素间距，而不是裁剪图像。
 */
const MAX_TEXELS = 1_000_000;

/**
 * 衰减场在接入点关联半径之外额外延伸的倍数。
 * 衰减场需覆盖图像可绘制的全部纹素以及跨楼层路径在楼板处的切分点。
 */
const FIELD_MARGIN_FACTOR = 1.65;

/**
 * 色阶默认显示的最低接收电平，单位 dBm。
 * 与范围模型使用的接收灵敏度 `RECEIVER_SENSITIVITY_DBM` 一致，因此显示范围与覆盖圆相同。
 */
const DEFAULT_RSSI_FLOOR = -85;

// 颜色查找表：256 项，启动时由共享色阶（`canvas/heatmap-ramp.ts`）构建一次。
function packColor(r: number, g: number, b: number, a: number): number {
	return ((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff);
}

const LUT = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
	const c = rampColorAt(i / 255);
	LUT[i] = packColor(c.r, c.g, c.b, c.a);
}
// LUT[0] 必须为 0，这样透明像素才会被 `!color` 判断跳过
LUT[0] = 0;

/**
 * 单个色带的宽度，单位 dB。
 * 色带数量由色阶自身跨度决定，调整门限或接入点功率不改变映射关系。
 */
const BAND_DB = 5;

/**
 * 删除小于 `minPixels` 的封闭区域。
 * 墙体双线之间的缝隙、门框后的空腔等会被围成小块，需剔除以免在房间外画出色斑。
 */
function dropSmallRegions(mask: Uint8Array, width: number, height: number, minPixels: number): void {
	const seen = new Uint8Array(mask.length);
	const stack: number[] = [];
	const region: number[] = [];
	for (let start = 0; start < mask.length; start++) {
		if (!mask[start] || seen[start]) continue;
		region.length = 0;
		stack.length = 0;
		stack.push(start);
		seen[start] = 1;
		while (stack.length > 0) {
			const index = stack.pop()!;
			region.push(index);
			const x = index % width;
			const y = (index - x) / width;
			if (x > 0 && mask[index - 1] && !seen[index - 1]) {
				seen[index - 1] = 1;
				stack.push(index - 1);
			}
			if (x < width - 1 && mask[index + 1] && !seen[index + 1]) {
				seen[index + 1] = 1;
				stack.push(index + 1);
			}
			if (y > 0 && mask[index - width] && !seen[index - width]) {
				seen[index - width] = 1;
				stack.push(index - width);
			}
			if (y < height - 1 && mask[index + width] && !seen[index + width]) {
				seen[index + width] = 1;
				stack.push(index + width);
			}
		}
		if (region.length < minPixels) {
			for (const index of region) mask[index] = 0;
		}
	}
}

/**
 * 用交叉数法判断点是否在闭合多边形内。
 * 多边形只是一层的轮廓，顶点数很少，直接线性扫描即可。
 */
function pointInPolygon(
	x: number,
	y: number,
	polygon: ReadonlyArray<{ x: number; y: number }>
): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i]!.x;
		const yi = polygon[i]!.y;
		const xj = polygon[j]!.x;
		const yj = polygon[j]!.y;
		const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
		if (intersects) inside = !inside;
	}
	return inside;
}

/**
 * 对电平栅格做两次可分离 3×3 均值模糊，并跳过缺失的纹素。
 * 平滑的是电平而非颜色；低于色阶门限的 NaN 不参与平均，避免覆盖区外出现亮边。
 */
function boxBlurLevels(levels: Float32Array, cols: number, rows: number): Float32Array {
	let source = levels;
	for (let pass = 0; pass < 3; pass++) {
		const target = new Float32Array(cols * rows).fill(Number.NaN);
		for (let y = 0; y < rows; y++) {
			const y0 = y > 0 ? y - 1 : 0;
			const y1 = y < rows - 1 ? y + 1 : rows - 1;
			for (let x = 0; x < cols; x++) {
				const x0 = x > 0 ? x - 1 : 0;
				const x1 = x < cols - 1 ? x + 1 : cols - 1;
				let sum = 0;
				let count = 0;
				for (let sy = y0; sy <= y1; sy++) {
					const row = sy * cols;
					for (let sx = x0; sx <= x1; sx++) {
						const value = source[row + sx]!;
						if (!Number.isNaN(value)) {
							sum += value;
							count++;
						}
					}
				}
				target[y * cols + x] = count > 0 ? sum / count : Number.NaN;
			}
		}
		source = target;
	}
	return source;
}

/**
 * 热力图图层，在主线程同步渲染。
 * 墙体衰减取自 rf/propagation.ts 的预计算场，读取为 O(1)。
 */
/**
 * `generateWorld` 从图层读取的全部输入，因此可为当前未显示的楼层生成图像。
 */
export interface HeatmapInput {
	aps: HeatmapAp[];
	wallMask: DecodedWallMask | null;
	materialMap: Uint8Array | null;
	defaultMaterial: WallMaterialId;
	worldUnitsPerMeter: number;
	rssiFloor: number;
	/** `wallMask` 的身份标识，用于衰减场缓存，见 `maskTag`。 */
	maskTag?: string;
	/**
	 * 本层的抬高行走面：夹层、楼梯、坡道。
	 * 接收电平取决于客户端与接入点的垂直间距，抬高区域按其实际高度着色。
	 */
	surfaces?: ElevatableSurface[];
	/**
	 * 本层衰减场裁剪所用的轮廓，以及该轮廓是否为唯一依据。
	 * 其他楼层的瓦片必须使用该楼层自己的规划区域。
	 */
	clipPolygon?: Array<{ x: number; y: number }> | null;
	clipStrict?: boolean;
	reflectingWalls?: ReflectingWall[];
	wallHeightM?: number;
	metric?: 'rssi' | 'sinr';
	receiverPolarizationAngleDeg?: number;
}

export class HeatmapLayer implements Layer {
	id = 'heatmap';
	visible = false;
	aps: HeatmapAp[] = [];
	/**
	 * 仅为兼容 API 保留，已不影响热力图：色阶是信号电平（dB）标度。
	 * 吞吐量面板仍在使用它。
	 */
	ispSpeed = 0;
	wallMask: DecodedWallMask | null = null;
	wallAttenuation = 5;
	materialMap: Uint8Array | null = null;
	materialVersion = 0;
	defaultMaterial: WallMaterialId = 0;
	/** 本图对应楼层的抬高行走面，见 `HeatmapInput`。 */
	surfaces: ElevatableSurface[] = [];
	/**
	 * 墙体线段，供本渲染器计算镜面反射。
	 * 与 `wallMask` 分开：掩码只表达遮挡，反射需要线段自身的走向。
	 */
	reflectingWalls: ReflectingWall[] = [];
	/**
	 * 裁剪所用的建筑内部区域，按生成它的掩码缓存。
	 * 该结果只取决于墙体掩码，掩码签名变化时失效。
	 */
	private interiorCache: { key: string; data: Uint8Array } | null = null;
	/**
	 * 建筑轮廓（如果平面图中有），使图像止于墙体。
	 * 为 null 时不裁剪，衰减场会画到图纸边缘之外。
	 */
	clipPolygon: Array<{ x: number; y: number }> | null = null;
	/**
	 * 轮廓是唯一依据，还是需要与墙体内部区域合并。
	 * 用户手绘的规划区域按精确裁剪，检测出的边界与墙体内部区域取并集。
	 */
	clipStrict = false;
	isDragging = false;
	/**
	 * 当前楼层的墙体掩码正在加载。
	 * 切换楼层后掩码尚未解码完成时置位，避免在无墙数据下做一次无效重建。
	 */
	maskPending = false;
	/**
	 * 当前已加载墙体掩码的身份标识，用于衰减场缓存。
	 * 缓存键含位置、半径和该标识而不含掩码内容，缺少它时不同楼层会共用同一衰减场。
	 */
	maskTag = '';
	worldUnitsPerMeter = 32.8; // 由 getEffectiveWupm() 更新
	/** 当前楼层墙高，单位米；一维漫散射积分用它把墙长换算成面积。 */
	wallHeightM = 3;
	/** 使用 V/H 复场相干合成；关闭时退回旧的功率相加。 */
	coherent = true;
	/**
	 * 色阶显示的最低接收电平，单位 dBm；低于该值的像素透明。
	 * 色阶从该值延伸到最强接入点 1 m 处的电平（`P_tx - PL0`）。
	 */
	rssiFloor = DEFAULT_RSSI_FLOOR;
	/** 显示指标；SINR 使用固定的 -5..30 dB 色阶。 */
	metric: 'rssi' | 'sinr' = 'rssi';
	/** 接收端线极化角，0 为垂直。 */
	receiverPolarizationAngleDeg = 0;
	/** 当前生成所属楼层；缓存按楼层分开，切回时可直接命中。 */
	floorId = '';

	private cache: HeatmapImage | null = null;
	private cacheKey = '';
	/** 当前输入下 GPU 生成的逐 AP 直射基础电平。 */
	private gpuDirect: { key: string; levels: Float32Array; apCount: number; pixels: number } | null =
		null;
	private gpuDirectPending = '';
	private gpuDirectUnavailable = false;
	/**
	 * GPU 直射场默认关闭：首次创建 device/pipeline/shader 的同步初始化在部分
	 * Intel 驱动上会让打开热力图停顿数秒，而当前直射项只占热力图总耗时的一部分。
	 * 需要实验时再打开；CPU/Worker 路径始终可用。
	 */
	gpuDirectEnabled = false;
	/** 小网格上 GPU 的初始化/提交开销大于收益，低于该纹素数保留 CPU。 */
	gpuDirectMinPixels = 120_000;

	private scheduleGpuDirect(input: ProductionDirectInput, key: string): void {
		if (!this.gpuDirectEnabled || this.gpuDirectUnavailable) return;
		if (this.gpuDirect?.key === key || this.gpuDirectPending === key) return;
		this.gpuDirectPending = key;
		void productionDirectGpu(input)
			.then((result) => {
				this.gpuDirectPending = '';
				if (!result) {
					this.gpuDirectUnavailable = true;
					return;
				}
				this.gpuDirect = {
					key,
					levels: result.dbm,
					apCount: result.apCount,
					pixels: result.pixels
				};
				// 当前图像是用 CPU 直射项生成的；丢掉它，下一帧用 GPU 结果重建。
				this.cacheEntries.delete(key);
				this.cacheKey = '';
				this.cache = null;
				this.onGenerated?.();
			})
			.catch(() => {
				this.gpuDirectPending = '';
				this.gpuDirectUnavailable = true;
			});
	}
	worker: Worker | null = null;
	onGenerated: (() => void) | null = null;
	private workerRequestId = 0;
	private workerJobs = new Map<number, string>();
	private workerTimer: ReturnType<typeof setTimeout> | null = null;
	private workerDebounce: ReturnType<typeof setTimeout> | null = null;
	private pendingWorkerKey = '';

	attachWorker(worker: Worker): void {
		this.worker = worker;
		worker.onmessage = (event: MessageEvent<{
			id: number;
			key: string;
			pixels: ArrayBuffer | null;
			colored?: number;
			width: number;
			height: number;
			x0: number;
			y0: number;
			texel: number;
		}>) => {
			const { id, key, pixels, colored, width, height, x0, y0, texel } = event.data;
			if (this.workerTimer) {
				clearTimeout(this.workerTimer);
				this.workerTimer = null;
			}
			debug(
				`[heatmap-worker] id=${id} key=${key.slice(-18)} pixels=${pixels?.byteLength ?? 0} colored=${colored ?? 0} at ${x0},${y0} texel=${texel}`
			);
			this.workerJobs.delete(id);
			// A late result for an older key must not become the current raster.
			if (key !== this.pendingWorkerKey) return;
			this.pendingWorkerKey = '';
			if (!pixels) {
				// Worker could not produce a raster; fall back to the synchronous path.
				this.worker = null;
				this.workerJobs.clear();
				this.cache = null;
				this.cacheKey = '';
				this.onGenerated?.();
				return;
			}
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext('2d')!;
			context.putImageData(
				new ImageData(new Uint8ClampedArray(pixels), width, height),
				0,
				0
			);
			this.cache = canvas;
			this.cacheX0 = x0;
			this.cacheY0 = y0;
			this.cacheTexel = texel;
			this.cacheKey = key;
			this.cacheEntries.set(key, { canvas, x0, y0, texel });
			// The wall editor can finish a frame between the message and the callback;
			// queue one more repaint so the worker raster is guaranteed to be seen.
			this.onGenerated?.();
			requestAnimationFrame(() => this.onGenerated?.());
		};
		worker.onerror = (event) => {
			console.warn('[heatmap] worker failed, falling back to CPU:', event.message);
			if (this.workerTimer) {
				clearTimeout(this.workerTimer);
				this.workerTimer = null;
			}
			this.worker = null;
			this.workerJobs.clear();
			this.cacheKey = '';
			this.onGenerated?.();
		};
	}
	/** 已生成的热力图按完整输入键缓存，切换楼层再切回来时直接复用。 */
	private cacheEntries = new Map<
		string,
		{ canvas: HeatmapImage; x0: number; y0: number; texel: number }
	>();
	private static readonly MAX_CACHE_ENTRIES = 12;
	/** `cache` 在世界坐标中的原点位置，以及每个纹素对应的世界坐标单位数。 */
	private cacheX0 = 0;
	private cacheY0 = 0;
	private cacheTexel = TEXEL_FINE;
	/**
	 * 反射/绕射候选跨帧缓存。候选只取决于 AP 位置与频段、墙体几何、楼层标定；
	 * 平移、缩放、平滑参数变化时可直接复用。
	 */
	private pathCandidates: {
		key: string;
		reflectionByAp: ReflectionCandidateSet[];
		diffractionByAp: DiffractionEdge[][];
		scatterByAp: ScatterSample[][];
		secondOrderByAp: ReflectionPair[][];
	} | null = null;

	markWallsDirty(): void {
		// 不删除具体缓存项：这里拿不到楼层 id，而键本身包含掩码/材质签名。
		// 当前图下次会按新键重建；其他楼层的缓存继续保留。
		this.cacheKey = '';
		invalidateAttenCache();
	}

	/**
	 * 输入发生变化时重建世界坐标下的缓存图像。
	 * 从 `render` 中拆出，使平铺楼层总览无需本图层绘制也能取得图像。
	 */
	/** 只传 plain data；Svelte 的 state proxy 不能直接 postMessage。 */
	private workerInput(): HeatmapInput {
		const mask = this.wallMask
			? {
					...this.wallMask,
					data: new Uint8Array(this.wallMask.data)
				}
			: null;
		const aps = this.aps.map((ap) => {
			const crossFloor = ap.crossFloor
				? {
						...ap.crossFloor,
						mask: {
							...ap.crossFloor.mask,
							data: new Uint8Array(ap.crossFloor.mask.data)
						},
						materialMap: ap.crossFloor.materialMap
							? new Uint8Array(ap.crossFloor.materialMap)
							: null,
						slabRoomType: ap.crossFloor.slabRoomType
							? {
									...ap.crossFloor.slabRoomType,
									data: new Uint8Array(ap.crossFloor.slabRoomType.data)
								}
							: null
					}
				: null;
			return { ...ap, crossFloor };
		});
		return {
			aps,
			wallMask: mask,
			materialMap: this.materialMap ? new Uint8Array(this.materialMap) : null,
			defaultMaterial: this.defaultMaterial,
			worldUnitsPerMeter: this.worldUnitsPerMeter,
			rssiFloor: this.rssiFloor,
			maskTag: this.maskTag,
			surfaces: this.surfaces.map((surface) => ({ ...surface })),
			clipPolygon: this.clipPolygon?.map((point) => ({ x: point.x, y: point.y })) ?? null,
			clipStrict: this.clipStrict,
			reflectingWalls: this.reflectingWalls.map((wall) => ({ ...wall })),
			wallHeightM: this.wallHeightM,
			metric: this.metric,
			receiverPolarizationAngleDeg: this.receiverPolarizationAngleDeg
		};
	}

	ensureGenerated(): void {
		if (this.aps.length === 0) {
			this.cache = null;
			this.cacheKey = '';
			return;
		}
		const key = this.getCacheKey();
		if (key === this.cacheKey) return;
		/*
		 * 新楼层还没有户型/墙体时，唯一的热力图来源是其他楼层的虚拟 AP。
		 * 这种图没有本层几何可裁剪，生成成本高且没有意义；等本层有墙体后再画。
		 */
		if (!this.wallMask && this.aps.every((ap) => !!ap.crossFloor)) {
			this.cache = null;
			this.cacheKey = key;
			return;
		}
		const cached = this.cacheEntries.get(key);
		if (cached) {
			this.cache = cached.canvas;
			this.cacheX0 = cached.x0;
			this.cacheY0 = cached.y0;
			this.cacheTexel = cached.texel;
			this.cacheKey = key;
			this.pendingWorkerKey = '';
			// 命中后移到末尾，Map 的插入顺序即 LRU 顺序。
			this.cacheEntries.delete(key);
			this.cacheEntries.set(key, cached);
			return;
		}
		this.cacheKey = key;
		if (this.worker) {
			const input = this.workerInput();
			const id = ++this.workerRequestId;
			this.cache = null;
			if (this.workerDebounce) clearTimeout(this.workerDebounce);
			/*
			 * 画墙/对齐会在一帧内连续改变裁剪键。等输入稳定后再发，避免把中间键
			 * 的请求留成 pending，新的键永远等不到结果。
			 */
			this.workerDebounce = setTimeout(() => {
				this.workerDebounce = null;
				if (this.cacheKey !== key || !this.worker) return;
				this.pendingWorkerKey = key;
				this.workerJobs.set(id, key);
				if (this.workerTimer) clearTimeout(this.workerTimer);
				this.workerTimer = setTimeout(() => {
					if (this.pendingWorkerKey === key && !this.cache) {
						this.worker = null;
						this.workerJobs.clear();
						this.pendingWorkerKey = '';
						this.cacheKey = '';
						this.onGenerated?.();
					}
				}, 800);
				try {
					this.worker.postMessage({ id, key, input });
				} catch {
					this.worker = null;
					this.workerJobs.clear();
					this.pendingWorkerKey = '';
					this.cacheKey = '';
					this.onGenerated?.();
				}
			}, 50);
			return;
		}
		const started = performance.now();
		const generated = this.generateWorld();
		this.cache = generated?.canvas ?? null;
		this.cacheX0 = generated?.x0 ?? 0;
		this.cacheY0 = generated?.y0 ?? 0;
		this.cacheTexel = generated?.texel ?? TEXEL_FINE;
		if (generated) {
			this.cacheEntries.set(key, {
				canvas: generated.canvas,
				x0: generated.x0,
				y0: generated.y0,
				texel: generated.texel
			});
			while (this.cacheEntries.size > HeatmapLayer.MAX_CACHE_ENTRIES) {
				const oldest = this.cacheEntries.keys().next().value;
				if (oldest === undefined) break;
				this.cacheEntries.delete(oldest);
			}
		}
		// 计时：一次生成会遍历整个平面，且发生在手势结束的那一帧，卡顿最易被感知。
		debug(`[heatmap] ${generated ? 'generated' : 'skipped'} in ${Math.round(performance.now() - started)} ms`);
	}

	/**
	 * 为任意楼层生成世界坐标下的覆盖图像。
	 * 生成期间临时替换图层的输入并在结束后恢复，因此不会影响图层自身的缓存。
	 */
	generateFor(
		input: HeatmapInput
	): { canvas: HTMLCanvasElement; x0: number; y0: number; texel: number } | null {
		if (input.aps.length === 0) return null;

		const savedAps = this.aps;
		const savedMask = this.wallMask;
		const savedMaterial = this.materialMap;
		const savedDefaultMaterial = this.defaultMaterial;
		const savedWupm = this.worldUnitsPerMeter;
		const savedRssiFloor = this.rssiFloor;
		const savedDragging = this.isDragging;
		const savedMaskTag = this.maskTag;
		const savedSurfaces = this.surfaces;
		const savedClip = this.clipPolygon;
		const savedClipStrict = this.clipStrict;
		const savedGpuEnabled = this.gpuDirectEnabled;

		try {
			this.gpuDirectEnabled = false;
			this.aps = input.aps;
			this.wallMask = input.wallMask;
			this.materialMap = input.materialMap;
			this.defaultMaterial = input.defaultMaterial;
			this.worldUnitsPerMeter = input.worldUnitsPerMeter;
			this.rssiFloor = input.rssiFloor;
			// 指明这些墙体属于哪一层，避免衰减场缓存把其他楼层的衰减结果给到本层接入点。
			// 见 `maskTag`。
			this.maskTag = input.maskTag ?? '';
			this.surfaces = input.surfaces ?? [];
			this.clipPolygon = input.clipPolygon ?? null;
			this.clipStrict = input.clipStrict ?? false;
			// 使用完整分辨率：瓦片是静态对比图，不涉及拖拽。
			this.isDragging = false;
			return this.generateWorld();
		} finally {
			this.aps = savedAps;
			this.wallMask = savedMask;
			this.materialMap = savedMaterial;
			this.defaultMaterial = savedDefaultMaterial;
			this.worldUnitsPerMeter = savedWupm;
			this.rssiFloor = savedRssiFloor;
			this.isDragging = savedDragging;
			this.maskTag = savedMaskTag;
			this.surfaces = savedSurfaces;
			this.clipPolygon = savedClip;
			this.clipStrict = savedClipStrict;
			this.gpuDirectEnabled = savedGpuEnabled;
		}
	}

	render(rc: RenderContext): void {
		this.ensureGenerated();
		if (!this.cache) return;

		// 在相机变换下直接绘制图像，这是每帧的全部开销，与接入点数量或纹素数量无关。
		const { ctx, camera, dpr } = rc;
		const [a, b, c, d, e, f] = camera.getTransform();
		ctx.save();
		ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
		// 图像在世界坐标中生成后在此放大，此处启用高质量采样；本图层是唯一会被放大的图层。
		const smoothing = ctx.imageSmoothingEnabled;
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(
			this.cache,
			this.cacheX0,
			this.cacheY0,
			this.cache.width * this.cacheTexel,
			this.cache.height * this.cacheTexel
		);
		ctx.imageSmoothingEnabled = smoothing;
		ctx.restore();
	}

	/**
	 * 生成热力图的缓存键。
	 * 相机不参与：图像位于世界坐标，平移和缩放不会使其失效；`texel` 参与，因为拖拽时使用更粗的分辨率。
	 * 热力图只渲染覆盖（各接入点路径损耗、墙体损耗与楼板损耗的最大值），不建模同频干扰。
	 */
	private getCacheKey(): string {
		// 拖拽时位置按粗纹素量化：图像原点本就对齐该栅格，几个像素的位移不会改变画面。
		const step = this.isDragging ? TEXEL_COARSE : 1;
		const snap = (v: number) => Math.round(v / step) * step;
		return (
			this.aps
				.map(
					(ap) =>
						`${ap.id}:${snap(ap.x)}:${snap(ap.y)}:${ap.interferenceRadius}:${ap.band}:${ap.channelWidth}:${ap.power}:${ap.verticalOffset ?? 0}:${ap.floorDbPerMeter ?? 0}:${ap.floorThickness ?? 0}:` +
						// 完整的天线方向图，由 `antennaSignature` 统一列明其依赖：安装朝向变化会改变画面。
						antennaSignature(ap) +
						// 路径在楼板处拆分时还需接入点本层的掩码：编辑该层墙体同样会改变本图。
						(ap.crossFloor
							? `:cf${ap.crossFloor.mask.width}x${ap.crossFloor.mask.height}@${ap.crossFloor.mask.originX},${ap.crossFloor.mask.originY}:${ap.crossFloor.sourceT.toFixed(4)},${ap.crossFloor.targetT.toFixed(4)}:${ap.crossFloor.defaultMaterial}`
							: '')
				)
				.join('|') +
			`|floor:${this.rssiFloor}|metric:${this.metric}|rxpol:${this.receiverPolarizationAngleDeg}|t:${this.isDragging ? 'c' : 'f'}` +
			`|id:${this.floorId}` +
			`|wm:${this.wallMask?.width ?? 0}x${this.wallMask?.height ?? 0}:${this.wallMask?.originX ?? 0},${this.wallMask?.originY ?? 0}` +
			// 掩码对象本身，而不仅是其几何尺寸：同尺寸替换掩码时，缓存中的衰减场也会随之失效。
			`|wms:${maskContentSignature(this.wallMask)}:${maskSignature(this.materialMap)}` +
			`|mat:${this.defaultMaterial}|mv:${this.materialVersion}|wupm:${this.worldUnitsPerMeter}` +
			`|wh:${this.wallHeightM}` +
			// 抬高面移动的是客户端而非接入点：同一平面加入夹层后画面不同。
			`|surf:${this.surfaces
				.map((s) => `${s.kind}:${s.ax},${s.ay},${s.bx},${s.by}:${s.heightM}/${s.topHeightM}`)
				.join(';')}` +
			// 反射线段：其走向决定反射项，编辑线段即使掩码框不变也会移动反射项。
			`|rw:${this.reflectingWalls
				.map((w) => `${w.ax},${w.ay},${w.bx},${w.by}:${w.material}`)
				.join(';')}` +
			// 裁剪决定哪些纹素存在，因此属于图像的一部分。
			`|clip:${this.clipPolygon?.map((p) => `${p.x},${p.y}`).join(';') ?? ''}` +
			`|clipstrict:${this.clipStrict ? 1 : 0}`
		);
	}

	/**
	 * 把热力图生成为世界坐标下的图像。
	 * 返回画布及其覆盖的世界坐标矩形；无接入点或墙体掩码尚未就绪时返回 null。
	 */
	private generateWorld(): { canvas: HTMLCanvasElement; x0: number; y0: number; texel: number } | null {
		const n = this.aps.length;
		if (n === 0) return null;
		// 墙体掩码正在解码，此时生成会在无墙数据下遍历全部纹素，结果随后被丢弃。
		if (!this.wallMask && this.maskPending) return null;

		const wupm = this.worldUnitsPerMeter;
		const metersPerWorldUnit = wupm > 0 ? 1 / wupm : 0;
		const fast = this.isDragging;

		// 覆盖范围：平面本身，加上这组接入点可能着色的全部区域，见 `heatmapRegion`。
		// 按色阶门限而非关联半径计算，避免被迫放粗纹素。
		const wm = this.wallMask;
		const region = heatmapRegion(
			this.aps,
			wm
				? { originX: wm.originX, originY: wm.originY, width: wm.width, height: wm.height }
				: null,
			this.rssiFloor,
			wupm,
			this.isDragging ? TEXEL_COARSE : TEXEL_FINE,
			MAX_TEXELS,
			// 手绘区域可以超出掩码范围，图像必须覆盖到它。
			this.isDragging ? null : this.clipPolygon
		);
		if (!region) return null;
		/*
		 * 把图像收缩到楼层自身的范围。
		 * 掩码框即楼层范围，与区域求交可跳过裁剪会逐个丢弃的纹素。
		 * 手绘规划区域是例外，它可能超出掩码框，此时并入轮廓的外接框。
		 */
		let bounds = wm
			? {
					x0: wm.originX,
					y0: wm.originY,
					x1: wm.originX + wm.width,
					y1: wm.originY + wm.height
				}
			: null;
		if (this.clipPolygon && this.clipPolygon.length >= 3 && !this.isDragging) {
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const point of this.clipPolygon) {
				if (point.x < minX) minX = point.x;
				if (point.y < minY) minY = point.y;
				if (point.x > maxX) maxX = point.x;
				if (point.y > maxY) maxY = point.y;
			}
			bounds = bounds
				? {
						x0: Math.min(bounds.x0, minX),
						y0: Math.min(bounds.y0, minY),
						x1: Math.max(bounds.x1, maxX),
						y1: Math.max(bounds.y1, maxY)
					}
				: { x0: minX, y0: minY, x1: maxX, y1: maxY };
		}
		const clipped = bounds
			? {
					x0: Math.max(region.x0, bounds.x0),
					y0: Math.max(region.y0, bounds.y0),
					x1: Math.min(region.x0 + region.cols * region.texel, bounds.x1),
					y1: Math.min(region.y0 + region.rows * region.texel, bounds.y1)
				}
			: null;
		const x0 = clipped?.x0 ?? region.x0;
		const y0 = clipped?.y0 ?? region.y0;
		const texel = region.texel;
		const cols = clipped ? Math.max(1, Math.ceil((clipped.x1 - x0) / texel)) : region.cols;
		const rows = clipped ? Math.max(1, Math.ceil((clipped.y1 - y0) / texel)) : region.rows;

		// 墙体衰减与频段相关，因此按实际用到的频段各建一份材料表。
		const matDbByBand = new Map<Band, number[]>();
		const defaultDbByBand = new Map<Band, number>();
		for (const ap of this.aps) {
			if (matDbByBand.has(ap.band)) continue;
			matDbByBand.set(ap.band, getMaterialDbTable(ap.band));
			defaultDbByBand.set(ap.band, getFlatAttenuation(this.defaultMaterial, ap.band));
		}

		// 各接入点的跨楼层参数
		/** 垂直偏移，单位世界坐标单位，用于计算天线仰角。 */
		const vertWu = new Float64Array(n);
		/** 各接入点的垂直天线方向图，见 `rf/antenna.ts`。 */
		const apProfiles: AntennaProfile[] = [];
		const floorDbThickness = new Float64Array(n); // ITU 楼板总隔离度，单位 dB
		const apX = new Float64Array(n);
		const apY = new Float64Array(n);
		const fieldV: Complex[] = Array.from({ length: n }, () => ({ re: 0, im: 0 }));
		const fieldH: Complex[] = Array.from({ length: n }, () => ({ re: 0, im: 0 }));
		const apPowers = new Float64Array(n);
		const addField = (
			index: number,
			power: number,
			phase: number,
			coefficientV: Complex = { re: 1, im: 0 },
			coefficientH: Complex = { re: 0, im: 0 }
		) => {
			const amplitude = Math.sqrt(Math.max(0, power));
			const cos = Math.cos(phase);
			const sin = Math.sin(phase);
			fieldV[index]!.re += amplitude * (coefficientV.re * cos - coefficientV.im * sin);
			fieldV[index]!.im += amplitude * (coefficientV.re * sin + coefficientV.im * cos);
			fieldH[index]!.re += amplitude * (coefficientH.re * cos - coefficientH.im * sin);
			fieldH[index]!.im += amplitude * (coefficientH.re * sin + coefficientH.im * cos);
		};
		/**
		 * 各接入点 1 m 处的电平，单位 dBm：P_tx - PL0(band)。
		 * 以此为各接入点的贡献基准，使功率与频段体现在结果中，色阶门限可用 dBm 表示。
		 */
		const apRefDb = new Float64Array(n);
		/** 各接入点的频段，用于反射系数的频率。 */
		const bands: Band[] = [];
		let rampTop = -Infinity;

		const fields: (AttenField | null)[] = [];
		/**
		 * 路径在楼板处拆分时，接入点本层对应的衰减场。
		 * 只计算从接入点到楼板下穿点的一段，即在切分点处查表。
		 */
		const sourceFields: (AttenField | null)[] = [];
		for (let i = 0; i < n; i++) {
			const ap = this.aps[i]!;
			apX[i] = ap.x;
			apY[i] = ap.y;
			const vo = ap.verticalOffset ?? 0;
			vertWu[i] = vo * wupm;
			// 天线的垂直方向图取决于射线仰角，而仰角逐纹素计算，因此这里只解析方向图。
			apProfiles.push(antennaProfileForMount(ap));
			bands.push(ap.band);
			floorDbThickness[i] = (ap.floorDbPerMeter ?? 0) * (ap.floorThickness ?? 0);
			// pathLossDb(band, 1) 即该频段 1 m 处的参考损耗 PL0。
			apRefDb[i] = ap.power - pathLossDb(ap.band, 1);
			if (apRefDb[i]! > rampTop) rampTop = apRefDb[i]!;
			// interferenceRadius 仍决定墙体衰减场的推进范围，但只推进到本图可读取的位置（`FIELD_MARGIN_FACTOR`）。
			// 缓存标签包含频段、用途和所用掩码：缓存键只有位置与半径，缺少标签时不同频段或不同楼层会共用衰减。
			const bandTag = `${ap.band}:tgt:${this.maskTag}`;
			fields.push(
				this.wallMask
					? getAttenField(
							ap.x,
							ap.y,
							ap.interferenceRadius,
							this.wallMask.data,
							this.wallMask.width,
							this.wallMask.height,
							this.materialMap,
							matDbByBand.get(ap.band)!,
							defaultDbByBand.get(ap.band)!,
							fast,
							this.wallMask.originX,
							this.wallMask.originY,
							bandTag,
							FIELD_MARGIN_FACTOR
						)
					: null
			);
			const cf = ap.crossFloor;
			sourceFields.push(
				cf
					? getAttenField(
							ap.x,
							ap.y,
							ap.interferenceRadius,
							cf.mask.data,
							cf.mask.width,
							cf.mask.height,
							cf.materialMap,
							matDbByBand.get(ap.band)!,
							getFlatAttenuation(cf.defaultMaterial, ap.band),
							fast,
							cf.mask.originX,
							cf.mask.originY,
							`${ap.band}:src:${cf.mask.width}x${cf.mask.height}@${cf.mask.originX},${cf.mask.originY}`,
							FIELD_MARGIN_FACTOR
						)
					: null
			);
		}

		// 色阶从门限延伸到最强接入点 1 m 处的电平；所有接入点都不高于门限时无需绘制。
		const levelFloor = this.metric === 'sinr' ? -5 : this.rssiFloor;
		const levelTop = this.metric === 'sinr' ? 30 : rampTop;
		const span = levelTop - levelFloor;
		if (!(span > 0)) return null;

		const startedAt = performance.now();
		const canvas: HTMLCanvasElement | OffscreenCanvas =
			typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(cols, rows) : document.createElement('canvas');
		canvas.width = cols;
		canvas.height = rows;
		const cctx = canvas.getContext('2d') as CanvasRenderingContext2D;
		const imgData = cctx.createImageData(cols, rows);
		const u32 = new Uint32Array(imgData.data.buffer);
		/** 每个纹素的接收电平，单位 dBm；低于色阶门限处为 NaN。 */
		const levels = new Float32Array(cols * rows).fill(Number.NaN);
		// 抬高面场，采用本循环使用的单位；只解析一次，使内层循环只需一次乘法和一次查表。
		const surfaces = this.surfaces;
		const surfaceScale = this.worldUnitsPerMeter;
		/*
		 * 图像允许绘制的区域。
		 * 有轮廓多边形时使用多边形，并始终加上墙体围出的内部区域。
		 * 内部区域由墙体掩码推导，因此任何有墙体的楼层都有裁剪。
		 */
		/*
		 * GPU 直射场只覆盖同层、同频段、无抬高面的情况；其他情况保留 CPU 路径。
		 * 结果异步返回，当前帧仍用 CPU，下一帧命中后再替换直射项。
		 */
		const gpuBand = bands[0];
		const sameBand = bands.every((band) => band === gpuBand);
		if (
			this.gpuDirectEnabled &&
			!this.gpuDirectUnavailable &&
			this.wallMask &&
			this.surfaces.length === 0 &&
			cols * rows >= this.gpuDirectMinPixels &&
			sameBand &&
			this.aps.every((ap) => !ap.crossFloor)
		) {
			const gpuKey = `${this.cacheKey}|gpu:${cols}x${rows}@${x0},${y0}:${texel}:${gpuBand}`;
			const mask = this.wallMask;
			const input: ProductionDirectInput = {
				width: cols,
				height: rows,
				originX: x0,
				originY: y0,
				texel,
				worldUnitsPerMeter: wupm,
				aps: this.aps.map((ap, i) => ({
					x: apX[i]!,
					y: apY[i]!,
					referenceDbm: apRefDb[i]!,
					pathLossExponent: pathLossN(),
					verticalGapM: vertWu[i]! * metersPerWorldUnit,
					slabLossDb: floorDbThickness[i]!
				})),
				wallMask: {
					data: mask.data,
					width: mask.width,
					height: mask.height,
					originX: mask.originX,
					originY: mask.originY,
					materialMap: this.materialMap,
					materialDb: matDbByBand.get(gpuBand!) ?? getMaterialDbTable(gpuBand!),
					fallbackDb: defaultDbByBand.get(gpuBand!) ?? 0,
					defaultMaterialId: this.defaultMaterial,
					stride: 2
				}
			};
			this.scheduleGpuDirect(input, gpuKey);
		}
		const gpuDirect =
			this.gpuDirect && this.gpuDirect.key.startsWith(`${this.cacheKey}|gpu:`)
				? this.gpuDirect
				: null;

		const outline =
			this.clipPolygon && this.clipPolygon.length >= 3 && !this.isDragging
				? this.clipPolygon
				: null;
		// 手绘区域具有权威性：下面取并集会允许墙体内部画到区域之外。
		const strictOutline = this.clipStrict && !this.isDragging ? outline : null;
		let interior: Uint8Array | null = null;
		const maskForClip = this.wallMask;
		if (maskForClip && !this.isDragging) {
			const key = maskContentSignature(maskForClip);
			if (this.interiorCache?.key === key) {
				interior = this.interiorCache.data;
			} else {
				const computed = computeBuildingInterior(
					maskForClip.data,
					maskForClip.width,
					maskForClip.height,
					{ maxDim: 400, dilateRatio: 0.04, minDilateR: 4, trimWallAdjacent: true }
				).interior;
				/*
				 * 仅在确实围合出区域时使用。
				 * 墙体未闭合的平面没有内部区域，裁剪到空区域会擦掉整幅图。
				 */
				let enclosed = 0;
				for (let i = 0; i < computed.length; i++) if (computed[i]) enclosed++;
				if (enclosed > maskForClip.width * maskForClip.height * 0.02) {
					// 保留房间，剔除图形意外围成的小块：它们会被画在墙线外和墙体端部。
					dropSmallRegions(computed, maskForClip.width, maskForClip.height, 400);
					interior = computed;
				}
				this.interiorCache = { key, data: interior ?? new Uint8Array(0) };
			}
		}
		// 缓存为空数组表示该掩码没有可用内部区域，而不是没有数据。
		if (interior && interior.length === 0) interior = null;
		/*
		 * 每个接入点一次镜面反射，作为功率项。
		 * 拖拽时关闭：反射是本循环开销最大的一步；楼层没有线段时也关闭。
		 */
		const walls = this.isDragging ? [] : this.reflectingWalls;
		const reflectionReach = 24 * this.worldUnitsPerMeter;
		// 每个墙体端点都是一条刃边；每幅图计算一次。
		const edges: DiffractionEdge[] = walls.length > 0 ? edgesOf(walls) : [];
		/*
		 * 二级路径候选按 AP 预计算。反射候选只排除不可能产生反射的墙；绕射候选先把
		 * AP 一侧的可见性和距离筛掉。纹素循环里只处理这些候选，不再每像素重扫全部墙。
		 *
		 * 候选只取决于 AP 位置/频段、墙体几何和楼层标定；平移和缩放不会改变它们，
		 * 因此可以跨帧复用。拖拽时墙体暂时清空，不写入缓存，避免拖拽帧覆盖静止图。
		 */
		const candidateKey = [
			metersPerWorldUnit,
			this.wallHeightM,
			this.aps.map((ap) => `${ap.x},${ap.y},${ap.band}`).join(';'),
			walls.map((wall) => `${wall.ax},${wall.ay},${wall.bx},${wall.by},${wall.material}`).join(';')
		].join('|');
		const cacheable = !this.isDragging;
		let reflectionByAp: ReflectionCandidateSet[];
		let diffractionByAp: DiffractionEdge[][];
		let scatterByAp: ScatterSample[][];
		let secondOrderByAp: ReflectionPair[][];
		if (cacheable && this.pathCandidates?.key === candidateKey) {
			reflectionByAp = this.pathCandidates.reflectionByAp;
			diffractionByAp = this.pathCandidates.diffractionByAp;
			scatterByAp = this.pathCandidates.scatterByAp;
			secondOrderByAp = this.pathCandidates.secondOrderByAp;
		} else {
			reflectionByAp =
				walls.length > 0
					? this.aps.map((ap) => reflectionCandidates(walls, ap.band, reflectionReach))
					: this.aps.map(() => ({ walls: [], wallIndices: [], grid: null }));
			diffractionByAp =
				edges.length > 0
					? this.aps.map((ap) =>
							diffractionCandidatesForAp(
								{ x: ap.x, y: ap.y },
								walls,
								ap.band,
								metersPerWorldUnit,
								this.wallHeightM * this.worldUnitsPerMeter
							)
						)
					: this.aps.map(() => []);
			scatterByAp =
				walls.length > 0
					? this.aps.map((ap) =>
							scatterSamplesForAp(
								{ x: ap.x, y: ap.y },
								walls,
								ap.band,
								metersPerWorldUnit,
								this.wallHeightM
							)
						)
					: this.aps.map(() => []);
			secondOrderByAp =
				walls.length > 0
					? this.aps.map((ap) => reflectionPairsForAp(walls, ap.band, 8))
					: this.aps.map(() => []);
			if (cacheable) {
				this.pathCandidates = {
					key: candidateKey,
					reflectionByAp,
					diffractionByAp,
					scatterByAp,
					secondOrderByAp
				};
			}
		}

		for (let ty = 0; ty < rows; ty++) {
			const wy = y0 + (ty + 0.5) * texel;
			const rowOff = ty * cols;

			for (let tx = 0; tx < cols; tx++) {
				const wx = x0 + (tx + 0.5) * texel;
				/*
				 * 只要任一区域表明此处属于楼层就绘制。
				 * 裁剪取并集：在规划区域内、墙体内部区域内，或两者中存在的那个之内；两者之外即图纸外。
				 */
				if (strictOutline) {
					if (!pointInPolygon(wx, wy, strictOutline)) continue;
				} else if (outline || interior) {
					let inOutline = true;
					let inInterior = true;
					if (outline) inOutline = pointInPolygon(wx, wy, outline);
					if (interior && maskForClip) {
						const ix = Math.round(wx - maskForClip.originX);
						const iy = Math.round(wy - maskForClip.originY);
						inInterior =
							ix >= 0 && iy >= 0 && ix < maskForClip.width && iy < maskForClip.height
								? interior[iy * maskForClip.width + ix] === 1
								: false;
					}
					if (!inOutline && !inInterior) continue;
				}

				/*
				 * 此处客户端所在的高度，单位世界坐标单位。
				 * 地面为零，夹层为层高，楼梯或坡道内按比例插值；楼层无抬高面时直接为零。
				 */
				const liftWu = surfaces.length > 0 ? surfaceHeightAt(surfaces, wx, wy) * surfaceScale : 0;
				if (this.coherent) {
					for (let i = 0; i < n; i++) {
						fieldV[i]!.re = 0;
						fieldV[i]!.im = 0;
						fieldH[i]!.re = 0;
						fieldH[i]!.im = 0;
					}
				}

				// 该纹素处的最强接收电平，单位 dBm。各项都是 dB 可直接相加，仅下方的反射项需换算一次功率。
				let bestDb = -Infinity;
				let reflectedMw = 0;
				let wallLoss = 0;
				for (let i = 0; i < n; i++) {
					wallLoss = 0;
					const polarAngle = ((this.aps[i]!.polarizationAngleDeg ?? 0) * Math.PI) / 180;
					const polarV = Math.cos(polarAngle);
					const polarH = Math.sin(polarAngle);
					const dx = wx - apX[i]!;
					const dy = wy - apY[i]!;
					// 接入点与客户端的高度差，减去客户端所处抬高面的高度；可为负值。
					const gap = vertWu[i]! - liftWu;
					const dWu = Math.sqrt(dx * dx + dy * dy + gap * gap);
					// 从该接入点 1 m 处的电平起算，减去超出的路径损耗；1 m 以内会被
					// relativePathLossDb 截断，因为对数距离模型在该范围内不成立。
					const gpuBase = gpuDirect
						? gpuDirect.levels[i * gpuDirect.pixels + ty * cols + tx]
						: undefined;
					let level =
						gpuBase !== undefined
							? gpuBase
							: apRefDb[i]! - relativePathLossDb(dWu * metersPerWorldUnit);
					if (gpuBase !== undefined) {
						// GPU 已包含墙体和楼板；反推墙损只供绕射门限使用，不再重复步进。
						const cpuBase =
							apRefDb[i]! -
							relativePathLossDb(dWu * metersPerWorldUnit) -
							floorDbThickness[i]!;
						wallLoss = Math.max(0, cpuBase - gpuBase);
					}

					/*
					 * 由本射线的几何关系得到天线方向图的切割。
					 * 垂直切割：全向天线在水平方向最强，正下方最弱。
					 * 壁挂设备另外叠加水平切割，一次调用同时应用两者。
					 */
					level -= antennaRayLossDb(apProfiles[i]!, gap, dx, dy);

					// 接入点与站在甲板上的客户端之间隔着楼板时，路径需穿过该板，按板自身的衰减计算。
					// 以 `liftWu` 为前置条件，因为大多数纹素不在任何甲板上。
					if (liftWu > 0) {
						const deck = deckCrossing(surfaces, wx, wy, gap / surfaceScale);
						if (deck) level -= deck.lossDb;
					}

					/*
					 * 不可能到达该纹素的射线无需推进。
					 * 此时 `level` 只含自由空间损耗与天线切割，后续各项只会使其减小。
					 * 已低于色阶门限的接入点无法着色该纹素，因此跳过最耗时的推进。
					 */
					if (level <= this.rssiFloor) continue;

					// 墙体衰减（预计算场，O(1) 查表）。
					const field = fields[i];
					const crossFloor = this.aps[i]!.crossFloor;
					if (gpuBase === undefined && field) {
						// 与 `level` 分开保存：它也用于判断该射线是否被遮挡，遮挡时由绕射项补足。
						/*
						 * 同楼层路径使用精确步进而非极坐标查表。
						 * 极坐标场按 0.5° 切片存储衰减，远距离时切片跨度大，插值会在拐角处产生尖刺。
						 * 跨楼层路径仍用该场，因为拆分需要切分点处的前缀值。
						 */
						const mask = this.wallMask;
						if (mask && !this.isDragging) {
							const band = bands[i]!;
							/*
							 * 每步两个像素而不是一个。
							 * 墙体是六像素宽的带状区域，两步的步长不会跨过它，同时把步进开销减半。
							 */
							wallLoss = wallRunLoss(
								{
									mask: mask.data,
									width: mask.width,
									height: mask.height,
									materialMask: this.materialMap,
									materialDb: matDbByBand.get(band) ?? getMaterialDbTable(band),
									fallbackDb:
										defaultDbByBand.get(band) ?? getFlatAttenuation(this.defaultMaterial, band),
									originX: mask.originX,
									originY: mask.originY,
									defaultMaterialId: this.defaultMaterial
								},
								{ x: apX[i]!, y: apY[i]! },
								{ x: wx, y: wy },
								2
							);
						} else {
							wallLoss = lookupAtten(field, wx, wy);
						}
						level -= wallLoss;
						if (crossFloor) {
							// 在楼板处拆分：撤回本层射线在切分点以上的部分，改计入接入点本层。
							// 切分点就在该射线上，因此在该距离处查表所得正是要撤回的前缀。
							const seg = crossFloorSegments(
								crossFloor.sourceT,
								crossFloor.targetT,
								apX[i]!,
								apY[i]!,
								wx,
								wy
							);
							if (seg) {
								level += lookupAtten(field, seg.target.from.x, seg.target.from.y);
								const srcField = sourceFields[i];
								if (srcField) {
									level -= lookupAtten(srcField, seg.source.to.x, seg.source.to.y);
								}
							}
						}
					}

					if (gpuBase === undefined) {
						// 楼板衰减（ITU-R P.1238 经验模型）：覆盖直接穿透、绕射与多径的总隔离度，按固定 dB 计。
						// 三维距离已体现斜入射几何；射线穿过处楼板缺失时（中庭、楼梯井）不计该项。
						let slabDb = floorDbThickness[i]!;
						const slabTypes = crossFloor?.slabRoomType;
						if (slabTypes) {
							const slabCross = pointAlong(apX[i]!, apY[i]!, wx, wy, crossFloor!.slabT ?? 0);
							if (
								slabIsVoid(
									slabTypes.data,
									slabTypes.width,
									slabTypes.height,
									slabTypes.originX,
									slabTypes.originY,
									slabCross.x,
									slabCross.y
								)
							) {
								slabDb = 0;
							}
						}
						level -= slabDb;
					}

					if (this.coherent) {
						addField(
							i,
							10 ** (level / 10),
							pathPhase(dWu * metersPerWorldUnit, BAND_FREQUENCY_GHZ[bands[i]!] * 1e9),
							{ re: polarV, im: 0 },
							{ re: polarH, im: 0 }
						);
					}

					if (level > bestDb) bestDb = level;

					/*
					 * 墙体的镜像反射：一次镜面反射，按功率叠加。
					 * 反射路径为接入点 → 墙体 → 纹素，因此计入更长路径的损耗与墙体反射系数（功率比，≤ 1）。
					 * 不计中间的其他墙体：按构造两段路径位于反射墙的同侧。
					 */
					if (walls.length > 0) {
						/*
						 * 累加所有到达此处的反射，而不只取最强的一条。
						 * 只取最强会在房间内留下折痕与距离裁剪边界的环，求和则保持连续。
						 *
						 * 反射路径的两段也按矢量墙算一次穿墙损耗；反射面本身由反射系数表示，
						 * 所以从墙损里排除。否则一面墙会同时按“反射系数”和“穿墙损耗”扣两次。
						 */
						const candidateSet = reflectionByAp[i]!;
						const nearby = candidateSet.grid
							? candidateSet.grid.query(
									(apX[i]! + wx) / 2,
									(apY[i]! + wy) / 2,
									reflectionReach
								)
							: undefined;
						const returns =
							nearby && nearby.length === 0
								? []
								: reflections(
										{ x: apX[i]!, y: apY[i]! },
										{ x: wx, y: wy },
										candidateSet.walls,
										bands[i]!,
										reflectionReach,
										undefined,
										candidateSet.wallIndices,
										nearby
									);
						for (const bounce of returns) {
							const legLoss =
								rayWallLossDb(
									{ x: apX[i]!, y: apY[i]! },
									{ x: bounce.x, y: bounce.y },
									walls,
									bands[i]!,
									[bounce.wallIndex]
								) +
								rayWallLossDb(
									{ x: bounce.x, y: bounce.y },
									{ x: wx, y: wy },
									walls,
									bands[i]!,
									[bounce.wallIndex]
								);
							const antennaLoss = antennaRayLossDb(
								apProfiles[i]!,
								gap,
								bounce.x - apX[i]!,
								bounce.y - apY[i]!
							);
							const reflected =
								apRefDb[i]! -
								relativePathLossDb(bounce.length * metersPerWorldUnit) -
								antennaLoss +
								10 * Math.log10(bounce.powerRatio) -
								legLoss;
							if (reflected > this.rssiFloor) reflectedMw += 10 ** (reflected / 10);
							if (this.coherent) {
								const wall = walls[bounce.wallIndex]!;
								const coefficients = reflectionCoefficients(
									wall,
									bands[i]!,
									bounce.cosTheta
								);
								addField(
									i,
									10 **
										((apRefDb[i]! -
											relativePathLossDb(bounce.length * metersPerWorldUnit) -
											antennaLoss -
											legLoss) /
											10),
									pathPhase(
										bounce.length * metersPerWorldUnit,
										BAND_FREQUENCY_GHZ[bands[i]!] * 1e9
									),
									{
										re: coefficients.te.re * polarV,
										im: coefficients.te.im * polarV
									},
									{
										re: coefficients.tm.re * polarH,
										im: coefficients.tm.im * polarH
									}
								);
							}
						}
					}

					/*
					 * 二次镜面反射：AP → wall(first) → wall(second) → 客户端。
					 * 候选墙对已按正入射功率比预筛，避免逐像素 O(W²)。
					 */
					for (const pair of secondOrderByAp[i]!) {
						const second = secondOrderReflection(
							{ x: apX[i]!, y: apY[i]! },
							{ x: wx, y: wy },
							walls,
							pair,
							bands[i]!
						);
						if (!second) continue;
						const legLoss =
							rayWallLossDb(
								{ x: apX[i]!, y: apY[i]! },
								{ x: second.x, y: second.y },
								walls,
								bands[i]!,
								[second.wallIndex]
							) +
							rayWallLossDb(
								{ x: second.x, y: second.y },
								{ x: second.x2, y: second.y2 },
								walls,
								bands[i]!,
								[second.wallIndex, second.wallIndex2]
							) +
							rayWallLossDb(
								{ x: second.x2, y: second.y2 },
								{ x: wx, y: wy },
								walls,
								bands[i]!,
								[second.wallIndex2]
							);
						const reflected =
							apRefDb[i]! -
							relativePathLossDb(second.length * metersPerWorldUnit) -
							antennaRayLossDb(
								apProfiles[i]!,
								gap,
								second.x - apX[i]!,
								second.y - apY[i]!
							) +
							10 * Math.log10(second.powerRatio * second.powerRatio2) -
							legLoss;
						if (reflected > this.rssiFloor) reflectedMw += 10 ** (reflected / 10);
						if (this.coherent) {
							const c1 = reflectionCoefficients(
								walls[second.wallIndex]!,
								bands[i]!,
								second.cosTheta
							);
							const c2 = reflectionCoefficients(
								walls[second.wallIndex2]!,
								bands[i]!,
								second.cosTheta2
							);
							addField(
								i,
								10 **
									((apRefDb[i]! -
										relativePathLossDb(second.length * metersPerWorldUnit) -
										antennaRayLossDb(
											apProfiles[i]!,
											gap,
											second.x - apX[i]!,
											second.y - apY[i]!
										) -
										legLoss) /
										10),
								pathPhase(
									second.length * metersPerWorldUnit,
									BAND_FREQUENCY_GHZ[bands[i]!] * 1e9
								),
								(() => {
									const v = cMul(c1.te, c2.te);
									return { re: v.re * polarV, im: v.im * polarV };
								})(),
								(() => {
									const h = cMul(c1.tm, c2.tm);
									return { re: h.re * polarH, im: h.im * polarH };
								})()
							);
						}
					}

					/*
					 * 单次漫散射：按墙面元做一维积分。
					 * 每个面元是一个独立的散射点，客户端一侧可见才计入；功率相加。
					 */
					const scatterSamples = scatterByAp[i]!;
					for (const sample of scatterSamples) {
						if (
							rayWallLossDb(
								{ x: sample.x, y: sample.y },
								{ x: wx, y: wy },
								walls,
								bands[i]!,
								[sample.wallIndex]
							) > 1e-9
						) {
							continue;
						}
						const d1M =
							Math.hypot(
								sample.x - apX[i]!,
								sample.y - apY[i]!,
								sample.z - gap
							) * metersPerWorldUnit;
						const d2M =
							Math.hypot(wx - sample.x, wy - sample.y, sample.z) *
							metersPerWorldUnit;
						const scattered = diffuseLevelDb({
							apRefDb: apRefDb[i]!,
							pathLengthM: d1M + d2M,
							antennaLossDb: antennaRayLossDb(
								apProfiles[i]!,
								sample.z - gap,
								sample.x - apX[i]!,
								sample.y - apY[i]!
							),
							wallLossDb: 0,
							wall: sample.wall,
							ap: { x: apX[i]!, y: apY[i]! },
							hit: { x: sample.x, y: sample.y },
							target: { x: wx, y: wy },
							material: sample.wall.material,
							band: bands[i]!,
							areaM2: sample.areaM2,
							normalization: sample.directiveNorm
						});
						if (scattered > this.rssiFloor) {
							reflectedMw += 10 ** (scattered / 10);
							if (this.coherent) {
								addField(
									i,
									10 ** (scattered / 10),
									pathPhase(
										d1M + d2M,
										BAND_FREQUENCY_GHZ[bands[i]!] * 1e9
									),
									(() => {
										const kx = getCrossPolarizationRatio(
											sample.wall.material as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
										);
										return {
											re: polarV * Math.sqrt(1 - kx) + polarH * Math.sqrt(kx),
											im: 0
										};
									})(),
									(() => {
										const kx = getCrossPolarizationRatio(
											sample.wall.material as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
										);
										return {
											re: polarH * Math.sqrt(1 - kx) - polarV * Math.sqrt(kx),
											im: 0
										};
									})()
								);
							}
						}
					}

					/*
					 * 绕射项随墙体遮挡程度渐入。
					 * 权重从 3 dB 处的 0 线性升到 9 dB 处的 1，避免阈值处出现可见缺口。
					 */
					const diffractionGate = Math.min(1, Math.max(0, (wallLoss - 3) / 6));
					const candidates = diffractionByAp[i]!;
					if (diffractionGate > 0 && candidates.length > 0) {
						const paths = diffractionPaths(
							{ x: apX[i]!, y: apY[i]!, z: gap },
							{ x: wx, y: wy, z: 0 },
							candidates,
							bandWavelengthM(bands[i]!),
							DIFFRACTION_MAX_CLEARANCE_M,
							DIFFRACTION_MAX_DISTANCE_M,
							metersPerWorldUnit,
							(edge) =>
								rayWallLossDb(
									{ x: edge.x, y: edge.y },
									{ x: wx, y: wy },
									walls,
									bands[i]!,
									edge.wallIndices ?? []
								) <= 1e-9,
							4
						);
						let diffractedMw = 0;
						for (const path of paths) {
							if (!(path.lossDb > 0)) continue;
							const diffracted =
								apRefDb[i]! -
								relativePathLossDb((path.d1 + path.d2) * metersPerWorldUnit) -
								path.lossDb -
								antennaRayLossDb(
									apProfiles[i]!,
									path.z - gap,
									path.x - apX[i]!,
									path.y - apY[i]!
								);
							if (diffracted > this.rssiFloor) {
								diffractedMw += 10 ** (diffracted / 10);
								if (this.coherent) {
									addField(
										i,
										10 ** (diffracted / 10),
										pathPhase(
											(path.d1 + path.d2) * metersPerWorldUnit,
											BAND_FREQUENCY_GHZ[bands[i]!] * 1e9
										),
										{ re: polarV, im: 0 },
										{ re: polarH, im: 0 }
									);
								}
							}
						}
						if (diffractedMw > 0) {
							reflectedMw += diffractionGate * diffractedMw;
						}
					}
				}

				// 功率求和：相干模式先按 AP 求 V/H 复场功率，再跨 AP 非相干相加。
				let totalDb: number;
				if (this.coherent) {
					let totalMw = 0;
					for (let i = 0; i < n; i++) {
						apPowers[i] = linearPolarizationPower(
							{ vertical: fieldV[i]!, horizontal: fieldH[i]! },
							(this.receiverPolarizationAngleDeg * Math.PI) / 180
						);
						totalMw += apPowers[i]!;
					}
					totalDb = totalMw > 0 ? 10 * Math.log10(totalMw) : -Infinity;
				} else {
					totalDb =
						reflectedMw > 0 ? 10 * Math.log10(10 ** (bestDb / 10) + reflectedMw) : bestDb;
				}
				let value = totalDb;
				if (this.metric === 'sinr' && this.coherent) {
					let strongest = 0;
					let strongestIndex = -1;
					let total = 0;
					for (let i = 0; i < n; i++) {
						const p = apPowers[i]!;
						total += p;
						if (p > strongest) {
							strongest = p;
							strongestIndex = i;
						}
					}
					const interference = Math.max(0, total - strongest);
					const width = this.aps[strongestIndex]?.channelWidth ?? 20;
					value = sinrDb(strongest, interference, thermalNoiseFloorDbm(width));
				}
				/*
				 * 这里保存电平而非颜色，以便先做平滑。
				 * 逐纹素的场是分段常数，直接着色会得到硬楔形与阶梯，平滑电平后才转为渐变。
				 */
				levels[rowOff + tx] = value;
			}
		}

		/*
		 * 对电平网格做两遍 3×3 均值模糊。
		 * 可分离且核很小，能消除纹素阶梯与相邻切片之间的接缝。
		 * 低于色阶门限的缺失电平不参与平均，否则会在覆盖区外产生亮边。
		 */
		const smooth = boxBlurLevels(levels, cols, rows);

		/*
		 * 使用等值色带而非连续渐变。
		 * 电平在平滑后按 `BAND_DB` 量化，因此每段边界是平滑的等值线。
		 * 颜色取各色带中点在同一色阶上的值，保持色板与图例的含义一致。
		 */
		const levelBands = new Int16Array(cols * rows).fill(-1);
		/*
		 * 色阶在当前参数下覆盖的色带数量。
		 * 由 span 推导而非固定值，使相同 dBm 在不同发射功率下对应同一颜色。
		 */
		const bandCount = Math.max(1, Math.ceil(span / BAND_DB));
		for (let i = 0; i < levelBands.length; i++) {
			const level = smooth[i]!;
			if (!Number.isFinite(level) || level < levelFloor) continue;
			const index = Math.floor((level - levelFloor) / BAND_DB);
			levelBands[i] = Math.max(0, Math.min(bandCount - 1, index));
		}

		for (let ty = 0; ty < rows; ty++) {
			const rowOff = ty * cols;
			for (let tx = 0; tx < cols; tx++) {
				const band = levelBands[rowOff + tx]!;
				if (band < 0) continue;
				const colourAt = Math.round(((band + 0.5) / bandCount) * 255);
				const color = LUT[colourAt]!;
				if (!color) continue;
				/*
				 * 不绘制等值线描边。
				 * 每个色带边缘描一像素的线在放大后会断裂成虚线；色带本身的跳变即构成轮廓。
				 */
				u32[rowOff + tx] = color;
			}
		}

		cctx.putImageData(imgData, 0, 0);
		debug(
			`[heatmap] ${cols}x${rows} texels at ${texel} world units ` +
				`(${((performance.now() - startedAt) | 0)} ms)`
		);
		return { canvas: canvas as HTMLCanvasElement, x0, y0, texel };
	}
}
