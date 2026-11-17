/**
 * 为平面图挑选合适的检测器并返回其掩码。
 * 矢量检测器（`vector-detect.ts`）读取文件自身的对象并分类，可区分门与墙体；
 * 光栅检测器（`wall-detect.ts`）对像素取阈值并始终兜底，选择依据平面图的实际证据而非扩展名。
 */

import { prepareSvgForDetection } from './boundary-detect.js';
import { detectWalls, type WallMask } from './wall-detect.js';
import type { ElementRole } from './vector-elements.js';
import {
	detectVectorFloorplan,
	type ReviewableElement,
	type VectorDetectionSummary
} from './vector-detect.js';

/**
 * 像素检测器而非矢量读取器运行的原因。
 * 原因会显式上报，因为两种情形的后续处理不同：光栅平面图只能读像素，矢量平面图读不出则可能通过
 * 覆盖或手工修正解决。
 */
export type RasterReason =
	/** 文件不是矢量标记：PNG、JPEG 或截图。 */
	| 'not-vector'
	/** 是矢量标记，但读取器未在其中找到墙体形状。 */
	| 'no-walls-found'
	/** 是矢量标记，但读取器处理时抛出异常。 */
	| 'vector-failed'
	/** 用户手动强制走像素路径。 */
	| 'forced';

/** 哪个检测器产出了掩码，以及矢量检测器看到的内容。 */
export interface FloorplanDetection {
	/** 渲染后的图形，即边界检测所需的输入。 */
	image: HTMLImageElement;
	wallMask: WallMask | null;
	materialMask: WallMask | null;
	via: 'vector' | 'raster';
	/** 仅当 `via === 'vector'` 时存在。 */
	summary: VectorDetectionSummary | null;
	/** 仅当 `via === 'vector'` 时存在，含复核面板所需的全部内容。 */
	elements: ReviewableElement[] | null;
	/**
	 * 矢量读取成功时以几何形式给出的墙体。
	 * 它比追踪掩码更精确且包含斜墙，每条线段带有其角色对应的材质；为空或 null 时只能追踪掩码。
	 */
	segments:
		| Array<{ ax: number; ay: number; bx: number; by: number; material: number }>
		| null;
	/** 交给矢量读取器的标记文本，保留以便应用覆盖后重新读取。 */
	source: string | null;
	/** 仅当 `via === 'raster'` 时存在，说明读取器未运行的原因。 */
	rasterReason: RasterReason | null;
}

/**
 * 检测 `url` 所指平面图的掩码。
 * `targetWidth` 是两个检测器共同栅格化到的工作分辨率，使返回的掩码可互换；
 * `forceRaster` 跳过矢量读取器，`overrides` 携带读取器的逐元素修正。
 */
export async function detectFloorplanMasks(
	url: string,
	targetWidth: number,
	options: {
		forceRaster?: boolean;
		overrides?: ReadonlyMap<number, ElementRole>;
		/**
		 * 无论取回的字节内容如何，都认定该平面图是矢量图。
		 * 导入时内容嗅探可靠，重新检测时底图已是会话 blob URL，故由 `floorplanState.sourceIsVector` 记录原始类型；
		 * 判断有误时矢量读取器会抛出异常并回退到像素路径。
		 */
		assumeVector?: boolean;
	} = {}
): Promise<FloorplanDetection> {
	const markup = await fetchText(url);
	const isSvgMarkup =
		options.assumeVector ?? (markup.trim().startsWith('<') && markup.includes('<svg'));
	let reason: RasterReason = 'not-vector';
	if (isSvgMarkup) {
		reason = options.forceRaster ? 'forced' : 'no-walls-found';
	}

	if (isSvgMarkup && !options.forceRaster) {
		try {
			const vector = await detectVectorFloorplan(markup, targetWidth, options.overrides);
			if (vector) {
				return {
					// 边界检测沿用其惯用图像：按图形固有尺寸渲染并去除文字，而非矢量读取器自己的渲染。
					// `detectBoundary` 以 `naturalWidth` 推导工作比例，调用方再按 `targetWidth / naturalWidth`
					// 缩放多边形，故按目标宽度渲染会使多边形减半，去除填充也会丢失外轮廓。
					image: await prepareSvgForDetection(url),
					wallMask: vector.wallMask,
					materialMask: vector.materialMask,
					via: 'vector',
					summary: vector.summary,
					elements: vector.elements,
					segments: vector.segments,
					source: markup,
					rasterReason: null,
				};
			}
		} catch (e) {
			// 畸形或特殊的 SVG 回退到像素而不是让导入失败；用户仍能得到墙体，原因字段会说明属于哪种情况。
			reason = 'vector-failed';
			console.warn('[detect] vector detection failed, using pixels:', e);
		}
	}

	const image = await prepareSvgForDetection(url);
	/*
	 * 直接使用像素，前面不再有其他步骤。
	 * 遮蔽房间文字的工作已交由追踪器完成，它会丢弃过短而不可能是墙体的连续像素。
	 */
	const wallMask = await detectWalls(image, targetWidth);
	return {
		image,
		wallMask,
		materialMask: null,
		via: 'raster',
		summary: null,
		elements: null,
		segments: null,
		source: null,
		rasterReason: reason,
	};
}

/** 文件的文本；无法按文本读取时（PNG、失效的 blob URL）返回空字符串。 */
async function fetchText(url: string): Promise<string> {
	try {
		const response = await fetch(url);
		const type = response.headers.get('content-type') ?? '';
		// 声明为文本类型的栅格会解码出大量乱码；长度上限使被截断的读取代价可控。
		if (type.startsWith('image/') && !type.includes('svg')) return '';
		const text = await response.text();
		return text.length > 8_000_000 ? '' : text;
	} catch {
		return '';
	}
}
