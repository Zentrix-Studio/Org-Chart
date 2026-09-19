/**
 * The end-gutter contract — one number for every scrollable surface in the visual.
 *
 * Reported repeatedly by the CEO: scroll a settings surface to its end and the LAST
 * control sits flush against (or half under) the container's rounded edge, so it reads
 * as sliced even though it is technically reachable. The cause was never one bug — it
 * was that each scroller had invented its own bottom padding: 20px on the gear card,
 * 12px on the rules body, 10px on the search results, 7px on the rules dropdown, 5px on
 * the icon grid, 4px on the font/select list. The thin ones look cropped; the generous
 * ones don't.
 *
 * So the rule is now a contract, not a per-surface judgement call:
 *
 *   EVERY element that can scroll vertically reserves an end gutter — real
 *   `padding-block-end` (which Chromium, and therefore Power BI Desktop's WebView2,
 *   includes in scrollable overflow) plus a matching `scroll-padding-block-end` so
 *   programmatic `scrollIntoView` lands with the same breathing room.
 *
 * Two sizes only, by surface weight:
 *   - `PANEL_END_GUTTER` — big bodies a reader scrolls through (the gear card's detail
 *     pane, the rules panel body, the node detail panel, the landing copy, the summary
 *     and insight pages).
 *   - `LIST_END_GUTTER` — dense option surfaces inside a popover (font/select lists, the
 *     icon grid, search results, the rules dropdown). A panel-sized gutter under a 26px
 *     option row reads as a rendering gap, so these get a smaller — but still obvious —
 *     one.
 *
 * Never hard-code a bottom padding on a scroller; import from here. `test/scrollGutter.test.ts`
 * asserts every known surface against these numbers.
 */

/** End gutter for a scrolling panel/page body, in px. */
export const PANEL_END_GUTTER = 28;

/** End gutter for a scrolling option list / grid inside a popover, in px. */
export const LIST_END_GUTTER = 14;

/**
 * The two declarations a scroller needs, ready to concatenate into a `cssText` string.
 * `startPad` is the surface's own top padding — passed through so the shorthand it
 * replaces keeps its original top value.
 */
export function endGutterCss(gutter: number, startPad = 0): string {
    return `padding-bottom:${gutter}px;scroll-padding-block:${startPad}px ${gutter}px;`;
}

/* ───────────── expanded option surfaces (select / font list, icon grid) ───────────── */

/**
 * An expanded option surface is laid out INSIDE the scrolling detail pane, so its own
 * `max-height` has to answer to the pane's height — not to a constant. The CSS constants
 * (156px list / 204px grid) are taller than the pane itself on a short tile, which is why
 * "the last option is half cropped" came back every time the visual got shorter and went
 * away at full height.
 *
 * `EXPANSION_RESERVE` is what the pane must keep for everything sharing it with the open
 * surface: the trigger row above it (~40px), the flex gap (12px), the expansion box's own
 * padding (12px, `.zsb-field-exp`) and the pane's end gutter.
 */
export const EXPANSION_RESERVE = 40 + 12 + 12 + PANEL_END_GUTTER;

/** Floor for a clamped option surface: ~2.5 option rows. Low on purpose — it only binds on
 *  the shortest tile (a 237px pane) under a field whose label + description already spend
 *  ~134px, and a floor above that leaves the list's end hanging past the pane edge, which
 *  is the very "half-cropped last option" this clamp exists to prevent. */
export const OPTION_SURFACE_MIN = 72;

/** Baseline (small-tile) heights, matching the CSS the surfaces ship with. On a taller
 *  pane these are only the FLOOR of the preference — see `OPTION_SURFACE_SHARE`. */
export const LIST_SURFACE_MAX = 156;
export const GRID_SURFACE_MAX = 204;

/**
 * Share of the detail pane an expanded option surface may occupy on a roomy tile.
 *
 * The 156/204px baselines were sized for the shortest tile we support, and then applied
 * at EVERY tile — so on a tall visual a 20-option list still scrolled inside a 156px
 * window with ~600px of empty pane beneath it. The cap now scales with the pane that has
 * to contain it (the pane IS the host height minus the bar strip and the card chrome, so
 * this is "a share of the visual" expressed in the only container that can clip it), and
 * the pane clamp below still has the final word — which is what keeps the last option
 * whole rather than sliced.
 */
export const OPTION_SURFACE_SHARE = 0.55;

/** Absolute ceiling for a scaled surface. A dropdown taller than this stops reading as a
 *  list and starts reading as a second panel, however much room the tile has. */
export const OPTION_SURFACE_CEILING = 420;

/**
 * How tall an expanded option surface may be inside a pane of `paneHeight`.
 * `paneHeight` is null where layout is unavailable (jsdom) — then the baseline height
 * stands, exactly as the CSS would have applied it.
 */
export function optionSurfaceMaxHeight(preferred: number, paneHeight: number | null): number {
    if (paneHeight == null) return preferred;
    const want = Math.min(
        OPTION_SURFACE_CEILING,
        Math.max(preferred, Math.round(paneHeight * OPTION_SURFACE_SHARE)),
    );
    return Math.max(OPTION_SURFACE_MIN, Math.min(want, paneHeight - EXPANSION_RESERVE));
}
