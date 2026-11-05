/**
 * 工程元数据：项目名、覆盖与干扰的规划参数、客户端高度，以及自定义墙体材质。
 *
 * 这些是整份工程共用的假设，改一处就会影响热力图、优化器和报告里的数字。
 */
import {
	DEFAULT_COVERAGE_SOFTNESS_DB,
	DEFAULT_PATH_LOSS_SCENARIO,
	type PathLossScenario
} from '../rf/propagation.js';

export const projectMeta = $state({
	name: 'Untitled Project',
	ispSpeed: 0 as number,
	targetThroughput: 25 as number,
	/**
	 * 放置优化器的策略。false（默认）时优化出来的 AP 只能落在识别出的室内；
	 * true 时可以放在平面图上的任何位置。
	 */
	allowOutsideRooms: false as boolean,
	/**
	 * 热力图着色的最低接收电平，单位 dBm。低于它的部分透明，所以它就是界面上的覆盖门限：
	 * 距离模型用的接收灵敏度是 −85 dBm，因此这和每台 AP 周围画的覆盖圈一致。
	 * 调高它会缩窄可见区域、提高对比度。
	 */
	// 和 rf/propagation.ts 里的 COVERAGE_THRESHOLD_DBM 保持一致，
	// 这样着色区域和报出的覆盖百分比说的是同一块地方。
	heatmapRssiFloor: -70 as number,
	/**
	 * 假设客户端离地多高，单位米。
	 *
	 * AP 按吸顶建模，所以这是每条跨层路径的另一端。它是整份工程共用的假设，不按楼层设，
	 * 因为它描述的是客户端设备，不是楼。
	 *
	 * 这个高度只以距离项的形式进模型，所以是很小的修正：改 1 米，跨层电平大约动 1 dB。
	 * 真正在乎它的只有吸顶安装的那些情况。
	 */
	clientHeight: 1.5 as number,
	/**
	 * 同频干扰占比在放置目标里的权重：
	 * `score = coverageUtility − interferenceWeight · interferenceShare`。
	 *
	 * 两项都归一到 0-1。设 0 就退回加这一项之前的纯覆盖目标，所以它是衡量这一项值多少的
	 * A/B 开关——也是它做成工程设置而不是常量的原因：这是一条帕累托曲线，不是一个工作点。
	 *
	 * 默认值和 rf/interference.ts 的 `DEFAULT_INTERFERENCE_WEIGHT` 一致（IJEAT 的综合惩罚系数）。
	 */
	interferenceWeight: 0.2 as number,
	/**
	 * 采样点低于覆盖门限多少 dB 以内还算有收益。
	 *
	 * 以前优化器把门限当硬边界：刚出门限和远远不够的点都记 0 分，分不出"差一点"和
	 * "完全没有"。在覆盖受限的楼层上，这会让两次重启之间差出 5.3 个百分点的真实覆盖，
	 * 而目标函数只差 0.9%（见 `docs/ROADMAP.md` F1 的第二次测量）。
	 *
	 * 设 0 就精确退回硬门限，这就是 A/B 开关。默认值同 rf/propagation.ts 的
	 * `DEFAULT_COVERAGE_SOFTNESS_DB`。它只改优化器的地形：报出的覆盖率照样按
	 * "门限以上的比例"算，不是收益之和。
	 */
	coverageSoftnessDb: DEFAULT_COVERAGE_SOFTNESS_DB as number,
	/**
	 * ε-约束（F3）：优化器必须达到的最低覆盖率，百分比；0 表示不约束。
	 *
	 * `score = coverageUtility − interferenceWeight · interference` 是加权和，
	 * 而加权和只能走覆盖/干扰前沿的**凸**段——F3 的扫描测出 λ 从 0 到 0.8 这段是凸的，
	 * 所以它不适合当默认工具。楼层把要求反过来讲（"这份方案至少覆盖 X%"），
	 * 才能走到非凸的那段，A1 的"每层至少 X%"也需要它。
	 *
	 * 实现成单边惩罚，达标时正好为 0，所以设回 0 就回到所有已有数字被测量时的目标。
	 */
	coverageFloorPct: 0 as number,
	/**
	 * 把覆盖下限应用到**每一层**，而不是只用在正在优化的那层。
	 *
	 * 关：`coverageFloorPct` 是对你点了"优化"的那层的要求——单层运行只能检查这个。
	 *
	 * 开：全楼运行把它当成对整栋的保证，即 A1 的"没有哪层低于 X%"。做法是多加一块：
	 * 交替循环照常跑，跑完最差那层还差，就单独拿它自己当 ε 再优化一次。
	 * A1 说加权和表达不了这个；这里能做，是因为一块只评一层，按层约束在分解后才还成立。
	 */
	coverageFloorEveryFloor: false as boolean,
	/**
	 * 距离项按 ITU-R P.1238 的哪种环境建模。
	 *
	 * 不是调参旋钮：表里的系数已经含了墙体的平均余量，而这个应用**还**对每次穿墙单独收费，
	 * 墙画全了再用高值就是重复计算（10 m 处 20 dB、20 m 处 26 dB，见
	 * `docs/PHYSICAL_MODELS.md` §A3a）。默认值是这一项存在之前所有已记录数字用的环境；
	 * 面板上会有一行提示该往哪边调。
	 *
	 * 改它会动关联距离、AP 半径、覆盖率和所有报出的数字，所以随工程保存、每次运行都打印。
	 */
	pathLossScenario: DEFAULT_PATH_LOSS_SCENARIO as PathLossScenario,
	/**
	 * 用户自己加的墙体材质：铅门、仓库货架、带数据手册数值的玻璃隔断。
	 * 随工程保存，因为材质属于这份方案怎么规划的，不是画图人的偏好。
	 */
	customMaterials: [] as Array<{
		id: number;
		name: string;
		dbPerCrossing: number;
		thicknessM: number;
		color: [number, number, number];
	}>
});
