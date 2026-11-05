import { currentFloor, type Floor } from './floor-state.svelte.js';

/**
 * 只属于本次会话的底图状态：记录上次导入的来路，不属于平面图数据本身。
 */
const session = $state({
	unitSystem: 'imperial' as 'imperial' | 'metric',
	/**
	 * 底图来自哪种文件。
	 *
	 * 必须单独记，因为底图只是个会话级的 blob URL：等到跑“重新检测墙体”时，URL 里已经看不出
	 * 图纸是矢量还是照片，而这两种要用不同的检测器。导入平面图时设置，内置 SVG 样例由 `loadSample` 设置。
	 */
	sourceIsVector: false,
	/**
	 * 上次导入为什么没变成平面图，没有则为 null。
	 *
	 * 拖进来的是本应用读不了的格式时设置。以前两个拖放处理器都直接 `return`，什么也不说，
	 * 于是拖进一个 PDF（真实图纸最常见的格式）看起来就像应用坏了。
	 */
	importNotice: null as string | null
});

/**
 * 当前楼层的底图：读写都直接作用在楼层上。
 *
 * 和 `wall-state.ts` 是同一处改动：这四个字段以前是 `Floor` 的镜像，保存、恢复、切楼层、撤销、导入时
 * 要双向各拷一遍。改成每个字段一对 getter/setter 之后副本没了，也就不会出现切完楼层屏幕上还留着上一层底图的 bug。
 *
 * `unitSystem`、`sourceIsVector`、`importNotice` 留在这里，因为它们描述的是项目或会话，不是某个楼层。
 */
export const floorplanState = {
	get floorplanUrl(): string | null {
		return currentFloor().floorplanUrl;
	},
	set floorplanUrl(url: string | null) {
		currentFloor().floorplanUrl = url;
	},

	get floorplanScale(): number {
		return currentFloor().floorplanScale;
	},
	set floorplanScale(scale: number) {
		currentFloor().floorplanScale = scale;
	},

	get calibration(): Floor['calibration'] {
		return currentFloor().calibration;
	},
	set calibration(calibration: Floor['calibration']) {
		currentFloor().calibration = calibration;
	},

	get floorplanBoundary(): Floor['floorplanBoundary'] {
		return currentFloor().floorplanBoundary;
	},
	set floorplanBoundary(boundary: Floor['floorplanBoundary']) {
		currentFloor().floorplanBoundary = boundary;
	},

	get unitSystem(): 'imperial' | 'metric' {
		return session.unitSystem;
	},
	set unitSystem(system: 'imperial' | 'metric') {
		session.unitSystem = system;
	},

	get sourceIsVector(): boolean {
		return session.sourceIsVector;
	},
	set sourceIsVector(isVector: boolean) {
		session.sourceIsVector = isVector;
	},

	get importNotice(): string | null {
		return session.importNotice;
	},
	set importNotice(notice: string | null) {
		session.importNotice = notice;
	}
};
