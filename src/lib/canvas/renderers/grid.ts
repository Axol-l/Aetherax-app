import type { Layer, RenderContext } from '../types.js';

const MINOR_COLOR = '#1a1d27';
const MAJOR_COLOR = '#252838';
const LABEL_COLOR = '#4d5370';

const FEET_PER_METER = 3.28084;

export class GridLayer implements Layer {
	id = 'grid';
	visible = true;
	/** 绘图辅助线，不属于平面图，不会出现在导出的图片中。 */
	readonly exportable = false;

	// 设置后，网格对齐到真实世界单位
	worldUnitsPerMeter: number | null = null;
	unitSystem: 'imperial' | 'metric' = 'imperial';

	render(rc: RenderContext): void {
		const { ctx, camera, width, height } = rc;
		const transform = camera.getTransform();
		const zoom = camera.state.zoom;

		// 计算网格间距
		let minor: number;
		let major: number;
		let unitLabel = '';
		let unitScale = 1; // 每个显示单位对应的世界单位

		if (this.worldUnitsPerMeter && this.worldUnitsPerMeter > 0) {
			const wupm = this.worldUnitsPerMeter;

			if (this.unitSystem === 'imperial') {
				// 英制：网格以英尺为单位
				const wupf = wupm / FEET_PER_METER; // 每英尺对应的世界单位
				unitScale = wupf;
				unitLabel = 'ft';
				minor = wupf * 5; // 5 英尺
				major = wupf * 25; // 25 英尺

				const screenMinor = minor * zoom;
				if (screenMinor < 8) {
					minor = wupf * 25;
					major = wupf * 100;
				} else if (screenMinor > 60) {
					minor = wupf; // 1 英尺
					major = wupf * 5;
				}
			} else {
				// 公制：网格以米为单位
				unitScale = wupm;
				unitLabel = 'm';
				minor = wupm; // 1 米
				major = wupm * 5; // 5 米

				const screenMinor = minor * zoom;
				if (screenMinor < 8) {
					minor = wupm * 5;
					major = wupm * 25;
				}
			}
		} else {
			// 未标定：使用像素网格
			minor = 20;
			major = 100;
		}

		const showMinor = zoom >= 0.3;

		const topLeft = camera.screenToWorld({ x: 0, y: 0 });
		const bottomRight = camera.screenToWorld({ x: width, y: height });

		const startX = Math.floor(topLeft.x / minor) * minor;
		const endX = Math.ceil(bottomRight.x / minor) * minor;
		const startY = Math.floor(topLeft.y / minor) * minor;
		const endY = Math.ceil(bottomRight.y / minor) * minor;

		const [a, b, c, d, e, f] = transform;
		ctx.transform(a, b, c, d, e, f);

		ctx.lineWidth = 1 / zoom;

		// 次级网格线
		if (showMinor) {
			ctx.strokeStyle = MINOR_COLOR;
			ctx.beginPath();
			for (let x = startX; x <= endX; x += minor) {
				if (Math.abs(x % major) < 0.01) continue;
				ctx.moveTo(x, startY);
				ctx.lineTo(x, endY);
			}
			for (let y = startY; y <= endY; y += minor) {
				if (Math.abs(y % major) < 0.01) continue;
				ctx.moveTo(startX, y);
				ctx.lineTo(endX, y);
			}
			ctx.stroke();
		}

		// 主网格线
		ctx.strokeStyle = MAJOR_COLOR;
		ctx.beginPath();
		const majorStartX = Math.floor(topLeft.x / major) * major;
		const majorEndX = Math.ceil(bottomRight.x / major) * major;
		const majorStartY = Math.floor(topLeft.y / major) * major;
		const majorEndY = Math.ceil(bottomRight.y / major) * major;

		for (let x = majorStartX; x <= majorEndX; x += major) {
			ctx.moveTo(x, majorStartY);
			ctx.lineTo(x, majorEndY);
		}
		for (let y = majorStartY; y <= majorEndY; y += major) {
			ctx.moveTo(majorStartX, y);
			ctx.lineTo(majorEndX, y);
		}
		ctx.stroke();

		// 主网格线上的比例标签（已标定时）
		if (unitLabel && unitScale > 0) {
			ctx.fillStyle = LABEL_COLOR;
			const fontSize = 10 / zoom;
			ctx.font = `${fontSize}px sans-serif`;
			ctx.textAlign = 'left';
			ctx.textBaseline = 'top';

			for (let x = majorStartX; x <= majorEndX; x += major) {
				const units = Math.round(x / unitScale);
				if (units === 0) continue;
				ctx.fillText(`${units}${unitLabel}`, x + 2 / zoom, topLeft.y + 2 / zoom);
			}

			// Y 轴标签
			ctx.textAlign = 'left';
			ctx.textBaseline = 'top';
			for (let y = majorStartY; y <= majorEndY; y += major) {
				const units = Math.round(y / unitScale);
				if (units === 0) continue;
				ctx.fillText(`${units}${unitLabel}`, topLeft.x + 2 / zoom, y + 2 / zoom);
			}
		}
	}
}
