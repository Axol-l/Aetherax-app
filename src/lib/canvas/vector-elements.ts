/**
 * 将**矢量**户型图中的图元分类为墙体、门窗洞口和其他类型，不做任何像素阈值处理。
 * 分类依据依次为名称、绘制样式和相对几何，无法判断时返回 `unknown`；分类逻辑集中在
 * 纯函数 `classifyVectorElements` 中，`describeSvgElements` 只是浏览器端适配器。
 */

export type ElementRole =
	| 'wall'
	/** 墙体中的玻璃：保留墙体拓扑，使用玻璃材质。 */
	| 'window'
	/** 门扇或开启弧线：按墙体参与拓扑，使用低损耗材质。 */
	| 'door'
	/** 文字标注和尺寸标注：不构成屏障，予以丢弃。 */
	| 'text'
	/** 洁具、家具和电器：予以丢弃。 */
	| 'fixture'
	/** 未能明确匹配任何类别；由调用方决定，丢弃最安全。 */
	| 'unknown';

/** 分类器允许读取的全部信息，不涉及 DOM 或画布。 */
export interface VectorElementFacts {
	tag: string;
	/**
	 * 图元携带的全部名称，转为小写并用空格连接，包括类名、id 和非标准 label 属性。
	 * 这是信息量最大的输入：文件若为墙体命名，就无须依赖启发式规则。
	 */
	name: string;
	strokeWidth: number;
	hasStroke: boolean;
	hasFill: boolean;
	/** 计算后的 `stroke` 值，或 `none`。 */
	stroke: string;
	/** 计算后的 `fill` 值，或 `none`。 */
	fill: string;
	/** 路径长度，单位为用户单位，来自 `getTotalLength()`；不可用时为 0。 */
	length: number;
	/** 用户单位下的包围盒；`getBBox()` 使用局部坐标，因此未经变换。 */
	x: number;
	y: number;
	/** 用户单位下轴对齐的范围。 */
	width: number;
	height: number;
	/** 是否存在弧或贝塞尔曲线；门扇开启弧是常见原因。 */
	curved: boolean;
	/**
	 * 曲线实际描绘的弧，由采样测得；无法测量时为 null。
	 * 闭合曲线也会返回结果，其中 `chord` 为 0。
	 */
	arc: ArcMeasurement | null;
	/** 子路径数量，即 `M` 命令数量；文字通常由许多细小闭合子路径组成。 */
	subpaths: number;
}

/**
 * 描边曲线实际构成的弧：两端间距、凸起量及凸起对应的圆。
 * `chord` 最关键：门扇开启弧是两端落在门窗洞口两侧边框上的开放曲线；
 * 两端重合的曲线为闭环，不能判定为门。
 */
export interface ArcMeasurement {
	/** 两端之间的距离；闭合曲线为 0。 */
	chord: number;
	/** 凸起量对应的圆半径；无凸起时为 null。 */
	radius: number | null;
	/** 曲线覆盖圆的角度，单位为度；无半径时为 null。 */
	sweep: number | null;
	/** 曲线相对弦换边，即 S 形而非圆弧。 */
	sShaped: boolean;
}

export interface ClassifiedElement extends VectorElementFacts {
	role: ElementRole;
	/** 决定该角色的规则，供复核界面和测试使用。 */
	reason: string;
}

/**
 * 相邻描边宽度类别之间需要达到的最小比值；最大间隔低于此值时，宽度不作为分类依据。
 * 户型图的描边宽度通常取自少数几个值，只有最宽间隔才能区分墙体。
 */
const WIDTH_SPREAD_MIN = 1.5;

/** 填充图元达到此长宽比才可能是薄墙色块（poché），而非房间。 */
const POCHÉ_ASPECT = 6;

/**
 * 填充图元要成为墙体，其面积占图纸面积的最小比例。
 * 用于区分墙体填充块与房间填充；文字轮廓的面积占比更小，会被一并排除。
 */
const POCHÉ_MIN_AREA_SHARE = 0.005;

/**
 * 填充图元仍算墙体颜色时，其最亮通道的上限。
 * 墙体填充在每个通道都偏暗，房间颜色通常有较亮的通道，因此用最亮通道区分。
 */
const POCHÉ_MAX_CHANNEL = 160;

/**
 * 判断细曲线是否为门扇开启弧，是则返回原因，否则返回 null。
 * 要求曲线开放、单侧凸起、覆盖角度在允许范围内，且半径相对图纸不过大；
 * 不符合时返回 null，调用方将其保留为 unknown。
 */
function swingArcOf(fact: VectorElementFacts, planArea: number): string | null {
	const arc = fact.arc;
	if (!arc) return null;
	if (arc.chord <= 0) return null;
	if (arc.sShaped) return null;
	if (arc.sweep === null || arc.radius === null) return null;
	if (arc.sweep < SWING_MIN_SWEEP || arc.sweep > SWING_MAX_SWEEP) return null;

	// 以图纸面积为基准，因此不受单位影响：图纸宽度取面积的平方根，
	// 门扇半径只占其中很小一部分。
	const radiusShareOfPlan = planArea > 0 ? arc.radius / Math.sqrt(planArea) : 0;
	if (radiusShareOfPlan > SWING_MAX_RADIUS_SHARE) return null;

	return `swing arc (${arc.sweep.toFixed(0)}° of r=${arc.radius.toFixed(0)})`;
}

/**
 * 门扇开启弧允许覆盖的角度范围。
 * 小于 40° 的曲线过平，可能是标注引线或微弯墙体；大于 135° 则接近闭环。
 */
const SWING_MIN_SWEEP = 40;
const SWING_MAX_SWEEP = 135;

/**
 * 门扇开启弧半径相对图纸宽度的最大占比。
 * 门扇半径通常只占建筑宽度的百分之几，超过此比例的多为结构曲线而非门扇。
 */
const SWING_MAX_RADIUS_SHARE = 0.25;

/**
 * 填充图元仍可视为墙体色块时允许的最大子路径数。
 * 墙体填充块通常由一个矩形或简单轮廓构成；文字则是一个填充路径包含多个字母轮廓。
 */
const POCHÉ_MAX_SUBPATHS = 6;

/**
 * 用于比较的颜色值，规范化为 `r,g,b` 形式；无法解析时返回 null。
 */
function colourKey(value: string | undefined): string | null {
	if (!value) return null;
	const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
	if (!m) return null;
	return `${m[1]},${m[2]},${m[3]}`;
}

/** 颜色的最亮通道值；无法解析为 `rgb()` 或 `rgba()` 时返回 null。 */
function brightestChannel(value: string | undefined): number | null {
	const key = colourKey(value);
	if (!key) return null;
	return Math.max(...key.split(',').map(Number));
}

/**
 * 两条平行细线的间距小于自身描边宽度的该倍数时，视为一扇窗而非两道墙。
 * 该值是无单位系数，用作窗对检测的间距上限。
 */
const WINDOW_PAIR_GAP = 8;

/** 名称片段规则，按顺序检查，首个匹配生效，因此门窗洞口优先于墙体。 */
const NAME_RULES: ReadonlyArray<{ role: ElementRole; match: RegExp }> = [
	// 先判断门窗洞口，确保同时含墙体字样的名称仍按洞口处理。
	{ role: 'door', match: /(^|[\s_-])(door|doors|doorway|opening|gate|entry)([\s_-]|$)/ },
	{ role: 'window', match: /(^|[\s_-])(window|windows|glaz|glass|wind)([\s_-]|$)/ },
	{
		role: 'text',
		match:
			/(^|[\s_-])(text|label|labels|dim|dims|dimension|dimensions|annotation|roomname|title|name)([\s_-]|$)/
	},
	{
		role: 'fixture',
		match:
			/(^|[\s_-])(fixture|fixtures|furniture|desk|desks|chair|chairs|table|tables|sanitary|toilet|sink|basin|bath|shower|appliance|equipment|stair|stairs|staircase)([\s_-]|$)/
	},
	{
		role: 'wall',
		match: /(^|[\s_-])(wall|walls|iwall|iwalls|partition|partitions|muro|wand)([\s_-]|$)/
	}
];

/** 名称所声明的角色；没有片段匹配时返回 null。 */
export function roleFromName(name: string): { role: ElementRole; reason: string } | null {
	for (const rule of NAME_RULES) {
		if (rule.match.test(name)) {
			return { role: rule.role, reason: `named "${name.trim()}"` };
		}
	}
	return null;
}

/**
 * 为每个图元分配角色。
 * 名称优先于几何，因为名称是绘图者的明确声明；几何阶段中，描边线条可为墙体、窗或门，
 * 填充区域按薄长、颜色和面积判断是否为墙体色块，其余归为固定设施。
 */
export function classifyVectorElements(
	facts: VectorElementFacts[],
	context: { planArea?: number } = {}
): ClassifiedElement[] {
	const planArea = context.planArea ?? 0;
	const stroked = facts.filter((f) => f.hasStroke && f.strokeWidth > 0);
	const thickAt = wallWidthThreshold(stroked);

	// 窗由成对图元构成，无法逐个图元单独判定。
	const paired = findWindowPairs(facts, thickAt);

	// 第一遍：处理所有能独立判定角色的图元。纯填充留到第二遍，
	// 因为需要知道本图的墙体颜色。
	const prelim = facts.map((fact, index): { role: ElementRole; reason: string } | null => {
		const named = roleFromName(fact.name);
		if (named) return named;

		if (!fact.hasStroke && fact.hasFill) return null;

		if (paired.has(index)) {
			return { role: 'window', reason: 'parallel twin of a thin line' };
		}

		if (fact.hasStroke) {
			if (fact.strokeWidth >= thickAt) {
				return { role: 'wall', reason: `stroke ${fact.strokeWidth} is above the width cut` };
			}
			// 未配对的细线：若形状符合，则为门扇开启弧。
			if (fact.curved && !fact.hasFill) {
				const swing = swingArcOf(fact, planArea);
				if (swing) return { role: 'door', reason: swing };
			}
			return { role: 'unknown', reason: `thin stroke ${fact.strokeWidth}` };
		}

		return { role: 'unknown', reason: 'nothing to classify' };
	});

	// 第二遍：处理纯填充。薄长的填充仅凭形状即可判为墙体色块；
	// 块状填充则需同时足够暗且足够大，分别排除房间和文字。详见 `POCHÉ_MIN_AREA_SHARE`。
	return facts.map((fact, index) => {
		const decided = prelim[index];
		if (decided) return { ...fact, ...decided };

		const aspect = thinAspect(fact);
		if (aspect >= POCHÉ_ASPECT) {
			return { ...fact, role: 'wall' as const, reason: `filled poché (${aspect.toFixed(0)}:1)` };
		}

		const area = fact.width * fact.height;
		const share = planArea > 0 ? area / planArea : 0;
		const brightest = brightestChannel(fact.fill);
		if (
			brightest !== null &&
			brightest < POCHÉ_MAX_CHANNEL &&
			fact.subpaths <= POCHÉ_MAX_SUBPATHS &&
			planArea > 0 &&
			area >= planArea * POCHÉ_MIN_AREA_SHARE
		) {
			return {
				...fact,
				role: 'wall' as const,
				reason: `dark filled block (${(share * 100).toFixed(1)} % of the plan)`
			};
		}

		return { ...fact, role: 'fixture' as const, reason: 'filled area, not wall-shaped' };
	});
}

/**
 * 描边达到或超过该宽度时判为墙体；描边宽度过于均匀而无法区分时返回 `Infinity`。
 * 阈值取描边宽度序列中相对间隔最大的位置，而非最宽值的固定比例。
 */
function wallWidthThreshold(stroked: VectorElementFacts[]): number {
	// 取不同宽度并按从宽到窄排序；计算样式带有浮点噪声，
	// 四舍五入到三位小数可避免把噪声当成间隔。
	const widths = [...new Set(stroked.map((f) => Math.round(f.strokeWidth * 1000) / 1000))].sort(
		(a, b) => b - a
	);
	if (widths.length < 2) return Infinity;

	let widestRatio = 0;
	let cut = Infinity;
	for (let i = 0; i < widths.length - 1; i++) {
		const hi = widths[i]!;
		const lo = widths[i + 1]!;
		if (lo <= 0) continue;
		const ratio = hi / lo;
		if (ratio > widestRatio) {
			widestRatio = ratio;
			cut = (hi + lo) / 2;
		}
	}

	// 没有值得切分的间隔：宽度不构成证据，交由后续规则处理。
	// 这类图纸的描边可能只有窗线。
	if (widestRatio < WIDTH_SPREAD_MIN) return Infinity;
	return cut;
}

/** 最长边与最短边之比；正方形为 1，退化线为 ∞。 */ function thinAspect(
	fact: VectorElementFacts
): number {
	const long = Math.max(fact.width, fact.height);
	const short = Math.min(fact.width, fact.height);
	if (short <= 0.01) return long > 0.01 ? Infinity : 1;
	return long / short;
}

/**
 * 返回具有**恰好一条**平行配对线的细描边图元索引，对应窗的双线画法。
 * 配对要求曲线不凸起，长度接近、方向相同、沿轴向重叠，横向间距在自身描边宽度的
 * 1 倍到 `WINDOW_PAIR_GAP` 倍之间；多于一条配对线的视为踏步或剖面线。
 */
function findWindowPairs(facts: VectorElementFacts[], wallWidth: number): Set<number> {
	const candidates = facts
		.map((fact, index) => ({ fact, index }))
		.filter(
			({ fact }) =>
				fact.hasStroke &&
				!fact.hasFill &&
				fact.strokeWidth > 0 &&
				// 按墙体宽度过滤：若图纸没有宽度分层，wallWidth 为 Infinity，
				// 此时所有描边线都参与配对，仅由配对测试决定。
				fact.strokeWidth < wallWidth &&
				fact.length > 0 &&
				// 排除有明显凸起的曲线，而不只是路径中含曲线命令。
				!(fact.arc && fact.arc.radius !== null)
		);

	const twins = new Map<number, number[]>();
	for (let i = 0; i < candidates.length; i++) {
		for (let j = i + 1; j < candidates.length; j++) {
			const a = candidates[i]!;
			const b = candidates[j]!;
			if (!isParallelTwin(a.fact, b.fact)) continue;
			(twins.get(a.index) ?? twins.set(a.index, []).get(a.index)!).push(b.index);
			(twins.get(b.index) ?? twins.set(b.index, []).get(b.index)!).push(a.index);
		}
	}

	const pairs = new Set<number>();
	for (const [index, partners] of twins) {
		if (partners.length === 1) pairs.add(index);
	}
	return pairs;
}

function isParallelTwin(a: VectorElementFacts, b: VectorElementFacts): boolean {
	// 长度接近。
	const long = Math.max(a.length, b.length);
	const short = Math.min(a.length, b.length);
	if (long <= 0 || short / long < 0.75) return false;

	// 判断走向；退化的跨度意味着图元沿另一轴成线。
	const horizontal = a.width >= a.height;
	if (horizontal !== b.width >= b.height) return false;

	// 沿走向需有重叠，避免共线线段被配对。
	const startA = horizontal ? a.x : a.y;
	const endA = startA + (horizontal ? a.width : a.height);
	const startB = horizontal ? b.x : b.y;
	const endB = startB + (horizontal ? b.width : b.height);
	const overlap = Math.min(endA, endB) - Math.max(startA, startB);
	if (overlap < Math.min(endA - startA, endB - startB) * 0.75) return false;

	// 测量横向间距，取图元自身线条之间的距离。
	const acrossA = horizontal ? a.y : a.x;
	const acrossB = horizontal ? b.y : b.x;
	const gap = Math.abs(acrossA - acrossB);
	const stroke = Math.min(a.strokeWidth, b.strokeWidth);
	return gap >= stroke && gap <= stroke * WINDOW_PAIR_GAP;
}

// ─── 浏览器适配器 ──────────────────────────────────────────────────────────

/**
 * 图纸自身的面积，单位与 `width`/`height` 相同。
 * 优先取 viewBox 的面积，无法取得时回退到 `getBBox()`；两者都是用户空间，
 * 不能使用渲染后的像素尺寸。
 */
export function planAreaOf(svg: SVGSVGElement): number {
	const box = svg.viewBox?.baseVal;
	if (box && box.width > 0 && box.height > 0) return box.width * box.height;
	try {
		const own = svg.getBBox();
		if (own.width > 0 && own.height > 0) return own.width * own.height;
	} catch {
		// 根节点游离时进入未知分支；调用方按“无法判断大小”处理，
		// 使色块保持未分类，而不是被误判为墙体。
	}
	return 0;
}

/**
 * 本模块处理的图元，按文档顺序返回。
 * 导出是为让调用方的列表索引与 `describeSvgElements` 结果对齐，任一侧多一个图元都会使后续角色错位；
 * `<defs>` 等容器内的图元不单独绘制，已排除。
 */
export function selectDrawableElements(svg: SVGSVGElement): SVGElement[] {
	const selector = 'path, line, rect, polygon, polyline, circle, ellipse';
	const deferred =
		'defs, clipPath, mask, marker, pattern, symbol, linearGradient, radialGradient, filter';
	return Array.from(svg.querySelectorAll<SVGElement>(selector)).filter(
		(el) => !el.closest(deferred)
	);
}

/**
 * 使用**计算样式**为 `svg` 下每个可绘制图元生成事实。
 * 采用计算样式而非属性值，是因为许多文件通过 `<style>` 块着色，属性读取会漏掉。
 */
export function describeSvgElements(svg: SVGSVGElement): VectorElementFacts[] {
	const out: VectorElementFacts[] = [];

	for (const el of selectDrawableElements(svg)) {
		const style = getComputedStyle(el);
		const stroke = style.stroke;
		const fill = style.fill;
		const hasStroke = !!stroke && stroke !== 'none' && style.strokeWidth !== '0px';
		const hasFill = !!fill && fill !== 'none';

		let length = 0;
		let x = 0;
		let y = 0;
		let width = 0;
		let height = 0;
		try {
			const geometry = el as SVGGeometryElement;
			if (typeof geometry.getTotalLength === 'function') length = geometry.getTotalLength();
			const box = geometry.getBBox();
			x = box.x;
			y = box.y;
			width = box.width;
			height = box.height;
		} catch {
			// 游离或尺寸为零的图元：几何值保持为 0，
			// 分类器会将其视为“无证据”，而不是一次测量。
		}

		const d = el.getAttribute('d') ?? '';
		out.push({
			tag: el.tagName.toLowerCase(),
			name: namesOf(el),
			strokeWidth: parseFloat(style.strokeWidth) || 0,
			hasStroke,
			hasFill,
			stroke,
			fill,
			length,
			x,
			y,
			width,
			height,
			curved:
				/[CcSsQqTtAa]/.test(d) ||
				el.tagName.toLowerCase() === 'circle' ||
				el.tagName.toLowerCase() === 'ellipse',
			arc: measureArc(el, d, hasFill),
			subpaths: d ? (d.match(/[Mm]/g) ?? []).length || 1 : 1
		});
	}

	return out;
}

/**
 * 通过采样 `getTotalLength`/`getPointAtLength` 测量描边曲线描绘的弧。
 * 只测量有描边、无填充的曲线；不是此类曲线或无法采样时返回 null。
 */
function measureArc(el: Element, d: string, hasFill: boolean): ArcMeasurement | null {
	const tag = el.tagName.toLowerCase();
	const isCurve = /[CcSsQqTtAa]/.test(d) || tag === 'circle' || tag === 'ellipse';
	if (!isCurve || hasFill) return null;
	const geometry = el as SVGGeometryElement;
	if (typeof geometry.getTotalLength !== 'function') return null;

	let total = 0;
	try {
		total = geometry.getTotalLength();
	} catch {
		return null;
	}
	if (!(total > 0)) return null;

	const SAMPLES = 32;
	const points: Array<[number, number]> = [];
	try {
		for (let i = 0; i <= SAMPLES; i++) {
			const p = geometry.getPointAtLength((total * i) / SAMPLES);
			points.push([p.x, p.y]);
		}
	} catch {
		return null;
	}

	const [ax, ay] = points[0]!;
	const [bx, by] = points[SAMPLES]!;
	const chord = Math.hypot(bx - ax, by - ay);
	if (chord < 1e-6) {
		// 两端重合：闭环而非弧线；无论由 `Z` 闭合还是曲线回到起点，
		// 都不能成为门扇开启弧。
		return { chord: 0, radius: null, sweep: null, sShaped: false };
	}

	// 相对弦的有符号垂直偏差，分别记录两侧最大值。
	let maxPositive = 0;
	let maxNegative = 0;
	for (const [px, py] of points) {
		const deviation = ((px - ax) * (by - ay) - (py - ay) * (bx - ax)) / chord;
		if (deviation > maxPositive) maxPositive = deviation;
		if (deviation < maxNegative) maxNegative = deviation;
	}
	const bulge = Math.max(maxPositive, -maxNegative);
	if (bulge < 1e-6) {
		// 看似直线：曲线命令实际画出了直线。
		return { chord, radius: null, sweep: null, sShaped: false };
	}

	// 矢高转半径，圆弧公式：r = s/2 + c^2 / (8s)。
	const radius = bulge / 2 + (chord * chord) / (8 * bulge);
	const sweep =
		radius >= chord / 2 ? (2 * Math.asin(Math.min(1, chord / (2 * radius))) * 180) / Math.PI : null;

	return {
		chord,
		radius,
		sweep,
		sShaped: maxPositive > bulge * 0.2 && maxNegative < -bulge * 0.2
	};
}

/** 类名、id 和所有 label 属性，转为小写并用空格连接。 */
function namesOf(el: Element): string {
	const parts: string[] = [];
	const cls = el.getAttribute('class');
	if (cls) parts.push(cls);
	const id = el.getAttribute('id');
	if (id) parts.push(id);
	for (const attr of ['inkscape:label', 'data-name', 'serif:master-page-name']) {
		const value = el.getAttribute(attr);
		if (value) parts.push(value);
	}
	return parts.join(' ').toLowerCase().replace(/[\s]+/g, ' ');
}
