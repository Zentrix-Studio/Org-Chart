"use strict";

/**
 * Dotted-line / matrix reporting — PAID (`dottedLines`).
 *
 * A second manager, drawn as a dashed connector. This is the feature no free
 * org chart on the marketplace offers, and every matrixed organisation needs.
 *
 * Design decision worth keeping: a dotted line is an EXTRA EDGE, never a second
 * parent in the tree. The layout tree stays a strict forest built from the
 * primary `Reports to` role, so adding dotted lines can never change where a
 * card sits, never create a cycle in the layout, and never affect collapse.
 * They are drawn on top and can be toggled off without relayout.
 */

export interface DottedLink {
    /** Node index of the secondary manager. */
    from: number;
    /** Node index of the person. */
    to: number;
}

export interface DottedResult {
    links: DottedLink[];
    /** Secondary parents that matched no row — reported, not silently dropped. */
    dangling: number[];
    /** Rows whose secondary manager duplicates their primary one. */
    redundant: number[];
}

/**
 * Resolve secondary-manager keys into drawable links.
 *
 * Dropped, with a reason, when the secondary parent is: blank, the person
 * themselves, unknown, or identical to their primary manager.
 *
 * @param keys            person key per node
 * @param primaryParent   resolved primary parent index per node (-1 for a root)
 * @param secondaryKeys   the secondary-manager key per node, null where absent
 */
export function resolveDottedLines(
    keys: Array<string | null>,
    primaryParent: number[],
    secondaryKeys: Array<string | null>,
): DottedResult {
    const links: DottedLink[] = [];
    const dangling: number[] = [];
    const redundant: number[] = [];

    const byKey = new Map<string, number>();
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k !== null && k !== undefined && !byKey.has(k)) byKey.set(k, i);
    }

    const seen = new Set<string>();
    for (let i = 0; i < secondaryKeys.length; i++) {
        const sk = secondaryKeys[i];
        if (sk === null || sk === undefined) continue;
        const from = byKey.get(sk);
        if (from === undefined) { dangling.push(i); continue; }
        if (from === i) continue;                       // self-reference
        if (from === primaryParent[i]) { redundant.push(i); continue; }
        const sig = `${from}>${i}`;
        if (seen.has(sig)) continue;                    // duplicate rows
        seen.add(sig);
        links.push({ from, to: i });
    }
    return { links, dangling, redundant };
}

/**
 * Dotted links whose BOTH ends are currently visible. A dashed line to a card
 * hidden inside a collapsed branch would point at nothing.
 */
export function visibleDottedLinks(links: DottedLink[], hidden: ReadonlySet<number>): DottedLink[] {
    if (hidden.size === 0) return links;
    const out: DottedLink[] = [];
    for (const l of links) {
        if (hidden.has(l.from) || hidden.has(l.to)) continue;
        out.push(l);
    }
    return out;
}

/** Secondary-manager count per node — feeds the analytics summary. */
export function dottedInDegree(links: DottedLink[], n: number): number[] {
    const out = new Array<number>(n).fill(0);
    for (const l of links) if (l.to >= 0 && l.to < n) out[l.to]++;
    return out;
}
