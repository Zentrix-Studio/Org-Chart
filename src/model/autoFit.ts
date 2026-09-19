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
import { treeLayout, fitTransform, LayoutOptions, LayoutResult, stackableShape } from "./treeLayout";

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
 * The on-screen scale of a laid-out tree. The visual passes one that fits around
 * its own chrome (`fitAvoiding`), so every decision below is made against the
 * view the reader will actually get; the default is the plain fit.
 */
export type FitScale = (layout: LayoutResult) => number;

/** Plain fit, for callers (and tests) with no chrome to steer around. */
export function plainFit(viewport: { width: number; height: number }, maxScale = 1): FitScale {
    return (layout) => fitTransform(layout.bounds, viewport, PAD, 0, maxScale).k;
}

/** Picks the stacking / wrapping for a given set of hidden nodes. */
export type Arrange = (hidden: ReadonlySet<number>) => LayoutOptions;

/**
 * The depth whose nodes should be collapsed, so levels `0..depth` stay visible.
 *
 * Walks DOWN from the roots and stops at the first level that no longer clears
 * the floor, so the cost is a handful of layouts of a mostly-hidden tree even on
 * a 36,000-row org (the old walk started from the whole tree).
 *
 * @param minScale the readable floor the opening view has to clear — since
 *                 OC-030 the scale at which the smallest name is 9px on screen
 * @param fit      the scale a layout will be drawn at (default: plain fit)
 * @param arrange  how to lay out each candidate — stacking and wrapping change
 *                 what fits, so they are chosen per candidate (default: as is)
 * @returns `NO_COLLAPSE` when the tree fits as it is, otherwise the depth to
 *          collapse at. 0 is allowed (OC-030, zentrix-org-chart#1): when not even
 *          the first level fits, the chart opens on its roots, each with a count
 *          of what is under it, rather than on a row of unreadable cards.
 */
export function depthThatFits(
    h: Hierarchy,
    opts: LayoutOptions,
    viewport: { width: number; height: number },
    minScale: number,
    fit?: FitScale,
    arrange?: Arrange,
): number {
    const n = h.depth.length;
    if (n === 0) return NO_COLLAPSE;

    let maxDepth = 0;
    for (let i = 0; i < n; i++) if (h.depth[i] > maxDepth) maxDepth = h.depth[i];
    if (maxDepth === 0) return NO_COLLAPSE;

    const scaleOf = fit ?? ((l: LayoutResult) => fitTransform(l.bounds, viewport).k);
    const fitsAt = (depth: number): boolean => {
        const hidden = new Set<number>();
        for (let i = 0; i < n; i++) if (h.depth[i] > depth) hidden.add(i);
        const layout = treeLayout(h, hidden, arrange ? arrange(hidden) : opts);
        if (layout.placed.length === 0) return true;
        return scaleOf(layout) >= minScale - 1e-9;
    };

    // Deeper never makes the tree smaller, so the first level that breaks the
    // floor ends the walk.
    for (let d = 0; d <= maxDepth; d++) {
        if (fitsAt(d)) continue;
        return Math.max(0, d - 1);
    }
    return NO_COLLAPSE;
}

/** How leaf reports are laid out: "Leaf reports" in Layout. */
export type LeafMode = "auto" | "row" | "stacked";

/** Column counts worth trying: every count up to 8, then a coarse ladder. */
function candidates(limit: number): number[] {
    const out: number[] = [];
    for (let c = 1; c <= Math.min(8, limit); c++) out.push(c);
    for (const c of [10, 12, 16, 20, 24, 32, 48, 64, 96, 128, 192, 256]) if (c <= limit) out.push(c);
    return out;
}

/**
 * Choose how many columns a stacked leaf group may use, for this tree, this
 * viewport and this card: the count that draws the chart largest (OC-030).
 *
 * Ties go to MORE columns — the closer to the familiar single row — and in Auto
 * to no stacking at all, so a team that already fits keeps looking exactly as it
 * did. Auto stacks groups of five or more; groups of two to four stack only when
 * nothing else gets the names to the floor.
 */
export function chooseLeafStack(
    h: Hierarchy,
    hidden: ReadonlySet<number>,
    opts: LayoutOptions,
    fit: FitScale,
    mode: LeafMode,
    minScale = 0,
): { leafStack: number; leafStackMin: number } {
    const none = { leafStack: 0, leafStackMin: 2 };
    if (mode === "row") return none;
    const shape = stackableShape(h, hidden);
    if (shape.maxGroup < 2) return none;

    const tryMin = (min: number, start: { k: number; pick: { leafStack: number; leafStackMin: number } }) => {
        let best = start;
        const cs = candidates(shape.maxGroup - 1).reverse();       // most columns first
        for (const c of cs) {
            const k = fit(treeLayout(h, hidden, { ...opts, leafStack: c, leafStackMin: min }));
            if (k > best.k * 1.005) best = { k, pick: { leafStack: c, leafStackMin: min } };
        }
        return best;
    };

    if (mode === "stacked") {
        return tryMin(2, { k: -Infinity, pick: none }).pick;
    }
    const row = { k: fit(treeLayout(h, hidden, { ...opts, leafStack: 0 })), pick: none };
    let best = shape.maxGroup >= 5 ? tryMin(5, row) : row;
    if (best.k < minScale && shape.smallGroups) best = tryMin(2, best);
    return best.pick;
}

/**
 * Forests wrap (OC-030): how many roots to set side by side before starting a
 * new shelf. Twenty-five roots in one line is what a department filter produces,
 * and at any scale that is a strip. Ties go to the single line.
 */
export function chooseRootsPerRow(
    h: Hierarchy,
    hidden: ReadonlySet<number>,
    opts: LayoutOptions,
    fit: FitScale,
): number {
    const roots = stackableShape(h, hidden).roots;
    if (roots < 2) return 0;
    let best = { k: fit(treeLayout(h, hidden, { ...opts, rootsPerRow: 0 })), perRow: 0 };
    for (const r of candidates(roots - 1).reverse()) {
        const k = fit(treeLayout(h, hidden, { ...opts, rootsPerRow: r }));
        if (k > best.k * 1.005) best = { k, perRow: r };
    }
    return best.perRow;
}

/** Stacking, then wrapping, for one hidden set — what `depthThatFits` tries per level. */
export function arrangeFor(
    h: Hierarchy,
    opts: LayoutOptions,
    fit: FitScale,
    mode: LeafMode,
    minScale = 0,
): Arrange {
    return (hidden) => {
        const stacked = { ...opts, ...chooseLeafStack(h, hidden, opts, fit, mode, minScale) };
        return { ...stacked, rootsPerRow: chooseRootsPerRow(h, hidden, stacked, fit) };
    };
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
    fit?: FitScale,
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

    // Every extra px of gap moves the deepest content by at most (levels - 1) px,
    // so this can never push the depth axis past the room. (It used to assume the
    // content was exactly levels × card, which a stacked block — deeper than its
    // own level — is not.)
    const needed = base + (room - content) / (levels.size - 1);
    let gap = Math.max(base, Math.min(MAX_FILL_GAP_FACTOR * depthSpan, needed));
    // The real fit steers around the visual's chrome, which can take room on the
    // depth axis that the plain fit above does not know about. Stretching into it
    // would shrink every card, so back off until it costs nothing.
    if (fit && gap > base) {
        const kBase = fit(layout);
        for (let tries = 0; tries < 8 && gap > base; tries++) {
            if (fit(treeLayout(h, hidden, { ...opts, levelGap: gap })) >= kBase * 0.995) break;
            gap = base + (gap - base) / 2;
            if (gap - base < 1) gap = base;
        }
    }
    return gap;
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
    fit?: FitScale,
): number {
    const maxDepth = visibleDepth(h, hidden);
    const scaleOf = fit ?? plainFit(viewport, maxScale);
    if (maxDepth === 0) return 1;

    // Both scales are measured WITHOUT the readable floor. With it, a chart that
    // already overflows reads as "0.5 either way" and the comparison below can
    // never fail — which is how 300 people under one manager still got 2× cards.
    const flat = treeLayout(h, hidden, opts);
    if (flat.placed.length === 0) return 1;
    const flatK = scaleOf(flat);
    // Nothing to give away: the chart is already too big to show at a readable
    // size, so bigger ancestors would only mean more panning.
    if (flatK < minScale) return 1;

    for (const ratio of LEVEL_RATIOS) {
        if (Math.pow(ratio, maxDepth) > MAX_LEVEL_GROWTH) continue;
        const scaled = treeLayout(h, hidden, {
            ...opts, levelScale: (d) => levelScale(d, maxDepth, ratio),
        });
        const k = scaleOf(scaled);
        // The leaf card pays for the growth, so it must not end up meaningfully
        // smaller than it would have been on a uniform chart.
        if (k >= minScale && k >= flatK * 0.92) return ratio;
    }
    return 1;
}
