"use strict";

/**
 * Search and jump — free-tier, and the second of the two features that block
 * publication.
 *
 * On a hierarchy too large to fit at a readable scale (which, given the fit
 * floor, is most real orgs) the only way to reach a person is to pan around
 * hunting for them. This finds them and takes you there.
 *
 * The matching is pure and lives in `matchNodes`; the box is a small HTML
 * overlay, because a real `<input>` is the only honest way to accept typing —
 * IME, selection, screen readers and the browser's own find-as-you-type all
 * come free. No `innerHTML` anywhere: every node is built with `createElement`,
 * which the certification review requires.
 */

export interface SearchableNode {
    key: string;
    name: string;
    title: string;
}

/**
 * Case- and accent-insensitive substring match over name, title and key.
 *
 * Accent folding matters here: an org with "Delacroix" and "Delacroïx" in it
 * should answer to either spelling, and a French or Turkish user typing without
 * diacritics should still find their colleagues. `NFD` + combining-mark strip is
 * the standard way and needs no table.
 */
export function fold(s: string): string {
    return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Indices of every node matching `query`, in tree order. Empty query = none. */
export function matchNodes(nodes: readonly SearchableNode[], query: string): number[] {
    const q = fold(query).trim();
    if (!q) return [];
    const out: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (fold(n.name).includes(q) || fold(n.title).includes(q) || fold(n.key).includes(q)) {
            out.push(i);
        }
    }
    return out;
}

/** Step through matches, wrapping at both ends. */
export function nextMatch(matches: readonly number[], current: number, step: number): number {
    if (matches.length === 0) return -1;
    const at = matches.indexOf(current);
    if (at < 0) return matches[step >= 0 ? 0 : matches.length - 1];
    const n = (at + step + matches.length) % matches.length;
    return matches[n];
}

export interface SearchOptions {
    placeholder: string;
    /** `(shown, total)` — e.g. "2 of 7". */
    countLabel: (at: number, total: number) => string;
    noMatchLabel: string;
    nextLabel: string;
    /** Called with the node index to centre, or -1 to clear the emphasis. */
    onJump: (index: number) => void;
    /** Called with every matching index whenever the query changes. */
    onMatches: (indices: number[]) => void;
    dark: boolean;
    fg: string;
    bg: string;
    stroke: string;
    accent: string;
    fontFamily: string;
}

/**
 * Below this the box cannot hold a usable field, so it stands down — the same
 * contract the gear and the zoom controls already follow. Without it the box
 * was the only piece of chrome that would hang outside the visual on a narrow
 * canvas (measured: 103px past the edge at 120px wide).
 */
export const SEARCH_MIN_WIDTH = 240;

export interface SearchHandle {
    /** Re-point at a new model; keeps the typed query and re-runs it. */
    setNodes(nodes: readonly SearchableNode[]): void;
    setVisible(on: boolean): void;
    /** Tell the box how much room the canvas has. */
    setViewport(width: number): void;
    /** Left edge in px — moves right when the gear shares the top-left corner. */
    setLeft(px: number): void;
    setTheme(o: Pick<SearchOptions, "fg" | "bg" | "stroke" | "accent">): void;
    /** Current query, so a re-render can re-apply the emphasis. */
    matches(): number[];
    destroy(): void;
}

const BOX_CLASS = "zx-search";

export function createSearchBox(host: HTMLElement, o: SearchOptions): SearchHandle {
    let nodes: readonly SearchableNode[] = [];
    let found: number[] = [];
    let cursor = -1;
    /** What the setting asks for, and whether the canvas can honour it. */
    let wanted = true;
    let roomy = true;

    const wrap = document.createElement("div");
    wrap.className = BOX_CLASS;
    wrap.setAttribute("role", "search");
    Object.assign(wrap.style, {
        position: "absolute", left: "10px", top: "8px", zIndex: "5",
        display: "flex", alignItems: "center", gap: "6px",
        padding: "3px 6px", borderRadius: "6px",
        border: `1px solid ${o.stroke}`, background: o.bg,
        font: `11px ${o.fontFamily}`, boxShadow: "0 1px 4px rgba(0,0,0,.08)",
    } as Partial<CSSStyleDeclaration>);

    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = o.placeholder;
    input.setAttribute("aria-label", o.placeholder);
    Object.assign(input.style, {
        border: "none", outline: "none", background: "transparent",
        color: o.fg, font: "inherit", width: "132px", padding: "1px 0",
    } as Partial<CSSStyleDeclaration>);

    const count = document.createElement("span");
    count.setAttribute("aria-live", "polite");
    Object.assign(count.style, { color: o.fg, opacity: "0.7", minWidth: "44px" } as Partial<CSSStyleDeclaration>);

    const next = document.createElement("button");
    next.type = "button";
    next.title = o.nextLabel;
    next.setAttribute("aria-label", o.nextLabel);
    next.textContent = "›";
    Object.assign(next.style, {
        border: "none", background: "transparent", color: o.accent,
        cursor: "pointer", font: "inherit", fontSize: "14px", lineHeight: "1",
        padding: "0 2px",
    } as Partial<CSSStyleDeclaration>);

    wrap.appendChild(input);
    wrap.appendChild(count);
    wrap.appendChild(next);
    host.appendChild(wrap);

    function paintCount(): void {
        if (!input.value.trim()) { count.textContent = ""; return; }
        count.textContent = found.length === 0
            ? o.noMatchLabel
            : o.countLabel(found.indexOf(cursor) + 1, found.length);
    }

    function run(jump: boolean): void {
        found = matchNodes(nodes, input.value);
        cursor = found.length ? (found.includes(cursor) ? cursor : found[0]) : -1;
        o.onMatches(found.slice());
        paintCount();
        if (jump && cursor >= 0) o.onJump(cursor);
    }

    function step(dir: number): void {
        if (found.length === 0) return;
        cursor = nextMatch(found, cursor, dir);
        paintCount();
        o.onJump(cursor);
    }

    input.addEventListener("input", () => run(false));
    input.addEventListener("keydown", (e: KeyboardEvent) => {
        // The chart owns +/-/0 and the arrows; while the box has focus the user
        // is typing, so nothing may reach them from here.
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
        if (e.key === "Escape") {
            e.preventDefault();
            input.value = "";
            found = []; cursor = -1;
            o.onMatches([]); o.onJump(-1); paintCount();
        }
    });
    // A click in the box must not clear the report's cross-filter selection.
    wrap.addEventListener("mousedown", (e: MouseEvent) => e.stopPropagation());
    wrap.addEventListener("click", (e: MouseEvent) => e.stopPropagation());
    next.addEventListener("click", (e: MouseEvent) => { e.stopPropagation(); step(1); });

    /**
     * Hiding the box must take its state with it, however it was hidden — by the
     * setting or by the canvas. Leaving the query running would strand an
     * outline on the chart with no control left to clear it.
     */
    function applyVisible(): void {
        const on = wanted && roomy;
        wrap.style.display = on ? "flex" : "none";
        if (!on && (input.value || found.length)) {
            input.value = "";
            found = []; cursor = -1;
            paintCount();
            o.onMatches([]);
            o.onJump(-1);
        }
    }

    return {
        setNodes(n) { nodes = n; if (input.value.trim()) run(false); },
        setVisible(on) { wanted = on; applyVisible(); },
        setViewport(width) {
            roomy = width >= SEARCH_MIN_WIDTH;
            // Never wider than the canvas: the count and the next button need
            // about 110px beside the field.
            input.style.width = `${Math.max(60, Math.min(132, width - 110))}px`;
            applyVisible();
        },
        setLeft(px) { wrap.style.left = `${Math.max(0, px)}px`; },
        setTheme(t) {
            wrap.style.background = t.bg;
            wrap.style.borderColor = t.stroke;
            input.style.color = t.fg;
            count.style.color = t.fg;
            next.style.color = t.accent;
        },
        matches() { return found.slice(); },
        destroy() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); },
    };
}
