/**
 * The canvas's accent: "this one is the current floor, or the selected object".
 *
 * One colour for every frame, outline, label and highlight that means *active* —
 * the plan's selection rectangle, the wall editor's brush guide, the floor
 * boundary, and the current floor's frame in both overviews. The two overviews
 * used a blue of their own for "current", while the plan used this mint
 * everywhere, so the same building looked like it had two different notions of
 * what was selected depending on which view you were in.
 *
 * It is also the access point's selection glow, which is why it lives here rather
 * than beside any one renderer: the point is that there is one of it.
 */

/** Solid form, for fills and glows. */
export const ACCENT = '#4be3a0';

/** Frame and outline form: visible over both a dark plan and a pale one. */
export const ACCENT_STROKE = 'rgba(75, 227, 160, 0.9)';

/** Label form, lightened so 13px text on the accent stroke is legible. */
export const ACCENT_TEXT = 'rgba(146, 245, 205, 0.95)';
