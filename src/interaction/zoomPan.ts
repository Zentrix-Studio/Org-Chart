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

/** Vertical room the collapsed gear (or the view pill) needs in a corner it shares. */
export const GEAR_CLEARANCE = 54;

/** Button box, so the tests and the hit area agree on one number. */
export const CONTROL_SIZE = 26;
const CONTROL_GAP = 4;
const CONTROL_MARGIN = 10;
/**
 * Room kept under a BOTTOM-corner stack for the status line / pan cue, which
 * own the last rows of the canvas. A top-corner stack needs none of it.
 */
const STATUS_BAND = 14;

/**
 * The bar's OPTIONAL buttons, in the order they are given up when the canvas is
 * too small to hold them all (OC-036).
 *
 * Zoom in, zoom out and fit are never shed — they are the way back in, and a
 * chart with no way back in is what OC-007 was. "Show everything" goes first: a
 * reader can still get there by holding `−`. The lens goes second: it is the
 * only answer to a card too small to read, so it is worth more than a shortcut.
 */
export type OptionalButton = "fullView" | "lens";
const SHED_ORDER: OptionalButton[] = ["fullView", "lens"];

/** Which corner the quick-action bar sits in. Since OC-034 the default is top-right. */
export type ActionCorner = "tl" | "tr" | "bl" | "br";

/** A rectangle in viewport pixels — the same shape `treeLayout` fits around. */
export interface ActionRect { x: number; y: number; w: number; h: number; }

export interface ActionBarGeometry {
    /** Viewport size. */
    width: number;
    height: number;
    /** Corner to pin to. */
    corner?: ActionCorner;
    /** How many buttons the bar holds — 3 without the lens, 4 with it. */
    buttons?: number;
    /** Extra room to leave along the vertical edge: another piece shares this corner. */
    cornerInset?: number;
    /**
     * Room to leave at the FAR end of the column, because something occupies the
     * opposite corner on the same side (OC-036).
     *
     * On a tall canvas the bar and a bottom-corner gear never meet, so this is 0
     * and nothing changes. On a short one they are effectively in the same strip:
     * at 280×180 a five-button bar pinned top-right ran 28px into a gear pinned
     * bottom-right. `cornerInset` only knows about the corner the bar is IN.
     */
    farInset?: number;
}

/**
 * Where the quick-action bar lands, or `null` on a canvas too small to hold it.
 *
 * ONE piece of geometry, used by the renderer AND by `chromeObstacles` — before
 * OC-034 the two carried the same constants separately and could disagree.
 */
export function actionBarRect(o: ActionBarGeometry): ActionRect | null {
    const n = Math.max(1, o.buttons ?? 3);
    const total = CONTROL_SIZE * n + CONTROL_GAP * (n - 1);
    const inset = Math.max(0, o.cornerInset ?? 0);
    const corner: ActionCorner = o.corner ?? "tr";
    const bottom = corner.charAt(0) === "b";
    const far = Math.max(CONTROL_MARGIN, Math.max(0, o.farInset ?? 0));
    // No room for chrome on a tile — the buttons would cover the chart. The far
    // end costs its own margin, or whatever the piece in the opposite corner
    // needs, whichever is larger.
    const needed = total + CONTROL_MARGIN + far + (bottom ? STATUS_BAND : 0) + inset;
    if (o.width < 200 || o.height < needed) return null;
    const x = corner.charAt(1) === "l"
        ? CONTROL_MARGIN
        : o.width - CONTROL_MARGIN - CONTROL_SIZE;
    const y = bottom
        ? o.height - CONTROL_MARGIN - total - STATUS_BAND - inset
        : CONTROL_MARGIN + inset;
    return { x, y, w: CONTROL_SIZE, h: total };
}

/**
 * What the bar can show, and what it settles for.
 *
 * `planActionBar` is the ONE place that decides — the renderer and the visual's
 * obstacle list both ask it, so the box that is drawn and the box the chart is
 * fitted around can never disagree (the drift OC-034 removed).
 */
export interface ActionBarWants extends ActionBarGeometry {
    /** The magnifier, when the author has it on. */
    lens?: boolean;
    /** "Show everything", when it would do something `fit` does not. */
    fullView?: boolean;
}

export interface ActionBarPlan {
    rect: ActionRect;
    /** How many buttons fit, including the three that are never shed. */
    buttons: number;
    lens: boolean;
    fullView: boolean;
}

/**
 * Where the bar lands and what it can hold, or `null` when not even the three
 * essential buttons fit — then the bar stands down, as every other piece of
 * chrome does on a canvas too small for it.
 */
export function planActionBar(o: ActionBarWants): ActionBarPlan | null {
    let lens = Boolean(o.lens);
    let fullView = Boolean(o.fullView);
    // Shed the optional buttons one at a time until the bar fits.
    for (;;) {
        const buttons = 3 + (lens ? 1 : 0) + (fullView ? 1 : 0);
        const rect = actionBarRect({ ...o, buttons });
        if (rect) return { rect, buttons, lens, fullView };
        const next = SHED_ORDER.find((b) => (b === "lens" ? lens : fullView));
        if (!next) return null;
        if (next === "lens") lens = false; else fullView = false;
    }
}

export interface LensButtonOptions {
    /** Draw the lens button at all. */
    show: boolean;
    /** Its current state — pressed draws it on the accent. */
    active: boolean;
    label: string;
    accent: string;
    onToggle: () => void;
}

export interface ZoomControlOptions extends ActionBarGeometry {
    /** Button and glyph colours. */
    fg: string;
    bg: string;
    stroke: string;
    /** Labels, already localized. */
    labels: { in: string; out: string; fit: string };
    onZoomIn: () => void;
    onZoomOut: () => void;
    onFit: () => void;
    /** The magnifier toggle (OC-034). Omit it and the bar is the original three. */
    lens?: LensButtonOptions;
    /**
     * "Show everything" (OC-036) — the fit that ignores the legibility floor.
     * Offered only when it would differ from `fit`, which since OC-030 stops AT
     * the floor and therefore shows a crop of a large hierarchy.
     */
    fullView?: { show: boolean; label: string; onClick: () => void };
}

/**
 * The quick-action bar: zoom in, zoom out, fit — and, since OC-034, the lens.
 *
 * Top-right by default (OC-034, CEO 2026-09-20); the author may pin it to any
 * corner. Drawn as SVG primitives with `role="button"` and a tab stop each,
 * because a mouse-only zoom is not accessible and certification checks keyboard
 * reach.
 *
 * ⚠️ The lens button is appended LAST so `.zoom-button[0..2]` stay in / out / fit
 * — the gates and a dozen tests address them by index.
 */
export function renderZoomControls(root: GSel, o: ZoomControlOptions): void {
    root.selectAll("g.zoom-controls").remove();
    const plan = planActionBar({
        ...o,
        lens: Boolean(o.lens && o.lens.show),
        fullView: Boolean(o.fullView && o.fullView.show),
    });
    if (!plan) return;

    const g = root.append("g").attr("class", "zoom-controls");
    const x = plan.rect.x;
    const y0 = plan.rect.y;

    const button = (
        index: number, label: string, glyph: (b: GSel) => void, action: () => void,
        opts: { pressed?: boolean; fill?: string; ink?: string } = {},
    ): void => {
        const b = g.append("g")
            .attr("class", "zoom-button")
            .attr("transform", `translate(${x},${y0 + index * (CONTROL_SIZE + CONTROL_GAP)})`)
            .attr("role", "button")
            .attr("tabindex", 0)
            .attr("aria-label", label) as GSel;
        if (opts.pressed !== undefined) b.attr("aria-pressed", opts.pressed ? "true" : "false");
        b.append("title").text(label);
        b.append("rect")
            .attr("width", CONTROL_SIZE).attr("height", CONTROL_SIZE).attr("rx", 6)
            .attr("fill", opts.fill ?? o.bg).attr("stroke", o.stroke).attr("stroke-width", 1);
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
    const stroke = (b: GSel, d: string, ink?: string): void => {
        b.append("path").attr("d", d)
            .attr("fill", "none").attr("stroke", ink ?? o.fg).attr("stroke-width", 1.6)
            .attr("stroke-linecap", "round");
    };

    button(0, o.labels.in, (b) => stroke(b, `M${c - 5},${c} h10 M${c},${c - 5} v10`), o.onZoomIn);
    button(1, o.labels.out, (b) => stroke(b, `M${c - 5},${c} h10`), o.onZoomOut);
    button(2, o.labels.fit, (b) => {
        // Four corners pointing out — the conventional "fit to screen" glyph.
        stroke(b, `M${c - 5},${c - 2} v-3 h3 M${c + 5},${c - 2} v-3 h-3`
            + ` M${c - 5},${c + 2} v3 h3 M${c + 5},${c + 2} v3 h-3`);
    }, o.onFit);

    let slot = 3;
    /*
     * "Show everything" — the whole chart at whatever scale that takes, below the
     * legibility floor if it must. `fit` deliberately stops AT the floor
     * (OC-030), so on a large hierarchy the two are different answers and both
     * are wanted: one readable, one complete. The glyph is a frame around
     * something small, not a second pair of corner brackets.
     */
    if (o.fullView && plan.fullView) {
        const full = o.fullView;
        button(slot++, full.label, (b) => {
            b.append("rect")
                .attr("x", c - 7.5).attr("y", c - 6).attr("width", 15).attr("height", 12).attr("rx", 1.5)
                .attr("fill", "none").attr("stroke", o.fg).attr("stroke-width", 1.4);
            b.append("rect")
                .attr("x", c - 2.5).attr("y", c - 2).attr("width", 5).attr("height", 4)
                .attr("fill", o.fg);
        }, full.onClick);
    }

    if (o.lens && plan.lens) {
        const lens = o.lens;
        // A magnifying glass: the ring, the handle, and a "+" inside it so the
        // button reads as "make this bigger" rather than "search" — the search
        // box is a different control and sits in the same visual.
        const ink = lens.active ? "#FFFFFF" : o.fg;
        button(slot++, lens.label, (b) => {
            stroke(b, `M${c - 1.5},${c - 1.5} m-4,0 a4,4 0 1,0 8,0 a4,4 0 1,0 -8,0`, ink);
            stroke(b, `M${c + 1.6},${c + 1.6} L${c + 5},${c + 5}`, ink);
            stroke(b, `M${c - 3.6},${c - 1.5} h4.2 M${c - 1.5},${c - 3.6} v4.2`, ink);
        }, lens.onToggle, { pressed: lens.active, fill: lens.active ? lens.accent : o.bg });
    }
}
