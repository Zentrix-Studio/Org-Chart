"use strict";

/**
 * Format-pane model.
 *
 * Category names follow the canonical taxonomy in visuals/SETTINGS-TAXONOMY.md.
 * The two domain-named slots are Connectors (slot 4, "Edges/Links") and — once
 * the paid analytics land — Org analysis (slot 9).
 *
 * ⚠️ The programmatic `name` keys are the PERSISTENCE CONTRACT and must never be
 * renamed. Only `displayName` may change.
 */

import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import ValidatorType = powerbi.visuals.ValidatorType;
import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

import { accentStrong } from "./theme/zentrixTokens";

class LayoutCard extends FormattingSettingsCard {
    orientation = new formattingSettings.ItemDropdown({
        name: "orientation",
        displayName: "Orientation",
        items: [
            { value: "topDown", displayName: "Top-down" },
            { value: "leftRight", displayName: "Left-to-right" },
        ],
        value: { value: "topDown", displayName: "Top-down" },
    });

    levelGap = new formattingSettings.NumUpDown({
        name: "levelGap",
        displayName: "Level spacing",
        value: 48,
        options: { minValue: { type: ValidatorType.Min, value: 8 }, maxValue: { type: ValidatorType.Max, value: 240 } },
    });

    siblingGap = new formattingSettings.NumUpDown({
        name: "siblingGap",
        displayName: "Sibling spacing",
        value: 20,
        options: { minValue: { type: ValidatorType.Min, value: 4 }, maxValue: { type: ValidatorType.Max, value: 200 } },
    });

    /** Leaf reports (OC-030, zentrix-org-chart#1): a manager whose reports are
     *  all leaves gets them in columns instead of one row. Auto stacks only when
     *  that draws the chart larger, so a team that already fits looks as it did. */
    leafStack = new formattingSettings.ItemDropdown({
        name: "leafStack",
        displayName: "Leaf reports",
        description: "Put a manager's direct reports in columns so wide teams stay readable. Auto stacks a team only when that draws the chart larger.",
        items: [
            { value: "auto", displayName: "Auto" },
            { value: "row", displayName: "Row" },
            { value: "stacked", displayName: "Stacked" },
        ],
        value: { value: "auto", displayName: "Auto" },
    });

    /** Stretch the spacing between levels so the chart fills the visual instead
     *  of sitting as a thin band in the middle of it. While this is on, level
     *  spacing is a MINIMUM rather than an exact value. */
    fillViewport = new formattingSettings.ToggleSwitch({
        name: "fillViewport",
        displayName: "Fill the viewport",
        value: true,
    });

    /**
     * Open a hierarchy too big to show whole with its deep levels collapsed,
     * rather than on an unreadable slice.
     *
     * ⚠️ It is an INSTRUCTION, not only an opening behaviour (OC-037): flipping
     * it ON collapses to fit there and then, flipping it OFF shows every level.
     * Before that it ran once per report and the switch was dead from the second
     * render on. What it still never does is re-apply ITSELF on a refresh — that
     * would fight a reader who had expanded a branch by hand, which is what
     * `collapseToFitDone` is for.
     */
    collapseToFit = new formattingSettings.ToggleSwitch({
        name: "collapseToFit",
        displayName: "Collapse deep levels to fit",
        value: true,
    });

    /**
     * Per-level collapse (OC-035, CEO 2026-09-20). One switch per level from 2 —
     * level 1 is the roots and is always drawn. ON means "this level is shown";
     * turning one OFF collapses every node on the level above it.
     *
     * The switches are a LADDER, and the gear's setter keeps them one: turning a
     * level off turns every deeper level off with it, turning one on turns every
     * shallower level on. A level cannot be visible while its parent level is
     * folded away, so any other arrangement would be a lie on screen.
     *
     * They are an INSTRUCTION, not a running constraint: the visual applies them
     * when the ladder CHANGES (against `levelsApplied`) and then leaves the
     * collapse set alone, so a reader clicking one branch open is not overruled
     * on the next render. The same contract `collapseToFitDone` already has.
     *
     * Eleven is the ceiling because an org eleven layers deep is already past
     * what any chart reads; deeper levels follow level 11.
     */
    level2 = new formattingSettings.ToggleSwitch({ name: "level2", displayName: "Level 2", value: true });
    level3 = new formattingSettings.ToggleSwitch({ name: "level3", displayName: "Level 3", value: true });
    level4 = new formattingSettings.ToggleSwitch({ name: "level4", displayName: "Level 4", value: true });
    level5 = new formattingSettings.ToggleSwitch({ name: "level5", displayName: "Level 5", value: true });
    level6 = new formattingSettings.ToggleSwitch({ name: "level6", displayName: "Level 6", value: true });
    level7 = new formattingSettings.ToggleSwitch({ name: "level7", displayName: "Level 7", value: true });
    level8 = new formattingSettings.ToggleSwitch({ name: "level8", displayName: "Level 8", value: true });
    level9 = new formattingSettings.ToggleSwitch({ name: "level9", displayName: "Level 9", value: true });
    level10 = new formattingSettings.ToggleSwitch({ name: "level10", displayName: "Level 10", value: true });
    level11 = new formattingSettings.ToggleSwitch({ name: "level11", displayName: "Level 11", value: true });

    /** The ladder the visual has already acted on — machine state, not a control.
     *  Without it a re-render would re-apply the levels and undo every branch the
     *  reader had opened by hand. */
    levelsApplied = new formattingSettings.TextInput({
        name: "levelsApplied", displayName: "Levels applied", value: "", placeholder: "", visible: false,
    });

    /** Records that the auto-collapse has already run for this report, so it
     *  never fights a user who deliberately expanded everything.
     *  Hidden from the pane — written by the visual. */
    collapseToFitDone = new formattingSettings.ToggleSwitch({
        name: "collapseToFitDone",
        displayName: "Collapse to fit applied",
        value: false,
        visible: false,
    });

    /** Persisted collapse state (JSON array of collapsed Person ID keys).
     *  Hidden from the pane — written by the visual, never edited by hand. */
    collapsed = new formattingSettings.TextInput({
        name: "collapsed",
        displayName: "Collapsed branches",
        value: "",
        placeholder: "",
        visible: false,
    });

    name = "layout";
    displayName = "Layout";
    /** Every level switch, shallowest first — the ladder, in order. */
    levelSlices(): formattingSettings.ToggleSwitch[] {
        return [
            this.level2, this.level3, this.level4, this.level5, this.level6,
            this.level7, this.level8, this.level9, this.level10, this.level11,
        ];
    }

    slices: FormattingSettingsSlice[] = [
        this.orientation, this.levelGap, this.siblingGap, this.leafStack, this.fillViewport,
        this.collapseToFit,
        this.level2, this.level3, this.level4, this.level5, this.level6,
        this.level7, this.level8, this.level9, this.level10, this.level11,
        this.levelsApplied, this.collapseToFitDone, this.collapsed,
    ];
}

class NodesCard extends FormattingSettingsCard {
    /**
     * How big each card is.
     *  • `level` — cards grow towards the root (x → 2x → 4x), by as much as the
     *    space allows without squeezing the leaves. The default.
     *  • `auto`  — one size for every card, drawn above 1:1 when there is room.
     *  • `fixed` — exactly the width and height set below, never scaled up.
     */
    sizeMode = new formattingSettings.ItemDropdown({
        name: "sizeMode",
        displayName: "Card sizing",
        items: [
            { value: "level", displayName: "By level — bigger nearer the top" },
            { value: "auto", displayName: "Auto — grow to fit the visual" },
            { value: "fixed", displayName: "Fixed" },
        ],
        value: { value: "level", displayName: "By level — bigger nearer the top" },
    });

    cardWidth = new formattingSettings.NumUpDown({
        name: "cardWidth", displayName: "Card width", value: 168,
        options: { minValue: { type: ValidatorType.Min, value: 80 }, maxValue: { type: ValidatorType.Max, value: 420 } },
    });
    cardHeight = new formattingSettings.NumUpDown({
        name: "cardHeight", displayName: "Card height", value: 58,
        options: { minValue: { type: ValidatorType.Min, value: 32 }, maxValue: { type: ValidatorType.Max, value: 200 } },
    });
    cornerRadius = new formattingSettings.NumUpDown({
        name: "cornerRadius", displayName: "Corner radius", value: 10,
        options: { minValue: { type: ValidatorType.Min, value: 0 }, maxValue: { type: ValidatorType.Max, value: 32 } },
    });
    showPhoto = new formattingSettings.ToggleSwitch({
        name: "showPhoto", displayName: "Show photo", value: true,
    });

    /**
     * Photo shape. The image is CLIPPED to this — until OC-025 it was not
     * clipped at all, so a square picture sat over a round outline and hid it.
     * All three shapes are one rounded rect: rx = r is a circle, rx = 0 a square.
     */
    photoShape = new formattingSettings.ItemDropdown({
        name: "photoShape",
        displayName: "Photo shape",
        items: [
            { value: "circle", displayName: "Circle" },
            { value: "rounded", displayName: "Rounded square" },
            { value: "square", displayName: "Square" },
        ],
        value: { value: "circle", displayName: "Circle" },
    });
    /**
     * Diameter as a percentage of card height. 62 reproduces what the visual drew
     * before this control existed — the old size was `min(H * 0.32, 18 * scale)`
     * as a RADIUS, which lands within a pixel of 62% of the height at every level.
     */
    photoSize = new formattingSettings.NumUpDown({
        name: "photoSize", displayName: "Photo size", value: 62,
        options: { minValue: { type: ValidatorType.Min, value: 20 }, maxValue: { type: ValidatorType.Max, value: 90 } },
    });
    photoRing = new formattingSettings.ToggleSwitch({
        name: "photoRing", displayName: "Photo outline", value: true,
    });
    /** Blank means "follow the card's accent", which is what shipped before. */
    photoRingColor = new formattingSettings.ColorPicker({
        name: "photoRingColor", displayName: "Outline colour", value: { value: "" },
    });
    photoRingWidth = new formattingSettings.NumUpDown({
        name: "photoRingWidth", displayName: "Outline width", value: 1.2,
        options: { minValue: { type: ValidatorType.Min, value: 0 }, maxValue: { type: ValidatorType.Max, value: 6 } },
    });
    /**
     * What a row with no photo gets. The default is initials rather than nothing:
     * with `none`, a dataset where only some people have a picture draws cards
     * whose text starts in two different places, which reads as broken.
     */
    photoFallback = new formattingSettings.ItemDropdown({
        name: "photoFallback",
        displayName: "When there is no photo",
        items: [
            { value: "initials", displayName: "Initials" },
            { value: "icon", displayName: "Person icon" },
            { value: "blank", displayName: "Empty circle" },
            { value: "none", displayName: "Nothing — close up the space" },
        ],
        value: { value: "initials", displayName: "Initials" },
    });

    showMeasure = new formattingSettings.ToggleSwitch({
        name: "showMeasure", displayName: "Show measure badge", value: true,
    });

    name = "nodes";
    displayName = "Nodes";
    slices: FormattingSettingsSlice[] = [
        this.sizeMode, this.cardWidth, this.cardHeight, this.cornerRadius,
        this.showPhoto, this.photoShape, this.photoSize, this.photoRing,
        this.photoRingColor, this.photoRingWidth, this.photoFallback,
        this.showMeasure,
    ];
}

class ColorsCard extends FormattingSettingsCard {
    colorMode = new formattingSettings.ItemDropdown({
        name: "colorMode",
        displayName: "Colour by",
        items: [
            { value: "single", displayName: "Single colour" },
            { value: "group", displayName: "Group" },
            { value: "level", displayName: "Level" },
        ],
        value: { value: "group", displayName: "Group" },
    });
    cardFill = new formattingSettings.ColorPicker({
        name: "cardFill", displayName: "Accent colour", value: { value: accentStrong },
    });
    accentBar = new formattingSettings.ToggleSwitch({
        name: "accentBar", displayName: "Accent bar", value: true,
    });
    /** When on, group colours come from the report's theme via
     *  colorPalette.getColor, so the chart adopts the customer's branding. */
    useReportTheme = new formattingSettings.ToggleSwitch({
        name: "useReportTheme", displayName: "Use report theme", value: true,
    });

    name = "colors";
    displayName = "Colours";
    slices: FormattingSettingsSlice[] = [this.colorMode, this.cardFill, this.accentBar, this.useReportTheme];
}

class ConnectorsCard extends FormattingSettingsCard {
    style = new formattingSettings.ItemDropdown({
        name: "style",
        displayName: "Line style",
        items: [
            { value: "elbow", displayName: "Elbow" },
            { value: "straight", displayName: "Straight" },
            { value: "curved", displayName: "Curved" },
        ],
        value: { value: "elbow", displayName: "Elbow" },
    });
    width = new formattingSettings.NumUpDown({
        name: "width", displayName: "Thickness", value: 1.5,
        options: { minValue: { type: ValidatorType.Min, value: 0.5 }, maxValue: { type: ValidatorType.Max, value: 8 } },
    });
    color = new formattingSettings.ColorPicker({
        name: "color", displayName: "Colour", value: { value: "#C9C9D4" },
    });

    name = "connectors";
    displayName = "Connectors";
    slices: FormattingSettingsSlice[] = [this.style, this.width, this.color];
}

class LabelsCard extends FormattingSettingsCard {
    nameSize = new formattingSettings.NumUpDown({
        name: "nameSize", displayName: "Name size", value: 12.5,
        options: { minValue: { type: ValidatorType.Min, value: 7 }, maxValue: { type: ValidatorType.Max, value: 28 } },
    });
    titleSize = new formattingSettings.NumUpDown({
        name: "titleSize", displayName: "Title size", value: 10.5,
        options: { minValue: { type: ValidatorType.Min, value: 6 }, maxValue: { type: ValidatorType.Max, value: 24 } },
    });
    showTitle = new formattingSettings.ToggleSwitch({
        name: "showTitle", displayName: "Show title", value: true,
    });

    name = "labels";
    displayName = "Labels";
    slices: FormattingSettingsSlice[] = [this.nameSize, this.titleSize, this.showTitle];
}

class OverlaysCard extends FormattingSettingsCard {
    tooltipStyle = new formattingSettings.ItemDropdown({
        name: "tooltipStyle",
        displayName: "Tooltip",
        items: [
            { value: "card", displayName: "Zentrix card" },
            { value: "native", displayName: "Power BI" },
            { value: "off", displayName: "Off" },
        ],
        value: { value: "card", displayName: "Zentrix card" },
    });
    showLegend = new formattingSettings.ToggleSwitch({
        name: "showLegend", displayName: "Legend", value: true,
    });
    showSearch = new formattingSettings.ToggleSwitch({
        name: "showSearch", displayName: "Search box", value: true,
    });

    name = "overlays";
    displayName = "Overlays";
    slices: FormattingSettingsSlice[] = [this.tooltipStyle, this.showLegend, this.showSearch];
}

/**
 * The minimap (OC-034) — the whole chart as a thumbnail, with the part on screen
 * marked and draggable. Family name: the Gantt's `minimap.show`.
 *
 * Default ON. Since OC-030 a large hierarchy opens as a deliberate CROP, and a
 * crop with no overview is the defect OC-QA-02 was; the thumbnail is how a
 * reader sees how much more there is.
 */
class MinimapCard extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({
        name: "show", displayName: "Minimap", value: true,
        description: "A thumbnail of the whole chart in the bottom corner, with the visible part marked. Click or drag it to move the view.",
    });
    name = "minimap";
    displayName = "Minimap";
    slices: FormattingSettingsSlice[] = [this.show];
}

/**
 * The Table segment of the view switch, and where the switch sits (OC-029).
 * Object and property names are the FAMILY's (`summaryTable.show` /
 * `summaryTable.position`, as in the Network Graph and the Sankey) — keep them.
 */
class SummaryTableCard extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({
        name: "show", displayName: "Show summary table", value: true,
        description: "Add a Table segment to the view switch: everyone in the hierarchy as a sortable, searchable table.",
    });
    position = new formattingSettings.ItemDropdown({
        name: "position",
        displayName: "View switch position",
        items: [
            { value: "auto", displayName: "Auto (bottom right)" },
            { value: "tl", displayName: "Top left" },
            { value: "tr", displayName: "Top right" },
            { value: "bl", displayName: "Bottom left" },
            { value: "br", displayName: "Bottom right" },
        ],
        value: { value: "auto", displayName: "Auto (bottom right)" },
    });
    name = "summaryTable";
    displayName = "Summary table";
    slices: FormattingSettingsSlice[] = [this.show, this.position];
}

/** The Insight segment of the view switch (OC-029). Family name: `insights.show`. */
class InsightsCard extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({
        name: "show", displayName: "Show insights", value: true,
        description: "Add an Insight segment to the view switch: a plain-English read-out of span of control, depth, the largest branches and data problems.",
    });
    name = "insights";
    displayName = "Insights";
    slices: FormattingSettingsSlice[] = [this.show];
}

/** PAID — conditional formatting. Slot 7 of the canonical taxonomy. */
class RulesCard extends FormattingSettingsCard {
    enabled = new formattingSettings.ToggleSwitch({
        name: "enabled", displayName: "Conditional formatting", value: false,
    });
    /** Serialized CFRule[] — written by the rules editor, not typed by hand. */
    definition = new formattingSettings.TextInput({
        name: "definition", displayName: "Rules", value: "", placeholder: "", visible: false,
    });

    name = "rules";
    displayName = "Rules";
    /** Hidden from the pane until the rule editor ships (#17, OC-QA-37). The values
     *  still populate — `populateFormattingSettingsModel` ignores `visible` — so a
     *  report that stored rules keeps them. */
    visible = false;
    slices: FormattingSettingsSlice[] = [this.enabled, this.definition];
}

/** PAID — the domain-named slot 9. */
class OrgAnalysisCard extends FormattingSettingsCard {
    showMetrics = new formattingSettings.ToggleSwitch({
        name: "showMetrics", displayName: "Show span metrics", value: false,
    });
    spanWide = new formattingSettings.NumUpDown({
        name: "spanWide", displayName: "Wide span above", value: 12,
        options: { minValue: { type: ValidatorType.Min, value: 1 }, maxValue: { type: ValidatorType.Max, value: 200 } },
    });
    spanNarrow = new formattingSettings.NumUpDown({
        name: "spanNarrow", displayName: "Narrow span below", value: 2,
        options: { minValue: { type: ValidatorType.Min, value: 1 }, maxValue: { type: ValidatorType.Max, value: 50 } },
    });
    flagVacancies = new formattingSettings.ToggleSwitch({
        name: "flagVacancies", displayName: "Flag vacancies", value: false,
    });
    showSummary = new formattingSettings.ToggleSwitch({
        name: "showSummary", displayName: "Summary strip", value: false,
    });
    compareperiods = new formattingSettings.ToggleSwitch({
        name: "compareperiods", displayName: "Compare periods", value: false,
    });
    /** Serialized Note[] — written by the annotation UI. */
    notes = new formattingSettings.TextInput({
        name: "notes", displayName: "Annotations", value: "", placeholder: "", visible: false,
    });

    name = "orgAnalysis";
    displayName = "Org analysis";
    slices: FormattingSettingsSlice[] = [
        this.showMetrics, this.spanWide, this.spanNarrow,
        this.flagVacancies, this.showSummary, this.compareperiods, this.notes,
    ];
}

/**
 * The in-visual gear — the Zentrix Settings Bar. Shared across the family, so
 * the names here match every other visual's `toolbar` object exactly.
 */
class ToolbarCard extends FormattingSettingsCard {
    show = new formattingSettings.ToggleSwitch({ name: "show", displayName: "Show gear", value: true });
    /**
     * ⚠️ Auto resolves to BOTTOM-RIGHT since OC-034 (CEO, 2026-09-20), where it
     * sits beside the view switch; OC-020 had put it top-right. The corner it
     * vacated is the quick-action bar's. `auto` is a stored value, not a stored
     * corner, so a report that never set this follows the new default — which is
     * the intent: chrome placement is a look, not data.
     */
    position = new formattingSettings.ItemDropdown({
        name: "position", displayName: "Gear position",
        items: [
            { value: "auto", displayName: "Auto (bottom right)" },
            { value: "bl", displayName: "Bottom left" },
            { value: "tl", displayName: "Top left" },
            { value: "tr", displayName: "Top right" },
            { value: "br", displayName: "Bottom right" },
        ],
        value: { value: "auto", displayName: "Auto (bottom right)" },
    });
    closeOnClickAway = new formattingSettings.ToggleSwitch({
        name: "closeOnClickAway", displayName: "Close on click-away", value: true,
    });

    /**
     * The quick-action bar — zoom in / zoom out / fit / lens (OC-034). It has
     * always been drawn; what is new is that the author can move it, and turn it
     * off. The family calls this pair `toolbar.actions` / `actionsPosition`
     * (Gantt) — keep the names.
     */
    actions = new formattingSettings.ToggleSwitch({
        name: "actions", displayName: "Quick actions (zoom, lens)", value: true,
    });
    /**
     * OC-048 — fade the on-canvas chrome (gear, view switch, quick-action bar, search
     * box) while the cursor is outside the visual. The family's `toolbar.autoHide`
     * (HM-V2-41, Calendar Heatmap). Default on, as there.
     */
    autoHide = new formattingSettings.ToggleSwitch({
        name: "autoHide", displayName: "Auto disappear", value: true,
    });
    actionsPosition = new formattingSettings.ItemDropdown({
        name: "actionsPosition", displayName: "Quick actions position",
        items: [
            { value: "tr", displayName: "Top right" },
            { value: "tl", displayName: "Top left" },
            { value: "bl", displayName: "Bottom left" },
            { value: "br", displayName: "Bottom right" },
        ],
        value: { value: "tr", displayName: "Top right" },
    });
    /** The magnifier button in that bar. Off leaves the original three. */
    lens = new formattingSettings.ToggleSwitch({
        name: "lens", displayName: "Lens", value: true,
        description: "A magnifying loupe that follows the pointer, for reading cards drawn too small to see.",
    });

    name = "toolbar";
    displayName = "Toolbar";
    slices: FormattingSettingsSlice[] = [
        this.show, this.position, this.closeOnClickAway,
        this.actions, this.autoHide, this.actionsPosition, this.lens,
    ];
}

/**
 * Zentrix branding — a subtle wordmark on the tooltip card. Default on, and any
 * user can turn it off here: it has never been gated and never will be.
 *
 * ⚠️ On does NOT mean everywhere (OC-043). Microsoft's publishing guidelines
 * allow a company mark in EDIT mode only — "Commercial logos can't be displayed
 * in view mode" — and a text-only logotype is one of the three kinds they name.
 * So the wordmark is drawn for an author and never for a report reader; this
 * switch says whether it is wanted at all, `Visual.editing` says where it is
 * allowed. Do not "fix" the reader case back on.
 */
class BrandingCard extends FormattingSettingsCard {
    showBranding = new formattingSettings.ToggleSwitch({
        name: "showBranding", displayName: "Show branding", value: true,
    });
    name = "branding";
    displayName = "Zentrix branding";
    slices: FormattingSettingsSlice[] = [this.showBranding];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    layout = new LayoutCard();
    nodes = new NodesCard();
    colors = new ColorsCard();
    connectors = new ConnectorsCard();
    labels = new LabelsCard();
    overlays = new OverlaysCard();
    minimap = new MinimapCard();
    summaryTable = new SummaryTableCard();
    insights = new InsightsCard();
    rules = new RulesCard();
    orgAnalysis = new OrgAnalysisCard();
    toolbar = new ToolbarCard();
    branding = new BrandingCard();

    // Canonical taxonomy order (SETTINGS-TAXONOMY.md): the domain slots are
    // Connectors (4) and Org analysis (9); Rules is slot 7.
    // Taxonomy order (visuals/SETTINGS-TAXONOMY.md): Layout · Nodes · Colours ·
    // Connectors · Labels · Overlays, then the domain and chrome cards.
    cards = [
        this.layout, this.nodes, this.colors, this.connectors, this.labels,
        this.overlays, this.minimap, this.summaryTable, this.insights,
        this.rules, this.orgAnalysis, this.toolbar, this.branding,
    ];
}
