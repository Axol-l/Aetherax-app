/**
 * 矢量识别的规则：按名称、绘制方式、相对邻近元素的宽度依次判定墙体、洞口或未知。
 * 断言覆盖各条规则，以及针对真实图纸暴露的问题所加的两处守卫。
 */
import { describe, expect, it } from 'vitest';
import {
	classifyVectorElements,
	roleFromName,
	type ArcMeasurement,
	type ElementRole,
	type VectorElementFacts
} from './vector-elements.js';

/** 单个元素，默认值取普通细线的属性。 */
function fact(overrides: Partial<VectorElementFacts> = {}): VectorElementFacts {
	return {
		tag: 'line',
		name: '',
		strokeWidth: 1,
		hasStroke: true,
		hasFill: false,
		stroke: 'rgb(26, 26, 26)',
		fill: 'none',
		length: 100,
		x: 0,
		y: 0,
		width: 100,
		height: 0,
		curved: false,
		arc: null,
		subpaths: 1,
		...overrides
	};
}

/** 门开启弧线的测量值：开放弧、单侧凸起，且半径与弦长匹配。 */
function swing(overrides: Partial<ArcMeasurement> = {}): ArcMeasurement {
	return { chord: 40, radius: 40, sweep: 60, sShaped: false, ...overrides };
}

/** 携带指定测量值的细描边曲线。 */
function curve(arc: ArcMeasurement | null, overrides: Partial<VectorElementFacts> = {}) {
	return fact({ curved: true, arc, width: 40, height: 40, length: 42, tag: 'path', ...overrides });
}

/** 填充区域，poché 与房间填充都属此类。 */
function filled(overrides: Partial<VectorElementFacts> = {}): VectorElementFacts {
	return fact({
		hasStroke: false,
		hasFill: true,
		stroke: 'none',
		fill: 'rgb(138, 121, 88)',
		...overrides
	});
}

/**
 * 一批事实对应的角色，并带上默认的平面面积。
 * 面积供相对图形而非像素的规则使用；默认取 0 会静默关闭这些规则。
 */
const SAMPLE_PLAN_AREA = 440 * 360;
const roles = (facts: VectorElementFacts[], planArea = SAMPLE_PLAN_AREA): ElementRole[] =>
	classifyVectorElements(facts, { planArea }).map((c) => c.role);

describe('naming', () => {
	it('reads the fragments a draughtsman writes', () => {
		expect(roleFromName('wall')?.role).toBe('wall');
		expect(roleFromName('iwall')?.role).toBe('wall');
		expect(roleFromName('door')?.role).toBe('door');
		expect(roleFromName('window')?.role).toBe('window');
		expect(roleFromName('glass')?.role).toBe('window');
		expect(roleFromName('desk')?.role).toBe('fixture');
		expect(roleFromName('label')?.role).toBe('text');
		expect(roleFromName('dim')?.role).toBe('text');
	});

	it('does not match a fragment inside a longer word', () => {
		// `windowsill` 不是窗，`wallpaper` 不是墙。
		expect(roleFromName('windowsill')).toBeNull();
		expect(roleFromName('wallpaper')).toBeNull();
	});

	it('prefers the opening when a name says both', () => {
		expect(roleFromName('door-wall')?.role).toBe('door');
		expect(roleFromName('wall window')?.role).toBe('window');
	});

	it('beats geometry, because a name is the draughtsman speaking', () => {
		// 1 px 描边按宽度永远不算墙，但名称优先。
		const classified = classifyVectorElements([
			fact({ name: 'wall', strokeWidth: 1 }),
			fact({ name: '', strokeWidth: 5 })
		]);
		expect(classified.map((c) => c.role)).toEqual(['wall', 'wall']);
		expect(classified[0]!.reason).toContain('named');
	});
});

describe('areas', () => {
	it('takes a long thin filled shape as poché', () => {
		expect(roles([fact({ hasStroke: false, hasFill: true, width: 200, height: 12 })])).toEqual([
			'wall'
		]);
	});

	it('drops a filled shape that is not wall-shaped', () => {
		// 房间：按本图比例尺约 4 m × 3 m。
		expect(roles([fact({ hasStroke: false, hasFill: true, width: 400, height: 300 })])).toEqual([
			'fixture'
		]);
	});
});

/**
 * 门开启弧线规则：要求开放曲线、合理的扫描角，以及与该图形相称的半径。
 */
describe('door swings', () => {
	it('takes an open arc of a plausible sweep', () => {
		expect(roles([curve(swing())])).toEqual(['door']);
	});

	it('takes a quarter circle, which is what a plan actually draws', () => {
		expect(roles([curve(swing({ sweep: 90, chord: 57, radius: 40 }))])).toEqual(['door']);
	});

	it('rejects a closed curve, which is what state-floor reported as a door', () => {
		// 首尾相接的闭合轮廓属于门廊，而不是开启弧线。
		expect(roles([curve(swing({ chord: 0, radius: null, sweep: null }))])).toEqual(['unknown']);
	});

	it('rejects a shallow curve and a nearly-closed one', () => {
		expect(roles([curve(swing({ sweep: 25 }))])).toEqual(['unknown']);
		expect(roles([curve(swing({ sweep: 170 }))])).toEqual(['unknown']);
	});

	it('rejects an S-curve however it measures', () => {
		expect(roles([curve(swing({ sShaped: true }))])).toEqual(['unknown']);
	});

	it('rejects a curve too large to be a door leaf', () => {
		// 弧形墙：形状相似，但半径接近整个建筑。
		expect(roles([curve(swing({ radius: 4000, chord: 4000, sweep: 90 }))])).toEqual(['unknown']);
	});

	it('rejects a curve with no measurement at all', () => {
		// `describeSvgElements` 无法遍历该元素；缺少证据不等于门的证据。
		expect(roles([curve(null)])).toEqual(['unknown']);
	});

	it('still prefers a name over the shape', () => {
		expect(roles([curve(swing({ sShaped: true }), { name: 'door' })])).toEqual(['door']);
	});

	it('is not stolen by the window test', () => {
		// 门可能画成弧线加直门扇：长度相同、相距几个描边宽度、沿走向重叠，
		// 满足窗配对测试的全部条件，因此需要曲线排除来避免误判。
		const arc = curve(swing(), { x: 0, y: 0, width: 40, height: 10, length: 42 });
		// 与弧线同描边宽度，使宽度筛选不会先于曲线排除决定结果。
		const leaf = fact({ x: 0, y: 5, width: 40, height: 0, length: 40 });
		const classified = classifyVectorElements([arc, leaf], { planArea: SAMPLE_PLAN_AREA });
		expect(classified[0]!.role, 'the arc is a swing').toBe('door');
		expect(classified[1]!.role, 'the leaf is not a window in its own right').not.toBe('window');

		// 对照：同样的两条线若没有测到凸起，就会被判为窗配对，
		// 说明上面的断言针对的是弧线而非几何形状。
		const flat = curve(null, { x: 0, y: 0, width: 40, height: 10, length: 42 });
		const control = classifyVectorElements([flat, leaf], { planArea: SAMPLE_PLAN_AREA });
		expect(control[0]!.role).toBe('window');
		expect(control[1]!.role).toBe('window');
	});
});

describe('poché built from blocks', () => {
	/**
	 * 一张含墙的图纸。
	 * 细线同样重要：宽度筛选需要两个宽度才能比较；仅有一条墙线的图纸里没有墙，
	 * 下面的测试确认此时仍能识别块状墙体。
	 */
	const wall = fact({ strokeWidth: 5, stroke: 'rgb(138, 121, 88)' });
	const detail = fact({ strokeWidth: 1, width: 40, height: 0, x: 0, y: 300 });
	const PLAN = 400_000;
	/** 第三个事实的角色，下面的辅助函数把填充形状放在该位置。 */
	const blockRole = (block: VectorElementFacts, planArea = PLAN) =>
		classifyVectorElements([wall, detail, block], { planArea })[2]!.role;

	it('takes a large dark block as wall', () => {
		// state-floor.svg：墙体是约 56 个填充块，没有细长形状。
		expect(blockRole(filled({ width: 100, height: 131 }))).toBe('wall');
	});

	it('leaves lettering alone even when it shares the wall colour', () => {
		// little-white-house.svg：房间标注是与墙同色的描边字母，每个元素一个字，
		// 尺寸是唯一可区分之处。
		const glyphs = Array.from({ length: 8 }, (_, i) =>
			filled({ width: 13, height: 47, x: i * 14 })
		);
		const classified = classifyVectorElements([wall, detail, ...glyphs], { planArea: PLAN });
		expect(classified.slice(2).every((c) => c.role === 'fixture')).toBe(true);
	});

	it('leaves a word-shaped path alone even when it is big enough to be a block', () => {
		// state-floor.svg：房间标注是一个填充路径，含整词的字形轮廓，其包围盒能通过
		// 尺寸测试，只能靠子路径数量识别。
		const word = filled({ width: 132, height: 30, subpaths: 17 });
		expect(blockRole(word)).toBe('fixture');
		// 同样的包围盒若为单一形状，则判为墙。
		expect(blockRole(filled({ width: 132, height: 30, subpaths: 1 }))).toBe('wall');
	});

	it('leaves a room fill alone however large it is, because it is not dark', () => {
		// 房间填充色至少有一个通道较亮，因此亮度按通道而非按整体亮度判断。
		for (const fill of ['rgb(255, 241, 218)', 'rgb(233, 86, 82)', 'rgb(71, 117, 209)']) {
			expect(blockRole(filled({ width: 244, height: 143, fill })), fill).toBe('fixture');
		}
	});

	it('judges size against the plan, not against pixels', () => {
		// 同样的块在小图纸上是结构，在大图纸上只有字级大小，
		// 区分的依据是它在平面图中所占的比例。
		const block = filled({ width: 100, height: 131 });
		expect(blockRole(block, 100_000)).toBe('wall');
		expect(blockRole(block, 40_000_000)).toBe('fixture');
	});

	it('recovers a block even when no wall stroke was identified at all', () => {
		// 整张图都用 poché 绘制时没有可比的墙色，该规则也不需要墙色。
		const classified = classifyVectorElements([filled({ width: 100, height: 131 })], {
			planArea: PLAN
		});
		expect(classified[0]!.role).toBe('wall');
	});

	it('needs a plan area to judge size against', () => {
		const classified = classifyVectorElements([wall, detail, filled({ width: 100, height: 131 })]);
		expect(classified[2]!.role).toBe('fixture');
	});
});

describe('windows are a pair, not a run', () => {
	const windowLine = (y: number) =>
		fact({ strokeWidth: 1.5, length: 80, x: 80, y, width: 80, height: 0 });

	it('pairs two parallel thin lines', () => {
		expect(roles([windowLine(18), windowLine(22)])).toEqual(['window', 'window']);
	});

	it('refuses a run of three, which is a staircase or hatching', () => {
		// state-floor.svg 的楼梯段：平行的踏步，任意两条都能通过配对测试。
		const treads = [0, 20, 40, 60].map((y) =>
			fact({ strokeWidth: 1, length: 60, x: 200, y, width: 60, height: 0 })
		);
		expect(roles(treads)).not.toContain('window');
	});

	it('ignores lines that are far apart', () => {
		expect(roles([windowLine(0), windowLine(60)])).not.toContain('window');
	});

	it('ignores lines of different lengths', () => {
		const short = fact({ strokeWidth: 1.5, length: 30, x: 80, y: 22, width: 30, height: 0 });
		expect(roles([windowLine(18), short])).not.toContain('window');
	});
});

describe('the width cluster', () => {
	it('takes the thick minority as walls and leaves the thin majority alone', () => {
		// apartment-48sqm.svg：外墙 5 px、隔墙 3.5 px、洞口 1.5 px、家具 1 px，
		// 只有墙和隔墙是粗线。
		const facts = [
			...Array.from({ length: 5 }, () => fact({ strokeWidth: 5 })),
			...Array.from({ length: 8 }, () => fact({ strokeWidth: 3.5 })),
			...Array.from({ length: 6 }, () => fact({ strokeWidth: 1.5 })),
			...Array.from({ length: 5 }, () => fact({ strokeWidth: 1 }))
		];
		const classified = classifyVectorElements(facts);
		expect(classified.filter((c) => c.role === 'wall')).toHaveLength(13);
	});

	it('does not promote the majority when the drawing has almost no width spread', () => {
		// little-white-house.svg：一条 2 px 路径构成整个墙体网络，五条 1 px 路径画细节；
		// 单纯按比例定阈值会把那五条也判成墙。
		const facts = [
			...Array.from({ length: 5 }, () => fact({ strokeWidth: 1 })),
			fact({ strokeWidth: 2, subpaths: 45, length: 3000 })
		];
		const classified = classifyVectorElements(facts);
		const walls = classified.filter((c) => c.role === 'wall');
		expect(walls).toHaveLength(1);
		expect(walls[0]!.strokeWidth).toBe(2);
	});

	it('leaves a file with no strokes at all without walls', () => {
		expect(roles([fact({ hasStroke: false, hasFill: true, width: 400, height: 300 })])).toEqual([
			'fixture'
		]);
	});
});

describe('doors', () => {
	it('does not call a curve a door on the curve alone', () => {
		// 无弧线测量值的细曲线判为 `unknown`，由复核面板询问；
		// 上面的弧线测试覆盖真正获得门角色的条件。
		expect(
			roles([fact({ curved: true, strokeWidth: 1.5, length: 63, width: 40, height: 40 })])
		).toEqual(['unknown']);
	});

	it('does not call a thick curve a door, because an arch is a wall', () => {
		// little-white-house.svg 的露台拱券。
		const facts = [
			fact({ curved: true, strokeWidth: 2, length: 400, width: 200, height: 160 }),
			fact({ strokeWidth: 1 })
		];
		expect(roles(facts)[0]).toBe('wall');
	});
});
