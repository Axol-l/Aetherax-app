/**
 * 墙体状态：当前楼层的墙体掩膜、材质和标定数据，以及本次会话的检测记录。
 *
 * 掩膜这类数据存在楼层对象上，这里只是读写代理；会话状态不随工程保存。
 */
import type { WallMaterialId } from '$lib/domain/materials.js';
import type { RasterReason } from '$canvas/detect-floorplan.js';
import type { ElementRole } from '$canvas/vector-elements.js';
import type { ReviewableElement, VectorDetectionSummary } from '$canvas/vector-detect.js';
import { currentFloor, type Floor } from './floor-state.svelte.js';

export interface WallMaskData {
	dataUrl: string;
	width: number;
	height: number;
	originX: number;
	originY: number;
}

/**
 * 矢量检测器对当前平面图读出了什么，以及用户之后改了什么。
 *
 * 会话状态，不是工程状态：它描述的是某一次检测，从存储重新载入的平面图只剩掩膜、
 * 不记得是怎么来的。数量按**元素**算而不是像素——回答"门找到了吗"要的是这个数。
 *
 * 它连**源标记**一起存，因为用户改判要重新读图才能生效：分类器对某个元素的判定没法
 * 在它生成的掩膜里撤销，而被读成设备的元素根本不在掩膜里。标记是内存里的字符串，
 * 活到会话结束；它原来那个 blob URL 到那时可能已经被撤销了。
 */
export interface VectorReview {
	summary: VectorDetectionSummary;
	/** 读取器看过的每个元素，按图里的顺序。 */
	elements: ReviewableElement[];
	/** 用户改判的结果，按元素 id 索引。 */
	overrides: Map<number, ElementRole>;
	/** 原始图纸，就是交给读取器的那份。 */
	source: string;
	/** 掩膜光栅化时用的工作宽度。 */
	targetWidth: number;
}

/**
 * 只属于会话的墙体状态：这次检测读出了什么、怎么失败的。
 *
 * 这些都不属于某一层——从存储载入的平面图有掩膜，但不记得产生它的那次运行——
 * 所以它是 `wallState` 里唯一还自己存着的东西。
 */
const session = $state({
	vectorReview: null as VectorReview | null,
	/**
	 * 像素检测器为什么跑起来（跑了的话）。
	 *
	 * 侧边栏会显示它。靠阈值得到的掩膜和靠读图里对象得到的掩膜，是对同一份平面图的两种
	 * 不同说法，只有用户能判断哪个不对——但前提是有人告诉他现在看的是哪一种。
	 */
	rasterReason: null as RasterReason | null
});

/**
 * 当前楼层的墙体数据，读写都穿过楼层对象。
 *
 * 以前这里是五个 `Floor` 字段的第二份拷贝，靠手工同步：保存、恢复、切楼层、撤销、导入
 * 每个都要把 `wallState`/`floorplanState` 的九个字段双向拷一遍，漏一次就表现为拿到别层的
 * 掩膜。拷贝已经删掉——每个 getter 读当前楼层，每个 setter 写当前楼层——只剩一个主人，
 * 没有需要记得的同步。
 *
 * 走 getter 读仍然响应式：getter 在调用它的 effect 里读 `$state`，和直接读属性一样。
 * 写入是给 `floor.wallMask` 赋一个新对象，这也是 `mask-registry.ts` 对缓存键的要求。
 */
export const wallState = {
	get wallMask(): Floor['wallMask'] {
		return currentFloor().wallMask;
	},
	set wallMask(mask: Floor['wallMask']) {
		currentFloor().wallMask = mask;
	},

	get wallAttenuation(): number {
		return currentFloor().wallAttenuation;
	},
	set wallAttenuation(db: number) {
		currentFloor().wallAttenuation = db;
	},

	get wallMaterial(): WallMaterialId {
		return currentFloor().wallMaterial;
	},
	set wallMaterial(material: WallMaterialId) {
		currentFloor().wallMaterial = material;
	},

	get materialMask(): Floor['materialMask'] {
		return currentFloor().materialMask;
	},
	set materialMask(mask: Floor['materialMask']) {
		currentFloor().materialMask = mask;
	},

	get roomTypeMask(): Floor['roomTypeMask'] {
		return currentFloor().roomTypeMask;
	},
	set roomTypeMask(mask: Floor['roomTypeMask']) {
		currentFloor().roomTypeMask = mask;
	},

	get vectorReview(): VectorReview | null {
		return session.vectorReview;
	},
	set vectorReview(review: VectorReview | null) {
		session.vectorReview = review;
	},

	get rasterReason(): RasterReason | null {
		return session.rasterReason;
	},
	set rasterReason(reason: RasterReason | null) {
		session.rasterReason = reason;
	}
};
