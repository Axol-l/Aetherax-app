import type { Layer, RenderContext } from '../types.js';
import type { RegionLabels } from '../region-labels.js';
import { ROOM_TYPES, type RoomType } from '$lib/domain/room-types.js';
import { t } from '../../state/i18n.svelte';

interface RoomLabelInfo {
	cx: number; // 质心 X，掩码局部坐标
	cy: number; // 质心 Y，掩码局部坐标
	typeId: number;
	type: RoomType;
	regionId: number;
}

export class RoomLabelsLayer implements Layer {
	id = 'room-labels';
	visible = true;

	/** 房间类型掩码：像素 → 房间类型 id（0 表示未指定）。 */
	roomTypeData: Uint8Array | null = null;
	/** 由 labelRooms 生成的区域标签（内部连通分量）。 */
	roomLabels: RegionLabels | null = null;
	/** Room-type tint opacity; raised while the heatmap is painted underneath. */
	tintAlpha = 0.18;
	/** Multiply keeps the tint from washing the heatmap out to white. */
	tintBlend: GlobalCompositeOperation = 'source-over';
	/** 掩码尺寸与世界坐标原点。 */
	maskWidth = 0;
	maskHeight = 0;
	originX = 0;
	originY = 0;
	/** 各区域密度覆盖："regionId" → 密度。 */
	densityOverrides: Record<string, number> = {};
	/** 各区域自定义标签："regionId" → 标签文本。 */
	customLabels: Record<string, string> = {};

	// 缓存
	private cachedTint: HTMLCanvasElement | null = null;
	private cachedLabels: RoomLabelInfo[] = [];
	private cachedTypeRef: Uint8Array | null = null;
	private cachedLabelRef: RegionLabels | null = null;
	private cachedDensityRef: Record<string, number> = {};
	private cachedCustomLabelsRef: Record<string, string> = {};

	invalidateCache(): void {
		this.cachedTypeRef = null;
	}

	render(rc: RenderContext): void {
		if (!this.roomTypeData || !this.roomLabels || this.maskWidth === 0) return;

		const needsRegen =
			this.roomTypeData !== this.cachedTypeRef ||
			this.roomLabels !== this.cachedLabelRef ||
			this.densityOverrides !== this.cachedDensityRef ||
			this.customLabels !== this.cachedCustomLabelsRef;

		if (needsRegen) {
			this.cachedTint = this.buildTintCanvas();
			this.cachedLabels = this.computeLabelPositions();
			this.cachedTypeRef = this.roomTypeData;
			this.cachedLabelRef = this.roomLabels;
			this.cachedDensityRef = this.densityOverrides;
			this.cachedCustomLabelsRef = this.customLabels;
		}

		const { ctx, camera, dpr } = rc;
		const transform = camera.getTransform();
		const [a, b, c, d, e, f] = transform;

		// 绘制房间色调填充
		if (this.cachedTint) {
			ctx.save();
			ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
			ctx.globalAlpha = this.tintAlpha;
			ctx.globalCompositeOperation = this.tintBlend;
			ctx.drawImage(this.cachedTint, this.originX, this.originY);
			ctx.restore();
		}

		// 绘制标签胶囊
		if (this.cachedLabels.length === 0) return;

		ctx.save();
		ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
		const zoom = camera.state.zoom;
		const scale = 1 / zoom;
		const fontSize = 10 * scale;
		const padX = 4 * scale;
		const padY = 2 * scale;
		const radius = 3 * scale;

		ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';

		for (const info of this.cachedLabels) {
			const wx = this.originX + info.cx;
			const wy = this.originY + info.cy;
			const custom = this.customLabels[String(info.regionId)];
			// 画布标签跟随界面语言；用户提供的标签不跟随。
		const text = custom || t(info.type.shortName);
			const metrics = ctx.measureText(text);
			const tw = metrics.width;
			const th = fontSize;
			const bw = tw + padX * 2;
			const bh = th + padY * 2;
			const bx = wx - bw / 2;
			const by = wy - bh / 2;

			// 胶囊背景
			const [r, g, b2] = info.type.color;
			ctx.fillStyle = `rgba(${r}, ${g}, ${b2}, 0.85)`;
			ctx.beginPath();
			ctx.roundRect(bx, by, bw, bh, radius);
			ctx.fill();

			// 文本
			ctx.fillStyle = '#ffffff';
			ctx.fillText(text, wx, wy);
		}
		ctx.restore();
	}

	private buildTintCanvas(): HTMLCanvasElement {
		const canvas = document.createElement('canvas');
		canvas.width = this.maskWidth;
		canvas.height = this.maskHeight;
		const ctx = canvas.getContext('2d')!;
		const imgData = ctx.createImageData(this.maskWidth, this.maskHeight);
		const data = this.roomTypeData!;
		const typeMap = new Map<number, RoomType>();
		for (const t of ROOM_TYPES) typeMap.set(t.id, t);

		for (let i = 0; i < data.length; i++) {
			const typeId = data[i]!;
			if (typeId === 0) continue;
			const type = typeMap.get(typeId);
			if (!type) continue;
			const j = i * 4;
			imgData.data[j] = type.color[0];
			imgData.data[j + 1] = type.color[1];
			imgData.data[j + 2] = type.color[2];
			imgData.data[j + 3] = 255;
		}
		ctx.putImageData(imgData, 0, 0);
		return canvas;
	}

	private computeLabelPositions(): RoomLabelInfo[] {
		const labels = this.roomLabels!;
		const typeData = this.roomTypeData!;
		const typeMap = new Map<number, RoomType>();
		for (const t of ROOM_TYPES) typeMap.set(t.id, t);

		// 累加各区域的质心坐标
		const regions = new Map<
			number,
			{ sumX: number; sumY: number; count: number; typeId: number }
		>();

		for (let i = 0; i < labels.labels.length; i++) {
			const regionId = labels.labels[i]!;
			if (regionId < 0) continue;
			const typeId = typeData[i]!;
			if (typeId === 0) continue;

			const x = i % this.maskWidth;
			const y = Math.floor(i / this.maskWidth);

			let acc = regions.get(regionId);
			if (!acc) {
				acc = { sumX: 0, sumY: 0, count: 0, typeId };
				regions.set(regionId, acc);
			}
			acc.sumX += x;
			acc.sumY += y;
			acc.count++;
		}

		const result: RoomLabelInfo[] = [];
		for (const [regionId, acc] of regions) {
			const type = typeMap.get(acc.typeId);
			if (!type) continue;
			result.push({
				cx: acc.sumX / acc.count,
				cy: acc.sumY / acc.count,
				typeId: acc.typeId,
				type,
				regionId
			});
		}

		return result;
	}
}
