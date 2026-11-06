import { computeBuildingInterior, dilateMask, erodeMask } from './morphology.js';

export interface WallMask {
	dataUrl: string;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

/**
 * 从户型图图像中识别墙体。
 * 流程：阈值 -> 去除小块 -> 去除外部块 -> 二值掩码；返回显示宽度分辨率下、世界坐标中的墙体掩码。
 */
export async function detectWalls(
	image: HTMLImageElement,
	displayWidth: number
): Promise<WallMask | null> {
	const displayScale = displayWidth / image.naturalWidth;
	const w = displayWidth;
	const h = Math.round(image.naturalHeight * displayScale);

	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(image, 0, 0, w, h);

	// 先确定图纸的正负极性并修补未着色像素，之后再读取它们。参见 `resolveBackground`。
	const { darkBg } = resolveBackground(ctx, w, h);

	// 步骤 1：灰度化并用阈值转为二值（1 = 墙体像素）
	const imageData = ctx.getImageData(0, 0, w, h);
	const { data: pixels } = imageData;

	const gray = new Uint8Array(w * h);
	for (let i = 0; i < w * h; i++) {
		gray[i] = Math.round((pixels[i * 4]! + pixels[i * 4 + 1]! + pixels[i * 4 + 2]!) / 3);
	}

	// 自适应局部阈值：将每个像素与其邻域均值比较。
	// 能捕捉全局阈值漏掉的细弱墙线。
	let binary = adaptiveThreshold(gray, w, h, darkBg);

	// 户型图大部分是地面，若墙体像素超过一半则极性反了，这时用相反极性重试一次。
	let wallPixels = 0;
	for (let i = 0; i < w * h; i++) wallPixels += binary[i]!;
	if (wallPixels * 2 > w * h) {
		const flipped = adaptiveThreshold(gray, w, h, !darkBg);
		let flippedPixels = 0;
		for (let i = 0; i < w * h; i++) flippedPixels += flipped[i]!;
		if (flippedPixels < wallPixels) binary = flipped;
	}

	// 步骤 3：填充绘制墙体内部的空腔。
	// 墙通常画成两条笔画夹填充，阈值只保留笔画而得到空心轮廓；形态学闭运算按半径桥接间隙并填补空腔。
	// 半径随图纸尺寸缩放，并限制在上下限之间。
	const closeRadius = Math.max(2, Math.min(6, Math.round(Math.min(w, h) * 0.004)));
	// `oob: 'solid'`：延伸到图纸边缘的墙仍是墙，因此腐蚀不能削掉它的边缘。
	binary = erodeMask(dilateMask(binary, w, h, closeRadius), w, h, closeRadius, 'solid');

	// 步骤 4：去除小的离散块（噪点、圆点、残留细文字）
	const minBlobPx = Math.max(30, Math.round(w * h * 0.0003));
	filterSmallBlobs(binary, w, h, minBlobPx);

	// 步骤 5：去除建筑外部之外的块
	removeExteriorBlobs(binary, w, h);

	let wallCount = 0;
	for (let i = 0; i < w * h; i++) wallCount += binary[i]!;
	if (wallCount < 50) return null;

	// 步骤 5：将二值掩码编码为 PNG data URL
	const maskCanvas = document.createElement('canvas');
	maskCanvas.width = w;
	maskCanvas.height = h;
	const maskCtx = maskCanvas.getContext('2d')!;
	const maskImg = maskCtx.createImageData(w, h);
	for (let i = 0; i < w * h; i++) {
		const j = i * 4;
		if (binary[i]) {
			maskImg.data[j] = 255;
			maskImg.data[j + 1] = 255;
			maskImg.data[j + 2] = 255;
			maskImg.data[j + 3] = 255;
		}
	}
	maskCtx.putImageData(maskImg, 0, 0);

	return {
		dataUrl: maskCanvas.toDataURL('image/png'),
		width: w,
		height: h,
		originX: 0,
		originY: 0
	};
}

function filterSmallBlobs(binary: Uint8Array, w: number, h: number, minSize: number): void {
	const labels = new Int32Array(w * h).fill(-1);
	const blobPixels: number[][] = [];
	let nextLabel = 0;

	for (let i = 0; i < w * h; i++) {
		if (!binary[i] || labels[i] !== -1) continue;

		const label = nextLabel++;
		const pixels: number[] = [];
		const queue = [i];
		labels[i] = label;

		while (queue.length > 0) {
			const idx = queue.pop()!;
			pixels.push(idx);
			const x = idx % w;
			const y = Math.floor(idx / w);

			if (y > 0 && binary[idx - w] && labels[idx - w] === -1) {
				labels[idx - w] = label;
				queue.push(idx - w);
			}
			if (y < h - 1 && binary[idx + w] && labels[idx + w] === -1) {
				labels[idx + w] = label;
				queue.push(idx + w);
			}
			if (x > 0 && binary[idx - 1] && labels[idx - 1] === -1) {
				labels[idx - 1] = label;
				queue.push(idx - 1);
			}
			if (x < w - 1 && binary[idx + 1] && labels[idx + 1] === -1) {
				labels[idx + 1] = label;
				queue.push(idx + 1);
			}
		}

		blobPixels.push(pixels);
	}

	for (const pixels of blobPixels) {
		if (pixels.length < minSize) {
			for (const idx of pixels) binary[idx] = 0;
		}
	}
}

/** 去除建筑外部的墙体块。
 *  形态学闭运算封住门洞，洪水填充识别外部，再删除不与内部相邻的墙体块。 */
function removeExteriorBlobs(binary: Uint8Array, w: number, h: number): void {
	const { interior: fullInterior } = computeBuildingInterior(binary, w, h, {
		maxDim: 400,
		dilateRatio: 0.03,
		minDilateR: 5
	});

	// 在原始分辨率下标记墙体块，并检查它们是否接触内部
	const labels = new Int32Array(w * h).fill(-1);
	const blobPixels: number[][] = [];
	const blobTouchesInterior: boolean[] = [];
	let nextLabel = 0;

	for (let i = 0; i < w * h; i++) {
		if (!binary[i] || labels[i] !== -1) continue;

		const label = nextLabel++;
		const pixels: number[] = [];
		let touches = false;
		const bq = [i];
		labels[i] = label;

		while (bq.length > 0) {
			const idx = bq.pop()!;
			pixels.push(idx);
			const x = idx % w,
				y = Math.floor(idx / w);

			// 检查四连通邻居是否属于内部
			if (y > 0 && fullInterior[idx - w]) touches = true;
			if (y < h - 1 && fullInterior[idx + w]) touches = true;
			if (x > 0 && fullInterior[idx - 1]) touches = true;
			if (x < w - 1 && fullInterior[idx + 1]) touches = true;

			if (y > 0 && binary[idx - w] && labels[idx - w] === -1) {
				labels[idx - w] = label;
				bq.push(idx - w);
			}
			if (y < h - 1 && binary[idx + w] && labels[idx + w] === -1) {
				labels[idx + w] = label;
				bq.push(idx + w);
			}
			if (x > 0 && binary[idx - 1] && labels[idx - 1] === -1) {
				labels[idx - 1] = label;
				bq.push(idx - 1);
			}
			if (x < w - 1 && binary[idx + 1] && labels[idx + 1] === -1) {
				labels[idx + 1] = label;
				bq.push(idx + 1);
			}
		}

		blobPixels.push(pixels);
		blobTouchesInterior.push(touches);
	}

	// 删除不接触内部的块（外部装饰、图例）
	for (let b = 0; b < blobPixels.length; b++) {
		if (!blobTouchesInterior[b]) {
			for (const idx of blobPixels[b]!) binary[idx] = 0;
		}
	}
}

/**
 * 判断图纸的明暗极性，并修补未着色的透明像素。
 * 返回 `adaptiveThreshold` 所需的极性：墙体为较亮像素时为 true。
 */
function resolveBackground(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number
): { darkBg: boolean; paper: [number, number, number] } {
	const pixels = ctx.getImageData(0, 0, w, h).data;

	let borderLumSum = 0;
	let borderRSum = 0;
	let borderGSum = 0;
	let borderBSum = 0;
	let borderOpaque = 0;
	let borderTotal = 0;
	const borderAdd = (i: number): void => {
		borderTotal++;
		if (pixels[i + 3]! < 250) return;
		borderRSum += pixels[i]!;
		borderGSum += pixels[i + 1]!;
		borderBSum += pixels[i + 2]!;
		borderLumSum += (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
		borderOpaque++;
	};
	for (let x = 0; x < w; x++) {
		borderAdd(x * 4);
		borderAdd(((h - 1) * w + x) * 4);
	}
	for (let y = 1; y < h - 1; y++) {
		borderAdd(y * w * 4);
		borderAdd((y * w + w - 1) * 4);
	}

	const lumHistogram = new Uint32Array(256);
	const colourCounts = new Map<number, number>();
	let opaque = 0;
	for (let i = 0; i < pixels.length; i += 4) {
		if (pixels[i + 3]! < 250) continue;
		opaque++;
		lumHistogram[Math.round((pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3)]!++;
		const key = ((pixels[i]! >> 3) << 10) | ((pixels[i + 1]! >> 3) << 5) | (pixels[i + 2]! >> 3);
		colourCounts.set(key, (colourCounts.get(key) ?? 0) + 1);
	}

	// 没有一个不透明像素：这是空白画布而非户型图。浅色纸面是无害的选择，阈值找不到东西，
	// `detectWalls` 会在下方的墙体数量检查中返回 null。
	if (opaque === 0) return { darkBg: false, paper: [255, 255, 255] };

	// 图纸自带纸面且边框与纸面同色时，直接以边框作为背景色。
	// 扫描件的边框常是最暗处（阴影、盖子、相框、桌面），与纸面不一致时以纸面为准。
	const modeLum = modalLuminance(lumHistogram);
	if (borderOpaque >= borderTotal * 0.1) {
		const borderLum = borderLumSum / borderOpaque;
		if (Math.abs(borderLum - modeLum) <= BORDER_AGREEMENT) {
			return {
				darkBg: borderLum < 128,
				paper: [
					Math.round(borderRSum / borderOpaque),
					Math.round(borderGSum / borderOpaque),
					Math.round(borderBSum / borderOpaque)
				]
			};
		}
		// 该边缘是别的东西——阴影、相框或桌面。纸面是图纸的主要色调。
		return { darkBg: modeLum < 128, paper: modalColour(colourCounts) };
	}

	// 没有绘制纸面时，未着色区域就是纸面，其颜色不在文件中。
	// 图纸整体的明暗决定极性：偏亮用白纸，偏暗用黑纸；由像素亮度的中位数判定。
	const medianLum = medianFromHistogram(lumHistogram, opaque);
	if (medianLum >= 128) {
		compositeOntoPaper(ctx, w, h, [255, 255, 255]);
		return { darkBg: false, paper: [255, 255, 255] };
	}

	// 整体偏暗的图纸是配深色画布的，沿用它，并取自身最暗的常见颜色以保证极性一致。
	const paper = darkestModalColour(colourCounts);
	compositeOntoPaper(ctx, w, h, paper);
	return { darkBg: true, paper };
}

/**
 * 用 `paper` 填充画布的透明部分，不透明的像素保持不变（`destination-over` 绘制在其后方）。
 * 没有透明像素时为空操作。
 */
function compositeOntoPaper(
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	paper: [number, number, number]
): void {
	const pixels = ctx.getImageData(0, 0, w, h).data;
	let transparent = 0;
	for (let i = 3; i < pixels.length; i += 4) {
		if (pixels[i]! < 250) transparent++;
	}
	if (transparent === 0) return;

	ctx.save();
	ctx.globalCompositeOperation = 'destination-over';
	ctx.fillStyle = `rgb(${paper[0]}, ${paper[1]}, ${paper[2]})`;
	ctx.fillRect(0, 0, w, h);
	ctx.restore();
}

/**
 * 边框亮度与图像最常见色调之间允许的最大差值，单位是亮度级（0-255）。
 * 在此范围内边框仍被当作纸面。
 */
const BORDER_AGREEMENT = 48;

/**
 * 不透明像素中最常见的颜色，每个通道量化到 5 位。
 * 量化是为了让带渐变或抗锯齿的图纸仍有可用的众数；无结果时回退为白色。
 */
function modalColour(colourCounts: Map<number, number>): [number, number, number] {
	let best: [number, number, number] = [255, 255, 255];
	let bestCount = 0;
	for (const [key, count] of colourCounts) {
		if (count <= bestCount) continue;
		bestCount = count;
		best = [(((key >> 10) & 31) << 3) + 4, (((key >> 5) & 31) << 3) + 4, ((key & 31) << 3) + 4];
	}
	return best;
}

/**
 * 最常见的亮度，按 8 级一桶统计。
 * 分桶是为了让扫描件仍有可用的峰值。
 */
function modalLuminance(histogram: Uint32Array): number {
	const buckets = new Uint32Array(32);
	for (let lum = 0; lum < histogram.length; lum++) {
		buckets[lum >> 3]! += histogram[lum]!;
	}
	let bestBucket = 0;
	let bestCount = -1;
	for (let b = 0; b < buckets.length; b++) {
		if (buckets[b]! > bestCount) {
			bestCount = buckets[b]!;
			bestBucket = b;
		}
	}
	// 取获胜桶的中心，避免落在桶边缘的峰值被报成最暗一级。
	return bestBucket * 8 + 4;
}

/** 亮度中位数：一半不透明像素位于该亮度以下。 */
function medianFromHistogram(histogram: Uint32Array, total: number): number {
	let seen = 0;
	for (let lum = 0; lum < histogram.length; lum++) {
		seen += histogram[lum]!;
		if (seen * 2 >= total) return lum;
	}
	return 255;
}

/**
 * 不透明像素中较暗部分里最常见的颜色，每个通道量化到 5 位。
 * 量化是为了让带渐变或抗锯齿的图纸仍有可用的众数；无结果时回退为黑色。
 */
function darkestModalColour(colourCounts: Map<number, number>): [number, number, number] {
	let bestKey = -1;
	let bestCount = 0;
	for (const [key, count] of colourCounts) {
		const r = (((key >> 10) & 31) << 3) + 4;
		const g = (((key >> 5) & 31) << 3) + 4;
		const b = ((key & 31) << 3) + 4;
		if ((r + g + b) / 3 >= 128) continue;
		if (count > bestCount) {
			bestCount = count;
			bestKey = key;
		}
	}
	if (bestKey < 0) return [0, 0, 0];
	return [
		(((bestKey >> 10) & 31) << 3) + 4,
		(((bestKey >> 5) & 31) << 3) + 4,
		((bestKey & 31) << 3) + 4
	];
}

/** 使用积分图做自适应局部阈值，将每个像素与 KxK 邻域均值比较，单次查询为 O(1)。
 *  深色背景：比局部均值 + C 更亮的像素为墙；浅色背景：比局部均值 - C 更暗的像素为墙。 */
function adaptiveThreshold(gray: Uint8Array, w: number, h: number, darkBg: boolean): Uint8Array {
	// 构建积分图以快速计算局部均值
	const integral = new Float64Array((w + 1) * (h + 1));
	for (let y = 0; y < h; y++) {
		let rowSum = 0;
		for (let x = 0; x < w; x++) {
			rowSum += gray[y * w + x]!;
			integral[(y + 1) * (w + 1) + (x + 1)] = rowSum + integral[y * (w + 1) + (x + 1)]!;
		}
	}

	function localMean(x: number, y: number, r: number): number {
		const x0 = Math.max(0, x - r);
		const y0 = Math.max(0, y - r);
		const x1 = Math.min(w, x + r + 1);
		const y1 = Math.min(h, y + r + 1);
		const stride = w + 1;
		const sum =
			integral[y1 * stride + x1]! -
			integral[y0 * stride + x1]! -
			integral[y1 * stride + x0]! +
			integral[y0 * stride + x0]!;
		return sum / ((x1 - x0) * (y1 - y0));
	}

	const binary = new Uint8Array(w * h);
	const radius = Math.max(8, Math.round(Math.max(w, h) * 0.03));
	// C：像素与局部均值的最小差值，超过即判为墙
	const C = darkBg ? 15 : -15;

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const val = gray[y * w + x]!;
			const mean = localMean(x, y, radius);
			if (darkBg) {
				binary[y * w + x] = val > mean + C ? 1 : 0;
			} else {
				binary[y * w + x] = val < mean + C ? 1 : 0;
			}
		}
	}

	return binary;
}
