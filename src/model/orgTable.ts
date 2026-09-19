"use strict";

/**
 * Rows behind the Table view (OC-029), and the CSV the table exports.
 *
 * Pure: no DOM, no Power BI imports, so the whole thing is drivable from jest.
 * One row per person, built from the same `Hierarchy` and `NodeMetrics` the
 * chart draws from — the table can never disagree with the cards. The table
 * covers EVERYONE, including people inside collapsed branches: collapsing is a
 * way of looking at the chart, not a filter on the data.
 */

import { Hierarchy } from "./hierarchy";
import { NodeMetrics, SpanFlag } from "./analytics";
import { ChangeKind } from "./temporal";
import { OrgModel } from "../types";

export interface OrgTableRow {
    /** Node index in the model — what "show on chart" jumps to. */
    index: number;
    name: string;
    title: string;
    /** The resolved manager's name; "" for a root. */
    manager: string;
    /** 1 for the top of a tree. */
    level: number;
    direct: number;
    /** Everyone below, at any depth. */
    team: number;
    layersBelow: number;
    span: SpanFlag;
    group: string | null;
    measure: number | null;
    measureText: string | null;
    branchTotal: number | null;
    vacant: boolean;
    change: ChangeKind | null;
    /** False only while another visual highlights and this row is not in it. */
    highlighted: boolean;
    /** Position in a depth-first walk — the default, outline-shaped order. */
    treeOrder: number;
}

/**
 * Depth-first, parents before children, siblings in input order. Iterative: a
 * 10,000-deep chain must not blow the stack. Every node gets a slot, so nothing
 * is dropped even if the hierarchy were somehow disconnected.
 */
export function treeOrder(h: Hierarchy): number[] {
    const n = h.parentIdx.length;
    const order = new Array<number>(n).fill(-1);
    let next = 0;
    const stack: number[] = [];
    for (let r = h.roots.length - 1; r >= 0; r--) stack.push(h.roots[r]);
    while (stack.length) {
        const i = stack.pop() as number;
        if (order[i] !== -1) continue;
        order[i] = next++;
        const kids = h.children[i];
        for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
    }
    for (let i = 0; i < n; i++) if (order[i] === -1) order[i] = next++;
    return order;
}

export function buildOrgRows(
    model: OrgModel,
    h: Hierarchy,
    metrics: NodeMetrics[],
    changeOf: Map<string, ChangeKind> | null = null,
): OrgTableRow[] {
    const order = treeOrder(h);
    return model.nodes.map((node, i) => {
        const p = h.parentIdx[i];
        const m = metrics[i];
        return {
            index: i,
            name: node.name,
            title: node.title,
            manager: p >= 0 ? model.nodes[p].name : "",
            level: h.depth[i] + 1,
            direct: m.directReports,
            team: m.totalDescendants,
            layersBelow: m.layersBelow,
            span: m.span,
            group: node.group,
            measure: node.measure,
            measureText: node.measureText,
            branchTotal: m.branchTotal,
            vacant: m.vacant,
            change: changeOf ? (changeOf.get(node.key) ?? null) : null,
            highlighted: node.highlighted,
            treeOrder: order[i],
        };
    });
}

/**
 * One CSV cell, RFC 4180 quoted. Text that a spreadsheet would read as a
 * formula (`=`, `+`, `-`, `@`, tab, CR) is prefixed with `'` — a name in a
 * report is data, and must never execute when the export is opened (OWASP
 * "CSV injection"). Real numbers are left alone, so `-12` stays a number.
 */
export function csvCell(v: string | number | null | undefined): string {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Array<Array<string | number | null>>): string {
    return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
