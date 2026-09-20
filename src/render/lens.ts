"use strict";

/**
 * The lens (OC-034) — a magnifying loupe that follows the pointer.
 *
 * Why it exists: since OC-030 the opening fit stops at the legibility floor, but
 * a READER may zoom out past it (only `−` and the wheel go below the floor), and
 * on a 2,000-person hierarchy "everything at once" means cards a few pixels
 * wide. The honest answer to "what is that dot?" was previously "zoom in, lose
 * the overview, zoom out again". The lens keeps the overview and reads the dot.
 *
 * How it works: one `<use>` of the live chart group, transformed so that the
 * world point under the cursor lands in the middle of a circular window, blown
 * up to a readable scale. `<use>` shares the rendered tree rather than copying
 * it, so a move is a single attribute write and nothing is re-laid-out. No
 * network, no `innerHTML`, no canvas — the certification surface is unchanged.
 *
 * Geometry lives in `lensMagnification` / `lensCentre`, which are pure, so the
 * hard part is testable without a DOM (jsdom renders no `<use>`).
 */

import { Selection } from "d3";
import { fontFamily } from "../theme/zentrixTokens";

type GSel = Selection<SVGGElement, unknown, null, undefined>;

/** Radius of the loupe on a normal canvas. About one full-size card across. */
export const LENS_RADIUS = 92;
/** Below this the loupe would be bigger than the canvas; it shrinks, then stands down. */
export const LENS_MIN_RADIUS = 44;

/**
 * The scale the loupe should draw at, as a multiple of what is on screen.
 *
 * The target is 1:1 — a card at its authored size, which is where the type was
 * designed to read. A view already at or above 1:1 still gets a usable step up
 * (`min`), and the ceiling stops a hairline view turning into a single pixel
 * filling the whole window.
 */
export function lensMagnification(k: number, target = 1, min = 2, max = 40): number {
    const wanted = target / Math.max(1e-4, k);
    return Math.min(max, Math.max(min, wanted));
}

/** Loupe radius for a viewport — smaller on a small canvas, `null` when it cannot fit. */
export function lensRadius(width: number, height: number): number | null {
    const r = Math.min(LENS_RADIUS, Math.floor(Math.min(width, height) / 3));
    return r >= LENS_MIN_RADIUS ? r : null;
}

/**
 * Where the loupe is drawn, given where the pointer is.
 *
 * Kept wholly inside the canvas: a loupe half off the edge shows half a card and
 * reads as a rendering fault. When it is pushed off the cursor this way the
 * CONTENT is still the point under the cursor — the window moves, not the subject.
 */
export function lensCentre(
    px: number, py: number, r: number, width: number, height: number,
): { cx: number; cy: number } {
    const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
    return {
        cx: clamp(px, r + 2, width - r - 2),
        cy: clamp(py, r + 2, height - r - 2),
    };
}

export interface LensOptions {
    /** Pointer position, in viewport pixels. */
    px: number;
    py: number;
    width: number;
    height: number;
    /** The live zoom transform the chart is drawn at. */
    k: number;
    /** `id` of the group the chart is drawn in — what the loupe re-uses. */
    chartId: string;
    bg: string;
    fg: string;
    stroke: string;
    accent: string;
    /** "×12" in the corner of the window, already localized. */
    label: (times: number) => string;
    /** How to get out of the mode, drawn beside it — e.g. "Esc". */
    exitLabel?: string;
}

/**
 * Draw (or move) the loupe inside `root`, which must be a layer of its own —
 * the chrome layer is cleared on every render and the lens is transient.
 */
export function renderLens(root: GSel, clipId: string, o: LensOptions): void {
    root.selectAll("*").remove();
    const r = lensRadius(o.width, o.height);
    if (r === null) return;
    const { cx, cy } = lensCentre(o.px, o.py, r, o.width, o.height);
    const m = lensMagnification(o.k);

    const g = root.append("g").attr("class", "zx-lens").attr("pointer-events", "none");
    g.append("defs").append("clipPath").attr("id", clipId)
        .append("circle").attr("cx", cx).attr("cy", cy).attr("r", r);

    const inner = g.append("g").attr("clip-path", `url(#${clipId})`);
    // An opaque plate: the chart under the loupe must not read through it.
    inner.append("rect")
        .attr("x", cx - r).attr("y", cy - r).attr("width", r * 2).attr("height", r * 2)
        .attr("fill", o.bg);
    /*
     * The magnified copy. `use` re-renders the chart group with this transform
     * applied BEFORE the group's own, so a world point drawn at screen (px, py)
     * lands at (cx, cy) scaled by m — which is exactly "blow up what is under
     * the cursor". No data is re-read and no layout is re-run.
     */
    inner.append("use")
        .attr("href", `#${o.chartId}`)
        .attr("transform", `translate(${cx},${cy}) scale(${m}) translate(${-o.px},${-o.py})`);

    // The rim, drawn last so nothing can paint over it (the same rule the card
    // avatar learned in OC-025).
    g.append("circle")
        .attr("cx", cx).attr("cy", cy).attr("r", r)
        .attr("fill", "none").attr("stroke", o.accent).attr("stroke-width", 2);
    g.append("circle")
        .attr("cx", cx).attr("cy", cy).attr("r", r - 1.5)
        .attr("fill", "none").attr("stroke", o.bg).attr("stroke-width", 1).attr("opacity", 0.6);

    /*
     * The tag: how much it is magnifying, and — since OC-035 — how to get OUT.
     * A mode with no visible exit is a trap, and this one covers the cursor, so
     * the way out travels with it rather than living only in a tooltip.
     */
    const times = Math.round(m * 10) / 10;
    const text = o.exitLabel ? `${o.label(times)}  ·  ${o.exitLabel}` : o.label(times);
    const width = Math.max(42, 14 + text.length * 6.2);
    const tag = g.append("g").attr("transform", `translate(${cx},${cy + r - 14})`);
    tag.append("rect")
        .attr("x", -width / 2).attr("y", -9).attr("width", width).attr("height", 18).attr("rx", 9)
        .attr("fill", o.bg).attr("fill-opacity", 0.92)
        .attr("stroke", o.stroke).attr("stroke-width", 1);
    tag.append("text")
        .attr("x", 0).attr("y", 4).attr("text-anchor", "middle")
        .attr("font-family", fontFamily).attr("font-size", 11).attr("font-weight", 600)
        .attr("fill", o.fg)
        .text(text);
}

/** Take the loupe down. */
export function clearLens(root: GSel): void {
    root.selectAll("*").remove();
}
