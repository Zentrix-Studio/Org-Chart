"use strict";

/**
 * The landing page — what the visual draws before it has a hierarchy to draw.
 *
 * `supportsLandingPage` is declared in capabilities.json, so the host hands us
 * an empty dataView and this is the first thing most people ever see of the
 * product. A single grey sentence (what shipped in OC-001) wastes that: it says
 * what is missing but not what the visual is, what else it can use, or what it
 * does once the fields are in.
 *
 * So this page draws, in one frame:
 *   - the brand mark and name,
 *   - the ask — which required well is still empty,
 *   - a checklist of every well, ticked as the author fills them,
 *   - a wireframe preview of the chart it is about to draw, and
 *   - pictogram tiles for the capabilities that define the product (the five
 *     documented competitor failures we fix, plus cross-filtering).
 *
 * Everything is drawn as SVG primitives — no <img>, no data URI, no innerHTML,
 * no network call — so the whole page is certification-safe by construction and
 * scales cleanly at any viewport.
 *
 * The blocks are planned against the viewport: a dashboard tile gets the
 * sentence alone, a full report page gets all five blocks. Nothing ever
 * overflows or overlaps.
 */

import { Selection } from "d3";
import { EmptyReason } from "../types";
import { Surface, fontFamily } from "../theme/zentrixTokens";
import { fitText } from "./tree";
import { RoleBinding } from "../model/dataTransform";

type G = Selection<SVGGElement, unknown, null, undefined>;

/** Blocks the page can show, in the order they are drawn. */
export type LandingBlock = "header" | "prompt" | "fields" | "hero" | "capabilities";

export interface LandingOptions {
    width: number;
    height: number;
    /** Which required role is unbound, if any. */
    reason: EmptyReason;
    /** Which wells hold a column — drives the checklist ticks. */
    bound: RoleBinding;
    surface: Surface;
    highContrast: boolean;
    /** Resolved accent (the author's card fill, or the theme's). */
    accent: string;
    /** Categorical colour for a card index in the preview. */
    groupColor: (index: number) => string;
    /** Localized string lookup — English default applied by the caller. */
    t: (key: string) => string;
}

/** Approximate advance width; the renderer never measures the DOM (jsdom has no metrics). */
const PER_CHAR = 0.56;
const PAD = 18;
const GAP = 14;

const HEADER_H = 30;
const PROMPT_LINE = 16;
const CHIP_H = 24;
const CHIP_GAP = 6;
const HERO_H = 136;
const TILE_H = 62;
const TILE_GAP = 10;

const HERO_MAX_W = 460;

/** Width a run of text needs at `fontPx`. */
export function textWidth(text: string, fontPx: number): number {
    return text.length * fontPx * PER_CHAR;
}

/**
 * Word-wrap to `maxLines`. The last line absorbs whatever is left and is
 * ellipsized, so a long translation degrades to "…" rather than to a line of
 * text running out of the viewport.
 */
export function wrapText(text: string, maxPx: number, fontPx: number, maxLines: number): string[] {
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return [];
    const all: string[] = [];
    let cur = words[0];
    for (let i = 1; i < words.length; i++) {
        const next = cur + " " + words[i];
        if (textWidth(next, fontPx) > maxPx) {
            all.push(cur);
            cur = words[i];
        } else {
            cur = next;
        }
    }
    all.push(cur);
    if (all.length <= maxLines) return all.map((l) => fitText(l, maxPx, fontPx));
    const kept = all.slice(0, maxLines - 1);
    kept.push(fitText(all.slice(maxLines - 1).join(" "), maxPx, fontPx));
    return kept;
}

/** Lines the ask is allowed — narrow viewports wrap it rather than truncate it. */
export function promptLines(w: number): number {
    return w < 470 ? 2 : 1;
}

/** Height the ask block reserves. Derived from the width alone, so the planner
 *  and the renderer always agree without either of them seeing the string. */
export function promptHeight(w: number): number {
    return promptLines(w) * PROMPT_LINE + 3;
}

/** The six capabilities the tiles advertise. All ship free; none is paid. */
export const CAPABILITY_KEYS = [
    "anyRoot", "collapse", "crossFilter", "cycles", "wideRow", "orientation",
] as const;
export type CapabilityKey = typeof CAPABILITY_KEYS[number];

interface Chip {
    label: string;
    /** Required wells show a tick or an empty target; optional ones stay plain. */
    required: boolean;
    filled: boolean;
    w: number;
}

/** A row of chips, already wrapped to the available width. */
export interface ChipRow {
    chips: Chip[];
    w: number;
}

/** Greedy wrap — chips keep their order, and rows never exceed `maxW`. */
export function layoutChips(chips: Chip[], maxW: number, maxRows: number): ChipRow[] {
    const rows: ChipRow[] = [];
    let row: Chip[] = [];
    let w = 0;
    for (const c of chips) {
        const add = row.length === 0 ? c.w : c.w + CHIP_GAP;
        if (row.length > 0 && w + add > maxW) {
            rows.push({ chips: row, w });
            if (rows.length >= maxRows) return rows;
            row = [];
            w = 0;
        }
        if (row.length === 0 && c.w > maxW) continue;   // a chip wider than the box is dropped
        row.push(c);
        w += row.length === 1 ? c.w : c.w + CHIP_GAP;
    }
    if (row.length > 0) rows.push({ chips: row, w });
    return rows;
}

/** How many tile columns the width affords, and therefore how many tiles show. */
export function tileColumns(w: number): number {
    if (w >= 780) return 3;
    if (w >= 470) return 2;
    return 1;
}

/**
 * Decide which blocks fit. Priority runs left to right: the ask is the one
 * thing that always survives, because it is the only actionable text.
 */
export function planBlocks(w: number, h: number): LandingBlock[] {
    if (w < 210 || h < 76) return ["prompt"];

    const avail = h - PAD * 2;
    const out: LandingBlock[] = [];
    let used = 0;
    const fit = (block: LandingBlock, minW: number, blockH: number): void => {
        const gap = out.length === 0 ? 0 : GAP;
        if (w >= minW && used + gap + blockH <= avail) {
            out.push(block);
            used += gap + blockH;
        }
    };

    fit("header", 210, HEADER_H);
    fit("prompt", 0, promptHeight(w));
    if (out.indexOf("prompt") < 0) return ["prompt"];
    fit("fields", 300, CHIP_H);
    fit("hero", 330, HERO_H);

    const cols = tileColumns(w);
    const count = cols === 3 ? 6 : cols === 2 ? 4 : 2;
    const rows = Math.ceil(count / cols);
    fit("capabilities", 360, rows * TILE_H + (rows - 1) * TILE_GAP);

    // Keep the drawn order stable regardless of what was dropped.
    const order: LandingBlock[] = ["header", "prompt", "fields", "hero", "capabilities"];
    return order.filter((b) => out.indexOf(b) >= 0);
}

/**
 * The sentence that tells the author what to do next.
 *
 * The binding is the authority: `reason` stops at the FIRST unbound required
 * role, so a dataView with only Person ID reports MissingParentId — but a
 * caller that passes a stale or synthetic reason must still get the ask that
 * matches the wells the author can see.
 */
export function promptKey(reason: EmptyReason, bound: RoleBinding): string {
    if (bound.personId && !bound.parentId) return "Landing_NeedParent";
    if (!bound.personId && bound.parentId) return "Landing_NeedPerson";
    if (bound.personId && bound.parentId) {
        return reason === EmptyReason.None || reason === EmptyReason.NoData
            ? "Landing_NoRows" : "Landing_NeedBoth";
    }
    if (reason === EmptyReason.MissingPersonId) return "Landing_NeedPerson";
    if (reason === EmptyReason.MissingParentId) return "Landing_NeedParent";
    return "Landing_NeedBoth";
}

export function renderLanding(root: G, o: LandingOptions): void {
    root.selectAll("*").remove();

    const { surface: s, t } = o;
    const ink = s.fg;
    const muted = s.muted;
    const accent = o.highContrast ? s.fg : o.accent;
    const blocks = planBlocks(o.width, o.height);
    const prompt = t(promptKey(o.reason, o.bound));

    const g = root.append("g").attr("class", "landing")
        .attr("role", "img")
        .attr("aria-label", `${t("Landing_Title")}. ${prompt}`);

    if (blocks.length === 1) {
        const lines = wrapText(prompt, o.width - 20, 12, Math.max(1, Math.min(3, Math.floor((o.height - 16) / 15))));
        const text = g.append("text")
            .attr("class", "landing-prompt")
            .attr("text-anchor", "middle")
            .attr("font-family", fontFamily).attr("font-size", 12)
            .attr("fill", muted);
        const top = o.height / 2 - ((lines.length - 1) * 15) / 2 + 4;
        lines.forEach((l, i) => {
            text.append("tspan").attr("x", o.width / 2).attr("y", top + i * 15).text(l);
        });
        return;
    }

    const cols = tileColumns(o.width);
    const tileCount = cols === 3 ? 6 : cols === 2 ? 4 : 2;
    const tileRows = Math.ceil(tileCount / cols);
    const heightOf = (b: LandingBlock): number =>
        b === "header" ? HEADER_H
            : b === "prompt" ? promptHeight(o.width)
                : b === "fields" ? CHIP_H
                    : b === "hero" ? HERO_H
                        : tileRows * TILE_H + (tileRows - 1) * TILE_GAP;
    const total = blocks.reduce((a, b) => a + heightOf(b), 0) + (blocks.length - 1) * GAP;

    const cx = o.width / 2;
    const innerW = o.width - PAD * 2;
    let y = Math.max(PAD, (o.height - total) / 2);

    for (const block of blocks) {
        // The group is namespaced apart from the elements inside it — a shared
        // class name would make ".landing-prompt" match two nodes.
        const bg = g.append("g").attr("class", "landing-block landing-block-" + block)
            .attr("transform", `translate(0,${y})`);
        if (block === "header") drawHeader(bg, cx, innerW, ink, muted, accent, o);
        else if (block === "prompt") drawPrompt(bg, cx, innerW, muted, prompt, o.width);
        else if (block === "fields") drawFields(bg, cx, innerW, ink, muted, accent, o);
        else if (block === "hero") drawHero(bg, cx, innerW, o);
        else drawCapabilities(bg, cx, innerW, cols, tileCount, ink, muted, accent, o);
        y += heightOf(block) + GAP;
    }
}

/** Brand mark (the 20×20 asset icon, redrawn) + product name. */
function drawHeader(
    g: G, cx: number, innerW: number, ink: string, muted: string, accent: string, o: LandingOptions,
): void {
    const title = fitText(o.t("Landing_Title"), innerW - 34, 15);
    const w = 26 + textWidth(title, 15);
    const x = cx - w / 2;

    const mark = g.append("g").attr("transform", `translate(${x},2)`);
    const strong = o.highContrast ? ink : "#6344E0";
    const light = o.highContrast ? ink : "#B59CFF";
    mark.append("path")
        .attr("d", "M10 6.6v2.2M4.2 13.4v-1.3h11.6v1.3")
        .attr("fill", "none").attr("stroke", strong).attr("stroke-width", 1.4);
    mark.append("rect").attr("x", 6.6).attr("y", 2.4).attr("width", 6.8).attr("height", 4.2)
        .attr("rx", 1.2).attr("fill", o.highContrast ? "none" : accent)
        .attr("stroke", o.highContrast ? ink : "none").attr("stroke-width", 1.2);
    mark.append("rect").attr("x", 1.4).attr("y", 13.4).attr("width", 5.6).attr("height", 4.2)
        .attr("rx", 1.2).attr("fill", o.highContrast ? "none" : strong)
        .attr("stroke", o.highContrast ? ink : "none").attr("stroke-width", 1.2);
    mark.append("rect").attr("x", 13).attr("y", 13.4).attr("width", 5.6).attr("height", 4.2)
        .attr("rx", 1.2).attr("fill", o.highContrast ? "none" : light)
        .attr("stroke", o.highContrast ? ink : "none").attr("stroke-width", 1.2);

    g.append("text")
        .attr("class", "landing-title")
        .attr("x", x + 26).attr("y", 15)
        .attr("font-family", fontFamily).attr("font-size", 15).attr("font-weight", 600)
        .attr("fill", ink)
        .text(title);

    // Dropped rather than truncated: half a tagline says nothing.
    const tag = o.t("Landing_Tagline");
    if (textWidth(tag, 11) <= innerW) {
        g.append("text")
            .attr("class", "landing-tagline")
            .attr("x", cx).attr("y", 29)
            .attr("text-anchor", "middle")
            .attr("font-family", fontFamily).attr("font-size", 11)
            .attr("fill", muted)
            .text(tag);
    }
}

function drawPrompt(g: G, cx: number, innerW: number, muted: string, prompt: string, w: number): void {
    const lines = wrapText(prompt, innerW, 12.5, promptLines(w));
    const text = g.append("text")
        .attr("class", "landing-prompt")
        .attr("text-anchor", "middle")
        .attr("font-family", fontFamily).attr("font-size", 12.5)
        .attr("fill", muted);
    lines.forEach((l, i) => {
        text.append("tspan").attr("x", cx).attr("y", 13 + i * PROMPT_LINE).text(l);
    });
}

/** Field-well checklist: the two required wells tick as they are filled. */
function drawFields(
    g: G, cx: number, innerW: number, ink: string, muted: string, accent: string, o: LandingOptions,
): void {
    const make = (key: string, required: boolean, filled: boolean): Chip => {
        const label = o.t(key);
        return { label, required, filled, w: Math.round(textWidth(label, 11) + (required ? 34 : 20)) };
    };
    const all: Chip[] = [
        make("Role_PersonId", true, o.bound.personId),
        make("Role_ParentId", true, o.bound.parentId),
        make("Role_Name", false, o.bound.personName),
        make("Role_Title", false, o.bound.personTitle),
        make("Role_Photo", false, o.bound.photo),
        make("Role_Group", false, o.bound.group),
        make("Role_Measure", false, o.bound.measure),
    ];
    const rows = layoutChips(all, innerW, 1);
    const row = rows[0];
    if (!row) return;

    let x = cx - row.w / 2;
    for (const c of row.chips) {
        const chip = g.append("g").attr("class", "landing-chip")
            .attr("transform", `translate(${x},0)`);
        chip.append("rect")
            .attr("width", c.w).attr("height", CHIP_H).attr("rx", CHIP_H / 2)
            .attr("fill", "none")
            .attr("stroke", c.required ? (c.filled ? accent : ink) : muted)
            .attr("stroke-width", c.required ? 1.4 : 1)
            .attr("stroke-dasharray", c.required && !c.filled ? "3 3" : "")
            .attr("opacity", c.required ? 1 : 0.7);
        if (c.required) {
            const mx = 14;
            if (c.filled) {
                chip.append("path")
                    .attr("class", "chip-tick")
                    .attr("d", `M${mx - 4},${CHIP_H / 2} l3,3 l5.5,-6.5`)
                    .attr("fill", "none").attr("stroke", accent).attr("stroke-width", 1.8)
                    .attr("stroke-linecap", "round").attr("stroke-linejoin", "round");
            } else {
                chip.append("circle")
                    .attr("class", "chip-todo")
                    .attr("cx", mx).attr("cy", CHIP_H / 2).attr("r", 4)
                    .attr("fill", "none").attr("stroke", ink).attr("stroke-width", 1.4);
            }
        }
        chip.append("text")
            .attr("x", c.required ? 24 : 10).attr("y", CHIP_H / 2 + 4)
            .attr("font-family", fontFamily).attr("font-size", 11)
            .attr("font-weight", c.required ? 600 : 400)
            .attr("fill", c.required ? ink : muted)
            .text(c.label);
        x += c.w + CHIP_GAP;
    }
}

/**
 * Wireframe preview of the chart itself: a root, three reports, one collapsed.
 * Deliberately text-free — grey bars stand in for the name and title lines, so
 * the preview needs no translation and never claims data the author has not
 * supplied.
 */
function drawHero(g: G, cx: number, innerW: number, o: LandingOptions): void {
    const w = Math.min(innerW, HERO_MAX_W);
    const x0 = cx - w / 2;
    const s = o.surface;
    const frame = g.append("g").attr("transform", `translate(${x0},0)`);

    frame.append("rect")
        .attr("class", "hero-frame")
        .attr("width", w).attr("height", HERO_H).attr("rx", 12)
        .attr("fill", o.highContrast ? "none" : s.cardFill)
        .attr("stroke", s.cardStroke).attr("stroke-width", o.highContrast ? 1.5 : 1)
        .attr("opacity", o.highContrast ? 1 : 0.6);

    const cw = Math.min(112, (w - 60) / 3);
    const ch = 34;
    const rootY = 22;
    const childY = 84;
    const cols = [w / 2 - cw - 14, w / 2, w / 2 + cw + 14];

    const card = (x: number, y: number, i: number, collapsed: boolean): void => {
        const c = frame.append("g").attr("class", "hero-card")
            .attr("transform", `translate(${x - cw / 2},${y - ch / 2})`);
        c.append("rect")
            .attr("width", cw).attr("height", ch).attr("rx", 7)
            .attr("fill", o.highContrast ? s.bg : "#FFFFFF")
            .attr("stroke", o.highContrast ? s.fg : s.cardStroke)
            .attr("stroke-width", o.highContrast ? 1.6 : 1);
        c.append("rect")
            .attr("class", "hero-accent")
            .attr("width", 3.5).attr("height", ch).attr("rx", 1.8)
            .attr("fill", o.highContrast ? s.fg : o.groupColor(i));
        c.append("circle")
            .attr("class", "hero-avatar")
            .attr("cx", 17).attr("cy", ch / 2).attr("r", 8)
            .attr("fill", "none")
            .attr("stroke", o.highContrast ? s.fg : o.groupColor(i)).attr("stroke-width", 1.4);
        c.append("rect")
            .attr("class", "hero-line")
            .attr("x", 30).attr("y", ch / 2 - 8).attr("width", Math.max(18, cw - 42)).attr("height", 5)
            .attr("rx", 2.5).attr("fill", o.highContrast ? s.fg : s.muted).attr("opacity", 0.75);
        c.append("rect")
            .attr("class", "hero-line")
            .attr("x", 30).attr("y", ch / 2 + 1).attr("width", Math.max(12, cw - 60)).attr("height", 4)
            .attr("rx", 2).attr("fill", s.muted).attr("opacity", 0.45);
        if (collapsed) {
            const t = c.append("g").attr("class", "hero-toggle")
                .attr("transform", `translate(${cw / 2},${ch + 1})`);
            t.append("circle").attr("r", 7)
                .attr("fill", o.highContrast ? s.bg : "#FFFFFF")
                .attr("stroke", o.highContrast ? s.fg : o.groupColor(i)).attr("stroke-width", 1.4);
            t.append("path").attr("d", "M-3.2,0 h6.4 M0,-3.2 v6.4")
                .attr("stroke", o.highContrast ? s.fg : o.groupColor(i)).attr("stroke-width", 1.4)
                .attr("stroke-linecap", "round");
        }
    };

    const elbow = (x: number): void => {
        const midY = (rootY + ch / 2 + childY - ch / 2) / 2;
        frame.append("path")
            .attr("class", "hero-connector")
            .attr("d", `M${w / 2},${rootY + ch / 2} V${midY} H${x} V${childY - ch / 2}`)
            .attr("fill", "none")
            .attr("stroke", o.highContrast ? s.fg : s.connector)
            .attr("stroke-width", 1.4).attr("stroke-linejoin", "round");
    };

    cols.forEach((x) => elbow(x));
    card(w / 2, rootY, 0, false);
    cols.forEach((x, i) => card(x, childY, i + 1, i === 2));
}

/** One pictogram per capability, drawn inside a 42×34 box at the tile's left. */
function pictogram(g: G, key: CapabilityKey, ink: string, accent: string, muted: string): void {
    const line = (d: string, color: string, width = 1.4, dash = ""): void => {
        g.append("path").attr("d", d)
            .attr("fill", "none").attr("stroke", color).attr("stroke-width", width)
            .attr("stroke-dasharray", dash)
            .attr("stroke-linecap", "round").attr("stroke-linejoin", "round");
    };
    const box = (x: number, y: number, w: number, h: number, color: string, dash = ""): void => {
        g.append("rect").attr("x", x).attr("y", y).attr("width", w).attr("height", h).attr("rx", 3)
            .attr("fill", "none").attr("stroke", color).attr("stroke-width", 1.4)
            .attr("stroke-dasharray", dash);
    };

    if (key === "anyRoot") {
        // The parent cell is blank — and the row below is still a root.
        box(3, 1, 36, 11, muted, "3 2");
        line("M21,12 v5", muted, 1.2, "2 2");
        box(9, 17, 24, 13, accent);
        line("M14, 23.5 h6", accent, 1.6);
        line("M14, 27 h11", muted, 1.4);
    } else if (key === "collapse") {
        // A manager, its toggle, and the reports folded away beneath it.
        box(11, 0, 20, 11, accent);
        line("M21,11 v3", muted, 1.2);
        g.append("circle").attr("cx", 21).attr("cy", 19).attr("r", 5.2)
            .attr("fill", "none").attr("stroke", accent).attr("stroke-width", 1.4);
        line("M18.6,19 h4.8 M21,16.6 v4.8", accent, 1.4);
        box(6, 26, 12, 7, muted, "2.5 2");
        box(24, 26, 12, 7, muted, "2.5 2");
    } else if (key === "crossFilter") {
        // Click a card (the cursor) and the chart beside it narrows.
        box(0, 1, 18, 11, accent);
        g.append("path").attr("d", "M10,13 l8.6,5.6 l-4.1,0.9 l-1.4,4 z")
            .attr("fill", ink).attr("stroke", "none");
        line("M26,30 v-8 M31,30 v-16 M36,30 v-12", ink, 2.4);
        line("M23.5,32 h16", muted, 1.2);
    } else if (key === "cycles") {
        // A reporting loop: three people pointing back at each other.
        line("M21,8 L31.5,25.5 L10.5,25.5 Z", accent, 1.5);
        g.append("path").attr("d", "M17.4,13.8 L16.8,18.7 L13.3,16.6 Z")
            .attr("fill", accent).attr("stroke", "none");
        for (const [cx, cy] of [[21, 6], [33, 27], [9, 27]]) {
            g.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 3.4)
                .attr("fill", "none").attr("stroke", muted).attr("stroke-width", 1.6);
        }
    } else if (key === "wideRow") {
        box(14, 0, 14, 8, accent);
        line("M21,8 v5 M6,13 h30 M6,13 v4 M13.5,13 v4 M21,13 v4 M28.5,13 v4 M36,13 v4", muted, 1.2);
        for (let i = 0; i < 5; i++) {
            box(2 + i * 7.5, 17, 8, 9, i === 2 ? accent : muted);
        }
    } else {
        // Both orientations: a top-down stub beside a left-to-right one.
        box(2, 2, 12, 7, accent);
        line("M8,9 v3.5 M1,12.5 h14 M1,12.5 v3 M15,12.5 v3", muted, 1.2);
        box(0, 15.5, 6, 7, muted);
        box(10, 15.5, 6, 7, muted);
        box(21, 11, 10, 7, accent);
        line("M31,14.5 h3 M34,8 v13 M34,8 h2 M34,21 h2", muted, 1.2);
        box(36, 4.5, 6, 7, muted);
        box(36, 17.5, 6, 7, muted);
    }
}

function drawCapabilities(
    g: G, cx: number, innerW: number, cols: number, count: number,
    ink: string, muted: string, accent: string, o: LandingOptions,
): void {
    const gridW = Math.min(innerW, cols === 3 ? 900 : cols === 2 ? 620 : 320);
    const tileW = (gridW - TILE_GAP * (cols - 1)) / cols;
    const x0 = cx - gridW / 2;

    CAPABILITY_KEYS.slice(0, count).forEach((key, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const tile = g.append("g")
            .attr("class", "landing-tile")
            .attr("transform", `translate(${x0 + col * (tileW + TILE_GAP)},${row * (TILE_H + TILE_GAP)})`);

        tile.append("rect")
            .attr("width", tileW).attr("height", TILE_H).attr("rx", 9)
            .attr("fill", o.highContrast ? "none" : o.surface.cardFill)
            .attr("stroke", o.surface.cardStroke)
            .attr("stroke-width", o.highContrast ? 1.4 : 1)
            .attr("opacity", o.highContrast ? 1 : 0.55);

        const art = tile.append("g")
            .attr("class", "tile-art")
            .attr("transform", "translate(12,14)");
        pictogram(art, key, ink, accent, muted);

        const textX = 62;
        const textW = tileW - textX - 12;
        const cap = "Cap_" + key.charAt(0).toUpperCase() + key.slice(1);
        tile.append("text")
            .attr("class", "tile-title")
            .attr("x", textX).attr("y", 25)
            .attr("font-family", fontFamily).attr("font-size", 11.5).attr("font-weight", 600)
            .attr("fill", ink)
            .text(fitText(o.t(cap), textW, 11.5));
        tile.append("text")
            .attr("class", "tile-sub")
            .attr("x", textX).attr("y", 41)
            .attr("font-family", fontFamily).attr("font-size", 10)
            .attr("fill", muted)
            .text(fitText(o.t(cap + "_Sub"), textW, 10));
    });
}
