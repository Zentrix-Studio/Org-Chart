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
import { EmptyReason, OrgModel, Orientation, ConnectorStyle, ColorMode, TooltipStyle } from "./types";
import { buildOrgModel, missingRequiredRole, boundRoles } from "./model/dataTransform";
import {
    buildHierarchy, hiddenByCollapse, isParentNode,
    serializeCollapsed, deserializeCollapsed, Hierarchy,
} from "./model/hierarchy";
import { treeLayout, fitAvoiding, cardRects, LayoutResult, LayoutOptions, ScreenRect } from "./model/treeLayout";
import { renderLegend, LegendItem, LEGEND_HEIGHT } from "./render/legend";
import { createSearchBox, SearchHandle } from "./interaction/search";
import {
    createZoomPan, renderZoomControls, ZoomPanHandle, ZOOM_STEP, MIN_FIT_SCALE, MAX_AUTO_SCALE,
    GEAR_CLEARANCE, CONTROL_SIZE,
} from "./interaction/zoomPan";
import {
    depthThatFits, fillLevelGap, levelRatioFor, levelScale, visibleDepth, NO_COLLAPSE,
} from "./model/autoFit";
import { renderTree, trimToWidth } from "./render/tree";
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

export class Visual implements IVisual {
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
    /** Bounds + viewport of the last render, so "fit" works without re-laying out. */
    /** Card rectangles of the last layout, in layout units — what the fit keeps clear of chrome. */
    private lastCards: ScreenRect[] = [];
    /** How far the search box moved right to clear a top-left gear. */
    private searchInset = 0;
    /** The width the search box may use this render, after the chrome in its row. */
    private searchWidth = 0;
    private lastFit: { bounds: { minX: number; minY: number; maxX: number; maxY: number };
        width: number; height: number; maxScale: number } | null = null;

    private svg: SvgSel;
    private viewport: GSel;
    private chrome: GSel;

    /** Collapsed node KEYS (not indices) — survives refresh and cross-filter. */
    private collapsedKeys = new Set<string>();
    /** The stored collapse value as last read from the host; null before the first. */
    private lastHostCollapsed: string | null = null;
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
        this.license = new LicenseGate(options.host, () => {
            if (this.lastOptions) this.update(this.lastOptions);
        });

        const root = select(options.element).append("div").classed("zentrix-org-root", true);
        this.root = root.node() as HTMLElement;
        this.svg = root.append("svg").classed("zentrix-org", true) as SvgSel;
        // Bookmarks: Power BI calls back with the restored selection.
        bindBookmarks(this.selectionManager, () => {
            if (this.lastOptions) this.update(this.lastOptions);
        });
        this.viewport = this.svg.append("g").attr("class", "viewport") as GSel;
        this.chrome = this.svg.append("g").attr("class", "chrome") as GSel;

        // A press on the chart must dismiss the gear. d3-zoom stops the mousedown
        // immediately (that is how it claims the drag), so the bar's own
        // click-away listener on `document` never sees it — the visual has to say so.
        this.zoom = createZoomPan(this.svg, this.viewport, () => this.updatePanHint(), () => {
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
                onJump: (i) => this.jumpTo(i),
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

        this.svg.on("keydown", (ev: KeyboardEvent) => {
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
            } else if (ev.key === "0") {
                ev.preventDefault();
                this.refit();
            }
        });
    }

    public update(options: VisualUpdateOptions): void {
        this.lastOptions = options;
        this.events.renderingStarted(options);
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
                this.syncOverlay(w, h);
                this.events.renderingFinished(options);
                return;
            }
            this.setLandingVisible(false, palette.surface);

            const model = buildOrgModel(dataView, this.license.nodeCap, this.host, this.loc.locale);
            this.maybeFetchMore(dataView);
            if (model.nodes.length === 0) {
                this.leaveAltViews();
                this.renderLanding(EmptyReason.NoData, dataView, w, h, palette);
                this.syncOverlay(w, h);
                this.events.renderingFinished(options);
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

            // Restore persisted collapse state, then reconcile with this render's
            // indices. Keys are the contract; indices shift on every filter.
            //
            // Only a value the host has CHANGED is restored (OC-029). Expanding the
            // last collapsed branch empties the set and re-renders from the same
            // (stale) options before the host echoes the write — and "empty set +
            // a stored value" used to restore that stored value, so the branch
            // snapped shut again. The + did nothing, and search-and-jump or "show
            // on the chart" into that branch landed on a card that wasn't drawn.
            const persisted = this.settings.layout.collapsed.value || "";
            if (persisted !== this.lastHostCollapsed) {
                this.lastHostCollapsed = persisted;
                if (this.collapsedKeys.size === 0 && persisted) {
                    const restored = deserializeCollapsed(keys, persisted);
                    restored.forEach((i) => this.collapsedKeys.add(keys[i]));
                }
            }

            // The view switch is placed BEFORE the chart is fitted: the fit, the
            // search box and the bottom rows all steer around it, the same way they
            // steer around the gear.
            this.syncOverlay(w, h);
            this.syncViewSwitch(w, h, palette);
            if (this.viewMode !== "chart") {
                this.renderAltView(model, hierarchy, palette);
                this.reportDataQuality(model, hierarchy, keys, parents);
                this.events.renderingFinished(options);
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

            // A hierarchy too big to show whole opens with its deep levels
            // collapsed, at the TOP of the tree. Without this the opening view of
            // a 169-person org is a 9% slice of its middle — technically fitted,
            // and useless. Runs once per report: after that the stored collapse
            // state is the user's, and re-applying this would fight them.
            if (this.settings.layout.collapseToFit.value
                && !this.settings.layout.collapseToFitDone.value
                && !this.autoFitApplied
                && this.collapsedKeys.size === 0) {
                this.autoFitApplied = true;
                const depth = depthThatFits(
                    hierarchy, layoutOptions, { width: w, height: h - chromeInset }, MIN_FIT_SCALE,
                );
                if (depth !== NO_COLLAPSE) {
                    for (let i = 0; i < keys.length; i++) {
                        if (hierarchy.depth[i] === depth && isParentNode(hierarchy, i)) {
                            this.collapsedKeys.add(keys[i]);
                        }
                    }
                }
                this.persistCollapsed(keys, true);
            }

            const collapsed = new Set<number>();
            for (let i = 0; i < keys.length; i++) {
                if (this.collapsedKeys.has(keys[i]) && isParentNode(hierarchy, i)) collapsed.add(i);
            }
            const hidden = hiddenByCollapse(hierarchy, collapsed);

            // Fit scales on the tighter axis, so a wide, shallow org fits by
            // width and then leaves most of the height empty. Stretching the gap
            // between levels uses that space at the same scale — the cards stay
            // the size they were. Level spacing becomes a minimum while this is on.
            // Auto lets the whole chart draw above 1:1 when the hierarchy leaves
            // room, so cards and their type grow together instead of sitting as
            // postage stamps in the middle of an empty canvas.
            const sizeMode = String(this.settings.nodes.sizeMode.value.value);
            const maxScale = sizeMode === "fixed" ? 1 : MAX_AUTO_SCALE;

            // Cards grow towards the root. The ratio is chosen against THIS
            // viewport and THIS hierarchy, so the growth comes out of empty space
            // rather than out of the leaves — and the layout reserves each card's
            // real size, so a big parent can never overlap its neighbours.
            if (sizeMode === "level") {
                const ratio = levelRatioFor(
                    hierarchy, hidden, layoutOptions, { width: w, height: h - chromeInset },
                    MIN_FIT_SCALE, maxScale,
                );
                if (ratio > 1) {
                    const deepest = visibleDepth(hierarchy, hidden);
                    layoutOptions.levelScale = (d: number) => levelScale(d, deepest, ratio);
                }
            }
            if (this.settings.layout.fillViewport.value) {
                layoutOptions.levelGap = fillLevelGap(
                    hierarchy, hidden, layoutOptions, { width: w, height: h - chromeInset },
                    MIN_FIT_SCALE, maxScale,
                );
            }

            const layout = treeLayout(hierarchy, hidden, layoutOptions);

            // The view is fitted when what is being drawn changes — a new model,
            // a collapse, a resize, a different orientation or card size. A pan or
            // zoom the user performed is kept through every other update, because
            // yanking someone back to fit mid-read is worse than a stale view.
            this.lastFit = { bounds: layout.bounds, width: w, height: h - chromeInset, maxScale };
            this.lastCards = cardRects(layout);
            // The fit has to know where the floating chrome will be, so its
            // visibility is settled BEFORE fitting (OC-028). Both calls repeat below
            // with the rest of their state; each is idempotent.
            this.syncOverlay(w, h);
            if (this.searchBox) {
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
                // Chrome the fit steers around: moving or hiding it changes the fit.
                this.settings.overlays.showSearch.value, this.settings.toolbar.show.value,
                this.settings.toolbar.position.value.value, this.allowInteractions,
                this.settings.summaryTable.show.value, this.settings.insights.show.value,
                this.settings.summaryTable.position.value.value,
            ].join("|");
            if (signature !== this.viewSignature || !this.zoom || !this.zoom.touched()) {
                this.viewSignature = signature;
                this.refit();
            }

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

            this.bindInteraction(keys, model, hierarchy, hidden, metrics, palette);
            this.renderStatus(model, hierarchy, w, h, surface.muted, summary, changeOf);

            // Legend — drawn after the status line, which clears `chrome`, and
            // above it so the two never share a row.
            if (legendOn) {
                const mode = String(this.settings.colors.colorMode.value.value);
                let items: LegendItem[] = [];
                if (mode === "group") {
                    items = model.groups.map((gname, gi) => ({
                        label: gname,
                        color: palette.groupColor(gi, gname),
                        dash: palette.groupDash(gi),
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
                    // Stop short of the zoom controls rather than run under them,
                    // and start/stop clear of a gear pinned to a bottom corner.
                    maxWidth: Math.max(0, Math.min(w - 10 - (CONTROL_SIZE + 24), band.right) - band.x),
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
            this.syncOverlay(w, h);
            this.reportDataQuality(model, hierarchy, keys, parents);
            this.events.renderingFinished(options);
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
            color: palette.groupColor(0),
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
            tip.setBranding(this.settings.branding.showBranding.value);
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
        const groupIdx = new Map<string, number>();
        model.groups.forEach((g, i) => groupIdx.set(g, i));
        const colorOf = (i: number): string => {
            if (palette.highContrast) return palette.groupColor(0);
            if (colorMode === "single") return single;
            if (colorMode === "level") return palette.groupColor(hierarchy.depth[i], `level-${hierarchy.depth[i]}`);
            const g = model.nodes[i].group;
            return g === null ? single : palette.groupColor(groupIdx.get(g) ?? 0, g);
        };
        // High contrast encodes groups by DASH, never colour.
        const dashOf = (i: number): string => {
            if (!palette.highContrast) return "";
            if (colorMode === "level") return palette.groupDash(hierarchy.depth[i]);
            const g = model.nodes[i].group;
            return g === null ? "" : palette.groupDash(groupIdx.get(g) ?? 0);
        };
        return { colorOf, dashOf };
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

    /** The corner the gear occupies, or null when it is not drawn. */
    private gearCorner(): string | null {
        if (!this.overlay || !this.settings.toolbar.show.value || !this.allowInteractions) return null;
        const pref = String(this.settings.toolbar.position.value.value || "auto");
        return pref === "auto" ? "tr" : pref;
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
        const corner = pref === "auto" ? "tr" : pref;
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

    /** True when the zoom stack's bottom-right corner is taken — by the gear or the pill. */
    private bottomRightTaken(): boolean {
        return this.gearAtBottomRight() || (this.pillBox() !== null && this.pillCorner === "br");
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
        if (!warning) return;
        if (typeof this.host.displayWarningIcon !== "function") return;
        try {
            this.host.displayWarningIcon(warning.title, warning.detail);
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
    private persistCollapsed(keys: string[], markAutoDone = false): void {
        const idx = new Set<number>();
        for (let i = 0; i < keys.length; i++) if (this.collapsedKeys.has(keys[i])) idx.add(i);
        const properties: Record<string, string | boolean> = {
            collapsed: serializeCollapsed(keys, idx),
        };
        if (markAutoDone) properties.collapseToFitDone = true;
        this.host.persistProperties({
            merge: [{
                objectName: "layout",
                selector: null,
                properties,
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
     * Hand the gear this render's settings, theme and corner.
     *
     * The gear pins top-RIGHT whenever its position is Auto (CEO, 2026-09-12).
     * Note the divergence: the Sankey and the Network Graph both pin bottom-right,
     * each citing an earlier CEO call — if the family is meant to move, they move
     * too, and this comment is the thread to pull. It is hidden on a viewport too
     * small to hold it without covering the chart.
     */
    private syncOverlay(w: number, h: number): void {
        if (!this.overlay) return;
        const tooSmall = w < 220 || h < 160;
        this.overlay.update(this.settings, false, tooSmall || !this.allowInteractions);
        this.overlay.setCorner("tr");
    }

    /** True when the gear occupies the bottom-right corner the zoom stack uses. */
    private gearAtBottomRight(): boolean {
        if (!this.overlay || !this.settings.toolbar.show.value || !this.allowInteractions) return false;
        // Auto is top-right now, so only an explicit "br" shares the corner.
        return String(this.settings.toolbar.position.value.value || "auto") === "br";
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
        hint.attr("opacity", cropped ? 1 : 0);
        // While the view is a crop, the pan notice is the more urgent sentence and
        // takes the status line's place; fitting brings the status line back.
        this.chrome.selectAll<SVGTextElement, unknown>("text.status-line").attr("opacity", cropped ? 0 : 1);
    }

    /** Zoom in / out / fit, bottom-right. Free tier — usability is not a feature. */
    private renderZoomControls(w: number, h: number, palette: ResolvedPalette): void {
        if (!this.zoom || !this.allowInteractions) return;
        const s = palette.surface;
        renderZoomControls(this.chrome, {
            width: w,
            height: h,
            // Stack above the gear (or the view switch) rather than on top of it.
            bottomInset: this.bottomRightTaken() ? GEAR_CLEARANCE : 0,
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
        });
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
        this.viewSignature = "";
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
     * Fit the whole chart into the space the host gives us.
     *
     * The automatic fit used to stop at a readable floor and CROP the rest, on
     * the theory that a readable window beats an unreadable whole. In practice
     * that is not what a fit is for: going from a report tile to focus mode, the
     * chart simply did not use the new space — it stayed cropped at both edges.
     *
     * The floor belongs earlier, where it can be paid for properly: the opening
     * auto-collapse (`depthThatFits`) and the level ratio both target
     * `MIN_FIT_SCALE`, so the view the author OPENS on is readable by
     * construction. Once they expand past that they have asked to see more, and
     * the honest answer is to show all of it, smaller — with zoom and pan for
     * detail.
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
        );
        this.zoom.apply(t);
        this.zoom.clearTouched();
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
        // The gear and, since OC-029, the view switch — whichever share this row.
        for (const g of [this.gearBox(), this.pillBox()]) {
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
        // The view switch is placed by us, so its box is known without measuring.
        const pill = this.pillBox();
        if (pill) clip(pill);
        if (this.zoom && this.allowInteractions && this.lastOptions) {
            const vw = this.lastOptions.viewport.width, vh = this.lastOptions.viewport.height;
            const inset = this.bottomRightTaken() ? GEAR_CLEARANCE : 0;
            if (vw >= 200 && vh >= 140 + inset) {
                const total = CONTROL_SIZE * 3 + 4 * 2;
                clip({ x: vw - 10 - CONTROL_SIZE, y: vh - 10 - total - 14 - inset, w: CONTROL_SIZE, h: total });
            }
        }
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
