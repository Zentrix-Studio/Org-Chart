"use strict";

/**
 * Org over time — PAID (`temporal`).
 *
 * Given a period value per row (any sortable label — "2026-Q1", a date, a
 * snapshot id), compare two snapshots of the same hierarchy and classify every
 * person as a joiner, leaver, mover, or unchanged.
 *
 * "Mover" means their manager changed between the two periods — the single most
 * useful reorg signal and the one no free org chart on the marketplace offers.
 *
 * Pure and allocation-light; no host, no DOM.
 */

export type ChangeKind = "joiner" | "leaver" | "mover" | "unchanged";

export interface PersonSnapshot {
    key: string;
    parentKey: string | null;
}

export interface PeriodDiff {
    from: string;
    to: string;
    /** Present in `to` but not `from`. */
    joiners: string[];
    /** Present in `from` but not `to`. */
    leavers: string[];
    /** In both, with a different parent. */
    movers: string[];
    unchanged: string[];
    /** Per-key classification, for card badging. */
    kindOf: Map<string, ChangeKind>;
}

/** Distinct period labels in sorted order. Blank periods are ignored. */
export function periodsOf(periods: Array<string | null>): string[] {
    const set = new Set<string>();
    for (const p of periods) {
        if (p === null || p === undefined) continue;
        const s = String(p).trim();
        if (s.length > 0) set.add(s);
    }
    return Array.from(set).sort();
}

/** Rows belonging to one period, de-duplicated by key (first row wins). */
export function snapshotAt(
    keys: Array<string | null>,
    parents: Array<string | null>,
    periods: Array<string | null>,
    period: string,
): Map<string, PersonSnapshot> {
    const out = new Map<string, PersonSnapshot>();
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === null || k === undefined) continue;
        const p = periods[i] === null || periods[i] === undefined ? null : String(periods[i]).trim();
        if (p !== period) continue;
        if (out.has(k)) continue;
        out.set(k, { key: k, parentKey: parents[i] ?? null });
    }
    return out;
}

/** Classify every person across two snapshots. */
export function diffPeriods(
    from: Map<string, PersonSnapshot>,
    to: Map<string, PersonSnapshot>,
    fromLabel = "",
    toLabel = "",
): PeriodDiff {
    const joiners: string[] = [], leavers: string[] = [], movers: string[] = [], unchanged: string[] = [];
    const kindOf = new Map<string, ChangeKind>();

    to.forEach((rec, key) => {
        const before = from.get(key);
        if (!before) { joiners.push(key); kindOf.set(key, "joiner"); return; }
        if ((before.parentKey ?? null) !== (rec.parentKey ?? null)) {
            movers.push(key); kindOf.set(key, "mover"); return;
        }
        unchanged.push(key); kindOf.set(key, "unchanged");
    });
    from.forEach((_rec, key) => {
        if (to.has(key)) return;
        leavers.push(key); kindOf.set(key, "leaver");
    });

    joiners.sort(); leavers.sort(); movers.sort(); unchanged.sort();
    return { from: fromLabel, to: toLabel, joiners, leavers, movers, unchanged, kindOf };
}

/**
 * The two periods to compare by default: the latest, and the one before it.
 * Returns null when there is nothing to compare.
 */
export function defaultComparison(periods: string[]): { from: string; to: string } | null {
    if (periods.length < 2) return null;
    return { from: periods[periods.length - 2], to: periods[periods.length - 1] };
}

/** Colour token key per change kind — resolved against the theme by the renderer. */
export const CHANGE_TONE: Record<ChangeKind, "pos" | "neg" | "accent" | "muted"> = {
    joiner: "pos",
    leaver: "neg",
    mover: "accent",
    unchanged: "muted",
};
