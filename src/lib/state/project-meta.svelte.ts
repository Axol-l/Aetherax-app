/**
 * 工程元数据：项目名、覆盖与干扰的规划参数、客户端高度，以及自定义墙体材质。
 */
import { setCoverageThresholdDbm, setPathLossScenario } from '../rf/propagation.js';
import { DEFAULT_SETTINGS } from './project-settings.js';

export const projectMeta = $state({
	name: 'Untitled Project',
	ispSpeed: 0 as number,
	targetThroughput: 25 as number,
	/*
	 * 规划参数一律从 `DEFAULT_SETTINGS` 取初值，别再在这里写第二份字面量：
	 * 两处默认值会各自漂移，新建工程的重置又会漏掉没抄到的字段。
	 */
	...DEFAULT_SETTINGS,
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

/**
 * 把规划参数写回默认值。
 *
 * 新建工程调用它，而不是逐个字段赋值：漏一个字段就是上一个工程的设置跟着进了新工程。
 * 传播模型和覆盖门限还各有一份模块级状态（`rf/propagation.ts`），必须一起同步，
 * 否则界面显示的是默认值、评分用的还是旧值。
 */
export function resetProjectSettings(): void {
	Object.assign(projectMeta, DEFAULT_SETTINGS);
	setCoverageThresholdDbm(DEFAULT_SETTINGS.coverageThresholdDbm);
	setPathLossScenario(DEFAULT_SETTINGS.pathLossScenario);
}
