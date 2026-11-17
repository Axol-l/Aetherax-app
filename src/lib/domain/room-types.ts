/**
 * 房间类型定义与设备密度，供按容量加权的优化使用。
 * 密度是每平方米的并发 WiFi 设备数，默认值参考 Cisco、Aruba 设计指南与 IBC 表 1004.5。
 */

export type BuildingCategory =
	| 'commercial'
	| 'residential'
	| 'education'
	| 'healthcare'
	| 'hospitality'
	| 'industrial';

export interface RoomType {
	id: number;
	name: string;
	shortName: string; // 画布标签用的短名
	categories: BuildingCategory[]; // 该房间出现的建筑类型
	defaultDensity: number; // 每平方米设备数，可按房间覆盖
	color: [number, number, number]; // 画布着色用的 RGB，按 15% 透明度绘制
	/**
	 * 没有地板的区域：中庭、楼梯井、挑空大堂。
	 * 它在布点时不算建筑内部，`computeBuildingInterior` 的使用方会排除它。
	 */
	isVoid?: boolean;
}

/**
 * 房间类型表。id 0 表示未指定，不在表内。
 * 颜色按同一分类内的密度从冷到暖排列。
 */
export const ROOM_TYPES: readonly RoomType[] = [
	// ─── 默认 ─────────────────────────────────────────────────
	{
		id: 1,
		name: 'Custom',
		shortName: 'Custom',
		categories: [
			'commercial',
			'residential',
			'education',
			'healthcare',
			'hospitality',
			'industrial'
		],
		defaultDensity: 0.3,
		color: [150, 150, 155]
	},

	// ─── 低人流 ─────────────────────────────────────────────
	{
		id: 2,
		name: 'Hallway',
		shortName: 'Hall',
		categories: ['commercial', 'education', 'healthcare', 'hospitality'],
		defaultDensity: 0.1,
		color: [130, 140, 160]
	},
	{
		id: 3,
		name: 'Stairwell',
		shortName: 'Stair',
		categories: ['commercial', 'education', 'healthcare'],
		defaultDensity: 0.03,
		color: [115, 115, 125]
	},
	{
		id: 4,
		name: 'Storage',
		shortName: 'Store',
		categories: ['commercial', 'residential', 'industrial'],
		defaultDensity: 0.05,
		color: [120, 120, 130]
	},
	{
		id: 5,
		name: 'Restroom',
		shortName: 'WC',
		categories: ['commercial', 'education', 'healthcare', 'hospitality'],
		defaultDensity: 0.08,
		color: [125, 130, 145]
	},
	{
		id: 6,
		name: 'Elevator Lobby',
		shortName: 'Elev',
		categories: ['commercial', 'hospitality'],
		defaultDensity: 0.1,
		color: [125, 135, 150]
	},
	{
		id: 7,
		name: 'Warehouse',
		shortName: 'Whse',
		categories: ['commercial', 'industrial'],
		defaultDensity: 0.05,
		color: [115, 120, 130]
	},
	{
		id: 8,
		name: 'Server Room',
		shortName: 'Server',
		categories: ['commercial', 'education'],
		defaultDensity: 0.2,
		color: [110, 130, 160]
	},

	// 按 IBC A-3 组估算，约 0.1 台/㎡。
	{
		id: 9,
		name: 'Place of Worship',
		shortName: 'Worship',
		categories: ['commercial'],
		defaultDensity: 0.1,
		color: [135, 135, 155]
	},

	// ─── 中等人流 ──────────────────────────────────────────
	{
		id: 10,
		name: 'Private Office',
		shortName: 'Office',
		categories: ['commercial', 'education', 'healthcare'],
		defaultDensity: 0.2,
		color: [100, 170, 140]
	},
	{
		id: 11,
		name: 'Open Office',
		shortName: 'Open',
		categories: ['commercial'],
		defaultDensity: 0.3,
		color: [80, 170, 165]
	},
	{
		id: 12,
		name: 'Lobby',
		shortName: 'Lobby',
		categories: ['commercial', 'hospitality', 'healthcare'],
		defaultDensity: 0.3,
		color: [90, 170, 190]
	},
	{
		id: 13,
		name: 'Retail Floor',
		shortName: 'Retail',
		categories: ['commercial'],
		defaultDensity: 0.2,
		color: [150, 140, 170]
	},
	{
		id: 14,
		name: 'Waiting Room',
		shortName: 'Wait',
		categories: ['healthcare', 'commercial'],
		defaultDensity: 0.35,
		color: [110, 160, 170]
	},
	{
		id: 15,
		name: 'Library',
		shortName: 'Library',
		categories: ['education', 'commercial'],
		defaultDensity: 0.25,
		color: [120, 155, 150]
	},
	{
		id: 16,
		name: 'Lab',
		shortName: 'Lab',
		categories: ['education', 'healthcare', 'commercial'],
		defaultDensity: 0.2,
		color: [130, 150, 160]
	},
	{
		id: 17,
		name: 'Exam Room',
		shortName: 'Exam',
		categories: ['healthcare'],
		defaultDensity: 0.25,
		color: [130, 165, 155]
	},
	{
		id: 18,
		name: 'Hotel Room',
		shortName: 'Hotel',
		categories: ['hospitality'],
		defaultDensity: 0.3,
		color: [140, 150, 165]
	},
	{
		id: 19,
		name: 'Gym',
		shortName: 'Gym',
		categories: ['commercial', 'hospitality', 'residential'],
		defaultDensity: 0.4,
		color: [160, 155, 100]
	},

	// 小房间 2-4 人加显示设备，约 0.5 台/㎡。
	{
		id: 40,
		name: 'Huddle Room',
		shortName: 'Huddle',
		categories: ['commercial'],
		defaultDensity: 0.5,
		color: [150, 165, 110]
	},
	// FICM 830：工作站与移动终端，约 0.35 台/㎡。
	{
		id: 41,
		name: 'Nurse Station',
		shortName: 'Nurse',
		categories: ['healthcare'],
		defaultDensity: 0.35,
		color: [120, 165, 160]
	},
	// FICM 810：患者设备加 5-8 台医疗 IoT，约 0.5 台/㎡。
	{
		id: 42,
		name: 'Patient Room',
		shortName: 'Patient',
		categories: ['healthcare'],
		defaultDensity: 0.5,
		color: [140, 160, 150]
	},
	// ICU 每间 15-20 台联网设备，约 0.7 台/㎡。
	{
		id: 43,
		name: 'ICU',
		shortName: 'ICU',
		categories: ['healthcare'],
		defaultDensity: 0.7,
		color: [180, 140, 90]
	},
	// 1-2 位住客各 3 台设备，加电视与 IoT，约 0.2 台/㎡。
	{
		id: 44,
		name: 'Guest Room',
		shortName: 'Guest',
		categories: ['hospitality'],
		defaultDensity: 0.2,
		color: [140, 145, 160]
	},
	// 摄像头与 IoT，约 0.01 台/㎡。
	{
		id: 45,
		name: 'Parking Garage',
		shortName: 'Parking',
		categories: ['commercial', 'residential'],
		defaultDensity: 0.01,
		color: [110, 110, 120]
	},
	// FICM 525：手机与穿戴设备，约 0.1 台/㎡。
	{
		id: 46,
		name: 'Locker Room',
		shortName: 'Locker',
		categories: ['education', 'hospitality', 'commercial'],
		defaultDensity: 0.1,
		color: [130, 140, 145]
	},
	// 收银机与顾客手机，约 0.15 台/㎡。
	{
		id: 47,
		name: 'Food Court',
		shortName: 'Food',
		categories: ['commercial', 'hospitality'],
		defaultDensity: 0.15,
		color: [165, 150, 95]
	},

	// ─── 高人流 ────────────────────────────────────────────
	{
		id: 20,
		name: 'Conference Room',
		shortName: 'Conf',
		categories: ['commercial'],
		defaultDensity: 0.8,
		color: [200, 170, 70]
	},
	{
		id: 21,
		name: 'Boardroom',
		shortName: 'Board',
		categories: ['commercial'],
		defaultDensity: 0.6,
		color: [190, 165, 80]
	},
	{
		id: 22,
		name: 'Cafeteria',
		shortName: 'Cafe',
		categories: ['commercial', 'education', 'healthcare'],
		defaultDensity: 0.8,
		color: [190, 160, 80]
	},
	{
		id: 23,
		name: 'Classroom',
		shortName: 'Class',
		categories: ['education'],
		defaultDensity: 1.0,
		color: [210, 150, 60]
	},
	{
		id: 24,
		name: 'Call Center',
		shortName: 'Calls',
		categories: ['commercial'],
		defaultDensity: 0.5,
		color: [170, 160, 90]
	},
	{
		id: 25,
		name: 'Auditorium',
		shortName: 'Audit',
		categories: ['education', 'commercial'],
		defaultDensity: 1.2,
		color: [200, 100, 80]
	},
	{
		id: 26,
		name: 'Event Space',
		shortName: 'Event',
		categories: ['hospitality', 'commercial'],
		defaultDensity: 1.5,
		color: [210, 90, 70]
	},
	{
		id: 27,
		name: 'Restaurant',
		shortName: 'Rest',
		categories: ['hospitality', 'commercial'],
		defaultDensity: 0.7,
		color: [185, 155, 85]
	},

	// 类似教室，人手一台笔记本，约 0.4 台/㎡。
	{
		id: 28,
		name: 'Training Room',
		shortName: 'Train',
		categories: ['commercial', 'education'],
		defaultDensity: 0.4,
		color: [195, 155, 75]
	},
	// 宴会场景人均 1.5 台设备，约 0.6 台/㎡。
	{
		id: 29,
		name: 'Banquet Hall',
		shortName: 'Banq',
		categories: ['hospitality', 'commercial'],
		defaultDensity: 0.6,
		color: [195, 130, 75]
	},

	// ─── 住宅 ─────────────────────────────────────────────
	{
		id: 30,
		name: 'Living Room',
		shortName: 'Living',
		categories: ['residential'],
		defaultDensity: 0.4,
		color: [130, 165, 140]
	},
	{
		id: 31,
		name: 'Bedroom',
		shortName: 'Bed',
		categories: ['residential', 'hospitality'],
		defaultDensity: 0.25,
		color: [140, 140, 165]
	},
	{
		id: 32,
		name: 'Kitchen',
		shortName: 'Kitchen',
		categories: ['residential'],
		defaultDensity: 0.25,
		color: [160, 150, 130]
	},
	{
		id: 33,
		name: 'Dining Room',
		shortName: 'Dining',
		categories: ['residential'],
		defaultDensity: 0.2,
		color: [145, 150, 140]
	},
	{
		id: 34,
		name: 'Home Office',
		shortName: 'Office',
		categories: ['residential'],
		defaultDensity: 0.6,
		color: [100, 170, 140]
	},
	{
		id: 35,
		name: 'Bathroom',
		shortName: 'Bath',
		categories: ['residential'],
		defaultDensity: 0.15,
		color: [130, 145, 155]
	},
	{
		id: 36,
		name: 'Garage',
		shortName: 'Garage',
		categories: ['residential', 'industrial'],
		defaultDensity: 0.08,
		color: [130, 130, 135]
	},
	{
		id: 37,
		name: 'Basement',
		shortName: 'Bsmt',
		categories: ['residential'],
		defaultDensity: 0.06,
		color: [120, 125, 130]
	},
	{
		id: 38,
		name: 'Laundry',
		shortName: 'Lndry',
		categories: ['residential', 'commercial'],
		defaultDensity: 0.1,
		color: [125, 135, 140]
	},
	{
		id: 39,
		name: 'Patio',
		shortName: 'Patio',
		categories: ['residential'],
		defaultDensity: 0.1,
		color: [120, 150, 135]
	},

	// ─── 无地板 ────────────────────────────────────────────────
	{
		id: 48,
		name: 'Void / Atrium',
		shortName: 'Void',
		categories: [
			'commercial',
			'residential',
			'education',
			'healthcare',
			'hospitality',
			'industrial'
		],
		defaultDensity: 0,
		color: [70, 80, 95],
		isVoid: true
	}
];

/** 按 id 查房间类型；id 0（未指定）返回 undefined。 */
export function getRoomType(id: number): RoomType | undefined {
	return ROOM_TYPES.find((t) => t.id === id);
}

/**
 * 是否为无地板区域（见 `RoomType.isVoid`）。
 * 布点时会把这些区域排除在建筑内部之外。
 */
export function isVoidRoomType(id: number): boolean {
	const t = ROOM_TYPES.find((r) => r.id === id);
	return t?.isVoid === true;
}

/** 默认房间类型，用户还没确定房间用途时使用。 */
export const DEFAULT_ROOM_TYPE_ID = 1;

/** 按建筑类型筛选房间类型。 */
export function getRoomTypesForCategory(category: BuildingCategory): RoomType[] {
	return ROOM_TYPES.filter((t) => t.categories.includes(category));
}
