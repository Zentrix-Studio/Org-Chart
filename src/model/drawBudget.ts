"use strict";

/**
 * The draw budget — how many cards the chart may put on screen at once.
 *
 * Certification rejection 1180.2.4 (2026-09-28): "Your custom visual does not
 * properly support large numbers of rows. The visual stops responding. [100005
 * rows]". Nothing capped the number of cards DRAWN. Collapse-to-fit folds a
 * deep tree down to a handful of cards, so every tree we tested opened fine —
 * but it cannot fold below the roots, and a table whose "Reports to" values
 * match no Person ID is 100,005 roots. That drew 100,005 SVG cards, ~1.2 ms
 * each in Chromium, on every data segment fetch-more delivered. A manager with
 * 100,000 direct reports, expanded, is the same failure one level down.
 *
 * This is a ceiling on the PICTURE, not on the data. Every row is still loaded:
 * search finds anyone, the Table and Insight views cover everyone, the counts on
 * folded cards are the true counts, and the status line says how many cards are
 * not drawn. Nobody loses a person; the chart just stops trying to paint them
 * all at once, which no screen could show legibly anyway.
 *
 * Which cards make the cut: breadth-first from the roots, so the top of the
 * hierarchy always draws and every drawn card's manager is drawn too (a BFS
 * reaches a parent before its children). A FOCUS — the branch a reader just
 * opened, or the person search jumped to — goes first: its chain of managers,
 * then its own reports. Without that, opening a branch past the budget would
 * change nothing on screen, which is a dead control.
 *
 * O(n), iterative, no recursion — the same contract as `hierarchy.ts`.
 */

import { Hierarchy } from "./hierarchy";

/**
 * Cards drawn at once. Measured in Chromium against the live harness: 10,000
 * cards took 11.7 s to draw, so 1,500 is ~1.8 s in the worst shape (all roots)
 * — and far less on a real org, where collapse-to-fit opens on a few dozen.
 * At the 9 px legibility floor a full-HD canvas holds well under 1,500 cards,
 * so the budget is never what limits a view a reader can actually read.
 */
export const MAX_DRAWN_CARDS = 1500;

export interface DrawBudget {
    /** Everything not drawn: hidden by a collapsed manager OR past the budget. */
    hidden: Set<number>;
    /** Cards the collapse state would have drawn that the budget did not. */
    cut: number;
    /** Drawn managers whose EVERY visible report was cut — drawn folded (+N). */
    folded: Set<number>;
}

/**
 * @param collapseHidden what `hiddenByCollapse` hides
 * @param max            the budget
 * @param focus          node index to draw first (with its managers and its
 *                       direct reports), or -1
 */
export function applyDrawBudget(
    h: Hierarchy, collapseHidden: ReadonlySet<number>, max: number, focus = -1,
): DrawBudget {
    const n = h.parentIdx.length;
    const visible = n - collapseHidden.size;
    if (visible <= max) return { hidden: new Set(collapseHidden), cut: 0, folded: new Set() };

    const kept = new Uint8Array(n);
    let count = 0;
    const keep = (i: number): void => {
        if (kept[i] || count >= max || collapseHidden.has(i)) return;
        kept[i] = 1;
        count++;
    };

    // The focus first: its managers top-down, itself, then its own reports.
    if (focus >= 0 && focus < n && !collapseHidden.has(focus)) {
        const chain: number[] = [];
        for (let p = focus; p >= 0; p = h.parentIdx[p]) {
            chain.push(p);
            if (chain.length > n) break;          // cannot happen: cycles are already broken
        }
        for (let c = chain.length - 1; c >= 0; c--) keep(chain[c]);
        const kids = h.children[focus];
        for (let k = 0; k < kids.length && count < max; k++) keep(kids[k]);
    }

    // Then breadth-first from the roots, until the budget is spent.
    const queue: number[] = h.roots.slice();
    for (let q = 0; q < queue.length && count < max; q++) {
        const i = queue[q];
        if (collapseHidden.has(i)) continue;
        keep(i);
        if (!kept[i]) continue;
        const kids = h.children[i];
        for (let k = 0; k < kids.length; k++) queue.push(kids[k]);
    }

    const hidden = new Set(collapseHidden);
    for (let i = 0; i < n; i++) if (!kept[i]) hidden.add(i);

    // A manager drawn with none of its reports would otherwise read as a leaf
    // with an "open" toggle — say instead that there is more below.
    const folded = new Set<number>();
    for (let i = 0; i < n; i++) {
        if (!kept[i]) continue;
        const kids = h.children[i];
        let anyVisible = false, anyKept = false;
        for (let k = 0; k < kids.length; k++) {
            if (!collapseHidden.has(kids[k])) anyVisible = true;
            if (kept[kids[k]]) { anyKept = true; break; }
        }
        if (anyVisible && !anyKept) folded.add(i);
    }

    return { hidden, cut: visible - count, folded };
}
