/*
 *  Zentrix Org Chart — Power BI custom visual
 *  v1 (free tier). Built against ../docs/CHANGE-LEDGER.md and the product
 *  definition at visuals/research/org-chart-product-definition-2026-09-09.html.
 */
"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { select, Selection } from "d3";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import IVisualEventService = powerbi.extensibility.IVisualEventService;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import DataView = powerbi.DataView;

import { VisualFormattingSettingsModel } from "./settings";
import {
    FIRST_LEVEL, LAST_LEVEL, levelLadder, levelsShown,
} from "./interaction/settingsSchema";
import { EmptyReason, OrgModel, Orientation, ConnectorStyle, ColorMode, TooltipStyle } from "./types";
import { buildOrgModel, missingRequiredRole, boundRoles } from "./model/dataTransform";
import {
    buildHierarchy, hiddenByCollapse, isParentNode,
    serializeCollapsed, deserializeCollapsed, Hierarchy,
} from "./model/hierarchy";
import {
    treeLayout, fitAvoiding, cardRects, rootsBox, LayoutResult, LayoutOptions, ScreenRect,
} from "./model/treeLayout";
import { renderLegend, LegendItem, LEGEND_HEIGHT } from "./render/legend";
import { createSearchBox, SearchHandle } from "./interaction/search";
import {
    createZoomPan, renderZoomControls, ZoomPanHandle, ZOOM_STEP, MAX_AUTO_SCALE,
    GEAR_CLEARANCE, planActionBar, ActionCorner, MIN_SCALE, MAX_SCALE,
} from "./interaction/zoomPan";
import { renderLens, clearLens } from "./render/lens";
import {
    renderMinimap, clearMinimap, minimapBox, visibleBounds, showsEverything,
} from "./render/minimap";
import {
    depthThatFits, fillLevelGap, levelRatioFor, levelScale, visibleDepth, NO_COLLAPSE,
    arrangeFor, FitScale, LeafMode, uniformLevelsShown,
} from "./model/autoFit";
import { renderTree, trimToWidth, smallestNameSize } from "./render/tree";
import { renderLanding as renderLandingPage } from "./render/landing";
import { PhotoShape, PhotoFallback } from "./render/tree";
import { LandingPage } from "./interaction/landingPage";
import { SettingsOverlay } from "./interaction/settingsPanel";
import { LicenseGate } from "./interaction/license";
import { assessQuality, buildWarning } from "./model/dataQuality";
import {
    bindSelection, bindCanvasClear, applySelectionDim, bindBookmarks, applyHighlightDim,
} from "./interaction/selection";
import { resolvePalette, ResolvedPalette } from "./theme/palette";
import { Localization } from "./localization";
import { buildTooltip, overlayContent, TooltipInput } from "./interaction/tooltip";
import { ZentrixOverlayTooltip } from "./interaction/zentrixOverlayTooltip";
import { nextFocus, isNavKey } from "./interaction/keyboardNav";
import { createTooltipServiceWrapper, ITooltipServiceWrapper } from "powerbi-visuals-utils-tooltiputils";
import { nodeMetrics, summarize, isVacancy, NodeMetrics, OrgSummary, DEFAULT_SPAN } from "./model/analytics";
import { parseRules, firstMatch, RuleContext, CFRule } from "./model/conditionalFormat";
import { resolveDottedLines, visibleDottedLinks, DottedLink } from "./model/dottedLines";
import { periodsOf, snapshotAt, diffPeriods, defaultComparison, ChangeKind } from "./model/temporal";
import { NotesStore } from "./notes/notesStore";
import { serializeSvg, rasterizeToPng, safeFileName } from "./render/exportImage";
import { renderDottedLines } from "./render/tree";
import { accent, accentStrong, posSafe, negSafe, fontFamily, Surface } from "./theme/zentrixTokens";
import { ViewToggle, ViewKind, PILL_HEIGHT } from "./interaction/viewToggle";
import { renderSummaryTable, TableState } from "./render/summaryTable";
import { renderInsightView } from "./render/insightView";
import { computeOrgNarrative, InsightAction } from "./insights/orgInsights";
import { buildOrgRows, toCsv } from "./model/orgTable";

type SvgSel = Selection<SVGSVGElement, unknown, null, undefined>;
type GSel = Selection<SVGGElement, unknown, null, undefined>;

/**
 * The legibility floor (OC-030, zentrix-org-chart#1): no automatic view draws a
 * name smaller than this many pixels on screen. The fit, the opening
 * collapse, level sizing and search all aim at it; only the reader's own − or
 * wheel goes below it.
 */
export const FLOOR_PX = 9;

/**
 * Where the gear and the view switch land when the author leaves them on Auto
 * (CEO, 2026-09-20 — OC-034). The quick-action bar took the top-right corner,
 * which OC-020 had given the gear. One constant, because three call sites used
 * to carry the corner as a literal and they drifted apart.
 */
export const GEAR_AUTO_CORNER = "br";

/**
 * The size the OPENING view aims its names at (OC-035, CEO 2026-09-20).
 *
 * `FLOOR_PX` is the floor — the smallest a name may ever be drawn automatically.
 * Opening AT the floor was the complaint: a chart technically readable at 9px,
 * where the same org shown three levels shallower is comfortable and the rest is
 * one click away behind a count. So the auto-collapse aims here and the floor
 * stays what it is, the last line of defence for the fit.
 *
 * 11 gives ~0.88 at the default 12.5px name — a fifth bigger than the floor,
 * and short of 1:1 so a chart that already fits comfortably is left alone.
 */
export const OPEN_PX = 11;

/**
 * Is this event target a piece of the visual's own chrome?
 *
 * Walks up from the target looking for any of the floating controls. Used to
 * stand the lens down over them — a loupe magnifying the zoom buttons is noise,
 * and one covering the button that turns it off is a trap.
 */
function overChrome(target: EventTarget | null): boolean {
    let el = target as Element | null;
    for (let hops = 0; el && hops < 12; hops++) {
        const cls = typeof el.getAttribute === "function" ? el.getAttribute("class") || "" : "";
        if (/\b(zoom-controls|zoom-button|zx-minimap|zx-view|zx-search|zsb-anchor|zsb-gear)\b/.test(cls)) return true;
        el = el.parentElement;
    }
    return false;
}

/** A saved view: the scale, and the chart-space point that was in the middle. */
interface SavedView { k: number; cx: number; cy: number }

/** How long the view must sit still before it is written to the report. */
const VIEW_SAVE_MS = 600;

/** Three decimals is a tenth of a pixel at any scale we draw — and a short blob. */
function round3(v: number): number { return Math.round(v * 1000) / 1000; }

/**
 * Read a saved view. Anything malformed is no view at all: this blob travels in
 * the report file, so it can arrive from an older build, a hand edit or a
 * half-written bookmark, and the answer to all three is the automatic fit.
 */
function parseView(blob: string): SavedView | null {
    if (!blob) return null;
    try {
        const v = JSON.parse(blob) as Partial<SavedView>;
        if (typeof v.k !== "number" || typeof v.cx !== "number" || typeof v.cy !== "number") return null;
        if (!isFinite(v.k) || !isFinite(v.cx) || !isFinite(v.cy)) return null;
        return { k: Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.k)), cx: v.cx, cy: v.cy };
    } catch {
        return null;
    }
}

export class Visual implements IVisual {
    /** Clip ids are unique per DOCUMENT: two Org Charts on one page share one. */
    private static clipSeq = 0;
    private host: IVisualHost;
    private events: IVisualEventService;
    private selectionManager: ISelectionManager;
    private formattingSettingsService: FormattingSettingsService;
    private settings: VisualFormattingSettingsModel;
    private license: LicenseGate;
    private loc: Localization;
    private tooltipWrapper: ITooltipServiceWrapper | null = null;
    /** False on non-interactive surfaces such as dashboard tiles. */
    private allowInteractions = true;
    /** Rendering for an export / dashboard host: no chrome, fitted (#5). */
    private exporting = false;
    /**
     * Is an AUTHOR editing the report right now? (OC-043)
     *
     * The only thing this gates is the Zentrix wordmark on the hover card.
     * Microsoft's publishing guidelines: *"Commercial logos are allowed in edit
     * mode only. Commercial logos can't be displayed in view mode."* — and a
     * **logotype**, text with no icon, is one of the three kinds they name. The
     * wordmark used to draw for report READERS too, which is the one place the
     * rule forbids.
     *
     * ⚠️ `options.viewMode`, never `editMode` — the other one has caused an S1
     * in this portfolio twice. `ViewMode.View` is 0, `Edit` 1, `InFocusEdit` 2.
     * A host that sends nothing is treated as VIEW: failing closed costs a brand
     * impression, failing open costs a certification cycle.
     */
    private editing = false;
    /** Photo data URI → decoded ("ok"), not an image ("bad"), or still probing (#10). */
    private photoStatus = new Map<string, "ok" | "bad" | "pending">();
    /** An update whose renderingFinished waits for photos still decoding. */
    private finishAfterPhotos: VisualUpdateOptions | null = null;
    /** True while the photo callback re-draws a render that has already started. */
    private redrawing = false;
    /** True while probes are being started — a probe that answers at once must not re-enter update(). */
    private probing = false;
    /** Set by destroy(): late photo answers must not draw or raise rendering events. */
    private destroyed = false;
    /** True between beforeprint and afterprint: the print fit is not a view choice. */
    private printing = false;
    private readonly onBeforePrint = (): void => {
        if (this.root) this.root.classList.add("zx-printing");
        // Printing fits the chart to the page, which is a refit like any other —
        // but it is the printer's decision, not the author's, so it must not
        // erase the view saved in the report (OC-042).
        this.printing = true;
        this.refit();
    };
    private readonly onAfterPrint = (): void => {
        if (this.root) this.root.classList.remove("zx-printing");
        this.printing = false;
    };
    private palette: ResolvedPalette | null = null;
    /** Node index that currently has keyboard focus. */
    private focusIndex = -1;
    /** Zoom / pan. Owns the viewport transform — never write it directly. */
    private zoom: ZoomPanHandle | null = null;
    /** The in-visual gear — the shared Zentrix Settings Bar. */
    private overlay: SettingsOverlay | null = null;
    /** Search and jump — free-tier chrome, an HTML overlay over the chart. */
    private searchBox: SearchHandle | null = null;
    /** Node indices matching the live query, so a re-render keeps the emphasis. */
    private searchHits: number[] = [];
    /** The last laid-out tree, so search can centre a person without re-laying out. */
    private lastLayout: LayoutResult | null = null;
    /** Hierarchy + keys from the last render, so search can open a closed branch. */
    private lastHierarchy: Hierarchy | null = null;
    private lastKeys: string[] = [];
    /** The branded hover card — the family's tooltip chrome. */
    private overlayTooltip: ZentrixOverlayTooltip | null = null;
    /** The positioned root the floating chrome is placed against. */
    private root: HTMLElement | null = null;
    /** Colour blob we have written but the host has not echoed back yet. */
    private pendingColors: string | null = null;
    /** The blob as last seen, so an ordinary repaint never re-persists. */
    private lastColorBlob = "";
    /** The opening auto-collapse runs once per session as well as once per
     *  report — a host that ignores persistProperties must not re-decide it on
     *  every update. */
    private autoFitApplied = false;
    /** What the view was last fitted to; a change re-fits, a user gesture does not. */
    private viewSignature = "";
    /**
     * The saved view (`viewState.data`), so a reopened report comes back to the
     * place its author left rather than to the automatic fit (OC-042).
     * `pendingView` is a write not yet echoed; it wins over what the host says,
     * exactly as `colorStore` does.
     */
    private lastViewBlob = "";
    private pendingView: string | null = null;
    private storedView: SavedView | null = null;
    /** A stored view is applied ONCE — after that the reader owns the transform. */
    private viewRestored = false;
    /** Debounce: a gesture is dozens of transforms, and each one is a host write. */
    private viewSaveTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * The part of the picture a MOVED view is not allowed to survive (OC-042):
     * the data itself and the author's layout controls. Everything else — a
     * collapse, a resize, chrome appearing — keeps the reader where they are.
     */
    private layoutSignature = "";
    /** Bounds + viewport of the last render, so "fit" works without re-laying out. */
    /** Card rectangles of the last layout, in layout units — what the fit keeps clear of chrome. */
    private lastCards: ScreenRect[] = [];
    /** How far the search box moved right to clear a top-left gear. */
    private searchInset = 0;
    /** The width the search box may use this render, after the chrome in its row. */
    private searchWidth = 0;
    private lastFit: { bounds: { minX: number; minY: number; maxX: number; maxY: number };
        width: number; height: number; maxScale: number;
        /** The legibility floor for this render, and what a floored view keeps on screen. */
        minScale: number; anchor: ScreenRect | null } | null = null;

    private svg: SvgSel;
    private viewport: GSel;
    private chrome: GSel;

    /* The minimap and the lens each own a LAYER of their own. `renderStatus`
     * clears `chrome` on every render, and both of these are also refreshed
     * between renders — the minimap from the zoom handler, the lens from the
     * pointer — so neither can live in a layer something else empties. */
    private mapLayer: GSel;
    private lensLayer: GSel;
    /** `id` of the chart group, which the lens re-uses. Document-unique. */
    private chartId = "";
    private lensClipId = "";
    /** The lens is session-local, like the view switch: a reader cannot persist. */
    private lensOn = false;
    /**
     * True when the whole chart cannot be shown at the legibility floor, so
     * "Show everything" is a different answer from "Fit to view" (OC-036).
     * Computed at render, from the fit the reader is actually given.
     */
    private fullViewDiffers = false;
    /** Last pointer position on the canvas, or null when the pointer is elsewhere. */
    private lensPoint: { x: number; y: number } | null = null;

    /** Collapsed node KEYS (not indices) — survives refresh and cross-filter. */
    private collapsedKeys = new Set<string>();
    /** The stored collapse value as last read from the host; null before the first. */
    private lastHostCollapsed: string | null = null;

    /** "Collapse deep levels to fit" as last seen, to spot the AUTHOR flipping it (OC-037). */
    private lastCollapseToFit: boolean | null = null;

    /** The level ladder as last applied by THIS instance (OC-035). */
    private lastLadder: string | null = null;
    /** A ladder written but not yet echoed back by the host. */
    private pendingLadder: string | null = null;
    /** The host's `levelsApplied` as last seen, to spot an outside change. */
    private lastHostLadder: string | null = null;
    /** What the ladder was before the pending write — how a stale update is spotted. */
    private prevLadder: string | null = null;
    /** A collapse value WE wrote that the host has not echoed back yet. */
    private pendingCollapsed: string | null = null;
    /** Bumped whenever the collapse set is replaced from outside (bookmark, undo),
     *  so the view re-fits even when the counts happen to match. */
    private collapseEpoch = 0;
    /** True once this instance raised the warning icon, so a clean render can clear it. */
    private warned = false;
    /** Group value → colour slot. Assigned once, never reassigned (#2). */
    private groupSlots = new Map<string, number>();
    private pendingSlots: string | null = null;
    private lastSlotsBlob = "";
    private lastOptions: VisualUpdateOptions | null = null;
    /** Annotations. Free since OC-016; the gate is kept but allows everything. */
    private notes = new NotesStore();
    /** Onboarding carousel, shown only while NOTHING is bound. */
    private landing: LandingPage | null = null;

    /* ── the view switch: Chart / Table / Insight (OC-029) ─────────────────
     * The view itself is session-local, never persisted: it has to work for a
     * report READER, where a persistProperties write does not survive. Only the
     * table's column / sort / folded-cards choices persist (`tableState`). */
    private viewToggle: ViewToggle | null = null;
    private viewMode: ViewKind = "chart";
    /** The mounted Table or Insight surface, when one is showing. */
    private altEl: HTMLElement | null = null;
    private altKind: ViewKind | null = null;
    /** Where the pill sits this render, in viewport pixels; null when hidden. */
    private pillRect: ScreenRect | null = null;
    private pillCorner = "tr";
    private tableState: TableState | null = null;
    private pendingTableState: string | null = null;
    private lastTableBlob = "";
    /** The table's search text — session-local, so a host re-render keeps it. */
    private tableQuery = "";

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.events = options.host.eventService;
        this.selectionManager = options.host.createSelectionManager();
        this.formattingSettingsService = new FormattingSettingsService();
        this.loc = new Localization(options.host);
        // Documented best practice: tooltips stay enabled in EVERY scenario,
        // including where allowInteractions is false.
        try {
            this.tooltipWrapper = createTooltipServiceWrapper(
                options.host.tooltipService, options.element);
        } catch {
            this.tooltipWrapper = null;
        }
        this.allowInteractions =
            (options.host as unknown as { hostCapabilities?: { allowInteractions?: boolean } })
                .hostCapabilities?.allowInteractions !== false;
        // zentrix-org-chart#5 (OC-QA-30). The Service renders exports in its own host
        // (`CustomVisualHostEnv.ExportReportHost`, API 5.11), and a dashboard tile is
        // no place for controls either: both draw the chart with no chrome at all.
        const env = Number((options.host as unknown as { hostEnv?: unknown }).hostEnv) || 0;
        this.exporting = (env & (HOST_ENV_EXPORT | HOST_ENV_DASHBOARD)) !== 0;
        if (this.exporting) this.allowInteractions = false;
        this.license = new LicenseGate(options.host, () => {
            if (this.lastOptions) this.update(this.lastOptions);
        });

        const root = select(options.element).append("div").classed("zentrix-org-root", true)
            .classed("zx-exporting", this.exporting);
        this.root = root.node() as HTMLElement;
        // A print (Desktop's PDF export may be one) gets the fitted chart and no
        // controls — not the reader's pan and a half-typed search (#5).
        try {
            window.addEventListener("beforeprint", this.onBeforePrint);
            window.addEventListener("afterprint", this.onAfterPrint);
        } catch { /* a host without print events */ }
        this.svg = root.append("svg").classed("zentrix-org", true) as SvgSel;
        // Bookmarks: Power BI calls back with the restored selection.
        bindBookmarks(this.selectionManager, () => {
            if (this.lastOptions) this.update(this.lastOptions);
        });
        // The chart draws inside a clip that ends above the bottom chrome band (the
        // status line and the legend). Since OC-030 the fit can stop at the
        // legibility floor and crop, and a crop — or a reader's pan — must not run
        // cards under that text. The clip lives on a wrapper because d3-zoom
        // transforms `viewport` itself, which would drag a clip set there along.
        const seq = Visual.clipSeq++;
        const clipId = "zxoc-clip-" + seq;
        // Ids must be unique across the DOCUMENT, not the visual: two Org Charts
        // on one report page share a document (the lesson of OC-025). A counter,
        // not a random value, so the markup stays deterministic for export.
        this.chartId = "zxoc-chart-" + seq;
        this.lensClipId = "zxoc-lens-" + seq;
        this.svg.append("defs").append("clipPath").attr("id", clipId).attr("class", "chart-clip")
            .append("rect").attr("x", 0).attr("y", 0).attr("width", 0).attr("height", 0);
        this.viewport = this.svg.append("g").attr("class", "chart-area").attr("clip-path", `url(#${clipId})`)
            .append("g").attr("class", "viewport").attr("id", this.chartId) as GSel;
        this.chrome = this.svg.append("g").attr("class", "chrome") as GSel;
        this.mapLayer = this.svg.append("g").attr("class", "zx-minimap-layer") as GSel;
        this.lensLayer = this.svg.append("g").attr("class", "zx-lens-layer")
            .attr("pointer-events", "none") as GSel;

        // A press on the chart must dismiss the gear. d3-zoom stops the mousedown
        // immediately (that is how it claims the drag), so the bar's own
        // click-away listener on `document` never sees it — the visual has to say so.
        this.zoom = createZoomPan(this.svg, this.viewport, () => {
            this.updatePanHint();
            // Save where the reader is, once they stop moving.
            this.scheduleViewSave();
            // The window rectangle answers to the LIVE view, not to the last data
            // render — the same reason the pan cue is its own element.
            this.updateMinimap();
            this.updateLens();
        }, () => {
            // "Close on click-away" is the author's call. Before OC-028 this closed
            // the gear on every press on the chart, so switching it off did nothing
            // on the one surface it exists for.
            if (this.overlay && this.closeOnClickAway()) this.overlay.forceClose();
            if (this.overlayTooltip) this.overlayTooltip.hide();
        });
        this.zoom.setEnabled(this.allowInteractions);

        if (this.root) {
            this.overlayTooltip = new ZentrixOverlayTooltip(this.root, {
                theme: {
                    dark: false, bg: "#FFFFFF", fg: "#15161E", muted: "#54566B",
                    strong: "#15161E", accent, pos: posSafe, neg: negSafe, fontFamily,
                },
            });
        }

        // Search and jump. Built once; visibility follows the setting.
        if (this.root) {
            this.searchBox = createSearchBox(this.root, {
                placeholder: this.loc.get("Search_Placeholder"),
                countLabel: (at, total) => this.loc.fmt("Search_Count", at, total),
                noMatchLabel: this.loc.get("Search_NoMatch"),
                nextLabel: this.loc.get("Search_Next"),
                // A found card is shown at a size it can be read at (OC-030):
                // centring it at a 4px scale found nothing.
                onJump: (i) => this.jumpTo(i, Math.max(1, this.lastFit ? this.lastFit.minScale : 1)),
                onMatches: (hits) => { this.searchHits = hits; this.paintSearch(); },
                dark: false,
                fg: "#15161E", bg: "#FFFFFF", stroke: "#E4E4EC", accent,
                fontFamily,
            });
        }

        // The family's in-visual settings surface. Edits repaint optimistically,
        // so a control moves the chart before the host round-trip lands.
        if (this.root) {
            this.overlay = new SettingsOverlay(this.root, this.host, () => {
                // A ColorPicker edit has to go to the durable store: the `fill`
                // the bar itself persists is dropped by the host.
                this.maybePersistColors();
                if (this.lastOptions) this.update(this.lastOptions);
            }, () => this.resetViewState());
        }

        // Chart / Table / Insight. Hidden until a hierarchy renders.
        if (this.root) {
            this.viewToggle = new ViewToggle(this.root, (kind) => {
                this.viewMode = kind;
                if (this.overlayTooltip) this.overlayTooltip.hide();
                if (this.lastOptions) this.update(this.lastOptions);
            });
        }

        // The onboarding carousel. Mounted HERE, not from update(): Power BI does
        // not call update() until a role is bound, so a page shown only from there
        // would never appear on the empty visual it exists for. update() takes it
        // down the moment anything is bound.
        if (this.root) {
            const launch = (url: string) => {
                try { this.host.launchUrl(url); } catch { /* host without URL launching */ }
            };
            this.landing = new LandingPage(this.root, {
                // launchUrl supports HTTP(S), not mailto — so the support address goes
                // through Outlook's HTTPS compose deep link. No WebAccess privilege, and
                // no report data leaves the sandbox.
                onSupport: () => launch(
                    "https://outlook.office.com/mail/deeplink/compose?to=support%40zentrixstudio.in"
                    + "&subject=Zentrix%20Org%20Chart%20Support",
                ),
                onLinkedIn: () => launch("https://www.linkedin.com/company/zentrixstudio/"),
            });
            // Never let onboarding art blank the visual.
            try { this.landing.show(); } catch { /* the SVG landing is still underneath */ }
        }

        /*
         * The lens (OC-034). The pointer position is tracked on the svg itself
         * rather than on the cards: the whole point is to magnify a region, and
         * half of what is in it — connectors, the gaps that show a branch is
         * wide — is not a card. Tracked only while the lens is ON, so a report
         * that never turns it on pays nothing.
         */
        this.svg.on("mousemove.lens", (ev: MouseEvent) => {
            if (!this.lensOn) return;
            const node = this.svg.node() as SVGSVGElement | null;
            if (!node || typeof node.getBoundingClientRect !== "function") return;
            // Over the controls, the loupe stands down (OC-035). It is drawn on
            // TOP of the chrome, so without this it covered the very button you
            // reach for to turn it off — and the way out of the mode looked like
            // there wasn't one. The loupe never takes a pointer event, so the
            // event's target is the real element underneath it.
            if (overChrome(ev.target)) {
                this.lensPoint = null;
                this.updateLens();
                return;
            }
            const r = node.getBoundingClientRect();
            this.lensPoint = { x: ev.clientX - r.left, y: ev.clientY - r.top };
            this.updateLens();
        });
        this.svg.on("mouseleave.lens", () => {
            this.lensPoint = null;
            this.updateLens();
        });

        this.svg.on("keydown", (ev: KeyboardEvent) => {
            // Escape puts the lens down — the way out of any transient mode.
            if (ev.key === "Escape" && this.lensOn) {
                ev.preventDefault();
                this.setLens(false);
                return;
            }
            // Ctrl/Cmd+E exports. Still routed through exportChart(); a toolbar
            // affordance arrives with the overlay chrome.
            if ((ev.ctrlKey || ev.metaKey) && (ev.key === "e" || ev.key === "E")) {
                ev.preventDefault();
                void this.exportChart("png");
                return;
            }
            // Zoom from the keyboard: the buttons are not the only way in.
            if (!this.zoom || !this.lastOptions) return;
            const vp = this.lastOptions.viewport;
            if (ev.key === "+" || ev.key === "=") {
                ev.preventDefault();
                this.zoom.zoomBy(ZOOM_STEP, vp);
            } else if (ev.key === "-" || ev.key === "_") {
                ev.preventDefault();
                this.zoom.zoomBy(1 / ZOOM_STEP, vp);
            } else if (ev.key === "0" && !ev.shiftKey) {
                ev.preventDefault();
                this.refit();
            } else if (ev.key === ")" || (ev.key === "0" && ev.shiftKey)) {
                // Shift+0 — "0, but all of it". Below the legibility floor if
                // that is what showing the whole chart takes (OC-036).
                ev.preventDefault();
                this.fitAll();
            }
        });
    }

    public update(options: VisualUpdateOptions): void {
        // A render still waiting on photos is superseded: close its event first,
        // so every renderingStarted has exactly one renderingFinished.
        if (this.finishAfterPhotos) {
            const prev = this.finishAfterPhotos;
            this.finishAfterPhotos = null;
            this.events.renderingFinished(prev);
        }
        this.lastOptions = options;
        this.editing = options.viewMode === powerbi.ViewMode.Edit
            || options.viewMode === powerbi.ViewMode.InFocusEdit;
        if (!this.redrawing) this.events.renderingStarted(options);
        try {
            const dataView: DataView | undefined = options.dataViews && options.dataViews[0];
            this.settings = this.formattingSettingsService.populateFormattingSettingsModel(
                VisualFormattingSettingsModel, dataView,
            );

            // The gear's own edits, and then the colours the host refuses to keep.
            // Both have to land BEFORE anything is drawn from these settings.
            if (this.overlay) this.overlay.reconcile(this.settings);
            this.hydrateColors(dataView);
            this.hydrateTableState(dataView);

            const w = options.viewport.width;
            const h = options.viewport.height;
            this.svg.attr("width", w).attr("height", h);
            if (this.zoom) this.zoom.setViewport({ width: w, height: h });

            // Report theme + high contrast, resolved in one place.
            const palette = resolvePalette(
                this.host.colorPalette as never,
                {
                    useReportTheme: this.settings.colors.useReportTheme.value,
                    accent: this.settings.colors.cardFill.value.value || accentStrong,
                    dark: false,   // Power BI hands visuals light chrome unless HC is on
                },
            );
            this.palette = palette;
            const surface = palette.surface;
            const hc = palette.highContrast;

            const reason = missingRequiredRole(dataView);
            if (reason !== EmptyReason.None) {
                // No hierarchy, so no table or read-out of one: the landing page owns the canvas.
                this.leaveAltViews();
                this.renderLanding(reason, dataView, w, h, palette);
                // The carousel is for "what IS this visual", so it belongs to the
                // nothing-bound state only. Once a well is filled the author has
                // started, and what helps then is the in-canvas checklist telling
                // them which well is still empty — not seven pages of product copy.
                // NoData from missingRequiredRole means no categories at all; the
                // NoData passed further down (bound, but zero rows after filtering)
                // is a different state and must NOT bring the carousel back.
                this.setLandingVisible(reason === EmptyReason.NoData, palette.surface);
                if (this.overlay) this.overlay.setLevels(0);
                this.hideChartOverlays();
                this.syncOverlay(w, h);
                this.finish(options);
                return;
            }
            this.setLandingVisible(false, palette.surface);

            const model = buildOrgModel(dataView, this.license.nodeCap, this.host, this.loc.locale);
            this.maybeFetchMore(dataView);
            if (this.settings.nodes.showPhoto.value) this.probePhotos(model);
            this.syncGroupSlots(model, dataView, palette);
            this.syncViewState(dataView);
            if (model.nodes.length === 0) {
                this.leaveAltViews();
                this.renderLanding(EmptyReason.NoData, dataView, w, h, palette);
                this.hideChartOverlays();
                this.syncOverlay(w, h);
                this.finish(options);
                return;
            }

            // The legend is chrome and the chart must not draw underneath it, so
            // it is reserved BEFORE anything is fitted.
            const legendOn = this.settings.overlays.showLegend.value
                && String(this.settings.colors.colorMode.value.value) !== "single";
            const chromeInset = 22 + (legendOn ? LEGEND_HEIGHT : 0);

            const keys = model.nodes.map((n) => n.key);
            const parents = model.nodes.map((n) => n.parentKey);
            const hierarchy = buildHierarchy(keys, parents);
            // The level ladder offers exactly the levels this hierarchy has.
            if (this.overlay) {
                let deepest = 0;
                for (const d of hierarchy.depth) if (d > deepest) deepest = d;
                this.overlay.setLevels(deepest + 1);
            }

            // Restore persisted collapse state. Keys are the contract; indices
            // shift on every filter.
            //
            // The stored value is the report's; the in-memory set is ours between
            // a write and its echo. Three cases (zentrix-org-chart#3, OC-QA-34):
            //   • it equals our unconfirmed write → the host confirmed it;
            //   • it equals what we last saw     → nothing happened (or a stale
            //     update raced our write — ignoring it is what OC-029 fixed);
            //   • anything else                  → it changed from OUTSIDE: a
            //     bookmark, Undo, a copy/paste, another author's save. Replace the
            //     set with it. Before this, an external value was only read while
            //     the set was empty, so after the first toggle bookmarks never
            //     restored collapse.
            const persisted = this.settings.layout.collapsed.value || "";
            if (this.pendingCollapsed !== null && persisted === this.pendingCollapsed) {
                this.pendingCollapsed = null;
                this.lastHostCollapsed = persisted;
            } else if (persisted !== this.lastHostCollapsed
                && !(this.pendingCollapsed !== null && this.lastHostCollapsed === null)) {
                const external = this.lastHostCollapsed !== null;
                this.lastHostCollapsed = persisted;
                this.pendingCollapsed = null;
                this.collapsedKeys = new Set(collapsedKeysOf(persisted));
                if (external) this.collapseEpoch++;
            }

            // The view switch is placed BEFORE the chart is fitted: the fit, the
            // search box and the bottom rows all steer around it, the same way they
            // steer around the gear.
            this.syncOverlay(w, h);
            this.syncViewSwitch(w, h, palette);
            if (this.viewMode !== "chart") {
                this.renderAltView(model, hierarchy, palette);
                this.reportDataQuality(model, hierarchy, keys, parents);
                this.finish(options);
                return;
            }
            this.removeAltView();
            this.svg.style("display", null);
            const layoutOptions: LayoutOptions = {
                orientation: this.settings.layout.orientation.value.value as Orientation,
                cardWidth: this.settings.nodes.cardWidth.value,
                cardHeight: this.settings.nodes.cardHeight.value,
                levelGap: this.settings.layout.levelGap.value,
                siblingGap: this.settings.layout.siblingGap.value,
            };

            // The floating chrome is settled BEFORE anything is fitted (OC-028):
            // every choice below is measured against the view the reader will get.
            this.placeSearchBox(w);
            const sizeMode = String(this.settings.nodes.sizeMode.value.value);
            const maxScale = sizeMode === "fixed" ? 1 : MAX_AUTO_SCALE;
            const fitBox = { width: w, height: h - chromeInset };
            const obstacles = this.chromeObstacles(fitBox.width, fitBox.height);
            const fitK: FitScale = (l) => fitAvoiding(l.bounds, cardRects(l), fitBox, obstacles, 16, maxScale).k;
            // The scale at which the smallest drawn name is FLOOR_PX on screen.
            // Never above 1: an author who picks 7px names has chosen them.
            const smallestName = Math.max(1, smallestNameSize(
                this.settings.nodes.cardHeight.value, this.settings.labels.nameSize.value,
                this.settings.labels.titleSize.value,
            ));
            const kFloor = Math.min(1, FLOOR_PX / smallestName);
            // What the OPENING view aims at, which is deliberately above the floor
            // (OC-035). Never above 1: an author who picks 7px names chose them.
            const kOpen = Math.min(1, OPEN_PX / smallestName);
            const leafMode = String(this.settings.layout.leafStack.value.value || "auto") as LeafMode;
            const arrange = arrangeFor(hierarchy, layoutOptions, fitK, leafMode, kFloor);

            // A hierarchy too big to show whole opens with its deep levels
            // collapsed, at the TOP of the tree. Without this the opening view of
            // a 169-person org is a 9% slice of its middle — technically fitted,
            // and useless. Runs once per report: after that the stored collapse
            // state is the user's, and re-applying this would fight them.
            /*
             * ⚠️ "Collapse deep levels to fit" is an INSTRUCTION, not only an
             * opening behaviour (OC-037).
             *
             * It used to run once per report and then never again, so after the
             * first render the switch did nothing in either direction — a author
             * flipping it watched a dead control, which is the defect this
             * product is positioned against. The reason for "once per report"
             * was never the switch: it was that RE-APPLYING on every refresh
             * would fight a reader who had expanded a branch by hand. Acting on
             * the author's flip is the opposite of that, and the flag still stops
             * any re-application between flips.
             */
            const ctfOn = this.settings.layout.collapseToFit.value;
            const ctfFlipped = this.lastCollapseToFit !== null && this.lastCollapseToFit !== ctfOn;
            this.lastCollapseToFit = ctfOn;
            const firstAuto = ctfOn
                && !this.settings.layout.collapseToFitDone.value
                && !this.autoFitApplied
                && this.collapsedKeys.size === 0;

            if (ctfFlipped && !ctfOn) {
                // Turned OFF: don't collapse to fit — so show every level. The
                // switch is reversible, and the note in the gear says as much.
                this.autoFitApplied = true;
                this.collapsedKeys.clear();
                this.persistCollapsed(keys, true, LAST_LEVEL);
            } else if (firstAuto || (ctfFlipped && ctfOn)) {
                this.autoFitApplied = true;
                // Turned ON: "collapse to fit" means exactly that, so start from
                // the whole tree rather than from whatever is folded now.
                if (ctfFlipped) this.collapsedKeys.clear();
                // Aimed at `kOpen` — a COMFORTABLE size, not the bare floor
                // (OC-035) — with stacking and wrapping chosen per level (they
                // change what fits), and free to stop at the roots when not even
                // the first level is readable (OC-030).
                let depth = depthThatFits(hierarchy, layoutOptions, fitBox, kOpen, fitK, arrange);
                /*
                 * Comfort may fold a level the floor would have kept — that IS the
                 * point — but it must never fold the chart down to the bare roots.
                 * A wide, shallow org whose one row of reports is merely tight
                 * would otherwise open as a single card, which shows nothing.
                 * Only the FLOOR may go that far (OC-030), so ask it instead.
                 */
                if (depth !== NO_COLLAPSE && depth < 1) {
                    depth = depthThatFits(hierarchy, layoutOptions, fitBox, kFloor, fitK, arrange);
                }
                if (depth !== NO_COLLAPSE) {
                    for (let i = 0; i < keys.length; i++) {
                        if (hierarchy.depth[i] === depth && isParentNode(hierarchy, i)) {
                            this.collapsedKeys.add(keys[i]);
                        }
                    }
                }
                // Tell the level ladder what it just did, so Layout → Levels shows
                // the view the reader is looking at rather than ten switches all
                // claiming to be on (OC-035).
                this.persistCollapsed(keys, true, depth === NO_COLLAPSE ? LAST_LEVEL : depth + 1);
            } else {
                // The author moved the ladder: apply it ONCE, then leave the
                // collapse set alone so a branch opened by hand is not overruled.
                this.applyLevelLadder(hierarchy, keys);
            }

            const collapsed = new Set<number>();
            for (let i = 0; i < keys.length; i++) {
                if (this.collapsedKeys.has(keys[i]) && isParentNode(hierarchy, i)) collapsed.add(i);
            }
            const hidden = hiddenByCollapse(hierarchy, collapsed);
            // Leaf stacking and forest wrapping for what is actually on screen.
            Object.assign(layoutOptions, arrange(hidden));

            // Fit scales on the tighter axis, so a wide, shallow org fits by
            // width and then leaves most of the height empty. Stretching the gap
            // between levels uses that space at the same scale — the cards stay
            // the size they were. Level spacing becomes a minimum while this is on.
            // Auto lets the whole chart draw above 1:1 when the hierarchy leaves
            // room, so cards and their type grow together instead of sitting as
            // postage stamps in the middle of an empty canvas.

            // Cards grow towards the root. The ratio is chosen against THIS
            // viewport and THIS hierarchy, so the growth comes out of empty space
            // rather than out of the leaves — and the layout reserves each card's
            // real size, so a big parent can never overlap its neighbours.
            if (sizeMode === "level") {
                // Growth only when the LEAVES still clear the floor afterwards
                // (OC-030): spending the room on a 4x root while its 21 reports
                // draw at 4px is what the By-level default used to do.
                const ratio = levelRatioFor(hierarchy, hidden, layoutOptions, fitBox, kFloor, maxScale, fitK);
                if (ratio > 1) {
                    const deepest = visibleDepth(hierarchy, hidden);
                    layoutOptions.levelScale = (d: number) => levelScale(d, deepest, ratio);
                }
            }
            if (this.settings.layout.fillViewport.value) {
                layoutOptions.levelGap = fillLevelGap(hierarchy, hidden, layoutOptions, fitBox, kFloor, maxScale, fitK);
            }

            const layout = treeLayout(hierarchy, hidden, layoutOptions);

            // The view is fitted when what is being drawn changes — a new model,
            // a collapse, a resize, a different orientation or card size. A pan or
            // zoom the user performed is kept through every other update, because
            // yanking someone back to fit mid-read is worse than a stale view.
            this.lastFit = {
                bounds: layout.bounds, width: fitBox.width, height: fitBox.height, maxScale,
                minScale: kFloor, anchor: rootsBox(hierarchy, layout),
            };
            /*
             * Does "Show everything" say anything "Fit to view" does not?
             * Only when the readable fit is a CROP — then the two are different
             * answers, one legible and one complete, and the bar offers both
             * (OC-036). On a chart that fits whole they would do the same thing,
             * and a button that duplicates its neighbour is the dead control
             * this product is positioned against.
             */
            this.fullViewDiffers = fitAvoiding(
                layout.bounds, cardRects(layout), fitBox, obstacles, 16, maxScale, kFloor,
            ).floored;
            this.svg.select("clipPath.chart-clip rect").attr("width", w).attr("height", Math.max(0, fitBox.height));
            this.lastCards = cardRects(layout);
            this.lastLayout = layout;
            this.lastHierarchy = hierarchy;
            this.lastKeys = keys;
            const signature = [
                model.nodes.length, collapsed.size, hidden.size, Math.round(w), Math.round(h),
                this.settings.layout.orientation.value.value,
                this.settings.nodes.cardWidth.value, this.settings.nodes.cardHeight.value,
                this.settings.layout.levelGap.value, this.settings.layout.siblingGap.value,
                this.settings.layout.fillViewport.value, layoutOptions.levelGap,
                this.settings.nodes.sizeMode.value.value,
                // Stacking and wrapping change the picture without changing the counts above.
                layoutOptions.leafStack ?? 0, layoutOptions.rootsPerRow ?? 0, this.collapseEpoch,
                this.settings.labels.nameSize.value, this.settings.labels.titleSize.value,
                // Chrome the fit steers around: moving or hiding it changes the fit.
                this.settings.overlays.showSearch.value, this.settings.toolbar.show.value,
                this.settings.toolbar.position.value.value, this.allowInteractions,
                this.settings.summaryTable.show.value, this.settings.insights.show.value,
                this.settings.summaryTable.position.value.value,
                // The quick-action bar's height depends on how many buttons it
                // holds, and its box is an obstacle — so it belongs here too.
                this.settings.toolbar.actions.value, this.settings.toolbar.actionsPosition.value.value,
                this.settings.toolbar.lens.value,
            ].join("|");
            /*
             * The subset that outranks a reader's own gesture. Data first: a
             * slicer that cuts the org to three people leaves an old transform
             * describing nothing. Then the author's layout controls, where a
             * change is a deliberate edit to the picture and refitting is the
             * answer they expect. Collapse, viewport size and chrome are
             * deliberately NOT here.
             */
            const layoutSignature = [
                model.nodes.length,
                this.settings.layout.orientation.value.value,
                this.settings.nodes.cardWidth.value, this.settings.nodes.cardHeight.value,
                this.settings.layout.levelGap.value, this.settings.layout.siblingGap.value,
                this.settings.layout.fillViewport.value,
                this.settings.nodes.sizeMode.value.value,
                this.settings.labels.nameSize.value, this.settings.labels.titleSize.value,
            ].join("|");
            /*
             * Who owns the view right now?
             *
             * Nobody has moved it → the fit does, on every render.
             * The reader has moved it → they keep it (OC-042, CEO "zoom is not
             * persisting"). Folding a branch, resizing the visual or turning a
             * piece of chrome on used to snap them back to the fit, because all
             * three are in `signature` — so a zoom survived a refresh and a
             * cross-filter but never the one gesture people actually make next.
             * `keepView` holds the transform and only rescues a view the new
             * layout left off screen.
             *
             * A refit still wins over a moved view when the PICTURE itself is
             * different — new data, a flipped orientation, a resized card. There
             * the old transform describes a chart that no longer exists.
             */
            const untouched = !this.zoom || !this.zoom.touched();
            /*
             * A stored view the host has handed us and we have not applied yet —
             * a reopened report, or a BOOKMARK. It wins even over a reader who
             * has already moved: restoring a bookmark that leaves the view where
             * the reader happened to be is not restoring anything. Our own
             * writes mark themselves applied, so this never fights a gesture.
             */
            if (this.storedView && !this.viewRestored) {
                this.applyStoredView();
            } else if (untouched || layoutSignature !== this.layoutSignature) {
                this.refit();
            } else if (signature !== this.viewSignature) {
                this.keepView();
            }
            this.viewSignature = signature;
            this.layoutSignature = layoutSignature;

            const { colorOf, dashOf } = this.cardColors(model, hierarchy, palette);

            // ── THE ANALYTICS LAYER ───────────────────────────────────────
            // Every block below still asks `license.allows(...)`, and since
            // OC-016 the answer is always yes: the CEO made the visual free, so
            // all of this is free functionality — permanently, by Microsoft's
            // rule. The gate is kept as the single choke point for anything
            // added LATER, which is the only kind of paid tier left available.
            const proAnalytics = this.license.allows("orgAnalytics");
            const proRules = this.license.allows("rules");
            const proDotted = this.license.allows("dottedLines");
            const proTemporal = this.license.allows("temporal");
            const proNotes = this.license.allows("annotations");

            const oa = this.settings.orgAnalysis;
            let metrics: NodeMetrics[] | null = null;
            let summary: OrgSummary | null = null;
            if (proAnalytics && (oa.showMetrics.value || oa.showSummary.value || oa.flagVacancies.value)) {
                metrics = nodeMetrics(
                    hierarchy,
                    (i) => model.nodes[i].measure,
                    (i) => oa.flagVacancies.value && isVacancy(model.nodes[i].name, model.nodes[i].title),
                    { wide: oa.spanWide.value || DEFAULT_SPAN.wide, narrow: oa.spanNarrow.value || DEFAULT_SPAN.narrow },
                );
                if (oa.showSummary.value) summary = summarize(metrics, hierarchy);
            }

            const rules: CFRule[] = proRules && this.settings.rules.enabled.value
                ? parseRules(this.settings.rules.definition.value || "")
                : [];

            let dotted: DottedLink[] = [];
            if (proDotted && model.hasSecondaryParent) {
                dotted = visibleDottedLinks(
                    resolveDottedLines(keys, hierarchy.parentIdx, model.nodes.map((n) => n.secondaryParentKey)).links,
                    hidden,
                );
            }

            // Compare two snapshots from `model.periodRows`, NOT from
            // `model.nodes`. A person present in both periods occupies one row
            // per period, so those rows are duplicate keys and `nodes` keeps
            // only the first — comparing that would report everyone in the
            // later period as a leaver and could never detect a mover, since a
            // mover is by definition present in both.
            const changes = proTemporal ? this.periodChanges(model) : null;
            const changeOf: Map<string, ChangeKind> | null = changes ? changes.kindOf : null;

            this.notes = proNotes ? NotesStore.parse(oa.notes.value || "") : new NotesStore();

            // Rules override the palette; the base colour stays the fallback.
            const baseColorOf = colorOf;
            const ruleColorOf = (i: number): string => {
                if (rules.length === 0) return baseColorOf(i);
                const m = metrics ? metrics[i] : null;
                const ctx: RuleContext = {
                    measure: model.nodes[i].measure,
                    branchTotal: m ? m.branchTotal : null,
                    directReports: hierarchy.children[i].length,
                    totalDescendants: m ? m.totalDescendants : 0,
                    depth: hierarchy.depth[i],
                    layersBelow: m ? m.layersBelow : 0,
                    group: model.nodes[i].group,
                    name: model.nodes[i].name,
                    title: model.nodes[i].title,
                    span: m ? m.span : "leaf",
                    vacant: m ? m.vacant : false,
                };
                const hit = firstMatch(rules, ctx);
                return hit ? hit.color : baseColorOf(i);
            };

            renderTree(this.viewport as never, model.nodes, hierarchy, layout, {
                orientation: this.settings.layout.orientation.value.value as Orientation,
                connectorStyle: this.settings.connectors.style.value.value as ConnectorStyle,
                connectorWidth: this.settings.connectors.width.value,
                connectorColor: hc ? surface.connector : (this.settings.connectors.color.value.value || surface.connector),
                cardWidth: this.settings.nodes.cardWidth.value,
                cardHeight: this.settings.nodes.cardHeight.value,
                cornerRadius: this.settings.nodes.cornerRadius.value,
                showPhoto: this.settings.nodes.showPhoto.value,
                photoOk: (uri: string) => this.photoStatus.get(uri) === "ok",
                photoShape: String(this.settings.nodes.photoShape.value.value) as PhotoShape,
                photoSize: this.settings.nodes.photoSize.value,
                photoRing: this.settings.nodes.photoRing.value,
                // Blank means "follow the card's accent"; the renderer resolves it.
                photoRingColor: this.settings.nodes.photoRingColor.value.value || "",
                photoRingWidth: this.settings.nodes.photoRingWidth.value,
                photoFallback: String(this.settings.nodes.photoFallback.value.value) as PhotoFallback,
                showMeasure: this.settings.nodes.showMeasure.value,
                showTitle: this.settings.labels.showTitle.value,
                nameSize: this.settings.labels.nameSize.value,
                titleSize: this.settings.labels.titleSize.value,
                accentBar: this.settings.colors.accentBar.value,
                surface,
                colorOf: ruleColorOf,
                collapsed,
                // The span numbers the "Show span metrics" control promises
                // on the card. `metrics` is already null unless the licence allows
                // orgAnalytics, so this needs no second gate (OC-QA-16 / OC-015).
                metricOf: (metrics && this.settings.orgAnalysis.showMetrics.value)
                    ? (i: number) => ({
                        direct: hierarchy.children[i].length,
                        span: String(metrics[i].span),
                    })
                    : null,
                vacantOf: (metrics && oa.flagVacancies.value) ? (i: number) => metrics[i].vacant : null,
                strokeWidth: palette.strokeWidth,
                dashOf,
                highContrast: palette.highContrast,
            });

            renderDottedLines(this.viewport as never, dotted, layout, {
                orientation: this.settings.layout.orientation.value.value as Orientation,
                cardWidth: this.settings.nodes.cardWidth.value,
                cardHeight: this.settings.nodes.cardHeight.value,
                color: surface.muted,
                width: this.settings.connectors.width.value,
            });

            this.bindInteraction(keys, model, hierarchy, hidden, metrics, palette, ruleColorOf);
            this.renderStatus(model, hierarchy, w, h, surface.muted, summary, changeOf);

            // Legend — drawn after the status line, which clears `chrome`, and
            // above it so the two never share a row.
            if (legendOn) {
                const mode = String(this.settings.colors.colorMode.value.value);
                let items: LegendItem[] = [];
                if (mode === "group") {
                    // In slot order, so a filter can drop a legend entry but never
                    // reorder or recolour the others (#2).
                    items = model.groups
                        .map((gname) => ({ gname, slot: this.groupSlots.get(gname) ?? 0 }))
                        .sort((a, b) => a.slot - b.slot)
                        .map(({ gname, slot }) => ({
                            label: gname,
                            color: this.slotColor(palette, slot),
                            dash: palette.groupDash(slot),
                        }));
                } else {
                    const depths = Array.from(new Set(hierarchy.depth
                        .filter((_d, i) => !hidden.has(i)))).sort((a, b) => a - b);
                    items = depths.map((d) => ({
                        label: this.loc.fmt("Legend_Level", d + 1),
                        color: palette.groupColor(d, `level-${d}`),
                        dash: palette.groupDash(d),
                    }));
                }
                const legendY = h - 8 - 22;
                const band = this.rowSpan(legendY - 13, legendY + 4, w);
                renderLegend(this.chrome, {
                    items,
                    x: band.x,
                    // `rowSpan` already steps clear of every piece of chrome in
                    // this row — the gear, the view switch and, since OC-034, the
                    // quick-action bar wherever the author put it. The old
                    // hard-coded right margin assumed the bar was always
                    // bottom-right and shortened the legend for no reason
                    // whenever it was not.
                    maxWidth: Math.max(0, band.right - band.x),
                    y: legendY,
                    fontPx: 11,
                    fg: surface.muted,
                    highContrast: hc,
                    strokeWidth: palette.strokeWidth,
                    moreLabel: (n) => this.loc.fmt("Legend_More", n),
                    title: this.loc.get("Legend_Title"),
                });
            }

            // Search — visibility follows the setting; the query survives a
            // re-render, so the emphasis is re-applied rather than rebuilt.
            if (this.searchBox) {
                this.searchBox.setVisible(
                    this.settings.overlays.showSearch.value && this.allowInteractions,
                );
                // Chrome stands down when the canvas cannot hold it, the way the
                // gear and the zoom controls already do.
                this.searchBox.setViewport(this.searchWidth);
                this.searchBox.setTheme({
                    fg: surface.fg,
                    bg: hc ? surface.bg : "#FFFFFF",
                    stroke: surface.cardStroke,
                    accent: hc ? surface.fg : accent,
                });
                this.searchBox.setNodes(model.nodes.map((n) => ({
                    key: n.key, name: n.name, title: n.title,
                })));
            }
            this.paintSearch();
            // After the status line: renderStatus clears `chrome`, and the
            // buttons live there so the fit transform never moves them.
            this.renderZoomControls(w, h, palette);
            this.renderPanHint(w, h, surface.muted);
            // Both live in layers of their own, so neither is cleared by the
            // status line — and both answer to the live transform.
            this.updateMinimap();
            this.updateLens();
            this.syncOverlay(w, h);
            this.reportDataQuality(model, hierarchy, keys, parents);
            this.finish(options);
        } catch (e) {
            this.events.renderingFailed(options, String(e));
        }
    }

    /**
     * Wire every interaction: cross-filter, context menu, tooltips, keyboard
     * navigation and collapse.
     *
     * `allowInteractions` is false on non-interactive surfaces (dashboard
     * tiles). Click, context menu and keyboard activation must no-op there —
     * but tooltips stay on, which is Microsoft's documented best practice.
     */
    private bindInteraction(
        keys: string[],
        model: OrgModel,
        hierarchy: Hierarchy,
        hidden: ReadonlySet<number>,
        metrics: NodeMetrics[] | null,
        palette: ResolvedPalette,
        /** The colour each card is actually painted — the tooltip shows the same one. */
        colorOf: (i: number) => string,
    ): void {
        const self = this;
        const cards = this.viewport.selectAll<SVGGElement, number>("g.card");

        bindSelection(cards, model.nodes, this.selectionManager,
            () => self.repaintEmphasis(model, palette), this.allowInteractions);
        // ONE canvas-click binding. d3's `.on("click")` replaces any previous
        // handler for the same type, so a second call here silently disables the
        // first — which is exactly how clicking the background stopped clearing
        // the cross-filter when the branded hover card was added.
        bindCanvasClear(this.svg, this.selectionManager, () => {
            if (this.overlayTooltip) this.overlayTooltip.hide();
            self.repaintEmphasis(model, palette);
        }, this.allowInteractions);

        // ── Tooltips — always on, interactive or not ───────────────────────
        // One content builder feeds both surfaces: "Zentrix card" is the family's
        // branded chrome, "Power BI" is the host's own tooltip service (which is
        // also what report-page tooltips require). Never a difference in what the
        // reader is told — only in what draws it.
        const inputFor = (i: number): TooltipInput => ({
            node: model.nodes[i],
            measureLabel: model.measureLabel || this.loc.get("Tooltip_Measure"),
            groupLabel: model.groupLabel || this.loc.get("Tooltip_Group"),
            directReports: hierarchy.children[i].length,
            metrics: metrics ? metrics[i] : null,
            note: this.notes.get(model.nodes[i].key) || null,
            extra: model.tooltipColumns.map((c) => ({
                displayName: c.displayName,
                value: String(c.values[model.nodes[i].index] ?? ""),
            })),
            /*
             * The swatch is the card's OWN colour (OC-042 — CEO: "tooltip color
             * not changing"). It was `groupColor(0)` for every person, so the
             * dot beside the header was the first palette entry whoever you
             * hovered: it never followed the colour mode, the accent picker, the
             * report theme or a conditional-format rule. `colorOf` is the
             * function the renderer paints with, rules included, so the two
             * cannot drift.
             */
            color: colorOf(i),
        });

        const style = this.settings.overlays.tooltipStyle.value.value as TooltipStyle;
        // Clear BOTH tooltip surfaces before binding one of them. `renderTree`
        // reuses the same `g.card` elements through a keyed data join, so a
        // handler bound in one mode outlives every later mode change: with Card
        // as the default, "Power BI" and "Off" both went on showing the Zentrix
        // card and the native tooltip could never appear at all (OC-QA-15, and
        // the mechanism behind OC-005's two open tooltip notes).
        if (this.overlayTooltip) this.overlayTooltip.hide();
        cards.on("mousemove.tip", null).on("mouseleave.tip", null)
            .on("pointerover", null).on("pointerout", null).on("pointermove", null);

        if (style === "native" && this.tooltipWrapper) {
            this.tooltipWrapper.addTooltip<number>(
                cards,
                (i: number) => buildTooltip(inputFor(i)),
                (i: number) => model.nodes[i].selectionId as never,
            );
        } else if (style === "card" && this.overlayTooltip) {
            const tip = this.overlayTooltip;
            tip.setTheme({
                dark: false,
                bg: palette.highContrast ? palette.surface.bg : "#FFFFFF",
                fg: palette.surface.fg,
                muted: palette.surface.muted,
                strong: palette.surface.fg,
                accent: palette.highContrast ? palette.surface.fg : accent,
                pos: posSafe, neg: negSafe, fontFamily,
            });
            // Edit mode only — see `editing`. The setting still owns whether it
            // is wanted at all; this owns where it is allowed.
            tip.setBranding(this.settings.branding.showBranding.value && this.editing);
            cards
                .on("mousemove.tip", (event: MouseEvent, i: number) => {
                    // The gear owns the pointer while it is open.
                    if (this.overlay && this.overlay.isOpen()) { tip.hide(); return; }
                    tip.show(
                        overlayContent(inputFor(i), this.loc.get("Tooltip_DirectReports")),
                        event.clientX, event.clientY,
                    );
                })
                .on("mouseleave.tip", () => tip.hide());
        }

        // ── Keyboard navigation across the tree ────────────────────────────
        const visible = (n: number): boolean => !hidden.has(n) && isFinite(n);
        cards.on("keydown.nav", function (event: KeyboardEvent, i: number) {
            if (!isNavKey(event.key)) return;
            const target = nextFocus(
                hierarchy, i, event.key,
                self.settings.layout.orientation.value.value as Orientation,
                visible,
            );
            if (target === null) return;
            event.preventDefault();
            event.stopPropagation();
            self.focusIndex = target;
            const nodes = self.viewport.selectAll<SVGGElement, number>("g.card").nodes();
            for (const el of nodes) {
                if (select(el).datum() === target) { (el as SVGGElement).focus(); break; }
            }
        });

        // ── Collapse toggle — stops propagation so expanding never filters ──
        cards.each(function (i) {
            select(this).select("g.card-toggle").on("click", (ev: MouseEvent) => {
                ev.stopPropagation();
                const key = keys[i];
                if (self.collapsedKeys.has(key)) self.collapsedKeys.delete(key);
                else self.collapsedKeys.add(key);
                self.persistCollapsed(keys);
                if (self.lastOptions) self.update(self.lastOptions);
            });
        });

        this.repaintEmphasis(model, palette);
    }

    /**
     * Re-apply emphasis without a re-layout.
     *
     * The user's own selection wins over a host highlight, because a click is
     * the more recent intent. Dim opacity comes from the palette so high
     * contrast uses Microsoft's documented 40%.
     */
    private repaintEmphasis(model: OrgModel, palette: ResolvedPalette): void {
        const cards = this.viewport.selectAll<SVGGElement, number>("g.card");
        const ids = this.selectionManager.getSelectionIds() as powerbi.visuals.ISelectionId[];
        if (ids && ids.length > 0) {
            applySelectionDim(cards, model.nodes, ids, palette.dimOpacity);
            return;
        }
        applyHighlightDim(cards, model.nodes, model.hasHighlights, palette.dimOpacity);
    }

    /**
     * The colour (and, in high contrast, the dash) of every card. One accessor
     * for the chart AND the table, so a group's dot in the table is always the
     * colour of its cards.
     */
    private cardColors(model: OrgModel, hierarchy: Hierarchy, palette: ResolvedPalette): {
        colorOf: (i: number) => string; dashOf: (i: number) => string;
    } {
        const colorMode = this.settings.colors.colorMode.value.value as ColorMode;
        const single = this.settings.colors.cardFill.value.value || accentStrong;
        const slotOf = (g: string): number => this.groupSlots.get(g) ?? 0;
        const colorOf = (i: number): string => {
            if (palette.highContrast) return palette.groupColor(0);
            if (colorMode === "single") return single;
            if (colorMode === "level") return palette.groupColor(hierarchy.depth[i], `level-${hierarchy.depth[i]}`);
            const g = model.nodes[i].group;
            return g === null ? single : this.slotColor(palette, slotOf(g));
        };
        // High contrast encodes groups by DASH, never colour.
        const dashOf = (i: number): string => {
            if (!palette.highContrast) return "";
            if (colorMode === "level") return palette.groupDash(hierarchy.depth[i]);
            const g = model.nodes[i].group;
            return g === null ? "" : palette.groupDash(slotOf(g));
        };
        return { colorOf, dashOf };
    }

    /**
     * A group's colour, by its SLOT — never by where it first appears in the rows.
     *
     * zentrix-org-chart#2 (OC-QA-12): excluding one person or re-sorting recoloured
     * six of eight groups, WITH the report theme on. 13c already asked the host for
     * `getColor(groupValue)`, so the host's palette is not stable across a filter in
     * Desktop (Microsoft documents no stability contract for it). The visual owns the
     * assignment instead: a value keeps its slot for good (`groupSlots`, persisted),
     * and with the theme on the host is asked for the SLOT keys in slot order every
     * render, so whatever the host's allocation policy, slot n is always the same
     * theme colour.
     */
    private slotColor(palette: ResolvedPalette, slot: number): string {
        return palette.groupColor(slot, `zx-slot-${slot}`);
    }

    /** Give every group a slot: stored ones first, then new values in first-seen
     *  order at the next free slot. Existing slots never move. */
    private syncGroupSlots(model: OrgModel, dataView: DataView | undefined, palette: ResolvedPalette): void {
        const obj = (dataView?.metadata?.objects as { colorStore?: { groupSlots?: unknown } } | undefined)?.colorStore;
        const stored = typeof obj?.groupSlots === "string" ? obj.groupSlots : "";
        if (this.pendingSlots !== null && stored === this.pendingSlots) this.pendingSlots = null;
        if (this.pendingSlots === null && stored !== this.lastSlotsBlob) {
            // The report's map wins (a bookmark, Undo, another author's save);
            // anything only this session knew about is kept after it.
            const parsed = parseSlots(stored);
            if (parsed.size) {
                for (const [g, s] of this.groupSlots) if (!parsed.has(g)) parsed.set(g, nextFree(parsed, s));
                this.groupSlots = parsed;
            }
            this.lastSlotsBlob = stored;
        }
        let added = false;
        for (const g of model.groups) {
            if (!this.groupSlots.has(g)) { this.groupSlots.set(g, nextFree(this.groupSlots)); added = true; }
        }
        // Theme on: request the slot keys in slot order, so the host hands out its
        // colours in the same order on every render.
        if (!palette.highContrast && this.settings.colors.useReportTheme.value) {
            let max = -1;
            this.groupSlots.forEach((s) => { if (s > max) max = s; });
            for (let s = 0; s <= max; s++) this.slotColor(palette, s);
        }
        if (added && this.groupSlots.size <= MAX_STORED_SLOTS) {
            const blob = JSON.stringify(Array.from(this.groupSlots.entries()).sort((a, b) => a[1] - b[1]));
            if (blob !== this.lastSlotsBlob) {
                this.lastSlotsBlob = blob;
                this.pendingSlots = blob;
                this.host.persistProperties({
                    merge: [{ objectName: "colorStore", selector: null, properties: { groupSlots: blob } }],
                } as powerbi.VisualObjectInstancesToPersist);
            }
        }
    }

    /**
     * Joiners / leavers / movers between the two most recent periods, when
     * "Compare periods" is on and a Period is bound.
     *
     * Compared from `model.periodRows`, NOT from `model.nodes`. A person present
     * in both periods occupies one row per period, so those rows are duplicate
     * keys and `nodes` keeps only the first — comparing that would report
     * everyone in the later period as a leaver and could never detect a mover,
     * since a mover is by definition present in both.
     */
    private periodChanges(model: OrgModel): { kindOf: Map<string, ChangeKind>; from: string; to: string } | null {
        if (!model.hasPeriod || !this.settings.orgAnalysis.compareperiods.value) return null;
        const rows = model.periodRows;
        const pair = defaultComparison(periodsOf(rows.periods));
        if (!pair) return null;
        const kindOf = diffPeriods(
            snapshotAt(rows.keys, rows.parents, rows.periods, pair.from),
            snapshotAt(rows.keys, rows.parents, rows.periods, pair.to),
            pair.from, pair.to,
        ).kindOf;
        return { kindOf, from: pair.from, to: pair.to };
    }

    /* ── the view switch (OC-029) ─────────────────────────────────────────── */

    /**
     * The corner the gear occupies, or null when it is not drawn.
     *
     * ⚠️ Auto is BOTTOM-RIGHT since OC-034 (CEO, 2026-09-20). OC-020 had moved it
     * to top-right; the quick-action bar now owns that corner, and the gear sits
     * with the view switch in the bottom one. Read `GEAR_AUTO_CORNER`, never a
     * literal — three call sites used to carry "tr" separately and one of them
     * (`syncOverlay`) ignored the setting altogether.
     */
    private gearCorner(): string | null {
        if (!this.overlay || !this.settings.toolbar.show.value || !this.allowInteractions) return null;
        const pref = String(this.settings.toolbar.position.value.value || "auto");
        return pref === "auto" ? GEAR_AUTO_CORNER : pref;
    }

    /** The corner the quick-action bar occupies, or null when it is not drawn. */
    private actionCorner(): ActionCorner | null {
        if (!this.zoom || !this.allowInteractions) return null;
        if (this.settings.toolbar.actions.value === false) return null;
        const pref = String(this.settings.toolbar.actionsPosition.value.value || "tr");
        return (pref === "tl" || pref === "bl" || pref === "br" ? pref : "tr") as ActionCorner;
    }

    /** The corner at the other end of the same column. */
    private static opposite(corner: string): string {
        return (corner.charAt(0) === "t" ? "b" : "t") + corner.charAt(1);
    }

    /** True when the gear or the view switch already sits in `corner`. */
    private cornerTaken(corner: string): boolean {
        if (this.gearCorner() === corner) return true;
        return this.pillBox() !== null && this.pillCorner === corner;
    }

    /**
     * The quick-action bar's box, from the SAME geometry the renderer uses.
     *
     * The gear and the pill are 36px tall and sit side by side when they share a
     * corner, so one clearance covers both — the bar steps past that band, not
     * past each piece in turn.
     */
    private actionBarBox(): ScreenRect | null {
        const corner = this.actionCorner();
        if (!corner || !this.lastOptions) return null;
        const vp = this.lastOptions.viewport;
        /*
         * The obstacle reserves the bar at its LARGEST — five buttons whenever
         * they could be wanted — rather than at the size being drawn right now.
         *
         * "Show everything" appears only when the readable fit is a crop, and
         * whether it is a crop is decided BY the fit this obstacle feeds. Asking
         * the live answer made the fit one render stale: a card was drawn under a
         * bar that had grown since (found by the COVER gate at 640×400). Over-
         * reserving by one button is the same trade the minimap makes.
         */
        const plan = planActionBar({
            width: vp.width,
            height: vp.height,
            corner,
            lens: this.lensOffered(),
            fullView: true,
            cornerInset: this.cornerTaken(corner) ? GEAR_CLEARANCE : 0,
            farInset: this.cornerTaken(Visual.opposite(corner)) ? GEAR_CLEARANCE : 0,
        });
        return plan ? plan.rect : null;
    }

    /** Whether the lens button is drawn at all. */
    private lensOffered(): boolean {
        return this.settings.toolbar.lens.value !== false && this.allowInteractions;
    }

    /**
     * Decide whether the Chart / Table / Insight pill shows, and where.
     *
     * Hidden on non-interactive surfaces (a dashboard tile cannot be clicked),
     * on a viewport too small to hold it (the same cut-off as the gear), and when
     * the author has turned both Table and Insight off. Any of those returns the
     * canvas to the chart, so a reader is never stranded in a view with no way out.
     *
     * Its corner is the author's (`summaryTable.position`); Auto is top right,
     * beside the gear. Sharing a corner with the gear, it steps to the gear's
     * inner side and lines up with it — both are 36px tall with the same margins.
     */
    private syncViewSwitch(w: number, h: number, palette: ResolvedPalette): void {
        const vt = this.viewToggle;
        this.pillRect = null;
        if (!vt) return;
        const s = this.settings;
        vt.setSegments({ table: s.summaryTable.show.value, insight: s.insights.show.value });
        // The segment the reader was in may just have been switched off.
        if (this.viewMode !== "chart" && vt.current() === "chart") this.viewMode = "chart";
        const tooSmall = w < 220 || h < 160;
        if (!vt.hasAlternateView() || !this.allowInteractions || tooSmall) {
            this.viewMode = "chart";
            vt.set("chart");
            vt.hide();
            return;
        }
        vt.set(this.viewMode);
        vt.setTheme(palette.surface, palette.highContrast);
        vt.setCompact(w < 560);
        vt.show();
        const pref = String(s.summaryTable.position.value.value || "auto");
        const corner = pref === "auto" ? GEAR_AUTO_CORNER : pref;
        this.pillCorner = corner;
        const pw = vt.width();
        const beside = this.gearCorner() === corner ? 36 + 8 : 0;
        const x = Math.max(0, corner.charAt(1) === "l" ? 18 + beside : w - 18 - beside - pw);
        const y = corner.charAt(0) === "t" ? 16 : h - 16 - PILL_HEIGHT;
        vt.placeAt(x, y);
        this.pillRect = { x, y, w: pw, h: PILL_HEIGHT };
    }

    /** The pill's box, for the fit and the chrome rows to steer around. */
    private pillBox(): ScreenRect | null {
        return this.viewToggle && this.viewToggle.isShown() ? this.pillRect : null;
    }

    /** True when the bottom-right corner is taken — by the gear or the pill. */
    private bottomRightTaken(): boolean {
        return this.cornerTaken("br");
    }

    /**
     * Draw the Table or the Insight read-out in place of the chart.
     *
     * Both cover EVERYONE, including people inside collapsed branches —
     * collapsing is a way of looking at the chart, not a filter on the data. The
     * numbers come from the same `nodeMetrics` the cards use, computed here
     * whether or not the Org analysis toggles are on: the views are their own
     * reason to have them.
     */
    private renderAltView(model: OrgModel, hierarchy: Hierarchy, palette: ResolvedPalette): void {
        const root = this.root;
        if (!root) return;
        const kind = this.viewMode;
        // The chart is not on screen, so neither is the thumbnail of it.
        this.hideChartOverlays();
        // A host update rebuilds the view; keep the reader where they were in it.
        const prevScroll = this.altEl && this.altKind === kind ? this.altEl.scrollTop : 0;
        this.removeAltView();
        this.svg.style("display", "none");
        if (this.searchBox) this.searchBox.setVisible(false);
        if (this.overlayTooltip) this.overlayTooltip.hide();

        const surface = palette.surface;
        const hc = palette.highContrast;
        const oa = this.settings.orgAnalysis;
        const thresholds = {
            wide: oa.spanWide.value || DEFAULT_SPAN.wide,
            narrow: oa.spanNarrow.value || DEFAULT_SPAN.narrow,
        };
        const flagVacancies = oa.flagVacancies.value;
        const metrics = nodeMetrics(
            hierarchy,
            (i) => model.nodes[i].measure,
            (i) => flagVacancies && isVacancy(model.nodes[i].name, model.nodes[i].title),
            thresholds,
        );
        const summary = summarize(metrics, hierarchy);
        const changes = this.license.allows("temporal") ? this.periodChanges(model) : null;
        const hasMeasure = model.nodes.some((n) => n.measure !== null);
        const hasGroup = model.groups.length > 0;
        const format = this.numberFormatter();

        // Keep the rows the floating chrome sits in clear, so the gear and the
        // pill never cover the table's own search box or a headline.
        const gear = this.gearCorner();
        const pill = this.pillBox() ? this.pillCorner : null;
        const inTop = (c: string | null): boolean => c !== null && c.charAt(0) === "t";
        const inBottom = (c: string | null): boolean => c !== null && c.charAt(0) === "b";
        const insetTop = inTop(gear) || inTop(pill) ? 44 : 0;
        const insetBottom = inBottom(gear) || inBottom(pill) ? 44 : 0;

        if (kind === "insight") {
            let counts: { joiners: number; leavers: number; movers: number } | null = null;
            if (changes) {
                counts = { joiners: 0, leavers: 0, movers: 0 };
                changes.kindOf.forEach((k) => {
                    if (k === "joiner") counts!.joiners++;
                    else if (k === "leaver") counts!.leavers++;
                    else if (k === "mover") counts!.movers++;
                });
            }
            const narrative = computeOrgNarrative({
                names: model.nodes.map((n) => n.name),
                hierarchy, metrics, summary, thresholds,
                groups: hasGroup ? model.nodes.map((n) => n.group) : undefined,
                groupLabel: model.groupLabel,
                measure: hasMeasure
                    ? { label: model.measureLabel || "Measure", values: model.nodes.map((n) => n.measure), format }
                    : null,
                vacanciesFlagged: flagVacancies,
                changes: changes && counts ? { from: changes.from, to: changes.to, ...counts } : null,
                quality: { duplicateRows: model.duplicateRows, keylessRows: model.keylessRows },
            });
            // Say so rather than let a reader assume the read-out follows a highlight.
            if (model.hasHighlights) narrative.subhead += " · covers everyone, not only the highlighted people";
            this.altEl = renderInsightView(root, narrative, surface, {
                hc,
                onAction: (a: InsightAction) => this.showOnChart(a.index),
                insetTop, insetBottom,
            });
        } else {
            const { colorOf } = this.cardColors(model, hierarchy, palette);
            const canExport = this.license.allows("export") && this.downloadService() !== null;
            this.altEl = renderSummaryTable(root, buildOrgRows(model, hierarchy, metrics, changes ? changes.kindOf : null), surface, {
                summary, thresholds,
                hasTitle: model.nodes.some((n) => n.title !== ""),
                hasGroup,
                groupLabel: model.groupLabel,
                hasMeasure,
                measureLabel: model.measureLabel,
                vacanciesFlagged: flagVacancies,
                hasChanges: changes !== null,
                hasHighlights: model.hasHighlights,
                colorOf,
                formatNumber: format,
                hc,
                onExport: canExport ? (rows) => this.exportTableCsv(rows) : undefined,
                onActivate: (i) => this.showOnChart(i),
                initial: this.tableState,
                onStateChange: (st) => this.persistTableState(st),
                initialQuery: this.tableQuery,
                onQuery: (q) => { this.tableQuery = q; },
                insetTop, insetBottom,
            });
        }
        this.altKind = kind;
        if (prevScroll) this.altEl.scrollTop = prevScroll;
    }

    /** Chart-only chrome, down: the landing page and the alternate views own the canvas. */
    private hideChartOverlays(): void {
        if (this.mapLayer) clearMinimap(this.mapLayer);
        if (this.lensLayer) clearLens(this.lensLayer);
        this.lensPoint = null;
    }

    private removeAltView(): void {
        if (this.altEl && this.altEl.parentNode) this.altEl.parentNode.removeChild(this.altEl);
        this.altEl = null;
        this.altKind = null;
    }

    /** Nothing to tabulate: drop the alternate view and the switch, restore the canvas. */
    private leaveAltViews(): void {
        this.removeAltView();
        this.svg.style("display", null);
        this.pillRect = null;
        if (this.viewToggle) this.viewToggle.hide();
    }

    /**
     * From the Table or a finding in the Insight view, back to the chart, centred
     * on that person — with their branch opened if it was collapsed — and at a
     * scale where their card can be read.
     */
    private showOnChart(index: number): void {
        this.viewMode = "chart";
        if (this.viewToggle) this.viewToggle.set("chart");
        if (this.lastOptions) this.update(this.lastOptions);
        this.jumpTo(index, 1);
        try {
            const cards = this.viewport.selectAll<SVGGElement, number>("g.card").nodes();
            for (const el of cards) {
                if (select(el).datum() === index) { el.focus(); this.focusIndex = index; break; }
            }
        } catch { /* focus is a courtesy; the jump already happened */ }
    }

    /** Locale-aware numbers for totals the host did not format for us. */
    private numberFormatter(): (v: number) => string {
        try {
            const nf = new Intl.NumberFormat(this.loc.locale || "en-US", { maximumFractionDigits: 2 });
            return (v: number) => nf.format(v);
        } catch {
            return (v: number) => String(Math.round(v * 100) / 100);
        }
    }

    private downloadService(): { exportVisualsContent: (c: string, f: string, t: string, d: string) => Promise<unknown> } | null {
        const svc = (this.host as unknown as {
            downloadService?: { exportVisualsContent?: (c: string, f: string, t: string, d: string) => Promise<unknown> };
        }).downloadService;
        return svc && typeof svc.exportVisualsContent === "function"
            ? svc as { exportVisualsContent: (c: string, f: string, t: string, d: string) => Promise<unknown> }
            : null;
    }

    /**
     * The table's rows and columns as shown, through the host's download service
     * (the ExportContent privilege). No network call; the tenant's admin switch
     * decides whether the download is allowed, and we never work around it.
     */
    private exportTableCsv(rows: Array<Array<string | number | null>>): void {
        const svc = this.downloadService();
        if (!svc || !this.license.allows("export")) return;
        try {
            void Promise.resolve(svc.exportVisualsContent(toCsv(rows), safeFileName("org-chart-people", "csv"), "csv", "People table"))
                .catch(() => { /* a refused download must never break the visual */ });
        } catch { /* ditto, for a host that throws synchronously */ }
    }

    /** Restore the table's columns / sort / folded cards from `tableState` — the
     *  colour-store pattern: an unconfirmed write of ours wins over a stale echo. */
    private hydrateTableState(dataView: DataView | undefined): void {
        const obj = (dataView?.metadata?.objects as { tableState?: { data?: unknown } } | undefined)?.tableState;
        const stored = typeof obj?.data === "string" ? obj.data : "";
        if (this.pendingTableState != null) {
            if (stored === this.pendingTableState) this.pendingTableState = null;
            else return;
        }
        this.tableState = parseTableState(stored);
        this.lastTableBlob = stored;
    }

    private persistTableState(state: TableState): void {
        const blob = JSON.stringify(state);
        this.tableState = state;
        if (blob === this.lastTableBlob) return;
        this.lastTableBlob = blob;
        this.pendingTableState = blob;
        this.host.persistProperties({
            merge: [{ objectName: "tableState", selector: null, properties: { data: blob } }],
        } as powerbi.VisualObjectInstancesToPersist);
    }

    /**
     * Ask the host for the next data segment.
     *
     * The categorical window is 30,000 rows; a large org exceeds that. Segments
     * accumulate (`aggregateSegments = true`) so each update carries everything
     * fetched so far. Only worth doing when the tier is uncapped — the free tier
     * renders 500 people and would just burn the 100 MB budget.
     *
     * Source: learn.microsoft.com/power-bi/developer/visuals/fetch-more-data
     */
    private maybeFetchMore(dataView: DataView | undefined): void {
        if (!this.license.allows("scale")) return;
        if (!dataView || !dataView.metadata || !dataView.metadata.segment) return;
        if (typeof this.host.fetchMoreData !== "function") return;
        try {
            // Returns false at the host's 100 MB ceiling — stop rather than retry.
            this.host.fetchMoreData(true);
        } catch {
            // Never let a paging failure break the render.
        }
    }

    /**
     * Surface data problems the permissive hierarchy contract absorbed.
     * The chart keeps rendering; the header just stops being silent about a
     * genuine data bug. Cleared automatically by the host on every render.
     */
    private reportDataQuality(model: OrgModel, h: Hierarchy, keys: string[], parents: Array<string | null>): void {
        const q = assessQuality(
            keys, parents, h.cycleBroken.length, h.roots.length,
            model.capped ? model.totalRows - model.nodes.length : 0,
            // Counted by the transform, because nothing downstream can see them.
            { duplicateRows: model.duplicateRows, keylessRows: model.keylessRows },
        );
        const warning = buildWarning(q);
        if (typeof this.host.displayWarningIcon !== "function") return;
        try {
            if (warning) {
                this.host.displayWarningIcon(warning.title, warning.detail);
                this.warned = true;
            } else if (this.warned) {
                // zentrix-org-chart#8 (OC-QA-35). Microsoft documents that the host
                // clears the icon "during each rendering of the visual"; in Desktop
                // a filter that makes the data clean did NOT clear it. API 5.11 has
                // no clear call, so the only lever is an empty warning — sent once,
                // on the warned → clean transition, never on an ordinary render.
                // Host-verified only; see the 1.0.0.0-20260920b handoff.
                this.host.displayWarningIcon("", "");
                this.warned = false;
            }
        } catch {
            // An older host without the API must not break the render.
        }
    }

    /**
     * Write collapse state back so it survives a refresh and lands in bookmarks.
     *
     * `markAutoDone` also records that the opening auto-collapse has run. It is
     * written even when nothing was collapsed — "this hierarchy fitted" is just
     * as much a decision as "this one did not", and re-deciding it on every
     * refresh would re-collapse a tree the user had opened up.
     */
    /**
     * @param setLadder when given, the level ladder is rewritten to show exactly
     *                  this many levels — what the automatic collapse just chose.
     *                  Written in the SAME merge as the collapse state: two
     *                  synchronous `persistProperties` calls are coalesced by the
     *                  host and all but the last are lost.
     */
    private persistCollapsed(keys: string[], markAutoDone = false, setLadder?: number): void {
        const idx = new Set<number>();
        for (let i = 0; i < keys.length; i++) if (this.collapsedKeys.has(keys[i])) idx.add(i);
        const properties: Record<string, string | boolean> = {
            collapsed: serializeCollapsed(keys, idx),
        };
        if (markAutoDone) properties.collapseToFitDone = true;
        if (setLadder !== undefined) {
            // What the switches said before this rewrite — how a stale update
            // that races the write is recognised (see `applyLevelLadder`).
            this.prevLadder = levelLadder(this.settings);
            const ladder = Visual.ladderString(setLadder);
            for (let n = FIRST_LEVEL; n <= LAST_LEVEL; n++) {
                properties[`level${n}`] = ladder.charAt(n - FIRST_LEVEL) === "1";
            }
            properties.levelsApplied = ladder;
            this.writeLadderLocal(ladder);
            this.lastLadder = ladder;
            this.pendingLadder = ladder;
        }
        this.pendingCollapsed = properties.collapsed as string;
        this.host.persistProperties({
            merge: [{
                objectName: "layout",
                selector: null,
                properties,
            }],
        });
    }

    /* ── the per-level ladder (OC-035) ──────────────────────────────────── */

    /** The ladder string for "show N levels". */
    private static ladderString(shown: number): string {
        let out = "";
        for (let n = FIRST_LEVEL; n <= LAST_LEVEL; n++) out += n <= shown ? "1" : "0";
        return out;
    }

    /**
     * Move the switches to `to` without touching the chart — the gear catching
     * up with a view that changed under it. The collapse state is NOT written:
     * it is already what it is, and this is only the label on it.
     */
    private syncLadder(to: string, from: string): void {
        this.prevLadder = from;
        this.lastLadder = to;
        this.pendingLadder = to;
        this.writeLadderLocal(to);
        const properties: Record<string, string | boolean> = { levelsApplied: to };
        for (let n = FIRST_LEVEL; n <= LAST_LEVEL; n++) {
            properties[`level${n}`] = to.charAt(n - FIRST_LEVEL) === "1";
        }
        this.host.persistProperties({
            merge: [{ objectName: "layout", selector: null, properties }],
        });
    }

    /** Write a ladder string onto the model's switches, without persisting. */
    private writeLadderLocal(ladder: string): void {
        const lay = this.settings.layout as unknown as Record<string, { value: boolean | string }>;
        for (let n = FIRST_LEVEL; n <= LAST_LEVEL; n++) {
            lay[`level${n}`].value = ladder.charAt(n - FIRST_LEVEL) === "1";
        }
        this.settings.layout.levelsApplied.value = ladder;
    }

    /**
     * Apply the per-level ladder — once, when the AUTHOR moves it.
     *
     * The switches are an instruction, not a running constraint. Enforcing them
     * on every render would re-fold a branch the reader had just clicked open —
     * the mistake `collapseToFitDone` exists to avoid, and the one that makes a
     * ceiling-style design unusable here.
     *
     * Telling "the author moved a switch" from "the host has not echoed our own
     * write yet" is the same three-case problem `collapsed` has (OC-029,
     * zentrix-org-chart#3). `levelsApplied` travels in the SAME merge as the
     * switches and the collapse state, so:
     *   • it equals our unconfirmed write → the host confirmed it;
     *   • it changed some other way       → a bookmark, Undo, another author's
     *     save. Its collapse state came with it, so adopt and change nothing;
     *   • the switches came back as they were BEFORE our write → a stale update
     *     that raced it. Keep showing ours.
     * Anything else is a move, including a second move before the first is
     * echoed — blocking on `pending` alone wedged the ladder after one change
     * on any host that does not store (found by probe, jsdom + the gate sweep).
     */
    private applyLevelLadder(h: Hierarchy, keys: string[]): void {
        const hostApplied = this.settings.layout.levelsApplied.value || "";

        if (this.pendingLadder !== null && hostApplied === this.pendingLadder) {
            this.pendingLadder = null;
            this.lastHostLadder = hostApplied;
            this.lastLadder = hostApplied;
        } else if (this.lastHostLadder !== null && hostApplied !== this.lastHostLadder
            && this.pendingLadder === null) {
            // Restored from outside, with its own collapse state. Adopt it.
            this.lastHostLadder = hostApplied;
            if (hostApplied !== "") {
                this.lastLadder = hostApplied;
                this.writeLadderLocal(hostApplied);
            }
            return;
        }
        if (this.lastHostLadder === null) this.lastHostLadder = hostApplied;

        const ladder = levelLadder(this.settings);
        if (this.pendingLadder !== null) {
            // Our write, not yet back: nothing new to do.
            if (ladder === this.pendingLadder) return;
            // The switches came back as they were before it — a stale update
            // racing the write. Keep ours on screen rather than undoing it.
            if (ladder === this.prevLadder) { this.writeLadderLocal(this.pendingLadder); return; }
            // Otherwise the author moved it again. Fall through.
        }

        /*
         * What the CHART is showing, when the ladder can say it. A collapse set
         * that folds one branch and not its siblings is a fine view and a bad
         * ladder, so `uniformLevelsShown` returns null there and the switches
         * keep the author's last instruction rather than being rewritten.
         */
        const folded = new Set<number>();
        for (let i = 0; i < keys.length; i++) {
            if (this.collapsedKeys.has(keys[i]) && isParentNode(h, i)) folded.add(i);
        }
        const actual = uniformLevelsShown(h, folded, LAST_LEVEL);
        const truth = actual === null ? null : Visual.ladderString(actual);

        // First sight in this session: the stored collapse state is the author's
        // and outranks a default nobody touched — so the CHART is the truth and
        // the switches are made to say so.
        if (this.lastLadder === null) {
            this.lastLadder = ladder;
            if (truth !== null && truth !== ladder) this.syncLadder(truth, ladder);
            return;
        }
        if (ladder === this.lastLadder) {
            // The switches have not moved, but the chart may have — a branch
            // folded or opened by hand, or a collapse state restored from the
            // report. Keep the gear honest about what is on screen.
            if (truth !== null && truth !== ladder) this.syncLadder(truth, ladder);
            return;
        }

        /*
         * The author moved it. "Show N levels" means every parent shallower than
         * level N is open and every parent ON level N is folded; anything deeper
         * is already hidden and is left exactly as the reader left it, so
         * expanding back out restores the shape they had.
         */
        this.prevLadder = this.lastLadder;
        this.lastLadder = ladder;
        this.pendingLadder = ladder;
        const foldAt = levelsShown(ladder) - 1;         // 0-based depth whose children go
        for (let i = 0; i < keys.length; i++) {
            if (!isParentNode(h, i)) continue;
            if (h.depth[i] < foldAt) this.collapsedKeys.delete(keys[i]);
            else if (h.depth[i] === foldAt) this.collapsedKeys.add(keys[i]);
        }
        const idx = new Set<number>();
        for (let i = 0; i < keys.length; i++) if (this.collapsedKeys.has(keys[i])) idx.add(i);
        const collapsed = serializeCollapsed(keys, idx);
        this.pendingCollapsed = collapsed;
        this.settings.layout.levelsApplied.value = ladder;
        // ONE merge. Two synchronous `persistProperties` calls are coalesced by
        // the host and all but the last are dropped.
        this.host.persistProperties({
            merge: [{
                objectName: "layout", selector: null,
                properties: { collapsed, levelsApplied: ladder },
            }],
        });
    }

    /** Honest cap notice + the paid summary strip. Never a blank or error state. */
    private renderStatus(
        model: OrgModel, h: Hierarchy, w: number, vh: number, color: string,
        summary?: OrgSummary | null, changeOf?: Map<string, ChangeKind> | null,
    ): void {
        this.chrome.selectAll("*").remove();
        const bits: string[] = [];
        if (model.capped) bits.push(this.loc.fmt("Status_Showing", model.nodes.length, model.totalRows));
        if (summary) {
            bits.push([
                this.loc.fmt("Status_People", summary.people),
                this.loc.fmt("Status_Managers", summary.managers),
                this.loc.fmt("Status_Layers", summary.maxDepth + 1),
            ].join(" · "));
            if (summary.averageSpan !== null) bits.push(this.loc.fmt("Status_AvgSpan", summary.averageSpan.toFixed(1)));
            if (summary.wideSpans.length) bits.push(this.loc.fmt("Status_WideSpans", summary.wideSpans.length));
            if (summary.vacancies.length) bits.push(this.loc.fmt("Status_Vacancies", summary.vacancies.length));
        }
        if (changeOf) {
            let j = 0, l = 0, m = 0;
            changeOf.forEach((k) => { if (k === "joiner") j++; else if (k === "leaver") l++; else if (k === "mover") m++; });
            bits.push(this.loc.fmt("Status_Changes", j, l, m));
        }
        if (h.cycleBroken.length > 0) {
            bits.push(this.loc.fmt("Status_Cycles", h.cycleBroken.length));
        }
        if (h.roots.length > 1) bits.push(this.loc.fmt("Status_Roots", h.roots.length));
        // (The fit no longer crops — see refit(). The notice that used to live
        // here, tied to a floored fit, is now the live-view check above, which
        // also covers a reader who zoomed in or panned away.)
        if (bits.length === 0) return;
        const full = bits.join(" · ");
        const row = this.rowSpan(vh - 20, vh - 3, w);
        const line = this.chrome.append("text")
            .attr("class", "status-line")
            .attr("x", row.x).attr("y", vh - 8)
            .attr("font-family", fontFamily).attr("font-size", 11)
            .attr("fill", color)
            .attr("aria-label", full)
            .text(full);
        // Shortened to the canvas, never run off its edge (OC-028: 320px past the
        // right edge of a 200px tile). The full sentence stays in the aria-label.
        trimToWidth(line.node() as SVGTextElement, full, Math.max(0, row.right - row.x));
    }

    /**
     * Report the render finished — unless photos are still decoding, in which case
     * the probe callback re-draws and finishes. An export captures the page at
     * renderingFinished, so it must never be the frame with a placeholder in it.
     */
    private finish(options: VisualUpdateOptions): void {
        for (const st of this.photoStatus.values()) {
            if (st === "pending") { this.finishAfterPhotos = options; return; }
        }
        this.events.renderingFinished(options);
    }

    /**
     * Decode each distinct photo once (zentrix-org-chart#10, OC-QA-31). A data URI
     * never touches the network, so this stays inside certification. A payload that
     * is valid base64 but not an image fails here and the card gets its fallback,
     * instead of the browser's broken-image glyph.
     */
    private probePhotos(model: OrgModel): void {
        const Img = (typeof Image === "function" ? Image : null) as (new () => HTMLImageElement) | null;
        this.probing = true;
        try { this.startProbes(model, Img); } finally { this.probing = false; }
    }

    private startProbes(model: OrgModel, Img: (new () => HTMLImageElement) | null): void {
        for (const n of model.nodes) {
            const uri = n.photo;
            if (!uri || this.photoStatus.has(uri)) continue;
            if (!Img) { this.photoStatus.set(uri, "ok"); continue; }
            this.photoStatus.set(uri, "pending");
            try {
                const img = new Img();
                const settle = (ok: boolean): void => {
                    if (this.photoStatus.get(uri) !== "pending") return;
                    this.photoStatus.set(uri, ok && img.naturalWidth > 0 ? "ok" : "bad");
                    if (!this.probing) this.onPhotoSettled();
                };
                img.onload = () => settle(true);
                img.onerror = () => settle(false);
                img.src = uri;
            } catch {
                this.photoStatus.set(uri, "bad");
            }
        }
    }

    /** Once every probe has settled, draw again with the answers and finish. */
    private onPhotoSettled(): void {
        if (this.destroyed) return;
        for (const st of this.photoStatus.values()) if (st === "pending") return;
        const waiting = this.finishAfterPhotos;
        this.finishAfterPhotos = null;
        if (waiting) {
            // Re-enter the draw WITHOUT a new renderingStarted: this is the same
            // render, still open, and this pass closes it.
            this.redraw(waiting);
        } else if (this.lastOptions) {
            // That render was already closed by a newer update — this one is our
            // own, so it gets its own started / finished pair (G12-a chaos gate).
            this.update(this.lastOptions);
        }
    }

    private redraw(options: VisualUpdateOptions): void {
        this.redrawing = true;
        try { this.update(options); } finally { this.redrawing = false; }
    }

    /**
     * Put the search box in the top row, clear of a gear pinned top-left and of
     * the view switch. Idempotent: called before the fit so the fit can steer
     * around it, and the box keeps its state across renders.
     */
    private placeSearchBox(w: number): void {
        this.syncOverlay(w, this.lastOptions ? this.lastOptions.viewport.height : 0);
        if (!this.searchBox) return;
        // The gear can be pinned top-left, where the search box lives: start after it.
        const top = this.rowSpan(8, 34, w);
        this.searchInset = top.x - 10;
        // …and stop short of whatever holds the right end of the row — the
        // view switch, since OC-029. The box is its field plus ~80px of count
        // and button; setViewport reserves 110, hence the +30. On the open
        // canvas this is exactly the old width; beside the switch it shrinks,
        // and stands down where it cannot fit, like every other chrome piece.
        this.searchWidth = Math.min(w - this.searchInset, top.right - top.x + 30);
        this.searchBox.setLeft(top.x);
        this.searchBox.setVisible(this.settings.overlays.showSearch.value && this.allowInteractions);
        this.searchBox.setViewport(this.searchWidth);
    }

    /**
     * Hand the gear this render's settings, theme and corner.
     *
     * ⚠️ Before OC-034 this passed the literal `"tr"`, so **the Gear position
     * setting did nothing** — `gearCorner()` reported the author's corner to the
     * fit and the rows while the gear itself stayed top-right, and the two
     * disagreed. It now asks `gearCorner()`, which is the one place the Auto
     * corner is decided. Hidden on a viewport too small to hold it without
     * covering the chart.
     */
    private syncOverlay(w: number, h: number): void {
        if (!this.overlay) return;
        const tooSmall = w < 220 || h < 160;
        this.overlay.update(this.settings, false, tooSmall || !this.allowInteractions);
        const pref = String(this.settings.toolbar.position.value.value || "auto");
        this.overlay.setCorner(pref === "auto" ? GEAR_AUTO_CORNER : pref);
    }

    /** True when the gear occupies the bottom-right corner. */
    private gearAtBottomRight(): boolean {
        return this.gearCorner() === "br";
    }

    /**
     * "Part of the chart is off screen" — drawn as its own element because it has
     * to answer to the LIVE view, not to the last data render. A reader who zooms
     * in or pans away is looking at a window; the notice appears the moment that
     * is true and goes when it is not, without a re-render.
     */
    private renderPanHint(w: number, h: number, color: string): void {
        this.chrome.selectAll("text.pan-hint").remove();
        const full = this.loc.get("Status_Panned");
        const row = this.rowSpan(h - 20, h - 3, w);
        const hint = this.chrome.append("text")
            .attr("class", "pan-hint")
            // The status line's own row and start. The two used to share the row —
            // one centred, one left — and printed over each other as soon as the
            // reader zoomed with any notice showing (OC-028). Now they take turns.
            .attr("x", row.x).attr("y", h - 8)
            .attr("font-family", fontFamily).attr("font-size", 11)
            .attr("fill", color)
            .attr("opacity", 0)
            .text(full);
        trimToWidth(hint.node() as SVGTextElement, full, Math.max(0, row.right - row.x));
        this.updatePanHint();
    }

    /** Show or hide it against the transform on screen right now. */
    private updatePanHint(): void {
        const hint = this.chrome.select<SVGTextElement>("text.pan-hint");
        if (hint.empty() || !this.lastFit || !this.zoom) return;
        const t = this.zoom.current();
        const b = this.lastFit.bounds;
        const cropped = b.minX * t.k + t.tx < -1
            || b.minY * t.k + t.ty < -1
            || b.maxX * t.k + t.tx > this.lastFit.width + 1
            || b.maxY * t.k + t.ty > this.lastFit.height + 1;
        // A surface that cannot be panned (a dashboard tile, an export) is not told to pan.
        hint.attr("opacity", cropped && this.allowInteractions ? 1 : 0);
        // While the view is a crop, the pan notice is the more urgent sentence and
        // takes the status line's place; fitting brings the status line back.
        this.chrome.selectAll<SVGTextElement, unknown>("text.status-line").attr("opacity", cropped ? 0 : 1);
    }

    /**
     * The quick-action bar: zoom in / out / fit / lens. Free tier — usability is
     * not a feature. Top-right by default since OC-034, and the author may move it.
     */
    private renderZoomControls(w: number, h: number, palette: ResolvedPalette): void {
        if (!this.zoom) return;
        const corner = this.actionCorner();
        if (!corner) return;
        const s = palette.surface;
        renderZoomControls(this.chrome, {
            width: w,
            height: h,
            corner,
            // Step past the gear / view-switch band rather than draw on top of it.
            cornerInset: this.cornerTaken(corner) ? GEAR_CLEARANCE : 0,
            // …and clear of whatever holds the other end of the same column.
            farInset: this.cornerTaken(Visual.opposite(corner)) ? GEAR_CLEARANCE : 0,
            fg: s.fg,
            bg: palette.highContrast ? s.bg : "#FFFFFF",
            stroke: s.cardStroke,
            labels: {
                in: this.loc.get("Zoom_In"),
                out: this.loc.get("Zoom_Out"),
                fit: this.loc.get("Zoom_Fit"),
            },
            onZoomIn: () => this.zoom && this.zoom.zoomBy(ZOOM_STEP, { width: w, height: h }),
            onZoomOut: () => this.zoom && this.zoom.zoomBy(1 / ZOOM_STEP, { width: w, height: h }),
            onFit: () => this.refit(),
            fullView: {
                show: this.fullViewDiffers,
                label: this.loc.get("Zoom_All"),
                onClick: () => this.fitAll(),
            },
            lens: {
                show: this.lensOffered(),
                active: this.lensOn,
                // The label is the way OUT while the lens is on: a mode with no
                // visible exit is what made this feel like a trap (OC-035).
                label: this.loc.get(this.lensOn ? "Lens_Off" : "Lens_Toggle"),
                accent: palette.highContrast ? s.selected : accent,
                onToggle: () => this.setLens(!this.lensOn),
            },
        });
    }

    /* ── the lens (OC-034) ─────────────────────────────────────────────────
     *
     * A loupe that follows the pointer. It exists because the opening fit stops
     * at the legibility floor but a READER may zoom out past it — only `−` and
     * the wheel go below the floor — and on a large hierarchy "everything at
     * once" means cards a few pixels wide. Session-local: a reader cannot
     * persist a property, so this is state, not a setting.
     */

    /** Turn the lens on or off and repaint the button that says so. */
    private setLens(on: boolean): void {
        if (this.lensOn === on) return;
        this.lensOn = on;
        if (!on) this.lensPoint = null;
        // The branded hover card and the loupe would fight over the same pointer.
        if (on && this.overlayTooltip) this.overlayTooltip.hide();
        try { this.svg.classed("zx-lens-active", on); } catch { /* jsdom without classed */ }
        this.updateLens();
        if (this.palette && this.lastOptions) {
            const vp = this.lastOptions.viewport;
            this.renderZoomControls(vp.width, vp.height, this.palette);
        }
    }

    /** Draw the loupe where the pointer is, or take it down. */
    private updateLens(): void {
        if (!this.lensLayer) return;
        const p = this.lensPoint;
        const vp = this.lastOptions ? this.lastOptions.viewport : null;
        if (!this.lensOn || !p || !vp || !this.palette || !this.zoom
            || this.viewMode !== "chart" || !this.allowInteractions) {
            clearLens(this.lensLayer);
            return;
        }
        const surface = this.palette.surface;
        try {
            renderLens(this.lensLayer, this.lensClipId, {
                px: p.x, py: p.y,
                width: vp.width, height: vp.height,
                k: this.zoom.current().k,
                chartId: this.chartId,
                bg: this.palette.highContrast ? surface.bg : "#FFFFFF",
                fg: surface.fg,
                stroke: surface.cardStroke,
                accent: this.palette.highContrast ? surface.fg : accent,
                label: (times) => this.loc.fmt("Lens_Times", times),
                exitLabel: this.loc.get("Lens_Exit"),
            });
        } catch {
            // A magnifier must never be the reason a report shows a broken chart.
            clearLens(this.lensLayer);
        }
    }

    /* ── the minimap (OC-034) ──────────────────────────────────────────── */

    /** Where the thumbnail goes, or null when it is off / there is no room. */
    private minimapRect(): ScreenRect | null {
        if (!this.lastOptions || !this.allowInteractions) return null;
        if (this.settings.minimap.show.value === false) return null;
        if (this.viewMode !== "chart") return null;
        const vp = this.lastOptions.viewport;
        // The legend and the status line own the last rows; the thumbnail sits
        // above that band, never in it.
        const legendOn = this.settings.overlays.showLegend.value
            && String(this.settings.colors.colorMode.value.value) !== "single";
        const bottomBand = 22 + (legendOn ? LEGEND_HEIGHT : 0);
        // Whichever bottom corner the gear and the pill left alone; if they took
        // both, step above the one on the left.
        const corner: "bl" | "br" = this.cornerTaken("bl") && !this.cornerTaken("br") ? "br" : "bl";
        const shared = this.cornerTaken(corner) || this.actionCorner() === corner;
        return minimapBox({
            width: vp.width,
            height: vp.height,
            bottomBand,
            corner,
            cornerInset: shared ? GEAR_CLEARANCE : 0,
        });
    }

    /**
     * Draw the thumbnail, or take it down.
     *
     * Hidden while the whole chart is on screen: with nothing off the edge the
     * window rectangle would fill the box and say nothing. It appears the moment
     * the view becomes a crop — which is the question it answers — and the space
     * it needs is reserved either way (`chromeObstacles`), so it never reflows
     * the chart by appearing.
     */
    private updateMinimap(): void {
        if (!this.mapLayer) return;
        const box = this.minimapRect();
        const vp = this.lastOptions ? this.lastOptions.viewport : null;
        if (!box || !vp || !this.palette || !this.zoom || !this.lastFit || !this.lastCards.length) {
            clearMinimap(this.mapLayer);
            return;
        }
        const t = this.zoom.current();
        const content = this.lastFit.bounds;
        if (showsEverything(visibleBounds(t, vp.width, vp.height), content)) {
            clearMinimap(this.mapLayer);
            return;
        }
        const surface = this.palette.surface;
        try {
            renderMinimap(this.mapLayer, {
                box,
                cards: this.lastCards,
                content,
                transform: t,
                width: vp.width,
                height: vp.height,
                bg: this.palette.highContrast ? surface.bg : "#FFFFFF",
                fg: surface.fg,
                muted: surface.muted,
                stroke: surface.cardStroke,
                accent: this.palette.highContrast ? surface.fg : accent,
                highContrast: this.palette.highContrast,
                label: this.loc.get("Minimap_Label"),
                interactive: this.allowInteractions,
                onGoTo: (x, y) => this.centreOn(x, y),
            });
        } catch {
            clearMinimap(this.mapLayer);
        }
    }

    /** Put a LAYOUT point in the middle of the canvas, keeping the scale. */
    private centreOn(x: number, y: number): void {
        if (!this.zoom || !this.lastOptions) return;
        const vp = this.lastOptions.viewport;
        const t = this.zoom.current();
        this.zoom.apply({ k: t.k, tx: vp.width / 2 - x * t.k, ty: vp.height / 2 - y * t.k });
        // A deliberate move, so the next update must not snap the reader back.
        this.zoom.markTouched();
    }

    /* ── colours: the one durable path ────────────────────────────────────
     *
     * Power BI silently DROPS a structural `fill` written through
     * persistProperties — the whole family has hit this (NG-273, and the
     * heatmap before it). A colour set in the gear therefore reverted to its
     * default on the next refresh, page change or reopen, which is exactly what
     * "connector colour not working" looked like. Every ColorPicker is mirrored
     * into one text property instead, which the host does keep.
     */

    /** Every ColorPicker slice in the model, keyed `object.property`.
     *  Duck-typed rather than listed, so a colour added later is carried too:
     *  a picker's value is `{ value: "#hex" }` and, unlike a dropdown, it has no
     *  `items`. */
    private colorPickerSlices(): Array<{ key: string; slice: { value: { value: string } } }> {
        const out: Array<{ key: string; slice: { value: { value: string } } }> = [];
        type Slice = { name: string; value: unknown; items?: unknown[] };
        for (const card of (this.settings.cards ?? []) as Array<{ name: string; slices?: Slice[] }>) {
            for (const slice of card.slices ?? []) {
                const v = slice.value as { value?: unknown } | null;
                if (!slice.items && v && typeof v === "object" && typeof v.value === "string") {
                    out.push({ key: `${card.name}.${slice.name}`,
                        slice: slice as unknown as { value: { value: string } } });
                }
            }
        }
        return out;
    }

    private serializeColors(): string {
        const blob: Record<string, string> = {};
        for (const { key, slice } of this.colorPickerSlices()) blob[key] = String(slice.value?.value ?? "");
        return JSON.stringify(blob);
    }

    /** Apply a stored blob onto the live pickers. Unknown keys are ignored, so a
     *  report written by an older build stays readable. */
    private applyColors(json: string): void {
        let blob: Record<string, unknown>;
        try { blob = JSON.parse(json) as Record<string, unknown>; } catch { return; }
        for (const { key, slice } of this.colorPickerSlices()) {
            if (Object.prototype.hasOwnProperty.call(blob, key)) {
                slice.value = { value: String(blob[key] ?? "") };
            }
        }
    }

    /** Re-hydrate the pickers from the store, right after the model is populated.
     *  While our own write is unconfirmed we keep applying it rather than the
     *  stale stored value. */
    private hydrateColors(dataView: DataView | undefined): void {
        if (!this.settings) return;
        const obj = (dataView?.metadata?.objects as
            { colorStore?: { data?: unknown } } | undefined)?.colorStore;
        const stored = typeof obj?.data === "string" ? obj.data : "";
        if (this.pendingColors != null) {
            if (stored === this.pendingColors) this.pendingColors = null;   // host confirmed
            else { this.applyColors(this.pendingColors); this.lastColorBlob = this.serializeColors(); return; }
        }
        if (stored) this.applyColors(stored);
        this.lastColorBlob = this.serializeColors();
    }

    /** Persist the blob if a picker actually changed. A Reset lands here too:
     *  `colorStore` is not a card, so the defaults-merge never touches it, and
     *  rewriting the now-default blob is what makes Reset clear a custom colour. */
    private maybePersistColors(): void {
        if (!this.settings) return;
        const blob = this.serializeColors();
        if (blob === this.lastColorBlob) return;
        this.lastColorBlob = blob;
        this.pendingColors = blob;
        this.host.persistProperties({
            merge: [{ objectName: "colorStore", selector: null, properties: { data: blob } }],
        } as powerbi.VisualObjectInstancesToPersist);
    }

    /**
     * Drop everything the instance holds ABOUT THE VIEW — what is collapsed, that
     * the opening auto-collapse has run, and the fitted transform.
     *
     * The gear's Reset wipes the persisted properties, but collapse state also
     * lives here in memory (by key, so it survives a filter), and the restore path
     * only reads the stored value when nothing is held. Without this the chart
     * stayed exactly as collapsed as it was through a Reset that had already
     * cleared the report's copy. Annotations are deliberately NOT cleared: they
     * are content, not formatting.
     */
    private resetViewState(): void {
        this.maybePersistColors();          // rewrite the (now default) colour blob
        this.collapsedKeys.clear();
        this.autoFitApplied = false;
        this.lastCollapseToFit = null;
        // The ladder went back to its default with everything else; forgetting
        // what was applied lets the fresh automatic collapse own the view again.
        this.lastLadder = null;
        this.pendingLadder = null;
        this.lastHostLadder = null;
        this.prevLadder = null;
        this.viewSignature = "";
        this.layoutSignature = "";
        // The saved view goes with the rest of the formatting Reset clears.
        this.storedView = null;
        this.pendingView = null;
        this.lastViewBlob = "";
        this.viewRestored = false;
        if (this.zoom) this.zoom.clearTouched();
    }

    /**
     * Centre a person, keeping the current scale.
     *
     * The jump is marked as a deliberate move, or the next update would re-fit
     * and snap the user straight back off the person they just searched for.
     */
    private jumpTo(index: number, minScale = 0): void {
        if (index < 0 || !this.zoom || !this.lastLayout || !this.lastOptions) return;
        // A match can be inside a collapsed branch, where no card is drawn.
        // Centring on it would land the user on empty canvas, so open the way in
        // first — that is the difference between "search" and "search and jump".
        if (this.revealAncestors(index) && !this.lastLayout) return;
        if (index >= this.lastLayout.x.length) return;
        const t = this.zoom.current();
        const vp = this.lastOptions.viewport;
        // Search keeps the reader's scale. "Show on the chart" from the table asks
        // to SEE the person, so it never lands on a card too small to read.
        const k = Math.max(t.k, minScale);
        this.zoom.apply({
            k,
            tx: vp.width / 2 - this.lastLayout.x[index] * k,
            ty: (vp.height - 22) / 2 - this.lastLayout.y[index] * k,
        });
        this.zoom.markTouched();
    }

    /**
     * Expand every collapsed ancestor of `index`. Returns true when something
     * opened, which means the chart has already re-rendered underneath us.
     */
    private revealAncestors(index: number): boolean {
        const h = this.lastHierarchy;
        const keys = this.lastKeys;
        if (!h || keys.length === 0) return false;
        let changed = false;
        let p = h.parentIdx[index];
        // The walk is bounded by the tree's depth; `buildHierarchy` has already
        // broken any cycle, so parents cannot loop back here.
        while (p !== undefined && p >= 0) {
            if (this.collapsedKeys.delete(keys[p])) changed = true;
            p = h.parentIdx[p];
        }
        if (!changed) return false;
        this.persistCollapsed(keys);
        if (this.lastOptions) this.update(this.lastOptions);
        return true;
    }

    /**
     * Outline the cards matching the live search.
     *
     * Deliberately an outline rather than dimming the rest: dimming is what
     * cross-filter selection means, and two different things must not look the
     * same. Re-applied after every render because `renderTree` rewrites stroke.
     */
    private paintSearch(): void {
        const palette = this.palette;
        if (!palette) return;
        const hits = new Set(this.searchHits);
        const accentStroke = palette.highContrast ? palette.surface.fg : accent;
        const width = Math.max(2.5, palette.strokeWidth + 1.5);
        this.viewport.selectAll<SVGGElement, number>("g.card").each(function (i) {
            const rect = select(this).select<SVGRectElement>("rect.card-bg");
            if (rect.empty()) return;
            const node = rect.node() as SVGRectElement;
            if (hits.has(i)) {
                // Remember what the renderer chose, once, so clearing the query
                // puts the card back exactly as it was rather than guessing.
                if (!node.hasAttribute("data-zx-stroke")) {
                    node.setAttribute("data-zx-stroke", node.getAttribute("stroke") || "");
                    node.setAttribute("data-zx-sw", node.getAttribute("stroke-width") || "");
                }
                rect.attr("stroke", accentStroke).attr("stroke-width", width);
            } else if (node.hasAttribute("data-zx-stroke")) {
                rect.attr("stroke", node.getAttribute("data-zx-stroke"))
                    .attr("stroke-width", node.getAttribute("data-zx-sw"));
                node.removeAttribute("data-zx-stroke");
                node.removeAttribute("data-zx-sw");
            }
        });
    }

    /**
     * Fit the chart into the space the host gives us — down to the legibility
     * floor, and no further (OC-030, zentrix-org-chart#1).
     *
     * OC-021 removed the old floor because it CROPPED in silence, and focus mode
     * gained nothing. That traded one failure for another: with no floor a
     * manager with 21 reports drew every name at 3–4px on a full page. The floor
     * is back at a readable 9px name, but paid for up front by stacking leaf
     * reports, wrapping forests and collapsing to fit, so the fit rarely needs
     * it. When it does, the view anchors on the roots and the pan cue says part
     * of the chart is off screen. ⛶ and `0` land here too; only − and the wheel
     * go below the floor, because that is the reader asking for an overview.
     */
    private refit(): void {
        if (!this.lastFit || !this.zoom) return;
        const t = fitAvoiding(
            this.lastFit.bounds,
            this.lastCards,
            { width: this.lastFit.width, height: this.lastFit.height },
            this.chromeObstacles(this.lastFit.width, this.lastFit.height),
            16,
            this.lastFit.maxScale,
            this.lastFit.minScale,
            this.lastFit.anchor,
        );
        this.zoom.apply({ k: t.k, tx: t.tx, ty: t.ty });
        this.zoom.clearTouched();
    }

    /**
     * Read the saved view off the report (OC-042).
     *
     * Same three-step dance as `colorStore`: a write this instance has made and
     * the host has not echoed yet WINS, so an in-flight save is never clobbered
     * by a stale round-trip. A blob that differs from the last one seen is a new
     * view — a reopen, a bookmark, another author's save — and is applied once.
     */
    private syncViewState(dataView: DataView | undefined): void {
        const obj = (dataView?.metadata?.objects as { viewState?: { data?: unknown } } | undefined)?.viewState;
        const stored = typeof obj?.data === "string" ? obj.data : "";
        if (this.pendingView !== null && stored === this.pendingView) this.pendingView = null;
        if (this.pendingView !== null || stored === this.lastViewBlob) return;
        this.lastViewBlob = stored;
        this.storedView = parseView(stored);
        this.viewRestored = false;
    }

    /**
     * Put the reader back where the report was saved.
     *
     * The blob holds the SCALE and the chart-space point that was centred, never
     * a raw transform: the visual can reopen at a different size — a phone, a
     * dashboard tile, focus mode — and a translation copied verbatim would land
     * somewhere else entirely. Marked as touched, because it is the author's
     * view and not the fit's: the automatic fit must not take it back on the
     * next update. `keepView` then does the clamping, so a saved view whose
     * chart has since been filtered away still finds the chart.
     */
    private applyStoredView(): void {
        if (!this.storedView || !this.lastFit || !this.zoom) return;
        this.viewRestored = true;
        const { k, cx, cy } = this.storedView;
        this.zoom.apply({
            k,
            tx: this.lastFit.width / 2 - cx * k,
            ty: this.lastFit.height / 2 - cy * k,
        });
        this.zoom.markTouched();
        this.keepView();
    }

    /**
     * Save the view after it settles.
     *
     * A single wheel gesture is dozens of transforms and each write is a host
     * round-trip that also marks the report dirty, so nothing is written until
     * the movement stops. The delay is doing a second job: `refit()` clears the
     * touched flag AFTER it applies the transform, so by the time this runs the
     * flag reads false and the save is correctly an erase — pressing ⛶ puts the
     * report back to opening on the automatic fit.
     */
    private scheduleViewSave(): void {
        if (this.viewSaveTimer !== null) clearTimeout(this.viewSaveTimer);
        this.viewSaveTimer = setTimeout(() => {
            this.viewSaveTimer = null;
            this.persistView();
        }, VIEW_SAVE_MS);
    }

    private persistView(): void {
        if (!this.zoom || !this.lastFit || this.destroyed || this.printing) return;
        const t = this.zoom.current();
        const blob = this.zoom.touched() && t.k > 0
            ? JSON.stringify({
                k: round3(t.k),
                cx: round3((this.lastFit.width / 2 - t.tx) / t.k),
                cy: round3((this.lastFit.height / 2 - t.ty) / t.k),
            })
            : "";
        if (blob === this.lastViewBlob) return;
        this.lastViewBlob = blob;
        this.pendingView = blob;
        this.storedView = parseView(blob);
        // Already on screen — a restore of what is being looked at would be a jump.
        this.viewRestored = true;
        this.host.persistProperties({
            merge: [{ objectName: "viewState", selector: null, properties: { data: blob } }],
        } as powerbi.VisualObjectInstancesToPersist);
    }

    /**
     * Hold a view the reader moved, through a change that re-laid out the chart
     * (OC-042 — CEO: "zoom is not persisting").
     *
     * The transform is kept exactly as it is, so folding a branch or resizing
     * the visual leaves the same place on screen at the same scale. The only
     * thing this does is rescue a view the new layout has left with nothing in
     * it: the tree can shrink or move under a stationary viewport — fold the
     * branch you were reading and it is gone — and a reader staring at empty
     * canvas has no way of knowing which direction to drag.
     *
     * The rescue is deliberately loose. It asks only that `KEEP` pixels of the
     * chart still meet the viewport on each axis, and then moves by the
     * smallest amount that buys that. A view already showing a piece of the
     * chart is never touched, however far off-centre the reader put it — being
     * "tidied" mid-read is the thing this whole change exists to stop.
     */
    private keepView(): void {
        if (!this.lastFit || !this.zoom) return;
        const t = this.zoom.current();
        const b = this.lastFit.bounds;
        /** How much of the chart must stay in the box before it counts as lost. */
        const KEEP = 48;
        /**
         * @param lo    the chart's leading edge, in screen pixels
         * @param size  its scaled extent on this axis
         * @param box   the viewport's extent on this axis
         * @returns how far to move the view on this axis; 0 when it is fine
         */
        const rescue = (lo: number, size: number, box: number): number => {
            const need = Math.min(KEEP, size, box);
            if (lo + size < need) return need - (lo + size);   // ran off the near edge
            if (lo > box - need) return (box - need) - lo;     // ran off the far edge
            return 0;
        };
        const dx = rescue(b.minX * t.k + t.tx, (b.maxX - b.minX) * t.k, this.lastFit.width);
        const dy = rescue(b.minY * t.k + t.ty, (b.maxY - b.minY) * t.k, this.lastFit.height);
        if (dx === 0 && dy === 0) return;
        this.zoom.apply({ k: t.k, tx: t.tx + dx, ty: t.ty + dy });
        // Still the reader's view, not the fit's: the next update must keep it.
        this.zoom.markTouched();
    }

    /**
     * "Show everything" — the whole chart, at whatever scale that takes (OC-036).
     *
     * `refit` stops at the legibility floor, which since OC-030 means a large
     * hierarchy fits to a READABLE CROP rather than to the whole tree. That is
     * the right default and the wrong answer to "let me see all of it", which
     * until now could only be had by holding `−`. This is the same
     * chrome-aware fit with the floor taken off, so nothing lands under the
     * controls; the lens is how a card is read once here.
     */
    private fitAll(): void {
        if (!this.lastFit || !this.zoom) return;
        const t = fitAvoiding(
            this.lastFit.bounds,
            this.lastCards,
            { width: this.lastFit.width, height: this.lastFit.height },
            this.chromeObstacles(this.lastFit.width, this.lastFit.height),
            16,
            this.lastFit.maxScale,
            0,                                   // no floor: everything, or nothing
            this.lastFit.anchor,
        );
        this.zoom.apply({ k: t.k, tx: t.tx, ty: t.ty });
        // A deliberate move below the floor, so the next update must not snap the
        // reader back to the readable fit they just chose to leave.
        this.zoom.markTouched();
    }

    /**
     * Where the COLLAPSED gear button sits, in viewport pixels; null when hidden or
     * unmeasurable.
     *
     * Always the collapsed position. Open (or animating), the button moves ~10px
     * inside the expanded bar, and a layout that followed it would jump every time
     * the reader opened settings — and a report reopened with the gear closed would
     * draw differently from the moment it was saved. So a collapsed gear is
     * measured, and any other state resolves to the collapsed box for its corner
     * (the family bar's own margins: 18px from the side, 16px from top or bottom).
     */
    private gearBox(): ScreenRect | null {
        const svgNode = this.svg.node() as SVGSVGElement | null;
        const el = this.root ? this.root.querySelector(".zsb-anchor .zsb-gear") as HTMLElement | null : null;
        if (!svgNode || !el || el.offsetParent === null || typeof el.getBoundingClientRect !== "function") return null;
        try {
            if (!el.classList.contains("zsb-collapsed")) {
                const vp = this.lastOptions ? this.lastOptions.viewport : null;
                if (!vp) return null;
                const corner = (el.closest(".zsb-anchor") as HTMLElement | null)?.getAttribute("data-corner") || "tr";
                const size = 36;
                return {
                    x: corner.indexOf("l") >= 0 ? 18 : vp.width - 18 - size,
                    y: corner.charAt(0) === "t" ? 16 : vp.height - 16 - size,
                    w: size, h: size,
                };
            }
            const o = svgNode.getBoundingClientRect(), b = el.getBoundingClientRect();
            return b.width > 0 && b.height > 0 ? { x: b.left - o.left, y: b.top - o.top, w: b.width, h: b.height } : null;
        } catch { return null; }
    }

    /**
     * The horizontal run a row of chrome (search box, legend, status line) may use
     * between `y0` and `y1`, keeping clear of the gear when the author pinned it to
     * a corner in that row. Before OC-028 the gear at Top left sat on the search
     * box and at Bottom left on the legend and the status line.
     */
    private rowSpan(y0: number, y1: number, w: number): { x: number; right: number } {
        let x = 10, right = w - 10;
        // The gear, the view switch (OC-029), and since OC-034 the quick-action
        // bar and the thumbnail — whichever of them share this row. Before
        // OC-034 the bar was assumed bottom-right and left out; pinned top-left
        // it sat on the search box.
        for (const g of [this.gearBox(), this.pillBox(), this.actionBarBox(), this.minimapRect()]) {
            if (g && g.y < y1 && g.y + g.h > y0) {
                if (g.x + g.w / 2 < w / 2) x = Math.max(x, g.x + g.w + 8);
                else right = Math.min(right, g.x - 8);
            }
        }
        return { x, right };
    }

    /** Honour the author's "Close on click-away" — true when unset. */
    private closeOnClickAway(): boolean {
        const v = this.settings?.toolbar?.closeOnClickAway?.value;
        return v !== false;
    }

    /**
     * Where the floating chrome sits, in viewport pixels, clipped to the fit box.
     *
     * The search box and the gear are HTML over the SVG, so they are measured
     * (a host without layout measures zero, which means "no obstacle"). The zoom
     * stack is drawn by us, so its box is computed from the same constants
     * `renderZoomControls` uses. The gear is measured as its BUTTON: the open
     * settings bar is a temporary panel the reader is working in, not chrome to
     * fit around.
     */
    private chromeObstacles(boxW: number, boxH: number): ScreenRect[] {
        const out: ScreenRect[] = [];
        const clip = (r: ScreenRect): void => {
            const x = Math.max(0, r.x), y = Math.max(0, r.y);
            const x2 = Math.min(boxW, r.x + r.w), y2 = Math.min(boxH, r.y + r.h);
            if (x2 > x && y2 > y) out.push({ x, y, w: x2 - x, h: y2 - y });
        };
        const svgNode = this.svg.node() as SVGSVGElement | null;
        if (this.root && svgNode && typeof svgNode.getBoundingClientRect === "function") {
            const origin = svgNode.getBoundingClientRect();
            const measure = (sel: string): void => {
                const el = this.root!.querySelector(sel) as HTMLElement | null;
                if (!el || el.offsetParent === null) return;
                const b = el.getBoundingClientRect();
                if (b.width > 0 && b.height > 0) clip({ x: b.left - origin.left, y: b.top - origin.top, w: b.width, h: b.height });
            };
            try {
                measure(".zx-search");
                const gear = this.gearBox();
                if (gear) clip(gear);
            } catch { /* measuring is best effort; the chart still fits */ }
        }
        // The view switch, the quick-action bar and the thumbnail are all placed
        // by US, so their boxes are known without measuring — and since OC-034
        // each comes from the one function that also draws it. The bar's box used
        // to be re-derived here from copies of the renderer's constants.
        const pill = this.pillBox();
        if (pill) clip(pill);
        const bar = this.actionBarBox();
        if (bar) clip(bar);
        /*
         * The thumbnail reserves its corner whether or not it is on screen this
         * instant. It appears only once the view is a crop, and a crop is decided
         * BY this fit — reserving the space unconditionally is what keeps the
         * chart from reflowing the moment the reader zooms in.
         */
        const map = this.minimapRect();
        if (map) clip(map);
        return out;
    }

    /**
     * Show or hide the onboarding carousel, keeping its theme current.
     *
     * Guarded on every path: onboarding art must never be the reason a report
     * shows a blank visual. If it throws, the SVG landing underneath still has
     * the ask and the field checklist.
     */
    private setLandingVisible(visible: boolean, surface: Surface): void {
        if (!this.landing) return;
        try {
            if (visible) {
                this.landing.setTheme(surface);
                this.landing.show();
            } else {
                this.landing.hide();
            }
        } catch { /* onboarding is never load-bearing */ }
    }

    /**
     * The landing page — brand, the ask, the field-well checklist, a wireframe
     * preview and the capability tiles, sized to whatever viewport we have.
     * Drawn into `chrome` so the fit transform on `viewport` never touches it.
     */
    private renderLanding(
        reason: EmptyReason,
        dataView: DataView | undefined,
        w: number,
        h: number,
        palette: ResolvedPalette,
    ): void {
        this.viewport.selectAll("*").remove();
        renderLandingPage(this.chrome, {
            width: w,
            height: h,
            reason,
            bound: boundRoles(dataView),
            surface: palette.surface,
            highContrast: palette.highContrast,
            accent: palette.highContrast
                ? palette.surface.fg
                : (this.settings.colors.cardFill.value.value || accentStrong),
            groupColor: (i: number) => palette.groupColor(i),
            t: (key: string) => this.loc.get(key),
        });
    }

    /**
     * Serialize the live chart and hand it to the host's
     * download service. No network call: the SVG is serialized in-place and, for
     * PNG, rasterized through a `data:` URL onto a canvas.
     *
     * Returns false when the tier does not allow it, so the caller can show the
     * upgrade affordance rather than failing silently.
     */
    public async exportChart(format: "svg" | "png" = "png"): Promise<boolean> {
        if (!this.license.allows("export")) return false;
        const node = this.svg.node();
        if (!node || !this.lastOptions) return false;
        const size = {
            width: this.lastOptions.viewport.width,
            height: this.lastOptions.viewport.height,
        };
        const svgText = serializeSvg(node, size, "#FFFFFF");
        const svc = (this.host as unknown as {
            downloadService?: { exportVisualsContent?: (c: string, f: string, t: string, d: string) => Promise<unknown> };
        }).downloadService;
        if (!svc || typeof svc.exportVisualsContent !== "function") return false;
        try {
            if (format === "svg") {
                await svc.exportVisualsContent(svgText, safeFileName("org-chart", "svg"), "svg", "Org chart");
                return true;
            }
            const png = await rasterizeToPng(svgText, size, 2, "#FFFFFF");
            await svc.exportVisualsContent(png, safeFileName("org-chart", "png"), "png", "Org chart");
            return true;
        } catch {
            return false;     // an export failure must never break the render
        }
    }

    /**
     * Power BI rarely calls this (it drops the iframe), but when it does, nothing
     * asynchronous may outlive the instance: a photo that finishes decoding later
     * must not draw into a dead visual or report a render nobody started.
     */
    public destroy(): void {
        this.destroyed = true;
        this.finishAfterPhotos = null;
        if (this.viewSaveTimer !== null) { clearTimeout(this.viewSaveTimer); this.viewSaveTimer = null; }
        try {
            window.removeEventListener("beforeprint", this.onBeforePrint);
            window.removeEventListener("afterprint", this.onAfterPrint);
        } catch { /* nothing to remove */ }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        // The accent colour only paints a card in "One" mode (and behind anyone
        // with no group), so in Group / Level mode it is hidden rather than left
        // sitting there doing nothing — same rule the gear applies.
        const mode = String(this.settings.colors.colorMode.value.value);
        this.settings.colors.cardFill.visible = mode === "single";
        // Same rule for the view switch's corner: with both segments off there is
        // no switch to place (the gear dims the same control).
        this.settings.summaryTable.position.visible =
            this.settings.summaryTable.show.value || this.settings.insights.show.value;
        return this.formattingSettingsService.buildFormattingModel(this.settings);
    }
}

/** Parse the persisted table blob; anything malformed means "defaults". */
function parseTableState(blob: string): TableState | null {
    if (!blob) return null;
    try {
        const o = JSON.parse(blob) as { columns?: unknown; sort?: { key?: unknown; desc?: unknown }; statsCollapsed?: unknown };
        if (Array.isArray(o.columns) && o.sort && typeof o.sort.key === "string") {
            return {
                columns: o.columns.filter((c): c is string => typeof c === "string"),
                sort: { key: o.sort.key, desc: o.sort.desc === true },
                statsCollapsed: o.statsCollapsed === true,
            };
        }
    } catch { /* malformed → defaults */ }
    return null;
}

/** Beyond this many distinct groups the slot map lives in memory only — a Group
 *  bound to a unique column must not write a megabyte into the report. */
const MAX_STORED_SLOTS = 500;

function parseSlots(blob: string): Map<string, number> {
    const out = new Map<string, number>();
    if (!blob) return out;
    try {
        const arr = JSON.parse(blob) as unknown;
        if (Array.isArray(arr)) {
            for (const e of arr) {
                if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number" && isFinite(e[1]) && e[1] >= 0) {
                    out.set(e[0], Math.floor(e[1]));
                }
            }
        }
    } catch { /* malformed → no stored map */ }
    return out;
}

/** The lowest slot no group holds (at or after `from`). */
function nextFree(map: Map<string, number>, from = 0): number {
    const used = new Set(map.values());
    let s = Math.max(0, from);
    while (used.has(s)) s++;
    return s;
}

/** Keys from a stored collapse value, whether or not they are in this render's rows. */
function collapsedKeysOf(raw: string): string[] {
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw) as unknown;
        return Array.isArray(arr) ? arr.filter((k): k is string => typeof k === "string") : [];
    } catch { return []; }
}

/** `CustomVisualHostEnv` bits (powerbi-visuals-api 5.11): ExportReportHost, DashboardHost. */
const HOST_ENV_EXPORT = 1 << 5;
const HOST_ENV_DASHBOARD = 1 << 7;
