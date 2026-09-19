"use strict";

/**
 * Data-quality reporting for the host's warning icon.
 *
 * `IVisualHost.displayWarningIcon(title, detail)` puts a warning glyph in the
 * visual header; hovering shows the title and clicking shows the detail. The
 * visual keeps rendering — that is the point. Our permissive hierarchy contract
 * silently rescues malformed data (dangling parents become roots, cycles are
 * broken) — and silently DISCARDS some of it: a repeated Person ID keeps only its
 * first row, and a row with no Person ID at all is dropped. Silence is the wrong
 * answer for an author who has a genuine data bug.
 *
 * Platform limits, from the docs: title <= 70 characters, detail <= 2000, plain
 * text only. Enforced here so the host never truncates us mid-sentence.
 *
 * Source: learn.microsoft.com/power-bi/developer/visuals/visual-display-warning-icon
 */

export const MAX_WARNING_TITLE = 70;
export const MAX_WARNING_DETAIL = 2000;

export interface DataQuality {
    /** Rows whose parent key matched no Person ID — rendered as extra roots. */
    danglingParents: number;
    /**
     * Rows sharing a Person ID with an earlier row, and therefore NOT drawn.
     * Supplied by `buildOrgModel`: it is the only place that can still see them
     * (OC-QA-20 — this used to be recomputed from the de-duplicated key list,
     * where it could never be anything but zero).
     */
    duplicateIds: number;
    /** Rows with no Person ID at all, and therefore not drawn. */
    keylessRows: number;
    /** Rows whose parent link was dropped to break a reporting cycle. */
    cyclesBroken: number;
    /** Rows dropped by the tier's node cap. */
    droppedByCap: number;
    /** Distinct roots. More than one is legal, but often a data surprise. */
    roots: number;
}

/** Count the quality problems the permissive contract absorbed. */
export function assessQuality(
    keys: Array<string | null>,
    parentKeys: Array<string | null>,
    cyclesBroken: number,
    roots: number,
    droppedByCap: number,
    /** What `buildOrgModel` discarded before these keys existed. */
    discarded: { duplicateRows: number; keylessRows: number } = { duplicateRows: 0, keylessRows: 0 },
): DataQuality {
    // `keys` arrives ALREADY de-duplicated, so counting repeats in it is
    // meaningless — it is a unique list by construction. The real count has to
    // come from the transform that did the dropping.
    const seen = new Set<string>();
    for (const k of keys) if (k !== null && k !== undefined) seen.add(k);
    const duplicateIds = discarded.duplicateRows;
    let danglingParents = 0;
    for (let i = 0; i < parentKeys.length; i++) {
        const pk = parentKeys[i];
        if (pk === null || pk === undefined) continue;
        if (pk === keys[i]) continue;          // self-reference is a root, not a dangling parent
        if (!seen.has(pk)) danglingParents++;
    }
    return {
        danglingParents, duplicateIds, keylessRows: discarded.keylessRows,
        cyclesBroken, droppedByCap, roots,
    };
}

export interface Warning { title: string; detail: string; }

/** Clamp to the platform limit without cutting a word in half. */
function clamp(s: string, max: number): string {
    if (s.length <= max) return s;
    const cut = s.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    return (space > max * 0.6 ? cut.slice(0, space) : cut) + "…";
}

/**
 * Build the warning, or null when the data is clean.
 *
 * Deliberately NOT raised for multiple roots alone: a forest is normal and
 * warning about it would cry wolf on healthy data.
 */
export function buildWarning(q: DataQuality): Warning | null {
    const problems: string[] = [];
    if (q.cyclesBroken > 0) {
        problems.push(
            `${q.cyclesBroken} row${q.cyclesBroken === 1 ? "" : "s"} form a circular reporting line ` +
            `(someone reports, directly or indirectly, to themselves). Each one is shown as a root ` +
            `so the chart still renders.`);
    }
    if (q.danglingParents > 0) {
        problems.push(
            `${q.danglingParents} row${q.danglingParents === 1 ? "" : "s"} point to a manager that is ` +
            `not in the data. They are shown as roots. Check the Reports to column for typos or for ` +
            `people filtered out of the semantic model.`);
    }
    if (q.duplicateIds > 0) {
        problems.push(
            `${q.duplicateIds} row${q.duplicateIds === 1 ? "" : "s"} repeat a Person ID that appeared ` +
            `earlier and ${q.duplicateIds === 1 ? "is" : "are"} NOT shown — only the first row for ` +
            `each ID gets a card. Check the Person ID column for repeated keys.`);
    }
    if (q.keylessRows > 0) {
        problems.push(
            `${q.keylessRows} row${q.keylessRows === 1 ? " has" : "s have"} no Person ID and ` +
            `${q.keylessRows === 1 ? "is" : "are"} not shown. A row needs a key to become a card.`);
    }
    if (q.droppedByCap > 0) {
        problems.push(
            `${q.droppedByCap} row${q.droppedByCap === 1 ? "" : "s"} are not shown because the ` +
            `node cap was reached.`);
    }
    if (problems.length === 0) return null;

    const title = problems.length === 1
        ? "Check your hierarchy data"
        : `${problems.length} hierarchy data issues`;
    return {
        title: clamp(title, MAX_WARNING_TITLE),
        detail: clamp(problems.join("\n\n"), MAX_WARNING_DETAIL),
    };
}
