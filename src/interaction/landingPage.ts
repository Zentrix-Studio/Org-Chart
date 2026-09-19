"use strict";

/**
 * Landing / onboarding carousel — shown when the visual is loaded with nothing
 * bound. Follows the family pattern (Calendar Heatmap → Sankey → Network Graph →
 * Gantt): a responsive, theme-aware card pairing a deterministic product
 * illustration with concise setup guidance, one MVP per page.
 *
 * Mounted from the visual constructor because Power BI does not call update()
 * until a role is bound, so a page shown only from update() never appears on an
 * empty visual.
 *
 * This sits ON TOP of `render/landing.ts`, which keeps drawing into the SVG
 * underneath. That is deliberate: the carousel is an absolutely-positioned
 * overlay, and if it ever fails to mount, the in-canvas ask and field checklist
 * are still there. The two never disagree — the carousel only ever appears when
 * NOTHING is bound, which is exactly the state whose SVG counterpart is the
 * generic "add a Person ID and a Reports to" ask.
 *
 * Cert-safe by construction: createElement / textContent / inline SVG, plus the
 * company mark as a bundled base64 data URI (`brand/zentrixMark.ts`). No
 * innerHTML, no external asset, no network access, no non-deterministic motion.
 */

import { Surface, accentStrong, categoryPalette } from "../theme/zentrixTokens";
import { zentrixMark } from "../brand/zentrixMark";

const NS = "http://www.w3.org/2000/svg";
const STYLE_ID = "zx-orgchart-landing-style";
type Cleanup = () => void;

interface SceneContext { dark: boolean; surface: Surface; }

/* ------------------------------------------------------------------ */
/* SVG primitives                                                      */
/* ------------------------------------------------------------------ */

function svgNode(viewBox: string, width: number, height: number): SVGSVGElement {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("aria-hidden", "true");
    return svg;
}

function rectNode(
    x: number, y: number, w: number, h: number, r: number, fill: string,
    stroke?: string, strokeWidth = 1, dash?: string,
): SVGRectElement {
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", String(r));
    rect.setAttribute("fill", fill);
    if (stroke) {
        rect.setAttribute("stroke", stroke);
        rect.setAttribute("stroke-width", String(strokeWidth));
        if (dash) rect.setAttribute("stroke-dasharray", dash);
    }
    return rect;
}

function circleNode(cx: number, cy: number, r: number, fill: string, stroke?: string): SVGCircleElement {
    const circle = document.createElementNS(NS, "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", String(r));
    circle.setAttribute("fill", fill);
    if (stroke) { circle.setAttribute("stroke", stroke); circle.setAttribute("stroke-width", "1.4"); }
    return circle;
}

function pathNode(d: string, stroke: string, width = 1.6, dash?: string, fill = "none"): SVGPathElement {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", fill);
    path.setAttribute("stroke", stroke);
    path.setAttribute("stroke-width", String(width));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    if (dash) path.setAttribute("stroke-dasharray", dash);
    return path;
}

function textNode(
    x: number, y: number, value: string,
    options: { size?: number; fill?: string; weight?: number; anchor?: string } = {},
): SVGTextElement {
    const text = document.createElementNS(NS, "text");
    text.setAttribute("x", String(x));
    text.setAttribute("y", String(y));
    text.setAttribute("font-family", "Segoe UI, system-ui, sans-serif");
    text.setAttribute("font-size", String(options.size ?? 10));
    text.setAttribute("fill", options.fill ?? "#64647A");
    if (options.weight) text.setAttribute("font-weight", String(options.weight));
    if (options.anchor) text.setAttribute("text-anchor", options.anchor);
    text.textContent = value;
    return text;
}

/** An elbow connector between two card centres, the shape the visual itself draws. */
function elbow(x1: number, y1: number, x2: number, y2: number, stroke: string): SVGPathElement {
    const mid = (y1 + y2) / 2;
    return pathNode(`M${x1},${y1} V${mid} H${x2} V${y2}`, stroke, 1.4);
}

/* ------------------------------------------------------------------ */
/* Card — the one motif every scene is built from                      */
/* ------------------------------------------------------------------ */

interface CardOptions {
    accentColor?: string;
    photo?: boolean;
    badge?: string;
    dashed?: boolean;
    dim?: boolean;
    label?: string;
}

/** A miniature of the visual's own card: accent bar, optional avatar, two text lines. */
function card(
    g: SVGElement, x: number, y: number, w: number, h: number,
    ctx: SceneContext, options: CardOptions = {},
): void {
    const s = ctx.surface;
    const tone = options.accentColor ?? accentStrong;
    const fill = ctx.dark ? "#1C1C28" : "#FFFFFF";
    const stroke = ctx.dark ? "#33334A" : "#E1E1EC";
    const line = ctx.dark ? "#3A3A52" : "#DCDCE8";
    const op = options.dim ? "0.45" : "1";

    const group = document.createElementNS(NS, "g");
    group.setAttribute("opacity", op);

    group.appendChild(rectNode(x, y, w, h, 5, fill, stroke, 1, options.dashed ? "3 2.5" : undefined));
    // accent bar down the left edge
    group.appendChild(rectNode(x, y, 3, h, 1.5, tone));

    const textLeft = options.photo ? x + 9 + h * 0.52 : x + 9;
    if (options.photo) {
        const r = h * 0.26;
        group.appendChild(circleNode(x + 8 + r, y + h / 2, r, tone));
    }
    // name line + title line, as bars — no text means no translation and no
    // claim about data the author has not supplied
    const avail = x + w - textLeft - (options.badge ? 20 : 7);
    group.appendChild(rectNode(textLeft, y + h * 0.30, Math.max(8, avail * 0.82), 3.2, 1.6, s.fg));
    group.appendChild(rectNode(textLeft, y + h * 0.56, Math.max(6, avail * 0.55), 2.6, 1.3, line));

    if (options.badge) {
        group.appendChild(rectNode(x + w - 21, y + h / 2 - 6, 16, 12, 3, ctx.dark ? "#2A2A3C" : "#F1EEFE"));
        group.appendChild(textNode(x + w - 13, y + h / 2 + 3.4, options.badge,
            { size: 7.5, fill: tone, weight: 700, anchor: "middle" }));
    }
    if (options.label) {
        group.appendChild(textNode(x + w / 2, y - 5, options.label,
            { size: 8.5, fill: s.muted, weight: 600, anchor: "middle" }));
    }
    g.appendChild(group);
}

/* ------------------------------------------------------------------ */
/* Scenes — one per page                                               */
/* ------------------------------------------------------------------ */

const VB = "0 0 320 230";

/** Welcome: a clean two-level tree, the thing the visual draws. */
function sceneWelcome(ctx: SceneContext): SVGSVGElement {
    const svg = svgNode(VB, 320, 230);
    const line = ctx.dark ? "#4A4A63" : "#C9C9D8";
    const kids = [30, 125, 220];
    kids.forEach((kx) => svg.appendChild(elbow(160, 74, kx + 35, 116, line)));
    svg.appendChild(elbow(65, 158, 65, 186, line));
    svg.appendChild(elbow(65, 158, 160, 186, line));

    card(svg, 105, 40, 110, 34, ctx, { photo: true, accentColor: accentStrong, badge: "128" });
    card(svg, 0, 116, 70, 30, ctx, { photo: true, accentColor: categoryPalette[1] });
    card(svg, 95, 116, 70, 30, ctx, { photo: true, accentColor: categoryPalette[2] });
    card(svg, 190, 116, 70, 30, ctx, { photo: true, accentColor: categoryPalette[3] });
    card(svg, 30, 186, 70, 28, ctx, { accentColor: categoryPalette[1], dim: true });
    card(svg, 125, 186, 70, 28, ctx, { accentColor: categoryPalette[1], dim: true });
    return svg;
}

/** MVP 1: every root shape, and cycles that cannot hang it. */
function sceneAnyRoot(ctx: SceneContext): SVGSVGElement {
    const svg = svgNode(VB, 320, 230);
    const s = ctx.surface;
    const line = ctx.dark ? "#4A4A63" : "#C9C9D8";
    const ok = categoryPalette[6];

    const rows: Array<[string, number]> = [
        ["parent is blank", 26],
        ["parent not in the data", 74],
        ["points at itself", 122],
        ["A → B → A", 170],
    ];
    rows.forEach(([label, y]) => {
        svg.appendChild(textNode(0, y - 6, label, { size: 8.5, fill: s.muted, weight: 600 }));
        card(svg, 0, y, 104, 26, ctx, { accentColor: categoryPalette[4], dashed: true });
        svg.appendChild(pathNode(`M112,${y + 13} H140`, line, 1.4, "3 3"));
        svg.appendChild(pathNode(`M134,${y + 9} l5,4 l-5,4`, line, 1.4));
    });

    // the self-reference and the cycle, drawn as loops on the left column
    svg.appendChild(pathNode("M104,135 q16,0 16,-9 q0,-9 -16,-9", categoryPalette[4], 1.3, "2.5 2.5"));
    svg.appendChild(pathNode("M104,183 q16,0 16,-9 q0,-9 -16,-9", categoryPalette[4], 1.3, "2.5 2.5"));

    // all four resolve to roots of one forest
    svg.appendChild(rectNode(146, 14, 174, 202, 9, "none", ok, 1.3, "4 3"));
    svg.appendChild(textNode(233, 30, "ALL FOUR BECOME ROOTS",
        { size: 8.5, fill: ok, weight: 700, anchor: "middle" }));
    [42, 90, 138, 186].forEach((y, i) => {
        card(svg, 160, y, 96, 26, ctx, { accentColor: categoryPalette[i], photo: true });
        svg.appendChild(circleNode(272, y + 13, 7, "none", ok));
        svg.appendChild(pathNode(`M268.5,${y + 13} l2.5,2.5 l4.5,-5.5`, ok, 1.6));
    });
    return svg;
}

/** MVP 2: the same two fields draw hierarchies that are not org charts. */
function sceneAnyDomain(ctx: SceneContext): SVGSVGElement {
    const svg = svgNode(VB, 320, 230);
    const s = ctx.surface;
    const line = ctx.dark ? "#4A4A63" : "#C9C9D8";
    const cols: Array<[string, number, string]> = [
        ["People", 0, categoryPalette[0]],
        ["Accounts", 110, categoryPalette[1]],
        ["Parts", 220, categoryPalette[2]],
    ];
    cols.forEach(([label, x, tone]) => {
        svg.appendChild(textNode(x + 50, 16, label, { size: 10, fill: s.fg, weight: 700, anchor: "middle" }));
        card(svg, x + 20, 30, 60, 24, ctx, { accentColor: tone as string });
        svg.appendChild(elbow(x + 50, 54, x + 25, 84, line));
        svg.appendChild(elbow(x + 50, 54, x + 75, 84, line));
        card(svg, x + 0, 84, 50, 22, ctx, { accentColor: tone as string });
        card(svg, x + 50, 84, 50, 22, ctx, { accentColor: tone as string });
        svg.appendChild(elbow(x + 25, 106, x + 25, 134, line));
        svg.appendChild(elbow(x + 75, 106, x + 75, 134, line));
        card(svg, x + 0, 134, 50, 22, ctx, { accentColor: tone as string, dim: true });
        card(svg, x + 50, 134, 50, 22, ctx, { accentColor: tone as string, dim: true });
    });
    svg.appendChild(rectNode(0, 178, 320, 40, 8, ctx.dark ? "#1B1B28" : "#F5F3FE"));
    svg.appendChild(textNode(160, 196, "Person ID  +  Reports to",
        { size: 11, fill: accentStrong, weight: 700, anchor: "middle" }));
    svg.appendChild(textNode(160, 210, "two fields, every hierarchy above",
        { size: 8.5, fill: s.muted, anchor: "middle" }));
    return svg;
}

/** MVP 3: a big org stays readable — stacked reports, a legibility floor, collapse. */
function sceneScale(ctx: SceneContext): SVGSVGElement {
    const svg = svgNode(VB, 320, 230);
    const s = ctx.surface;
    const line = ctx.dark ? "#4A4A63" : "#C9C9D8";

    // A manager with nine reports, stacked in three columns off their spines —
    // what the chart actually draws for a wide team since OC-030.
    card(svg, 120, 6, 80, 24, ctx, { accentColor: accentStrong });
    svg.appendChild(pathNode("M160,30 V40 M44,40 H244", line, 1));
    for (let c = 0; c < 3; c++) {
        const spine = 44 + c * 100;
        svg.appendChild(pathNode(`M${spine},40 V${48 + 2 * 30 + 11}`, line, 1));
        for (let r = 0; r < 3; r++) {
            const y = 48 + r * 30;
            svg.appendChild(pathNode(`M${spine},${y + 11} H${spine + 8}`, line, 1));
            card(svg, spine + 8, y, 70, 22, ctx, { accentColor: categoryPalette[(c * 3 + r) % 8] });
        }
    }
    svg.appendChild(textNode(160, 150, "Wide teams stack into columns — every name stays 9px or larger",
        { size: 8.5, fill: s.muted, anchor: "middle" }));

    // a collapsed branch carrying its count
    card(svg, 20, 164, 80, 24, ctx, { accentColor: categoryPalette[3] });
    svg.appendChild(rectNode(47, 181, 26, 16, 8, accentStrong));
    svg.appendChild(textNode(60, 192, "13.7K", { size: 7.5, fill: "#FFFFFF", weight: 700, anchor: "middle" }));
    svg.appendChild(textNode(112, 180, "Too big to read whole? It opens collapsed.",
        { size: 8.5, fill: s.muted }));
    svg.appendChild(textNode(160, 214, "Zoom, pan, or fit. A note says when part of the chart is off screen.",
        { size: 8.5, fill: s.muted, anchor: "middle" }));
    return svg;
}

/** MVP 4: the card is yours — and every control actually does something. */
function sceneCard(ctx: SceneContext): SVGSVGElement {
    const svg = svgNode(VB, 320, 230);
    const s = ctx.surface;
    const line = ctx.dark ? "#4A4A63" : "#C9C9D8";

    card(svg, 60, 30, 200, 70, ctx, { photo: true, accentColor: accentStrong, badge: "42" });

    const callouts: Array<[string, number, number, number]> = [
        ["accent bar", 0, 44, 58],
        ["photo", 0, 68, 58],
        ["name + title", 0, 92, 58],
        ["measure badge", 262, 66, 320],
    ];
    callouts.forEach(([label, tx, ty, lx]) => {
        const anchor = tx === 0 ? "end" : "start";
        svg.appendChild(textNode(tx === 0 ? 56 : tx, ty + 3, label,
            { size: 8.5, fill: s.muted, weight: 600, anchor }));
        void lx;
    });
    svg.appendChild(pathNode("M244,66 H262", line, 1.2, "2 2"));

    // colour modes
    svg.appendChild(textNode(160, 132, "COLOUR BY", { size: 8.5, fill: s.muted, weight: 700, anchor: "middle" }));
    const modes: Array<[string, number, string[]]> = [
        ["Single", 6, [accentStrong, accentStrong, accentStrong]],
        ["Group", 116, [categoryPalette[1], categoryPalette[2], categoryPalette[3]]],
        ["Level", 226, [categoryPalette[0], categoryPalette[7], categoryPalette[4]]],
    ];
    modes.forEach(([label, x, tones]) => {
        svg.appendChild(rectNode(x, 142, 88, 44, 7, ctx.dark ? "#181824" : "#FAFAFE",
            ctx.dark ? "#2E2E42" : "#E6E6F0"));
        (tones as string[]).forEach((tone, i) => {
            svg.appendChild(rectNode(x + 8 + i * 25, 152, 20, 12, 3, tone));
        });
        svg.appendChild(textNode(x + 44, 179, label as string,
            { size: 9, fill: s.fg, weight: 600, anchor: "middle" }));
    });
    svg.appendChild(textNode(160, 208, "Set a colour and it stays set — through refresh, page change and reopen.",
        { size: 8.5, fill: s.muted, anchor: "middle" }));
    return svg;
}

/** MVP 5: it answers questions about the org, not only draws it. */
function sceneAnalysis(ctx: SceneContext): SVGSVGElement {
    const svg = svgNode(VB, 320, 230);
    const s = ctx.surface;
    const line = ctx.dark ? "#4A4A63" : "#C9C9D8";
    const warn = categoryPalette[4];

    card(svg, 124, 14, 72, 26, ctx, { accentColor: accentStrong, badge: "12" });
    svg.appendChild(elbow(160, 40, 46, 74, line));
    svg.appendChild(elbow(160, 40, 160, 74, line));
    svg.appendChild(elbow(160, 40, 274, 74, line));
    card(svg, 10, 74, 72, 26, ctx, { accentColor: categoryPalette[1], badge: "9" });
    card(svg, 124, 74, 72, 26, ctx, { accentColor: categoryPalette[2], badge: "1" });
    card(svg, 238, 74, 72, 26, ctx, { accentColor: categoryPalette[3], badge: "2" });

    // span-of-control flags
    svg.appendChild(rectNode(10, 104, 72, 13, 3, warn));
    svg.appendChild(textNode(46, 113.5, "WIDE SPAN", { size: 7.5, fill: "#1A1A1F", weight: 700, anchor: "middle" }));
    svg.appendChild(rectNode(124, 104, 72, 13, 3, categoryPalette[5]));
    svg.appendChild(textNode(160, 113.5, "NARROW", { size: 7.5, fill: "#FFFFFF", weight: 700, anchor: "middle" }));

    // dotted-line report — an extra edge, never a second parent
    svg.appendChild(pathNode("M82,87 H124", categoryPalette[7], 1.6, "4 3"));
    svg.appendChild(textNode(103, 80, "dotted line", { size: 7.5, fill: categoryPalette[7], weight: 600, anchor: "middle" }));

    // period comparison
    svg.appendChild(rectNode(0, 138, 320, 52, 8, ctx.dark ? "#1B1B28" : "#F5F3FE"));
    svg.appendChild(textNode(160, 155, "Q1  →  Q2", { size: 10, fill: s.fg, weight: 700, anchor: "middle" }));
    const marks: Array<[string, string, number]> = [
        ["+ joiners", categoryPalette[6], 42],
        ["− leavers", categoryPalette[5], 160],
        ["→ movers", categoryPalette[3], 272],
    ];
    marks.forEach(([label, tone, x]) => {
        svg.appendChild(circleNode(x - 34, 173, 4.5, tone as string));
        svg.appendChild(textNode(x - 26, 176.5, label as string, { size: 8.5, fill: s.muted, weight: 600 }));
    });
    svg.appendChild(textNode(160, 212, "Span of control, layers, roll-ups, vacancies — computed in the visual.",
        { size: 8.5, fill: s.muted, anchor: "middle" }));
    return svg;
}

/** MVP 6: free in full, and safe to put in a governed report. */
function sceneFree(ctx: SceneContext): SVGSVGElement {
    const svg = svgNode(VB, 320, 230);
    const s = ctx.surface;
    const ok = categoryPalette[6];

    // open padlock
    svg.appendChild(pathNode("M138,64 v-12 a16,16 0 0 1 32,0", ok, 4));
    svg.appendChild(rectNode(120, 64, 56, 42, 7, ok));
    svg.appendChild(circleNode(148, 83, 5.5, ctx.dark ? "#0A0A0F" : "#FFFFFF"));

    svg.appendChild(textNode(160, 132, "Everything. Free.",
        { size: 15, fill: s.fg, weight: 800, anchor: "middle" }));

    // Only what a reader can actually reach in this build. Image export has no
    // on-screen control yet, and the rules and note editors are not ported, so
    // they are not advertised (OC-030; QA 2026-09-19 carousel-copy finding).
    const chips = ["No node cap", "Dotted lines", "Org analysis", "Table + CSV", "Period compare"];
    let x = 0;
    let y = 148;
    chips.forEach((label) => {
        const w = 11 + label.length * 5.4;
        if (x + w > 320) { x = 0; y += 24; }
        svg.appendChild(rectNode(x, y, w, 18, 9, ctx.dark ? "#1E2A24" : "#EAF7EF"));
        svg.appendChild(textNode(x + w / 2, y + 12.5, label,
            { size: 8.5, fill: ok, weight: 600, anchor: "middle" }));
        x += w + 6;
    });

    svg.appendChild(textNode(160, y + 44, "No network calls. Your data never leaves the report.",
        { size: 8.5, fill: s.muted, anchor: "middle" }));
    return svg;
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

interface PageDefinition {
    eyebrow: string;
    title: string;
    lines: string[];
    scene: (context: SceneContext) => SVGSVGElement;
}

export const PAGES: PageDefinition[] = [
    {
        eyebrow: "Zentrix Org Chart",
        title: "Any parent-child hierarchy, drawn as a tree of cards",
        scene: sceneWelcome,
        lines: [
            "Bind two fields — a Person ID and a Reports to — and the chart draws itself. Everything else is optional.",
            "Built against the failures of the org charts already on AppSource: roots that must be numbered 1, collapse that forgets on refresh, controls that do nothing, and wide rows that overlap.",
            "Free in full. Nothing here is behind a paywall.",
        ],
    },
    {
        eyebrow: "MVP 1 · Messy hierarchies",
        title: "Your data does not have to be tidy first",
        scene: sceneAnyRoot,
        lines: [
            "• The top row can have a blank parent, a missing one, a parent that is not in the data, or a parent that is itself. All four are roots.",
            "• No magic value. The root's ID does not have to be 1, or 0, or blank.",
            "• More than one root is fine — you get a forest, not an error.",
            "• A reporting cycle becomes a root instead of hanging the visual. The walk is iterative, so a 5,000-deep chain cannot overflow the stack.",
        ],
    },
    {
        eyebrow: "MVP 2 · Not only org charts",
        title: "The same two fields draw far more than people",
        scene: sceneAnyDomain,
        lines: [
            "• Chart of accounts, bill of materials, product hierarchy, legal-entity structure, folder tree, category tree.",
            "• ID and Parent accept text, numbers or measures — no fixed key format and no blank-means-root rule.",
            "• Cards cross-filter the rest of the page, so any hierarchy becomes a navigation control for the report.",
            "If you can express it as a row and its parent, this draws it.",
        ],
    },
    {
        eyebrow: "MVP 3 · Big orgs stay readable",
        title: "It opens at a size you can actually read",
        scene: sceneScale,
        lines: [
            "• A manager's direct reports stack into columns when one row would be too wide to read. Leaf reports: Auto, Row or Stacked.",
            "• Nothing opens with a name smaller than 9 px. If the whole chart won't fit at that size, it opens collapsed to the levels that do, each with a count of what's folded away.",
            "• Zoom out with − or the wheel to see all of it. Fit and search bring you back to a readable size, and a note says when part of the chart is off screen.",
            "• Collapse is stored by key, not by row position, so a filter, a re-sort or a refresh cannot lose it — and a bookmark or Undo brings it back.",
        ],
    },
    {
        eyebrow: "MVP 4 · Cards you control",
        title: "Every control does something",
        scene: sceneCard,
        lines: [
            "• Size, corner radius, photo, measure badge, name and title sizing, connector style and thickness.",
            "• Colour by a single colour, by Group, or by Level — with a legend, and the accent picker hidden where it would do nothing.",
            "• Colours survive a refresh, a page change and a reopen. Power BI silently drops colours written the usual way; this works around that.",
            "• Report theme and Windows high contrast are both honoured.",
        ],
    },
    {
        eyebrow: "MVP 5 · Org analysis built in",
        title: "Questions a picture of the org cannot answer",
        scene: sceneAnalysis,
        lines: [
            "• Span of control per manager, with wide and narrow spans flagged at thresholds you set.",
            "• Layer counts, roll-ups down each branch, and vacancy flagging.",
            "• Dotted-line reporting as a second edge — it never moves a card to a second parent.",
            "• Bind a Period and compare two snapshots: joiners, leavers and movers.",
        ],
    },
    {
        eyebrow: "MVP 6 · Free, and certifiable",
        title: "No paywall, no node cap, no network calls",
        scene: sceneFree,
        lines: [
            "• Every capability is free in Desktop and in the Service, for everyone who opens the report.",
            "• No limit on the number of people or rows.",
            "• No external calls of any kind — photos are data URIs only, and report data never leaves the Power BI sandbox.",
            "• Keyboard navigation, high contrast, and localized strings throughout.",
        ],
    },
];

/* ------------------------------------------------------------------ */
/* The carousel                                                        */
/* ------------------------------------------------------------------ */

interface LandingActions {
    onSupport?: () => void;
    onLinkedIn?: () => void;
}

export class LandingPage {
    private root: HTMLElement;
    private host?: HTMLElement;
    private page = 0;
    private surface: Surface = {
        bg: "#FFFFFF", fg: "#15161E", muted: "#54566B",
        cardFill: "#FFFFFF", cardStroke: "#E1E1EC", connector: "#C9C9D8",
    };
    private cleanups: Cleanup[] = [];

    constructor(root: HTMLElement, private actions: LandingActions = {}) {
        this.root = root;
        this.injectStyle();
    }

    /** Pages shown, for tests and for the caller's aria label. */
    public get pageCount(): number { return PAGES.length; }

    /** Currently visible page index. */
    public get pageIndex(): number { return this.page; }

    /** True while the carousel is mounted. */
    public get visible(): boolean { return !!this.host; }

    setTheme(surface: Surface): void {
        this.surface = surface;
        if (this.host) {
            this.applyTheme();
            this.render();
        }
    }

    show(): void {
        if (this.host) { this.render(); return; }
        if (getComputedStyle(this.root).position === "static") this.root.style.position = "relative";
        const host = document.createElement("div");
        host.className = "zx-lp";
        host.setAttribute("role", "region");
        host.setAttribute("aria-label", "Getting started with Zentrix Org Chart");
        host.tabIndex = 0;
        this.root.appendChild(host);
        this.host = host;
        this.applyTheme();

        const onKey = (event: KeyboardEvent) => {
            if (event.key === "ArrowRight") { this.go(1); event.preventDefault(); }
            else if (event.key === "ArrowLeft") { this.go(-1); event.preventDefault(); }
        };
        host.addEventListener("keydown", onKey);
        this.cleanups.push(() => host.removeEventListener("keydown", onKey));

        // Size the deck from the VISUAL's box, not the window's (OC-028). The old
        // `@media (max-width:560px)` rule matched the window — right inside Power
        // BI's per-visual iframe, but nothing ever answered HEIGHT, so a 400×300
        // visual squeezed the body to zero and a 200×150 tile clipped the title.
        // Power BI does not call update() while nothing is bound, so the deck has
        // to watch its own box.
        this.applySize();
        const RO = (window as unknown as { ResizeObserver?: new (cb: () => void) => { observe(e: Element): void; disconnect(): void } }).ResizeObserver;
        if (RO) {
            const ro = new RO(() => this.applySize());
            ro.observe(this.root);
            this.cleanups.push(() => ro.disconnect());
        } else {
            const onResize = (): void => this.applySize();
            window.addEventListener("resize", onResize);
            this.cleanups.push(() => window.removeEventListener("resize", onResize));
        }

        this.page = 0;
        this.render();
    }

    /**
     * `data-size` on the deck: `full`, `compact` (narrow or short — art hidden,
     * type smaller) or `tiny` (a tile — brand mark, title and navigation only).
     * Public so the visual can push a size when it has one; a host that measures
     * nothing reports 0×0 and keeps the full layout.
     */
    public applySize(width?: number, height?: number): void {
        if (!this.host) return;
        const w = width ?? this.root.clientWidth;
        const h = height ?? this.root.clientHeight;
        let size = "full";
        if (w > 0 && h > 0) {
            if (w < 300 || h < 220) size = "tiny";
            else if (w < 560 || h < 400) size = "compact";
        }
        this.host.setAttribute("data-size", size);
        // The gear floats over the deck's top-right corner whenever the visual
        // shows it (it stands down below 220×160 — `syncOverlay`). On a tile the
        // title runs up into that corner, so keep it clear there.
        if (w >= 220 && h >= 160) this.host.setAttribute("data-gear", "");
        else this.host.removeAttribute("data-gear");
    }

    hide(): void {
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];
        if (this.host) {
            this.host.remove();
            this.host = undefined;
        }
    }

    private applyTheme(): void {
        if (!this.host) return;
        const dark = isDark(this.surface.bg);
        this.host.setAttribute("data-theme", dark ? "dark" : "light");
        this.host.style.setProperty("--lp-fg", this.surface.fg);
        this.host.style.setProperty("--lp-muted", this.surface.muted);
        this.host.style.setProperty("--lp-canvas", this.surface.bg);
    }

    private go(delta: number): void {
        const next = this.page + delta;
        if (next < 0 || next >= PAGES.length) return;
        this.page = next;
        this.render();
    }

    private render(): void {
        if (!this.host) return;
        const host = this.host;
        while (host.firstChild) host.removeChild(host.firstChild);
        const page = PAGES[this.page];
        const context: SceneContext = { dark: isDark(this.surface.bg), surface: this.surface };

        const shell = el("div", "zx-lp-card");
        const art = el("div", "zx-lp-art");
        const artInner = el("div", "zx-lp-art-inner");
        let scene: SVGSVGElement;
        // A scene that throws must never blank the visual — fall back to the welcome art.
        try { scene = page.scene(context); } catch { scene = sceneWelcome(context); }
        artInner.appendChild(scene);
        art.appendChild(artInner);
        shell.appendChild(art);

        const content = el("div", "zx-lp-content");
        const brand = el("div", "zx-lp-brand");
        brand.appendChild(zentrixMark(context.dark));
        // The website's lockup: "Zentrix" in ink, "Studio" italic in the warm accent.
        const name = el("span", "zx-lp-brandname");
        name.appendChild(textEl("span", "zx-lp-brandword", "Zentrix"));
        name.appendChild(textEl("span", "zx-lp-brandword-studio", "Studio"));
        brand.appendChild(name);
        content.appendChild(brand);
        content.appendChild(textEl("div", "zx-lp-eyebrow", page.eyebrow));
        content.appendChild(textEl("h2", "zx-lp-title", page.title));

        const body = el("div", "zx-lp-body");
        page.lines.forEach((line) => {
            if (line.startsWith("• ")) {
                const row = el("div", "zx-lp-bullet");
                row.appendChild(textEl("span", "zx-lp-tick", "✓"));
                row.appendChild(textEl("span", "zx-lp-bulltext", line.slice(2)));
                body.appendChild(row);
            } else {
                body.appendChild(textEl("p", "zx-lp-line", line));
            }
        });
        content.appendChild(body);

        if (this.page === 0) {
            const actions = el("div", "zx-lp-cta-row");
            const support = actionButton(
                "zx-lp-cta zx-lp-cta-primary", "Contact us", "support@zentrixstudio.in",
                () => this.actions.onSupport?.(),
            );
            support.setAttribute("data-action", "support");
            support.setAttribute("aria-label", "Contact Zentrix support at support@zentrixstudio.in");
            actions.appendChild(support);
            const linkedIn = actionButton(
                "zx-lp-cta", "Follow us", "LinkedIn",
                () => this.actions.onLinkedIn?.(),
            );
            linkedIn.setAttribute("data-action", "linkedin");
            linkedIn.setAttribute("aria-label", "Follow Zentrix Studio on LinkedIn; opens a new tab");
            actions.appendChild(linkedIn);
            content.appendChild(actions);
        }

        const footer = el("div", "zx-lp-footer");
        const previous = button("zx-lp-nav", "‹ Back", () => this.go(-1));
        previous.disabled = this.page === 0;
        footer.appendChild(previous);

        const dots = el("div", "zx-lp-dots");
        PAGES.forEach((_, index) => {
            const dot = el("button", "zx-lp-pip" + (index === this.page ? " is-on" : ""));
            dot.setAttribute("aria-label", `Page ${index + 1} of ${PAGES.length}`);
            dot.addEventListener("click", () => { this.page = index; this.render(); });
            dots.appendChild(dot);
        });
        footer.appendChild(dots);

        const last = this.page === PAGES.length - 1;
        const next = button(
            "zx-lp-nav zx-lp-next",
            last ? "Add fields to begin" : "Next ›",
            () => { if (!last) this.go(1); },
        );
        next.disabled = last;
        footer.appendChild(next);
        content.appendChild(footer);

        shell.appendChild(content);
        host.appendChild(shell);
    }

    private injectStyle(): void {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = LANDING_CSS;
        (document.head || document.documentElement).appendChild(style);
    }
}

function isDark(color: string): boolean {
    const match = /^#([0-9a-f]{6})$/i.exec(color);
    if (!match) return false;
    const value = match[1];
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

function el(tag: string, className: string): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    return element;
}

function textEl(tag: string, className: string, text: string): HTMLElement {
    const element = el(tag, className);
    element.textContent = text;
    return element;
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
    const element = document.createElement("button");
    element.className = className;
    element.type = "button";
    element.textContent = text;
    element.addEventListener("click", onClick);
    return element;
}

function actionButton(
    className: string, label: string, detail: string, onClick: () => void,
): HTMLButtonElement {
    const element = document.createElement("button");
    element.className = className;
    element.type = "button";
    element.appendChild(textEl("span", "zx-lp-cta-label", label));
    element.appendChild(textEl("span", "zx-lp-cta-detail", detail));
    element.addEventListener("click", onClick);
    return element;
}

const LANDING_CSS = `
.zx-lp{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  padding:18px;box-sizing:border-box;overflow:auto;z-index:5;
  font-family:"Segoe UI",system-ui,-apple-system,sans-serif;
  --lp-fg:#15161E;--lp-muted:#54566B;--lp-sub:#8A8C9E;--lp-accent:#7C5CFF;
  --lp-soft:rgba(124,92,255,.12);--lp-border:rgba(20,23,50,.09);--lp-card:#FFFFFF;
  --lp-warm:#C4572A;
  --lp-art-a:#F3EFFE;--lp-art-b:#E3EAFD;--lp-canvas:#FFFFFF;
  background:radial-gradient(120% 120% at 100% 0%,rgba(124,92,255,.10),transparent 55%),
             radial-gradient(120% 120% at 0% 100%,rgba(77,163,255,.08),transparent 55%),var(--lp-canvas);}
.zx-lp[data-theme="dark"]{--lp-sub:#70707F;--lp-soft:rgba(124,92,255,.20);--lp-warm:#E08B5A;
  --lp-border:rgba(255,255,255,.10);--lp-card:#15151F;--lp-art-a:#1B1633;--lp-art-b:#101827;
  background:radial-gradient(120% 120% at 100% 0%,rgba(124,92,255,.16),transparent 55%),
             radial-gradient(120% 120% at 0% 100%,rgba(77,163,255,.10),transparent 55%),var(--lp-canvas);}
.zx-lp-card{width:min(960px,100%);height:min(520px,100%);min-height:0;display:flex;
  background:var(--lp-card);border:1px solid var(--lp-border);border-radius:20px;overflow:hidden;
  box-shadow:0 24px 60px -24px rgba(16,24,64,.34);box-sizing:border-box;}
.zx-lp-art{flex:1 1 46%;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;
  padding:26px 24px;box-sizing:border-box;overflow:hidden;
  background:linear-gradient(150deg,var(--lp-art-a),var(--lp-art-b));}
.zx-lp-art-inner{flex:1;min-width:0;min-height:0;align-self:stretch;display:flex;
  align-items:center;justify-content:center;}
.zx-lp-art-inner svg{width:100%!important;height:100%!important;
  filter:drop-shadow(0 10px 22px rgba(80,50,180,.16));}
.zx-lp-content{flex:1 1 54%;min-width:0;min-height:0;display:flex;flex-direction:column;
  padding:26px 30px 18px;box-sizing:border-box;overflow:hidden;}
@media (max-width:560px){.zx-lp-art{display:none}.zx-lp-content{flex:1 1 100%}}
.zx-lp[data-size="compact"],.zx-lp[data-size="tiny"]{padding:8px;}
.zx-lp[data-size="compact"] .zx-lp-art,.zx-lp[data-size="tiny"] .zx-lp-art{display:none;}
.zx-lp[data-size="compact"] .zx-lp-content,.zx-lp[data-size="tiny"] .zx-lp-content{flex:1 1 100%;}
.zx-lp[data-size="compact"] .zx-lp-card{border-radius:14px;}
.zx-lp[data-size="compact"] .zx-lp-content{padding:14px 16px 10px;}
.zx-lp[data-size="compact"] .zx-lp-brand{margin-bottom:8px;}
.zx-lp[data-size="compact"] .zx-lp-eyebrow{font-size:10px;margin-bottom:4px;}
.zx-lp[data-size="compact"] .zx-lp-title{font-size:17px;margin-bottom:8px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;flex:none;}
.zx-lp[data-size="compact"] .zx-lp-body{min-height:18px;}
.zx-lp[data-size="compact"] .zx-lp-line{font-size:12.5px;line-height:1.45;margin-bottom:6px;}
.zx-lp[data-size="compact"] .zx-lp-bulltext{font-size:12px;}
.zx-lp[data-size="compact"] .zx-lp-bullet{margin-bottom:6px;}
.zx-lp[data-size="compact"] .zx-lp-cta-row{display:none;}
.zx-lp[data-size="compact"] .zx-lp-footer{margin-top:8px;padding-top:8px;}
.zx-lp[data-size="compact"] .zx-lp-nav{padding:5px 10px;font-size:11.5px;}
.zx-lp[data-size="tiny"] .zx-lp-card{border-radius:10px;box-shadow:none;}
.zx-lp[data-size="tiny"] .zx-lp-content{padding:8px 10px 6px;}
.zx-lp[data-size="tiny"] .zx-lp-brand{margin-bottom:4px;}
.zx-lp[data-size="tiny"] .zx-lp-brandname,.zx-lp[data-size="tiny"] .zx-lp-eyebrow,
.zx-lp[data-size="tiny"] .zx-lp-body,.zx-lp[data-size="tiny"] .zx-lp-cta-row,
.zx-lp[data-size="tiny"] .zx-lp-dots,.zx-lp[data-size="tiny"] .zx-lp-nav:disabled{display:none;}
.zx-lp[data-size="tiny"] .zx-zentrix-mark{width:16px;height:16px;}
.zx-lp[data-size="tiny"] .zx-lp-title{font-size:13px;line-height:1.25;margin:0;letter-spacing:0;flex:1 1 auto;min-height:0;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
.zx-lp[data-size="tiny"][data-gear] .zx-lp-title{padding-right:34px;}
.zx-lp[data-size="tiny"] .zx-lp-footer{margin-top:4px;padding-top:4px;justify-content:flex-end;}
.zx-lp[data-size="tiny"] .zx-lp-nav{padding:3px 8px;font-size:10.5px;border-radius:7px;}
.zx-lp-brand{display:flex;align-items:center;gap:8px;margin-bottom:16px;}
.zx-zentrix-mark{flex:none;width:22px;height:22px;display:block;user-select:none;}
.zx-lp-brandname{display:flex;align-items:baseline;gap:4px;font-size:15px;line-height:1;}
.zx-lp-brandword{font-weight:700;letter-spacing:-.1px;color:var(--lp-fg);}
.zx-lp-brandword-studio{font-weight:600;font-style:italic;color:var(--lp-warm);}
.zx-lp-eyebrow{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;
  color:var(--lp-accent);margin-bottom:7px;}
.zx-lp-title{font-size:25px;font-weight:800;color:var(--lp-fg);margin:0 0 16px;line-height:1.18;
  letter-spacing:-.3px;}
.zx-lp-body{flex:1;min-height:0;overflow-y:auto;}
.zx-lp-line{font-size:14px;line-height:1.55;color:var(--lp-muted);margin:0 0 10px;}
.zx-lp-bullet{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px;}
.zx-lp-tick{flex:none;width:18px;height:18px;border-radius:50%;background:var(--lp-soft);
  color:var(--lp-accent);font-size:11px;font-weight:800;display:grid;place-items:center;margin-top:1px;}
.zx-lp-bulltext{font-size:13.5px;line-height:1.5;color:var(--lp-muted);}
.zx-lp-cta-row{display:flex;gap:9px;align-items:stretch;margin-top:5px;}
.zx-lp-cta{appearance:none;flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;
  gap:2px;padding:9px 11px;border:1px solid var(--lp-border);border-radius:10px;background:transparent;
  color:var(--lp-fg);font-family:inherit;cursor:pointer;text-align:left;transition:.15s;}
.zx-lp-cta:hover,.zx-lp-cta:focus-visible{border-color:var(--lp-accent);background:var(--lp-soft);outline:none;}
.zx-lp-cta-primary{background:var(--lp-accent);border-color:var(--lp-accent);color:#FFF;
  box-shadow:0 6px 16px -7px rgba(124,92,255,.7);}
.zx-lp-cta-primary:hover,.zx-lp-cta-primary:focus-visible{background:var(--lp-accent);filter:brightness(1.06);}
.zx-lp-cta-label{font-size:12px;font-weight:750;line-height:1.2;}
.zx-lp-cta-detail{max-width:100%;font-size:9.5px;font-weight:550;line-height:1.25;opacity:.74;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.zx-lp-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;
  margin-top:18px;padding-top:16px;border-top:1px solid var(--lp-border);}
.zx-lp-nav{appearance:none;border:1px solid var(--lp-border);background:transparent;
  color:var(--lp-muted);font:600 12.5px inherit;padding:8px 14px;border-radius:10px;
  cursor:pointer;transition:.15s;white-space:nowrap;}
.zx-lp-nav:hover:not(:disabled),.zx-lp-nav:focus-visible{color:var(--lp-fg);border-color:var(--lp-accent);outline:none;}
.zx-lp-nav:disabled{opacity:0;pointer-events:none;}
.zx-lp-next{background:var(--lp-accent);border-color:var(--lp-accent);color:#FFF;
  box-shadow:0 6px 16px -6px rgba(124,92,255,.7);}
.zx-lp-next:hover:not(:disabled){filter:brightness(1.07);color:#FFF;}
.zx-lp-next:disabled{opacity:.6;background:var(--lp-soft);border-color:transparent;
  color:var(--lp-accent);box-shadow:none;}
.zx-lp-dots{display:flex;gap:7px;align-items:center;}
.zx-lp-pip{width:7px;height:7px;border-radius:50%;border:0;padding:0;cursor:pointer;
  background:var(--lp-border);transition:.2s;}
.zx-lp-pip:focus-visible{outline:2px solid var(--lp-accent);outline-offset:3px;}
.zx-lp-pip.is-on{background:var(--lp-accent);width:22px;border-radius:4px;}
@media (prefers-reduced-motion:no-preference){
  .zx-lp-card{animation:zxLpCard .4s cubic-bezier(.2,.7,.3,1);}
  @keyframes zxLpCard{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
}
`;
