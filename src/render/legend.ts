"use strict";

/**
 * The legend — free-tier, and one of the two features that block publication.
 *
 * It answers the question the colour modes create: "what does this colour mean?"
 * Without it, `Colour by = Group` on a hierarchy with more groups than the
 * palette has colours is decoration rather than information (OC-QA-09).
 *
 * Drawn into the `chrome` layer, never the viewport, so the fit transform never
 * moves or scales it. Everything about which items fit is pure and lives in
 * `fitLegend`, so the hard part is testable without a DOM.
 */

import { Selection } from "d3";
import { fontFamily } from "../theme/zentrixTokens";

export interface LegendItem {
    label: string;
    color: string;
    /** Dash pattern in high contrast, where colour may not carry meaning. */
    dash: string;
}

export interface LegendLayout {
    /** The items that fit, in order. */
    shown: LegendItem[];
    /** How many were left out. 0 when everything fits. */
    overflow: number;
}

const SWATCH = 9;
const GAP = 6;
const ITEM_GAP = 14;
/** Same advance approximation the card renderer starts from. */
const PER_CHAR = 0.56;

/** Width one chip needs at `fontPx`. */
export function chipWidth(label: string, fontPx: number): number {
    return SWATCH + GAP + label.length * fontPx * PER_CHAR;
}

/**
 * Decide what fits in `maxWidth`.
 *
 * Always keeps at least one item — a legend showing nothing but "+25 more" tells
 * the reader less than one colour with its name. The overflow chip is measured
 * too, so the count never itself overflows.
 */
export function fitLegend(
    items: readonly LegendItem[], maxWidth: number, fontPx: number,
    moreLabel: (n: number) => string,
): LegendLayout {
    if (items.length === 0) return { shown: [], overflow: 0 };

    let used = 0;
    const shown: LegendItem[] = [];
    for (let i = 0; i < items.length; i++) {
        const w = chipWidth(items[i].label, fontPx) + (i > 0 ? ITEM_GAP : 0);
        const rest = items.length - i - 1;
        // Reserve room for the overflow chip whenever there would be one.
        const reserve = rest > 0
            ? ITEM_GAP + chipWidth(moreLabel(rest), fontPx)
            : 0;
        if (shown.length > 0 && used + w + reserve > maxWidth) break;
        used += w;
        shown.push(items[i]);
    }
    return { shown, overflow: items.length - shown.length };
}

export interface LegendOptions {
    items: readonly LegendItem[];
    /** Left edge, and the widest the row may be. */
    x: number;
    maxWidth: number;
    /** Baseline for the chip text. */
    y: number;
    fontPx: number;
    fg: string;
    highContrast: boolean;
    strokeWidth: number;
    moreLabel: (n: number) => string;
    /** Accessible name for the row as a whole. */
    title: string;
}

type GSel = Selection<SVGGElement, unknown, null, undefined>;

/** Height the legend occupies, so the caller can keep the chart clear of it. */
export const LEGEND_HEIGHT = 20;

export function renderLegend(root: GSel, o: LegendOptions): void {
    root.selectAll("g.legend").remove();
    if (o.items.length === 0 || o.maxWidth < 60) return;

    const { shown, overflow } = fitLegend(o.items, o.maxWidth, o.fontPx, o.moreLabel);
    if (shown.length === 0) return;
    // fitLegend always keeps one item. Where even that (plus its "+N more") is
    // wider than the room, stand down like the other chrome rather than run into
    // whatever holds the end of the row — at 280px, the view switch (OC-029).
    const needed = shown.reduce((sum, it, i) => sum + chipWidth(it.label, o.fontPx) + (i > 0 ? ITEM_GAP : 0), 0)
        + (overflow > 0 ? ITEM_GAP + chipWidth(o.moreLabel(overflow), o.fontPx) : 0);
    if (needed > o.maxWidth) return;

    const g = root.append("g")
        .attr("class", "legend")
        .attr("role", "list")
        .attr("aria-label", o.title) as GSel;

    let x = o.x;
    for (const item of shown) {
        const chip = g.append("g").attr("role", "listitem").attr("aria-label", item.label) as GSel;
        chip.append("rect")
            .attr("x", x).attr("y", o.y - SWATCH + 1)
            .attr("width", SWATCH).attr("height", SWATCH).attr("rx", 2)
            // High contrast: an outlined swatch carrying the group's dash, since
            // colour is not allowed to be the only encoding there.
            .attr("fill", o.highContrast ? "none" : item.color)
            .attr("stroke", o.highContrast ? o.fg : "none")
            .attr("stroke-width", o.highContrast ? o.strokeWidth : 0)
            .attr("stroke-dasharray", o.highContrast && item.dash ? item.dash : null);
        chip.append("text")
            .attr("x", x + SWATCH + GAP).attr("y", o.y)
            .attr("font-family", fontFamily).attr("font-size", o.fontPx)
            .attr("fill", o.fg)
            .text(item.label);
        x += chipWidth(item.label, o.fontPx) + ITEM_GAP;
    }

    if (overflow > 0) {
        g.append("text")
            .attr("x", x).attr("y", o.y)
            .attr("font-family", fontFamily).attr("font-size", o.fontPx)
            .attr("fill", o.fg).attr("opacity", 0.7)
            .text(o.moreLabel(overflow));
    }
}
