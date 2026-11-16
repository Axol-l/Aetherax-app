/**
 * 工程级的规划参数，以及它们的默认值。
 *
 * 以前默认值散在三处：`projectMeta` 的初始值、`rf/propagation.ts` 的常量、
 * `NewProjectDialog` 里手抄的一份。新建工程只重置了手抄的那几个，于是上一个工程的
 * 覆盖率下限、传播环境会跟着进新工程。这里只留一份，初始化和重置都从这里取。
 */
import {
	COVERAGE_THRESHOLD_DBM,
	DEFAULT_COVERAGE_SOFTNESS_DB,
	DEFAULT_PATH_LOSS_SCENARIO,
	type PathLossScenario
} from '../rf/propagation.js';
import {
	DEFAULT_CAPACITY_ASSUMPTIONS,
	type CapacityProfile
} from '../rf/capacity-plan.js';

export interface ProjectSettings {
	/** 优化和手动放置是否允许 AP 落在楼层边界之外（边界取规划范围，没有就用识别出的内部）。 */
	allowOutsideRooms: boolean;
	/** 覆盖率判定门限，单位 dBm。 */
	coverageThresholdDbm: number;
	/** 假设客户端离地多高，单位米。 */
	clientHeight: number;
	/** 接收端线极化角：0° 垂直，90° 水平。 */
	receiverPolarizationAngleDeg: number;
	/** 同频干扰占比在放置目标里的权重。 */
	interferenceWeight: number;
	/**
	 * 采样点低于覆盖门限多少 dB 以内还算有收益。
	 *
	 * 它是目标函数的过渡带，不是用户可调的偏好；留在文档里是为了让测量工具能复现
	 * 旧的目标函数（见 `DEFAULT_COVERAGE_SOFTNESS_DB`）。
	 */
	coverageSoftnessDb: number;
	/** 优化器必须达到的最低覆盖率，百分比；0 表示不约束。 */
	coverageFloorPct: number;
	/** 距离项按 ITU-R P.1238 的哪种环境建模。 */
	pathLossScenario: PathLossScenario;
	/** 容量规划预设；自定义时以下四项可独立调整。 */
	capacityProfile: CapacityProfile;
	activityFactor: number;
	oneStreamShare: number;
	twoStreamShare: number;
	fourStreamShare: number;
	densityScale: number;
}

/**
 * 新建工程的规划参数。
 *
 * 影响评分或覆盖率的字段都在这里，方便 `resetProjectSettings` 一次写回；
 * 只影响显示的量（热力图下限之类）不该出现在这里——显示下限现在由覆盖门限推出。
 */
export const DEFAULT_SETTINGS: Readonly<ProjectSettings> = {
	allowOutsideRooms: false,
	coverageThresholdDbm: COVERAGE_THRESHOLD_DBM,
	clientHeight: 1.5,
	receiverPolarizationAngleDeg: 0,
	interferenceWeight: 0.2,
	coverageSoftnessDb: DEFAULT_COVERAGE_SOFTNESS_DB,
	coverageFloorPct: 0,
	pathLossScenario: DEFAULT_PATH_LOSS_SCENARIO,
	capacityProfile: DEFAULT_CAPACITY_ASSUMPTIONS.profile,
	activityFactor: DEFAULT_CAPACITY_ASSUMPTIONS.activityFactor,
	oneStreamShare: DEFAULT_CAPACITY_ASSUMPTIONS.oneStreamShare,
	twoStreamShare: DEFAULT_CAPACITY_ASSUMPTIONS.twoStreamShare,
	fourStreamShare: DEFAULT_CAPACITY_ASSUMPTIONS.fourStreamShare,
	densityScale: DEFAULT_CAPACITY_ASSUMPTIONS.densityScale
};
