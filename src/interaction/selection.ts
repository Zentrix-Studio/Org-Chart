"use strict";

/**
 * Cross-filtering, context menu, bookmarks and selection emphasis.
 *
 * Clicking a card selects that person and filters every other visual on the
 * page — the behaviour that makes this a Power BI visual rather than a picture.
 * The collapse toggle stops propagation, so expanding a branch never filters.
 *
 * Three platform behaviours are honoured here:
 *  • `allowInteractions` — false on non-interactive surfaces such as dashboard
 *    tiles. Click, context menu and keyboard activation must all no-op there.
 *    (Tooltips deliberately stay on: Microsoft's documented best practice.)
 *  • BOOKMARKS — `registerOnSelectCallback` fires when Power BI restores a saved
 *    selection, and the visual must repaint to match.
 *  • HIGHLIGHT — when another visual cross-filters us, the host marks rows as
 *    highlighted; unhighlighted cards dim instead of disappearing.
 *
 * Sources: learn.microsoft.com/power-bi/developer/visuals/visuals-interactions
 *          learn.microsoft.com/power-bi/developer/visuals/bookmarks-support
 */

import powerbi from "powerbi-visuals-api";
import { Selection, select } from "d3";
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;

import { OrgNode } from "../types";

type CardSel = Selection<SVGGElement, number, SVGGElement, unknown>;

/** Opacity applied to cards outside the current selection.
 *  High contrast uses 0.4 per Microsoft's guidance — see theme/palette.ts. */
export const DIM_OPACITY = 0.35;

/**
 * Bind click-to-filter and right-click-to-context-menu on every card.
 *
 * @param onChange called after the selection changes so the caller can repaint.
 */
export function bindSelection(
    cards: CardSel,
    nodes: OrgNode[],
    selectionManager: ISelectionManager,
    onChange: () => void,
    allowInteractions = true,
): void {
    cards.on("click", (event: MouseEvent, i: number) => {
        if (!allowInteractions) return;
        const id = nodes[i].selectionId;
        if (!id) return;
        event.stopPropagation();
        // Ctrl / Cmd / Shift extends the selection, matching Power BI's convention.
        const multi = event.ctrlKey || event.metaKey || event.shiftKey;
        const p = selectionManager.select(id, multi) as unknown as Promise<unknown>;
        if (p && typeof (p as Promise<unknown>).then === "function") {
            (p as Promise<unknown>).then(onChange).catch(() => onChange());
        } else {
            onChange();
        }
    });

    cards.on("contextmenu", (event: MouseEvent, i: number) => {
        event.preventDefault();
        event.stopPropagation();
        if (!allowInteractions) return;
        const id = nodes[i].selectionId;
        // The host's menu carries Drill down / Drill up when a drillable role is
        // bound, which is how drill-down reaches the user for this visual.
        selectionManager.showContextMenu(id ?? {}, { x: event.clientX, y: event.clientY });
    });

    // Keyboard parity: Enter / Space select the focused card.
    cards.on("keydown", (event: KeyboardEvent, i: number) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (!allowInteractions) return;
        const id = nodes[i].selectionId;
        if (!id) return;
        event.preventDefault();
        const p = selectionManager.select(id, false) as unknown as Promise<unknown>;
        if (p && typeof (p as Promise<unknown>).then === "function") {
            (p as Promise<unknown>).then(onChange).catch(() => onChange());
        } else {
            onChange();
        }
    });
}

/** Dim everything outside the current selection; restore when nothing is selected. */
export function applySelectionDim(
    cards: CardSel,
    nodes: OrgNode[],
    selected: ISelectionId[],
    dimOpacity: number = DIM_OPACITY,
): void {
    if (!selected || selected.length === 0) {
        cards.attr("opacity", 1);
        return;
    }
    cards.attr("opacity", (i: number) => (isSelected(nodes[i].selectionId, selected) ? 1 : dimOpacity));
}

/** True when `id` is in the current selection. Uses the host's own comparer. */
export function isSelected(id: ISelectionId | null, selected: ISelectionId[]): boolean {
    if (!id) return false;
    for (const s of selected) {
        const cmp = s as unknown as { equals?: (o: unknown) => boolean };
        if (typeof cmp.equals === "function" ? cmp.equals(id) : s === id) return true;
    }
    return false;
}

/**
 * Register for bookmark restores. Power BI calls back with the selection saved
 * in the bookmark; the visual repaints so its highlighted cards match.
 * Safe on hosts that predate the callback.
 */
export function bindBookmarks(
    selectionManager: ISelectionManager,
    onRestore: (ids: ISelectionId[]) => void,
): void {
    const mgr = selectionManager as unknown as {
        registerOnSelectCallback?: (cb: (ids: ISelectionId[]) => void) => void;
    };
    if (typeof mgr.registerOnSelectCallback !== "function") return;
    try {
        mgr.registerOnSelectCallback((ids: ISelectionId[]) => onRestore(ids || []));
    } catch {
        // An older host without the callback must not break construction.
    }
}

/**
 * Dim cards the host has NOT highlighted. Highlighting happens when another
 * visual cross-filters this one; unlike a filter, every card stays on screen.
 *
 * Selection emphasis wins when both are active, because the user's own click is
 * the more recent intent.
 */
export function applyHighlightDim(
    cards: CardSel,
    nodes: OrgNode[],
    anyHighlight: boolean,
    dimOpacity: number,
): void {
    if (!anyHighlight) {
        cards.attr("opacity", 1);
        return;
    }
    cards.attr("opacity", (i: number) => (nodes[i].highlighted ? 1 : dimOpacity));
}

/** Clear the selection when the empty canvas is clicked. */
export function bindCanvasClear(
    svg: Selection<SVGSVGElement, unknown, null, undefined>,
    selectionManager: ISelectionManager,
    onChange: () => void,
    allowInteractions = true,
): void {
    svg.on("click", () => {
        if (!allowInteractions) return;
        const p = selectionManager.clear() as unknown as Promise<unknown>;
        if (p && typeof (p as Promise<unknown>).then === "function") {
            (p as Promise<unknown>).then(onChange).catch(() => onChange());
        } else {
            onChange();
        }
    });
    svg.on("contextmenu", (event: MouseEvent) => {
        event.preventDefault();
        if (!allowInteractions) return;
        selectionManager.showContextMenu({}, { x: event.clientX, y: event.clientY });
    });
    void select;
}
