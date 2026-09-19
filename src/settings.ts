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

    /** Stretch the spacing between levels so the chart fills the visual instead
     *  of sitting as a thin band in the middle of it. While this is on, level
     *  spacing is a MINIMUM rather than an exact value. */
    fillViewport = new formattingSettings.ToggleSwitch({
        name: "fillViewport",
        displayName: "Fill the viewport",
        value: true,
    });

    /** Open a hierarchy too big to show whole with its deep levels collapsed,
     *  rather than on an unreadable slice. Turning it off stops FUTURE
     *  auto-collapses; it never expands what is already collapsed. */
    collapseToFit = new formattingSettings.ToggleSwitch({
        name: "collapseToFit",
        displayName: "Collapse deep levels to fit",
        value: true,
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
    slices: FormattingSettingsSlice[] = [
        this.orientation, this.levelGap, this.siblingGap, this.fillViewport,
        this.collapseToFit, this.collapseToFitDone, this.collapsed,
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
            { value: "auto", displayName: "Auto (top right)" },
            { value: "tl", displayName: "Top left" },
            { value: "tr", displayName: "Top right" },
            { value: "bl", displayName: "Bottom left" },
            { value: "br", displayName: "Bottom right" },
        ],
        value: { value: "auto", displayName: "Auto (top right)" },
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
    position = new formattingSettings.ItemDropdown({
        name: "position", displayName: "Gear position",
        items: [
            { value: "auto", displayName: "Auto (top right)" },
            { value: "bl", displayName: "Bottom left" },
            { value: "tl", displayName: "Top left" },
            { value: "tr", displayName: "Top right" },
            { value: "br", displayName: "Bottom right" },
        ],
        value: { value: "auto", displayName: "Auto (top right)" },
    });
    closeOnClickAway = new formattingSettings.ToggleSwitch({
        name: "closeOnClickAway", displayName: "Close on click-away", value: true,
    });
    name = "toolbar";
    displayName = "Toolbar";
    slices: FormattingSettingsSlice[] = [this.show, this.position, this.closeOnClickAway];
}

/**
 * Zentrix branding — a subtle wordmark on the tooltip card. Default on, and any
 * user can turn it off here: it has never been gated and never will be.
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
        this.overlays, this.summaryTable, this.insights,
        this.rules, this.orgAnalysis, this.toolbar, this.branding,
    ];
}
