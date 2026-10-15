/**
 * Tiled binary mask for infinite-canvas wall drawing.
 *
 * Storage: sparse Map of 256×256 tiles. Only non-empty tiles consume memory.
 * Computation: materialize() flattens to a Uint8Array for hot-path consumers
 * (ray march, renderer, BFS) — same speed as a monolithic array.
 *
 * Supports negative coordinates. Materialized origin tracks the bounding box.
 */

const TILE_SIZE = 256;
const TILE_PIXELS = TILE_SIZE * TILE_SIZE;

/**
 * Pack a tile coordinate into a single number.
 *
 * This used to build a template string on every getPixel/setPixel, which a
 * radius-15 material brush does thousands of times per stroke. The +32768
 * offset keeps negative tile coordinates distinct; a canvas would have to
 * exceed roughly 8.4 million pixels per axis for these to collide.
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

/** Proper floor division that handles negatives (JS % is remainder, not modulo). */
function floorDiv(n: number, d: number): number {
	return Math.floor(n / d);
}

/**
 * Snap a world coordinate to the pixel raster.
 *
 * The mask is a pixel grid, but every caller works in world units, and the world
 * origin of a mask is whatever the alignment drag last settled on
 * (`dxScreen / zoom`), so it is routinely fractional. That mattered: a fractional
 * coordinate made `mod(x, 256)` fractional, and writing to a typed array with a
 * fractional index is *silently discarded* — the key becomes an ordinary expando
 * property instead of an element. A floor whose offset had a fractional part
 * therefore loaded its detected walls into an all-zero raster, and the first edit
 * saved that blank raster back over them.
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
	/** Optional per-pixel material data (same tile layout). */
	materialTiles: MaterialTiledMask | null = null;

	// Bounding box of all non-empty tiles (in world pixels)
	private minTX = Infinity;
	private minTY = Infinity;
	private maxTX = -Infinity;
	private maxTY = -Infinity;
	private dirty = true;

	/**
	 * Tiles touched since the last materialisation.
	 *
	 * materialize() used to clear the whole raster and recopy every tile on each
	 * rebuild. Because a brush stroke only ever touches a handful of 256x256
	 * tiles, tracking the touched keys lets a rebuild patch just those instead.
	 * `fullRebuild` forces the slow path when the bounding box moved (which
	 * reallocates the raster) or when a caller explicitly requested it.
	 */
	private dirtyTileKeys = new Set<number>();
	private dirtyMatTileKeys = new Set<number>();
	private fullRebuild = true;

	/**
	 * An explicit rectangle, in world pixels, that the raster must always cover.
	 *
	 * This is what keeps an *empty* mask materialisable. The box used to come from
	 * the occupied tiles alone, so a mask with no walls had no box at all,
	 * `materialize()` returned null, and every caller reads null as "this floor
	 * has no floorplan" — the wall editor included, which then dropped every
	 * subsequent stroke without a word. "Clear all walls" put the floor in exactly
	 * that state, so clearing the walls also silently ended the drawing session.
	 */
	frameOriginX = 0;
	frameOriginY = 0;
	frameWidth = 0;
	frameHeight = 0;

	/** Pin the raster box, e.g. to the extent of the mask a floor was loaded with. */
	setFrame(originX: number, originY: number, width: number, height: number): void {
		this.frameOriginX = Math.round(originX);
		this.frameOriginY = Math.round(originY);
		this.frameWidth = Math.max(0, Math.round(width));
		this.frameHeight = Math.max(0, Math.round(height));
		this.dirty = true;
		this.fullRebuild = true;
	}

	// Cached flat materialization
	private cachedData: Uint8Array | null = null;
	private cachedMaterial: Uint8Array | null = null;
	private cachedOriginX = 0;
	private cachedOriginY = 0;
	private cachedWidth = 0;
	private cachedHeight = 0;

	/** Read a single pixel (for non-hot-path use). */
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

	/** Write a single pixel. Allocates tile on first write. */
	setPixel(x: number, y: number, value: number): void {
		x = snap(x);
		y = snap(y);
		const tx = floorDiv(x, TILE_SIZE);
		const ty = floorDiv(y, TILE_SIZE);
		const key = tileKey(tx, ty);
		let tile = this.tiles.get(key);
		if (!tile) {
			// Clearing a pixel that was never set must not allocate a tile or move
			// the bounds. Otherwise an erase outside the drawn area silently grows
			// the mask, and the mask is materialised and PNG-encoded whole on every
			// edit — so a stray erase costs work proportional to the empty span it
			// just added, and past the canvas size limit the encode fails and the
			// entire wall layer disappears.
			if (!value) return;
			tile = new Uint8Array(TILE_PIXELS);
			this.tiles.set(key, tile);
		}
		const lx = mod(x, TILE_SIZE);
		const ly = mod(y, TILE_SIZE);
		tile[ly * TILE_SIZE + lx] = value;
		this.dirty = true;
		this.dirtyTileKeys.add(key);

		// Update bounding box
		if (tx < this.minTX) this.minTX = tx;
		if (ty < this.minTY) this.minTY = ty;
		if (tx > this.maxTX) this.maxTX = tx;
		if (ty > this.maxTY) this.maxTY = ty;
	}

	/** Set a material value for a pixel. */
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

	/** Paint a filled circle of wall pixels (brush stroke). */
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

	/** Check if the mask has any tiles with data. */
	get isEmpty(): boolean {
		return this.tiles.size === 0;
	}

	/**
	 * Get the bounding box in world pixels (the occupied tiles unioned with the
	 * explicit frame).
	 *
	 * The origin is the first occupied tile, not zero.
	 *
	 * It used to be `Math.min(tileOX, 0)`, which forced every mask to start at the
	 * world origin. For a plan drawn near (0, 0) that is invisible; for a floor
	 * that has been moved — an alignment offset of a few thousand world units —
	 * it turned a 1500-wide mask into a 3500-wide mostly-empty one, because the
	 * whole span from the origin to the content was included. The mask is
	 * materialised and PNG-encoded whole on every wall edit, so that span is paid
	 * for on every stroke, and it grows with the alignment offset.
	 *
	 * The box is always on whole pixels. It is a pixel raster: `materialize()`
	 * allocates `width * height` bytes and `blitTile` derives the row stride from
	 * the array length, while `encodeMask` feeds the same numbers to a canvas,
	 * which truncates them. So a fractional box does not fail loudly — the raster
	 * is silently shaped differently from the numbers that describe it, and the
	 * encoded PNG no longer corresponds to the pixels. A floor aligned to
	 * `y = 14.2796` reported `height: 540.2796`, which is how a 526-tall mask grew a
	 * phantom half-row.
	 */
	get bounds(): { originX: number; originY: number; width: number; height: number } | null {
		// The box has to cover the material tiles as well as the wall tiles.
		// `setMaterial` allocates its own tiles without consulting the wall grid, so
		// a material can exist where no wall does; sizing the raster from the wall
		// tiles alone left those tiles outside it.
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
	 * Materialize tiles into a flat Uint8Array for hot-path consumers.
	 * Returns cached result if unchanged since last call. Cost: <1ms for typical masks.
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
		// Reuse cached arrays if bounds unchanged (avoid a full alloc per stroke)
		const sameSize =
			this.cachedData != null &&
			this.cachedWidth === width &&
			this.cachedHeight === height &&
			this.cachedOriginX === originX &&
			this.cachedOriginY === originY;

		const needsMat = this.materialTiles != null && this.materialTiles.tiles.size > 0;

		// Fast path: bounds unchanged and only whole tiles were touched. Patch just
		// those tiles. Blitting a tile overwrites all 256x256 of its pixels, so
		// erased pixels inside a touched tile are cleared correctly without having
		// to clear the whole raster first.
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
					// Material tiles appeared for the first time: the untouched area
					// must read as the default material, not as zero.
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

		// Slow path: (re)build the whole raster.
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

		// Copy tile data into flat array
		for (const [key, tile] of this.tiles) {
			this.blitTile(data, tile, key, originX, originY, width);
		}

		// Copy material tiles
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
	 * Copy one 256x256 tile into the flat raster at its world offset.
	 *
	 * Clipped, not assumed to fit. A tile can exist for a pixel that is not a wall
	 * — `setMaterial` allocates its own tiles and does not consult the wall grid —
	 * so a material tile can sit outside the box `bounds` derives from the wall
	 * tiles. Trusting that it fit threw `RangeError: offset is out of bounds` out
	 * of `materialize`, which surfaces as the entire wall layer vanishing on a
	 * stroke rather than as a bad material somewhere.
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
			// Columns of this tile that land inside the raster.
			const srcX0 = Math.max(0, -baseX);
			const srcX1 = Math.min(TILE_SIZE, width - baseX);
			if (srcX1 <= srcX0) continue;
			const rowOff = ly * TILE_SIZE;
			dst.set(tile.subarray(rowOff + srcX0, rowOff + srcX1), dy * width + baseX + srcX0);
		}
	}

	/** Import from a flat Uint8Array with world-space origin offset. */
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
		// The caller's origin is in world units and can be fractional (it comes from
		// the alignment offset), so snap it before it becomes a pixel address. The
		// frame is what keeps the raster the same size when the data is all zeros.
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
	 * Drop every pixel, keeping the raster frame.
	 *
	 * Tiles are never reclaimed individually — erasing a region leaves its
	 * (zeroed) tile in place — so this is the only way to actually shrink the
	 * mask back down.
	 *
	 * The frame deliberately survives. A cleared mask still has to materialise:
	 * with no pixels and no frame, `materialize()` returned null, and callers read
	 * null as "no floorplan here" — so "clear all walls" left the wall editor
	 * holding nothing and swallowed every stroke the user drew afterwards. Use
	 * `setFrame(0, 0, 0, 0)` as well to mean "no raster at all".
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
	 * Mark as dirty so the next materialize() rebuilds the flat array.
	 *
	 * Forces a full rebuild rather than patching touched tiles, because this is
	 * called by callers that mutated tiles directly (and so are not tracked by
	 * the dirty-tile sets).
	 */
	markDirty(): void {
		this.dirty = true;
		this.fullRebuild = true;
	}
}
