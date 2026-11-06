import { currentFloor, type Floor } from './floor-state.svelte.js';

/**
 * 只属于本次会话的底图状态：记录上次导入的来路，不属于平面图数据本身。
 */
const session = $state({
	unitSystem: 'imperial' as 'imperial' | 'metric',
	/**
	 * 底图来自哪种文件
	 */
	sourceIsVector: false,
	/**
	 * 上次导入为什么没变成平面图，没有则为 null
	 */
	importNotice: null as string | null
});

/**
 * 当前楼层的底图
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
