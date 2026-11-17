/**
 * 形态学操作与建筑内部检测。
 * 供边界检测、墙体检测、优化器 worker 与房间检测使用；不依赖 DOM，可在 Web Worker 中运行。
 */

export interface InteriorResult {
	/** 1 表示内部（建筑内且非墙体），0 表示外部或墙体。 */
	interior: Uint8Array;
	/** 1 表示外部（可从边界到达），0 表示非外部。 */
	exterior: Uint8Array;
}

export interface BuildingInteriorOptions {
	/** 形态学闭运算前降采样到的最大边长；0 表示不降采样。 */
	maxDim?: number;
	/** 膨胀半径占（降采样后）宽度的比例，默认 0.04。 */
	dilateRatio?: number;
	/** 膨胀半径的最小值，单位为像素，默认 10。 */
	minDilateR?: number;
	/**
	 * 把内部区域从每面墙处收缩一个像素（八邻域）。
	 *
	 * 适用于内部本身就是结果的场景（优化器的放置域与覆盖采样集）；`wall-detect` 的外部块过滤必须关闭，否则会移除所有墙体。默认关闭。
	 */
	trimWallAdjacent?: boolean;
	/**
	 * 丢弃过窄、放不下接入点的封闭区域，单位为掩码像素。
	 *
	 * 以区域的最大内切圆半径判定，小于该半径的区域整体移除；掩码像素即世界单位，默认 0 表示保留全部封闭区域。
	 */
	minRegionRadius?: number;
}

// ─── 可复用的形态学操作 ─────────────────────────────

/**
 * 封闭掩码中的缝隙，使宽度不超过 `2·radius` 的开口不再连通两侧。
 *
 * 闭运算（先膨胀后腐蚀）能在不增厚墙体的情况下封住门口；`radius` 单位为像素，越界区域视为实体。
 */
export function sealOpenings(
	mask: Uint8Array,
	w: number,
	h: number,
	radius: number
): Uint8Array {
	const r = Math.max(0, Math.round(radius));
	if (r === 0) return new Uint8Array(mask);
	return erodeMask(dilateMask(mask, w, h, r), w, h, r, 'solid');
}

/**
 * 用方形半径膨胀二值掩码中的真值像素，可分离实现，复杂度 O(n·r)。
 *
 * 返回新掩码，不修改输入；`radius` 单位为像素。
 */
export function dilateMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
	const r = Math.max(0, Math.round(radius));
	if (r === 0) return new Uint8Array(mask);

	// 水平方向：行内距离 r 以内有真值像素时置位；用滑动计数避免逐像素扫描。
	const rows = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		const base = y * w;
		let count = 0;
		for (let x = 0; x <= Math.min(w - 1, r); x++) count += mask[base + x]!;
		for (let x = 0; x < w; x++) {
			if (count > 0) rows[base + x] = 1;
			const out = x - r;
			const inn = x + r + 1;
			if (out >= 0) count -= mask[base + out]!;
			if (inn < w) count += mask[base + inn]!;
		}
	}

	// 垂直方向：对水平结果按列做同样处理。
	const out = new Uint8Array(w * h);
	for (let x = 0; x < w; x++) {
		let count = 0;
		for (let y = 0; y <= Math.min(h - 1, r); y++) count += rows[y * w + x]!;
		for (let y = 0; y < h; y++) {
			if (count > 0) out[y * w + x] = 1;
			const gone = y - r;
			const added = y + r + 1;
			if (gone >= 0) count -= rows[gone * w + x]!;
			if (added < h) count += rows[added * w + x]!;
		}
	}
	return out;
}

/**
 * 腐蚀：用方形半径收缩真值像素。
 *
 * 仅当半径内所有像素都为真值时该像素才保留；`oob` 决定越界内容的含义，`'empty'`（默认）视为空，`'solid'` 视为实体。
 */
export function erodeMask(
	mask: Uint8Array,
	w: number,
	h: number,
	radius: number,
	oob: 'empty' | 'solid' = 'empty'
): Uint8Array {
	const r = Math.max(0, Math.round(radius));
	const outsideIsSolid = oob === 'solid';
	if (r === 0) return new Uint8Array(mask);

	// 与膨胀一样可分离：像素仅当其整个方窗都为真时才保留，先检验行窗口再检验列窗口。
	// `'empty'` 越界时裁剪后的窗口更小（即缺失格未置位），`'solid'` 越界时视为已置位，两种情况都只统计范围内格。
	const rows = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		const base = y * w;
		let zeros = 0;
		const xlo = 0;
		const xhi = Math.min(w - 1, r);
		for (let x = xlo; x <= xhi; x++) if (!mask[base + x]) zeros++;
		for (let x = 0; x < w; x++) {
			const lo = Math.max(0, x - r);
			const hi = Math.min(w - 1, x + r);
			// 回退到当前像素的窗口：比逐格跟踪更简单，且窗口每步只移动一格，重新计数最多涉及两格。
			if (x === 0) {
				rows[base] = zeros === 0 ? 1 : 0;
			} else {
				const drop = x - 1 - r;
				const add = x + r;
				if (drop >= 0 && !mask[base + drop]) zeros--;
				if (add < w && !mask[base + add]) zeros++;
				rows[base + x] = lo <= hi && zeros === 0 ? 1 : 0;
			}
		}
	}

	const out = new Uint8Array(w * h);
	for (let x = 0; x < w; x++) {
		let zeros = 0;
		for (let y = 0; y <= Math.min(h - 1, r); y++) if (!rows[y * w + x]) zeros++;
		for (let y = 0; y < h; y++) {
			if (y === 0) {
				out[x] = zeros === 0 ? 1 : 0;
			} else {
				const drop = y - 1 - r;
				const add = y + r;
				if (drop >= 0 && !rows[drop * w + x]) zeros--;
				if (add < h && !rows[add * w + x]) zeros++;
				out[y * w + x] = zeros === 0 ? 1 : 0;
			}
		}
	}
	if (!outsideIsSolid) {
		// 越界视为空时，无论掩码如何，边界带的窗口里都有一个零：显式清除，而不是把裁剪窗口当作完整窗口。
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				if (x < r || y < r || x >= w - r || y >= h - r) out[y * w + x] = 0;
			}
		}
	}
	return out;
}

/**
 * 从所有边界像素出发，沿可通行（真值）像素做洪水填充。
 * 返回掩码，1 表示可从边界到达（外部）。
 */
export function floodFillExterior(passable: Uint8Array, w: number, h: number): Uint8Array {
	const exterior = new Uint8Array(w * h);
	const queue: number[] = [];

	// 从所有边界像素播种
	for (let x = 0; x < w; x++) {
		if (passable[x]) queue.push(x);
		if (passable[(h - 1) * w + x]) queue.push((h - 1) * w + x);
	}
	for (let y = 0; y < h; y++) {
		if (passable[y * w]) queue.push(y * w);
		if (passable[y * w + w - 1]) queue.push(y * w + w - 1);
	}

	while (queue.length > 0) {
		const idx = queue.pop()!;
		if (exterior[idx]) continue;
		exterior[idx] = 1;
		const x = idx % w;
		const y = Math.floor(idx / w);
		if (y > 0 && !exterior[idx - w] && passable[idx - w]) queue.push(idx - w);
		if (y < h - 1 && !exterior[idx + w] && passable[idx + w]) queue.push(idx + w);
		if (x > 0 && !exterior[idx - 1] && passable[idx - 1]) queue.push(idx - 1);
		if (x < w - 1 && !exterior[idx + 1] && passable[idx + 1]) queue.push(idx + 1);
	}

	return exterior;
}

// ─── 建筑内部检测 ───────────────────────────────────

/**
 * 从二值墙体掩码计算建筑内部：可选降采样 → 闭运算（膨胀+腐蚀）→ 外部洪水填充 → 内部。
 * 掩码中 1 表示墙体像素、0 表示可通行；返回原始 (w x h) 分辨率下的内部与外部掩码。
 */
export function computeBuildingInterior(
	wallMask: Uint8Array,
	w: number,
	h: number,
	options?: BuildingInteriorOptions
): InteriorResult {
	const maxDim = options?.maxDim ?? 0;
	const dilateRatio = options?.dilateRatio ?? 0.04;
	const minDilateR = options?.minDilateR ?? 10;

	// 确定工作分辨率
	const needsDownsample = maxDim > 0 && Math.max(w, h) > maxDim;
	const rs = needsDownsample ? maxDim / Math.max(w, h) : 1;
	const sw0 = Math.round(w * rs);
	const sh0 = Math.round(h * rs);

	// 闭运算半径，按未补边的工作掩码计算。
	const dilateR = Math.max(minDilateR, Math.round(sw0 * dilateRatio));

	/*
	 * 在四周按闭运算半径外扩后的掩码上工作。
	 *
	 * 掩码边缘不是墙；外边距薄于闭运算半径时会被吞掉，补边使“墙体围成闭合轮廓即为内部”成立。
	 */
	const pad = dilateR;
	const sw = sw0 + pad * 2;
	const sh = sh0 + pad * 2;

	/*
	 * 需要时把墙体掩码降采样进带补边的工作数组，并让墙体赢得所在格。
	 *
	 * 取格内最大值只会加粗墙体，最近邻采样则可能丢掉墙线而使建筑敞开。
	 */
	const small = new Uint8Array(sw * sh);
	if (needsDownsample) {
		for (let sy = 0; sy < sh0; sy++) {
			const oy0 = Math.min(h - 1, Math.floor(sy / rs));
			const oy1 = Math.min(h, Math.max(oy0 + 1, Math.ceil((sy + 1) / rs)));
			for (let sx = 0; sx < sw0; sx++) {
				const ox0 = Math.min(w - 1, Math.floor(sx / rs));
				const ox1 = Math.min(w, Math.max(ox0 + 1, Math.ceil((sx + 1) / rs)));
				let wall = 0;
				for (let oy = oy0; oy < oy1 && !wall; oy++) {
					for (let ox = ox0; ox < ox1; ox++) {
						if (wallMask[oy * w + ox]) {
							wall = 1;
							break;
						}
					}
				}
				small[(sy + pad) * sw + (sx + pad)] = wall;
			}
		}
	} else {
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				small[(y + pad) * sw + (x + pad)] = wallMask[y * w + x]!;
			}
		}
	}

	// 形态学闭运算：先膨胀墙体（收缩可通行区域），再膨胀可通行区域使其恢复。
	// 注意后半段是膨胀而非腐蚀，半径按“膨胀-膨胀”标定。
	const dilated = dilateMask(small, sw, sh, dilateR);
	const closedPass = new Uint8Array(sw * sh);
	for (let i = 0; i < sw * sh; i++) closedPass[i] = dilated[i] ? 0 : 1;
	const eroded = dilateMask(closedPass, sw, sh, dilateR);

	// 从边界洪水填充外部
	const smallExterior = floodFillExterior(eroded, sw, sh);

	// 上采样回原始分辨率
	const exterior = new Uint8Array(w * h);
	const interior = new Uint8Array(w * h);

	for (let y = 0; y < h; y++) {
		const sy = Math.min(sh0 - 1, Math.round(y * rs)) + pad;
		for (let x = 0; x < w; x++) {
			const sx = Math.min(sw0 - 1, Math.round(x * rs)) + pad;
			const ext = smallExterior[sy * sw + sx] === 1;
			if (ext) exterior[y * w + x] = 1;
			// 墙体判定读取无补边的全分辨率掩码：无论粗分辨率如何判断该格，墙体像素永远不是内部。
			if (!ext && !wallMask[y * w + x]) interior[y * w + x] = 1;
		}
	}

	// 当调用方把内部用作放置域或采样域时，向内收缩一个像素；见 `trimWallAdjacent`。
	if (options?.trimWallAdjacent) {
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = y * w + x;
				if (!interior[i]) continue;
				const up = y > 0;
				const down = y < h - 1;
				const left = x > 0;
				const right = x < w - 1;
				// 对角也算：在拐角处唯一可达的墙体像素是对角。
				if (
					(left && wallMask[i - 1]) ||
					(right && wallMask[i + 1]) ||
					(up && wallMask[i - w]) ||
					(down && wallMask[i + w]) ||
					(up && left && wallMask[i - w - 1]) ||
					(up && right && wallMask[i - w + 1]) ||
					(down && left && wallMask[i + w - 1]) ||
					(down && right && wallMask[i + w + 1])
				) {
					interior[i] = 0;
				}
			}
		}
	}

	// 移除空腔与绘图缝隙；用区域判定而非腐蚀，避免把墙从挂墙件旁挖掉。
	if (options?.minRegionRadius && options.minRegionRadius > 0) {
		dropThinRegions(interior, wallMask, w, h, options.minRegionRadius);
	}

	return { interior, exterior };
}

/**
 * 在不移动两条平行笔画的前提下填补它们之间的缝隙。
 *
 * 沿单一轴做一维闭运算：沿 y 闭合连接两条水平线且不改变其 y 坐标，沿 x 闭合处理竖向条带，垂直方向不会被撑大。
 */
export function fillParallelGaps(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
	if (radius <= 0) return new Uint8Array(mask);
	const maxGap = radius * 2;
	/*
	 * 用跨度填充而非先膨胀后腐蚀：逐行扫描，两处墨迹相距不超过 `maxGap` 时把中间背景填为墨迹。
	 * 它不需要图形四周的外边距，且只会在缝隙内部把 0 变成 1，条带不会外扩。
	 */
	const along = (input: Uint8Array, axis: 'x' | 'y'): Uint8Array => {
		const out = new Uint8Array(input);
		const lineLength = axis === 'x' ? w : h;
		const lineCount = axis === 'x' ? h : w;
		const indexOf = (line: number, at: number) => (axis === 'x' ? line * w + at : at * w + line);
		for (let line = 0; line < lineCount; line++) {
			let lastInk = -1;
			for (let at = 0; at < lineLength; at++) {
				if (!input[indexOf(line, at)]) continue;
				if (lastInk >= 0 && at - lastInk - 1 <= maxGap) {
					for (let p = lastInk + 1; p < at; p++) out[indexOf(line, p)] = 1;
				}
				lastInk = at;
			}
		}
		return out;
	};
	// 先沿 y：大多数条带横跨立面；再沿 x：处理沿立面竖向的条带。
	return along(along(mask, 'y'), 'x');
}

/**
 * 移除最大内切圆半径小于 `minRadius` 的每个封闭区域。
 * 两遍处理：先距离变换得到间隙，再连通标记遍历区域，区域整体保留或丢弃；原地修改 `interior`。
 */
export function dropThinRegions(
	interior: Uint8Array,
	wallMask: Uint8Array,
	w: number,
	h: number,
	minRadius: number
): void {
	const n = w * h;
	const clearance = new Float32Array(n);
	// 用两次扫描得到到最近墙体的切比雪夫距离：足以区分房间与缝隙，且避免把欧氏变换引入 worker 热路径。
	const INF = 1e9;
	for (let i = 0; i < n; i++) clearance[i] = wallMask[i] ? 0 : INF;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (clearance[i] === 0) continue;
			let best = clearance[i]!;
			if (y > 0) best = Math.min(best, clearance[i - w]! + 1);
			if (x > 0) best = Math.min(best, clearance[i - 1]! + 1);
			if (y > 0 && x > 0) best = Math.min(best, clearance[i - w - 1]! + 1);
			if (y > 0 && x < w - 1) best = Math.min(best, clearance[i - w + 1]! + 1);
			clearance[i] = best;
		}
	}
	for (let y = h - 1; y >= 0; y--) {
		for (let x = w - 1; x >= 0; x--) {
			const i = y * w + x;
			if (clearance[i] === 0) continue;
			let best = clearance[i]!;
			if (y < h - 1) best = Math.min(best, clearance[i + w]! + 1);
			if (x < w - 1) best = Math.min(best, clearance[i + 1]! + 1);
			if (y < h - 1 && x < w - 1) best = Math.min(best, clearance[i + w + 1]! + 1);
			if (y < h - 1 && x > 0) best = Math.min(best, clearance[i + w - 1]! + 1);
			clearance[i] = best;
		}
	}

	const label = new Int32Array(n).fill(-1);
	const queue = new Int32Array(n);
	/** 每个区域的像素列表，便于在丢弃时无需重新扫描即可清除。 */
	const pixelsOf: number[][] = [];

	for (let start = 0; start < n; start++) {
		if (!interior[start] || label[start] !== -1) continue;
		const id = pixelsOf.length;
		const pixels: number[] = [];
		pixelsOf.push(pixels);
		let head = 0;
		let tail = 0;
		queue[tail++] = start;
		label[start] = id;
		let maxClearance = 0;
		while (head < tail) {
			const i = queue[head++]!;
			pixels.push(i);
			const c = clearance[i]!;
			if (c > maxClearance) maxClearance = c;
			const x = i % w;
			const y = (i / w) | 0;
			for (let dy = -1; dy <= 1; dy++) {
				const ny = y + dy;
				if (ny < 0 || ny >= h) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx;
					if (nx < 0 || nx >= w) continue;
					const ni = ny * w + nx;
					if (!interior[ni] || label[ni] !== -1) continue;
					label[ni] = id;
					queue[tail++] = ni;
				}
			}
		}
		// `maxClearance` 即能放入该区域的最大圆半径。
		if (maxClearance < minRadius) {
			for (const i of pixels) interior[i] = 0;
		}
	}
}
