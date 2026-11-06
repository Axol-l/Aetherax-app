/**
 * 用于无限画布墙体绘制的分块二值掩码。
 * 存储：256×256 瓦片的稀疏 Map，只有非空瓦片占用内存。
 * 计算：materialize() 展平为 Uint8Array 供热路径使用；支持负坐标，原点跟随包围盒。
 */

const TILE_SIZE = 256;
const TILE_PIXELS = TILE_SIZE * TILE_SIZE;

/**
 * 将瓦片坐标打包为单个数字。
 * +32768 偏移用于区分为负的瓦片坐标，跨度是 65536。
 */
const TILE_KEY_BIAS = 32768;
const TILE_KEY_SPAN = 65536;

function tileKey(tx: number, ty: number): number {
	return (tx + TILE_KEY_BIAS) * TILE_KEY_SPAN + (ty + TILE_KEY_BIAS);
}

function tileKeyX(key: number): number {
	return Math.floor(key / TILE_KEY_SPAN) - TILE_KEY_BIAS;
}

function tileKeyY(key: number): number {
	return (key % TILE_KEY_SPAN) - TILE_KEY_BIAS;
}

/** 能正确处理负数的向下取整除法（JS 的 % 是取余而非取模）。 */
function floorDiv(n: number, d: number): number {
	return Math.floor(n / d);
}

/**
 * 将世界坐标对齐到像素栅格。
 * 掩码是像素网格，而调用方使用世界坐标，原点常为小数，因此先四舍五入。
 */
function snap(v: number): number {
	return Math.round(v);
}

function mod(n: number, d: number): number {
	return ((n % d) + d) % d;
}

export interface MaterialTiledMask {
	tiles: Map<number, Uint8Array>;
	defaultValue: number;
}

export class TiledMask {
	tiles = new Map<number, Uint8Array>();
	/** 可选的逐像素材质数据（瓦片布局相同）。 */
	materialTiles: MaterialTiledMask | null = null;

	// 所有非空瓦片的包围盒（单位：世界像素）
	private minTX = Infinity;
	private minTY = Infinity;
	private maxTX = -Infinity;
	private maxTY = -Infinity;
	private dirty = true;

	/**
	 * 自上次物化以来被改动过的瓦片。
	 * 重建时只修补这些瓦片；包围盒移动或调用方显式要求时用 `fullRebuild` 走全量重建。
	 */
	private dirtyTileKeys = new Set<number>();
	private dirtyMatTileKeys = new Set<number>();
	private fullRebuild = true;

	/**
	 * 光栅必须始终覆盖的显式矩形，单位是世界像素。
	 * 空掩码靠它保持可物化，避免 `materialize()` 返回 null 后被当作没有户型图。
	 */
	frameOriginX = 0;
	frameOriginY = 0;
	frameWidth = 0;
	frameHeight = 0;

	/** 固定光栅框，用于设定楼层加载时所用的掩码范围。 */
	setFrame(originX: number, originY: number, width: number, height: number): void {
		this.frameOriginX = Math.round(originX);
		this.frameOriginY = Math.round(originY);
		this.frameWidth = Math.max(0, Math.round(width));
		this.frameHeight = Math.max(0, Math.round(height));
		this.dirty = true;
		this.fullRebuild = true;
	}

	// 缓存展平后的物化结果
	private cachedData: Uint8Array | null = null;
	private cachedMaterial: Uint8Array | null = null;
	private cachedOriginX = 0;
	private cachedOriginY = 0;
	private cachedWidth = 0;
	private cachedHeight = 0;

	/** 读取单个像素（用于非热路径）。 */
	getPixel(x: number, y: number): number {
		x = snap(x);
		y = snap(y);
		const tx = floorDiv(x, TILE_SIZE);
		const ty = floorDiv(y, TILE_SIZE);
		const tile = this.tiles.get(tileKey(tx, ty));
		if (!tile) return 0;
		const lx = mod(x, TILE_SIZE);
		const ly = mod(y, TILE_SIZE);
		return tile[ly * TILE_SIZE + lx]!;
	}

	/** 写入单个像素；首次写入时分配瓦片。 */
	setPixel(x: number, y: number, value: number): void {
		x = snap(x);
		y = snap(y);
		const tx = floorDiv(x, TILE_SIZE);
		const ty = floorDiv(y, TILE_SIZE);
		const key = tileKey(tx, ty);
		let tile = this.tiles.get(key);
		if (!tile) {
			// 清除从未设置过的像素不得分配瓦片或移动边界，否则绘制区域外的擦除会扩大掩码，
			// 而每次编辑都要整体物化并编码 PNG，可能因超出画布尺寸上限而导致整个墙体图层消失。
			if (!value) return;
			tile = new Uint8Array(TILE_PIXELS);
			this.tiles.set(key, tile);
		}
		const lx = mod(x, TILE_SIZE);
		const ly = mod(y, TILE_SIZE);
		tile[ly * TILE_SIZE + lx] = value;
		this.dirty = true;
		this.dirtyTileKeys.add(key);

		// 更新包围盒
		if (tx < this.minTX) this.minTX = tx;
		if (ty < this.minTY) this.minTY = ty;
		if (tx > this.maxTX) this.maxTX = tx;
		if (ty > this.maxTY) this.maxTY = ty;
	}

	/** 设置单个像素的材质值。 */
	setMaterial(x: number, y: number, materialId: number): void {
		if (!this.materialTiles) {
			this.materialTiles = { tiles: new Map(), defaultValue: 0 };
		}
		x = snap(x);
		y = snap(y);
		const tx = floorDiv(x, TILE_SIZE);
		const ty = floorDiv(y, TILE_SIZE);
		const key = tileKey(tx, ty);
		let tile = this.materialTiles.tiles.get(key);
		if (!tile) {
			tile = new Uint8Array(TILE_PIXELS);
			tile.fill(this.materialTiles.defaultValue);
			this.materialTiles.tiles.set(key, tile);
		}
		const lx = mod(x, TILE_SIZE);
		const ly = mod(y, TILE_SIZE);
		tile[ly * TILE_SIZE + lx] = materialId;
		this.dirty = true;
		this.dirtyMatTileKeys.add(key);
	}

	/** 绘制一个实心圆形的墙体像素（笔刷笔画）。 */
	paintCircle(cx: number, cy: number, radius: number, value: number, materialId?: number): void {
		cx = snap(cx);
		cy = snap(cy);
		const r2 = radius * radius;
		const x0 = cx - radius;
		const y0 = cy - radius;
		const x1 = cx + radius;
		const y1 = cy + radius;
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				const dx = x - cx;
				const dy = y - cy;
				if (dx * dx + dy * dy <= r2) {
					this.setPixel(x, y, value);
					if (materialId !== undefined && value === 1) {
						this.setMaterial(x, y, materialId);
					}
				}
			}
		}
	}

	/** 判断掩码是否含有带数据的瓦片。 */
	get isEmpty(): boolean {
		return this.tiles.size === 0;
	}

	/**
	 * 获取世界像素坐标下的包围盒（占用瓦片与显式框的并集）。
	 * 原点是第一个占用瓦片而非零点，且始终对齐到整像素；无瓦片且无框时返回 null。
	 */
	get bounds(): { originX: number; originY: number; width: number; height: number } | null {
		// 包围盒必须同时覆盖材质瓦片：`setMaterial` 会独立分配瓦片，材质可能出现在没有墙的位置。
		let minTX = this.minTX;
		let maxTX = this.maxTX;
		let minTY = this.minTY;
		let maxTY = this.maxTY;
		let hasTiles = this.minTX <= this.maxTX;
		const matTiles = this.materialTiles?.tiles;
		if (matTiles && matTiles.size > 0) {
			for (const key of matTiles.keys()) {
				const tx = tileKeyX(key);
				const ty = tileKeyY(key);
				if (!hasTiles) {
					minTX = maxTX = tx;
					minTY = maxTY = ty;
					hasTiles = true;
					continue;
				}
				if (tx < minTX) minTX = tx;
				if (tx > maxTX) maxTX = tx;
				if (ty < minTY) minTY = ty;
				if (ty > maxTY) maxTY = ty;
			}
		}

		const hasFrame = this.frameWidth > 0 && this.frameHeight > 0;
		if (!hasTiles && !hasFrame) return null;

		let originX = hasTiles ? minTX * TILE_SIZE : this.frameOriginX;
		let originY = hasTiles ? minTY * TILE_SIZE : this.frameOriginY;
		let endX = hasTiles ? (maxTX + 1) * TILE_SIZE : this.frameOriginX + this.frameWidth;
		let endY = hasTiles ? (maxTY + 1) * TILE_SIZE : this.frameOriginY + this.frameHeight;

		if (hasFrame) {
			originX = Math.min(originX, this.frameOriginX);
			originY = Math.min(originY, this.frameOriginY);
			endX = Math.max(endX, this.frameOriginX + this.frameWidth);
			endY = Math.max(endY, this.frameOriginY + this.frameHeight);
		}

		originX = Math.floor(originX);
		originY = Math.floor(originY);
		endX = Math.ceil(endX);
		endY = Math.ceil(endY);
		return {
			originX,
			originY,
			width: Math.max(1, endX - originX),
			height: Math.max(1, endY - originY)
		};
	}

	/**
	 * 将瓦片展平为 Uint8Array，供热路径使用。
	 * 若自上次调用后没有变化则返回缓存结果。
	 */
	materialize(): {
		data: Uint8Array;
		materialData: Uint8Array | null;
		originX: number;
		originY: number;
		width: number;
		height: number;
	} | null {
		if (!this.dirty && this.cachedData) {
			return {
				data: this.cachedData,
				materialData: this.cachedMaterial,
				originX: this.cachedOriginX,
				originY: this.cachedOriginY,
				width: this.cachedWidth,
				height: this.cachedHeight
			};
		}

		const b = this.bounds;
		if (!b) return null;

		const { originX, originY, width, height } = b;
		// 包围盒不变时复用缓存数组，避免每次笔画都完整分配
		const sameSize =
			this.cachedData != null &&
			this.cachedWidth === width &&
			this.cachedHeight === height &&
			this.cachedOriginX === originX &&
			this.cachedOriginY === originY;

		const needsMat = this.materialTiles != null && this.materialTiles.tiles.size > 0;

		// 快路径：包围盒未变且只改动了整块瓦片时，仅修补这些瓦片。
		// 平铺一整块瓦片会覆盖其全部像素，因此被擦除的像素无需先清空整个光栅。
		if (sameSize && !this.fullRebuild) {
			const data = this.cachedData!;
			for (const key of this.dirtyTileKeys) {
				const tile = this.tiles.get(key);
				if (tile) this.blitTile(data, tile, key, originX, originY, width);
			}
			this.dirtyTileKeys.clear();

			let matData = this.cachedMaterial;
			if (needsMat) {
				if (!matData) {
					// 材质瓦片首次出现：未改动的区域必须读作默认材质，而不是 0。
					matData = new Uint8Array(width * height);
					matData.fill(this.materialTiles!.defaultValue);
				}
				for (const key of this.dirtyMatTileKeys) {
					const tile = this.materialTiles!.tiles.get(key);
					if (tile) this.blitTile(matData, tile, key, originX, originY, width);
				}
			} else {
				matData = null;
			}
			this.dirtyMatTileKeys.clear();
			this.cachedMaterial = matData;
			this.dirty = false;

			return { data, materialData: matData, originX, originY, width, height };
		}

		// 慢路径：重新构建整个光栅。
		const data = sameSize ? this.cachedData! : new Uint8Array(width * height);
		if (sameSize) data.fill(0);
		const matData = needsMat
			? sameSize && this.cachedMaterial
				? this.cachedMaterial
				: new Uint8Array(width * height)
			: null;
		if (matData && this.materialTiles) {
			matData.fill(this.materialTiles.defaultValue);
		}

		// 将瓦片数据复制到展平数组
		for (const [key, tile] of this.tiles) {
			this.blitTile(data, tile, key, originX, originY, width);
		}

		// 复制材质瓦片
		if (matData && this.materialTiles) {
			for (const [key, tile] of this.materialTiles.tiles) {
				this.blitTile(matData, tile, key, originX, originY, width);
			}
		}

		this.cachedData = data;
		this.cachedMaterial = matData;
		this.cachedOriginX = originX;
		this.cachedOriginY = originY;
		this.cachedWidth = width;
		this.cachedHeight = height;
		this.dirty = false;
		this.fullRebuild = false;
		this.dirtyTileKeys.clear();
		this.dirtyMatTileKeys.clear();

		return {
			data,
			materialData: matData,
			originX,
			originY,
			width,
			height
		};
	}

	/**
	 * 将一块 256x256 瓦片复制到展平光栅中对应的世界偏移处。
	 * 按裁剪处理而不假设瓦片一定落在光栅内；`setMaterial` 分配的瓦片可能位于包围盒之外。
	 */
	private blitTile(
		dst: Uint8Array,
		tile: Uint8Array,
		key: number,
		originX: number,
		originY: number,
		width: number
	): void {
		const baseX = tileKeyX(key) * TILE_SIZE - originX;
		const baseY = tileKeyY(key) * TILE_SIZE - originY;
		const height = width > 0 ? Math.floor(dst.length / width) : 0;

		for (let ly = 0; ly < TILE_SIZE; ly++) {
			const dy = baseY + ly;
			if (dy < 0 || dy >= height) continue;
			// 该瓦片落在光栅内的列范围。
			const srcX0 = Math.max(0, -baseX);
			const srcX1 = Math.min(TILE_SIZE, width - baseX);
			if (srcX1 <= srcX0) continue;
			const rowOff = ly * TILE_SIZE;
			dst.set(tile.subarray(rowOff + srcX0, rowOff + srcX1), dy * width + baseX + srcX0);
		}
	}

	/** 从带世界坐标原点偏移的展平 Uint8Array 导入。 */
	static fromFlat(
		data: Uint8Array,
		width: number,
		height: number,
		materialData?: Uint8Array | null,
		defaultMaterial?: number,
		originX = 0,
		originY = 0
	): TiledMask {
		const mask = new TiledMask();
		// 调用方的原点以世界单位表示且可能是小数，因此在变成像素地址前先取整。
		// 框用于在数据全为零时保持光栅尺寸不变。
		originX = Math.round(originX);
		originY = Math.round(originY);
		mask.setFrame(originX, originY, width, height);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if (data[y * width + x]) {
					mask.setPixel(x + originX, y + originY, 1);
				}
			}
		}
		if (materialData) {
			if (!mask.materialTiles) {
				mask.materialTiles = {
					tiles: new Map(),
					defaultValue: defaultMaterial ?? 0
				};
			}
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const val = materialData[y * width + x]!;
					if (val !== (defaultMaterial ?? 0) || data[y * width + x]) {
						mask.setMaterial(x + originX, y + originY, val);
					}
				}
			}
		}
		return mask;
	}

	/**
	 * 清除所有像素，但保留光栅框。
	 * 瓦片不会被单独回收，这是真正缩小掩码的唯一方式；空掩码仍需可物化，因此框有意保留。
	 */
	clear(): void {
		this.tiles.clear();
		this.materialTiles?.tiles.clear();
		this.materialTiles = null;
		this.minTX = Infinity;
		this.minTY = Infinity;
		this.maxTX = -Infinity;
		this.maxTY = -Infinity;
		this.cachedData = null;
		this.cachedMaterial = null;
		this.cachedWidth = 0;
		this.cachedHeight = 0;
		this.dirtyTileKeys.clear();
		this.dirtyMatTileKeys.clear();
		this.dirty = true;
		this.fullRebuild = true;
	}

	/**
	 * 标记为脏，使下一次 materialize() 重建展平数组。
	 * 走全量重建而非修补，因为调用方是直接修改瓦片的，脏瓦片集合没有记录这些改动。
	 */
	markDirty(): void {
		this.dirty = true;
		this.fullRebuild = true;
	}
}
