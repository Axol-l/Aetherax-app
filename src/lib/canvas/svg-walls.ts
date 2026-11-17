/**
 * 直接从 SVG 读取墙体线段而不经过栅格化图像：读取几何是精确的，可保留斜墙且无需文字遮罩，
 * 角色由 `classifyVectorElements` 给出，窗和门保持各自角色并带上材质。
 * 坐标输出到渲染掩码所用的坐标系：用户单位减去内容框原点，再乘以渲染缩放，结果即掩码像素，也就是世界单位。
 */

export interface SvgSegment {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	/** 来源绘制元素的下标，供调用方回映射以便编辑。 */
	element: number;
}

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const multiply = (m: Matrix, n: Matrix): Matrix => [
	m[0] * n[0] + m[2] * n[1],
	m[1] * n[0] + m[3] * n[1],
	m[0] * n[2] + m[2] * n[3],
	m[1] * n[2] + m[3] * n[3],
	m[0] * n[4] + m[2] * n[5] + m[4],
	m[1] * n[4] + m[3] * n[5] + m[5]
];

const apply = (m: Matrix, x: number, y: number): { x: number; y: number } => ({
	x: m[0] * x + m[2] * y + m[4],
	y: m[1] * x + m[3] * y + m[5]
});

/**
 * 把 `transform` 属性解析为矩阵。
 * 仅支持 matrix、translate、scale、rotate、skewX 和 skewY，未知关键字会被跳过而不做猜测。
 */
export function parseTransform(value: string | null): Matrix {
	if (!value) return IDENTITY;
	let result = IDENTITY;
	const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
	for (const match of value.matchAll(pattern)) {
		const kind = match[1]!;
		const args = match[2]!
			.split(/[\s,]+/)
			.filter((part) => part.length > 0)
			.map(Number);
		if (args.some((n) => !Number.isFinite(n))) continue;
		let step: Matrix = IDENTITY;
		if (kind === 'matrix' && args.length >= 6) {
			step = [args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, args[5]!];
		} else if (kind === 'translate' && args.length >= 1) {
			step = [1, 0, 0, 1, args[0]!, args[1] ?? 0];
		} else if (kind === 'scale' && args.length >= 1) {
			step = [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0];
		} else if (kind === 'rotate' && args.length >= 1) {
			const radians = (args[0]! * Math.PI) / 180;
			const cos = Math.cos(radians);
			const sin = Math.sin(radians);
			const rotation: Matrix = [cos, sin, -sin, cos, 0, 0];
			if (args.length >= 3) {
				const cx = args[1]!;
				const cy = args[2]!;
				step = multiply(multiply([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy]);
			} else {
				step = rotation;
			}
		} else if (kind === 'skewX' && args.length >= 1) {
			step = [1, 0, Math.tan((args[0]! * Math.PI) / 180), 1, 0, 0];
		} else if (kind === 'skewY' && args.length >= 1) {
			step = [1, Math.tan((args[0]! * Math.PI) / 180), 0, 1, 0, 0];
		}
		result = multiply(result, step);
	}
	return result;
}

/**
 * 节点只要能响应 `getAttribute` 即为真，这也是本模块对元素的全部要求。
 * 采用结构化判断而非 `instanceof SVGElement`，使几何规则可以脱离浏览器测试。
 */
function isElementLike(node: unknown): node is SVGElement {
	return !!node && typeof (node as SVGElement).getAttribute === 'function';
}

/** 从元素自身坐标到 SVG 根用户坐标的变换。 */
function matrixOf(element: SVGElement, stop: SVGElement): Matrix {
	let result = IDENTITY;
	let node: Element | null = element;
	const chain: SVGElement[] = [];
	while (node && node !== stop) {
		if (isElementLike(node)) chain.unshift(node);
		node = node.parentElement;
	}
	for (const item of chain) result = multiply(result, parseTransform(item.getAttribute('transform')));
	return result;
}

/** 按顺序取出 `points`/`d` 属性中的数字。 */
const numbersIn = (value: string): number[] =>
	(value.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);

/**
 * 某个可绘制元素在其自身坐标下由哪些线段组成。
 * 圆、弧、贝塞尔曲线等非直线不产生线段；直线、矩形、折线以及由移动/直线/水平/垂直/闭合指令组成的路径精确读取。
 */
export function elementSegments(element: Element): Array<[number, number, number, number]> {
	const tag = element.tagName.toLowerCase();
	if (tag === 'line') {
		const x1 = Number(element.getAttribute('x1') ?? 0);
		const y1 = Number(element.getAttribute('y1') ?? 0);
		const x2 = Number(element.getAttribute('x2') ?? 0);
		const y2 = Number(element.getAttribute('y2') ?? 0);
		return [[x1, y1, x2, y2]];
	}
	if (tag === 'rect') {
		const x = Number(element.getAttribute('x') ?? 0);
		const y = Number(element.getAttribute('y') ?? 0);
		const w = Number(element.getAttribute('width') ?? 0);
		const h = Number(element.getAttribute('height') ?? 0);
		if (!(w > 0) || !(h > 0)) return [];
		return [
			[x, y, x + w, y],
			[x + w, y, x + w, y + h],
			[x + w, y + h, x, y + h],
			[x, y + h, x, y]
		];
	}
	if (tag === 'polyline' || tag === 'polygon') {
		const points = numbersIn(element.getAttribute('points') ?? '');
		const out: Array<[number, number, number, number]> = [];
		for (let i = 0; i + 3 < points.length; i += 2) {
			out.push([points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!]);
		}
		if (tag === 'polygon' && points.length >= 4) {
			out.push([
				points[points.length - 2]!,
				points[points.length - 1]!,
				points[0]!,
				points[1]!
			]);
		}
		return out;
	}
	if (tag === 'path') {
		const d = element.getAttribute('d') ?? '';
		// 仅处理直线指令：含曲线的路径不视为墙体。
		if (/[csqta]/i.test(d)) return [];
		return pathSegments(d);
	}
	return [];
}

/**
 * 由 M/L/H/V/Z 组成的路径线段，绝对或相对指令均可。
 * 相对指令按当前笔位累加，闭合子路径也作为一条边输出。
 */
export function pathSegments(d: string): Array<[number, number, number, number]> {
	const tokens = d.match(/[a-z][^a-z]*/gi) ?? [];
	const out: Array<[number, number, number, number]> = [];
	let x = 0;
	let y = 0;
	let startX = 0;
	let startY = 0;
	for (const token of tokens) {
		const command = token[0]!;
		const args = numbersIn(token.slice(1));
		const relative = command === command.toLowerCase();
		const upper = command.toUpperCase();
		if (upper === 'M' && args.length >= 2) {
			x = (relative ? x : 0) + args[0]!;
			y = (relative ? y : 0) + args[1]!;
			startX = x;
			startY = y;
			// moveto 之后多余的坐标对视为隐式 lineto。
			for (let i = 2; i + 1 < args.length; i += 2) {
				const nx = (relative ? x : 0) + args[i]!;
				const ny = (relative ? y : 0) + args[i + 1]!;
				out.push([x, y, nx, ny]);
				x = nx;
				y = ny;
			}
		} else if (upper === 'L' && args.length >= 2) {
			for (let i = 0; i + 1 < args.length; i += 2) {
				const nx = (relative ? x : 0) + args[i]!;
				const ny = (relative ? y : 0) + args[i + 1]!;
				out.push([x, y, nx, ny]);
				x = nx;
				y = ny;
			}
		} else if (upper === 'H' && args.length >= 1) {
			for (const value of args) {
				const nx = (relative ? x : 0) + value;
				out.push([x, y, nx, y]);
				x = nx;
			}
		} else if (upper === 'V' && args.length >= 1) {
			for (const value of args) {
				const ny = (relative ? y : 0) + value;
				out.push([x, y, x, ny]);
				y = ny;
			}
		} else if (upper === 'Z') {
			if (x !== startX || y !== startY) out.push([x, y, startX, startY]);
			x = startX;
			y = startY;
		}
	}
	return out;
}

export interface SvgGeometryOptions {
	/** 每个可绘制元素的角色，顺序与调用方的列表一致。 */
	roles: ReadonlyArray<string>;
	/** 哪些角色计为墙体；窗和门同样阻挡，并以各自的材质计入墙体。 */
	wantedRoles?: ReadonlyArray<string>;
	/** 栅格化阶段所用的内容框及其施加的缩放。 */
	contentBox: { x: number; y: number; width: number; height: number };
	scale: number;
	/** 短于该值（输出单位）的线段视为噪声。 */
	minLength?: number;
}

/**
 * 窗在图中是两条描边，在模型里只是一次材质变化。
 * `collapseOpenings` 把每对平行且重叠的描边合并为一条中心线；`mergeOpeningsIntoWalls`
 * 再在开口处切开墙体并赋予该片开口的材质，得到墙体→玻璃→墙体的一条线。
 */
export interface MaterialSegment {
	ax: number;
	ay: number;
	bx: number;
	by: number;
	material: number;
}

const lengthOf = (s: MaterialSegment): number => Math.hypot(s.bx - s.ax, s.by - s.ay);

function perpendicularDistance(
	point: { x: number; y: number },
	segment: MaterialSegment
): number {
	const dx = segment.bx - segment.ax;
	const dy = segment.by - segment.ay;
	const len = Math.hypot(dx, dy);
	if (len < 1e-9) return Math.hypot(point.x - segment.ax, point.y - segment.ay);
	return Math.abs((point.x - segment.ax) * dy - (point.y - segment.ay) * dx) / len;
}

/** 点沿线段方向的位置，单位为该线段自身的长度单位。 */
function projectionAlong(point: { x: number; y: number }, segment: MaterialSegment): number {
	const dx = segment.bx - segment.ax;
	const dy = segment.by - segment.ay;
	const len = Math.hypot(dx, dy);
	if (len < 1e-9) return 0;
	return ((point.x - segment.ax) * dx + (point.y - segment.ay) * dy) / len;
}

/**
 * 把属于同一开口的每对平行描边合并为一条中心线。
 * 方向平行且距离在 `tolerance`（输出单位）以内者视为同一块玻璃的两面；保留较长者并沿用其材质。
 */
export function collapseOpenings(
	openings: readonly MaterialSegment[],
	tolerance = 10
): MaterialSegment[] {
	const dropped = new Set<number>();
	for (let i = 0; i < openings.length; i++) {
		if (dropped.has(i)) continue;
		const a = openings[i]!;
		const lenA = lengthOf(a);
		if (lenA < 1e-6) continue;
		for (let j = i + 1; j < openings.length; j++) {
			if (dropped.has(j)) continue;
			const b = openings[j]!;
			const lenB = lengthOf(b);
			if (lenB < 1e-6) continue;
			// 是否平行：单位方向的叉积按长度缩放。
			const cross = Math.abs((a.bx - a.ax) * (b.by - b.ay) - (a.by - a.ay) * (b.bx - b.ax));
			if (cross / (lenA * lenB) > 0.05) continue;
			// 是否处于同一带内，并沿自身方向重叠。
			const near = Math.max(
				perpendicularDistance({ x: b.ax, y: b.ay }, a),
				perpendicularDistance({ x: b.bx, y: b.by }, a)
			);
			if (near > tolerance) continue;
			const t0 = projectionAlong({ x: b.ax, y: b.ay }, a);
			const t1 = projectionAlong({ x: b.bx, y: b.by }, a);
			const overlap = Math.min(lenA, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
			if (overlap < Math.min(lenA, lenB) * 0.5) continue;
			// 属于同一开口而非两个，丢弃较短者。
			dropped.add(lenB <= lenA ? j : i);
			if (lenB > lenA) break;
		}
	}
	return openings.filter((_, index) => !dropped.has(index));
}

/**
 * 在开口所在处切开墙体，并把该片赋予开口的材质。
 * 不落在任何墙体上的开口（独立玻璃）原样返回，以免丢失图中已有的几何。
 */
export function mergeOpeningsIntoWalls(
	walls: readonly MaterialSegment[],
	openings: readonly MaterialSegment[],
	tolerance = 10
): MaterialSegment[] {
	const result: MaterialSegment[] = [];
	const remaining = [...openings];

	for (const wall of walls) {
		const len = lengthOf(wall);
		if (len < 1e-6) {
			result.push(wall);
			continue;
		}
		const cuts: Array<{ from: number; to: number; material: number }> = [];
		for (let i = remaining.length - 1; i >= 0; i--) {
			const opening = remaining[i]!;
			const far = Math.max(
				perpendicularDistance({ x: opening.ax, y: opening.ay }, wall),
				perpendicularDistance({ x: opening.bx, y: opening.by }, wall)
			);
			if (far > tolerance) continue;
			const t0 = projectionAlong({ x: opening.ax, y: opening.ay }, wall);
			const t1 = projectionAlong({ x: opening.bx, y: opening.by }, wall);
			const from = Math.max(0, Math.min(t0, t1));
			const to = Math.min(len, Math.max(t0, t1));
			if (to - from < tolerance * 0.5) continue;
			cuts.push({ from, to, material: opening.material });
			remaining.splice(i, 1);
		}
		if (cuts.length === 0) {
			result.push(wall);
			continue;
		}
		cuts.sort((a, b) => a.from - b.from);
		let cursor = 0;
		for (const cut of cuts) {
			if (cut.from > cursor + 1) result.push(piece(wall, cursor, cut.from, wall.material));
			result.push(piece(wall, Math.max(cursor, cut.from), cut.to, cut.material));
			cursor = Math.max(cursor, cut.to);
		}
		if (cursor < len - 1) result.push(piece(wall, cursor, len, wall.material));
	}
	return [...result, ...remaining];
}

/** `wall` 上两个位置之间的子线段。 */
function piece(wall: MaterialSegment, from: number, to: number, material: number): MaterialSegment {
	const len = lengthOf(wall);
	const ratioFrom = len < 1e-9 ? 0 : from / len;
	const ratioTo = len < 1e-9 ? 0 : to / len;
	return {
		ax: wall.ax + (wall.bx - wall.ax) * ratioFrom,
		ay: wall.ay + (wall.by - wall.ay) * ratioFrom,
		bx: wall.ax + (wall.bx - wall.ax) * ratioTo,
		by: wall.ay + (wall.by - wall.ay) * ratioTo,
		material
	};
}

/**
 * 把 SVG 中所有墙体形状的元素输出为世界单位线段。
 * `roles[i]` 对应 `elements[i]`，返回值中的 `element` 即该下标，UI 可据此回映射到绘制对象。
 */
export function segmentsFromSvg(
	root: SVGElement,
	elements: ReadonlyArray<Element>,
	options: SvgGeometryOptions
): SvgSegment[] {
	const wanted = options.wantedRoles ?? ['wall', 'window', 'door'];
	const minLength = options.minLength ?? 2;
	const out: SvgSegment[] = [];
	const { contentBox, scale } = options;

	for (let index = 0; index < elements.length; index++) {
		const element = elements[index]!;
		if (!wanted.includes(options.roles[index] ?? 'unknown')) continue;
		const matrix = matrixOf(element as SVGElement, root);
		for (const [x1, y1, x2, y2] of elementSegments(element)) {
			const a = apply(matrix, x1, y1);
			const b = apply(matrix, x2, y2);
			// 转换到渲染坐标系：渲染时内容框原点位于 (0,0) 并已缩放。
			const ax = (a.x - contentBox.x) * scale;
			const ay = (a.y - contentBox.y) * scale;
			const bx = (b.x - contentBox.x) * scale;
			const by = (b.y - contentBox.y) * scale;
			if (Math.hypot(bx - ax, by - ay) < minLength) continue;
			out.push({ ax, ay, bx, by, element: index });
		}
	}
	return out;
}
