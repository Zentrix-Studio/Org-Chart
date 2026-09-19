"use strict";

/**
 * Org insight — the plain-English read-out behind the Insight view (OC-029).
 *
 * Answers "so what does this hierarchy say?" in ordinary sentences: how big it
 * is, how wide the managers' spans run, how deep the reporting lines go, where
 * the people (and the measure) sit, and what in the data looks wrong.
 *
 * Pure: no DOM, no Power BI imports. Everything is computed from the same
 * `Hierarchy` and `NodeMetrics` the chart draws from, so the Insight view can
 * never disagree with the cards. Iterative throughout — a deep chain cannot
 * blow the stack.
 */

import { Hierarchy } from "../model/hierarchy";
import { NodeMetrics, OrgSummary, SpanThresholds } from "../model/analytics";

export type InsightTone = "positive" | "negative" | "neutral";

/** A click-through from the read-out to the chart. */
export interface InsightAction {
    kind: "focusPerson";
    /** Node index in the model the chart is drawn from. */
    index: number;
}

export interface InsightMetric {
    value: string;
    label: string;
    sub?: string;
    tone: InsightTone;
    action?: InsightAction;
}

export interface InsightLine {
    text: string;
    tone: InsightTone;
    strong?: boolean;
    action?: InsightAction;
}

export interface InsightSection {
    /** Stable id — tests and the renderer key on it, never on the title. */
    id: string;
    title: string;
    metric?: InsightMetric;
    lines: InsightLine[];
}

export interface OrgNarrative {
    headline: string;
    subhead: string;
    sections: InsightSection[];
}

export interface InsightInput {
    /** Display name per node. */
    names: string[];
    hierarchy: Hierarchy;
    metrics: NodeMetrics[];
    summary: OrgSummary;
    thresholds: SpanThresholds;
    /** Group label per node (null = no group); omit when the Group well is empty. */
    groups?: Array<string | null>;
    /** Caption of the Group column, e.g. "Department". */
    groupLabel?: string | null;
    /** The bound measure, or null when the Measure well is empty. */
    measure?: {
        label: string;
        values: Array<number | null>;
        format: (v: number) => string;
    } | null;
    /** True when "Flag vacancies" is on — otherwise vacancies were never looked for. */
    vacanciesFlagged?: boolean;
    /** Period comparison, when it is on and two periods exist. */
    changes?: { from: string; to: string; joiners: number; leavers: number; movers: number } | null;
    /** Rows the transform had to drop. */
    quality?: { duplicateRows: number; keylessRows: number };
}

/** "1 person" / "3 people". */
export function plural(n: number, one: string, many: string): string {
    return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function pct(part: number, whole: number): string {
    if (whole <= 0) return "0%";
    const p = (part / whole) * 100;
    // One decimal only where rounding would lie ("0%" for 3 of 900 people).
    return p > 0 && p < 1 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

/** Name for a node, never blank — a keyless name would make a sentence unreadable. */
function nameOf(input: InsightInput, i: number): string {
    const n = input.names[i];
    return n && n.trim().length ? n : "(unnamed)";
}

/** Nodes whose parent is a root: the top-level branches of every tree. */
function topBranches(h: Hierarchy): number[] {
    const out: number[] = [];
    for (const r of h.roots) for (const c of h.children[r]) out.push(c);
    return out;
}

/** Root → … → `leaf`, walking parents. Bounded by depth; cycles are already broken. */
export function chainTo(h: Hierarchy, leaf: number): number[] {
    const path: number[] = [];
    let p = leaf;
    while (p >= 0 && path.length <= h.parentIdx.length) {
        path.push(p);
        p = h.parentIdx[p];
    }
    return path.reverse();
}

/** "A → B → … → Y → Z" — the ends are what a reader recognises. */
function chainText(input: InsightInput, chain: number[]): string {
    const names = chain.map((i) => nameOf(input, i));
    if (names.length <= 5) return names.join(" → ");
    return [names[0], names[1], "…", names[names.length - 2], names[names.length - 1]].join(" → ");
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const s = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function sizeSection(input: InsightInput): InsightSection {
    const { summary: s, hierarchy: h, quality } = input;
    const lines: InsightLine[] = [];
    if (s.people > 1) {
        lines.push({
            text: `${pct(s.managers, s.people)} of people manage someone; `
                + `${plural(s.individualContributors, "person has", "people have")} no direct reports.`,
            tone: "neutral",
        });
    }
    if (h.roots.length > 1) {
        lines.push({
            text: `The data holds ${plural(h.roots.length, "separate tree", "separate trees")}: `
                + `${plural(h.roots.length, "person has", "people have")} no manager in the data.`,
            tone: "neutral",
        });
    }
    const cycles = h.cycleBroken.length;
    const dupes = quality ? quality.duplicateRows : 0;
    const keyless = quality ? quality.keylessRows : 0;
    if (cycles) {
        lines.push({
            text: `${plural(cycles, "reporting loop was", "reporting loops were")} broken to draw the chart — `
                + "someone reports, through others, to themselves.",
            tone: "negative", strong: true,
        });
    }
    if (dupes) {
        lines.push({
            text: `${plural(dupes, "row repeats", "rows repeat")} a Person ID already seen and ${dupes === 1 ? "was" : "were"} skipped.`,
            tone: "negative",
        });
    }
    if (keyless) {
        lines.push({
            text: `${plural(keyless, "row has", "rows have")} no Person ID and ${keyless === 1 ? "was" : "were"} skipped.`,
            tone: "negative",
        });
    }
    if (!cycles && !dupes && !keyless) {
        lines.push({ text: "No reporting loops, repeated IDs or blank IDs in the data.", tone: "positive" });
    }
    return {
        id: "size",
        title: "Size",
        metric: {
            value: s.people.toLocaleString("en-US"),
            label: s.people === 1 ? "person" : "people",
            sub: `${plural(s.managers, "manager", "managers")} · ${plural(s.individualContributors, "individual contributor", "individual contributors")}`,
            tone: "neutral",
        },
        lines,
    };
}

function spanSection(input: InsightInput): InsightSection | null {
    const { summary: s, metrics, thresholds: t } = input;
    if (s.managers === 0) return null;
    let widest = -1;
    for (let i = 0; i < metrics.length; i++) {
        if (widest < 0 || metrics[i].directReports > metrics[widest].directReports) widest = i;
    }
    const lines: InsightLine[] = [];
    const wd = metrics[widest].directReports;
    lines.push({
        text: `${nameOf(input, widest)} has the widest span: ${plural(wd, "direct report", "direct reports")}.`,
        tone: wd > t.wide ? "negative" : "neutral",
        strong: wd > t.wide,
        action: { kind: "focusPerson", index: widest },
    });
    if (s.wideSpans.length) {
        lines.push({
            text: `${plural(s.wideSpans.length, "manager runs", "managers run")} more than ${t.wide} direct reports.`,
            tone: "negative",
        });
    } else {
        lines.push({ text: `No manager has more than ${t.wide} direct reports.`, tone: "positive" });
    }
    if (s.narrowSpans.length) {
        lines.push({
            text: `${plural(s.narrowSpans.length, "manager has", "managers have")} fewer than `
                + `${plural(t.narrow, "direct report", "direct reports")}.`,
            tone: "neutral",
        });
    }
    const avg = s.averageSpan ?? 0;
    return {
        id: "span",
        title: "Span of control",
        metric: {
            value: avg.toFixed(1),
            label: "direct reports per manager, on average",
            sub: `Wide above ${t.wide} · narrow below ${t.narrow} (set in Org analysis)`,
            tone: avg > t.wide ? "negative" : "neutral",
        },
        lines,
    };
}

function depthSection(input: InsightInput): InsightSection {
    const { hierarchy: h, summary: s } = input;
    const layers = s.maxDepth + 1;
    let deepest = 0;
    for (let i = 1; i < h.depth.length; i++) if (h.depth[i] > h.depth[deepest]) deepest = i;
    const lines: InsightLine[] = [];
    if (layers > 1) {
        const chain = chainTo(h, deepest);
        lines.push({
            text: `Longest reporting line: ${chainText(input, chain)}.`,
            tone: "neutral",
            action: { kind: "focusPerson", index: deepest },
        });
        const typical = median(h.depth);
        lines.push({
            text: `The typical person sits ${plural(Math.round(typical), "level", "levels")} below the top.`,
            tone: "neutral",
        });
    } else {
        lines.push({ text: "Everyone is at the top level — nobody reports to anyone in the data.", tone: "neutral" });
    }
    return {
        id: "depth",
        title: "Depth",
        metric: {
            value: String(layers),
            label: layers === 1 ? "level" : "levels, top to bottom",
            tone: "neutral",
            action: layers > 1 ? { kind: "focusPerson", index: deepest } : undefined,
        },
        lines,
    };
}

function teamsSection(input: InsightInput): InsightSection | null {
    const { hierarchy: h, metrics, summary: s } = input;
    const branches = topBranches(h);
    if (branches.length === 0) return null;
    const size = (i: number): number => metrics[i].totalDescendants + 1;
    const ranked = branches.slice().sort((a, b) => size(b) - size(a));
    const top = ranked[0];
    const lines: InsightLine[] = ranked.slice(0, 3).map((i) => ({
        text: `${nameOf(input, i)} — ${plural(size(i), "person", "people")} (${pct(size(i), s.people)})`,
        tone: "neutral" as InsightTone,
        action: { kind: "focusPerson" as const, index: i },
    }));
    if (ranked.length > 3) {
        lines.push({ text: `…and ${plural(ranked.length - 3, "more branch", "more branches")} below the top.`, tone: "neutral" });
    }
    return {
        id: "teams",
        title: "Largest branches",
        metric: {
            value: size(top).toLocaleString("en-US"),
            label: `people in ${nameOf(input, top)}'s branch`,
            sub: `${pct(size(top), s.people)} of everyone`,
            tone: "neutral",
            action: { kind: "focusPerson", index: top },
        },
        lines,
    };
}

function measureSection(input: InsightInput): InsightSection | null {
    const m = input.measure;
    if (!m) return null;
    let total = 0, any = false, best = -1;
    for (let i = 0; i < m.values.length; i++) {
        const v = m.values[i];
        if (v === null || !isFinite(v)) continue;
        total += v;
        any = true;
        if (best < 0 || v > (m.values[best] as number)) best = i;
    }
    if (!any) return null;
    const lines: InsightLine[] = [];
    // Branch totals come from analytics, the same numbers the cards roll up.
    const branches = topBranches(input.hierarchy)
        .filter((i) => input.metrics[i].branchTotal !== null)
        .sort((a, b) => (input.metrics[b].branchTotal as number) - (input.metrics[a].branchTotal as number));
    if (branches.length) {
        const b = branches[0];
        const bt = input.metrics[b].branchTotal as number;
        lines.push({
            text: `${nameOf(input, b)}'s branch carries the most: ${m.format(bt)}`
                + (total > 0 && bt >= 0 ? ` (${pct(bt, total)} of the total).` : "."),
            tone: "neutral",
            action: { kind: "focusPerson", index: b },
        });
    }
    lines.push({
        text: `Highest single value: ${nameOf(input, best)}, ${m.format(m.values[best] as number)}.`,
        tone: "neutral",
        action: { kind: "focusPerson", index: best },
    });
    return {
        id: "measure",
        title: m.label,
        metric: { value: m.format(total), label: `total ${m.label}`, tone: "neutral" },
        lines,
    };
}

function groupsSection(input: InsightInput): InsightSection | null {
    if (!input.groups) return null;
    const counts = new Map<string, number>();
    for (const g of input.groups) if (g !== null && g !== "") counts.set(g, (counts.get(g) ?? 0) + 1);
    if (counts.size === 0) return null;
    const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const people = input.summary.people;
    const label = input.groupLabel || "Group";
    const lines: InsightLine[] = [{
        text: `Largest: ${ranked[0][0]}, ${plural(ranked[0][1], "person", "people")} (${pct(ranked[0][1], people)}).`,
        tone: "neutral",
    }];
    const singles = ranked.filter(([, n]) => n === 1).length;
    if (singles && ranked.length > 1) {
        lines.push({ text: `${plural(singles, "value has", "values have")} a single person.`, tone: "neutral" });
    }
    const none = input.groups.filter((g) => g === null || g === "").length;
    if (none) lines.push({ text: `${plural(none, "person has", "people have")} no ${label}.`, tone: "neutral" });
    return {
        id: "groups",
        title: label,
        metric: { value: String(counts.size), label: `distinct ${counts.size === 1 ? "value" : "values"}`, tone: "neutral" },
        lines,
    };
}

function vacancySection(input: InsightInput): InsightSection | null {
    if (!input.vacanciesFlagged) return null;
    const vac = input.summary.vacancies;
    const lines: InsightLine[] = [];
    if (vac.length === 0) {
        lines.push({ text: "No card reads as vacant, open, TBH or unfilled.", tone: "positive" });
    } else {
        // Which manager carries the most open roles.
        const under = new Map<number, number>();
        for (const i of vac) {
            const p = input.hierarchy.parentIdx[i];
            if (p >= 0) under.set(p, (under.get(p) ?? 0) + 1);
        }
        let top = -1, n = 0;
        under.forEach((c, p) => { if (c > n) { n = c; top = p; } });
        if (top >= 0) {
            lines.push({
                text: `Most sit under ${nameOf(input, top)}: ${plural(n, "open role", "open roles")}.`,
                tone: "neutral",
                action: { kind: "focusPerson", index: top },
            });
        }
    }
    return {
        id: "vacancies",
        title: "Open roles",
        metric: {
            value: String(vac.length),
            label: vac.length === 1 ? "open role" : "open roles",
            sub: `${pct(vac.length, input.summary.people)} of all positions`,
            tone: vac.length ? "negative" : "positive",
        },
        lines,
    };
}

function changesSection(input: InsightInput): InsightSection | null {
    const c = input.changes;
    if (!c) return null;
    const total = c.joiners + c.leavers + c.movers;
    const net = c.joiners - c.leavers;
    return {
        id: "changes",
        title: "Changes",
        metric: {
            value: String(total),
            label: `changes from ${c.from} to ${c.to}`,
            sub: `Net headcount ${net > 0 ? "+" : net < 0 ? "−" : "±"}${Math.abs(net)}`,
            tone: "neutral",
        },
        lines: [
            { text: `${plural(c.joiners, "joiner", "joiners")}`, tone: c.joiners ? "positive" : "neutral" },
            { text: `${plural(c.leavers, "leaver", "leavers")}`, tone: c.leavers ? "negative" : "neutral" },
            { text: `${plural(c.movers, "person moved", "people moved")} to a different manager`, tone: "neutral" },
        ],
    };
}

/** The full read-out. Sections with nothing to say are left out, not shown empty. */
export function computeOrgNarrative(input: InsightInput): OrgNarrative {
    const s = input.summary;
    const layers = s.maxDepth + 1;
    let headline = `${plural(s.people, "person", "people")} across ${plural(layers, "level", "levels")}`;
    if (s.averageSpan !== null) {
        headline += `; managers average ${s.averageSpan.toFixed(1)} direct reports`;
    }
    headline += ".";
    if (s.wideSpans.length) {
        headline += ` ${plural(s.wideSpans.length, "manager is", "managers are")} stretched past ${input.thresholds.wide}.`;
    }

    const subBits = [
        plural(input.hierarchy.roots.length, "person at the top", "people at the top"),
        plural(s.managers, "manager", "managers"),
        plural(s.individualContributors, "individual contributor", "individual contributors"),
    ];

    const sections = [
        sizeSection(input),
        spanSection(input),
        depthSection(input),
        teamsSection(input),
        measureSection(input),
        groupsSection(input),
        vacancySection(input),
        changesSection(input),
    ].filter((x): x is InsightSection => x !== null);

    return { headline, subhead: subBits.join(" · "), sections };
}
