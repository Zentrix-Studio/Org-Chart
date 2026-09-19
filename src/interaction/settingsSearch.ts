"use strict";

/**
 * Settings search — a pure, DOM-free index + matcher over the gear tree (SB_CATS).
 *
 * It finds a setting by its exact name, a close (typo) name, OR a different *word*
 * for the same thing, so a user who knows Power BI's own vocabulary finds our
 * control even when we named it differently. The synonym table below is grounded in
 * real Power BI formatting-pane terminology (learn.microsoft.com) plus the words
 * people actually use for a Sankey — "ribbon", "band", "funnel", "journey" — NOT
 * guesses: our "Rules" is Power BI's "conditional formatting / fx"; our "opacity"
 * is their "transparency"; "data colors", "data labels", "display units", etc.
 *
 * Certification-safe: no network, no `eval`, no external data — a deterministic
 * function over static schema text. Everything here is unit-tested.
 */

import type { SBCategory, SBField } from "./zentrixSettingsBar";

/** One searchable control, flattened out of the category → sub → field tree. */
export interface SearchEntry {
    /** Engine key used to jump to and highlight the control (data-fkey). */
    key: string;
    label: string;
    catId: string;
    catName: string;
    subId: string;
    subName: string;
}

export type MatchType = "exact" | "starts" | "contains" | "category" | "synonym" | "fuzzy";

export interface SearchResult extends SearchEntry {
    score: number;
    matchType: MatchType;
    /** "You mean this" context — present only for non-literal (synonym/fuzzy) hits,
     *  telling the user WHY this control matched what they typed. */
    hint?: string;
}

/**
 * Concept map: `canon` = the words that actually appear in our labels; `aliases` =
 * the Power BI / everyday words a user is likely to type instead. Researched against
 * the Power BI formatting-pane vocabulary and the Sankey vocabulary in
 * PRODUCT-DEFINITION — extend it here, never inline.
 */
const CONCEPTS: { canon: string[]; aliases: string[] }[] = [
    { canon: ["rule", "rules"], aliases: ["conditional formatting", "conditional format", "conditional", "fx", "threshold", "thresholds", "format by rule", "format rule"] },
    { canon: ["opacity", "transparent", "dimmed"], aliases: ["transparency", "alpha", "fade", "see through", "translucent", "ghost"] },
    { canon: ["colour", "color", "palette"], aliases: ["data colors", "data colours", "data color", "data colour", "fill colour", "fill color", "sentiment", "recolour", "recolor", "theme colours", "theme colors"] },
    { canon: ["label", "labels", "title", "titles"], aliases: ["data labels", "data label", "callout", "callout value", "value label", "text label", "name tag", "caption", "heading"] },
    { canon: ["border"], aliases: ["outline", "stroke", "frame", "ring", "visual border"] },
    { canon: ["pattern", "patterns"], aliases: ["texture", "hatch", "hatching", "stripe", "stripes", "fill pattern", "accessibility pattern"] },
    { canon: ["legend"], aliases: ["key", "colour key", "color key", "swatch key"] },
    { canon: ["gradient"], aliases: ["color scale", "colour scale", "colorscale", "continuous", "sequential", "heat", "ramp", "blend"] },
    { canon: ["width", "thickness", "spacing"], aliases: ["weight", "stroke width", "line width", "thick", "boldness", "gap", "padding", "margin"] },
    { canon: ["font", "text size"], aliases: ["font family", "font size", "typography", "typeface", "point size"] },
    { canon: ["background", "backdrop"], aliases: ["canvas colour", "canvas color", "plot background", "fill background"] },
    { canon: ["tooltip", "tooltips"], aliases: ["hover", "popup", "pop up", "infotip", "hover card", "mouseover"] },
    { canon: ["zoom", "pan", "fill space"], aliases: ["zoom slider", "scroll", "magnify", "pan and zoom", "fit", "fit to view"] },
    { canon: ["ranking", "rank", "top n", "show"], aliases: ["topn", "top-n", "bottom n", "leaderboard", "limit", "cap", "truncate", "filter"] },
    { canon: ["other"], aliases: ["remainder", "rest", "bucket", "grouped", "misc", "everything else"] },
    { canon: ["flow", "flows", "link", "links"], aliases: ["ribbon", "ribbons", "band", "bands", "stream", "streams", "edge", "edges", "line", "lines", "connection", "connections", "arrow", "arrows", "path", "paths"] },
    { canon: ["node", "nodes"], aliases: ["bar", "bars", "block", "blocks", "box", "boxes", "vertex", "vertices", "entity", "category"] },
    { canon: ["stage", "stages"], aliases: ["column", "columns", "layer", "layers", "step", "steps", "level", "levels", "depth", "phase", "phases", "funnel"] },
    { canon: ["orientation", "alignment", "position"], aliases: ["direction", "horizontal", "vertical", "left to right", "top to bottom", "rotate", "flip", "align", "placement", "anchor", "layout", "arrangement"] },
    { canon: ["curvature"], aliases: ["curve", "bend", "bezier", "roundness", "smoothing", "straight"] },
    { canon: ["animate", "animation", "speed"], aliases: ["motion", "transition", "transitions", "movement", "flowing", "moving"] },
    { canon: ["icon", "icons", "image", "images"], aliases: ["picture", "logo", "avatar", "emoji", "photo", "symbol", "glyph", "marker", "markers"] },
    { canon: ["variance", "comparison", "compare"], aliases: ["delta", "difference", "change", "vs", "versus", "budget", "actual", "target", "scenario", "prior", "last month"] },
    { canon: ["drop-off", "drop off"], aliases: ["churn", "attrition", "leakage", "loss", "abandon", "abandonment", "fall out", "fallout"] },
    { canon: ["insight", "insights", "diagnostics", "integrity"], aliases: ["analysis", "analytics", "narrative", "summary", "explain", "story", "data quality", "audit", "reconcile", "balance", "imbalance"] },
    { canon: ["display units", "decimals", "accounting"], aliases: ["number format", "format", "thousands", "millions", "billions", "abbreviate", "precision", "decimal places", "currency", "negative"] },
    { canon: ["summary table", "table"], aliases: ["grid", "data table", "show as table", "tabular", "matrix"] },
    { canon: ["shadow", "halo"], aliases: ["drop shadow", "glow", "depth", "elevation"] },
    { canon: ["export", "download"], aliases: ["save", "csv", "excel", "xlsx", "pdf", "png", "image export", "snapshot", "print", "share"] },
    { canon: ["note", "notes", "annotation", "annotations"], aliases: ["comment", "comments", "sticky", "sticky note", "callout note", "markup", "memo"] },
];

/** Flatten SB_CATS into a searchable entry per control (with an engine key). */
export function buildSearchIndex(cats: SBCategory[]): SearchEntry[] {
    const out: SearchEntry[] = [];
    for (const cat of cats) {
        for (const sub of cat.subs || []) {
            const subName = sub.name || "";
            // A menu/swatch sub IS itself one control (its own key).
            if ((sub.kind === "menu" || sub.kind === "swatch") && sub.key) {
                out.push({ key: sub.key, label: subName || sub.key, catId: cat.id, catName: cat.name, subId: sub.id, subName });
                continue;
            }
            for (const f of sub.fields || []) {
                const key = f.key ?? (f.keys && f.keys[0]);
                const label = f.label;
                // Skip structural rows (dividers/headings/notes) and keyless controls.
                if (!key || !label || f.control === "divider" || f.control === "heading" || f.control === "note") continue;
                out.push({ key, label, catId: cat.id, catName: cat.name, subId: sub.id, subName });
            }
        }
    }
    return out;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Bounded Levenshtein — good enough for single-word typo tolerance. */
function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        prev = cur;
    }
    return prev[b.length];
}

/** Which alias phrase(s) the query invokes, and the canon tokens they map to. */
function conceptsForQuery(q: string): { alias: string; canon: string[] }[] {
    const hits: { alias: string; canon: string[] }[] = [];
    for (const c of CONCEPTS) {
        for (const alias of c.aliases) {
            // The user's phrase matches an alias when either contains the other (with a
            // length guard so "n" doesn't match everything).
            if (q.length >= 2 && (q === alias || alias.includes(q) || q.includes(alias))) {
                hits.push({ alias, canon: c.canon });
                break;
            }
        }
    }
    return hits;
}

/**
 * Rank the index against `query`. exact/starts/contains beat synonym, which beats a
 * fuzzy (typo) match. Category-name matches rank below own-label matches.
 */
export function searchSettings(index: SearchEntry[], query: string, limit = 25): SearchResult[] {
    const q = norm(query);
    if (q.length < 2) return [];
    const conceptHits = conceptsForQuery(q);
    const results: SearchResult[] = [];

    for (const e of index) {
        const label = norm(e.label);
        const cat = norm(e.catName);
        const subn = norm(e.subName);
        let best: { score: number; matchType: MatchType; hint?: string } | null = null;

        if (label === q) best = { score: 100, matchType: "exact" };
        else if (label.startsWith(q)) best = { score: 88, matchType: "starts" };
        else if (label.includes(q)) best = { score: 74, matchType: "contains" };
        else if (subn.includes(q) || cat.includes(q)) best = { score: 58, matchType: "category" };

        if (!best && conceptHits.length) {
            // Synonym: the query is a Power BI / everyday alias whose concept word
            // appears in this control's own text.
            const hay = `${label} ${subn} ${cat}`;
            for (const ch of conceptHits) {
                if (ch.canon.some((tok) => hay.includes(tok))) {
                    best = { score: 52, matchType: "synonym", hint: `Also called “${ch.alias}”` };
                    break;
                }
            }
        }

        if (!best) {
            // Fuzzy: a single label word within edit distance of the query (typo).
            const maxD = q.length <= 4 ? 1 : 2;
            for (const w of label.split(" ")) {
                if (w.length >= 3 && editDistance(w, q) <= maxD) {
                    best = { score: 38, matchType: "fuzzy", hint: "Did you mean this?" };
                    break;
                }
            }
        }

        if (best) results.push({ ...e, ...best });
    }

    results.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    return results.slice(0, limit);
}

/** Why a searched control is currently unavailable (hidden by data/mode, or dimmed
 *  by an unmet prerequisite), or undefined when it's fully active. Pure — the bar
 *  passes in a live `get`. */
export function gateReason(f: SBField | undefined, get: (k: string) => unknown): string | undefined {
    if (!f) return undefined;
    if (f.visibleIf && !f.visibleIf(get)) return "Not available with the current data or mode";
    if (f.dimIf && f.dimIf(get)) return (f.disabledReasonFn ? f.disabledReasonFn(get) : undefined) ?? f.disabledReason ?? "Currently unavailable";
    return undefined;
}
