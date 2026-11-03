"use strict";

/**
 * Auto disappear (OC-048, family origin HM-V2-41 in the Calendar Heatmap) — the on-canvas
 * chrome shows only while the pointer is inside the visual. What fades here:
 *  - `.zsb-anchor`    the settings gear (zentrixSettingsBar.ts, `this.anchor = div("zsb-anchor")`)
 *  - `.zx-view`       the Chart / Table / Insight switch pill (viewToggle.ts)
 *  - `.zoom-controls` the quick-action bar: zoom in / out / fit / lens / full view
 *                     (zoomPan.ts `renderZoomControls`, an SVG `g` inside the chrome layer)
 *  - `.zx-search`     the "Search people" box (search.ts `BOX_CLASS`)
 * What does NOT fade, on purpose: the legend, the status line, the pan notice, the minimap
 * (it is a picture of the chart — content, not a control), the cards and connectors, the
 * tooltip, the Zentrix wordmark, notes and the landing page. The Org Chart has no rules
 * editor panel yet; when one lands it joins this list like the Heatmap's `.zx-rules-panel`.
 *
 * This is the founder rule `gr-hover-only-chrome`, zentrix-qa QA-STANDARD §21 (issue #36).
 *
 * §21 step by step:
 *  1. pointer outside → hidden; enters → shown; leaves → hidden, no click needed.
 *  2. an open panel or menu CLOSES when the pointer leaves (`onLeave`), then hides. The
 *     gear's close commits a half-typed field first, so nothing committed is lost.
 *  5. keyboard focus inside the visual shows it (`:focus-within`, WCAG 2.1.1).
 *  6. touch: a tap on the visual shows it; a tap elsewhere in the report takes focus
 *     away from this frame (`window` blur), which hides it.
 *
 * Opacity + pointer-events only, never `display`: each overlay keeps its own show/hide
 * rules (gear on small tiles and in Reading view, pill until a hierarchy renders, search
 * box behind its own switch, action bar behind `toolbar.actions`) and the chart does not
 * re-lay out when the chrome fades. `opacity` and `pointer-events` apply to an SVG `g`
 * exactly as to an HTML element, so the action bar needs no special case.
 */

const CSS = `
.zx-autohide .zsb-anchor, .zx-autohide .zx-view, .zx-autohide .zoom-controls, .zx-autohide .zx-search {
    transition: opacity .18s ease;
}
.zx-autohide.zx-chrome-away:not(:focus-within) .zsb-anchor,
.zx-autohide.zx-chrome-away:not(:focus-within) .zx-view,
.zx-autohide.zx-chrome-away:not(:focus-within) .zoom-controls,
.zx-autohide.zx-chrome-away:not(:focus-within) .zx-search {
    opacity: 0; pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
    .zx-autohide .zsb-anchor, .zx-autohide .zx-view, .zx-autohide .zoom-controls, .zx-autohide .zx-search { transition: none; }
}`;

export class ChromeAutoHide {
    private enabled = true;
    /** Last known pointer position relative to the visual. Starts outside: on load the
     *  chrome stays away until the pointer first enters (Power BI renders us in our own
     *  iframe, so a pointer already inside fires `mousemove` on its first move). */
    private inside = false;

    /** @param onLeave closes whatever the chrome has open (settings panel, hover card)
     *  when the pointer leaves — only called while Auto disappear is on. */
    constructor(private root: HTMLElement, private onLeave: () => void) {
        const doc = root.ownerDocument;
        if (!doc.getElementById("zx-autohide-css")) {
            const style = doc.createElement("style");
            style.id = "zx-autohide-css";
            style.textContent = CSS;
            (doc.head ?? doc.documentElement).appendChild(style);
        }
        root.classList.add("zx-autohide");
        const here = () => { if (!this.inside) { this.inside = true; this.sync(); } };
        const gone = () => {
            if (!this.inside) return;
            this.inside = false;
            if (this.enabled) this.onLeave();
            this.sync();
        };
        root.addEventListener("mouseenter", here);
        root.addEventListener("mousemove", here);
        root.addEventListener("pointerdown", here);   // a tap on a touch screen
        root.addEventListener("mouseleave", gone);
        // A tap / click elsewhere in the report blurs this frame. The window outlives any
        // one visual, so its listener holds the instance only weakly — a strong closure
        // kept every discarded visual alive (the settings sweep ran out of heap).
        ChromeAutoHide.bindBlur(doc.defaultView, new WeakRef(this));
        this.pointerGone = gone;
        this.sync();
    }

    /**
     * Static on purpose (HM-V2-46): built inside the constructor, the listener shared
     * its scope with `here` / `gone`, which read `this` — so V8 kept `this` in that
     * shared context and the "weak" listener held the instance (and, through
     * `onLeave`, the whole Visual) strongly anyway.
     */
    private static bindBlur(win: Window | null, self: WeakRef<ChromeAutoHide>): void {
        const onBlur = (): void => {
            const me = self.deref();
            if (!me) { win?.removeEventListener("blur", onBlur); return; }
            me.pointerGone();
        };
        win?.addEventListener("blur", onBlur);
    }

    /** Set in the constructor; the window's blur listener reaches it through a WeakRef. */
    private pointerGone: () => void = () => { /* replaced in the constructor */ };

    /** Toolbar › Auto disappear. Off keeps the chrome on screen at all times. */
    setEnabled(on: boolean): void {
        if (on === this.enabled) return;
        this.enabled = on;
        this.sync();
    }

    /** Re-evaluate the faded state (called on every host update). */
    sync(): void {
        this.root.classList.toggle("zx-chrome-away", this.enabled && !this.inside);
    }

    /** True while the chrome is faded out (for tests and the harness). */
    isAway(): boolean { return this.root.classList.contains("zx-chrome-away"); }
}
