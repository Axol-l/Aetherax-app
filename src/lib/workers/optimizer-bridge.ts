/**
 * 主线程和优化 Worker 之间的桥接
 *
 * 一次优化运行的收发都走这里：把户型几何和参数打包发过去、转发进度，再把结果或取消还原成 Promise。
 * 户型几何按数组身份缓存，同一份户型只传一次，之后只传参数。
 */
import type { Band, ChannelWidth, RegulatoryDomain } from '@aetherax/channels';
import type { PathLossScenario } from '../rf/propagation.js';
import { debug } from '../log.js';
import { OPTIMIZER_PAYLOAD_VERSION } from './optimizer-protocol.js';
import type {
	ApInput,
	OptimizeProgress,
	OptimizeResult,
	WireGeometry,
	WireMessage,
	WorkerReply
} from './optimizer-protocol.js';
export type { OptimizeProgress, OptimizeResult } from './optimizer-protocol.js';

/** 一个还在等结果的任务，以及 Worker 回复时要通知谁。 */
interface PendingRun {
	runId: string;
	resolve: (value: OptimizeResult) => void;
	reject: (reason: unknown) => void;
	onProgress: ((progress: OptimizeProgress) => void) | null;
}

/**
 * 给输入数组编个号，供 `geometryIdentity` 用。
 */
const inputIds = new WeakMap<object, number>();
let nextInputId = 1;
function inputId(value: object | null | undefined): number {
	if (!value) return 0;
	let id = inputIds.get(value);
	if (id === undefined) {
		id = nextInputId++;
		inputIds.set(value, id);
	}
	return id;
}

export class OptimizerBridge {
	private worker: Worker | null = null;
	private pending: PendingRun | null = null;
	/**
	 * Worker 手上缓存的户型几何编号，没有缓存就是 null。
	 */
	private loadedGeometry: string | null = null;

	private getWorker(): Worker {
		if (!this.worker) {
			this.worker = new Worker(new URL('./optimizer-worker.ts', import.meta.url), {
				type: 'module'
			});
			this.loadedGeometry = null;
			this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
				const message = event.data;
				const pending = this.pending;
				if (!pending || message.runId !== pending.runId) return;
				if (message.type === 'progress') {
					pending.onProgress?.(message);
					return;
				}
				if (message.type === 'cancelled') {
					pending.reject(new Error('Cancelled'));
				} else if (message.type === 'busy') {
					pending.reject(new Error('Another optimisation is still running'));
				} else {
					pending.resolve(message);
				}
				this.cleanup();
			};
			this.worker.onerror = (err) => {
				this.pending?.reject(err);
				this.cleanup();
			};
		}
		return this.worker;
	}

	private cleanup(): void {
		this.pending = null;
	}

	optimize(
		aps: ApInput[],
		wallMask: Uint8Array,
		maskWidth: number,
		maskHeight: number,
		wallAttenuation: number,
		options?: {
			fixedAps?: Array<{
				x: number;
				y: number;
				interferenceRadius: number;
				signalScale: number;
				/** 这个接入点用的信道，可能为 null。干扰项会读它。 */
				assignedChannel?: number | null;
				/** 用户固定的信道。它是信道着色的一个约束。 */
				fixedChannel?: number | null;
				/** 信道宽度，用来生成互不重叠的信道表。 */
				channelWidth?: ChannelWidth;
				/** 到被优化楼层的垂直距离，用世界坐标单位。 */
				verticalGap: number;
				band: Band;
				/**
				 * 接入点自己那层楼的墙掩码，只在跨层时才需要。
				 * 路径在楼板处会切成两段：接入点到穿板点这段按这份掩码算，剩下的按被优化楼层的算。
				 */
				source?: {
					data: Uint8Array;
					width: number;
					height: number;
					materialMask: Uint8Array | null;
					defaultMaterial: number;
					/** 这份掩码的原点，落在被优化楼层掩码的坐标系里。 */
					originX: number;
					originY: number;
				} | null;
				/** 射线离开接入点自己那层的位置，用 0-1 的比例表示。 */
				sourceT?: number;
				/** 射线进入被优化楼层的位置，用 0-1 的比例表示。 */
				targetT?: number;
				/**
				 * 这条路径穿过的每个楼层边界：每个边界连同楼板所属那层的房间类型（坐标在被优化楼层的
				 * 掩码坐标系里），以及总楼板损耗分摊到该边界的比例。那里如果是空洞（洞口），射线承担的这份损耗要少一些。
				 */
				slabs?: Array<{
					t: number;
					lossShare: number;
					roomTypes: Uint8Array | null;
					width: number;
					height: number;
					originX: number;
					originY: number;
				}> | null;
			}>;
			onProgress?: (progress: OptimizeProgress) => void;
			densityMap?: Float32Array | null;
			medianDensity?: number;
			materialMask?: Uint8Array | null;
			/** 原始房间类型 id */
			roomTypeMask?: Uint8Array | null;
			defaultMaterial?: number;
			metersPerPixel?: number;
			/** 默认 false：接入点会被限制在识别出的建筑内部。 */
			allowOutside?: boolean;
			/** 不传就用随机种子，实际用到的种子会在结果里带回来。 */
			seed?: number;
			/** 同频干扰占比在目标函数里的权重 */
			interferenceWeight?: number;
			/**
			 * 传了之后，Worker 会给每个评估过的布局自己做信道着色，按该布局最优分配「之后」剩下的
			 * 干扰打分。
			 */
			regulatoryDomain?: RegulatoryDomain;
			/**
			 * 采样点低于覆盖门限多少 dB 以内还算有收益
			 */
			coverageSoftnessDb?: number;
			/** 距离项用的 ITU-R P.1238 环境类型。 */
			pathLossScenario?: PathLossScenario;
			/** 覆盖门限，单位 dBm；不传用默认 −70。 */
			coverageThresholdDbm?: number;
			/**
			 * 只按消息数据里的现有位置算冲突图，不做布点。
			 */
			graphOnly?: boolean;
			/**
			 * 每个接入点能选的发射功率，单位 dBm，从大到小；按消息数据顺序，一个接入点一个列表。
			 * 不传就说明功率不参与寻优。
			 */
			powerLevelsDbm?: number[][];
			/** 每米多少世界坐标单位，用来把功率换算成半径。 */
			worldUnitsPerMeter?: number;
			/**
			 * 同层路径的垂直落差。
			 * 它进的是穿墙步进的材质路径系数 —— 射线斜着穿墙，比平面上看过去走的材质更多。不传就不做修正。
			 */
			localVerticalDrop?: number;
			/**
			 * 沿墙那条带的深度，世界坐标单位：壁挂接入点就布在这条带里。
			 */
			wallBandWu?: number;
			/**
			 * 封闭区域能被布点所需的最小内切半径，世界坐标单位。
			 */
			minRoomRadiusWu?: number;
			/**
			 * 用户画好的规划区域，掩码坐标。
			 * Worker 会把布点范围裁到这块区域里，和应用自己的校验用同一个形状。
			 */
			planningArea?: Array<{ x: number; y: number }> | null;
			/**
			 * 本层的抬升面，掩码坐标。
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
			 * 用户自定义的墙体材质，用材质表里那套字段。
			 */
			customMaterials?: Array<{
				id: number;
				name: string;
				dbPerMeter: Record<string, number>;
				typicalThickness: number;
				color: [number, number, number];
			}>;
			/**
			 * ε 约束：结果必须达到的覆盖率，0-1 的小数。传 0 就是不加约束。
			 */
			coverageFloor?: number;
		}
	): Promise<OptimizeResult> {
		const runId = crypto.randomUUID();
		const geometryId = this.geometryIdentity(wallMask, options);
		return new Promise((resolve, reject) => {
			const previous = this.pending;
			if (previous) {
				this.pending = null;
				this.getWorker().postMessage({ type: 'cancel', runId: previous.runId });
				previous.reject(new Error('Superseded'));
			}
			this.pending = { runId, resolve, reject, onProgress: options?.onProgress ?? null };

			/*
			 * 先把 Worker 取出来。新建 Worker 会清掉它手上的缓存。
			 */
			const worker = this.getWorker();

			/*
			 * `reuse` 表示 Worker 手上正好有这份户型。每次新建或销毁 Worker 都要把这个标记清掉。
			 */
			const reuse = geometryId === this.loadedGeometry;
			const transferable: ArrayBuffer[] = [];
			let geometry: Partial<WireGeometry> = {};

			if (!reuse) {
				// 先拷一份 buffer，才能 transfer 给 Worker
				const maskCopy = new Uint8Array(wallMask);
				const densityCopy = options?.densityMap ? new Float32Array(options.densityMap) : null;
				const materialCopy =
					options?.materialMask != null ? new Uint8Array(options.materialMask) : null;
				const roomTypeCopy =
					options?.roomTypeMask != null ? new Uint8Array(options.roomTypeMask) : null;
				transferable.push(maskCopy.buffer);
				if (densityCopy) transferable.push(densityCopy.buffer);
				if (materialCopy) transferable.push(materialCopy.buffer);
				if (roomTypeCopy) transferable.push(roomTypeCopy.buffer);

				// 跨层来源掩码：只拷贝，不原地 transfer。
				const fixedAps = (options?.fixedAps ?? []).map((fap) => {
					const src = fap.source;
					const slabs = fap.slabs;
					if (!src && (!slabs || slabs.length === 0)) return fap;
					const srcMaskCopy = src ? new Uint8Array(src.data) : null;
					const srcMaterialCopy =
						src?.materialMask != null ? new Uint8Array(src.materialMask) : null;
					if (srcMaskCopy) transferable.push(srcMaskCopy.buffer);
					if (srcMaterialCopy) transferable.push(srcMaterialCopy.buffer);
					const slabCopies = (slabs ?? []).map((slab) => {
						const copy = slab.roomTypes ? new Uint8Array(slab.roomTypes) : null;
						if (copy) transferable.push(copy.buffer);
						return { ...slab, roomTypes: copy };
					});
					return {
						...fap,
						source:
							src && srcMaskCopy
								? { ...src, data: srcMaskCopy, materialMask: srcMaterialCopy }
								: null,
						slabs: slabCopies.length > 0 ? slabCopies : null
					};
				});

				geometry = {
					fixedAps,
					wallMask: maskCopy,
					maskWidth,
					maskHeight,
					materialMask: materialCopy,
					densityMap: densityCopy,
					medianDensity: options?.medianDensity ?? 0,
					roomTypeMask: roomTypeCopy
				};
			}

			const msg: WireMessage = {
				type: 'optimize',
				runId,
				geometryId,
				geometryReused: reuse,
				...geometry,
				aps,
				wallAttenuation,
				defaultMaterial: options?.defaultMaterial ?? 0,
				metersPerPixel: options?.metersPerPixel ?? 0,
				allowOutside: options?.allowOutside ?? false,
				seed: options?.seed,
				interferenceWeight: options?.interferenceWeight,
				regulatoryDomain: options?.regulatoryDomain,
				coverageSoftnessDb: options?.coverageSoftnessDb,
				pathLossScenario: options?.pathLossScenario,
				coverageThresholdDbm: options?.coverageThresholdDbm,
				graphOnly: options?.graphOnly,
				powerLevelsDbm: options?.powerLevelsDbm,
				worldUnitsPerMeter: options?.worldUnitsPerMeter,
				localVerticalDrop: options?.localVerticalDrop ?? 0,
				wallBandWu: options?.wallBandWu,
				minRoomRadiusWu: options?.minRoomRadiusWu,
				planningArea: options?.planningArea ?? null,
				surfaces: options?.surfaces ?? [],
				customMaterials: options?.customMaterials ?? [],
				payloadVersion: OPTIMIZER_PAYLOAD_VERSION,
				coverageFloor: options?.coverageFloor
			};
			if (reuse) {
				// 打这条日志，是因为这一下差着几百字节和上百 MB，而且缓存用错了平时根本看不出来。
				debug(`[optimizer] reusing the plan the worker holds (${geometryId})`);
			} else {
				this.loadedGeometry = geometryId;
			}
			worker.postMessage(msg, transferable);
		});
	}

	/**
	 * 算出一次运行需要的户型几何编号。
	 *
	 * 这些数组是调用方缓存好的解码结果，同一份方案每次重跑都会交出同一批对象。
	 */
	private geometryIdentity(
		wallMask: Uint8Array,
		options:
			| {
					materialMask?: Uint8Array | null;
					roomTypeMask?: Uint8Array | null;
					densityMap?: Float32Array | null;
					fixedAps?: ReadonlyArray<{
						source?: { data: Uint8Array; materialMask?: Uint8Array | null } | null;
						slabs?: ReadonlyArray<{ roomTypes?: Uint8Array | null }> | null;
					}>;
				}
			| undefined
	): string {
		const parts = [
			inputId(wallMask),
			inputId(options?.materialMask),
			inputId(options?.roomTypeMask),
			inputId(options?.densityMap)
		];
		for (const fixed of options?.fixedAps ?? []) {
			parts.push(inputId(fixed.source?.data), inputId(fixed.source?.materialMask));
			for (const slab of fixed.slabs ?? []) parts.push(inputId(slab.roomTypes));
		}
		return parts.join(',');
	}

	/**
	 * 停掉正在跑的那次运行，并且不再等它。
	 */
	cancel(): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = null;
		this.getWorker().postMessage({ type: 'cancel', runId: pending.runId });
		pending.reject(new Error('Cancelled'));
	}

	terminate(): void {
		this.worker?.terminate();
		this.worker = null;
		this.loadedGeometry = null;
		this.cleanup();
	}
}
