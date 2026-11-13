/**
 * 画布绘制与点击处理所读取的墙体、材质和房间栅格。
 * 每层楼的掩码依次经历解码、发布和重置，本类持有缓存并承担其中的异步工作。
 */
import { debug } from '$lib/log.js';
import type { HeatmapLayer } from './renderers/heatmap.js';
import type { RoomLabelsLayer } from './renderers/room-labels.js';
import type { WallLayer } from './renderers/walls.js';
import { buildRoomDomain } from './rooms.js';
import {
	decodeMaterialMask,
	encodeMaterialMask,
	labelWallBlobs,
	type RegionLabels
} from './region-labels.js';
import { encodeMask, decodeMask, type DecodedWallMask } from './mask-codec.js';
import { floorState, currentFloor } from '$state/floor-state.svelte.js';
import { floorplanState } from '$state/floorplan-state.svelte.js';
import { wallState } from '$state/wall-state.svelte.js';
import { invalidateSolverMaskCache } from '$state/floor-mask.js';
import { updateCoverage } from '$state/optimizer.svelte.js';
import { scheduleSave } from '$state/persistence.svelte.js';
import { minRoomRadiusWu } from '$state/room-domain.js';

/** 墙体编辑器或线段栅格化器生成的栅格。 */
export interface MaterialisedMask {
	data: Uint8Array;
	materialData: Uint8Array | null;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

export interface MaskLayers {
	wallLayer: WallLayer | null;
	heatmapLayer: HeatmapLayer | null;
	roomLabelsLayer: RoomLabelsLayer | null;
}

export interface MaskPipelineHost {
	/** 当前图层；画布引擎挂载完成前为 null。 */
	layers(): MaskLayers;
	markDirty(): void;
}

export class MaskPipeline {
	/**
	 * AP 标注据以测量的解码后栅格。
	 * 声明为 `$state` 以便从 promise 落地时让标注 effect 重跑；它只由回调写入，避免读取它的 effect 自触发。
	 */
	apWallMask = $state<DecodedWallMask | null>(null);
	/** 每次发布时递增，用作距离变换缓存的键。 */
	revision = 0;

	/** 解码后的栅格与标签，供墙体/房间点击处理读取。 */
	wallData: Uint8Array | null = null;
	materialData: Uint8Array | null = null;
	wallLabels: RegionLabels | null = null;
	interior: Uint8Array | null = null;
	roomLabels: RegionLabels | null = null;
	roomTypeData: Uint8Array | null = null;
	originX = 0;
	originY = 0;

	/**
	 * 墙体掩码每次被替换时递增。
	 * 由自动求解的键读取；刻意使用普通字段而非 `$state`，避免其自身写入再次触发求解。
	 */
	maskVersion = 0;

	private wallUrl: string | null = null;
	private materialUrl: string | null = null;
	private keyOriginX = Number.NaN;
	private keyOriginY = Number.NaN;
	private roomTypeUrl: string | null = null;
	/** 防止异步解码结果写入已被替换的楼层或掩码。 */
	private version = 0;
	/** 这些缓存所属的楼层，参见 `syncWallMask` 中的重置逻辑。 */
	private syncedFloorId = '';

	constructor(private readonly host: MaskPipelineHost) {}

	/**
	 * 状态变化时解码当前楼层的墙体掩码与材质掩码。
	 * 需在无参数的 `$effect` 中调用：方法在首个 `await` 前同步读取 `wallState`，以建立依赖。
	 */
	syncWallMask(): void {
		const { wallLayer, heatmapLayer } = this.host.layers();
		if (!wallLayer || !heatmapLayer) return;

		/*
		 * 其他楼层的缓存不属于当前楼层，在此丢弃。
		 * 流水线自行记录缓存所属楼层，因此无需依赖 effect 的创建顺序。
		 */
		const floorId = floorState.currentFloorId;
		if (floorId !== this.syncedFloorId) {
			this.syncedFloorId = floorId;
			this.reset();
		}

		const mask = wallState.wallMask;
		const materialMask = wallState.materialMask;

		// 数据 URL 与原点均未变化时跳过重复解码；对齐楼层只移动掩码而不会改动任何像素。
		const wallUrl = mask?.dataUrl ?? null;
		const materialUrl = materialMask?.dataUrl ?? null;
		const originX = mask?.originX ?? 0;
		const originY = mask?.originY ?? 0;
		if (
			wallUrl === this.wallUrl &&
			materialUrl === this.materialUrl &&
			originX === this.keyOriginX &&
			originY === this.keyOriginY &&
			this.wallData
		) {
			return;
		}
		this.wallUrl = wallUrl;
		this.materialUrl = materialUrl;
		this.keyOriginX = originX;
		this.keyOriginY = originY;

		debug(
			`[walls] decode start: mask ${mask?.width ?? 0}x${mask?.height ?? 0} at ${originX},${originY}`
		);

		this.maskVersion++;
		invalidateSolverMaskCache();
		const thisVersion = ++this.version;

		if (!mask) {
			wallLayer.mask = null;
			heatmapLayer.wallMask = null;
			// 不会再有掩码到来：该楼层没有平面图，无墙热力图即为正确结果，不应被抑制。
			heatmapLayer.maskPending = false;
			this.clearCaches();
			const { roomLabelsLayer } = this.host.layers();
			if (roomLabelsLayer) {
				roomLabelsLayer.roomTypeData = null;
				roomLabelsLayer.roomLabels = null;
				roomLabelsLayer.invalidateCache();
			}
			this.host.markDirty();
			return;
		}

		const wallPromise = decodeMask(mask.dataUrl, mask.width, mask.height);
		const materialPromise = materialMask
			? decodeMaterialMask(materialMask.dataUrl, materialMask.width, materialMask.height)
			: null;

		wallPromise
			.then(async (decoded) => {
				if (this.version !== thisVersion) return;
				const materialData = materialPromise ? await materialPromise : null;
				if (this.version !== thisVersion) return;

				// 把存储的原点传播到解码后的掩码，并对齐到整像素。
				// 原点来自对齐偏移（`dragDistance / zoom`，可能为小数），但被当作像素地址使用。
				decoded.originX = Math.round(mask.originX ?? 0);
				decoded.originY = Math.round(mask.originY ?? 0);

				const layers = this.host.layers();
				const defaultMaterial = wallState.wallMaterial;
				wallLayer.mask = decoded;
				wallLayer.materialMap = materialData ?? null;
				wallLayer.defaultMaterial = defaultMaterial;
				heatmapLayer.wallMask = decoded;
				heatmapLayer.materialMap = materialData ?? null;
				heatmapLayer.defaultMaterial = defaultMaterial;
				heatmapLayer.wallAttenuation = wallState.wallAttenuation;
				// 等待的掩码已就绪，可以继续生成。
				heatmapLayer.maskPending = false;
				this.setApWallMask(decoded);

				this.wallData = decoded.data;
				this.originX = decoded.originX;
				this.originY = decoded.originY;
				this.wallLabels = labelWallBlobs(decoded.data, decoded.width, decoded.height);
				this.materialData = materialData ?? null;

				// 本平面图的房间取自共用的同一份推导；产出的 id 即点击写入 `roomDensityOverrides` 的 id，
				// 优化器按同一分区读回，因此这些参数不是局部选择，参见 `canvas/rooms.ts`。
				const domain = buildRoomDomain(
					decoded.data,
					decoded.width,
					decoded.height,
					{ minRegionRadius: minRoomRadiusWu(this.syncedFloorId), trimWallAdjacent: false }
				);
				this.interior = domain.interior;
				this.roomLabels = { labels: domain.labels, regionCount: domain.regionCount };

				// 若已持久化，则解码房间类型掩码
				const roomTypeMask = wallState.roomTypeMask;
				if (
					roomTypeMask &&
					roomTypeMask.width === decoded.width &&
					roomTypeMask.height === decoded.height
				) {
					const roomTypeData = await decodeMaterialMask(
						roomTypeMask.dataUrl,
						roomTypeMask.width,
						roomTypeMask.height
					);
					if (this.version !== thisVersion) return;
					this.roomTypeData = roomTypeData;
				} else {
					this.roomTypeData = null;
				}

				// 把房间数据提供给渲染器
				if (layers.roomLabelsLayer) {
					layers.roomLabelsLayer.roomTypeData = this.roomTypeData;
					layers.roomLabelsLayer.roomLabels = this.roomLabels;
					layers.roomLabelsLayer.maskWidth = decoded.width;
					layers.roomLabelsLayer.maskHeight = decoded.height;
					layers.roomLabelsLayer.originX = decoded.originX;
					layers.roomLabelsLayer.originY = decoded.originY;
					layers.roomLabelsLayer.densityOverrides = currentFloor().roomDensityOverrides;
					layers.roomLabelsLayer.customLabels = currentFloor().roomCustomLabels ?? {};
					layers.roomLabelsLayer.invalidateCache();
				}

				this.host.markDirty();
			})
			.catch((err) => {
				// 缺少此处处理时链路会静默失败，墙体不显示的平面图也无从得知解码为何未完成。
				console.error(
					'[walls] floorplan decode failed. The plan then has no walls to measure ' +
						'against, so coverage and the heatmap read as empty rather than as wrong.',
					err
				);
			});
	}

	/**
	 * 单独解码房间类型掩码。
	 * 它独立于墙体掩码变化；单独成 effect 可避免为改标签而重解码整个墙体栅格。
	 */
	syncRoomTypes(force = false): void {
		const { roomLabelsLayer } = this.host.layers();
		if (!roomLabelsLayer) return;

		const roomTypeMask = wallState.roomTypeMask;
		const roomTypeUrl = roomTypeMask?.dataUrl ?? null;
		// The layer can have been cleared by a floor reset while the URL stayed the
		// same; a URL-only shortcut would leave it blank forever.
		if (!force && roomTypeUrl === this.roomTypeUrl && roomLabelsLayer.roomLabels) return;
		this.roomTypeUrl = roomTypeUrl;

		const mask = wallState.wallMask;
		if (
			!roomTypeMask ||
			!mask ||
			roomTypeMask.width !== mask.width ||
			roomTypeMask.height !== mask.height
		) {
			this.roomTypeData = null;
			roomLabelsLayer.roomTypeData = null;
			roomLabelsLayer.invalidateCache();
			this.host.markDirty();
			return;
		}

		decodeMaterialMask(roomTypeMask.dataUrl, roomTypeMask.width, roomTypeMask.height).then(
			(roomTypeData) => {
				// 已过期：解码期间有更新的掩码到达。
				if (wallState.roomTypeMask?.dataUrl !== roomTypeMask.dataUrl) return;
				this.roomTypeData = roomTypeData;
				roomLabelsLayer.roomTypeData = roomTypeData;
				roomLabelsLayer.roomLabels = this.roomLabels;
				roomLabelsLayer.densityOverrides = currentFloor().roomDensityOverrides;
				roomLabelsLayer.customLabels = currentFloor().roomCustomLabels ?? {};
				roomLabelsLayer.invalidateCache();
				this.host.markDirty();
			}
		);
	}

	/**
	 * 把已生成的栅格发布为该楼层的墙体掩码。
	 * 掩码不只是数据 URL：图层要绘制刚写入的像素，材质弹窗需要团块标签，求解器的解码副本也随之过期。
	 */
	publish(mat: MaterialisedMask): boolean {
		const { data, materialData, width, height, originX, originY } = mat;

		// 每次编辑都会整体编码掩码，故需关注其范围；远超建筑尺寸的掩码通常是边界计算错误，
		// 表现为超过画布尺寸上限后整个图层消失。
		if (width > 8000 || height > 8000) {
			console.warn(
				`[walls] mask is ${width}x${height} at origin ${originX},${originY}. ` +
					'That is larger than any floorplan; expect slow edits and, past the ' +
					'canvas size limit, a failed encode that wipes the layer.'
			);
		}

		this.apply(mat);

		const wallUrl = encodeMask(data, width, height);
		const materialUrl = materialData ? encodeMaterialMask(materialData, width, height) : null;

		// 更新 URL 并预设解码键，使异步解码 effect 跳过已在屏幕上的重复解码。
		wallState.wallMask = { dataUrl: wallUrl, width, height, originX, originY };
		this.wallUrl = wallUrl;
		if (materialUrl) {
			wallState.materialMask = { dataUrl: materialUrl, width, height, originX, originY };
			this.materialUrl = materialUrl;
		} else if (wallState.materialMask) {
			// 已无材质像素；保留旧的材质掩码会让下次解码读回它，使材质指派重新出现。
			wallState.materialMask = null;
			this.materialUrl = null;
		}

		// 重新计算团块标签，使点击覆盖在编辑后的墙体上仍然可用
		this.wallLabels = labelWallBlobs(data, width, height);

		// 房间使用与上述解码路径相同的推导，确保点击写入与优化器读回的 id 一致。
		const domain = buildRoomDomain(data, width, height, {
			minRegionRadius: minRoomRadiusWu(this.syncedFloorId),
			trimWallAdjacent: false
		});
		this.interior = domain.interior;
		this.roomLabels = { labels: domain.labels, regionCount: domain.regionCount };

		// 掩码尺寸变化时，房间类型数据可能需要重新调整
		if (this.roomTypeData && this.roomTypeData.length !== width * height) {
			this.roomTypeData = null;
			wallState.roomTypeMask = null;
		}

		const { roomLabelsLayer } = this.host.layers();
		if (roomLabelsLayer) {
			roomLabelsLayer.roomLabels = this.roomLabels;
			roomLabelsLayer.roomTypeData = this.roomTypeData;
			roomLabelsLayer.maskWidth = width;
			roomLabelsLayer.maskHeight = height;
			roomLabelsLayer.originX = originX;
			roomLabelsLayer.originY = originY;
			roomLabelsLayer.invalidateCache();
		}

		// 触发重新求解：`maskVersion` 是自动求解键的一部分。
		this.maskVersion++;
		invalidateSolverMaskCache();

		this.host.layers().heatmapLayer?.markWallsDirty();
		this.host.markDirty();
		// 墙体决定楼层的覆盖范围，故重新测量该数值，而非沿用刚被替换的几何。
		void updateCoverage();
		scheduleSave();
		return true;
	}

	/**
	 * 丢弃由当前楼层掩码派生的一切。
	 * 在切换楼层时调用，避免期间绘制或点击到即将过期的栅格，因此渲染器引用也一并清空。
	 */
	reset(): void {
		this.wallUrl = null;
		this.materialUrl = null;
		this.roomTypeUrl = null;
		// 原点标记属于同一缓存键，须与 URL 一并清除，否则解码会把新掩码的原点与上一层楼比较。
		this.keyOriginX = Number.NaN;
		this.keyOriginY = Number.NaN;
		this.version++;
		this.clearCaches();

		const { wallLayer, heatmapLayer, roomLabelsLayer } = this.host.layers();
		if (wallLayer) {
			wallLayer.mask = null;
			wallLayer.materialMap = null;
			wallLayer.invalidateCache();
		}
		if (heatmapLayer) {
			heatmapLayer.wallMask = null;
			heatmapLayer.materialMap = null;
			// 解码进行中若无墙生成热力图，会得到一张开销很大且立即被替换的完整图像，参见 `maskPending`。
			heatmapLayer.maskPending = floorState.floors.some(
				(f) => f.id === floorState.currentFloorId && !!f.wallMask
			);
			heatmapLayer.markWallsDirty();
		}
		if (roomLabelsLayer) {
			roomLabelsLayer.roomTypeData = null;
			roomLabelsLayer.roomLabels = null;
			roomLabelsLayer.invalidateCache();
		}
	}

	/** 供 AP 标注使用的解码栅格，同时递增供变换缓存使用的版本号。 */
	private setApWallMask(mask: DecodedWallMask | null): void {
		this.apWallMask = mask;
		this.revision++;
	}

	/** 把解码后的栅格写入负责绘制的图层。 */
	private apply(mat: MaterialisedMask): void {
		const { wallLayer, heatmapLayer } = this.host.layers();
		const maskRef = {
			data: mat.data,
			width: mat.width,
			height: mat.height,
			originX: mat.originX,
			originY: mat.originY
		};
		if (wallLayer) wallLayer.mask = maskRef;
		if (heatmapLayer) {
			heatmapLayer.wallMask = maskRef;
			/*
			 * 线段，用于热力图携带的一次镜面反射。
			 * 掩码负责阻挡，线段负责反射：反射需要线段自身的直线，而掩码像素没有法线；
			 * 墙体仍为检测栅格的楼层没有线段，只得到直达场。
			 */
			heatmapLayer.reflectingWalls = (currentFloor()?.walls ?? []).map((wall) => ({
				ax: wall.ax,
				ay: wall.ay,
				bx: wall.bx,
				by: wall.by,
				material: wall.material
			}));
			heatmapLayer.columnObstacles = (currentFloor()?.columns ?? []).map((column) => ({
				shape: column.shape,
				ax: column.ax,
				ay: column.ay,
				bx: column.bx,
				by: column.by,
				material: column.material
			}));
			/*
			 * 热力图裁剪所用的轮廓：存在绘制的规划区域时用该区域，否则用检测到的边界。
			 * 没有它时场会覆盖整张图纸，内墙还会向建筑之外投影。
			 */
			const planned = currentFloor()?.planningArea ?? null;
			heatmapLayer.clipPolygon = planned ?? floorplanState.floorplanBoundary ?? null;
			// 绘制的区域代表用户对楼层的声明，故严格裁剪；检测到的边界只做修剪，并与墙体内域求并。
			heatmapLayer.clipStrict = !!planned && planned.length >= 3;
			heatmapLayer.materialMap = mat.materialData;
			heatmapLayer.materialVersion++;
		}
		if (wallLayer) {
			wallLayer.materialMap = mat.materialData;
			wallLayer.invalidateCache();
		}

		this.wallData = mat.data;
		this.materialData = mat.materialData;
		this.originX = mat.originX;
		this.originY = mat.originY;
		this.setApWallMask(maskRef);
	}

	private clearCaches(): void {
		this.wallData = null;
		this.materialData = null;
		this.wallLabels = null;
		this.interior = null;
		this.roomLabels = null;
		this.roomTypeData = null;
	}
}

