"use strict";

/**
 * Zoom, pan and fit — free tier, and table stakes.
 *
 * Why this exists: the first render fitted the whole tree into the viewport and
 * nothing else. A 169-person org lays out ~24,500px wide, so fitting it into a
 * 1,140px visual scaled everything to 0.045 — a 7.6 × 2.6px card with 0.6px
 * text. The chart got *smaller* with every person added and there was no way
 * back in. Fit alone is not a viewing model.
 *
 * So: the wheel zooms, dragging pans, three on-screen buttons and the +/-/0 keys
 * do the same for keyboard and touch users, and the initial fit is floored at a
 * scale that still shows card shapes rather than a hairline.
 *
 * d3-zoom owns the transform. The visual no longer writes `transform` on the
 * viewport group directly — it asks for a fit and d3 applies it, so a
 * programmatic fit and a user gesture cannot disagree about the current view.
 */

import { Selection, zoom as d3Zoom, zoomIdentity, ZoomBehavior } from "d3";

type SvgSel = Selection<SVGSVGElement, unknown, null, undefined>;
type GSel = Selection<SVGGElement, unknown, null, undefined>;

/** How far out a user may zoom by hand — far enough to see any org whole. */
export const MIN_SCALE = 0.02;
/** How far in. 4× a 168px card is plenty for reading a photo. */
export const MAX_SCALE = 4;
/** One button press / key press. */
export const ZOOM_STEP = 1.35;

/**
 * The floor under the INITIAL fit. Below this a card stops reading as a card,
 * and an unreadable overview is worse than a readable corner you can pan.
 * User gestures are not floored by it — `MIN_SCALE` is the real limit.
 */
export const MIN_FIT_SCALE = 0.5;

/**
 * The ceiling under `Card sizing: Auto`. A small hierarchy grows to use the
 * visual rather than sitting as postage stamps in the middle of it — cards and
 * type together. Past about 1.75 a card stops looking like a card and starts
 * looking like a poster, so this is where it stops.
 */
export const MAX_AUTO_SCALE = 1.75;

export interface ViewTransform {
    k: number;
    tx: number;
    ty: number;
}

export interface ZoomPanHandle {
    /**
     * Tell the behaviour how big the visual is.
     *
     * Not optional: d3-zoom's default extent reads `svg.width.baseVal`, which is
     * the host's layout size rather than the viewport Power BI reports, and does
     * not exist at all outside a full SVG implementation. Setting it explicitly
     * is what makes wheel-zoom centre on the pointer correctly.
     */
    setViewport(vp: { width: number; height: number }): void;
    /** Apply a transform (what `fitTransform` returns). */
    apply(t: ViewTransform): void;
    /** The live transform. */
    current(): ViewTransform;
    /** Multiply the scale about the viewport centre. */
    zoomBy(factor: number, viewport: { width: number; height: number }): void;
    /** True once a gesture or a button has moved the view away from the last fit. */
    touched(): boolean;
    /** Forget that, so the next model change re-fits. */
    clearTouched(): void;
    /**
     * Declare the view deliberately moved without a gesture — what a
     * search jump is. `apply` alone is "programmatic" and leaves the view
     * re-fittable, which would snap the user straight back off the person
     * they just searched for on the very next update.
     */
    markTouched(): void;
    /** Dashboard tiles and other non-interactive surfaces get no gestures. */
    setEnabled(on: boolean): void;
}

/**
 * Wire zoom and pan onto the svg, driving `viewport`'s transform.
 *
 * @param onChange       fired after every transform change, gesture or programmatic.
 * @param onGestureStart fired when the USER starts a gesture. d3-zoom stops the
 *                       mousedown immediately, so floating chrome that dismisses
 *                       on click-away (the gear, the hover card) never hears it —
 *                       this is how the visual gets told.
 */
export function createZoomPan(
    svg: SvgSel,
    viewport: GSel,
    onChange?: (t: ViewTransform) => void,
    onGestureStart?: () => void,
): ZoomPanHandle {
    // True only while WE are setting the transform. Everything else that
    // reaches the zoom handler is the user's hand — a wheel, a drag, a touch.
    let programmatic = false;
    let userMoved = false;
    let enabled = true;

    const behavior: ZoomBehavior<SVGSVGElement, unknown> = d3Zoom<SVGSVGElement, unknown>()
        .scaleExtent([MIN_SCALE, MAX_SCALE])
        .filter((event: Event) => {
            if (!enabled) return false;
            // Right-click belongs to the context menu, not to panning.
            const me = event as MouseEvent;
            if (me.type === "mousedown" && me.button !== 0) return false;
            return !me.ctrlKey || me.type === "wheel";
        })
        .on("start", () => { if (!programmatic && onGestureStart) onGestureStart(); })
        .on("zoom", (event: { transform: { k: number; x: number; y: number } }) => {
            const t = event.transform;
            viewport.attr("transform", `translate(${t.x},${t.y}) scale(${t.k})`);
            if (!programmatic) userMoved = true;
            if (onChange) onChange({ k: t.k, tx: t.x, ty: t.y });
        });

    try {
        svg.call(behavior);
        // Double-click is reserved: Power BI uses it to enter focus mode.
        svg.on("dblclick.zoom", null);
    } catch {
        // A host or test environment without the DOM surface d3-zoom needs must
        // never break the render — the chart still draws, just without gestures.
    }

    const apply = (t: ViewTransform): void => {
        const next = zoomIdentity.translate(t.tx, t.ty).scale(t.k);
        programmatic = true;
        try {
            svg.call(behavior.transform, next);
        } catch {
            // A host or environment where d3-zoom cannot resolve its extent must
            // still get a correctly positioned chart, just without gestures.
            viewport.attr("transform", `translate(${t.tx},${t.ty}) scale(${t.k})`);
            if (onChange) onChange(t);
        } finally {
            programmatic = false;
        }
    };

    return {
        setViewport(vp: { width: number; height: number }): void {
            behavior.extent([[0, 0], [Math.max(1, vp.width), Math.max(1, vp.height)]]);
        },
        apply,
        current(): ViewTransform {
            const node = svg.node() as unknown as { __zoom?: { k: number; x: number; y: number } };
            const z = node && node.__zoom;
            return z ? { k: z.k, tx: z.x, ty: z.y } : { k: 1, tx: 0, ty: 0 };
        },
        zoomBy(factor: number, vp: { width: number; height: number }): void {
            const cur = this.current();
            const k = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cur.k * factor));
            if (k === cur.k) return;
            // Keep the viewport centre fixed, which is what a button press means.
            const cx = vp.width / 2, cy = vp.height / 2;
            apply({
                k,
                tx: cx - ((cx - cur.tx) / cur.k) * k,
                ty: cy - ((cy - cur.ty) / cur.k) * k,
            });
            userMoved = true;
        },
        touched: () => userMoved,
        clearTouched: () => { userMoved = false; },
        markTouched: () => { userMoved = true; },
        setEnabled(on: boolean): void { enabled = on; },
    };
}

/** Vertical room the collapsed gear needs in the corner it shares. */
export const GEAR_CLEARANCE = 54;

export interface ZoomControlOptions {
    width: number;
    height: number;
    /** Extra room to leave at the bottom — the gear shares this corner. */
    bottomInset?: number;
    /** Button and glyph colours. */
    fg: string;
    bg: string;
    stroke: string;
    /** Labels, already localized. */
    labels: { in: string; out: string; fit: string };
    onZoomIn: () => void;
    onZoomOut: () => void;
    onFit: () => void;
}

/** Button box, so the tests and the hit area agree on one number. */
export const CONTROL_SIZE = 26;
const CONTROL_GAP = 4;
const CONTROL_MARGIN = 10;

/**
 * Three buttons, bottom-right: zoom in, zoom out, fit.
 *
 * Drawn as SVG primitives with `role="button"` and a tab stop each, because a
 * mouse-only zoom is not accessible and certification checks keyboard reach.
 */
export function renderZoomControls(root: GSel, o: ZoomControlOptions): void {
    root.selectAll("g.zoom-controls").remove();
    // No room for chrome on a tile — the buttons would cover the chart.
    if (o.width < 200 || o.height < 140 + (o.bottomInset ?? 0)) return;

    const g = root.append("g").attr("class", "zoom-controls");
    const x = o.width - CONTROL_MARGIN - CONTROL_SIZE;
    const total = CONTROL_SIZE * 3 + CONTROL_GAP * 2;
    const y0 = o.height - CONTROL_MARGIN - total - 14 - (o.bottomInset ?? 0);

    const button = (
        index: number, label: string, glyph: (b: GSel) => void, action: () => void,
    ): void => {
        const b = g.append("g")
            .attr("class", "zoom-button")
            .attr("transform", `translate(${x},${y0 + index * (CONTROL_SIZE + CONTROL_GAP)})`)
            .attr("role", "button")
            .attr("tabindex", 0)
            .attr("aria-label", label) as GSel;
        b.append("title").text(label);
        b.append("rect")
            .attr("width", CONTROL_SIZE).attr("height", CONTROL_SIZE).attr("rx", 6)
            .attr("fill", o.bg).attr("stroke", o.stroke).attr("stroke-width", 1);
        glyph(b);
        b.on("click", (event: MouseEvent) => {
            event.stopPropagation();      // never clear the cross-filter selection
            action();
        });
        b.on("keydown", (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
                event.preventDefault();
                event.stopPropagation();
                action();
            }
        });
    };

    const c = CONTROL_SIZE / 2;
    const stroke = (b: GSel, d: string): void => {
        b.append("path").attr("d", d)
            .attr("fill", "none").attr("stroke", o.fg).attr("stroke-width", 1.6)
            .attr("stroke-linecap", "round");
    };

    button(0, o.labels.in, (b) => stroke(b, `M${c - 5},${c} h10 M${c},${c - 5} v10`), o.onZoomIn);
    button(1, o.labels.out, (b) => stroke(b, `M${c - 5},${c} h10`), o.onZoomOut);
    button(2, o.labels.fit, (b) => {
        // Four corners pointing out — the conventional "fit to screen" glyph.
        stroke(b, `M${c - 5},${c - 2} v-3 h3 M${c + 5},${c - 2} v-3 h-3`
            + ` M${c - 5},${c + 2} v3 h3 M${c + 5},${c + 2} v3 h-3`);
    }, o.onFit);
}
