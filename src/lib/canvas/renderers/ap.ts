import type { Layer, RenderContext } from '../types.js';
import type { AccessPoint } from '$state/ap-state.svelte.js';
import { channelColor } from '@aetherax/channels';
import { ACCENT } from '../accents.js';

const UNASSIGNED_COLOR = '#6b7185';
const LABEL_COLOR = '#8b8fa3';
const BADGE_BG = 'rgba(0, 0, 0, 0.6)';
const BADGE_TEXT = '#ffffff';
const WALL_LINK_COLOR = 'rgba(75, 227, 160, 0.65)';
const WALL_LINK_TEXT = '#7fd7ae';
/**
 * The colour of the padlock on a pinned AP.
 *
 * Amber rather than the interface's green: the green on this canvas means channels,
 * and a lock drawn in it read as another badge about the radio. This is a statement
 * about the *optimiser*, so it is a colour nothing else on the plan uses.
 */
const PIN_COLOR = '#f0b429';

/**
 * The colour of an access point's marker, wherever it is drawn.
 *
 * One function for the plan and both overviews, because they are the same marker:
 * an overview with a palette of its own drew the plan's green access points in
 * blue, which reads as a different kind of object rather than the same one seen
 * from further away. A channel is what the colour means, so an AP with none is
 * grey in every view.
 */
export function apMarkerColor(ap: { assignedChannel: number | null; band: string }): string {
	return ap.assignedChannel != null
		? channelColor(ap.assignedChannel, ap.band as Parameters<typeof channelColor>[1])
		: UNASSIGNED_COLOR;
}

/**
 * Where an access point sits relative to the nearest wall.
 *
 * The measurement is not made here: `x` and `y` are the nearest wall point in
 * world units and `text` is the caption already converted to the unit system the
 * interface is showing. Both come from the view, which owns the wall mask, the
 * calibration and the units —the renderer only draws what it is handed.
 */
export interface WallDistanceAnnotation {
	x: number;
	y: number;
	text: string;
}

export class ApLayer implements Layer {
	id = 'aps';
	visible = true;
	showLabels: boolean = true;

	aps: AccessPoint[] = [];
	selectedIds: string[] = [];
	hoveredId: string | null = null;
	/**
	 * Nearest-wall annotation per access point id, for the ones that have one.
	 *
	 * Empty whenever the annotation is off, which is the view's decision —see
	 * the note on `WallDistanceAnnotation`.
	 */
	wallDistances: Map<string, WallDistanceAnnotation> = new Map();

	render(rc: RenderContext): void {
		const { ctx, camera } = rc;
		const transform = camera.getTransform();
		const zoom = camera.state.zoom;
		const [a, b, c, d, e, f] = transform;
		ctx.transform(a, b, c, d, e, f);

		const screenScale = 1 / zoom;
		const selectedSet = new Set(this.selectedIds);

		for (const ap of this.aps) {
			const isSelected = selectedSet.has(ap.id);
			const isHovered = this.hoveredId === ap.id;

			const color = apMarkerColor(ap);
			/**
			 * A wall-mounted unit is drawn as the bracket it is: a short thick plate
			 * lying along the wall, with a tick along the direction it faces. A circle
			 * would say "ceiling", and the difference is exactly the thing the marker
			 * has to carry — the same unit hung the other way round is a different
			 * coverage.
			 */
			const onWall = ap.mount === 'wall';

			const radius = 7 * screenScale;

			if (onWall) {
				const facing = (ap.facingDeg * Math.PI) / 180;
				ctx.save();
				ctx.translate(ap.x, ap.y);
				ctx.rotate(facing);
				/*
				 * Local +x is the facing direction, so the plate is thin across it and
				 * long along the wall — the same rounded plate the panel's own drawing
				 * shows, scaled to the marker.
				 */
				ctx.beginPath();
				ctx.roundRect(-4 * screenScale, -9 * screenScale, 8 * screenScale, 18 * screenScale, 2 * screenScale);
				ctx.fillStyle = color;
				ctx.fill();
				ctx.lineWidth = isSelected ? 2.5 * screenScale : 1.5 * screenScale;
				ctx.strokeStyle = isSelected
					? ACCENT
					: isHovered
						? 'rgba(255, 255, 255, 0.15)'
						: 'rgba(255, 255, 255, 0.3)';
				ctx.stroke();
				// The facing tick: which way the unit looks, out of the room side.
				ctx.beginPath();
				ctx.moveTo(4 * screenScale, 0);
				ctx.lineTo(12 * screenScale, 0);
				ctx.lineWidth = 1.5 * screenScale;
				ctx.strokeStyle = WALL_LINK_COLOR;
				ctx.stroke();
				ctx.restore();
			} else {
				// Selection glow
				if (isSelected) {
					ctx.save();
					ctx.shadowBlur = 12 * screenScale;
					ctx.shadowColor = ACCENT;
					ctx.beginPath();
					ctx.arc(ap.x, ap.y, radius, 0, Math.PI * 2);
					ctx.fillStyle = color;
					ctx.fill();
					ctx.restore();
				}

				// Filled circle
				ctx.beginPath();
				ctx.arc(ap.x, ap.y, radius, 0, Math.PI * 2);
				ctx.fillStyle = color;
				ctx.fill();

				// Border ring
				ctx.beginPath();
				ctx.arc(ap.x, ap.y, radius, 0, Math.PI * 2);
				ctx.lineWidth = 1.5 * screenScale;

				if (isSelected) {
					ctx.strokeStyle = ACCENT;
				} else if (isHovered) {
					ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
				} else {
					ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
				}
				ctx.stroke();

				// Hover brightness boost ring
				if (isHovered && !isSelected) {
					ctx.beginPath();
					ctx.arc(ap.x, ap.y, radius + 2 * screenScale, 0, Math.PI * 2);
					ctx.lineWidth = 1 * screenScale;
					ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
					ctx.stroke();
				}
			}

			// Nearest-wall connector and its measurement.
			const wall = this.wallDistances.get(ap.id);
			if (wall) {
				const dx = wall.x - ap.x;
				const dy = wall.y - ap.y;
				const span = Math.hypot(dx, dy);
				const ux = span > 0 ? dx / span : 0;
				const uy = span > 0 ? dy / span : 1;

				// A connector shorter than the dot itself is a smudge on the marker
				// rather than a line, so it is dropped; the caption still shows.
				if (span > radius * 1.5) {
					ctx.save();
					ctx.setLineDash([3 * screenScale, 3 * screenScale]);
					ctx.beginPath();
					ctx.moveTo(ap.x + ux * radius, ap.y + uy * radius);
					ctx.lineTo(wall.x, wall.y);
					ctx.lineWidth = 1 * screenScale;
					ctx.strokeStyle = WALL_LINK_COLOR;
					ctx.stroke();
					ctx.restore();

					/*
					 * A tick across the wall end, so the measurement has a visible
					 * endpoint. Without it the dashes simply stop somewhere inside the
					 * wall's thickness, and the one thing the annotation is for —which
					 * wall, and which point on it —is left to the eye to guess.
					 */
					const tick = 4 * screenScale;
					ctx.beginPath();
					ctx.moveTo(wall.x - uy * tick, wall.y + ux * tick);
					ctx.lineTo(wall.x + uy * tick, wall.y - ux * tick);
					ctx.lineWidth = 1.5 * screenScale;
					ctx.strokeStyle = WALL_LINK_TEXT;
					ctx.stroke();
				}

				if (this.showLabels) {
					/*
					 * The figure goes on a second line under the name, in the one place
					 * an access point's text always is. It used to sit beside the middle
					 * of the connector, which moved with the nearest wall's angle and
					 * distance —so the same AP's reading wandered around its marker,
					 * and the closer the wall the more it collided with the name and the
					 * dot. The connector still shows *which* wall the figure is about.
					 */
					ctx.font = `${9 * screenScale}px monospace`;
					ctx.textAlign = 'center';
					ctx.textBaseline = 'top';
					ctx.fillStyle = WALL_LINK_TEXT;
					ctx.fillText(wall.text, ap.x, ap.y + radius + 16 * screenScale);
				}
			}

			// Name label below the dot
			if (this.showLabels) {
				const fontSize = 10 * screenScale;
				ctx.font = `${fontSize}px monospace`;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'top';
				ctx.fillStyle = LABEL_COLOR;
				ctx.fillText(ap.name, ap.x, ap.y + radius + 4 * screenScale);
			}

			/*
			 * A pinned AP wears a padlock.
			 *
			 * "The optimiser will not move this one" is otherwise invisible on the plan —
			 * the marker and the readouts are identical either way — and the moment it
			 * matters is exactly the moment the optimiser is about to run. Drawn to the
			 * left of the marker, where the channel badge (above right) and the name
			 * (below) are not.
			 */
			if (this.showLabels && ap.pinned) {
				const lockW = 7 * screenScale;
				const lockH = 10 * screenScale;
				const bodyH = 6.2 * screenScale;
				const bodyY = ap.y - radius - lockH + (lockH - bodyH);
				const lx = ap.x - radius - lockW - 3 * screenScale;
				const bodyR = 1.6 * screenScale;
				ctx.beginPath();
				ctx.roundRect(lx, bodyY, lockW, bodyH, bodyR);
				ctx.fillStyle = BADGE_BG;
				ctx.fill();
				ctx.lineWidth = 1.2 * screenScale;
				ctx.strokeStyle = PIN_COLOR;
				ctx.stroke();
				// The shackle: a half circle standing on the body, narrower than it.
				ctx.beginPath();
				ctx.arc(lx + lockW / 2, bodyY, lockW * 0.3, Math.PI, 0);
				ctx.stroke();
			}

			// Channel badge above-right if assigned
			if (this.showLabels && ap.assignedChannel !== null) {
				const badgeText = String(ap.assignedChannel);
				const badgeFontSize = 8 * screenScale;
				ctx.font = `bold ${badgeFontSize}px monospace`;
				const textMetrics = ctx.measureText(badgeText);
				const badgePadX = 3 * screenScale;
				const badgePadY = 2 * screenScale;
				const badgeW = textMetrics.width + badgePadX * 2;
				const badgeH = badgeFontSize + badgePadY * 2;
				const badgeX = ap.x + radius + 2 * screenScale;
				const badgeY = ap.y - radius - badgeH;
				const badgeRadius = 3 * screenScale;

				// Rounded rect
				ctx.beginPath();
				ctx.moveTo(badgeX + badgeRadius, badgeY);
				ctx.lineTo(badgeX + badgeW - badgeRadius, badgeY);
				ctx.arcTo(badgeX + badgeW, badgeY, badgeX + badgeW, badgeY + badgeRadius, badgeRadius);
				ctx.lineTo(badgeX + badgeW, badgeY + badgeH - badgeRadius);
				ctx.arcTo(
					badgeX + badgeW,
					badgeY + badgeH,
					badgeX + badgeW - badgeRadius,
					badgeY + badgeH,
					badgeRadius
				);
				ctx.lineTo(badgeX + badgeRadius, badgeY + badgeH);
				ctx.arcTo(badgeX, badgeY + badgeH, badgeX, badgeY + badgeH - badgeRadius, badgeRadius);
				ctx.lineTo(badgeX, badgeY + badgeRadius);
				ctx.arcTo(badgeX, badgeY, badgeX + badgeRadius, badgeY, badgeRadius);
				ctx.closePath();
				ctx.fillStyle = BADGE_BG;
				ctx.fill();

				// Badge text
				ctx.fillStyle = BADGE_TEXT;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2);
			}
		}
	}
}
