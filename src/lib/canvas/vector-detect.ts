/**
 * 将已分类的矢量户型图转换为墙体掩膜和逐像素材质掩膜。
 * 墙体、窗和门都进入墙体掩膜以保持封闭拓扑，门窗洞口只改变材质，其他图元和文字被排除；
 * 栅格化按角色分三次进行，避免抗锯齿混色干扰判定。
 */

import { WALL_MATERIALS, type WallMaterialId } from '$lib/domain/materials.js';
import { fillParallelGaps } from './morphology.js';
import { segmentsFromSvg, collapseOpenings, mergeOpeningsIntoWalls } from './svg-walls.js';
import type { WallMaskData } from '$state/wall-state.svelte.js';
import {
	classifyVectorElements,
	describeSvgElements,
	planAreaOf,
	selectDrawableElements,
	type ClassifiedElement,
	type ElementRole
} from './vector-elements.js';
/** 窗使用的材质。 */
export const WINDOW_MATERIAL: WallMaterialId = 2; // 玻璃

/**
 * 窗的两条描边之间需要填充的间隙宽度，单位为掩膜像素。
 * 该间隙等于工作分辨率下的墙厚，取值过小会留下夹层，过大会把相邻窗合并。
 */
const WINDOW_FILL_RADIUS = 6;

/** 门使用的材质。 */
export const DOOR_MATERIAL: WallMaterialId = 7; // 门

/** 一次识别得到的结果，供侧栏的复核信息使用。 */
export interface VectorDetectionSummary {
	/** 进入墙体掩膜的图元数量，按角色统计。 */
	walls: number;
	windows: number;
	doors: number;
	/** 有意排除的图元：固定设施、文字和房间填充。 */
	ignored: number;
	/** 没有规则能归类的图元；不进入掩膜，但计数供用户查看。 */
	unknown: number;
	/** 可绘制图元总数，用作以上计数的分母。 */
	total: number;
}

export interface VectorDetection {
	wallMask: WallMaskData;
	/** 只发现墙体、没有窗或门可记录时为 null。 */
	materialMask: WallMaskData | null;
	summary: VectorDetectionSummary;
	/** 读取器检查过的所有图元，供复核面板使用。 */
	elements: ReviewableElement[];
	/**
	 * 以**几何**形式表示的墙体，来自图纸自身的图元。
	 * 坐标为掩膜坐标系（掩膜像素等于世界单位），每段带角色对应的材质；
	 * 图元全为曲线时为空，此时改用栅格描边。
	 */
	segments: Array<{
		ax: number;
		ay: number;
		bx: number;
		by: number;
		material: WallMaterialId;
	}>;
}

/**
 * 复核面板看到的单个图元。
 * 同时携带分类结果和依据，因为面板需要让用户理解并质疑分类；包围盒使用渲染像素，
 * 以便直接在图纸上高亮。
 */
export interface ReviewableElement {
	/** 图元在图纸中的顺序索引，同一来源内保持稳定。 */
	id: number;
	role: ElementRole;
	/** 决定该图元角色的规则。 */
	reason: string;
	/** 图元的标签名。 */
	tag: string;
	/** 文件赋予该图元的名称，可能为空；这是最强的证据。 */
	name: string;
	box: { x: number; y: number; w: number; h: number };
}

/** 属于墙体掩膜的角色及其填充材质。 */
const MASK_ROLES: ReadonlyArray<{ role: ElementRole; material: WallMaterialId | null }> = [
	{ role: 'wall', material: null },
	{ role: 'window', material: WINDOW_MATERIAL },
	{ role: 'door', material: DOOR_MATERIAL }
];

/**
 * 从每个角色各一张像素缓冲区合成两张掩膜；合成过程为纯函数，可在无画布环境下测试。
 * `defaultMaterial` 是未被洞口覆盖的墙体像素所用材质；门窗洞口与墙体重叠时洞口优先，
 * 但掩膜始终取并集，不挖出孔洞。
 */
export function composeRoleMasks(
	roleBuffers: ReadonlyArray<{ material: WallMaterialId | null; pixels: Uint8Array }>,
	defaultMaterial: WallMaterialId
): { wall: Uint8Array; material: Uint8Array } {
	const length = roleBuffers[0]?.pixels.length ?? 0;
	const wall = new Uint8Array(length);
	const material = new Uint8Array(length);
	material.fill(defaultMaterial);

	// 先处理带具体材质的角色：材质明确的角色覆盖材质为 null 的角色，
	// 这就是缓冲区分离后“洞口优先”的含义。
	const ordered = [...roleBuffers].sort(
		(a, b) => (a.material === null ? 1 : 0) - (b.material === null ? 1 : 0)
	);

	for (const { material: id, pixels } of ordered) {
		for (let i = 0; i < length; i++) {
			if (!pixels[i]) continue;
			wall[i] = 1;
			if (id !== null) material[i] = id;
		}
	}

	return { wall, material };
}

/**
 * 从标记文本识别矢量户型图，`overrides` 按图元索引覆盖分类结果。
 * 没有可绘制图元或没有墙体时返回 null，由调用方回退到栅格流程。
 */
export async function detectVectorFloorplan(
	svgText: string,
	targetWidth: number,
	overrides: ReadonlyMap<number, ElementRole> = new Map()
): Promise<VectorDetection | null> {
	const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
	const source = doc.querySelector('svg');
	if (!source) return null;

	// `<use>` 渲染出的几何不会被分类器看到：被引用的节点位于 `<defs>` 中，
	// `selectDrawableElements` 会跳过它们，而 `<use>` 本身又不是形状。
	// 因此先展开引用，使这些几何参与分类。
	expandUse(source);

	// 在文档中保留一个活动副本，因为 `getComputedStyle` 需要布局；
	// 这也是能处理通过 `<style>` 着色文件的原因。
	const host = document.createElement('div');
	host.style.cssText = 'position:absolute;left:-10000px;top:0;width:1px;height:1px;overflow:hidden';
	document.body.appendChild(host);

	try {
		host.appendChild(document.importNode(source, true));
		const svg = host.querySelector('svg')!;
		// 图纸自身的范围，单位为用户单位，并且只在这里计算一次。
		// 有 `viewBox` 时用它，否则退回到 `width`/`height`，再不行才用根节点包围盒；
		// 元素包围盒的缩放与 `renderRolePass` 的渲染都依赖它。
		const contentBox = contentBoxOf(svg);
		const scale = targetWidth / (contentBox.width || targetWidth);
		const width = targetWidth;
		const height = Math.max(1, Math.round((contentBox.height || targetWidth) * scale));

		// 共用同一次查询，确保 `roles[i]` 确实对应 `drawables[i]`。
		const drawables = selectDrawableElements(svg);
		// 图纸自身的面积，使“面积足够大才可能是墙”与比例无关；
		// 单位为用户单位，与事实中的包围盒一致，详见 `planAreaOf`。
		const classified = classifyVectorElements(describeSvgElements(svg), {
			planArea: planAreaOf(svg)
		});
		if (drawables.length === 0) return null;

		const roles = drawables.map((_, i) => overrides.get(i) ?? classified[i]?.role ?? 'unknown');
		// 用图纸的标记文本，让每个角色过程只保留自己的副本并删除其他角色；
		// 这样每次渲染只包含该角色的图元。
		const markup = new XMLSerializer().serializeToString(svg);

		const buffers: Array<{ material: WallMaterialId | null; pixels: Uint8Array }> = [];
		for (const { role, material } of MASK_ROLES) {
			const rendered = await renderRolePass(markup, role, roles, width, height, contentBox);
			const pixels = await alphaToBuffer(rendered, width, height);
			/*
			 * 窗是一条**带状区域**，图纸只描出它的两条边而不填充。
			 * `fillParallelGaps` 逐轴连接两条描边；门不做此处理，因为门扇和开启弧并非实体。
			 */
			const solid =
				role === 'window' ? fillParallelGaps(pixels, width, height, WINDOW_FILL_RADIUS) : pixels;
			buffers.push({ material, pixels: solid });
		}

		// 边界过程不在此渲染：`detectFloorplanMasks` 会以图纸的固有尺寸处理，
		// 因为 `detectBoundary` 从 `naturalWidth` 推导工作比例。

		const defaultMaterial = WALL_MATERIALS[0]!.id;
		const { wall, material } = composeRoleMasks(buffers, defaultMaterial);

		let wallPixels = 0;
		for (let i = 0; i < wall.length; i++) wallPixels += wall[i]!;
		// 没有墙体形状：交给栅格流程处理。
		if (wallPixels < 50) return null;

		// 摘要和复核列表描述实际生效的角色，包含用户覆盖。
		const effective: ClassifiedElement[] = classified.map((c, i) => ({
			...c,
			role: roles[i] ?? c.role
		}));

		const summary: VectorDetectionSummary = {
			walls: countRole(effective, 'wall'),
			windows: countRole(effective, 'window'),
			doors: countRole(effective, 'door'),
			ignored: countRole(effective, 'fixture') + countRole(effective, 'text'),
			unknown: countRole(effective, 'unknown'),
			total: effective.length
		};

		// 图元包围盒使用渲染像素，确保高亮落在图纸上。
		const elements: ReviewableElement[] = effective.map((c, i) => ({
			id: i,
			role: c.role,
			reason: c.reason,
			tag: c.tag,
			name: c.name,
			box: {
				x: Math.round(c.x * scale),
				y: Math.round(c.y * scale),
				w: Math.round(c.width * scale),
				h: Math.round(c.height * scale)
			}
		}));

		const materialMask = material.some((m) => m !== defaultMaterial)
			? {
					dataUrl: encodeMaterial(material, width, height),
					width,
					height,
					originX: 0,
					originY: 0
				}
			: null;

		/*
		 * 以几何形式表示墙体，而不仅是掩膜。
		 * `segmentsFromSvg` 读取图纸自身的线条，能保留斜线以及门窗洞口的材质；
		 * 这里能同时访问角色、内容框和渲染比例，因此在此构建并随掩膜一起返回。
		 */
		const segments = segmentsFromSvg(svg as unknown as SVGElement, drawables, {
			roles,
			contentBox,
			scale,
			minLength: 2
		}).map((segment) => {
			const role = roles[segment.element] ?? 'unknown';
			return {
				...segment,
				material:
					role === 'window' ? WINDOW_MATERIAL : role === 'door' ? DOOR_MATERIAL : defaultMaterial
			};
		});
		/*
		 * 目标是让一段线按墙体 → 玻璃 → 墙体的顺序衔接，而不是在完整墙体上覆盖两条玻璃线。
		 * 图纸把窗画成墙体长描边内部的两条平行线，直接读取会得到两段玻璃墙和背后不断的墙体；
		 * 这里先把洞口描边合并为一条中心线，再切入墙体，使该段获得洞口的材质。
		 */
		const wallRuns = segments.filter((segment) => segment.material === defaultMaterial);
		const openingRuns = collapseOpenings(
			segments.filter((segment) => segment.material !== defaultMaterial)
		);
		const merged = mergeOpeningsIntoWalls(wallRuns, openingRuns);

		return {
			wallMask: {
				dataUrl: encodeBinary(wall, width, height),
				width,
				height,
				originX: 0,
				originY: 0
			},
			materialMask,
			summary,
			elements,
			segments: merged.map((segment) => ({
				ax: segment.ax,
				ay: segment.ay,
				bx: segment.bx,
				by: segment.by,
				material: segment.material as WallMaterialId
			}))
		};
	} finally {
		host.remove();
	}
}

function countRole(classified: ClassifiedElement[], role: ElementRole): number {
	return classified.filter((c) => c.role === role).length;
}

/**
 * 将每个 `<use>` 就地替换为它引用内容的副本。
 * 被引用节点通常位于 `<defs>` 中，分类器会跳过它们，不展开就会漏掉通过 `<use>` 复用的几何；
 * `<symbol>` 因自带 `viewBox` 而保留原样，最多执行 4 轮以避免引用环。
 */
function expandUse(svg: SVGSVGElement): void {
	const SVG_NS = 'http://www.w3.org/2000/svg';
	for (let pass = 0; pass < 4; pass++) {
		let expanded = 0;
		for (const use of Array.from(svg.querySelectorAll('use'))) {
			const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
			if (!href.startsWith('#')) continue;
			let target: Element | null = null;
			try {
				target = svg.querySelector(href);
			} catch {
				// id 无法由 querySelector 表达，因而没有可解析的目标。
				continue;
			}
			if (!target || target.tagName.toLowerCase() === 'symbol') continue;

			const group = svg.ownerDocument.createElementNS(SVG_NS, 'g');
			const x = use.getAttribute('x') ?? '0';
			const y = use.getAttribute('y') ?? '0';
			const transform = use.getAttribute('transform');
			group.setAttribute('transform', `${transform ? `${transform} ` : ''}translate(${x},${y})`);
			for (const attr of Array.from(use.attributes)) {
				if (/^(x|y|href|xlink:href|transform|id)$/.test(attr.name)) continue;
				group.setAttribute(attr.name, attr.value);
			}
			group.appendChild(target.cloneNode(true));
			use.replaceWith(group);
			expanded++;
		}
		if (expanded === 0) return;
	}
}

/**
 * 图纸在用户单位下的范围，也是其几何所在的坐标空间。
 * 依次取 `viewBox`、`width`/`height`，最后才用根节点包围盒；
 * 视口是图纸被裁剪到的范围，包围盒不是，百分比宽度则忽略。
 */
function contentBoxOf(svg: SVGSVGElement): { x: number; y: number; width: number; height: number } {
	const box = svg.viewBox?.baseVal;
	if (box && box.width > 0 && box.height > 0) {
		return { x: box.x, y: box.y, width: box.width, height: box.height };
	}

	const widthAttr = svg.getAttribute('width') ?? '';
	const heightAttr = svg.getAttribute('height') ?? '';
	if (widthAttr && heightAttr && !widthAttr.includes('%') && !heightAttr.includes('%')) {
		// 使用 `baseVal.value` 而非属性文本，以便把带单位的长度解析为像素。
		const w = svg.width?.baseVal?.value ?? 0;
		const h = svg.height?.baseVal?.value ?? 0;
		if (w > 0 && h > 0) return { x: 0, y: 0, width: w, height: h };
	}

	try {
		const own = svg.getBBox();
		if (own.width > 0 && own.height > 0) {
			return { x: own.x, y: own.y, width: own.width, height: own.height };
		}
	} catch {
		// 节点游离或无法渲染：调用方退回目标宽度。
	}
	return { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * 从图纸标记文本中栅格化单个角色。
 * 从副本中**删除**不属于该角色的所有内容，包括分类器从未见到的文字和图像。
 */
async function renderRolePass(
	markup: string,
	role: ElementRole,
	roles: ElementRole[],
	width: number,
	height: number,
	contentBox: { x: number; y: number; width: number; height: number }
): Promise<HTMLImageElement> {
	const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
	const svg = doc.querySelector('svg');
	if (!svg) throw new Error('no svg in markup');

	for (const el of Array.from(svg.querySelectorAll('text, tspan, image, foreignObject'))) {
		el.remove();
	}

	const drawables = selectDrawableElements(svg);
	drawables.forEach((el, i) => {
		if ((roles[i] ?? 'unknown') !== role) el.remove();
	});

	// 副本是游离的，无法自行测量；尺寸由调用方从活动节点取得。
	// 否则 `width`/`height` 只会调整画布，不会缩放图纸，内容会落在角落且比例错误。
	if (!svg.getAttribute('viewBox') && contentBox.width > 0 && contentBox.height > 0) {
		svg.setAttribute(
			'viewBox',
			`${contentBox.x} ${contentBox.y} ${contentBox.width} ${contentBox.height}`
		);
	}
	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	const serialized = new XMLSerializer().serializeToString(svg);
	const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }));
	try {
		return await new Promise<HTMLImageElement>((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error('vector render failed'));
			img.src = url;
		});
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** 图像有墨迹处为 1，其余为 0，尺寸严格为 `width x height`。 */
async function alphaToBuffer(
	image: HTMLImageElement,
	width: number,
	height: number
): Promise<Uint8Array> {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(image, 0, 0, width, height);
	const data = ctx.getImageData(0, 0, width, height).data;
	const out = new Uint8Array(width * height);
	for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3]! > 128 ? 1 : 0;
	return out;
}

/** 将二值掩膜编码为白透明底的 PNG 数据 URL，供 `decodeMask` 读取。 */
function encodeBinary(mask: Uint8Array, w: number, h: number): string {
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(w, h);
	for (let i = 0; i < mask.length; i++) {
		if (!mask[i]) continue;
		const j = i * 4;
		img.data[j] = img.data[j + 1] = img.data[j + 2] = 255;
		img.data[j + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
	return canvas.toDataURL('image/png');
}

/**
 * 将材质编号编码为 PNG，编号写入红色通道。
 * 编码方式与 `region-labels.encodeMaterialMask` 相同，后者也是画笔写入的格式。
 */
function encodeMaterial(mask: Uint8Array, w: number, h: number): string {
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(w, h);
	for (let i = 0; i < mask.length; i++) {
		const j = i * 4;
		img.data[j] = mask[i]!;
		img.data[j + 1] = 0;
		img.data[j + 2] = 0;
		img.data[j + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
	return canvas.toDataURL('image/png');
}
