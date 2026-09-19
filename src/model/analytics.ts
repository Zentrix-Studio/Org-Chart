"use strict";

/**
 * Org analytics — PAID (`orgAnalytics`).
 *
 * Turns the picture into people analytics: span of control, layers, branch
 * roll-ups and vacancy flags. Everything here is pure and iterative, so the
 * whole module is drivable from jest and a deep hierarchy cannot blow the stack.
 *
 * Never call these on the free path — `visual.ts` guards on
 * `license.allows("orgAnalytics")`.
 */

import { Hierarchy } from "./hierarchy";

export interface SpanThresholds {
    /** More direct reports than this is "too wide". */
    wide: number;
    /** Fewer than this (but at least one) is "too narrow". */
    narrow: number;
}

export const DEFAULT_SPAN: SpanThresholds = { wide: 12, narrow: 2 };

export type SpanFlag = "ok" | "wide" | "narrow" | "leaf";

export interface NodeMetrics {
    /** Immediate children. */
    directReports: number;
    /** Everyone below, at any depth. */
    totalDescendants: number;
    /** Levels of hierarchy beneath this node (0 for a leaf). */
    layersBelow: number;
    /** Depth from its own root (0 for a root). */
    depth: number;
    /** Sum of the bound measure across this node and its whole branch. */
    branchTotal: number | null;
    /** Span-of-control classification. */
    span: SpanFlag;
    /** True when the row reads as an unfilled position. */
    vacant: boolean;
}

export interface OrgSummary {
    people: number;
    roots: number;
    managers: number;
    individualContributors: number;
    /** Deepest chain in the whole forest, counted in levels. */
    maxDepth: number;
    /** Mean direct reports across managers only. Null when there are none. */
    averageSpan: number | null;
    wideSpans: number[];
    narrowSpans: number[];
    vacancies: number[];
}

/** Default markers for an unfilled position, matched case-insensitively. */
export const DEFAULT_VACANCY_MARKERS = ["vacant", "open", "open role", "tbh", "to be hired", "unfilled"];

/** True when a name/title reads as an unfilled position. */
export function isVacancy(name: string, title: string, markers: string[] = DEFAULT_VACANCY_MARKERS): boolean {
    const hay = `${name || ""} ${title || ""}`.toLowerCase();
    for (const m of markers) {
        const needle = m.toLowerCase().trim();
        if (needle.length === 0) continue;
        // Whole-word match so "Openshaw" is not a vacancy.
        const re = new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
        if (re.test(hay)) return true;
    }
    return false;
}

/** Levels of hierarchy beneath every node. Iterative, children-before-parents. */
export function layersBelow(h: Hierarchy): number[] {
    const n = h.parentIdx.length;
    const out = new Array<number>(n).fill(0);
    // Process deepest-first so a child's answer is ready when its parent is reached.
    const order = nodesDeepestFirst(h);
    for (const i of order) {
        let best = 0;
        const kids = h.children[i];
        for (let k = 0; k < kids.length; k++) best = Math.max(best, out[kids[k]] + 1);
        out[i] = best;
    }
    return out;
}

/** Node indices sorted deepest depth first — a safe post-order substitute. */
function nodesDeepestFirst(h: Hierarchy): number[] {
    const idx: number[] = [];
    for (let i = 0; i < h.parentIdx.length; i++) idx.push(i);
    idx.sort((a, b) => h.depth[b] - h.depth[a]);
    return idx;
}

/** Sum the measure across each node's whole branch, including itself. */
export function branchTotals(h: Hierarchy, measure: (i: number) => number | null): Array<number | null> {
    const n = h.parentIdx.length;
    const out = new Array<number | null>(n).fill(null);
    const own = new Array<number>(n).fill(0);
    const seen = new Array<boolean>(n).fill(false);
    for (let i = 0; i < n; i++) {
        const v = measure(i);
        if (v !== null && isFinite(v)) { own[i] = v; seen[i] = true; }
    }
    const acc = own.slice();
    const has = seen.slice();
    for (const i of nodesDeepestFirst(h)) {
        const kids = h.children[i];
        for (let k = 0; k < kids.length; k++) {
            const c = kids[k];
            acc[i] += acc[c];
            if (has[c]) has[i] = true;
        }
    }
    for (let i = 0; i < n; i++) out[i] = has[i] ? acc[i] : null;
    return out;
}

/** Classify a node's span of control. */
export function spanFlag(reports: number, t: SpanThresholds = DEFAULT_SPAN): SpanFlag {
    if (reports === 0) return "leaf";
    if (reports > t.wide) return "wide";
    if (reports < t.narrow) return "narrow";
    return "ok";
}

/** Per-node metrics for the whole forest. */
export function nodeMetrics(
    h: Hierarchy,
    measure: (i: number) => number | null,
    vacant: (i: number) => boolean,
    thresholds: SpanThresholds = DEFAULT_SPAN,
): NodeMetrics[] {
    const n = h.parentIdx.length;
    const below = layersBelow(h);
    const totals = branchTotals(h, measure);
    // Descendant counts without building a Set per node: children-first accumulation.
    const desc = new Array<number>(n).fill(0);
    const order: number[] = [];
    for (let i = 0; i < n; i++) order.push(i);
    order.sort((a, b) => h.depth[b] - h.depth[a]);
    for (const i of order) {
        const kids = h.children[i];
        let sum = 0;
        for (let k = 0; k < kids.length; k++) sum += desc[kids[k]] + 1;
        desc[i] = sum;
    }
    const out: NodeMetrics[] = [];
    for (let i = 0; i < n; i++) {
        const reports = h.children[i].length;
        out.push({
            directReports: reports,
            totalDescendants: desc[i],
            layersBelow: below[i],
            depth: h.depth[i],
            branchTotal: totals[i],
            span: spanFlag(reports, thresholds),
            vacant: vacant(i),
        });
    }
    return out;
}

/** Whole-org roll-up, for the summary strip. */
export function summarize(metrics: NodeMetrics[], h: Hierarchy): OrgSummary {
    let managers = 0, spanSum = 0, maxDepth = 0;
    const wideSpans: number[] = [], narrowSpans: number[] = [], vacancies: number[] = [];
    for (let i = 0; i < metrics.length; i++) {
        const m = metrics[i];
        if (m.directReports > 0) { managers++; spanSum += m.directReports; }
        if (m.depth > maxDepth) maxDepth = m.depth;
        if (m.span === "wide") wideSpans.push(i);
        if (m.span === "narrow") narrowSpans.push(i);
        if (m.vacant) vacancies.push(i);
    }
    return {
        people: metrics.length,
        roots: h.roots.length,
        managers,
        individualContributors: metrics.length - managers,
        maxDepth,
        averageSpan: managers === 0 ? null : spanSum / managers,
        wideSpans, narrowSpans, vacancies,
    };
}
