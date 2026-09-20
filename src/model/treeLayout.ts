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
    /**
     * Stack leaf reports (OC-030, zentrix-org-chart#1). When every visible child
     * of a manager is a leaf, those children are laid out as a block of at most
     * this many columns under the manager, hung off a spine, instead of one row.
     * 0 / undefined / Infinity = never stack — the one-row layout, unchanged.
     */
    leafStack?: number;
    /** Smallest leaf group that stacks. Default 2. */
    leafStackMin?: number;
    /**
     * Forests wrap (OC-030): at most this many roots side by side before the
     * next root starts a new shelf below. undefined / Infinity = one line.
     */
    rootsPerRow?: number;
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
    /**
     * Stacked children only (NaN otherwise): where the connector's spine runs
     * (sweep axis) and where the bus from the manager crosses to it (depth axis),
     * both in layout units. The renderer draws a stacked child's connector from
     * these instead of the parent-to-child elbow, which would cut across the rows.
     */
    spine: Float64Array;
    bus: Float64Array;
}

const MIN_PITCH = 8;

/** Radius the collapse toggle reaches past a card's edge, at a card scale. Kept
 *  in step with `render/tree.ts` so a stacked row always clears the toggle of the
 *  card above it. */
export function toggleReach(scale: number): number {
    return 9 * Math.min(1.6, Math.max(1, scale));
}

/** Room left for the spine beside a column of stacked cards. */
export function spineIndent(cardSweep: number): number {
    return Math.max(16, cardSweep * 0.12);
}

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
    const spine = new Float64Array(n).fill(NaN);
    const bus = new Float64Array(n).fill(NaN);
    const placed: number[] = [];
    const empty: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    if (n === 0) return { x, y, w, h: hh, bounds: empty, placed, spine, bus };

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
     * Leaf stacking. A manager whose visible reports are ALL leaves (no visible
     * children of their own — a real leaf, or a collapsed manager) gets them as a
     * block of `columnsOf` columns instead of one row. This is the whole answer
     * to "21 reports make every name 3px": one row of 21 is 3,928px wide, five
     * columns of five are ~990px. A group that would fit in one row anyway is
     * never stacked, so a small team looks exactly as it always did.
     */
    const maxCols = opts.leafStack && isFinite(opts.leafStack) ? Math.max(1, Math.floor(opts.leafStack)) : 0;
    const minGroup = Math.max(2, opts.leafStackMin ?? 2);
    const columnsOf = (kids: number[]): number => {
        if (maxCols === 0 || kids.length < minGroup || maxCols >= kids.length) return 0;
        for (let k = 0; k < kids.length; k++) if (kidsOf(kids[k]).length > 0) return 0;
        return maxCols;
    };
    const maxSweepOf = (kids: number[]): number => {
        let m = 0;
        for (let k = 0; k < kids.length; k++) m = Math.max(m, sweepOf(kids[k]));
        return m;
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
    const blockOf = (kids: number[]): number => {
        const c = columnsOf(kids);
        if (c > 0) return c * (spineIndent(maxSweepOf(kids)) + maxSweepOf(kids)) + (c - 1) * gapSweep;
        let block = 0;
        for (let k = 0; k < kids.length; k++) block += span[kids[k]] + (k > 0 ? gapSweep : 0);
        return block;
    };
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
            span[i] = Math.max(sweepOf(i), blockOf(kidsOf(i)));
        }
    }

    /*
     * Depth-axis offsets. Levels can differ in thickness once cards are sized by
     * level, so each level starts after the tallest card of the level above it
     * rather than at a fixed pitch. A stacked block runs deeper than its level,
     * but only inside its own sweep interval, which no other subtree shares — so
     * it never pushes the next level down.
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
    const levelMid = (d: number): number => levelStart[d] + levelSize[d] / 2;

    /*
     * Pass 2 — place each subtree inside the interval pass 1 reserved for it.
     * The node sits in the middle of its own interval; its children are laid out
     * as one centred block inside it. Iterative, so a 5,000-deep chain is fine.
     */
    const sweep = new Float64Array(n).fill(NaN);
    const depthPos = new Float64Array(n).fill(NaN);
    const rootOf = new Int32Array(n).fill(-1);
    const rootStart: number[] = [];
    const visibleRoots: number[] = [];
    let cursor = 0;
    for (let r = 0; r < h.roots.length; r++) {
        const root = h.roots[r];
        if (hidden.has(root)) continue;
        visibleRoots.push(root);
        rootStart.push(cursor);
        depthPos[root] = levelMid(h.depth[root]);
        const stack: Array<{ i: number; start: number }> = [{ i: root, start: cursor }];
        while (stack.length) {
            const { i, start } = stack.pop() as { i: number; start: number };
            rootOf[i] = root;
            sweep[i] = start + span[i] / 2;
            const kids = kidsOf(i);
            if (kids.length === 0) continue;
            const c = columnsOf(kids);
            if (c > 0) {
                // A block of `c` columns, filled row by row so ←/→ still walks
                // the reports in their order. Each column hangs off its own spine.
                const cs = maxSweepOf(kids);
                const indent = spineIndent(cs);
                const block = c * (indent + cs) + (c - 1) * gapSweep;
                const at = start + (span[i] - block) / 2;
                const d = h.depth[kids[0]];
                // A collapsed card's toggle hangs off its bottom edge (top-down) or
                // its right edge as a pill up to four radii wide (left-right); the
                // next row starts clear of it.
                const reach = toggleReach(scaleOf(kids[0])) * (horizontal ? 2 : 1);
                const rowGap = Math.max(gapSweep, reach + 8);
                const pitch = levelSize[d] + rowGap;
                const busAt = (depthPos[i] + depthOf(i) / 2 + levelStart[d]) / 2;
                for (let k = 0; k < kids.length; k++) {
                    const col = k % c, row = Math.floor(k / c);
                    const lane = at + col * (indent + cs + gapSweep);
                    const kid = kids[k];
                    rootOf[kid] = root;
                    sweep[kid] = lane + indent + cs / 2;
                    depthPos[kid] = levelMid(d) + row * pitch;
                    spine[kid] = lane + indent / 2;
                    bus[kid] = busAt;
                }
                continue;
            }
            let block = 0;
            for (let k = 0; k < kids.length; k++) block += span[kids[k]] + (k > 0 ? gapSweep : 0);
            let at = start + (span[i] - block) / 2;
            // Push in reverse so the first child is popped first and order is stable.
            const frames: Array<{ i: number; start: number }> = [];
            for (let k = 0; k < kids.length; k++) {
                depthPos[kids[k]] = levelMid(h.depth[kids[k]]);
                frames.push({ i: kids[k], start: at });
                at += span[kids[k]] + gapSweep;
            }
            for (let k = frames.length - 1; k >= 0; k--) stack.push(frames[k]);
        }
        // Breathing room between separate roots so a forest does not read as one tree.
        cursor += span[root] + Math.max(gapSweep, sweepOf(root) * 0.5);
    }

    /*
     * Forests wrap. Twenty-five roots in one line — a filter that orphans a
     * department does exactly that — draw as a strip too long to read at any
     * scale. With `rootsPerRow` set they fill shelves instead, each shelf as deep
     * as its deepest subtree. Every node moves with its root, so nothing inside a
     * subtree changes shape.
     */
    const perRow = opts.rootsPerRow && isFinite(opts.rootsPerRow) ? Math.max(1, Math.floor(opts.rootsPerRow)) : 0;
    if (perRow > 0 && visibleRoots.length > perRow) {
        const reach = new Map<number, number>();
        for (let i = 0; i < n; i++) {
            if (rootOf[i] < 0) continue;
            const end = depthPos[i] + depthOf(i) / 2;
            if (end > (reach.get(rootOf[i]) ?? -Infinity)) reach.set(rootOf[i], end);
        }
        const dSweep = new Map<number, number>();
        const dDepth = new Map<number, number>();
        let shelfTop = 0, shelfDeep = 0, at = 0;
        for (let r = 0; r < visibleRoots.length; r++) {
            const root = visibleRoots[r];
            if (r > 0 && r % perRow === 0) {
                shelfTop += shelfDeep + gapDepth;
                shelfDeep = 0;
                at = 0;
            }
            dSweep.set(root, at - rootStart[r]);
            dDepth.set(root, shelfTop);
            shelfDeep = Math.max(shelfDeep, reach.get(root) ?? 0);
            at += span[root] + Math.max(gapSweep, sweepOf(root) * 0.5);
        }
        for (let i = 0; i < n; i++) {
            const root = rootOf[i];
            if (root < 0) continue;
            const ds = dSweep.get(root) ?? 0, dd = dDepth.get(root) ?? 0;
            sweep[i] += ds;
            depthPos[i] += dd;
            if (isFinite(spine[i])) { spine[i] += ds; bus[i] += dd; }
        }
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
        const d = depthPos[i];
        const cx = horizontal ? d : s;
        const cy = horizontal ? s : d;
        x[i] = cx; y[i] = cy;
        placed.push(i);
        if (cx - w[i] / 2 < minX) minX = cx - w[i] / 2;
        if (cy - hh[i] / 2 < minY) minY = cy - hh[i] / 2;
        if (cx + w[i] / 2 > maxX) maxX = cx + w[i] / 2;
        if (cy + hh[i] / 2 > maxY) maxY = cy + hh[i] / 2;
        // A stacked card's spine runs beside it, outside the card: the fit has
        // to include it or the first column's connector hugs the canvas edge.
        if (isFinite(spine[i])) {
            if (horizontal) { if (spine[i] < minY) minY = spine[i]; } else if (spine[i] < minX) minX = spine[i];
        }
        const kids = kidsOf(i);
        for (let k = 0; k < kids.length; k++) queue.push(kids[k]);
    }

    if (placed.length === 0) return { x, y, w, h: hh, bounds: empty, placed, spine, bus };
    return { x, y, w, h: hh, bounds: { minX, minY, maxX, maxY }, placed, spine, bus };
}

/** Largest group of all-leaf siblings the layout could stack, and how many roots show. */
export function stackableShape(h: Hierarchy, hidden: ReadonlySet<number>): { maxGroup: number; smallGroups: boolean; roots: number } {
    let maxGroup = 0, smallGroups = false, roots = 0;
    const visibleKids = (i: number): number => {
        let c = 0;
        for (const k of h.children[i]) if (!hidden.has(k)) c++;
        return c;
    };
    for (const r of h.roots) if (!hidden.has(r)) roots++;
    for (let i = 0; i < h.parentIdx.length; i++) {
        if (hidden.has(i)) continue;
        const kids = h.children[i].filter((k) => !hidden.has(k));
        if (kids.length < 2) continue;
        if (kids.some((k) => visibleKids(k) > 0)) continue;
        if (kids.length > maxGroup) maxGroup = kids.length;
        if (kids.length <= 4) smallGroups = true;
    }
    return { maxGroup, smallGroups, roots };
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
    minScale = 0,
    anchor: ScreenRect | null = null,
): { k: number; tx: number; ty: number; floored: boolean } {
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
    /*
     * One strip per obstacle, and none is revisited — and that is sound, not a
     * shortcut (re-confirmed OC-036). Every inset is taken with `Math.max`, so a
     * strip only ever moves cards AWAY from the obstacle it was cut for; an
     * obstacle already given one cannot be collided with again. A revisiting
     * loop was written, then reverted: 300,000 random bounds / card / obstacle
     * arrangements produced no case where it cleared a collision this does not.
     */
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
    const floor = Math.min(Math.max(1, maxScale), minScale);
    if (!(t.k < floor - 1e-9)) return { ...t, floored: false };

    /*
     * The legibility floor (OC-030, zentrix-org-chart#1). The whole chart does not
     * fit at a size where the smallest name reads (9px), so the view stops
     * shrinking there and shows the part that matters first — the roots — inside
     * the same chrome-free box. Along each axis: centre the content if it fits,
     * otherwise centre the roots and slide back until no empty canvas shows past
     * the chart's own edge. The caller shows the pan cue, because this is a crop.
     */
    const k = floor;
    // A crop has cards under every corner, so the obstacle loop above (which
    // clears only the cards of the unfloored fit) says nothing about it. Each
    // piece of chrome reserves the cheapest edge band instead — the pill and the
    // gear the top, the zoom stack the right — so the anchored roots are never
    // drawn under them (seen at 610×680: the root sat under the view switch).
    for (const o of live) {
        const need = (px: number): number => Math.max(0, px + GAP - padding);
        const sides = [
            { side: "t" as const, v: need(o.y + o.h) },
            { side: "b" as const, v: need(viewport.height - o.y) },
            { side: "l" as const, v: need(o.x + o.w) },
            { side: "r" as const, v: need(viewport.width - o.x) },
        ].sort((a, b) => a.v - b.v);
        for (const c of sides) {
            const next = { ...ins, [c.side]: Math.max(ins[c.side], c.v) };
            if (viewport.width - next.l - next.r > padding * 2 + 8 && viewport.height - next.t - next.b > padding * 2 + 8) {
                ins = next;
                break;
            }
        }
    }
    const place = (lo: number, hi: number, bMin: number, bMax: number, aMin: number, aMax: number): number => {
        const room = hi - lo;
        if ((bMax - bMin) * k <= room) return lo + (room - (bMax - bMin) * k) / 2 - bMin * k;
        let at = lo + room / 2 - ((aMin + aMax) / 2) * k;
        at = Math.min(at, lo - bMin * k);          // no gap before the chart's first edge
        at = Math.max(at, hi - bMax * k);          // …or after its last
        return at;
    };
    const a = anchor ?? { x: bounds.minX, y: bounds.minY, w: 0, h: 0 };
    return {
        k,
        tx: place(ins.l + padding, viewport.width - ins.r - padding, bounds.minX, bounds.maxX, a.x, a.x + a.w),
        ty: place(ins.t + padding, viewport.height - ins.b - padding, bounds.minY, bounds.maxY, a.y, a.y + a.h),
        floored: true,
    };
}

/**
 * The card a floored view is anchored on: the FIRST visible root — the top-left
 * of a wrapped forest, the only root of an ordinary chart. Anchoring on the box
 * around every root centred a two-shelf forest between its shelves and pushed its
 * first row under the top chrome (OC-030, found by the COVER gate at 280×180).
 */
export function rootsBox(h: Hierarchy, layout: LayoutResult): ScreenRect | null {
    for (const r of h.roots) {
        if (!isFinite(layout.x[r])) continue;
        return { x: layout.x[r] - layout.w[r] / 2, y: layout.y[r] - layout.h[r] / 2, w: layout.w[r], h: layout.h[r] };
    }
    return null;
}
