/** Planning fallback for an AP that has no explicit client capacity. */
export const DEFAULT_CLIENTS_PER_AP = 25;

/**
 * 没有房间类型/密度数据时，按可通行面积估算并发终端的默认密度。
 * 房间类型数据存在时，覆盖率计算会优先使用逐房间密度。
 */
export const DEFAULT_DEVICE_DENSITY = 0.1;
