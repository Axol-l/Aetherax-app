/**
 * 实时覆盖估算：屏幕上这一层有多少在门限之上，供用户布点时看的那根条。
 * 对当前楼层按房间密度采样，报一个百分比。它的缓存
 * （解码后的掩码、采样网格、密度图）也只有这里用。
 */
import {
	apHeightAboveFloor,
	apSplitFor,
	apVerticalOffsetTo,
	antennaProfileFor,
	wupmForFloor
} from './ap-state.svelte.js';
import { scaleBetween } from './floor-scale.js';
import { antennaRayLossDb } from '$lib/rf/antenna.js';
import { surfaceHeightAt, deckCrossing } from '$lib/rf/surface-height.js';
import { bestReflection } from '$lib/rf/reflection.js';
import { bandWavelengthM, diffractionPaths, edgesOf } from '$lib/rf/diffraction.js';
import { rayWallLossDb } from '$lib/rf/wall-crossings.js';
import { scatteringFactor } from '$lib/rf/scattering.js';
import { scatterSamplesForAp } from '$lib/rf/path-candidates.js';
import type { Band } from '@aetherax/channels';
import { decodeMask, type DecodedWallMask } from '$canvas/mask-codec.js';
import { decodeMaterialMask } from '$canvas/region-labels.js';
import { getMaterialDbTable } from '$lib/domain/materials.js';
import { buildRoomDomain } from '$canvas/rooms.js';
import { coverageMarginDb, coverageThresholdMarginDb, coverageHorizontalReach, slabDbOf } from '$lib/rf/propagation.js';
import { violatesAt } from '$lib/rf/interference.js';
import { slabLossFactor, type SlabCrossing } from '$lib/rf/cross-floor.js';
import { splitWallRunLoss, wallRunLoss, type WallRun } from '$lib/rf/link-budget.js';
import { floorState, currentFloor, getFloorSlabAttenuation, type Floor } from './floor-state.svelte.js';
import { projectMeta } from './project-meta.svelte.js';
import { wallState } from './wall-state.svelte.js';
import { minRoomRadiusWu } from './room-domain.js';
import { clipInteriorToPlanningArea, isUsablePlanningArea } from './planning-area.js';
import { apState } from '$state/ap-state.svelte.js';
import { canvasState } from '$state/canvas.svelte.js';
import { coverageBasis, dropStaleCoverage, optimizerState, floorCoverage } from './optimizer-state.svelte.js';
import { buildDensityMap, crossingSlabsFor, sourceFloorMaskFor } from './optimizer-support.js';



/** 拖动时被推迟的那次计算，见 `updateCoverage`。 */
let coverageAfterDrag: ReturnType<typeof setTimeout> | null = null;

let cachedMaskUrl: string | null = null;
/** 缓存的掩码原点放在哪。楼层平移时 URL 不会变，所以要单独记。 */
let cachedMaskOriginX = 0;
let cachedMaskOriginY = 0;
let cachedMask: DecodedWallMask | null = null;
let cachedSamples: Array<{ x: number; y: number }> | null = null;
let cachedSamplePixelIdx: number[] | null = null;
let cachedInteriorPixelCount = 0;
/**
 * 密度图和它的输入。为什么缓存见使用处；缓存安不安全全靠这个 key。
 */
let densityCache: Awaited<ReturnType<typeof buildDensityMap>> | null = null;
let densityCacheKey = '';
/** 正在后台构建的那个 key，避免同一个请求重复起两次。 */
let densityBuilding: string | null = null;

/**
 * 在后台算某层的密度图
 */
function buildDensityInBackground(
	key: string,
	width: number,
	height: number,
	floor: Floor
): void {
	if (densityBuilding === key) return;
	densityBuilding = key;
	setTimeout(() => {
		void (async () => {
			try {
				const built = await buildDensityMap(width, height, floor);
				// 算的时候楼层或掩码可能已经变了，只保留仍然符合 key 的结果。
				densityCache = built;
				densityCacheKey = key;
				await updateCoverage();
			} catch {
				// 密度图算失败就继续用均匀的那份
			} finally {
				if (densityBuilding === key) densityBuilding = null;
			}
		})();
	}, 0);
}
/** 缓存掩码的逐像素材质 id，没有就是 null。 */
let cachedMaterialData: Uint8Array | null = null;

async function ensureCoverageCache(): Promise<boolean> {
	const mask = wallState.wallMask;
	if (!mask) return false;
	if (
		mask.dataUrl === cachedMaskUrl &&
		(mask.originX ?? 0) === cachedMaskOriginX &&
		(mask.originY ?? 0) === cachedMaskOriginY &&
		cachedMask &&
		cachedSamples
	) {
		return true;
	}

	cachedMask = await decodeMask(mask.dataUrl, mask.width, mask.height);
	cachedMask.originX = mask.originX ?? 0;
	cachedMask.originY = mask.originY ?? 0;
	cachedMaskUrl = mask.dataUrl;
	cachedMaskOriginX = mask.originX ?? 0;
	cachedMaskOriginY = mask.originY ?? 0;

	// 墙体材质也一起解
	const matMask = wallState.materialMask;
	cachedMaterialData =
		matMask && matMask.width === mask.width && matMask.height === mask.height
			? await decodeMaterialMask(matMask.dataUrl, matMask.width, matMask.height)
			: null;

	// 覆盖采样集
	const { interior } = buildRoomDomain(cachedMask.data, mask.width, mask.height, {
		minRegionRadius: minRoomRadiusWu(floorState.currentFloorId),
		trimWallAdjacent: true
	});

	const currentFloorForArea = floorState.floors.find((f) => f.id === floorState.currentFloorId);
	if (isUsablePlanningArea(currentFloorForArea?.planningArea)) {
		clipInteriorToPlanningArea(
			interior,
			mask.width,
			mask.height,
			mask.originX ?? 0,
			mask.originY ?? 0,
			currentFloorForArea!.planningArea!
		);
	}

	const interiorPixels: number[] = [];
	for (let i = 0; i < mask.width * mask.height; i++) {
		if (interior[i]) interiorPixels.push(i);
	}

	/*
	 * 实时覆盖在多少个点上采样
	 */
	const sampleCount = Math.min(140, interiorPixels.length);
	cachedInteriorPixelCount = interiorPixels.length;
	const step = interiorPixels.length / sampleCount;
	cachedSamples = [];
	cachedSamplePixelIdx = [];
	for (let i = 0; i < sampleCount; i++) {
		const idx = interiorPixels[Math.floor(i * step)]!;
		cachedSamples.push({ x: idx % mask.width, y: Math.floor(idx / mask.width) });
		cachedSamplePixelIdx.push(idx);
	}

	return cachedSamples.length > 0;
}

/** 按当前 AP 位置算实时覆盖率 */
export async function updateCoverage(): Promise<void> {
	/*
	 * 在这次计算加上自己那个数之前，先把每个存下来的数字和它声称描述的方案对一遍。
	 */
	dropStaleCoverage();

	/*
	 * 拖动 AP 的时候不跑
	 */
	if (canvasState.isDragging) {
		if (coverageAfterDrag) clearTimeout(coverageAfterDrag);
		coverageAfterDrag = setTimeout(() => {
			coverageAfterDrag = null;
			if (canvasState.isDragging) return;
			// 挑空闲帧再算，和存盘一样：这是应用在主线程上最贵的活，
			// 不能压在用户松手的那一帧上。
			if (typeof requestIdleCallback === 'function') {
				requestIdleCallback(() => void updateCoverage(), { timeout: 1200 });
			} else {
				void updateCoverage();
			}
		}, 600);
		return;
	}
	if (apState.aps.length === 0 || !wallState.wallMask) {
		optimizerState.coverage = 0;
		return;
	}

	const curFloorId = floorState.currentFloorId;
	/*
	 * 切回已经算过的楼层时直接复用该层缓存。
	 * 覆盖率和设备负载只取决于这一层的几何/AP/门限，全部包含在 basis 里。
	 */
	const cachedFloor = floorCoverage.get(curFloorId);
	if (cachedFloor && cachedFloor.basis === coverageBasis(curFloorId)) {
		optimizerState.coverage = cachedFloor.coverage;
		return;
	}

	if (!(await ensureCoverageCache()) || !cachedMask || !cachedSamples) {
		// 这一步失败时覆盖率会静默读成 0
		console.warn(
			'[optimizer] coverage unavailable:',
			cachedMask ? 'wall mask decoded' : 'wall mask NOT decoded',
			cachedSamples ? 'samples ready' : 'NO interior samples - is any room enclosed by walls?'
		);
		optimizerState.coverage = 0;
		return;
	}

	const { data, width, height } = cachedMask;
	const ox = cachedMask.originX ?? 0;
	const oy = cachedMask.originY ?? 0;
	const wallDb = wallState.wallAttenuation;

	// 各频段的材质表
	const materialTables = new Map<Band, number[]>();
	const tablesFor = (band: Band) => {
		let t = materialTables.get(band);
		if (!t) {
			t = getMaterialDbTable(band);
			materialTables.set(band, t);
		}
		return t;
	};

	/*
	 * 密度图缓存
	 */
	const densityFloor = currentFloor();
	const densityKey = [
		densityFloor.id,
		`${width}x${height}`,
		cachedMaskUrl ?? '',
		wallState.roomTypeMask?.dataUrl ?? '',
		JSON.stringify(densityFloor.roomDensityOverrides ?? {}),
		JSON.stringify(densityFloor.roomCustomLabels ?? {})
	].join('|');
	if (densityKey !== densityCacheKey) {
		if (densityCache) densityCache = null;
		buildDensityInBackground(densityKey, width, height, densityFloor);
	}
	const densityResult = densityCache;
	const baseline = densityResult
		? densityResult.medianDensity > 0
			? densityResult.medianDensity
			: 0.3
		: 0.3;
	const sampleDensity: number[] = [];
	for (let i = 0; i < cachedSamples.length; i++) {
		if (densityResult && cachedSamplePixelIdx) {
			const raw = densityResult.map[cachedSamplePixelIdx[i]!]!;
			sampleDensity.push(raw >= 0 ? raw : baseline);
		} else {
			sampleDensity.push(1);
		}
	}
	// 密度全为 0 就退回均匀权重（免得除零）
	if (Math.max(...sampleDensity) <= 0) {
		for (let i = 0; i < sampleDensity.length; i++) sampleDensity[i] = 1;
	}

	// 把别的楼层的虚拟 AP 也当成固定信号源
	const localAps = apState.aps.filter((ap) => ap.floorId === curFloorId);
	const virtualAps: Array<
		(typeof apState.aps)[0] & {
			signalScale: number;
			verticalGapWu: number;
			source: Awaited<ReturnType<typeof sourceFloorMaskFor>>;
			sourceT: number;
			targetT: number;
			/**
			 * 这条路径穿过的每道楼板，带每道楼板所属楼层的房间类型，以及在这里摊掉的总损耗份额。
			 */
			slabs: SlabCrossing[];
		}
	> = [];
	const wupmForGap = wupmForFloor(curFloorId);
	for (const otherFloor of floorState.floors) {
		if (otherFloor.id === curFloorId) continue;
		const otherAps = apState.aps.filter((ap) => ap.floorId === otherFloor.id);
		if (otherAps.length === 0) continue;
		// 垂直间距既进距离也进损耗：隔两层的 AP 是更远，不只是衰减更多。
		//
		// 按楼层缓存
		const source = await sourceFloorMaskFor(otherFloor.id, ox, oy, curFloorId);
		const k = scaleBetween(otherFloor.id, curFloorId);
		// 楼板损耗和频段有关，所以按每个 AP 自己的频段推
		const slabsByKey = new Map<string, SlabCrossing[]>();
		for (const ap of otherAps) {
			const apHeightM = apHeightAboveFloor(ap);
			const key = `${ap.band}|${apHeightM}`;
			if (!slabsByKey.has(key)) {
				slabsByKey.set(
					key,
					(await crossingSlabsFor(
						otherFloor.id,
						curFloorId,
						projectMeta.clientHeight,
						ap.band,
						ox,
						oy,
						densityResult?.roomTypeData ?? null,
						apHeightM
					)) ?? []
				);
			}
			const split = apSplitFor(ap, curFloorId, projectMeta.clientHeight);
			virtualAps.push({
				...ap,
				x: ap.x * k,
				y: ap.y * k,
				interferenceRadius: ap.interferenceRadius * k,
				signalScale: Math.pow(10, -getFloorSlabAttenuation(curFloorId, otherFloor.id, ap.band) / 10),
				verticalGapWu: apVerticalOffsetTo(ap, curFloorId, projectMeta.clientHeight) * wupmForGap,
				source,
				sourceT: split.sourceT,
				targetT: split.targetT,
				slabs: slabsByKey.get(key) ?? []
			});
		}
	}
	const allAps = [
		...localAps.map((ap) => ({
			...ap,
			signalScale: 1,
			// 同层路径在「安装高度」关掉时是平的，开了之后就是 AP 与客户端的高度差。
			verticalGapWu: apVerticalOffsetTo(ap, curFloorId, projectMeta.clientHeight) * wupmForGap,
			source: null as Awaited<ReturnType<typeof sourceFloorMaskFor>>,
			sourceT: 0,
			targetT: 0,
			slabs: [] as SlabCrossing[]
		})),
		...virtualAps
	];

	// 覆盖就是（按密度加权的）楼面里，落在至少一个 AP 覆盖圈内的比例
	let coveredWeight = 0;
	let totalWeight = 0;

	const surfaces = currentFloor().surfaces ?? [];
	const surfaceWupm = wupmForFloor(curFloorId);
	/*
	 * 射线能反射的墙段
	 */
	const reflectingWalls = (currentFloor().walls ?? []).map((wall) => ({
		ax: wall.ax,
		ay: wall.ay,
		bx: wall.bx,
		by: wall.by,
		material: wall.material
	}));
	const reflectionReach = 24 * surfaceWupm;
	/** 每个墙头都是刀锋，用来算墙后面的阴影。 */
	const diffractionEdges =
		reflectingWalls.length > 0
			? edgesOf(reflectingWalls, (currentFloor()?.ceilingHeight ?? 3) * wupmForGap)
			: [];
	const sampleHeightWu = cachedSamples.map(
		(sample) => surfaceHeightAt(surfaces, sample.x + ox, sample.y + oy) * surfaceWupm
	);
	const floorHeightM = currentFloor()?.ceilingHeight ?? 3;
	const scatterByAp = allAps.map((ap) =>
		scatterSamplesForAp(
			{ x: ap.x - ox, y: ap.y - oy },
			reflectingWalls,
			ap.band as Band,
			1 / surfaceWupm,
			floorHeightM
		)
	);

	/*
	 * 干扰在这里按这个方案实际的信道量出来。
	 */
	const channels = allAps.map((ap) => ap.assignedChannel ?? 0);
	/** 每个 AP 都有信道，所以这是个实测值，不是上界。 */
	const channelsKnown = channels.every((channel) => channel > 0);
	const margins = new Float64Array(allAps.length);
	let degradedWeight = 0;

	for (let i = 0; i < cachedSamples.length; i++) {
		const sample = cachedSamples[i]!;
		let bestMargin = -Infinity;
		margins.fill(-Infinity);
		let sourceIndex = 0;
		for (const ap of allAps) {
			const index = sourceIndex++;
			const dx = sample.x - (ap.x - ox);
			const dy = sample.y - (ap.y - oy);
			// AP 和客户端的高度差，再减掉客户端脚下踩的东西。
			const vertical = ap.verticalGapWu - (sampleHeightWu[i] ?? 0);
			const verticalAbs = Math.abs(vertical);
			const horiz = Math.sqrt(dx * dx + dy * dy);

			if (horiz > coverageHorizontalReach(ap.interferenceRadius, 0, 0)) continue;
			// 跨层路径按三维算，和热力图一致。
			const dist = vertical !== 0 ? Math.hypot(horiz, vertical) : horiz;
			const slabDb = slabDbOf(ap.signalScale);
			const crossings = ap.slabs;
			const slabLoss =
				crossings && crossings.length > 0
					? slabDb * slabLossFactor(crossings, ap.x - ox, ap.y - oy, sample.x, sample.y)
					: slabDb;
			if (horiz >= coverageHorizontalReach(ap.interferenceRadius, slabLoss, verticalAbs)) continue;
			const targetRun: WallRun = {
				mask: data,
				width,
				height,
				materialMask: cachedMaterialData,
				materialDb: tablesFor(ap.band),
				fallbackDb: wallDb,
				originX: ox,
				originY: oy,
				defaultMaterialId: wallState.wallMaterial
			};
			const sourceRun: WallRun | null = ap.source
				? {
						mask: ap.source.data,
						width: ap.source.width,
						height: ap.source.height,
						materialMask: ap.source.materialMask,
						materialDb: tablesFor(ap.band),
						fallbackDb: ap.source.materialMask
							? (tablesFor(ap.band)[ap.source.defaultMaterial] ?? wallDb)
							: wallDb,
						originX: ap.source.originX,
						originY: ap.source.originY,
						defaultMaterialId: ap.source.defaultMaterial
					}
				: null;
			// 路径离开本层时要在两张图上各推进一段：先走 AP 自己那层到楼板交点，再从交点走本层到采样点。
			const splitLoss = sourceRun
				? splitWallRunLoss(
						sourceRun,
						targetRun,
						ap.sourceT,
						ap.targetT,
						{ x: ap.x - ox, y: ap.y - oy },
						{ x: sample.x, y: sample.y },
						1
					)
				: null;
			let dbLoss =
				splitLoss ??
				wallRunLoss(targetRun, { x: ap.x - ox, y: ap.y - oy }, { x: sample.x, y: sample.y }, 1);

			const wallLossDb = dbLoss;
			dbLoss += slabLoss;

			const deck =
				(sampleHeightWu[i] ?? 0) > 0
					? deckCrossing(surfaces, sample.x + ox, sample.y + oy, vertical / surfaceWupm)
					: null;
			if (deck) dbLoss += deck.lossDb;
			dbLoss += antennaRayLossDb(antennaProfileFor(ap), vertical, dx, dy);
			const margin = coverageMarginDb(dist, ap.interferenceRadius) - dbLoss;
			if (margin > bestMargin) bestMargin = margin;
			if (margin > margins[index]!) margins[index] = margin;
			/*
			 * 绕过墙头的绕射，墙挡得越多它的分量越大
			 */
			const diffractionGate = Math.min(1, Math.max(0, (wallLossDb - 3) / 6));
			if (diffractionGate > 0 && diffractionEdges.length > 0) {
				const paths = diffractionPaths(
					{ x: ap.x - ox, y: ap.y - oy, z: vertical },
					{ x: sample.x, y: sample.y, z: 0 },
					diffractionEdges,
					bandWavelengthM(ap.band as '2.4ghz' | '5ghz' | '6ghz'),
					undefined,
					undefined,
					1 / wupmForGap,
					(edge) =>
						rayWallLossDb(
							{ x: ap.x - ox, y: ap.y - oy },
							{ x: edge.x, y: edge.y },
							reflectingWalls,
							ap.band as Band,
							edge.wallIndices ?? []
						) <= 1e-9 &&
						rayWallLossDb(
							{ x: edge.x, y: edge.y },
							{ x: sample.x, y: sample.y },
							reflectingWalls,
							ap.band as Band,
							edge.wallIndices ?? []
						) <= 1e-9,
					4
				);
				let diffractedMw = 0;
				for (const path of paths) {
					if (!(path.lossDb > 0)) continue;
					const diffractedMargin =
						coverageMarginDb((path.d1 + path.d2) * wupmForGap, ap.interferenceRadius) -
						(wallLossDb + path.lossDb) +
						(dbLoss - wallLossDb);
					diffractedMw += 10 ** (diffractedMargin / 10);
				}
				if (diffractedMw > 0) {
					const diffractedMargin = 10 * Math.log10(diffractedMw);
					const blended = margin + diffractionGate * (diffractedMargin - margin);
					if (blended > bestMargin) bestMargin = blended;
					if (blended > margins[index]!) margins[index] = blended;
				}
			}

			if (reflectingWalls.length > 0) {
				const bounce = bestReflection(
					{ x: ap.x - ox, y: ap.y - oy },
					{ x: sample.x, y: sample.y },
					reflectingWalls,
					ap.band as Band,
					reflectionReach
				);
				if (bounce) {
					const legLoss =
						rayWallLossDb(
							{ x: ap.x - ox, y: ap.y - oy },
							{ x: bounce.x, y: bounce.y },
							reflectingWalls,
							ap.band as Band,
							[bounce.wallIndex]
						) +
						rayWallLossDb(
							{ x: bounce.x, y: bounce.y },
							{ x: sample.x, y: sample.y },
							reflectingWalls,
							ap.band as Band,
							[bounce.wallIndex]
						);
					const reflectedMargin =
						coverageMarginDb(bounce.length, ap.interferenceRadius) +
						10 * Math.log10(bounce.powerRatio) -
						legLoss;
					if (reflectedMargin > bestMargin) bestMargin = reflectedMargin;
					if (reflectedMargin > margins[index]!) margins[index] = reflectedMargin;
				}

				for (const scatter of scatterByAp[index]!) {
					if (
						rayWallLossDb(
							{ x: scatter.x, y: scatter.y },
							{ x: sample.x, y: sample.y },
							reflectingWalls,
							ap.band as Band,
							[scatter.wallIndex]
						) > 1e-9
					) {
						continue;
					}
					const horizontal = Math.hypot(sample.x - scatter.x, sample.y - scatter.y);
					const d1M = Math.hypot(horizontal, scatter.z - vertical) / surfaceWupm;
					const d2M = Math.hypot(horizontal, scatter.z) / surfaceWupm;
					const factor =
						scatteringFactor({
							wall: scatter.wall,
							ap: { x: ap.x - ox, y: ap.y - oy },
							hit: { x: scatter.x, y: scatter.y },
							target: { x: sample.x, y: sample.y },
							material: scatter.wall.material,
							band: ap.band as Band,
							normalization: scatter.directiveNorm
						}) * scatter.areaM2;
					if (factor <= 0) continue;
					const scatteredMargin =
						coverageMarginDb(
							(d1M + d2M) * surfaceWupm,
							ap.interferenceRadius
						) +
						10 * Math.log10(factor);
					if (scatteredMargin > bestMargin) bestMargin = scatteredMargin;
					if (scatteredMargin > margins[index]!) margins[index] = scatteredMargin;
				}
			}
		}
		const w = sampleDensity[i] ?? 1;
		if (bestMargin >= coverageThresholdMarginDb()) coveredWeight += w;
		for (let k = 0; k < margins.length; k++) {
			if (!(margins[k]! > 0)) margins[k] = -Infinity;
		}
		if (channelsKnown && violatesAt(margins, channels, allAps.length, 0, null)) degradedWeight += w;
		totalWeight += w;
	}

	optimizerState.coverage = totalWeight > 0 ? Math.round((coveredWeight / totalWeight) * 100) : 0;
	optimizerState.interferenceMeasured = channelsKnown && totalWeight > 0;
	optimizerState.interferenceKnown = channelsKnown;
	if (channelsKnown && totalWeight > 0) {
		optimizerState.interference = Math.round((degradedWeight / totalWeight) * 100);
	}

	// debug(
	// 	`[coverage] ${cachedSamples.length} samples × ${apState.aps.length} APs in ${Math.round(performance.now() - coverageStarted)} ms`
	// );

	// 缓存每层的覆盖率（用采样点数当面积权重）
	const pixelsPerSample =
		cachedSamples.length > 0 ? cachedInteriorPixelCount / cachedSamples.length : 0;
	const devices = densityResult
		? sampleDensity.reduce((sum, value) => sum + value, 0) *
			pixelsPerSample *
			(1 / (wupmForGap * wupmForGap))
		: 0;
	floorCoverage.set(curFloorId, {
		coverage: optimizerState.coverage,
		samples: cachedSamples.length,
		devices: Math.round(devices),
		basis: coverageBasis(curFloorId)
	});
}