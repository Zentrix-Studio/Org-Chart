"use strict";

/**
 * Org-chart schema + cfg adapter for the shared Zentrix Settings Bar.
 *
 * The bar engine (`zentrixSettingsBar.ts`) is the GOLDEN SOURCE and is identical
 * across every Zentrix visual. THIS file is the only per-visual code: it declares
 * the category / sub / field tree (`SB_CATS`) in engine keys, and maps each key
 * onto the real formatting model + `persistProperties` (`KEYS` → `makeCfg`).
 * Same pattern as the Network Graph, Sankey and Heatmap.
 *
 * Category ORDER and NAMES follow `visuals/SETTINGS-TAXONOMY.md`: the shared
 * slots are named identically across the family, and the domain slots here are
 * 4 → Connectors and 9 → Org analysis.
 */

import type powerbi from "powerbi-visuals-api";
import { VisualFormattingSettingsModel } from "../settings";
import type { SBCategory, SBCfg, SBFont, SBOption, SBPalette } from "./zentrixSettingsBar";
import { COLOR_PICKER_PRESETS } from "./colorPickerPresets";
import { categoryPalette, accent, accentStrong, fontFamily } from "../theme/zentrixTokens";

type Model = VisualFormattingSettingsModel;
type PersistFn = (object: string, prop: string, value: powerbi.DataViewPropertyValue) => void;

/** One property write inside a single logical edit. */
export type PersistWrite = { object: string; prop: string; value: powerbi.DataViewPropertyValue };
/**
 * Flush every write from one `cfg.set` as ONE `persistProperties` call. Several
 * synchronous calls are coalesced by the host (last write wins), which silently
 * drops the earlier property of any two-property edit.
 */
export type PersistBatch = (writes: PersistWrite[]) => void;

/* ───────────── shared design data ───────────── */

/** The visual has no font picker yet; the bar still wants a non-empty list. */
export const SB_FONTS: SBFont[] = [
    { id: fontFamily, label: "Inter (Zentrix)", css: fontFamily },
];

export const SB_PALETTES: Record<string, SBPalette> = {
    zentrix: { name: "Zentrix", light: categoryPalette },
};

export const SB_PRESETS = COLOR_PICKER_PRESETS;
export const SB_EMOJI = ["⭐", "⚠️", "🚀", "🎯", "✅", "❗", "📈", "🏆", "🔺", "🔻", "💠", "🕓"];

/* ───────────── engine key → model binding ───────────── */

interface Entry {
    get(m: Model): unknown;
    set(persist: PersistFn, value: unknown): void;
    setLocal(m: Model, value: unknown): void;
}

/* Slice classes differ per control, so these accessors stay loosely typed: a
 * dropdown's value is an item object, a toggle's a boolean, a picker's a colour. */
/* Slice classes differ per control — a toggle's `value` is a boolean, a
 * dropdown's is an item object, a picker's is `{ value: "#hex" }` — so the
 * accessors below stay loosely typed and each one narrows what it reads. This
 * mirrors the same declaration in every other visual's schema. */
type AnySlice = { value: any; items?: any[] };

function pickItem(slice: AnySlice, value: unknown): unknown {
    return slice.items?.find((it) => String(it.value) === String(value)) ?? slice.value;
}
function dropdown(object: string, prop: string, acc: (m: Model) => AnySlice): Entry {
    return {
        get: (m) => acc(m).value?.value,
        set: (p, v) => p(object, prop, String(v)),
        setLocal: (m, v) => { acc(m).value = pickItem(acc(m), v); },
    };
}
function bool(object: string, prop: string, acc: (m: Model) => AnySlice): Entry {
    return {
        get: (m) => acc(m).value,
        set: (p, v) => p(object, prop, Boolean(v)),
        setLocal: (m, v) => { acc(m).value = Boolean(v); },
    };
}
function num(object: string, prop: string, acc: (m: Model) => AnySlice): Entry {
    return {
        get: (m) => acc(m).value,
        set: (p, v) => p(object, prop, Number(v)),
        setLocal: (m, v) => { acc(m).value = Number(v); },
    };
}
function color(object: string, prop: string, acc: (m: Model) => AnySlice): Entry {
    return {
        get: (m) => acc(m).value.value,
        set: (p, v) => p(object, prop,
            { solid: { color: String(v) } } as unknown as powerbi.DataViewPropertyValue),
        setLocal: (m, v) => { acc(m).value = { value: String(v) }; },
    };
}

/**
 * Every control the gear can reach, keyed as `object.property`.
 *
 * Keys here are the SAME strings the format pane persists — they are the
 * persistence contract, and renaming one silently orphans every report that
 * already set it. Add, never rename.
 */
const KEYS: Record<string, Entry> = {
    // Layout
    "layout.orientation": dropdown("layout", "orientation", (m) => m.layout.orientation),
    "layout.levelGap": num("layout", "levelGap", (m) => m.layout.levelGap),
    "layout.siblingGap": num("layout", "siblingGap", (m) => m.layout.siblingGap),
    "layout.fillViewport": bool("layout", "fillViewport", (m) => m.layout.fillViewport),
    "layout.collapseToFit": bool("layout", "collapseToFit", (m) => m.layout.collapseToFit),

    // Nodes
    "nodes.sizeMode": dropdown("nodes", "sizeMode", (m) => m.nodes.sizeMode),
    "nodes.cardWidth": num("nodes", "cardWidth", (m) => m.nodes.cardWidth),
    "nodes.cardHeight": num("nodes", "cardHeight", (m) => m.nodes.cardHeight),
    "nodes.cornerRadius": num("nodes", "cornerRadius", (m) => m.nodes.cornerRadius),
    "nodes.showPhoto": bool("nodes", "showPhoto", (m) => m.nodes.showPhoto),
    "nodes.photoShape": dropdown("nodes", "photoShape", (m) => m.nodes.photoShape),
    "nodes.photoSize": num("nodes", "photoSize", (m) => m.nodes.photoSize),
    "nodes.photoRing": bool("nodes", "photoRing", (m) => m.nodes.photoRing),
    "nodes.photoRingColor": color("nodes", "photoRingColor", (m) => m.nodes.photoRingColor),
    "nodes.photoRingWidth": num("nodes", "photoRingWidth", (m) => m.nodes.photoRingWidth),
    "nodes.photoFallback": dropdown("nodes", "photoFallback", (m) => m.nodes.photoFallback),
    "nodes.showMeasure": bool("nodes", "showMeasure", (m) => m.nodes.showMeasure),

    // Colours
    "colors.colorMode": dropdown("colors", "colorMode", (m) => m.colors.colorMode),
    "colors.cardFill": color("colors", "cardFill", (m) => m.colors.cardFill),
    "colors.accentBar": bool("colors", "accentBar", (m) => m.colors.accentBar),
    "colors.useReportTheme": bool("colors", "useReportTheme", (m) => m.colors.useReportTheme),

    // Connectors
    "connectors.style": dropdown("connectors", "style", (m) => m.connectors.style),
    "connectors.width": num("connectors", "width", (m) => m.connectors.width),
    "connectors.color": color("connectors", "color", (m) => m.connectors.color),

    // Labels
    "labels.nameSize": num("labels", "nameSize", (m) => m.labels.nameSize),
    "labels.titleSize": num("labels", "titleSize", (m) => m.labels.titleSize),
    "labels.showTitle": bool("labels", "showTitle", (m) => m.labels.showTitle),

    // Overlays
    "overlays.tooltipStyle": dropdown("overlays", "tooltipStyle", (m) => m.overlays.tooltipStyle),
    "overlays.showLegend": bool("overlays", "showLegend", (m) => m.overlays.showLegend),
    "overlays.showSearch": bool("overlays", "showSearch", (m) => m.overlays.showSearch),
    // View switch (OC-029) — the family's object names, unchanged.
    "summaryTable.show": bool("summaryTable", "show", (m) => m.summaryTable.show),
    "summaryTable.position": dropdown("summaryTable", "position", (m) => m.summaryTable.position),
    "insights.show": bool("insights", "show", (m) => m.insights.show),

    // Org analysis — free since 2026-09-11 (OC-016). `orgAnalytics` stays in
    // FEATURE_TIER as a mechanism, but it is marked free and gates nothing.
    "orgAnalysis.showMetrics": bool("orgAnalysis", "showMetrics", (m) => m.orgAnalysis.showMetrics),
    "orgAnalysis.spanWide": num("orgAnalysis", "spanWide", (m) => m.orgAnalysis.spanWide),
    "orgAnalysis.spanNarrow": num("orgAnalysis", "spanNarrow", (m) => m.orgAnalysis.spanNarrow),
    "orgAnalysis.flagVacancies": bool("orgAnalysis", "flagVacancies", (m) => m.orgAnalysis.flagVacancies),
    "orgAnalysis.showSummary": bool("orgAnalysis", "showSummary", (m) => m.orgAnalysis.showSummary),
    "orgAnalysis.compareperiods": bool("orgAnalysis", "compareperiods", (m) => m.orgAnalysis.compareperiods),
    "rules.enabled": bool("rules", "enabled", (m) => m.rules.enabled),

    // Toolbar + branding
    "toolbar.show": bool("toolbar", "show", (m) => m.toolbar.show),
    "toolbar.position": dropdown("toolbar", "position", (m) => m.toolbar.position),
    "toolbar.closeOnClickAway": bool("toolbar", "closeOnClickAway", (m) => m.toolbar.closeOnClickAway),
    "branding.showBranding": bool("branding", "showBranding", (m) => m.branding.showBranding),
};

/** Apply an engine-key value onto a model in place (replays a pending edit). */
export function applyLocal(m: Model, key: string, value: unknown): void { KEYS[key]?.setLocal(m, value); }

/** Read the current engine-key value from a model (detects host confirmation). */
export function readLocal(m: Model, key: string): unknown { return KEYS[key]?.get(m); }

/** Every engine key the gear can reach — drives the parity test. */
export function settingKeys(): string[] { return Object.keys(KEYS); }

/**
 * Every capabilities object the gear can write, derived by replaying each entry's
 * persist call against a recorder. A card in the model that is neither in the
 * format pane nor reachable here is an orphan: it persists and renders, but no
 * user can ever change it.
 */
export function gearObjectNames(): Set<string> {
    const m = new VisualFormattingSettingsModel();
    const out = new Set<string>();
    const rec: PersistFn = (object) => { out.add(object); };
    for (const k of Object.keys(KEYS)) {
        const e = KEYS[k];
        try { e.set(rec, e.get(m)); } catch { /* recording only — a throw just skips the key */ }
    }
    return out;
}

/**
 * Build the `SBCfg` adapter around a live model getter and a persist callback.
 * Every edit is applied to the model optimistically so the canvas repaints at
 * once rather than after the host round-trip.
 */
export function makeCfg(
    getModel: () => Model,
    persist: PersistBatch,
    onChange?: (key: string, value: unknown) => void,
    reset?: () => void,
): SBCfg {
    return {
        get(key: string): unknown {
            const e = KEYS[key];
            return e ? e.get(getModel()) : undefined;
        },
        set(key: string, value: unknown): void {
            const e = KEYS[key];
            if (!e) return;
            e.setLocal(getModel(), value);        // optimistic
            const writes: PersistWrite[] = [];
            e.set((object, prop, v) => writes.push({ object, prop, value: v }), value);
            if (writes.length) persist(writes);   // durable
            onChange?.(key, value);
        },
        reset,
    };
}

/* ───────────── the category / sub / field schema ───────────── */

const opt = (value: string, label: string): SBOption => [value, label];

export const SB_CATS: SBCategory[] = [
    // 1 — Layout. The shape of the tree itself.
    {
        id: "layout", name: "Layout", subs: [
            {
                id: "shape", name: "Shape", kind: "fields",
                info: "Which way the tree runs, and how much room each level and each sibling gets.",
                fields: [
                    {
                        control: "segText", label: "Orientation", key: "layout.orientation",
                        options: [opt("topDown", "Top-down"), opt("leftRight", "Left → right")],
                        note: "Left-to-right stays readable past about four levels, where top-down needs a mile of width.",
                    },
                    { control: "divider" },
                    {
                        control: "stepper", label: "Level spacing", key: "layout.levelGap",
                        min: 8, max: 240, step: 4, suffix: "px",
                        noteFn: (g) => (g("layout.fillViewport")
                            ? "A MINIMUM while Fill the viewport is on — set it higher than the automatic spacing and your number wins."
                            : undefined),
                    },
                    {
                        control: "stepper", label: "Sibling spacing", key: "layout.siblingGap",
                        min: 4, max: 200, step: 2, suffix: "px",
                    },
                ],
            },
            {
                id: "fit", name: "Fit", kind: "fields", width: 268,
                info: "How the chart uses the space Power BI gives it.",
                fields: [
                    {
                        control: "switch", label: "Fill the viewport", key: "layout.fillViewport",
                        note: "Stretch the spacing between levels so the chart uses the whole visual instead of sitting as a thin band in the middle.",
                    },
                    { control: "divider" },
                    {
                        control: "switch", label: "Collapse deep levels to fit", key: "layout.collapseToFit",
                        note: "Open a large hierarchy at the top, with the deeper levels folded behind a + . Runs once per report; turning it off never expands what is already collapsed.",
                    },
                ],
            },
        ],
    },

    // 2 — Nodes. The card.
    {
        id: "nodes", name: "Nodes", subs: [
            {
                id: "card", name: "Card", kind: "fields", width: 268,
                info: "The size and shape of one person's card.",
                fields: [
                    {
                        control: "segText", label: "Card sizing", key: "nodes.sizeMode",
                        options: [opt("level", "By level"), opt("auto", "Auto"), opt("fixed", "Fixed")],
                        note: "By level grows cards towards the root — the leaves keep the size below, their managers are larger, the root larger still. Auto keeps one size for all but draws above 1:1 when there is room. Fixed is exactly the size below.",
                    },
                    { control: "divider" },
                    { control: "stepper", label: "Width", key: "nodes.cardWidth", min: 80, max: 420, step: 4, suffix: "px" },
                    { control: "stepper", label: "Height", key: "nodes.cardHeight", min: 32, max: 200, step: 2, suffix: "px" },
                    { control: "stepper", label: "Corner radius", key: "nodes.cornerRadius", min: 0, max: 32, step: 1, suffix: "px" },
                ],
            },
            {
                id: "content", name: "Content", kind: "fields",
                info: "What each card shows besides the name.",
                fields: [
                    {
                        control: "switch", label: "Photo", key: "nodes.showPhoto",
                        note: "Needs the Photo field. Images must be base64 data URIs — a certified visual never fetches one.",
                    },
                    // Everything below steers the avatar, so all of it hides with the
                    // switch above. A control that cannot change what you are looking
                    // at is the defect this product is positioned against.
                    {
                        control: "segText", label: "Shape", key: "nodes.photoShape",
                        options: [opt("circle", "Circle"), opt("rounded", "Rounded"), opt("square", "Square")],
                        visibleIf: (g) => g("nodes.showPhoto") === true,
                    },
                    {
                        control: "stepper", label: "Size", key: "nodes.photoSize",
                        min: 20, max: 90, step: 2, suffix: "%",
                        note: "Diameter as a percentage of the card height.",
                        visibleIf: (g) => g("nodes.showPhoto") === true,
                    },
                    {
                        control: "switch", label: "Outline", key: "nodes.photoRing",
                        visibleIf: (g) => g("nodes.showPhoto") === true,
                    },
                    {
                        control: "color", label: "Outline colour", key: "nodes.photoRingColor",
                        note: "Blank follows the card's own accent colour.",
                        visibleIf: (g) => g("nodes.showPhoto") === true && g("nodes.photoRing") === true,
                    },
                    {
                        control: "stepper", label: "Outline width", key: "nodes.photoRingWidth",
                        min: 0, max: 6, step: 0.2, suffix: "px",
                        visibleIf: (g) => g("nodes.showPhoto") === true && g("nodes.photoRing") === true,
                    },
                    {
                        control: "segText", label: "No photo", key: "nodes.photoFallback",
                        options: [opt("initials", "Initials"), opt("icon", "Icon"),
                            opt("blank", "Empty"), opt("none", "Hide")],
                        note: "What a row with an empty Photo gets. Hiding it closes up the space, so a part-filled dataset draws cards whose text starts in two different places.",
                        visibleIf: (g) => g("nodes.showPhoto") === true,
                    },
                    { control: "divider" },
                    {
                        control: "switch", label: "Measure badge", key: "nodes.showMeasure",
                        note: "Needs the Measure field.",
                    },
                ],
            },
        ],
    },

    // 3 — Colours.
    {
        id: "colors", name: "Colours", subs: [
            {
                id: "scheme", name: "Scheme", kind: "fields", width: 268,
                info: "What decides a card's colour.",
                fields: [
                    {
                        control: "segText", label: "Colour by", key: "colors.colorMode",
                        options: [opt("single", "One"), opt("group", "Group"), opt("level", "Level")],
                        noteFn: (g) => {
                            const mode = String(g("colors.colorMode"));
                            if (mode === "group") {
                                return "One colour per value of the Group field, from the palette below. "
                                    + "Anyone with no group falls back to the accent colour.";
                            }
                            if (mode === "level") return "One colour per level of the hierarchy.";
                            return "Every card in one colour.";
                        },
                    },
                    { control: "divider" },
                    {
                        control: "color", label: "Accent colour", key: "colors.cardFill",
                        // Hidden where it would do nothing. In Group and Level mode the
                        // colour comes from the palette, and a picker that changes
                        // nothing is the Akvelon defect this product exists to be
                        // better than.
                        visibleIf: (g) => String(g("colors.colorMode")) === "single",
                    },
                    { control: "switch", label: "Accent bar", key: "colors.accentBar" },
                    {
                        control: "switch", label: "Use report theme", key: "colors.useReportTheme",
                        note: "Take group colours from the report's theme rather than the Zentrix palette.",
                    },
                ],
            },
        ],
    },

    // 4 — Connectors (the domain slot).
    {
        id: "connectors", name: "Connectors", flat: true, subs: [
            {
                id: "connectors", kind: "fields",
                fields: [
                    {
                        control: "segText", label: "Line style", key: "connectors.style",
                        options: [opt("elbow", "Elbow"), opt("straight", "Straight"), opt("curved", "Curved")],
                    },
                    { control: "stepper", label: "Thickness", key: "connectors.width", min: 0.5, max: 8, step: 0.5, suffix: "px" },
                    { control: "color", label: "Colour", key: "connectors.color" },
                ],
            },
        ],
    },

    // 5 — Labels.
    {
        id: "labels", name: "Labels", flat: true, subs: [
            {
                id: "labels", kind: "fields",
                fields: [
                    { control: "stepper", label: "Name size", key: "labels.nameSize", min: 7, max: 28, step: 0.5, suffix: "px" },
                    { control: "switch", label: "Show title", key: "labels.showTitle" },
                    {
                        control: "stepper", label: "Title size", key: "labels.titleSize",
                        min: 6, max: 24, step: 0.5, suffix: "px",
                        visibleIf: (g) => Boolean(g("labels.showTitle")),
                    },
                ],
            },
        ],
    },

    // 6 — Overlays.
    {
        id: "overlays", name: "Overlays", subs: [
            {
                id: "tooltip", name: "Tooltip", kind: "menu", key: "overlays.tooltipStyle",
                info: "The hover card: the Zentrix card, Power BI's own tooltip, or none.",
                options: [opt("card", "Zentrix card"), opt("native", "Power BI"), opt("off", "Off")],
            },
            // Taxonomy order: Tooltip · View switch · Legend · Gear icon.
            {
                id: "views", name: "View switch", kind: "fields", width: 268,
                info: "The Chart / Table / Insight switch. Anyone reading the report can flip the canvas with it.",
                fields: [
                    {
                        control: "switch", label: "Summary table", key: "summaryTable.show",
                        note: "Everyone in the hierarchy as a sortable, searchable table, with CSV export.",
                    },
                    {
                        control: "switch", label: "Insights", key: "insights.show",
                        note: "A plain-English read-out: span of control, depth, the largest branches and anything wrong in the data.",
                    },
                    {
                        control: "select", label: "Position", key: "summaryTable.position",
                        options: [opt("auto", "Auto (top right)"), opt("tl", "Top left"),
                            opt("tr", "Top right"), opt("bl", "Bottom left"), opt("br", "Bottom right")],
                        dimIf: (g) => !g("summaryTable.show") && !g("insights.show"),
                        disabledReason: "Turn on Summary table or Insights to show the view switch.",
                    },
                ],
            },
            {
                id: "chrome", name: "On canvas", kind: "fields",
                info: "What the visual draws on top of the chart.",
                fields: [
                    { control: "switch", label: "Legend", key: "overlays.showLegend" },
                    { control: "switch", label: "Search box", key: "overlays.showSearch" },
                ],
            },
            {
                id: "toolbar", name: "Gear", kind: "fields", width: 260,
                info: "This settings button itself.",
                fields: [
                    { control: "switch", label: "Show gear", key: "toolbar.show" },
                    {
                        control: "select", label: "Position", key: "toolbar.position",
                        options: [opt("auto", "Auto (top right)"), opt("bl", "Bottom left"),
                            opt("tl", "Top left"), opt("tr", "Top right"), opt("br", "Bottom right")],
                    },
                    { control: "switch", label: "Close on click-away", key: "toolbar.closeOnClickAway" },
                    { control: "divider" },
                    {
                        control: "switch", label: "Zentrix branding", key: "branding.showBranding",
                        note: "A small Zentrix wordmark on the tooltip card.",
                    },
                ],
            },
        ],
    },

    // 9 — Org analysis (the domain slot). Free since OC-016.
    {
        id: "orgAnalysis", name: "Org analysis", subs: [
            {
                id: "span", name: "Span", kind: "fields", width: 268,
                info: "Span-of-control numbers on each card, and the thresholds that count as wide or narrow.",
                fields: [
                    { control: "switch", label: "Span metrics", key: "orgAnalysis.showMetrics" },
                    {
                        control: "stepper", label: "Wide above", key: "orgAnalysis.spanWide",
                        min: 1, max: 200, step: 1,
                        visibleIf: (g) => Boolean(g("orgAnalysis.showMetrics")),
                    },
                    {
                        control: "stepper", label: "Narrow below", key: "orgAnalysis.spanNarrow",
                        min: 1, max: 50, step: 1,
                        visibleIf: (g) => Boolean(g("orgAnalysis.showMetrics")),
                    },
                    { control: "divider" },
                    {
                        control: "switch", label: "Flag vacancies", key: "orgAnalysis.flagVacancies",
                        note: "Marks cards whose name reads as an open role — \"vacant\", \"TBH\", \"open\".",
                    },
                ],
            },
            {
                id: "summary", name: "Summary", kind: "fields", width: 268,
                info: "Roll-ups across the whole hierarchy, and the period comparison.",
                fields: [
                    { control: "switch", label: "Summary strip", key: "orgAnalysis.showSummary" },
                    {
                        control: "switch", label: "Compare periods", key: "orgAnalysis.compareperiods",
                        note: "Needs the Period field. Marks joiners, leavers and movers between the two most recent periods.",
                    },
                    { control: "divider" },
                    {
                        control: "switch", label: "Conditional formatting", key: "rules.enabled",
                        note: "Colour cards by rule. The rule editor arrives with the overlay chrome.",
                    },
                ],
            },
        ],
    },
];
