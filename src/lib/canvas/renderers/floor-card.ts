/**
 * 每个楼层缩略图的组成部分，由两个总览视图共用。
 * `FloorTilesLayer` 按网格排布楼层，堆叠视图按高度堆叠；卡片其余工作（解码并缓存底图与掩码图、
 * 绘制平面图、掩码轮廓、楼层覆盖图和 AP 点）在此共用，图像缓存同样共用，避免重复生成。
 */

import { apMarkerColor } from './ap.js';
import { colorizeWalls } from './walls.js';
import type { WallMaterialId } from '$lib/domain/materials.js';

/** 底图宽度，世界单位；与 `FloorplanLayer` 一致，使平面图缩放相同。 */
export const CARD_PLAN_WIDTH = 800;

/**
 * 既无掩码也未加载平面图的楼层所使用的后备框。
 * 它比真实平面图小，以免在网格或堆叠中遮住下方楼层，同时仍表明该楼层存在。
 */
const EMPTY_W = 320;
const EMPTY_H = 240;

export interface FloorCardSource {
	id: string;
	name: string;
	planUrl: string | null;
	planOffsetX: number;
	planOffsetY: number;
	maskUrl: string | null;
	/**
	 * 该楼层已绘制的材质图，与平面图为墙体着色所用的栅格相同。
	 * 缺失时总览只能绘制墙体掩码而无法区分材质；楼层未重绘过材质时为 null。
	 */
	materialUrl: string | null;
	/** 该楼层未上漆墙体的绘制材质，参见 `getFloorMask`。 */
	defaultMaterial: number;
	maskOriginX: number;
	maskOriginY: number;
	maskWidth: number;
	maskHeight: number;
	/** 该楼层手绘的规划区域；有它时它才是可选/绘制的范围。 */
	planningArea?: Array<{ x: number; y: number }> | null;
	/**
	 * 该楼层的标定，单位：世界单位/米。
	 * 卡片按楼层自身的单位绘制，再把整幅图缩放到底图坐标框架中，使不同分辨率的楼层尺寸可比。
	 */
	wupm: number;
	/**
	 * 该楼层的接入点，与单楼层视图的绘制方式一致。
	 * 携带信道以便总览按平面图的规则着色；`mountHeightM` 供堆叠视图按 AP 实际安装高度抬升标记，
	 * 安装方式决定标记形状，壁挂单元绘制为面板。
	 */
	aps: Array<{
		x: number;
		y: number;
		assignedChannel?: number | null;
		band?: string;
		mountHeightM?: number;
		mount?: string;
		facingDeg?: number;
	}>;
	/**
	 * 该楼层行走面相对最低楼层的高度，单位：米。
	 * 仅堆叠视图读取，由 `floorElevation` 推导而不存储，以免与已有的 `level`、`ceilingHeight` 不一致。
	 */
	elevation: number;
}

/** 为某个楼层生成的覆盖图像，坐标单位为世界单位。 */
export interface FloorHeatmap {
	canvas: HTMLCanvasElement;
	x0: number;
	y0: number;
	texel: number;
}

/** 卡片绘制的内容，使两个视图对 LAYERS 面板的开关含义保持一致。 */
export interface CardContentOptions {
	showPlan: boolean;
	showWalls: boolean;
	showAPs: boolean;
	showHeatmap: boolean;
	/** 底图透明度，与单楼层视图共用。 */
	planOpacity: number;
	/** 相机缩放，使屏幕上尺寸恒定的细节保持恒定。 */
	zoom: number;
	/** 底图的参考比例，楼层自身的绘制会换算到该比例。 */
	wupm: number;
}

/** 卡片内容占据的世界坐标包围盒。 */
export interface CardBox {
	minX: number;
	minY: number;
	w: number;
	h: number;
}

/**
 * 所有楼层的已解码图像与已生成覆盖图，仅持有一份。
 * `sync` 由两个视图的 `setFloors` 驱动，同时清理不再需要的 URL 与已删除楼层的条目。
 */
export class FloorCardCache {
	readonly images = new Map<string, HTMLImageElement>();
	/**
	 * 按楼层 id 索引的覆盖图像，由调用方（`CanvasView` 的预热循环）填充而非在此计算，
	 * 使覆盖着色只有一份实现。
	 */
	readonly heatmaps = new Map<string, FloorHeatmap>();
	/**
	 * 按楼层 id 索引、已按材质着色的墙体。
	 * 由该楼层已有的墙体掩码与材质图配合平面图的着色器生成，并缓存为画布以免每帧重建。
	 */
	private readonly wallCanvases = new Map<string, { signature: string; canvas: HTMLCanvasElement }>();
	/**
	 * 按楼层 id 记录的构建中任务。
	 * 着色栅格需要两张位图都解码完成，此表用于防止首个构建等待期间重复启动相同构建。
	 */
	private readonly wallJobs = new Map<string, string>();
	/** 平面图图像加载完成时调用，以便引擎重绘。 */
	onLoad: (() => void) | null = null;

	/** 着色墙体栅格所依赖的全部输入，用于避免绘制过期结果。 */
	private wallSignature(s: FloorCardSource): string {
		return `${s.maskUrl ?? ''}|${s.materialUrl ?? ''}|${s.defaultMaterial}|${s.maskWidth}x${s.maskHeight}`;
	}

	/**
	 * 确保该楼层的着色墙体存在，不存在则启动构建。
	 * 两张栅格取自 `sync` 已加载的位图，并用平面图的着色函数处理，使总览与平面图表现一致。
	 */
	private ensureWalls(s: FloorCardSource): void {
		if (!s.maskUrl || s.maskWidth <= 0 || s.maskHeight <= 0) {
			this.wallCanvases.delete(s.id);
			return;
		}
		const signature = this.wallSignature(s);
		if (this.wallCanvases.get(s.id)?.signature === signature) return;
		if (this.wallJobs.get(s.id) === signature) return;
		const maskImg = this.images.get(s.maskUrl);
		const materialImg = s.materialUrl ? this.images.get(s.materialUrl) : null;
		if (!maskImg) return;

		this.wallJobs.set(s.id, signature);
		void Promise.all([whenDecoded(maskImg), materialImg ? whenDecoded(materialImg) : null]).then(
			() => {
				this.wallJobs.delete(s.id);
				// 已有更新的签名（用户绘制了其他材质）占用该位置。
				if (this.wallSignature(s) !== signature) return;
				const mask = readRaster(maskImg, s.maskWidth, s.maskHeight);
				const materials = materialImg ? readRaster(materialImg, s.maskWidth, s.maskHeight) : null;
				this.wallCanvases.set(s.id, {
					signature,
					canvas: colorizeWalls(
						mask,
						s.maskWidth,
						s.maskHeight,
						materials,
						s.defaultMaterial as WallMaterialId
					)
				});
				this.onLoad?.();
			}
		);
	}

	/** 加载需要的内容，丢弃不再需要的。 */
	sync(sources: FloorCardSource[]): void {
		const wanted = new Set<string>();
		const liveFloors = new Set<string>();
		for (const s of sources) {
			liveFloors.add(s.id);
			for (const url of [s.planUrl, s.maskUrl, s.materialUrl]) {
				if (!url) continue;
				wanted.add(url);
				if (this.images.has(url)) continue;
				const img = new Image();
				img.onload = () => this.onLoad?.();
				img.src = url;
				this.images.set(url, img);
			}
			// 材质图以图像形式加载以读取像素，使着色墙体复用平面图读取的同一位图。
			this.ensureWalls(s);
		}
		for (const url of [...this.images.keys()]) {
			if (!wanted.has(url)) this.images.delete(url);
		}
		for (const id of [...this.heatmaps.keys()]) {
			if (!liveFloors.has(id)) this.heatmaps.delete(id);
		}
		for (const id of [...this.wallCanvases.keys()]) {
			if (!liveFloors.has(id)) this.wallCanvases.delete(id);
		}
	}

	/**
	 * 该楼层自身的内容框，世界单位；有掩码时取掩码范围。
	 * 两个视图都需要它：布局给每张卡片一个格子，内容按此框而非格子裁剪，避免覆盖图溢出到格子的空白边距。
	 */
	contentBox(s: FloorCardSource, sheetWupm = s.wupm): CardBox {
		const k = s.wupm > 0 ? sheetWupm / s.wupm : 1;
		const scaled = (box: CardBox): CardBox => ({
			minX: box.minX * k,
			minY: box.minY * k,
			w: box.w * k,
			h: box.h * k
		});
		if (s.planningArea && s.planningArea.length >= 3) {
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const point of s.planningArea) {
				minX = Math.min(minX, point.x);
				minY = Math.min(minY, point.y);
				maxX = Math.max(maxX, point.x);
				maxY = Math.max(maxY, point.y);
			}
			return scaled({ minX, minY, w: maxX - minX, h: maxY - minY });
		}
		if (s.maskUrl && s.maskWidth > 0 && s.maskHeight > 0) {
			return scaled({
				minX: s.maskOriginX,
				minY: s.maskOriginY,
				w: s.maskWidth,
				h: s.maskHeight
			});
		}
		const plan = s.planUrl ? this.images.get(s.planUrl) : null;
		if (plan?.complete && plan.naturalWidth > 0) {
			return scaled({
				minX: s.planOffsetX,
				minY: s.planOffsetY,
				w: CARD_PLAN_WIDTH,
				h: (plan.naturalHeight / plan.naturalWidth) * CARD_PLAN_WIDTH
			});
		}
		if (s.planUrl) {
			return scaled({ minX: s.planOffsetX, minY: s.planOffsetY, w: EMPTY_W, h: EMPTY_H });
		}
		return scaled({ minX: 0, minY: 0, w: EMPTY_W, h: EMPTY_H });
	}

	/**
	 * 在当前变换下绘制一个楼层的内容。
	 * 调用方已完成裁剪与定位，并负责边框、标签和深度装饰，此处只画楼层自身的绘制内容。
	 */
	draw(ctx: CanvasRenderingContext2D, src: FloorCardSource, opts: CardContentOptions): void {
		const k = src.wupm > 0 ? opts.wupm / src.wupm : 1;
		ctx.save();
		// 楼层按自身单位绘制，而底图使用参考楼层的单位。
		ctx.scale(k, k);
		const plan = src.planUrl ? this.images.get(src.planUrl) : null;
		if (opts.showPlan && plan?.complete && plan.naturalWidth > 0) {
			ctx.globalAlpha = opts.planOpacity;
			if (src.maskUrl && src.maskWidth > 0 && src.maskHeight > 0) {
				/*
				 * 有墙体掩码时，平面图和掩码是同一张图纸。总览必须把平面图铺到
				 * 掩码框上，而不是用单独的 800 单位框；否则带 floorplanOffset 的
				 * 楼层在单层视图里对齐，到了平铺视图却会错位。
				 */
				ctx.drawImage(
					plan,
					src.maskOriginX,
					src.maskOriginY,
					src.maskWidth,
					src.maskHeight
				);
			} else {
				const h = (plan.naturalHeight / plan.naturalWidth) * CARD_PLAN_WIDTH;
				ctx.drawImage(plan, src.planOffsetX, src.planOffsetY, CARD_PLAN_WIDTH, h);
			}
		}

		// 每个楼层的覆盖情况，用于跨楼层比较 AP 覆盖薄弱之处。
		const hm = opts.showHeatmap ? this.heatmaps.get(src.id) : undefined;
		if (hm) {
			ctx.globalAlpha = 1;
			ctx.drawImage(
				hm.canvas,
				hm.x0,
				hm.y0,
				hm.canvas.width * hm.texel,
				hm.canvas.height * hm.texel
			);
		}

		if (opts.showWalls && src.maskUrl) {
			const coloured = this.wallCanvases.get(src.id)?.canvas;
			ctx.globalAlpha = 0.5;
			if (coloured) {
				// 平面图自身的着色，参见 `colorizeWalls`；两张栅格解码期间回退为原始掩码。
				ctx.drawImage(coloured, src.maskOriginX, src.maskOriginY);
			} else {
				const maskImg = this.images.get(src.maskUrl);
				if (maskImg?.complete && maskImg.naturalWidth > 0) {
					ctx.drawImage(maskImg, src.maskOriginX, src.maskOriginY);
				}
			}
		}

		if (opts.showAPs) {
			ctx.globalAlpha = 1;
			// 标记是屏幕上尺寸恒定的标注，故除掉卡片自身的缩放，使更精细的平面图不会得到更大的点。
			const dotR = 4 / (opts.zoom * Math.max(0.0001, k));
			for (const ap of src.aps) {
				// 与平面图相同的颜色，参见 `apMarkerColor`，使总览与平面图配色一致。
				ctx.fillStyle = apMarkerColor({ assignedChannel: ap.assignedChannel ?? null, band: ap.band ?? '5ghz' });
				// 形状也相同：壁挂单元绘制为平面图上所用的面板。
				if (ap.mount === 'wall') {
					ctx.save();
					ctx.translate(ap.x, ap.y);
					ctx.rotate(((ap.facingDeg ?? 0) * Math.PI) / 180);
					ctx.beginPath();
					ctx.roundRect(-dotR, -dotR * 2.2, dotR * 2, dotR * 4.4, dotR * 0.6);
					ctx.fill();
					ctx.restore();
					continue;
				}
				ctx.beginPath();
				ctx.arc(ap.x, ap.y, dotR, 0, Math.PI * 2);
				ctx.fill();
			}
		}
		ctx.restore();
	}
}

/**
 * 把一张栅格的像素取成字节，取红色通道，使两种掩码约定读取方式一致。
 * 墙体掩码为透明底上的白色墙体，材质图在红色通道携带材质 id（`encodeMask`、`encodeMaterialMask`），
 * 与 `wall-detect.ts` 和 `region-labels.ts` 中解码器的读法相同，且复用已加载的图像。
 */
function readRaster(img: HTMLImageElement, width: number, height: number): Uint8Array {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(img, 0, 0, width, height);
	const data = ctx.getImageData(0, 0, width, height).data;
	const out = new Uint8Array(width * height);
	for (let i = 0; i < out.length; i++) out[i] = data[i * 4]!;
	return out;
}

/** 图像可解码时 resolve；已可解码则立即 resolve。 */
function whenDecoded(img: HTMLImageElement): Promise<void> {
	if (img.complete && img.naturalWidth > 0) return Promise.resolve();
	return new Promise((resolve) => {
		// 两种结果都会 resolve：加载失败的掩码仍会绘制原始轮廓。
		img.addEventListener('load', () => resolve(), { once: true });
		img.addEventListener('error', () => resolve(), { once: true });
	});
}
