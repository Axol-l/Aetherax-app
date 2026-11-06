/**
 * 房间区域判定
 */
import { getEffectiveWupm, wupmForFloor } from './ap-state.svelte.js';

/**
 * 一个区域要算作房间，内切半径最小多少米。
 */
export const MIN_ROOM_RADIUS_M = 0.3;

/**
 * 同一个门限，换算成某一层标定下的掩码像素。
 */
export function minRoomRadiusWu(floorId?: string): number {
	return MIN_ROOM_RADIUS_M * (floorId ? wupmForFloor(floorId) : getEffectiveWupm());
}
