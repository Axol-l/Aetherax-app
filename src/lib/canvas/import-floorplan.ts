
import { floorplanState } from '$state/floorplan-state.svelte.js';
import { floorState } from '$state/floor-state.svelte.js';
import { wallState } from '$state/wall-state.svelte.js';
import { scheduleSave } from '$state/persistence.svelte.js';
import { traceFloorWalls, setFloorWallsFromSegments } from '$state/wall-trace.js';
import { detectBoundary } from '$canvas/boundary-detect.js';
import { detectFloorplanMasks } from '$canvas/detect-floorplan.js';

const FLOORPLAN_TARGET_WIDTH = 800;

/**
 * 导入平面图文件，执行边界与墙体检测并更新项目状态。
 * 侧边栏拖放区和画布拖放目标共用此入口。
 */
export async function importFloorplanFile(file: File): Promise<void> {
	const validTypes = ['image/png', 'image/jpeg', 'image/svg+xml'];
	if (!validTypes.includes(file.type)) {
		// 不支持的类型必须给出提示，否则拖放会静默失败。
		floorplanState.importNotice =
			file.type === 'application/pdf'
				? 'PDF plans are not supported yet — export the page as a PNG and drop that.'
				: 'That file type is not supported — use a PNG, JPEG or SVG.';
		return;
	}
	floorplanState.importNotice = null;

	const blobUrl = URL.createObjectURL(file);
	floorplanState.floorplanUrl = blobUrl;
	floorplanState.sourceIsVector = file.type === 'image/svg+xml';

	try {
		// 用哪个检测器由文件内容决定，而非扩展名。
		const detection = await detectFloorplanMasks(blobUrl, FLOORPLAN_TARGET_WIDTH);
		const { image, wallMask, materialMask } = detection;

		// 边界检测
		const result = detectBoundary(image);
		if (result && result.polygon.length >= 3) {
			const scaleFactor = FLOORPLAN_TARGET_WIDTH / image.naturalWidth;
			floorplanState.floorplanBoundary = result.polygon.map((p) => ({
				x: p.x * scaleFactor,
				y: p.y * scaleFactor
			}));
			// 标定用面积，仅存储，无用户输入时不自动应用
		}

		if (wallMask) {
			wallState.wallMask = wallMask;
			// 矢量检测能识别每个开口的类型，位图检测不能，因此不改动材质图，避免只填一半。
			if (materialMask) wallState.materialMask = materialMask;
			/*
			 * 把掩码描摹成图纸实际显示的线段。导入路径直接写入掩码，若不描摹，
			 * 模型就没有可编辑的墙。
			 */
			const floor = floorState.floors.find((candidate) => candidate.id === floorState.currentFloorId);
			if (floor) {
				floor.walls = [];
				floor.columns = [];
				// 矢量读取得到几何时用图纸的精确几何，否则照旧描摹掩码；两种方式都让楼层得到线段。
				const written = setFloorWallsFromSegments(floor.id, detection.segments ?? []);
				if (written === 0) await traceFloorWalls(floor.id);
			}
		}
		// 矢量读取的结果，供复核面板使用。位图检测会将其清空，避免过期报告描述已被替换的掩码。
		const { summary, elements, source } = detection;
		wallState.vectorReview =
			detection.via === 'vector' && summary && elements && source
				? {
						summary,
						elements,
						overrides: new Map(),
						source,
						targetWidth: FLOORPLAN_TARGET_WIDTH
					}
				: null;

		scheduleSave();
	} catch (e) {
		console.warn('Floorplan detection failed:', e);
	}
}
