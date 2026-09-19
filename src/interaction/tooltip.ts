"use strict";

/**
 * Tooltips via the host's `ITooltipService`, so they render exactly like a
 * native visual's and pick up the report theme.
 *
 * Two platform behaviours matter here:
 *  • Microsoft's guidance is to enable tooltips in ALL scenarios, regardless of
 *    the `allowInteractions` flag — a dashboard tile is non-interactive but
 *    should still explain itself on hover.
 *  • Passing the data point's `ISelectionId` as `identities` is what makes
 *    report-page (canvas) tooltips and modern-tooltip drill actions work.
 *
 * Source: learn.microsoft.com/power-bi/developer/visuals/add-tooltips
 *
 * `buildTooltip` is pure, so tooltip content is unit-tested without a host.
 */

import powerbi from "powerbi-visuals-api";
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;

import type { OverlayContent } from "./zentrixOverlayTooltip";
import { OrgNode } from "../types";
import { NodeMetrics } from "../model/analytics";
import { Note } from "../notes/notesStore";

export interface TooltipInput {
    node: OrgNode;
    /** Column caption for the measure, e.g. "Headcount". */
    measureLabel?: string;
    /** Column caption for the group role, e.g. "Department". */
    groupLabel?: string;
    /** Direct reports — always available, free. */
    directReports: number;
    /** PAID metrics; omitted at the free tier. */
    metrics?: NodeMetrics | null;
    /** PAID annotation pinned to this person. */
    note?: Note | null;
    /** Extra fields bound to the Tooltips role: caption/value pairs. */
    extra?: Array<{ displayName: string; value: string }>;
    /** Accent used for the swatch shown beside the header. */
    color?: string;
}

/**
 * Build the tooltip rows. Order is deliberate: identity first, then structure,
 * then the bound measure, then anything the author added.
 */
export function buildTooltip(input: TooltipInput): VisualTooltipDataItem[] {
    const { node } = input;
    const items: VisualTooltipDataItem[] = [];

    items.push({
        displayName: node.name,
        value: node.title || "",
        header: node.name,
        color: input.color,
    });

    if (node.group) {
        items.push({ displayName: input.groupLabel || "Group", value: node.group });
    }

    items.push({
        displayName: "Direct reports",
        value: String(input.directReports),
    });

    const m = input.metrics;
    if (m) {
        items.push({ displayName: "Total in branch", value: String(m.totalDescendants) });
        items.push({ displayName: "Layers below", value: String(m.layersBelow) });
        if (m.span === "wide") items.push({ displayName: "Span of control", value: "Wide" });
        if (m.span === "narrow") items.push({ displayName: "Span of control", value: "Narrow" });
        if (m.vacant) items.push({ displayName: "Status", value: "Vacant" });
        if (m.branchTotal !== null) {
            items.push({ displayName: `${input.measureLabel || "Measure"} (branch)`, value: String(m.branchTotal) });
        }
    }

    if (node.measureText !== null) {
        items.push({ displayName: input.measureLabel || "Measure", value: node.measureText });
    }

    if (input.extra) {
        for (const e of input.extra) {
            items.push({ displayName: e.displayName, value: e.value });
        }
    }

    if (input.note) {
        items.push({
            displayName: input.note.author ? `Note — ${input.note.author}` : "Note",
            value: input.note.text,
        });
    }

    return items;
}

/**
 * The same content, shaped for the branded Zentrix card
 * (`zentrixOverlayTooltip.ts`) rather than for Power BI's own tooltip service.
 *
 * One builder feeds both surfaces on purpose: "Zentrix card" and "Power BI" are
 * a presentation choice in Overlays › Tooltip, never a difference in what the
 * reader is told. Derived from `buildTooltip` so the two can never drift.
 */
export function overlayContent(input: TooltipInput, reportsLabel = "Direct reports"): OverlayContent {
    // Everything after the identity row, and after the direct-reports row that
    // the card promotes to its big number.
    const rows = buildTooltip(input)
        .slice(1)
        .filter((r) => r.displayName !== "Direct reports")
        .map((r) => ({ name: r.displayName, value: String(r.value ?? "") }));

    return {
        eyebrow: input.node.group || undefined,
        title: input.node.name,
        metric: {
            label: reportsLabel,
            dotColor: input.color,
            value: String(input.directReports),
        },
        rows: input.node.title
            ? [{ name: "Title", value: input.node.title, emphasis: true }, ...rows]
            : rows,
    };
}
