"use strict";

/**
 * The view switch (OC-029) — a segmented pill, [Chart | Table | Insight], that
 * flips the canvas between the org chart, the people table and the plain-English
 * read-out. The family control (Network Graph NG-113 / NG-125), rebuilt for this
 * visual: the first segment is the chart, drawn as a tiny tree.
 *
 * Session-local, never persisted: it has to work for someone READING the report,
 * where a persistProperties write would not survive.
 *
 * Table and Insight are gated individually (`summaryTable.show` /
 * `insights.show`); a disabled segment leaves the pill and the cycle, and with
 * only Chart left the visual hides the pill altogether.
 *
 * Built with createElement/createElementNS + textContent — never innerHTML.
 */

import { Surface, fontFamily, accent } from "../theme/zentrixTokens";

export type ViewKind = "chart" | "table" | "insight";

const ORDER: ViewKind[] = ["chart", "table", "insight"];
const LABELS: Record<ViewKind, string> = { chart: "Chart", table: "Table", insight: "Insight" };
const SVG_NS = "http://www.w3.org/2000/svg";

/** Pill height — the same 36px as the collapsed gear, so the two line up. */
export const PILL_HEIGHT = 36;

function segIcon(kind: ViewKind): SVGSVGElement {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("width", "14");
    s.setAttribute("height", "14");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    const path = (d: string): void => {
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        s.appendChild(p);
    };
    if (kind === "chart") {
        // A tiny org chart: one box on top, an elbow down to two below.
        path("M9 3h6v5H9z"); path("M3 16h6v5H3z"); path("M15 16h6v5h-6z");
        path("M12 8v4"); path("M6 16v-4h12v4");
    } else if (kind === "table") {
        path("M4 5h16v14H4z"); path("M4 10h16"); path("M11 10v9");
    } else {
        // A lightbulb — the family's "insight" glyph.
        path("M9 18h6"); path("M10 21h4");
        path("M12 3a6 6 0 0 0-3.7 10.7c.5.4.7.9.7 1.5v.3h6v-.3c0-.6.2-1.1.7-1.5A6 6 0 0 0 12 3z");
    }
    return s;
}

export class ViewToggle {
    private root: HTMLDivElement;
    private segs: Record<ViewKind, HTMLButtonElement>;
    private labels: Record<ViewKind, HTMLSpanElement>;
    private kind: ViewKind = "chart";
    private surface: Surface | null = null;
    private enabled: Record<ViewKind, boolean> = { chart: true, table: true, insight: true };
    private compact = false;

    constructor(host: HTMLElement, private onToggle: (next: ViewKind) => void) {
        this.root = document.createElement("div");
        this.root.className = "zx-view";
        this.root.setAttribute("role", "group");
        this.root.setAttribute("aria-label", "Canvas view");
        const s = this.root.style;
        s.position = "absolute";
        s.zIndex = "16";
        s.display = "none";
        s.alignItems = "center";
        s.gap = "2px";
        s.height = `${PILL_HEIGHT}px`;
        s.padding = "3px";
        s.borderRadius = "999px";
        s.boxSizing = "border-box";
        s.font = `600 12px ${fontFamily}`;
        // A press on the pill must not reach the chart's zoom (it would start a drag).
        this.root.addEventListener("mousedown", (e) => e.stopPropagation());
        this.labels = {} as Record<ViewKind, HTMLSpanElement>;
        this.segs = {
            chart: this.makeSeg("chart"),
            table: this.makeSeg("table"),
            insight: this.makeSeg("insight"),
        };
        host.appendChild(this.root);
        this.reflect();
    }

    private makeSeg(kind: ViewKind): HTMLButtonElement {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "zx-view-seg";
        b.setAttribute("data-kind", kind);
        b.setAttribute("aria-label", `Switch to ${LABELS[kind].toLowerCase()} view`);
        b.title = LABELS[kind];
        const s = b.style;
        s.display = "flex";
        s.alignItems = "center";
        s.gap = "6px";
        s.height = "30px";
        s.padding = "0 12px";
        s.border = "none";
        s.borderRadius = "999px";
        s.background = "transparent";
        s.cursor = "pointer";
        s.font = "inherit";
        b.appendChild(segIcon(kind));
        const t = document.createElement("span");
        t.textContent = LABELS[kind];
        b.appendChild(t);
        this.labels[kind] = t;
        b.onclick = (e) => { e.stopPropagation(); this.select(kind); };
        // Arrow keys move between segments, the way a segmented control should.
        b.onkeydown = (e: KeyboardEvent) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            e.stopPropagation();
            const c = this.cycle();
            const i = c.indexOf(kind);
            const next = c[(i + (e.key === "ArrowRight" ? 1 : c.length - 1)) % c.length];
            this.segs[next].focus();
            this.select(next);
        };
        this.root.appendChild(b);
        return b;
    }

    private cycle(): ViewKind[] { return ORDER.filter((k) => this.enabled[k]); }

    /** Declare which non-chart segments exist. The active one falling away returns to Chart. */
    setSegments(opts: { table: boolean; insight: boolean }): void {
        this.enabled = { chart: true, table: opts.table, insight: opts.insight };
        this.segs.table.style.display = opts.table ? "flex" : "none";
        this.segs.insight.style.display = opts.insight ? "flex" : "none";
        if (!this.enabled[this.kind]) this.kind = "chart";
        this.reflect();
    }

    hasAlternateView(): boolean { return this.enabled.table || this.enabled.insight; }

    private select(kind: ViewKind): void {
        if (!this.enabled[kind] || kind === this.kind) return;
        this.kind = kind;
        this.reflect();
        this.onToggle(kind);
    }

    /** Icons only, for a narrow visual. The label stays as the tooltip and aria-label. */
    setCompact(compact: boolean): void {
        this.compact = compact;
        for (const k of ORDER) {
            this.labels[k].style.display = compact ? "none" : "";
            this.segs[k].style.padding = compact ? "0 9px" : "0 12px";
        }
    }

    setTheme(surface: Surface, hc: boolean): void {
        this.surface = surface;
        const dark = surface.bg !== "#FFFFFF";
        this.root.style.background = surface.bg;
        this.root.style.border = hc ? `1px solid ${surface.fg}` : `1px solid ${surface.cardStroke}`;
        this.root.style.boxShadow = hc ? "none" : (dark ? "0 4px 14px rgba(0,0,0,0.45)" : "0 4px 14px rgba(11,16,32,0.12)");
        this.reflect();
    }

    private reflect(): void {
        for (const kind of ORDER) {
            const seg = this.segs[kind];
            const active = kind === this.kind;
            seg.setAttribute("aria-pressed", active ? "true" : "false");
            const fill = this.surface?.selected ?? accent;
            seg.style.background = active ? fill : "transparent";
            // Active text sits on the accent (or the HC "selected" role), so it takes the
            // surface's own background colour — white on the light theme.
            seg.style.color = active ? (this.surface?.bg ?? "#FFFFFF") : (this.surface?.fg ?? "#15161E");
        }
    }

    current(): ViewKind { return this.kind; }

    /** Force a view without firing onToggle. */
    set(kind: ViewKind): void { this.kind = this.enabled[kind] ? kind : "chart"; this.reflect(); }

    /** Pin to a box computed by the visual, in the visual's own pixels. */
    placeAt(x: number, y: number): void {
        const s = this.root.style;
        s.right = s.bottom = "";
        s.left = `${Math.round(x)}px`;
        s.top = `${Math.round(y)}px`;
    }

    /** Rendered width, or an estimate where nothing is laid out (jsdom, a hidden pill). */
    width(): number {
        const w = this.root.getBoundingClientRect ? this.root.getBoundingClientRect().width : 0;
        if (w > 0) return w;
        const n = this.cycle().length;
        return 8 + n * (this.compact ? 34 : 82);
    }

    show(): void { this.root.style.display = "flex"; }
    hide(): void { this.root.style.display = "none"; }
    isShown(): boolean { return this.root.style.display !== "none"; }
    element(): HTMLDivElement { return this.root; }
}
