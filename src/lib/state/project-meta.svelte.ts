/**
 * 工程元数据：项目名、覆盖与干扰的规划参数、客户端高度，以及自定义墙体材质。
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
	 * 热力图着色的最低接收电平，单位 dBm。低于它的部分透明。
	 */
	heatmapRssiFloor: -70 as number,
	/**
	 * 覆盖率判定门限，单位 dBm。它与热力图的显示下限分开：热力图可以只显示强信号，
	 * 覆盖率仍然按这个设计门限统计。默认 −70 dBm。
	 */
	coverageThresholdDbm: -70 as number,
	/**
	 * 假设客户端离地多高，单位米。
	 */
	clientHeight: 1.5 as number,
	/** 接收端线极化角：0° 垂直，90° 水平。 */
	receiverPolarizationAngleDeg: 0 as number,
	/**
	 * 同频干扰占比在放置目标里的权重：
	 * `score = coverageUtility − interferenceWeight · interferenceShare`。
	 */
	interferenceWeight: 0.2 as number,
	/**
	 * 采样点低于覆盖门限多少 dB 以内还算有收益。
	 */
	coverageSoftnessDb: DEFAULT_COVERAGE_SOFTNESS_DB as number,
	/**
	 * 优化器必须达到的最低覆盖率，百分比；0 表示不约束。
	 */
	coverageFloorPct: 0 as number,
	/**
	 * 把覆盖下限应用到每一层，而不是只用在正在优化的那层。
	 */
	coverageFloorEveryFloor: false as boolean,
	/**
	 * 距离项按 ITU-R P.1238 的哪种环境建模。
	 */
	pathLossScenario: DEFAULT_PATH_LOSS_SCENARIO as PathLossScenario,
	/**
	 * 用户自己加的墙体材质
	 */
	customMaterials: [] as Array<{
		id: number;
		name: string;
		dbPerCrossing: number;
		thicknessM: number;
		color: [number, number, number];
	}>
});
