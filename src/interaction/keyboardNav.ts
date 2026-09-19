"use strict";

/**
 * Keyboard navigation across the tree.
 *
 * `supportsKeyboardFocus` in capabilities.json makes Power BI put the visual's
 * focusable children into the report's tab order; this module makes the arrow
 * keys move the way the picture looks, which is what a screen-reader user and a
 * keyboard-only user both expect.
 *
 * Pure index maths — no DOM — so every movement rule is unit tested.
 */

import { Hierarchy } from "../model/hierarchy";
import { Orientation } from "../types";

export type NavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

/** Visible siblings of `i`, in layout order. */
function siblingsOf(h: Hierarchy, i: number, visible: (n: number) => boolean): number[] {
    const p = h.parentIdx[i];
    const pool = p === -1 ? h.roots : h.children[p];
    return pool.filter(visible);
}

/**
 * Where an arrow key moves focus.
 *
 * In top-down mode: Up goes to the manager, Down to the first report, Left/Right
 * between siblings. In left-to-right mode the axes swap, so the movement always
 * matches what is on screen rather than the data structure.
 *
 * @returns the node index to focus, or null when the move is not possible.
 */
export function nextFocus(
    h: Hierarchy,
    current: number,
    key: NavKey,
    orientation: Orientation,
    visible: (n: number) => boolean,
): number | null {
    if (current < 0 || current >= h.parentIdx.length) return null;

    const toParent = (): number | null => {
        const p = h.parentIdx[current];
        return p >= 0 && visible(p) ? p : null;
    };
    const toChild = (): number | null => {
        const kids = h.children[current].filter(visible);
        return kids.length > 0 ? kids[0] : null;
    };
    const toSibling = (delta: number): number | null => {
        const sibs = siblingsOf(h, current, visible);
        const at = sibs.indexOf(current);
        if (at < 0) return null;
        const next = at + delta;
        return next >= 0 && next < sibs.length ? sibs[next] : null;
    };

    const horizontal = orientation === "leftRight";
    switch (key) {
        case "Home": {
            const roots = h.roots.filter(visible);
            return roots.length ? roots[0] : null;
        }
        case "End": {
            const sibs = siblingsOf(h, current, visible);
            return sibs.length ? sibs[sibs.length - 1] : null;
        }
        case "ArrowUp": return horizontal ? toSibling(-1) : toParent();
        case "ArrowDown": return horizontal ? toSibling(1) : toChild();
        case "ArrowLeft": return horizontal ? toParent() : toSibling(-1);
        case "ArrowRight": return horizontal ? toChild() : toSibling(1);
        default: return null;
    }
}

/** True when the key is one this module handles. */
export function isNavKey(key: string): key is NavKey {
    return key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft"
        || key === "ArrowRight" || key === "Home" || key === "End";
}
