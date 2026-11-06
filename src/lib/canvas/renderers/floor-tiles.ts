import type { Layer, RenderContext } from '../types.js';
import { ACCENT_STROKE, ACCENT_TEXT } from '../accents.js';
import type { FloorCardCache} from './floor-card.js';
import { type FloorCardSource, type FloorHeatmap } from './floor-card.js';

/** 瓦片之间的间距，单位为世界单位。 */
const GAP = 120;
/** 瓦片周围仍算作命中的扩展区，便于点击卡片。 */
const HIT_PAD = 24;

interface TileLayout {
	id: string;
	/** 瓦片边框的世界空间矩形。 */
	x: number;
	y: number;
	w: number;
	h: number;
	/**
	 * 该楼层自身的内容框，单位为世界单位；有掩码时取掩码范围，内容裁剪到此框而非边框。
	 */
	boxW: number;
	boxH: number;
	/** 将该楼层内容移入边框的世界空间位移。 */
	dx: number;
	dy: number;
}

/**
 * 只读的楼层总览，各楼层并排排列：绘制底层图、墙体轮廓、AP 点与楼层名称，点击切换楼层。
 * 布局每次渲染时重新计算而不缓存，避免失效布局使内容落到相邻瓦片的点击区。
 */
export class FloorTilesLayer implements Layer {
	id = 'floor-tiles';
	visible = false;
	currentFloorId: string | null = null;
	/**
	 * 图层开关，作用于每个瓦片。
	 *
	 * LAYERS 面板在各视图中含义必须一致，因此这些开关在此视图中同样生效。
	 */
	showPlan = true;
	showWalls = true;
	showAPs = true;
	showHeatmap = false;
	/** 底层图不透明度，与单楼层视图共用。 */
	planOpacity = 0.8;
	/** 总览图的参考比例，各楼层绘制都换算到该比例。 */
	wupm = 1;

	private sources: FloorCardSource[] = [];

	constructor(private readonly cards: FloorCardCache) {}

	/** 各楼层的覆盖图，由共享缓存持有，调用方填充。 */
	get heatmaps(): Map<string, FloorHeatmap> {
		return this.cards.heatmaps;
	}

	/** 平面图图片加载完成后调用，使引擎可以重绘。 */
	set onLoad(fn: (() => void) | null) {
		this.cards.onLoad = fn;
	}

	setFloors(sources: FloorCardSource[], currentFloorId: string | null, wupm: number): void {
		this.currentFloorId = currentFloorId;
		this.wupm = wupm;
		this.cards.sync(sources);
		this.sources = sources;
	}

	/** 每个瓦片占用的世界空间矩形，单位为世界单位。 */
	computeLayout(): TileLayout[] {
		if (this.sources.length === 0) return [];

		// 所有瓦片使用同一格尺寸以保证网格对齐；逐行独立定尺寸会使列参差不齐。
		let cellW = 0;
		let cellH = 0;
		const boxes = this.sources.map((s) => {
			const box = this.cards.contentBox(s, this.wupm);
			cellW = Math.max(cellW, box.w);
			cellH = Math.max(cellH, box.h);
			return { s, box };
		});

		// 接近方形的网格；一两个楼层排成单行更易读。
		const n = boxes.length;
		const cols = n <= 2 ? n : Math.ceil(Math.sqrt(n));

		return boxes.map((m, i) => {
			const x = (i % cols) * (cellW + GAP);
			const y = Math.floor(i / cols) * (cellH + GAP);
			// 每个楼层的内容对齐到瓦片左上角，避免小楼层被拉伸以匹配大楼层。
			return {
				id: m.s.id,
				x,
				y,
				w: cellW,
				h: cellH,
				boxW: m.box.w,
				boxH: m.box.h,
				dx: x - m.box.minX,
				dy: y - m.box.minY
			};
		});
	}

	/** 世界坐标点落在哪个楼层上；没有命中时为 null。 */
	tileAt(worldX: number, worldY: number): string | null {
		for (const t of this.computeLayout()) {
			if (
				worldX >= t.x - HIT_PAD &&
				worldX <= t.x + t.w + HIT_PAD &&
				worldY >= t.y - HIT_PAD &&
				worldY <= t.y + t.h + HIT_PAD
			) {
				return t.id;
			}
		}
		return null;
	}

	/** 整张总览图的边界，用于适配相机。 */
	contentBounds(): Array<{ x: number; y: number }> {
		const tiles = this.computeLayout();
		if (tiles.length === 0) return [];
		let maxX = 0;
		let maxY = 0;
		for (const t of tiles) {
			maxX = Math.max(maxX, t.x + t.w);
			maxY = Math.max(maxY, t.y + t.h);
		}
		return [
			{ x: 0, y: 0 },
			{ x: maxX, y: maxY }
		];
	}

	render(rc: RenderContext): void {
		if (!this.visible) return;
		const { ctx, camera } = rc;
		const tiles = this.computeLayout();
		if (tiles.length === 0) return;

		const [a, b, c, d, e, f] = camera.getTransform();
		const zoom = camera.state.zoom || 1;

		ctx.save();
		ctx.transform(a, b, c, d, e, f);

		for (const tile of tiles) {
			const src = this.sources.find((s) => s.id === tile.id);
			if (!src) continue;

			// 边框和标签按固定屏幕尺寸绘制，只有楼层自身内容随相机缩放。
			const isCurrent = src.id === this.currentFloorId;

			ctx.fillStyle = 'rgba(255,255,255,0.03)';
			ctx.fillRect(tile.x, tile.y, tile.w, tile.h);

			ctx.strokeStyle = isCurrent ? ACCENT_STROKE : 'rgba(255,255,255,0.18)';
			ctx.lineWidth = (isCurrent ? 2 : 1) / zoom;
			ctx.strokeRect(tile.x, tile.y, tile.w, tile.h);

			ctx.font = `${13 / zoom}px sans-serif`;
			ctx.fillStyle = isCurrent ? ACCENT_TEXT : 'rgba(255,255,255,0.55)';
			ctx.textBaseline = 'bottom';
			ctx.fillText(src.name, tile.x, tile.y - 6 / zoom);

			ctx.save();
			ctx.beginPath();
			// 裁剪到该楼层自身的内容框而非边框：见 `TileLayout.boxW`。
			ctx.rect(tile.x, tile.y, tile.boxW, tile.boxH);
			ctx.clip();
			ctx.translate(tile.dx, tile.dy);
			this.cards.draw(ctx, src, {
				showPlan: this.showPlan,
				showWalls: this.showWalls,
				showAPs: this.showAPs,
				showHeatmap: this.showHeatmap,
				planOpacity: this.planOpacity,
				zoom,
				wupm: this.wupm
			});
			ctx.restore();
		}

		ctx.restore();
	}
}
