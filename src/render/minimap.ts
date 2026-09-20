"use strict";

/**
 * The minimap (OC-034) — the whole chart in a thumbnail, with a rectangle
 * marking the part that is on screen.
 *
 * Why it exists: since OC-030 the opening fit stops at the legibility floor
 * rather than shrinking to a hairline, which means a large hierarchy opens as a
 * CROP. The pan cue says so in words; this shows it. Drag the rectangle (or
 * click anywhere in the box) and the view goes there.
 *
 * The family already ships one: the Network Graph's `renderMinimap` and the
 * Gantt's `minimap.show`. This is the same idea against a card layout, and
 * unlike the Network Graph's it is INTERACTIVE — a chart you can only look at
 * would be the dead control this product is positioned against.
 *
 * Drawn into a layer of its own, never the viewport, so the zoom transform never
 * moves or scales it. All of the geometry is pure and lives above the renderer.
 */

import { Selection } from "d3";

type GSel = Selection<SVGGElement, unknown, null, undefined>;

/** A rectangle in viewport pixels (x, y = top-left). */
export interface Rect { x: number; y: number; w: number; h: number; }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number; }

/** Thumbnail size. Wide rather than square — org charts are wider than they are tall. */
export const MINIMAP_WIDTH = 116;
export const MINIMAP_HEIGHT = 78;
const PAD = 6;
const EDGE = 10;
/**
 * Below this the box would take a quarter of the canvas. A tile that small is
 * already showing a handful of cards; the pan cue is the honest answer there,
 * and the thumbnail stands down — the same contract the gear, the search box
 * and the quick-action bar follow.
 */
const MIN_CANVAS_W = 360;
const MIN_CANVAS_H = 300;
/** At most this many card marks — a 5,000-node org must not draw 5,000 rects. */
export const MAX_MARKS = 400;

export interface MinimapBoxInput {
    width: number;
    height: number;
    /** Rows already owned by the status line / pan cue / legend, measured from the bottom. */
    bottomBand: number;
    /** Left or right; the caller picks the corner nothing else has taken. */
    corner?: "bl" | "br";
    /** Room another piece needs in the same corner (the gear, the view pill). */
    cornerInset?: number;
}

/**
 * Where the thumbnail lands, or `null` on a canvas too small to give it room.
 *
 * Sits ABOVE the bottom band rather than in it: the legend and the status line
 * own the last rows, and OC-028 was exactly the lesson that two pieces of chrome
 * sharing a row print over each other.
 */
export function minimapBox(o: MinimapBoxInput): Rect | null {
    if (o.width < MIN_CANVAS_W || o.height < MIN_CANVAS_H) return null;
    const inset = Math.max(0, o.cornerInset ?? 0);
    const y = o.height - Math.max(0, o.bottomBand) - EDGE - MINIMAP_HEIGHT - inset;
    if (y < EDGE) return null;
    const x = (o.corner ?? "bl") === "bl" ? EDGE : o.width - EDGE - MINIMAP_WIDTH;
    return { x, y, w: MINIMAP_WIDTH, h: MINIMAP_HEIGHT };
}

export interface MiniScale {
    /** Layout units → thumbnail pixels, per axis. */
    kx: number;
    ky: number;
    /** Thumbnail pixel of a layout point. */
    sx: (x: number) => number;
    sy: (y: number) => number;
    /** …and back, which is what a click on the thumbnail means. */
    ix: (x: number) => number;
    iy: (y: number) => number;
}

/**
 * Fit the chart's layout bounds into the thumbnail — each axis SEPARATELY.
 *
 * ⚠️ This deliberately does not keep the aspect ratio, and that is not a
 * shortcut. A real org chart is extremely wide and shallow: the 1,240-person
 * fixture lays out 105,635 × 1,162, a ratio of 91:1. Fitted uniformly into a
 * 116 × 78 box it draws as a 104 × 1 hairline, and the window rectangle inside
 * it as a 5 × 1 dot — a picture that answers nothing.
 *
 * Stretched per axis, the same chart fills the box and the window rectangle
 * reads as "you are seeing 5% of the width and all of the height", which is the
 * question the thumbnail exists to answer. The window is stretched by exactly
 * the same factors, so the FRACTION shown on each axis stays truthful; only the
 * shape of the marks is distorted, and they are a density texture, not a
 * drawing. The Network Graph's minimap can keep a uniform scale because a force
 * layout is roughly square; a tree is not.
 */
export function miniScale(bounds: Bounds, box: Rect): MiniScale {
    const bw = Math.max(1, bounds.maxX - bounds.minX);
    const bh = Math.max(1, bounds.maxY - bounds.minY);
    const kx = (box.w - PAD * 2) / bw;
    const ky = (box.h - PAD * 2) / bh;
    const ox = box.x + PAD - bounds.minX * kx;
    const oy = box.y + PAD - bounds.minY * ky;
    return {
        kx,
        ky,
        sx: (x) => ox + x * kx,
        sy: (y) => oy + y * ky,
        ix: (x) => (x - ox) / kx,
        iy: (y) => (y - oy) / ky,
    };
}

/**
 * The part of the chart on screen right now, in LAYOUT units — the inverse of
 * the zoom transform applied to the canvas rectangle.
 */
export function visibleBounds(
    t: { k: number; tx: number; ty: number }, width: number, height: number,
): Bounds {
    const k = Math.max(1e-6, t.k);
    return {
        minX: (0 - t.tx) / k,
        minY: (0 - t.ty) / k,
        maxX: (width - t.tx) / k,
        maxY: (height - t.ty) / k,
    };
}

/** True when the whole chart is on screen — nothing for the thumbnail to add. */
export function showsEverything(view: Bounds, content: Bounds, slack = 1): boolean {
    return view.minX <= content.minX + slack
        && view.minY <= content.minY + slack
        && view.maxX >= content.maxX - slack
        && view.maxY >= content.maxY - slack;
}

/** Evenly sample `rects` down to at most `max`, keeping the shape of the chart. */
export function sampleMarks(rects: readonly Rect[], max = MAX_MARKS): Rect[] {
    if (rects.length <= max) return rects.slice();
    const step = rects.length / max;
    const out: Rect[] = [];
    for (let i = 0; i < max; i++) out.push(rects[Math.floor(i * step)]);
    return out;
}

export interface MinimapOptions {
    box: Rect;
    /** Every card, in layout units. */
    cards: readonly Rect[];
    /** The whole chart's extent, in layout units. */
    content: Bounds;
    /** The live zoom transform and the canvas it applies to. */
    transform: { k: number; tx: number; ty: number };
    width: number;
    height: number;
    bg: string;
    fg: string;
    muted: string;
    stroke: string;
    accent: string;
    highContrast: boolean;
    label: string;
    /** Centre the view on this layout point. */
    onGoTo: (x: number, y: number) => void;
    /** Whether the reader may drive it at all (never on a dashboard tile). */
    interactive: boolean;
}

/**
 * Draw the thumbnail into `root`, which must be a layer of its own: the chrome
 * layer is cleared by `renderStatus` on every render, and this one is also
 * refreshed from the zoom handler between renders.
 */
export function renderMinimap(root: GSel, o: MinimapOptions): void {
    root.selectAll("*").remove();
    const { box } = o;
    const s = miniScale(o.content, box);

    const g = root.append("g").attr("class", "zx-minimap");
    g.append("rect")
        .attr("class", "zx-minimap-plate")
        .attr("x", box.x).attr("y", box.y).attr("width", box.w).attr("height", box.h)
        .attr("rx", 8)
        .attr("fill", o.bg).attr("fill-opacity", o.highContrast ? 1 : 0.94)
        .attr("stroke", o.stroke).attr("stroke-width", 1);

    const marks = g.append("g").attr("class", "zx-minimap-marks").attr("pointer-events", "none");
    for (const c of sampleMarks(o.cards)) {
        marks.append("rect")
            .attr("x", s.sx(c.x)).attr("y", s.sy(c.y))
            .attr("width", Math.max(1, c.w * s.kx)).attr("height", Math.max(1, c.h * s.ky))
            .attr("fill", o.muted).attr("fill-opacity", 0.55);
    }

    // The window: what is on screen, clipped to the thumbnail so a view zoomed
    // out past the chart does not draw a rectangle outside the box.
    const v = visibleBounds(o.transform, o.width, o.height);
    const x0 = Math.max(box.x, s.sx(v.minX)), x1 = Math.min(box.x + box.w, s.sx(v.maxX));
    const y0 = Math.max(box.y, s.sy(v.minY)), y1 = Math.min(box.y + box.h, s.sy(v.maxY));
    g.append("rect")
        .attr("class", "zx-minimap-window")
        .attr("x", x0).attr("y", y0)
        .attr("width", Math.max(3, x1 - x0)).attr("height", Math.max(3, y1 - y0))
        .attr("rx", 2)
        .attr("fill", o.accent).attr("fill-opacity", o.highContrast ? 0 : 0.12)
        .attr("stroke", o.highContrast ? o.fg : o.accent).attr("stroke-width", 1.5)
        .attr("pointer-events", "none");

    if (!o.interactive) {
        g.attr("role", "img").attr("aria-label", o.label);
        return;
    }

    /*
     * The hit area. A transparent rect over the whole box rather than handlers on
     * the plate, so a press anywhere — including on a card mark — moves the view.
     * Every handler stops propagation: d3-zoom claims a mousedown the moment it
     * sees one, and the chart would pan out from under the drag.
     */
    const goTo = (ev: MouseEvent, node: SVGGElement): void => {
        const owner = node.ownerSVGElement;
        if (!owner || typeof owner.getBoundingClientRect !== "function") return;
        const r = owner.getBoundingClientRect();
        o.onGoTo(s.ix(ev.clientX - r.left), s.iy(ev.clientY - r.top));
    };
    let dragging = false;
    const hit = g.append("rect")
        .attr("class", "zx-minimap-hit")
        .attr("x", box.x).attr("y", box.y).attr("width", box.w).attr("height", box.h)
        .attr("rx", 8)
        .attr("fill", "transparent")
        .attr("cursor", "pointer")
        .attr("role", "button")
        .attr("tabindex", 0)
        .attr("aria-label", o.label);
    hit.append("title").text(o.label);

    const node = g.node() as SVGGElement;
    hit.on("mousedown", function (ev: MouseEvent) {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        dragging = true;
        goTo(ev, node);
    });
    hit.on("mousemove", function (ev: MouseEvent) {
        if (!dragging) return;
        ev.preventDefault();
        ev.stopPropagation();
        goTo(ev, node);
    });
    const stop = (ev: MouseEvent): void => { dragging = false; ev.stopPropagation(); };
    hit.on("mouseup", stop);
    hit.on("mouseleave", stop);
    hit.on("click", (ev: MouseEvent) => ev.stopPropagation());
    // Keyboard: the thumbnail is a control, and certification checks that every
    // control can be reached and used without a mouse.
    hit.on("keydown", (ev: KeyboardEvent) => {
        const step = (ev.shiftKey ? 4 : 1) * 40;
        let dx = 0, dy = 0;
        if (ev.key === "ArrowLeft") dx = -step;
        else if (ev.key === "ArrowRight") dx = step;
        else if (ev.key === "ArrowUp") dy = -step;
        else if (ev.key === "ArrowDown") dy = step;
        else return;
        ev.preventDefault();
        ev.stopPropagation();
        const cur = visibleBounds(o.transform, o.width, o.height);
        o.onGoTo((cur.minX + cur.maxX) / 2 + dx, (cur.minY + cur.maxY) / 2 + dy);
    });

}

/** Take the thumbnail down. */
export function clearMinimap(root: GSel): void {
    root.selectAll("*").remove();
}
