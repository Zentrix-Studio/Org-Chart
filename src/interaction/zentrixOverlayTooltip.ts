"use strict";

/**
 * Zentrix Overlay Tooltip — the canonical branded in-visual tooltip chrome.
 *
 * GOLDEN SOURCE (@zentrix/overlay-tooltip). A framework-agnostic vanilla
 * DOM/TS primitive — NO React, NO d3, NO powerbi-visuals-api imports — so it
 * drops into any Power BI custom visual's cert sandbox. Each visual vendors a
 * byte-faithful MIRROR of this file (verified by sync-shared.mjs --check) and
 * supplies the row content via the OverlayContent model; the primitive owns the
 * card (surface, shadow, font, big-number slot, delta badge, color dot, brand
 * wordmark, smart edge-flip positioning).
 *
 * Z-151a: extracted from the heatmap's HeatmapTooltip + branding/zentrixBrand.ts.
 * The host supplies every color via OverlayTheme (token-sourced), so the package
 * contains ZERO raw hex except the one neutral shadow-overlay alpha.
 *
 * Native vs branded: the "report-page tooltip → host ITooltipService, branded
 * overlay otherwise" switch lives in the per-visual binder, NOT here. This
 * primitive is mode-agnostic; it only knows how to draw a card.
 */

/** Marker attribute stamped on the injected brand node so it is findable and
 *  never collides with the host's DOM. */
export const BRAND_ATTR = "data-zentrix-brand";

const WORDMARK = "Zentrix";
/** Neutral elevation overlay — not a brand hex (a black shadow at low alpha). */
const SHADOW = "0 4px 16px rgba(0,0,0,.18)";

/** Theme + brand context, refreshed per render (token-sourced — host passes resolved colors). */
export interface OverlayTheme {
    dark: boolean;
    bg: string; fg: string; muted: string; strong: string;   // resolved surface tokens
    accent: string;                                            // brand violet (token)
    pos: string; neg: string;                                  // CVD-safe Okabe–Ito good/bad (tokens)
    fontFamily: string;                                        // token font stack
    radius?: number;                                           // card corner radius (token; default 10)
}

/** One render's content. The host builds this; the primitive owns how it looks. */
export interface OverlayContent {
    eyebrow?: string;                 // small uppercase line (e.g. date label / category)
    title?: string;                   // bold strong line (e.g. facet / category name)
    notes?: { icon?: string; text: string }[];   // 📌 annotation-style rows
    metric?: {                        // the "big number" block (heatmap layout)
        label: string;                  // metric name (with color dot)
        dotColor?: string;              // color dot beside the label (defaults to accent)
        value: string;                  // pre-formatted big value
        delta?: { up: boolean; pct: string; detail?: string };  // ▲/▼ badge + "+26 vs Mon"
    };
    rows?: { name: string; value: string; tone?: "pos" | "neg" | "neutral"; emphasis?: boolean }[];
                                      // compact name/value rows (bullet layout)
    noData?: boolean;                 // renders the muted "No data" state
}

export interface OverlayOptions {
    theme: OverlayTheme;
    branding?: boolean;               // ZENTRIX-BRAND — default true (free tier)
    minWidth?: number;                // default 150
}

/* ───────────────────────── DOM helpers ───────────────────────── */

function div(style: string, text?: string): HTMLDivElement {
    const d = document.createElement("div");
    if (style) d.style.cssText = style;
    if (text != null) d.textContent = text;
    return d;
}
function span(style: string, text: string): HTMLSpanElement {
    const s = document.createElement("span");
    if (style) s.style.cssText = style;
    s.textContent = text;
    return s;
}
function clear(el: HTMLElement): void { while (el.firstChild) el.removeChild(el.firstChild); }

/* ═════════════════════════ the component ═════════════════════════ */

export class ZentrixOverlayTooltip {
    private el: HTMLDivElement;
    private theme: OverlayTheme;
    private brandingOn: boolean;
    private minWidth: number;

    constructor(root: HTMLElement, opts: OverlayOptions) {
        this.theme = opts.theme;
        this.brandingOn = opts.branding ?? true;
        this.minWidth = opts.minWidth ?? 150;
        this.el = document.createElement("div");
        this.el.style.cssText =
            "position:fixed;pointer-events:none;z-index:1000;display:none;" +
            `min-width:${this.minWidth}px;padding:10px 12px;` +
            `box-shadow:${SHADOW};`;
        root.appendChild(this.el);
    }

    /** Per-render theme refresh (light/dark, brand colors). Applied on the next show(). */
    setTheme(theme: OverlayTheme): void { this.theme = theme; }

    /** ZENTRIX-BRAND — host toggles the subtle wordmark on/off. */
    setBranding(on: boolean): void { this.brandingOn = on; }

    show(content: OverlayContent, clientX: number, clientY: number): void {
        const t = this.theme;
        const radius = t.radius ?? 10;
        this.el.style.background = t.bg;
        this.el.style.color = t.fg;
        this.el.style.fontFamily = t.fontFamily;
        this.el.style.borderRadius = `${radius}px`;
        clear(this.el);

        if (content.eyebrow) {
            this.el.appendChild(div(`font-size:10px;letter-spacing:.5px;color:${t.muted}`, content.eyebrow));
        }
        if (content.title) {
            this.el.appendChild(div(`margin-top:2px;font-size:11px;font-weight:600;color:${t.strong}`, content.title));
        }
        for (const note of content.notes ?? []) {
            const row = div(`margin-top:5px;font-size:12px;font-weight:600;color:${t.strong};display:flex;align-items:flex-start`);
            if (note.icon) row.appendChild(span("margin-right:5px", note.icon));
            row.appendChild(span("", note.text));
            this.el.appendChild(row);
        }

        if (content.noData) {
            this.el.appendChild(div(`margin-top:6px;font-size:13px;color:${t.muted}`, "No data"));
        } else {
            if (content.metric) this.renderMetric(content.metric);
            for (const r of content.rows ?? []) this.renderRow(r);
        }

        if (this.brandingOn) this.appendBrand();

        this.el.style.display = "block";
        this.move(clientX, clientY);
    }

    private renderMetric(metric: NonNullable<OverlayContent["metric"]>): void {
        const t = this.theme;
        const dot = metric.dotColor || t.accent;
        const label = div("margin-top:6px;font-size:12px;display:flex;align-items:center");
        label.appendChild(span(`width:9px;height:9px;border-radius:2px;background:${dot};` +
            "display:inline-block;margin-right:6px;border:1px solid rgba(0,0,0,.12)", ""));
        label.appendChild(span("", metric.label));
        this.el.appendChild(label);

        const valueRow = div("margin-top:2px;font-size:24px;font-weight:700;line-height:1.1");
        valueRow.appendChild(span("", metric.value));
        if (metric.delta) {
            valueRow.appendChild(span(
                `margin-left:8px;font-size:12px;font-weight:600;color:${metric.delta.up ? t.pos : t.neg}`,
                `${metric.delta.up ? "▲" : "▼"} ${metric.delta.pct}`));
            this.el.appendChild(valueRow);
            if (metric.delta.detail) {
                this.el.appendChild(div(`margin-top:4px;font-size:11px;color:${t.muted}`, metric.delta.detail));
            }
        } else {
            this.el.appendChild(valueRow);
        }
    }

    private renderRow(r: NonNullable<OverlayContent["rows"]>[number]): void {
        const t = this.theme;
        const row = div(`margin-top:3px;font-size:11px;color:${t.muted}`, `${r.name}: `);
        const valColor = r.tone === "pos" ? t.pos : r.tone === "neg" ? t.neg : t.strong;
        const weight = r.emphasis || r.tone === "pos" || r.tone === "neg" ? ";font-weight:600" : "";
        row.appendChild(span(`color:${valColor}${weight}`, r.value));
        this.el.appendChild(row);
    }

    /**
     * ZENTRIX-BRAND — subtle wordmark, appended last so it sits bottom-right.
     * Idempotent (removes any prior brand node first). Muted neutral from the
     * theme; 10px, regular weight, .55 opacity, no border/bg, pointer-events:none.
     */
    private appendBrand(): void {
        const prev = this.el.querySelector(`[${BRAND_ATTR}="tooltip"]`);
        if (prev) prev.remove();
        const brand = div(
            "margin-top:8px;text-align:right;font-size:10px;font-weight:400;letter-spacing:.2px;" +
            `line-height:1;color:${this.theme.muted};opacity:.55;pointer-events:none;user-select:none;`,
            WORDMARK);
        brand.setAttribute(BRAND_ATTR, "tooltip");
        this.el.appendChild(brand);
    }

    /** Smart edge-flip: flip to the opposite side of the cursor near the viewport
     *  edge; clamp to >= 2px. */
    move(clientX: number, clientY: number): void {
        const pad = 14;
        const r = this.el.getBoundingClientRect();
        let left = clientX + pad, top = clientY + pad;
        if (left + r.width > window.innerWidth) left = clientX - r.width - pad;
        if (top + r.height > window.innerHeight) top = clientY - r.height - pad;
        this.el.style.left = Math.max(2, left) + "px";
        this.el.style.top = Math.max(2, top) + "px";
    }

    hide(): void { this.el.style.display = "none"; }

    destroy(): void { this.el.remove(); }
}
