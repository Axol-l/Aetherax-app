/**
 * 从画好的墙体掩码里描出线段，供矢量墙使用。
 *
 * 做法只认正交：连续墙体像素的中间就是中心线，同一条线上的段会合并（被门框、文字打断的墙
 * 仍算一根）；厚墙带靠「横截面比最小长度短」被丢掉，一条带只出一根线。坐标是掩码像素，原点
 * 由调用方补上。
 */
import type { WallMaterialId } from '$lib/domain/materials.js';
import { getFloorMask } from './floor-mask.js';
import { floorState } from './floor-state.svelte.js';

export interface TracedWall {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: WallMaterialId;
}

export interface TraceOptions {
	/** 比这个短的连续段算横截面，不算墙。 */
	minLength?: number;
	/** 行/列相距在这个范围内、又有重叠的连续段，算同一道墙。 */
	mergeGap?: number;
	/** 端点相距小于这个值就接起来，让拐角和 T 形交点闭合。 */
	joinGap?: number;
}

interface Run {
	/** 横向连续段存行号，纵向连续段存列号。 */
	line: number;
	from: number;
	to: number;
	material: WallMaterialId;
}

/** 取这段里出现最多的材质；0（没画）换成默认材质。 */
function modeMaterial(
	material: Uint8Array | null,
	base: number,
	stride: number,
	from: number,
	to: number,
	defaultMaterial: WallMaterialId
): WallMaterialId {
	if (!material) return defaultMaterial;
	const counts = new Map<number, number>();
	for (let i = from; i <= to; i++) {
		const id = material[base + i * stride] || defaultMaterial;
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	let best = defaultMaterial as number;
	let bestCount = -1;
	for (const [id, count] of counts) {
		if (count > bestCount) {
			best = id;
			bestCount = count;
		}
	}
	return best as WallMaterialId;
}

/** 沿一个轴扫出所有够长的墙体连续段。 */
function runsAlong(
	wall: Uint8Array,
	material: Uint8Array | null,
	width: number,
	height: number,
	horizontal: boolean,
	minLength: number,
	defaultMaterial: WallMaterialId
): Run[] {
	const runs: Run[] = [];
	const lines = horizontal ? height : width;
	const span = horizontal ? width : height;
	for (let line = 0; line < lines; line++) {
		let start = -1;
		for (let i = 0; i <= span; i++) {
			const inside = i < span && wall[horizontal ? line * width + i : i * width + line];
			if (inside && start < 0) start = i;
			if (!inside && start >= 0) {
				const end = i - 1;
				if (end - start + 1 >= minLength) {
					const base = horizontal ? line * width : line;
					runs.push({
						line,
						from: start,
						to: end,
						material: modeMaterial(material, base, horizontal ? 1 : width, start, end, defaultMaterial)
					});
				}
				start = -1;
			}
		}
	}
	return runs;
}

/**
 * 把属于同一道墙的连续段合并起来。
 *
 * 相邻行、跨度明显重叠的两段算同一道墙。合并后取更长的跨度和最多的材质，所以用两种材质刷的
 * 一条带会变成一根按多数材质着色的线段——输出里看得见，手动改一下就能纠正。
 */
function mergeRuns(runs: Run[], mergeGap: number): Run[] {
	const sorted = [...runs].sort((a, b) => a.line - b.line || a.from - b.from);
	const merged: Run[] = [];
	for (const run of sorted) {
		const host = merged.find((candidate) => {
			if (Math.abs(candidate.line - run.line) > mergeGap) return false;
			/*
			 * 只有同材质的段才算同一道墙。
			 *
			 * 检测会把窗和门画成各自的材质，跨材质合并曾把一排窗并成房间的整条上墙：变成
			 * 一条按墙体材质的长线，洞口全没了。让窗带还是窗段，墙还是墙。
			 */
			if (candidate.material !== run.material) return false;
			const overlap = Math.min(candidate.to, run.to) - Math.max(candidate.from, run.from);
			const shortest = Math.min(candidate.to - candidate.from, run.to - run.from);
			// 这里要覆盖两种情况：一条厚墙带的各行几乎完全重叠；被门框打断的半截墙只擦到
			// 一点。两者都是同一道墙，所以沿走向的小缺口也算连上。
			const alongGap = Math.max(candidate.from, run.from) - Math.min(candidate.to, run.to);
			if (overlap > shortest * 0.5 && shortest >= 0) return true;
			return alongGap <= mergeGap * 2;
		});
		if (!host) {
			merged.push({ ...run });
			continue;
		}
		host.from = Math.min(host.from, run.from);
		host.to = Math.max(host.to, run.to);
		// 合并后的线取两段的平均，这样厚墙带正好落在厚度中间。
		host.line = Math.round((host.line + run.line) / 2);
	}
	return merged;
}

/** 在某个点上沿法线方向量墙体厚度。 */
function thicknessAt(
	wall: Uint8Array,
	width: number,
	height: number,
	x: number,
	y: number,
	horizontal: boolean,
	maxProbe = 24
): number {
	let count = 0;
	for (let d = -maxProbe; d <= maxProbe; d++) {
		const px = horizontal ? Math.round(x) : Math.round(x) + d;
		const py = horizontal ? Math.round(y) + d : Math.round(y);
		if (px < 0 || py < 0 || px >= width || py >= height) continue;
		if (wall[py * width + px]) count++;
	}
	return count;
}

/**
 * 收拾描摹出来的结果。
 *
 * 去掉三种「把墙算多」的情况：每多一根线段射线就多穿一次，实测这样描出来是 5.98 dB，按掩码
 * 算是 4.60。
 *
 * 1. **去掉横截面**：沿墙带短轴的段长度等于墙厚，不是墙；横竖两遍都会产出候选。
 * 2. **合并重叠段**：同一条线上的共线重叠段是同一道墙，墙带错位时会重复。
 * 3. **接上端点**：相距几个单位内的端点拉到中点，搭在墙上的端点投影过去，别留缝。
 */
export function pruneWalls(
	walls: readonly TracedWall[],
	wall: Uint8Array,
	width: number,
	height: number,
	options: TraceOptions = {}
): TracedWall[] {
	const joinGap = options.joinGap ?? 6;
	const kept: TracedWall[] = [];

	// 1. 去掉横截面：长度要比墙带厚度大好几倍才行。
	for (const candidate of walls) {
		const horizontal = Math.abs(candidate.ay - candidate.by) < Math.abs(candidate.ax - candidate.bx);
		const length = Math.hypot(candidate.bx - candidate.ax, candidate.by - candidate.ay);
		const midX = (candidate.ax + candidate.bx) / 2;
		const midY = (candidate.ay + candidate.by) / 2;
		const thickness = thicknessAt(wall, width, height, midX, midY, horizontal);
		if (length < Math.max(12, thickness * 2.5)) continue;
		kept.push({ ...candidate });
	}

	// 2. 合并共线的重叠段。
	const merged: TracedWall[] = [];
	for (const candidate of kept) {
		const horizontal = candidate.ay === candidate.by;
		const host = merged.find((other) => {
			const otherHorizontal = other.ay === other.by;
			if (otherHorizontal !== horizontal) return false;
			const sameLine = horizontal
				? Math.abs(other.ay - candidate.ay) <= 3
				: Math.abs(other.ax - candidate.ax) <= 3;
			if (!sameLine) return false;
			if (horizontal) {
				const overlap = Math.min(other.bx, candidate.bx) - Math.max(other.ax, candidate.ax);
				return overlap > 0;
			}
			const overlap = Math.min(other.by, candidate.by) - Math.max(other.ay, candidate.ay);
			return overlap > 0;
		});
		if (!host) {
			merged.push({ ...candidate });
			continue;
		}
		if (horizontal) {
			host.ax = Math.min(host.ax, candidate.ax);
			host.bx = Math.max(host.bx, candidate.bx);
			host.ay = host.by = Math.round((host.ay + candidate.ay) / 2);
		} else {
			host.ay = Math.min(host.ay, candidate.ay);
			host.by = Math.max(host.by, candidate.by);
			host.ax = host.bx = Math.round((host.ax + candidate.ax) / 2);
		}
	}

	// 3. 接端点：几乎碰头的两个端点拉到中点，搭在墙上的端点则投影过去。
	const near = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
	for (let i = 0; i < merged.length; i++) {
		for (let j = i + 1; j < merged.length; j++) {
			const a = merged[i]!;
			const b = merged[j]!;
			const pairs: Array<[ 'ax' | 'bx', 'ax' | 'bx' ]> = [
				['ax', 'ax'],
				['ax', 'bx'],
				['bx', 'ax'],
				['bx', 'bx']
			];
			for (const [pa, pb] of pairs) {
				const ax = pa === 'ax' ? a.ax : a.bx;
				const ay = pa === 'ax' ? a.ay : a.by;
				const bx = pb === 'ax' ? b.ax : b.bx;
				const by = pb === 'ax' ? b.ay : b.by;
				if (near(ax, ay, bx, by) > joinGap) continue;
				const mx = (ax + bx) / 2;
				const my = (ay + by) / 2;
				if (pa === 'ax') {
					a.ax = mx;
					a.ay = my;
				} else {
					a.bx = mx;
					a.by = my;
				}
				if (pb === 'ax') {
					b.ax = mx;
					b.ay = my;
				} else {
					b.bx = mx;
					b.by = my;
				}
			}
		}
	}

	return merged;
}

/** 从画好的掩码描出来的墙线段，单位是掩码像素。 */
export function traceWallsFromMask(
	wall: Uint8Array,
	material: Uint8Array | null,
	width: number,
	height: number,
	defaultMaterial: WallMaterialId,
	options: TraceOptions = {}
): TracedWall[] {
	if (width <= 0 || height <= 0) return [];
	// 横截面和墙带一样宽，而墙要长得多。12 个单位略大于栅格工具最粗的笔刷，所以一笔的横
	// 截面混不成墙，再短的真墙也能留下。
	const minLength = options.minLength ?? 12;
	const mergeGap = options.mergeGap ?? 3;

	const horizontal = mergeRuns(
		runsAlong(wall, material, width, height, true, minLength, defaultMaterial),
		mergeGap
	);
	const vertical = mergeRuns(
		runsAlong(wall, material, width, height, false, minLength, defaultMaterial),
		mergeGap
	);

	const walls: TracedWall[] = [];
	for (const run of horizontal) {
		walls.push({ ax: run.from, ay: run.line, bx: run.to, by: run.line, material: run.material });
	}
	for (const run of vertical) {
		walls.push({ ax: run.line, ay: run.from, bx: run.line, by: run.to, material: run.material });
	}
	return pruneWalls(walls, wall, width, height, options);
}

/**
 * 用矢量读取器给出的几何直接写入楼层的墙。
 *
 * 这是最准的路径：图纸本身说了墙在哪，不用描、不用近似。返回写入的线段数——返回 0 说明
 * 调用方该退回描摹掩码（比如图纸里的元素全是曲线）。
 */
export function setFloorWallsFromSegments(
	floorId: string,
	segments: ReadonlyArray<{ ax: number; ay: number; bx: number; by: number; material: number }>
): number {
	const floor = floorState.floors.find((candidate) => candidate.id === floorId);
	if (!floor) return 0;
	floor.walls = segments.map((segment) => ({
		id: crypto.randomUUID(),
		ax: segment.ax,
		ay: segment.ay,
		bx: segment.bx,
		by: segment.by,
		material: segment.material as WallMaterialId
	}));
	floor.columns = [];
	return floor.walls.length;
}

/**
 * 把楼层当前的掩码描成墙体线段。
 *
 * **凡是**产出掩码的路径都得调它，否则只有掩码的楼层在矢量层上画不出东西、也没法编辑（以前
 * 只接在「重新检测」上，导入的还是一张图，而导入走的是 `importFloorplanFile` 那几条路径）。
 * 调用方必须先清空 `floor.walls`：有线段时 `getFloorMask` 是用线段反推掩码。返回写入的
 * 线段数，0 表示没有够长的连续段可描。
 */
export async function traceFloorWalls(floorId: string): Promise<number> {
	const floor = floorState.floors.find((candidate) => candidate.id === floorId);
	if (!floor) return 0;
	const decoded = await getFloorMask(floorId);
	if (!decoded) return 0;
	const traced = traceWallsFromMask(
		decoded.wallData,
		decoded.materialMap,
		decoded.width,
		decoded.height,
		floor.wallMaterial as WallMaterialId,
		/*
		 * 够长才算墙，别把家具算进来。
		
		 * 默认最小值 12 像素，对手绘掩码合适（那是一笔的横截面），但对检测出的图纸太松：
		 * 桌子、椅子或一排剖面线都有二三十像素长，以前全成了墙——图纸上多个小凸起，热力图里
		 * 多道窄阴影。24 像素大约等于导入目标尺寸下一扇门的宽度，真正的隔断还能留下，家具
		 * 不会。
		 */
		{ minLength: 24 }
	);
	floor.walls = traced.map((wall) => ({
		id: crypto.randomUUID(),
		ax: wall.ax + decoded.originX,
		ay: wall.ay + decoded.originY,
		bx: wall.bx + decoded.originX,
		by: wall.by + decoded.originY,
		material: wall.material
	}));
	floor.columns = [];
	return floor.walls.length;
}
