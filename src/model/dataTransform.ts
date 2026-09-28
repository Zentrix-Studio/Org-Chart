"use strict";

/**
 * dataView -> OrgModel. Pure and host-free apart from the powerbi type imports,
 * so the whole transform is drivable from jest without a DOM.
 */

import powerbi from "powerbi-visuals-api";
import DataView = powerbi.DataView;
import DataViewCategoryColumn = powerbi.DataViewCategoryColumn;
import DataViewValueColumn = powerbi.DataViewValueColumn;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;

import { EmptyReason, OrgModel, OrgNode, PeriodRows } from "../types";
import { normalizeKey } from "./hierarchy";
import { safeImageDataUri } from "../imageSafety";

/** Find the first category column bound to `role`. */
function categoryFor(cats: DataViewCategoryColumn[] | undefined, role: string): DataViewCategoryColumn | null {
    if (!cats) return null;
    for (const c of cats) {
        if (c && c.source && c.source.roles && c.source.roles[role]) return c;
    }
    return null;
}

/**
 * Find the LAST category column bound to `role` — the drilled-to level.
 *
 * `drilldown` is declared on the Group role, so an author can drop a hierarchy
 * (Region > Department > Team) into it. When the user drills, the host sends
 * every level; the deepest one is what the cards should be coloured and
 * legended by.
 * Source: learn.microsoft.com/power-bi/developer/visuals/drill-down-support
 */
function deepestCategoryFor(cats: DataViewCategoryColumn[] | undefined, role: string): DataViewCategoryColumn | null {
    if (!cats) return null;
    let found: DataViewCategoryColumn | null = null;
    for (const c of cats) {
        if (c && c.source && c.source.roles && c.source.roles[role]) found = c;
    }
    return found;
}

/** Every value column bound to `role`, in order. */
function valuesFor(vals: DataViewValueColumn[] | undefined, role: string): DataViewValueColumn[] {
    if (!vals) return [];
    return vals.filter((v) => v && v.source && v.source.roles && v.source.roles[role]);
}

/**
 * Locale-aware number formatting for the measure badge and tooltip.
 * Uses the host locale so 1234.5 reads as "1,234.5" or "1.234,5" correctly.
 */
export function formatMeasure(value: number, locale?: string): string {
    try {
        return measureFormat(locale || "en-US").format(value);
    } catch {
        return String(value);   // an unknown locale must never break the render
    }
}

/*
 * One formatter per locale. Constructing an Intl.NumberFormat costs far more than
 * using one, and this runs once per ROW: at 100,005 rows it was 844 ms of every
 * update on its own (1180.2.4 profiling, 2026-09-28).
 */
const formats = new Map<string, Intl.NumberFormat>();
function measureFormat(locale: string): Intl.NumberFormat {
    let f = formats.get(locale);
    if (!f) {
        f = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });   // throws on a bad locale: not cached
        formats.set(locale, f);
    }
    return f;
}

/** Find the first value column bound to `role`. */
function valueFor(vals: DataViewValueColumn[] | undefined, role: string): DataViewValueColumn | null {
    if (!vals) return null;
    for (const v of vals) {
        if (v && v.source && v.source.roles && v.source.roles[role]) return v;
    }
    return null;
}

/** Which field wells currently hold a column — drives the landing page checklist. */
export interface RoleBinding {
    personId: boolean;
    parentId: boolean;
    personName: boolean;
    personTitle: boolean;
    photo: boolean;
    group: boolean;
    measure: boolean;
}

/**
 * Report which wells the author has filled.
 *
 * The landing page needs more than "which required role is missing": it ticks
 * off what is already bound, and it has to tell "nothing dropped yet" apart
 * from "both required fields are bound but the filters left no rows".
 */
export function boundRoles(dataView: DataView | undefined): RoleBinding {
    const cats = dataView?.categorical?.categories as DataViewCategoryColumn[] | undefined;
    const vals = dataView?.categorical?.values as unknown as DataViewValueColumn[] | undefined;
    const cat = (role: string): boolean => categoryFor(cats, role) !== null;
    return {
        personId: cat("personId"),
        parentId: cat("parentId"),
        personName: cat("personName"),
        personTitle: cat("personTitle"),
        photo: cat("photo"),
        group: cat("group"),
        measure: valuesFor(vals, "measure").length > 0,
    };
}

/** Which required role, if any, is unbound. */
export function missingRequiredRole(dataView: DataView | undefined): EmptyReason {
    const cats = dataView?.categorical?.categories as DataViewCategoryColumn[] | undefined;
    if (!cats || cats.length === 0) return EmptyReason.NoData;
    if (!categoryFor(cats, "personId")) return EmptyReason.MissingPersonId;
    if (!categoryFor(cats, "parentId")) return EmptyReason.MissingParentId;
    return EmptyReason.None;
}

function asNumber(v: unknown): number | null {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return isFinite(n) ? n : null;
}

/**
 * Build the model.
 *
 * @param host optional — supplied by the visual so each card can cross-filter.
 *             Omitted in unit tests, which need no host.
 * @param cap maximum rows to keep (the tier's node cap). Rows beyond the cap are
 *            dropped in source order and reported via `capped` / `totalRows`, so
 *            the visual can show "showing 500 of 1,240" rather than a blank.
 */
export function buildOrgModel(
    dataView: DataView | undefined,
    cap: number,
    host?: IVisualHost,
    locale?: string,
): OrgModel {
    const empty: OrgModel = {
        nodes: [], groups: [], capped: false, totalRows: 0, duplicateRows: 0, keylessRows: 0,
        hasSecondaryParent: false, hasPeriod: false, hasHighlights: false,
        measureLabel: null, groupLabel: null, tooltipColumns: [],
        periodRows: { keys: [], parents: [], periods: [] },
    };
    const cats = dataView?.categorical?.categories as DataViewCategoryColumn[] | undefined;
    if (!cats) return empty;

    const idCol = categoryFor(cats, "personId");
    const parentCol = categoryFor(cats, "parentId");
    if (!idCol || !parentCol) return empty;

    const secondaryCol = categoryFor(cats, "secondaryParentId");
    const periodCol = categoryFor(cats, "period");
    const nameCol = categoryFor(cats, "personName");
    const titleCol = categoryFor(cats, "personTitle");
    const photoCol = categoryFor(cats, "photo");
    // Group is drillable, so take the deepest bound level.
    const groupCol = deepestCategoryFor(cats, "group");
    const vals = dataView?.categorical?.values as unknown as DataViewValueColumn[] | undefined;
    const measureCol = valueFor(vals, "measure");
    const tooltipCols = valuesFor(vals, "tooltips");
    // The host sends `highlights` when another visual cross-filters this one:
    // a parallel array where non-highlighted rows are null.
    const highlights = (measureCol as unknown as { highlights?: unknown[] })?.highlights
        || (vals && vals.length ? (vals[0] as unknown as { highlights?: unknown[] }).highlights : undefined);
    const hasHighlights = Array.isArray(highlights);

    const totalRows = idCol.values ? idCol.values.length : 0;
    const limit = Math.min(totalRows, isFinite(cap) ? Math.max(0, cap) : totalRows);

    const nodes: OrgNode[] = [];
    const groups: string[] = [];
    const groupIndex = new Map<string, number>();
    const seen = new Set<string>();
    // Rows this loop discards. Nothing downstream can recover these counts, so
    // they are carried out on the model and reported (OC-QA-20).
    let duplicateRows = 0;
    let keylessRows = 0;
    // Raw rows for the period comparison, kept BEFORE the de-duplication below.
    // Only assembled when a Period is bound, so the ordinary path allocates nothing.
    const periodRows: PeriodRows = { keys: [], parents: [], periods: [] };

    for (let i = 0; i < limit; i++) {
        const key = normalizeKey(idCol.values[i]);
        if (key === null) { keylessRows++; continue; }   // no identity — cannot be a card
        if (periodCol) {
            periodRows.keys.push(key);
            periodRows.parents.push(normalizeKey(parentCol.values[i]));
            periodRows.periods.push(normalizeKey(periodCol.values[i]));
        }
        if (seen.has(key)) { duplicateRows++; continue; }   // duplicate ID — first row wins
        seen.add(key);

        const group = groupCol ? normalizeKey(groupCol.values[i]) : null;
        if (group !== null && !groupIndex.has(group)) {
            groupIndex.set(group, groups.length);
            groups.push(group);
        }

        const measure = measureCol && measureCol.values ? asNumber(measureCol.values[i]) : null;

        nodes.push({
            index: i,
            key,
            parentKey: normalizeKey(parentCol.values[i]),
            secondaryParentKey: secondaryCol ? normalizeKey(secondaryCol.values[i]) : null,
            period: periodCol ? normalizeKey(periodCol.values[i]) : null,
            name: (nameCol ? normalizeKey(nameCol.values[i]) : null) ?? key,
            title: (titleCol ? normalizeKey(titleCol.values[i]) : null) ?? "",
            photo: photoCol ? safeImageDataUri(photoCol.values[i]) : null,
            group,
            measure,
            measureText: measure === null ? null : formatMeasure(measure, locale),
            highlighted: hasHighlights
                ? (highlights as unknown[])[i] !== null && (highlights as unknown[])[i] !== undefined
                : true,
            selectionId: host
                ? host.createSelectionIdBuilder().withCategory(idCol, i).createSelectionId()
                : null,
        });
    }

    return {
        nodes, groups, capped: totalRows > limit, totalRows, duplicateRows, keylessRows,
        hasSecondaryParent: !!secondaryCol,
        hasPeriod: !!periodCol,
        hasHighlights,
        measureLabel: measureCol?.source?.displayName ?? null,
        groupLabel: groupCol?.source?.displayName ?? null,
        tooltipColumns: tooltipCols.map((c) => ({
            displayName: c.source?.displayName ?? "",
            values: (c.values as unknown[]) || [],
        })),
        periodRows,
    };
}
