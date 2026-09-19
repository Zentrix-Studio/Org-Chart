"use strict";

/**
 * Insight view (OC-029) — a full-canvas, plain-English read-out of the
 * hierarchy, the third segment of the Chart / Table / Insight switch. Ported
 * from the Network Graph (NG-125 / NG-252) so the two read as one family: an
 * eyebrow, a headline sentence, then one card per finding with its big number.
 *
 * A finding about a PERSON is clickable and shows that person on the chart —
 * the read-out is a way in, not a dead end.
 *
 * Built with createElement + textContent — never innerHTML (certifiable by
 * construction).
 */

import { OrgNarrative, InsightTone, InsightAction } from "../insights/orgInsights";
import { Surface, fontFamily, accent, posSafe, negSafe } from "../theme/zentrixTokens";

const SERIF = "Georgia, 'Times New Roman', serif";

function chrome(surface: Surface, hc: boolean) {
    const light = surface.bg === "#FFFFFF";
    if (hc) return { pageBg: surface.bg, cardBg: surface.bg, border: surface.fg, shadow: "none", hover: "transparent" };
    return light
        ? { pageBg: "#F0F1F7", cardBg: "#FFFFFF", border: "#E8EAF2", shadow: "0 2px 10px rgba(11,16,32,0.06)", hover: "#F4F5FB" }
        : { pageBg: surface.bg, cardBg: "#15161E", border: "#2A2B36", shadow: "0 2px 10px rgba(0,0,0,0.45)", hover: "#1C1D28" };
}

/** Tone → colour. High contrast drops the colour cue; bold still carries importance. */
function toneColor(t: InsightTone, surface: Surface, hc: boolean): string {
    if (hc) return surface.fg;
    return t === "positive" ? posSafe : t === "negative" ? negSafe : surface.muted;
}

export interface InsightViewOptions {
    hc?: boolean;
    onAction?: (a: InsightAction) => void;
    insetTop?: number;
    insetBottom?: number;
}

/** Make an element an accessible button that fires `action`. */
function clickable(el: HTMLElement, label: string, fire: () => void, hover: string): void {
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", label);
    el.style.cursor = "pointer";
    el.style.borderRadius = "8px";
    el.style.transition = "background 120ms ease";
    el.addEventListener("click", (e) => { e.stopPropagation(); fire(); });
    el.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); fire(); }
    });
    el.addEventListener("mouseenter", () => { el.style.background = hover; });
    el.addEventListener("mouseleave", () => { el.style.background = "transparent"; });
    el.addEventListener("focus", () => { el.style.outline = `2px solid ${accent}`; el.style.outlineOffset = "1px"; });
    el.addEventListener("blur", () => { el.style.outline = "none"; });
}

export function renderInsightView(
    host: HTMLElement,
    narrative: OrgNarrative,
    surface: Surface,
    opts: InsightViewOptions = {},
): HTMLDivElement {
    const hc = Boolean(opts.hc);
    const c = chrome(surface, hc);
    const cue = hc ? surface.fg : accent;

    const wrap = document.createElement("div");
    wrap.className = "zx-insight";
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Org insight");
    const top = 22 + (opts.insetTop ?? 0), bottom = 22 + (opts.insetBottom ?? 0);
    wrap.style.cssText = `position:absolute;inset:0;overflow:auto;background:${c.pageBg};z-index:4;` +
        `color:${surface.fg};font:13px ${fontFamily};padding:${top}px 22px ${bottom}px;box-sizing:border-box`;
    wrap.addEventListener("mousedown", (ev) => ev.stopPropagation());

    const hero = document.createElement("div");
    hero.style.cssText = "max-width:860px;margin:0 auto 20px auto";
    const eyebrow = document.createElement("div");
    eyebrow.textContent = "ORG INSIGHT";
    eyebrow.style.cssText = `font:700 11px ${fontFamily};letter-spacing:1.8px;color:${cue};margin-bottom:10px`;
    const headline = document.createElement("div");
    headline.className = "zx-insight-headline";
    headline.textContent = narrative.headline;
    headline.style.cssText = `font:600 24px/1.35 ${SERIF};color:${surface.fg};letter-spacing:0.2px`;
    hero.appendChild(eyebrow);
    hero.appendChild(headline);
    if (narrative.subhead) {
        const sub = document.createElement("div");
        sub.textContent = narrative.subhead;
        sub.style.cssText = `font:400 13px ${fontFamily};color:${surface.muted};margin-top:8px;letter-spacing:0.3px`;
        hero.appendChild(sub);
    }
    wrap.appendChild(hero);

    const grid = document.createElement("div");
    grid.style.cssText = "max-width:860px;margin:0 auto;display:grid;gap:14px;" +
        "grid-template-columns:repeat(auto-fit,minmax(240px,1fr))";
    wrap.appendChild(grid);

    for (const section of narrative.sections) {
        const card = document.createElement("div");
        card.className = "zx-insight-card";
        card.setAttribute("data-section", section.id);
        card.style.cssText = `background:${c.cardBg};border:1px solid ${c.border};border-radius:12px;` +
            `box-shadow:${c.shadow};padding:16px 18px`;

        const title = document.createElement("div");
        title.textContent = section.title.toUpperCase();
        title.style.cssText = `font:700 10px ${fontFamily};letter-spacing:1.4px;color:${surface.muted};margin-bottom:12px`;
        card.appendChild(title);

        if (section.metric) {
            const m = section.metric;
            const box = document.createElement("div");
            box.className = "zx-insight-metric";
            box.style.cssText = "margin:-6px -8px 10px -8px;padding:6px 8px";
            const value = document.createElement("div");
            value.textContent = m.value;
            value.style.cssText = `font:700 34px/1.05 ${fontFamily};color:${toneColor(m.tone, surface, hc)};` +
                "letter-spacing:-0.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
            const label = document.createElement("div");
            label.textContent = m.label;
            label.style.cssText = `font:600 12px/1.35 ${fontFamily};color:${surface.fg};opacity:0.85;margin-top:4px`;
            box.appendChild(value);
            box.appendChild(label);
            if (m.sub) {
                const sub = document.createElement("div");
                sub.textContent = m.sub;
                sub.style.cssText = `font:400 11px ${fontFamily};color:${surface.muted};margin-top:3px`;
                box.appendChild(sub);
            }
            if (m.action && opts.onAction) {
                const action = m.action;
                const hint = document.createElement("div");
                hint.textContent = "Show on the chart ›";
                hint.style.cssText = `font:600 11px ${fontFamily};color:${cue};margin-top:7px`;
                box.appendChild(hint);
                clickable(box, `${m.value} ${m.label}. Show on the chart.`, () => opts.onAction!(action), c.hover);
            }
            card.appendChild(box);
        }

        for (const line of section.lines) {
            const row = document.createElement("div");
            row.className = "zx-insight-line";
            row.style.cssText = "display:flex;align-items:flex-start;gap:10px;margin:0 -6px 5px -6px;padding:2px 6px";
            const dot = document.createElement("span");
            dot.setAttribute("aria-hidden", "true");
            dot.style.cssText = "flex:0 0 auto;width:8px;height:8px;border-radius:50%;margin-top:6px;" +
                `background:${toneColor(line.tone, surface, hc)}`;
            const text = document.createElement("div");
            text.textContent = line.text;
            text.style.cssText = `font:${line.strong ? "600 " : ""}14px/1.5 ${fontFamily};color:${surface.fg}` +
                (line.strong ? "" : ";opacity:0.9");
            row.appendChild(dot);
            row.appendChild(text);
            if (line.action && opts.onAction) {
                const action = line.action;
                const arrow = document.createElement("span");
                arrow.textContent = "›";
                arrow.setAttribute("aria-hidden", "true");
                arrow.style.cssText = `margin-left:auto;padding-left:6px;font:600 14px/1.5 ${fontFamily};color:${cue}`;
                row.appendChild(arrow);
                clickable(row, `${line.text} Show on the chart.`, () => opts.onAction!(action), c.hover);
            }
            card.appendChild(row);
        }
        grid.appendChild(card);
    }

    host.appendChild(wrap);
    return wrap;
}
