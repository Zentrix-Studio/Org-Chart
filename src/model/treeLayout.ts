"use strict";

/**
 * Card-aware layered tree layout for a FOREST.
 *
 * Classic leaf-sweep: leaves are placed left to right along the sweep axis at a
 * fixed pitch, and every parent is centred over the span of its own children.
 * Roots are laid out one after another and packed side by side, because real
 * data always produces more than one root.
 *
 * Differences from the Network Graph's `treeLayout.ts`, which this replaces for
 * this visual:
 *   • pitch is derived from the CARD size, not a fixed node radius, so wide
 *     sibling rows lay out correctly instead of overlapping — the documented
 *     failure of "Hierarchy Chart by Akvelon" when many people report to one
 *     manager.
 *   • orientation is a first-class parameter (top-down / left-to-right).
 *   • only VISIBLE nodes participate, so a collapsed branch takes no space.
 *
 * Pure, deterministic, iterative (no recursion — a 500-deep chain is fine), and
 * cannot throw on malformed input.
 */

import { Hierarchy } from "./hierarchy";
import { Orientation } from "../types";

export interface LayoutOptions {
    orientation: Orientation;
    cardWidth: number;
    cardHeight: number;
    /** Gap between depth levels, in px. */
    levelGap: number;
    /** Gap between siblings along the sweep axis, in px. */
    siblingGap: number;
    /**
     * Size multiplier for a card at this depth — 1 everywhere unless the author
     * asks for level sizing, where the root is the biggest card and each level
     * down is smaller. The layout reserves the space each card actually needs,
     * so a parent wider than its children cannot collide with its neighbours.
     */
    levelScale?: (depth: number) => number;
}

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number; }

export interface LayoutResult {
    /** Card CENTRE per node index. Hidden nodes keep NaN and are never drawn. */
    x: Float64Array;
    y: Float64Array;
    /** Card SIZE per node index — the one source of truth for the renderer, so
     *  what is drawn is exactly what the layout reserved. */
    w: Float64Array;
    h: Float64Array;
    bounds: Bounds;
    /** Node indices that were laid out, in draw order (parents before children). */
    placed: number[];
}

const MIN_PITCH = 8;

/**
 * @param h       resolved forest
 * @param hidden  node indices suppressed by a collapsed ancestor
 * @param opts    card geometry
 */
export function treeLayout(h: Hierarchy, hidden: ReadonlySet<number>, opts: LayoutOptions): LayoutResult {
    const n = h.parentIdx.length;
    const x = new Float64Array(n).fill(NaN);
    const y = new Float64Array(n).fill(NaN);
    const w = new Float64Array(n);
    const hh = new Float64Array(n);
    const placed: number[] = [];
    const empty: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    if (n === 0) return { x, y, w, h: hh, bounds: empty, placed };

    const horizontal = opts.orientation === "leftRight";
    const gapSweep = Math.max(0, opts.siblingGap);
    const gapDepth = Math.max(0, opts.levelGap);

    // Per-node card size. A scale of 1 (the default) reproduces the uniform
    // layout exactly, so nothing changes for a chart that does not use it.
    const scaleOf = (i: number): number => {
        if (!opts.levelScale) return 1;
        const s = opts.levelScale(h.depth[i]);
        return isFinite(s) && s > 0 ? s : 1;
    };
    for (let i = 0; i < n; i++) {
        const s = scaleOf(i);
        w[i] = Math.max(MIN_PITCH, opts.cardWidth * s);
        hh[i] = Math.max(MIN_PITCH, opts.cardHeight * s);
    }
    const sweepOf = (i: number): number => (horizontal ? hh[i] : w[i]);
    const depthOf = (i: number): number => (horizontal ? w[i] : hh[i]);

    // Visible children, in input order. A collapsed node keeps its card but
    // contributes no children, so its whole branch costs no space.
    const kidsOf = (i: number): number[] => {
        const src = h.children[i];
        if (!src || src.length === 0) return [];
        const out: number[] = [];
        for (let k = 0; k < src.length; k++) if (!hidden.has(src[k])) out.push(src[k]);
        return out;
    };

    /*
     * Pass 1 — how much room each subtree needs along the sweep axis.
     *
     * `span[i]` is the WIDER of the node's own card and the block its children
     * occupy. Taking the max is what stops a card that is larger than its
     * children — the root under level sizing, or a wide card over two narrow
     * ones — from spilling sideways into the neighbouring subtree. With a
     * uniform card size the max is always the children's block, so this reduces
     * to the original leaf sweep.
     */
    const span = new Float64Array(n);
    for (let r = 0; r < h.roots.length; r++) {
        const root = h.roots[r];
        if (hidden.has(root)) continue;
        const stack: Array<{ i: number; expanded: boolean }> = [{ i: root, expanded: false }];
        while (stack.length) {
            const frame = stack[stack.length - 1];
            if (!frame.expanded) {
                frame.expanded = true;
                const kids = kidsOf(frame.i);
                for (let k = kids.length - 1; k >= 0; k--) stack.push({ i: kids[k], expanded: false });
                continue;
            }
            stack.pop();
            const i = frame.i;
            const kids = kidsOf(i);
            let block = 0;
            for (let k = 0; k < kids.length; k++) {
                block += span[kids[k]] + (k > 0 ? gapSweep : 0);
            }
            span[i] = Math.max(sweepOf(i), block);
        }
    }

    /*
     * Depth-axis offsets. Levels can differ in thickness once cards are sized by
     * level, so each level starts after the tallest card of the level above it
     * rather than at a fixed pitch.
     */
    let maxDepth = 0;
    for (let i = 0; i < n; i++) if (!hidden.has(i) && h.depth[i] > maxDepth) maxDepth = h.depth[i];
    const levelSize = new Float64Array(maxDepth + 1);
    for (let i = 0; i < n; i++) {
        if (hidden.has(i)) continue;
        const d = h.depth[i];
        if (depthOf(i) > levelSize[d]) levelSize[d] = depthOf(i);
    }
    const levelStart = new Float64Array(maxDepth + 1);
    for (let d = 1; d <= maxDepth; d++) {
        levelStart[d] = levelStart[d - 1] + levelSize[d - 1] + gapDepth;
    }

    /*
     * Pass 2 — place each subtree inside the interval pass 1 reserved for it.
     * The node sits in the middle of its own interval; its children are laid out
     * as one centred block inside it. Iterative, so a 5,000-deep chain is fine.
     */
    const sweep = new Float64Array(n).fill(NaN);
    let cursor = 0;
    for (let r = 0; r < h.roots.length; r++) {
        const root = h.roots[r];
        if (hidden.has(root)) continue;
        const stack: Array<{ i: number; start: number }> = [{ i: root, start: cursor }];
        while (stack.length) {
            const { i, start } = stack.pop() as { i: number; start: number };
            sweep[i] = start + span[i] / 2;
            const kids = kidsOf(i);
            if (kids.length === 0) continue;
            let block = 0;
            for (let k = 0; k < kids.length; k++) block += span[kids[k]] + (k > 0 ? gapSweep : 0);
            let at = start + (span[i] - block) / 2;
            // Push in reverse so the first child is popped first and order is stable.
            const frames: Array<{ i: number; start: number }> = [];
            for (let k = 0; k < kids.length; k++) {
                frames.push({ i: kids[k], start: at });
                at += span[kids[k]] + gapSweep;
            }
            for (let k = frames.length - 1; k >= 0; k--) stack.push(frames[k]);
        }
        // Breathing room between separate roots so a forest does not read as one tree.
        cursor += span[root] + Math.max(gapSweep, sweepOf(root) * 0.5);
    }

    // Project sweep/depth onto x/y, and collect draw order (parents first).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const queue: number[] = [];
    for (let r = 0; r < h.roots.length; r++) if (!hidden.has(h.roots[r])) queue.push(h.roots[r]);
    let head = 0;
    while (head < queue.length) {
        const i = queue[head++];
        const s = sweep[i];
        if (!isFinite(s)) continue;
        const d = levelStart[h.depth[i]] + levelSize[h.depth[i]] / 2;
        const cx = horizontal ? d : s;
        const cy = horizontal ? s : d;
        x[i] = cx; y[i] = cy;
        placed.push(i);
        if (cx - w[i] / 2 < minX) minX = cx - w[i] / 2;
        if (cy - hh[i] / 2 < minY) minY = cy - hh[i] / 2;
        if (cx + w[i] / 2 > maxX) maxX = cx + w[i] / 2;
        if (cy + hh[i] / 2 > maxY) maxY = cy + hh[i] / 2;
        const kids = kidsOf(i);
        for (let k = 0; k < kids.length; k++) queue.push(kids[k]);
    }

    if (placed.length === 0) return { x, y, w, h: hh, bounds: empty, placed };
    return { x, y, w, h: hh, bounds: { minX, minY, maxX, maxY }, placed };
}

/**
 * Scale + translate that fits `bounds` inside a viewport, capped at 1:1.
 *
 * `minScale` puts a FLOOR under the result, and it is the whole point of this
 * signature. Without one, fit is not a viewing model: a 169-person org lays out
 * ~24,500px wide, so fitting it into a 1,140px visual returns 0.045 and draws a
 * 7.6 × 2.6px card with 0.6px text — the chart shrank with every person added
 * and there was no way back in. Below the floor the view stops shrinking and
 * anchors to the TOP of the tree instead of centring it, so the root is on
 * screen and the rest is a pan away (see interaction/zoomPan.ts).
 *
 * `maxScale` is the other half of the same idea. Capping at 1:1 means a small
 * hierarchy in a large visual draws 168px cards in the middle of an empty
 * canvas with the names set in 12px type, because "fit" was only ever allowed to
 * shrink. Above 1 the cards and their text grow together — it is the same chart,
 * read from closer.
 */
export function fitTransform(
    bounds: Bounds,
    viewport: { width: number; height: number },
    padding = 16,
    minScale = 0,
    maxScale = 1,
): { k: number; tx: number; ty: number; floored: boolean } {
    const w = Math.max(1, bounds.maxX - bounds.minX);
    const h = Math.max(1, bounds.maxY - bounds.minY);
    const vw = Math.max(1, viewport.width - padding * 2);
    const vh = Math.max(1, viewport.height - padding * 2);
    const fitted = Math.min(Math.max(1, maxScale), vw / w, vh / h);
    const k = Math.max(fitted, Math.min(1, minScale));
    const floored = k > fitted;
    const tx = padding + (vw - w * k) / 2 - bounds.minX * k;
    // Centring a tree that no longer fits would put its middle on screen and
    // the root off it. Anchor to the top edge instead.
    const ty = floored
        ? padding - bounds.minY * k
        : padding + (vh - h * k) / 2 - bounds.minY * k;
    // `floored` means the tree is larger than the viewport at the smallest
    // readable scale — i.e. what is drawn is a crop. The caller says so on
    // screen; silently cropping is what OC-QA-02 was.
    return { k, tx, ty, floored };
}


/* ───────────────────────── fitting around chrome ───────────────────────── */

/** A rectangle in viewport pixels (x, y = top-left). */
export interface ScreenRect { x: number; y: number; w: number; h: number; }

/** Card rectangles in LAYOUT units, from a layout result. */
export function cardRects(layout: LayoutResult): ScreenRect[] {
    return layout.placed.filter((i) => isFinite(layout.x[i])).map((i) => ({
        x: layout.x[i] - layout.w[i] / 2, y: layout.y[i] - layout.h[i] / 2, w: layout.w[i], h: layout.h[i],
    }));
}

/**
 * `fitTransform`, but no card may end up under the visual's own chrome.
 *
 * The search box, the gear and the zoom buttons float over the chart. A plain fit
 * centres the tree in the whole viewport, so on a forest, a cycle set or any tile
 * the top row slid under the search box and the gear, and the bottom-right card
 * under the zoom stack — at a 280×180 tile the root itself was hidden (OC-028).
 *
 * Fit first; while a card collides with an obstacle, give up the cheapest strip
 * of the viewport that clears it — above, below, left or right of it, whichever
 * keeps the largest scale — and fit again. A single-root chart whose top row sits
 * clear of the corners keeps exactly the fit it had. Bounded: one strip per
 * obstacle, so it terminates.
 */
export function fitAvoiding(
    bounds: Bounds,
    cards: readonly ScreenRect[],
    viewport: { width: number; height: number },
    obstacles: readonly ScreenRect[],
    padding = 16,
    maxScale = 1,
): { k: number; tx: number; ty: number } {
    const GAP = 4;
    const fitIn = (ins: { t: number; r: number; b: number; l: number }): { k: number; tx: number; ty: number } => {
        const f = fitTransform(bounds, {
            width: Math.max(1, viewport.width - ins.l - ins.r),
            height: Math.max(1, viewport.height - ins.t - ins.b),
        }, padding, 0, maxScale);
        return { k: f.k, tx: f.tx + ins.l, ty: f.ty + ins.t };
    };
    const hits = (t: { k: number; tx: number; ty: number }, o: ScreenRect): boolean => cards.some((c) => {
        const x = c.x * t.k + t.tx, y = c.y * t.k + t.ty, w = c.w * t.k, h = c.h * t.k;
        return x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y;
    });
    const live = obstacles.filter((o) => o.w > 0 && o.h > 0);
    let ins = { t: 0, r: 0, b: 0, l: 0 };
    let t = fitIn(ins);
    const cleared = new Set<number>();
    for (let guard = 0; guard < live.length; guard++) {
        const idx = live.findIndex((o, i) => !cleared.has(i) && hits(t, o));
        if (idx < 0) break;
        cleared.add(idx);
        const o = live[idx];
        const need = (px: number): number => Math.max(0, px + GAP - padding);
        const options = [
            { ...ins, t: Math.max(ins.t, need(o.y + o.h)) },
            { ...ins, b: Math.max(ins.b, need(viewport.height - o.y)) },
            { ...ins, l: Math.max(ins.l, need(o.x + o.w)) },
            { ...ins, r: Math.max(ins.r, need(viewport.width - o.x)) },
        ].filter((c) => viewport.width - c.l - c.r > padding * 2 + 8 && viewport.height - c.t - c.b > padding * 2 + 8);
        if (!options.length) break;
        let best = options[0], bestT = fitIn(best);
        for (const c of options.slice(1)) {
            const ct = fitIn(c);
            if (ct.k > bestT.k + 1e-9) { best = c; bestT = ct; }
        }
        ins = best; t = bestT;
    }
    return t;
}
