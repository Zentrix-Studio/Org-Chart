"use strict";

import powerbi from "powerbi-visuals-api";

/** One row of the bound data = one card. */
export interface OrgNode {
    /** Row index in the source dataView — the identity used for selection. */
    index: number;
    /** The Person ID value, normalised to a string key. */
    key: string;
    /** Raw parent key as bound, before root/cycle resolution. Null when absent. */
    parentKey: string | null;
    /** PAID. Secondary ("dotted-line") manager key. Never affects layout. */
    secondaryParentKey: string | null;
    /** PAID. Snapshot label for period comparison. Null when unbound. */
    period: string | null;
    /** Display name; falls back to `key` when the Name role is unbound. */
    name: string;
    /** Title line. Empty string when unbound. */
    title: string;
    /** Sanitised base64 data URI, or null. Never a remote URL. */
    photo: string | null;
    /** Group label, or null when the Group role is unbound. */
    group: string | null;
    /** Measure value, or null. */
    measure: number | null;
    /** Formatted measure for display, or null. Locale-aware. */
    measureText: string | null;
    /** False only when the host is highlighting and this row is not in it. */
    highlighted: boolean;
    /** Power BI selection identity for cross-filtering. Null outside a host
     *  (unit tests build the model without one). */
    selectionId: powerbi.visuals.ISelectionId | null;
}

export interface OrgModel {
    nodes: OrgNode[];
    /** Distinct group labels in first-seen order; index = palette slot. */
    groups: string[];
    /** True when the source data was truncated by the free-tier cap. */
    capped: boolean;
    /** Rows present before capping — for the honest "showing N of M" notice. */
    totalRows: number;
    /**
     * Rows skipped because their Person ID repeated an earlier row. Counted here
     * because only `buildOrgModel` can see them: by the time anything downstream
     * has `nodes`, the duplicates are gone and are uncountable (OC-QA-20).
     */
    duplicateRows: number;
    /** Rows skipped because they had no Person ID at all — blank or whitespace. */
    keylessRows: number;
    /** True when the Dotted-line manager role is bound. */
    hasSecondaryParent: boolean;
    /** True when the Period role is bound. */
    hasPeriod: boolean;
    /** True when the host sent a highlight set (another visual cross-filtered us). */
    hasHighlights: boolean;
    /** Caption of the bound measure column, for tooltips. */
    measureLabel: string | null;
    /** Caption of the bound group column — the drilled level when drilling. */
    groupLabel: string | null;
    /** Extra fields bound to the Tooltips role. */
    tooltipColumns: Array<{ displayName: string; values: unknown[] }>;
    /**
     * PAID (`temporal`). Per-row id / parent / period as bound, BEFORE the
     * de-duplication by key that `nodes` goes through.
     *
     * With a Period bound, one person legitimately occupies one row per period,
     * so those rows ARE duplicate keys — `nodes` keeps only the first and drops
     * the rest. Comparing two periods needs every row, or a person present in
     * both periods loses their later row and can never be seen to have moved.
     *
     * Empty unless the Period role is bound.
     */
    periodRows: PeriodRows;
}

/** Parallel arrays of the raw period rows. See `OrgModel.periodRows`. */
export interface PeriodRows {
    keys: Array<string | null>;
    parents: Array<string | null>;
    periods: Array<string | null>;
}

/** Why the visual is showing a landing page instead of a chart. */
export enum EmptyReason {
    None = "none",
    NoData = "noData",
    MissingPersonId = "missingPersonId",
    MissingParentId = "missingParentId",
}

export type Orientation = "topDown" | "leftRight";
export type ConnectorStyle = "elbow" | "straight" | "curved";
export type ColorMode = "single" | "group" | "level";
export type TooltipStyle = "card" | "native" | "off";
