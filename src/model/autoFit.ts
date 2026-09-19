"use strict";

/**
 * Pick an opening depth for a hierarchy that is too big to show whole.
 *
 * Zoom and a scale floor stopped the chart rendering as a hairline, but they do
 * not fix the OPENING VIEW: a 169-person org is ~24,500px wide, so even at the
 * floor the first thing on screen is a 9% slice of the middle of the tree, with
 * no visible connection between the root and the cards under it.
 *
 * Every usable org chart opens at the top and lets you expand downward. This
 * finds the deepest level that still fits at a readable scale, so the visual
 * opens on the whole top of the hierarchy — with the `+` toggles showing exactly
 * where the rest is — instead of on an arbitrary middle.
 *
 * Pure: no DOM, no host, no state. The visual decides whether to apply it.
 */

import { Hierarchy } from "./hierarchy";
import { treeLayout, fitTransform, LayoutOptions } from "./treeLayout";

/** Same padding `fitTransform` uses; the two have to agree about the free space. */
const PAD = 16;

/**
 * How far the level gap may be stretched, as a multiple of the card's own depth
 * span. A wide, shallow org can never fill a tall viewport by spacing alone, and
 * a root sitting 1,500px above its reports is not a chart — it is a diagram of
 * nothing.
 *
 * Four is deliberately short of "fill the canvas". Stretching to the edges was
 * tried (OC-008 shipped at ten) and looked wrong: rows marooned at the top and
 * bottom joined by long empty connectors. Proportion beats occupancy — the gap
 * stays related to the card it separates, and any space left over is picked up
 * by growing the cards instead (`maxScale`).
 */
export const MAX_FILL_GAP_FACTOR = 4;

/** Nothing to collapse — the whole tree already fits. */
export const NO_COLLAPSE = -1;

/**
 * The depth whose nodes should be collapsed, so levels `0..depth` stay visible.
 *
 * @param minScale the readable floor the opening view has to clear
 * @returns `NO_COLLAPSE` when the tree fits as it is, otherwise a depth >= 1.
 *          Never 0: collapsing the roots themselves would open on a single card
 *          and hide the entire chart.
 */
export function depthThatFits(
    h: Hierarchy,
    opts: LayoutOptions,
    viewport: { width: number; height: number },
    minScale: number,
): number {
    const n = h.depth.length;
    if (n === 0) return NO_COLLAPSE;

    let maxDepth = 0;
    for (let i = 0; i < n; i++) if (h.depth[i] > maxDepth) maxDepth = h.depth[i];
    if (maxDepth === 0) return NO_COLLAPSE;

    const fitsAt = (depth: number): boolean => {
        const hidden = new Set<number>();
        if (depth >= 0) {
            for (let i = 0; i < n; i++) if (h.depth[i] > depth) hidden.add(i);
        }
        const layout = treeLayout(h, hidden, opts);
        if (layout.placed.length === 0) return true;
        return fitTransform(layout.bounds, viewport).k >= minScale;
    };

    if (fitsAt(maxDepth)) return NO_COLLAPSE;       // the whole tree is fine as it is

    // Deepest level that still clears the floor. Walking down from the root is
    // O(depth) layouts of a tree that shrinks at every step, so this is cheap
    // even at the 500-node cap.
    for (let d = maxDepth - 1; d >= 1; d--) {
        if (fitsAt(d)) return d;
    }
    return 1;
}

/**
 * The level gap to use so the tree fills the viewport it was given.
 *
 * Fit scales on the tighter axis, so a wide, shallow org — the common shape:
 * one CEO, four SVPs, sixteen VPs — fits by WIDTH and then leaves 80% of the
 * height empty, drawn as a thin band floating in the middle of the visual.
 * Nothing is wrong with it; it just wastes the space it was given.
 *
 * Stretching the gap BETWEEN levels uses that space without changing the scale:
 * the depth axis grows to fill the viewport exactly, so the axis that was
 * binding stays binding and the cards stay the size they were.
 *
 * Returns the configured gap unchanged when there is nothing to gain — one
 * level, no spare room, or a tree that already overflows the depth axis.
 *
 * @param minScale the readable floor, so this agrees with what will be drawn
 */
export function fillLevelGap(
    h: Hierarchy,
    hidden: ReadonlySet<number>,
    opts: LayoutOptions,
    viewport: { width: number; height: number },
    minScale: number,
    maxScale = 1,
): number {
    const base = Math.max(0, opts.levelGap);
    const layout = treeLayout(h, hidden, opts);
    if (layout.placed.length === 0) return base;

    const levels = new Set<number>();
    for (let i = 0; i < layout.placed.length; i++) levels.add(h.depth[layout.placed[i]]);
    if (levels.size < 2) return base;              // nothing to space out

    const horizontal = opts.orientation === "leftRight";
    const depthSpan = horizontal ? opts.cardWidth : opts.cardHeight;
    const content = horizontal
        ? layout.bounds.maxX - layout.bounds.minX
        : layout.bounds.maxY - layout.bounds.minY;

    const k = fitTransform(layout.bounds, viewport, PAD, minScale, maxScale).k;
    const available = Math.max(1, (horizontal ? viewport.width : viewport.height) - PAD * 2);
    // The room along the depth axis, in layout units rather than screen pixels.
    const room = (available / k) * 0.98;           // a hair under, so the other axis stays binding
    if (content >= room) return base;              // already full, or overflowing

    const needed = (room - levels.size * depthSpan) / (levels.size - 1);
    return Math.max(base, Math.min(MAX_FILL_GAP_FACTOR * depthSpan, needed));
}


/* ───────────────────────── level sizing ───────────────────────── */

/**
 * Ratios tried, largest first. 2 is the shape the CEO asked for — x → 2x → 4x —
 * and the rest are the graceful way down for a tree too deep or too wide to
 * afford it.
 */
export const LEVEL_RATIOS = [2, 1.7, 1.45, 1.3, 1.18, 1.1] as const;

/**
 * How much bigger the root may be than a leaf, whatever the depth. Without a
 * ceiling a six-level tree at ratio 2 would put a 32× card at the top, which is
 * a billboard, not a chart.
 */
export const MAX_LEVEL_GROWTH = 4;

/** The multiplier for a card at `depth`, given the deepest visible level. */
export function levelScale(depth: number, maxDepth: number, ratio: number): number {
    return Math.pow(ratio, Math.max(0, maxDepth - depth));
}

/** Deepest level actually drawn — hidden branches do not count. */
export function visibleDepth(h: Hierarchy, hidden: ReadonlySet<number>): number {
    let max = 0;
    for (let i = 0; i < h.depth.length; i++) {
        if (!hidden.has(i) && h.depth[i] > max) max = h.depth[i];
    }
    return max;
}

/**
 * Pick the level-size ratio for this hierarchy, this viewport, this card size.
 *
 * Bigger ancestors make the tree wider AND taller, which drives the fitted scale
 * down — so the biggest ratio is not the best one: past a point every card,
 * including the root, ends up smaller than it would have been at ratio 1. This
 * walks down from the CEO's 2× and takes the first ratio whose LEAVES still draw
 * at least as large as the readable floor, so the growth is always paid for out
 * of empty space rather than out of the leaves.
 *
 * Returns 1 when no ratio fits — a uniform chart, exactly as before.
 */
export function levelRatioFor(
    h: Hierarchy,
    hidden: ReadonlySet<number>,
    opts: LayoutOptions,
    viewport: { width: number; height: number },
    minScale: number,
    maxScale = 1,
): number {
    const maxDepth = visibleDepth(h, hidden);
    if (maxDepth === 0) return 1;

    // Both scales are measured WITHOUT the readable floor. With it, a chart that
    // already overflows reads as "0.5 either way" and the comparison below can
    // never fail — which is how 300 people under one manager still got 2× cards.
    const flat = treeLayout(h, hidden, opts);
    if (flat.placed.length === 0) return 1;
    const flatK = fitTransform(flat.bounds, viewport, PAD, 0, maxScale).k;
    // Nothing to give away: the chart is already too big to show at a readable
    // size, so bigger ancestors would only mean more panning.
    if (flatK < minScale) return 1;

    for (const ratio of LEVEL_RATIOS) {
        if (Math.pow(ratio, maxDepth) > MAX_LEVEL_GROWTH) continue;
        const scaled = treeLayout(h, hidden, {
            ...opts, levelScale: (d) => levelScale(d, maxDepth, ratio),
        });
        const k = fitTransform(scaled.bounds, viewport, PAD, 0, maxScale).k;
        // The leaf card pays for the growth, so it must not end up meaningfully
        // smaller than it would have been on a uniform chart.
        if (k >= minScale && k >= flatK * 0.92) return ratio;
    }
    return 1;
}
