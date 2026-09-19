"use strict";

/**
 * Connector path builders. Pure string maths, no DOM — so the geometry is unit
 * testable and the render layer stays a thin d3 binding.
 *
 * Every path runs from the parent card's exit edge to the child card's entry
 * edge, which depends on orientation:
 *   top-down    parent bottom-centre -> child top-centre
 *   left-right  parent right-centre  -> child left-centre
 */

import { ConnectorStyle, Orientation } from "../types";

export interface CardBox {
    /** Card centre. */
    cx: number;
    cy: number;
    w: number;
    h: number;
}

export interface Endpoints { x1: number; y1: number; x2: number; y2: number; }

/** Exit point on the parent and entry point on the child. */
export function endpoints(parent: CardBox, child: CardBox, orientation: Orientation): Endpoints {
    if (orientation === "leftRight") {
        return {
            x1: parent.cx + parent.w / 2, y1: parent.cy,
            x2: child.cx - child.w / 2, y2: child.cy,
        };
    }
    return {
        x1: parent.cx, y1: parent.cy + parent.h / 2,
        x2: child.cx, y2: child.cy - child.h / 2,
    };
}

const r = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * Build the SVG path for one connector.
 *
 * elbow    — the org-chart convention: out, across at the midpoint, then in.
 * straight — a direct line.
 * curved   — a cubic easing across the depth axis.
 */
export function connectorPath(
    parent: CardBox,
    child: CardBox,
    orientation: Orientation,
    style: ConnectorStyle,
): string {
    const { x1, y1, x2, y2 } = endpoints(parent, child, orientation);
    if (style === "straight") return `M${r(x1)},${r(y1)} L${r(x2)},${r(y2)}`;

    if (orientation === "leftRight") {
        const mx = (x1 + x2) / 2;
        if (style === "curved") return `M${r(x1)},${r(y1)} C${r(mx)},${r(y1)} ${r(mx)},${r(y2)} ${r(x2)},${r(y2)}`;
        return `M${r(x1)},${r(y1)} H${r(mx)} V${r(y2)} H${r(x2)}`;
    }
    const my = (y1 + y2) / 2;
    if (style === "curved") return `M${r(x1)},${r(y1)} C${r(x1)},${r(my)} ${r(x2)},${r(my)} ${r(x2)},${r(y2)}`;
    return `M${r(x1)},${r(y1)} V${r(my)} H${r(x2)} V${r(y2)}`;
}

/* ───────────────────────── dotted-line routing ───────────────────────── */

type Pt = { x: number; y: number };
type Box = { l: number; t: number; r: number; b: number };

/** Orientation is handled by routing in top-down space and swapping axes back. */
function toBox(c: CardBox, swap: boolean): Box {
    const cx = swap ? c.cy : c.cx, cy = swap ? c.cx : c.cy;
    const w = swap ? c.h : c.w, h = swap ? c.w : c.h;
    return { l: cx - w / 2, t: cy - h / 2, r: cx + w / 2, b: cy + h / 2 };
}

/** A polyline with its bends rounded — dashed elbows read as broken solid lines. */
function roundedPath(pts: Pt[], radius: number): string {
    const clean = pts.filter((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) > 0.01 || Math.abs(p.y - pts[i - 1].y) > 0.01);
    if (clean.length < 2) return "";
    let d = `M${r(clean[0].x)},${r(clean[0].y)}`;
    for (let i = 1; i < clean.length - 1; i++) {
        const a = clean[i - 1], b = clean[i], c = clean[i + 1];
        const inLen = Math.hypot(b.x - a.x, b.y - a.y), outLen = Math.hypot(c.x - b.x, c.y - b.y);
        const rr = Math.min(radius, inLen / 2, outLen / 2);
        const p1 = { x: b.x - ((b.x - a.x) / (inLen || 1)) * rr, y: b.y - ((b.y - a.y) / (inLen || 1)) * rr };
        const p2 = { x: b.x + ((c.x - b.x) / (outLen || 1)) * rr, y: b.y + ((c.y - b.y) / (outLen || 1)) * rr };
        d += ` L${r(p1.x)},${r(p1.y)} Q${r(b.x)},${r(b.y)} ${r(p2.x)},${r(p2.y)}`;
    }
    const last = clean[clean.length - 1];
    return d + ` L${r(last.x)},${r(last.y)}`;
}

/**
 * Route a dotted (matrix) reporting line so it never crosses a card.
 *
 * The old path was a single bezier from one card to the other, straight through
 * whatever sat between them — a dotted line to a skip-level manager ran across
 * every card in its own reporting chain. Now the line leaves its card towards the
 * other one, travels only through the GAPS between levels (which hold no cards by
 * construction), and changes level in a vertical lane that is clear of every card
 * in between — the free lane nearest the two ends, or outside the tree if there is
 * none. Pure geometry; `cards` are every drawn card, the two ends included.
 */
export function dottedPath(
    from: CardBox,
    to: CardBox,
    cards: readonly CardBox[],
    orientation: Orientation,
): string {
    const swap = orientation === "leftRight";
    const A = toBox(from, swap), B = toBox(to, swap);
    const all = cards.map((c) => toBox(c, swap));
    const same = (p: Box, q: Box): boolean => Math.abs(p.l - q.l) < 0.01 && Math.abs(p.t - q.t) < 0.01;
    const others = all.filter((c) => !same(c, A) && !same(c, B));
    const acx = (A.l + A.r) / 2, bcx = (B.l + B.r) / 2;

    /** Middle of the empty band just above / below a card's row. */
    const gapAbove = (c: Box): number => {
        const above = all.filter((o) => o.b <= c.t + 0.5).map((o) => o.b);
        return above.length ? (c.t + Math.max(...above)) / 2 : c.t - 12;
    };
    const gapBelow = (c: Box): number => {
        const below = all.filter((o) => o.t >= c.b - 0.5).map((o) => o.t);
        return below.length ? (c.b + Math.min(...below)) / 2 : c.b + 12;
    };

    const rowTol = Math.min(A.b - A.t, B.b - B.t) / 2;
    const aMid = (A.t + A.b) / 2, bMid = (B.t + B.b) / 2;
    let exitY: number, chA: number, entryY: number, chB: number;
    if (Math.abs(aMid - bMid) < rowTol) {
        exitY = A.t; entryY = B.t; chA = chB = Math.min(gapAbove(A), gapAbove(B));
    } else if (bMid < aMid) {
        exitY = A.t; chA = gapAbove(A); entryY = B.b; chB = gapBelow(B);
    } else {
        exitY = A.b; chA = gapBelow(A); entryY = B.t; chB = gapAbove(B);
    }

    const pts: Pt[] = [{ x: acx, y: exitY }, { x: acx, y: chA }];
    if (Math.abs(chA - chB) > 0.5) {
        // Change level in a lane no card between the two channels occupies.
        const lo = Math.min(chA, chB), hi = Math.max(chA, chB);
        const clear = 6;
        const blocking = others.filter((o) => o.b > lo && o.t < hi)
            .map((o) => [o.l - clear, o.r + clear] as [number, number])
            .sort((p, q) => p[0] - q[0]);
        const merged: Array<[number, number]> = [];
        for (const iv of blocking) {
            const lastIv = merged[merged.length - 1];
            if (lastIv && iv[0] <= lastIv[1]) lastIv[1] = Math.max(lastIv[1], iv[1]);
            else merged.push([iv[0], iv[1]]);
        }
        const free = (x: number): boolean => !merged.some(([a, b]) => x > a && x < b);
        const target = (acx + bcx) / 2;
        const candidates = [target, acx, bcx, ...merged.flatMap(([a, b]) => [a, b])];
        const minL = Math.min(...all.map((c) => c.l)), maxR = Math.max(...all.map((c) => c.r));
        candidates.push(minL - 16, maxR + 16);
        const cost = (x: number): number => Math.abs(x - acx) + Math.abs(x - bcx);
        const lane = candidates.filter(free).sort((p, q) => cost(p) - cost(q))[0];
        pts.push({ x: lane, y: chA }, { x: lane, y: chB });
    }
    pts.push({ x: bcx, y: chB }, { x: bcx, y: entryY });

    const radius = Math.max(2, Math.min(10, Math.abs(chA - exitY)));
    const out = swap ? pts.map((p) => ({ x: p.y, y: p.x })) : pts;
    return roundedPath(out, radius);
}

/**
 * A stacked report's connector (OC-030): out of the manager, along the bus to
 * this column's spine, down the spine to the card, and in from the side.
 *
 * The parent-to-child elbow cannot be used for a stacked block — it would drop
 * straight through the rows above the card. Every card in a column shares the
 * same spine, so the column reads as one bracket, the way Visio draws it.
 *
 *   top-down    parent bottom → bus (y) → spine (x) → card centre (y) → card left
 *   left-right  parent right  → bus (x) → spine (y) → card centre (x) → card top
 */
export function stackedPath(
    parent: CardBox,
    child: CardBox,
    orientation: Orientation,
    spine: number,
    bus: number,
): string {
    if (orientation === "leftRight") {
        const x1 = parent.cx + parent.w / 2;
        return `M${r(x1)},${r(parent.cy)} H${r(bus)} V${r(spine)} H${r(child.cx)} V${r(child.cy - child.h / 2)}`;
    }
    const y1 = parent.cy + parent.h / 2;
    return `M${r(parent.cx)},${r(y1)} V${r(bus)} H${r(spine)} V${r(child.cy)} H${r(child.cx - child.w / 2)}`;
}
