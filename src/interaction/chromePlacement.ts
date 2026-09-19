"use strict";

/**
 * Corner-stacking math for the floating chrome overlays (NG-136). Pure — no DOM and no
 * Power BI imports — so it is deterministic and unit-testable.
 *
 * Three floating pieces can each be pinned to any of the four corners: the quick-action
 * toolbar (fixed top-right), the settings **gear**, and the **view-switch pill**
 * (Graph / Table / Insight). When two land in the same corner they must not overlap, so
 * occupants are laid out along that corner's horizontal edge in a fixed priority order
 * (closest to the edge first): action bar → gear → pill. The legend used to be a fourth
 * occupant here; it now DOCKS to a reserved band instead (see render/legend.ts), so it
 * has no corner to negotiate.
 * Each occupant starts at its own flush inset, or just past the previous occupant —
 * whichever is farther. Widths are fixed constants (the action-bar column is 42px, the
 * collapsed gear 36px) so no `getBBox`/`offsetWidth` measurement is needed and the result
 * is identical under jsdom and a real browser.
 */

export type Corner = "tl" | "tr" | "bl" | "br";
export type CornerPref = "auto" | Corner;

/** Resolve an author preference to a concrete corner (`auto` → the element's default). */
export function resolveCorner(pref: CornerPref, auto: Corner): Corner {
    return pref === "auto" ? auto : pref;
}

/** One box on a corner's horizontal edge: `base` = its own flush inset, `width` = px it
 *  consumes inward. */
export interface Box { base: number; width: number; }

/**
 * Near-edge inset (distance from the corner's vertical edge) for each box, stacked in
 * order. Box 0 sits at its own `base`; each later box at `max(its base, prevFarEdge + gap)`
 * so nothing overlaps and small boxes still respect their own inset when they follow a
 * gap. Returns one inset per input box, in the same order.
 */
export function packCorner(boxes: Box[], gap = 8): number[] {
    const out: number[] = [];
    let edge = -Infinity;
    for (const b of boxes) {
        const near = edge === -Infinity ? b.base : Math.max(b.base, edge + gap);
        out.push(near);
        edge = near + b.width;
    }
    return out;
}

/** The three floating pieces, in edge-outward priority order. */
export type ChromePiece = "actionBar" | "gear" | "pill";

const ORDER: ChromePiece[] = ["actionBar", "gear", "pill"];
/** Flush inset each piece uses when it owns its corner alone (matches the CSS/mirror). */
const BASE: Record<ChromePiece, number> = { actionBar: 10, gear: 18, pill: 10 };
/** Fixed width each piece consumes when another piece must clear it. The pill is only
 *  ever the *last* occupant in the calls below, so its width is never read. */
const WIDTH: Record<ChromePiece, number> = { actionBar: 42, gear: 36, pill: 0 };

export interface ChromeCtx {
    /** The quick-action toolbar occupies the top-right corner (shown & in graph view). */
    actionBar: boolean;
    /** Resolved gear corner, or null when the gear is hidden / not considered. */
    gearCorner: Corner | null;
    /** Resolved pill corner, or null when the pill is hidden / not considered. */
    pillCorner: Corner | null;
    gap?: number;
}

/**
 * The horizontal near-edge inset for `target` at `corner`, after clearing every
 * higher-priority piece that shares the same corner. When `target` sits alone this is
 * just its flush `BASE`, so callers can compare against the default to know whether an
 * override is even needed.
 */
export function cornerInset(corner: Corner, target: ChromePiece, ctx: ChromeCtx): number {
    const boxes: Box[] = [];
    let targetIndex = -1;
    for (const who of ORDER) {
        const atCorner =
            who === "actionBar" ? (ctx.actionBar && corner === "tr") :
            who === "gear" ? ctx.gearCorner === corner :
                ctx.pillCorner === corner;
        if (who === target) targetIndex = boxes.length;
        else if (!atCorner) continue;
        boxes.push({ base: BASE[who], width: WIDTH[who] });
        if (who === target) break; // nothing lower-priority can precede the target
    }
    if (targetIndex < 0) return BASE[target];
    return packCorner(boxes, ctx.gap ?? 8)[targetIndex];
}
