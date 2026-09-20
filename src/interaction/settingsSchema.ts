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
import type { SBCategory, SBCfg, SBField, SBFont, SBOption, SBPalette } from "./zentrixSettingsBar";
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
/**
 * A colour as the hex string Power BI's `fill` expects, whatever shape it came in:
 * a string, a picker value `{ value }`, or a fill `{ solid: { color } }`.
 * zentrix-org-chart#14 (OC-QA-27) found `connectors.color.solid.color =
 * '[object Object]'` in a saved report; `String(object)` is exactly what makes
 * that, so nothing that is not a string colour is ever written from here.
 */
export function hexOf(v: unknown): string | null {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
        const o = v as { value?: unknown; solid?: { color?: unknown } };
        if (typeof o.value === "string") return o.value;
        if (o.solid && typeof o.solid.color === "string") return o.solid.color;
    }
    return null;
}
function color(object: string, prop: string, acc: (m: Model) => AnySlice): Entry {
    return {
        get: (m) => acc(m).value.value,
        set: (p, v) => {
            const hex = hexOf(v);
            if (hex === null) return;
            p(object, prop, { solid: { color: hex } } as unknown as powerbi.DataViewPropertyValue);
        },
        setLocal: (m, v) => { const hex = hexOf(v); if (hex !== null) acc(m).value = { value: hex }; },
    };
}

/**
 * The per-level collapse ladder (OC-035). Level 1 is the roots and is always
 * drawn, so the switches run from 2.
 */
export const FIRST_LEVEL = 2;
export const LAST_LEVEL = 11;
export const LEVEL_KEYS: string[] = [];
for (let n = FIRST_LEVEL; n <= LAST_LEVEL; n++) LEVEL_KEYS.push(`layout.level${n}`);

/** The ladder's state as a string, for comparing one render against the next. */
export function levelLadder(m: Model): string {
    return LEVEL_KEYS.map((k) => (readLocal(m, k) ? "1" : "0")).join("");
}

/**
 * How many levels the ladder says to show: 1 (the roots alone) plus every level
 * switched on before the first one switched off. The switches are kept monotone
 * by `levelBool`, so this is the whole reading of them.
 */
export function levelsShown(ladder: string): number {
    let n = 1;
    for (const c of ladder) {
        if (c !== "1") break;
        n++;
    }
    return n;
}

/**
 * One level switch — and its LADDER, written in the same batch.
 *
 * A level cannot be on screen while the level above it is folded away, so the
 * switches move together: turning level 5 off turns 6…11 off, turning level 5 on
 * turns 2…4 on. Every write goes through the one `p` the caller collects, so the
 * whole ladder lands as a SINGLE `persistProperties` merge — several synchronous
 * calls are coalesced by the host and all but the last are dropped, which is the
 * defect `PersistBatch` exists for.
 */
function levelBool(n: number): Entry {
    const nameOf = (i: number): string => `level${i}`;
    const sliceOf = (m: Model, i: number): AnySlice =>
        (m.layout as unknown as Record<string, AnySlice>)[nameOf(i)];
    return {
        get: (m) => sliceOf(m, n).value,
        set: (p, v) => {
            const on = Boolean(v);
            p("layout", nameOf(n), on);
            if (on) for (let i = FIRST_LEVEL; i < n; i++) p("layout", nameOf(i), true);
            else for (let i = n + 1; i <= LAST_LEVEL; i++) p("layout", nameOf(i), false);
        },
        setLocal: (m, v) => {
            const on = Boolean(v);
            sliceOf(m, n).value = on;
            if (on) for (let i = FIRST_LEVEL; i < n; i++) sliceOf(m, i).value = true;
            else for (let i = n + 1; i <= LAST_LEVEL; i++) sliceOf(m, i).value = false;
        },
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
    "layout.leafStack": dropdown("layout", "leafStack", (m) => m.layout.leafStack),
    "layout.fillViewport": bool("layout", "fillViewport", (m) => m.layout.fillViewport),
    "layout.collapseToFit": bool("layout", "collapseToFit", (m) => m.layout.collapseToFit),
    // The per-level ladder (OC-035). Each one cascades — see `levelBool`.
    "layout.level2": levelBool(2),
    "layout.level3": levelBool(3),
    "layout.level4": levelBool(4),
    "layout.level5": levelBool(5),
    "layout.level6": levelBool(6),
    "layout.level7": levelBool(7),
    "layout.level8": levelBool(8),
    "layout.level9": levelBool(9),
    "layout.level10": levelBool(10),
    "layout.level11": levelBool(11),

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
    "minimap.show": bool("minimap", "show", (m) => m.minimap.show),
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
    // The quick-action bar and the lens (OC-034).
    "toolbar.actions": bool("toolbar", "actions", (m) => m.toolbar.actions),
    "toolbar.actionsPosition": dropdown("toolbar", "actionsPosition", (m) => m.toolbar.actionsPosition),
    "toolbar.lens": bool("toolbar", "lens", (m) => m.toolbar.lens),
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

/**
 * What the BOUND DATA looks like, for the controls whose usefulness depends on
 * it. Today that is only the level ladder: a switch for a level the hierarchy
 * does not have is the dead control this product is positioned against.
 *
 * It is per-instance and mutable rather than a setting, because it describes the
 * data, not the author's choice — the visual refreshes it on every render
 * (`SettingsOverlay.setLevels`). Two Org Charts on one page each get their own.
 */
export interface DataShape {
    /** How many levels deep the bound hierarchy is. */
    levels: number;
}

/** The shape assumed before any data arrives — show the whole ladder. */
export function defaultShape(): DataShape { return { levels: LAST_LEVEL }; }

/** The ten level switches, each shown only when the hierarchy is that deep. */
function levelFields(shape: DataShape): SBField[] {
    const out: SBField[] = [
        {
            control: "note",
            label: "This hierarchy is a single level — there is nothing below the roots to fold away.",
            visibleIf: () => shape.levels < FIRST_LEVEL,
        },
    ];
    for (let n = FIRST_LEVEL; n <= LAST_LEVEL; n++) {
        out.push({
            control: "switch",
            label: `Level ${n}`,
            key: `layout.level${n}`,
            visibleIf: () => shape.levels >= n,
            noteFn: (g) => (g(`layout.level${n}`)
                ? undefined
                : `Level ${n} and everything below it is folded into a count on level ${n - 1}.`),
        });
    }
    return out;
}

export function makeCats(shape: DataShape): SBCategory[] {
    return [
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
                    { control: "divider" },
                    {
                        control: "segText", label: "Leaf reports", key: "layout.leafStack",
                        options: [opt("auto", "Auto"), opt("row", "Row"), opt("stacked", "Stacked")],
                        note: "Put a manager's direct reports in columns so wide teams stay readable. Auto stacks a team only when that draws the chart larger.",
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
                        note: "Open a large hierarchy at the top, with the deeper levels folded behind a + , at a size the names can be read at. Turning it off shows every level again; turning it on folds to fit. It never re-folds a branch a reader has opened by hand.",
                    },
                ],
            },
            {
                id: "levels", name: "Levels", kind: "fields", width: 280,
                info: "Which levels of the hierarchy are drawn. Level 1 is the roots and is always shown. Turning a level off folds the level above it into a count — which is how a large org stays readable.",
                fields: levelFields(shape),
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
                        options: [opt("auto", "Auto (bottom right)"), opt("tl", "Top left"),
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
                    {
                        control: "switch", label: "Search box", key: "overlays.showSearch",
                        note: "The Search people field in the top corner — type a name and the chart jumps to that card.",
                    },
                    {
                        control: "switch", label: "Minimap", key: "minimap.show",
                        note: "A thumbnail of the whole chart, with the part on screen marked. Click or drag it to move the view.",
                    },
                ],
            },
            {
                id: "actions", name: "Quick actions", kind: "fields", width: 268,
                info: "The zoom / fit / lens buttons anyone reading the report can use.",
                fields: [
                    { control: "switch", label: "Quick actions", key: "toolbar.actions" },
                    {
                        control: "select", label: "Position", key: "toolbar.actionsPosition",
                        options: [opt("tr", "Top right"), opt("tl", "Top left"),
                            opt("bl", "Bottom left"), opt("br", "Bottom right")],
                        dimIf: (g) => !g("toolbar.actions"),
                        disabledReason: "Turn on Quick actions to place them.",
                    },
                    { control: "divider" },
                    {
                        control: "switch", label: "Lens", key: "toolbar.lens",
                        note: "A magnifying loupe that follows the pointer — for reading cards drawn too small to see.",
                        dimIf: (g) => !g("toolbar.actions"),
                        disabledReason: "The lens lives in the quick-action bar.",
                    },
                ],
            },
            {
                id: "toolbar", name: "Gear", kind: "fields", width: 260,
                info: "This settings button itself.",
                fields: [
                    { control: "switch", label: "Show gear", key: "toolbar.show" },
                    {
                        control: "select", label: "Position", key: "toolbar.position",
                        options: [opt("auto", "Auto (bottom right)"), opt("bl", "Bottom left"),
                            opt("tl", "Top left"), opt("tr", "Top right"), opt("br", "Bottom right")],
                    },
                    { control: "switch", label: "Close on click-away", key: "toolbar.closeOnClickAway" },
                    { control: "divider" },
                    {
                        control: "switch", label: "Zentrix branding", key: "branding.showBranding",
                        note: "A small Zentrix wordmark on the tooltip card, while you are editing the report. Microsoft's guidelines do not allow a company mark in view mode, so readers never see it.",
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
                    // "Conditional formatting" (rules.enabled) is NOT offered until the rule
                    // editor exists (zentrix-org-chart#17, OC-QA-37): a switch with no way
                    // to define a rule is the dead control this product exists to beat.
                    // The key stays bound in KEYS so a stored rule still applies and Reset
                    // still clears it.
                ],
            },
        ],
    },
    ];
}

/**
 * The schema as the tests, the gates and any caller without an instance see it:
 * every level switch shown. A live gear builds its own through `makeCats` so the
 * ladder can follow the data it is actually looking at.
 */
export const SB_CATS: SBCategory[] = makeCats(defaultShape());
