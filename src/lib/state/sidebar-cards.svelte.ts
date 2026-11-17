/**
 * 侧栏卡片的展开/收起状态。
 *
 * Floorplan 与 APs 两个面板切换时会卸载另一侧的组件，卡片自己的 `$state` 会跟着丢掉；
 * 状态放在模块里，切走再回来时卡片保持原样。
 */
export const sidebarCards = $state({
	/** 平面图卡片。 */
	floorplan: false,
	/** 比例卡片。 */
	scale: false,
	/** 楼层属性卡片。 */
	properties: false,
	/** 规划范围卡片。 */
	planningArea: false,
	/** 墙体卡片。 */
	walls: false,
	/** 抬升面卡片。 */
	surfaces: false,
	/** 备注卡片。 */
	notes: false
});
