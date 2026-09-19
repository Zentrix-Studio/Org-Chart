"use strict";

/**
 * Localization.
 *
 * Power BI hands the visual a locale (`host.locale`) and a localization manager
 * (`host.createLocalizationManager()`); `getDisplayName(key)` resolves a key
 * against the `resources.resjson` for that locale, which pbiviz bundles from
 * `stringResources/`.
 *
 * Source: learn.microsoft.com/power-bi/developer/visuals/localization
 *
 * Every string is looked up through here with an English default, so a missing
 * key or an older host degrades to readable English instead of showing the raw
 * key — which is what happens if you call getDisplayName blind.
 */

import powerbi from "powerbi-visuals-api";
type IVisualHost = powerbi.extensibility.visual.IVisualHost;

interface LocalizationManagerLike {
    getDisplayName?: (key: string) => string;
}

/** English defaults. Kept in sync with stringResources/en-US/resources.resjson. */
const DEFAULTS: Record<string, string> = {
    Landing_NeedBoth: "Add a Person ID and a Reports to field to draw the hierarchy.",
    Landing_NeedPerson: "Add a Person ID field — the unique key for each row.",
    Landing_NeedParent: "Add a Reports to field — each row's parent key.",
    Landing_NoRows: "No rows in the current filter — the chart draws when data returns.",
    Zoom_In: "Zoom in",
    Zoom_Out: "Zoom out",
    Zoom_Fit: "Fit to view",
    Landing_Title: "Zentrix Org Chart",
    Landing_Tagline: "Any parent-child hierarchy, drawn as a tree of cards",
    // Field-well names, echoed by the landing page checklist.
    Role_PersonId: "Person ID *",
    Role_ParentId: "Reports to *",
    Role_Name: "Name",
    Role_Title: "Title",
    Role_Photo: "Photo",
    Role_Group: "Group",
    Role_Measure: "Measure",
    // Landing page capability tiles — every one of these ships free.
    Cap_AnyRoot: "Any root shape",
    Cap_AnyRoot_Sub: "Blank or missing parents are roots.",
    Cap_Collapse: "Collapse that sticks",
    Cap_Collapse_Sub: "Survives refresh and bookmarks.",
    Cap_CrossFilter: "Click filters the page",
    Cap_CrossFilter_Sub: "Selecting a card filters every visual.",
    Cap_Cycles: "Loops can't hang it",
    Cap_Cycles_Sub: "A reporting loop becomes a root.",
    Cap_WideRow: "Wide teams fit",
    Cap_WideRow_Sub: "40 reports under one manager.",
    Cap_Orientation: "Both orientations",
    Cap_Orientation_Sub: "Top-down, or left-to-right.",
    Status_Showing: "showing {0} of {1} people",
    Status_Cycles: "{0} circular reporting links shown as roots",
    Status_Roots: "{0} roots",
    Status_Panned: "showing part of the chart — drag to pan, or use ⛶ to fit it all",
    Status_People: "{0} people",
    Status_Managers: "{0} managers",
    Status_Layers: "{0} layers",
    Status_AvgSpan: "avg span {0}",
    Status_WideSpans: "{0} wide spans",
    Status_Vacancies: "{0} vacancies",
    Status_Changes: "+{0} joined · -{1} left · {2} moved",
    // Superseded by Status_Panned (OC-021), which names the control that fixes it.
    // Kept declared so an older persisted resource file still resolves.
    Status_Clipped: "part of the chart is off screen — drag to pan",
    // Legend and search — both free-tier, both blocked publication until OC-017.
    Legend_Title: "Legend",
    Legend_More: "+{0} more",
    Legend_Level: "Level {0}",
    Search_Placeholder: "Search people",
    Search_Count: "{0} of {1}",
    Search_NoMatch: "no match",
    Search_Next: "Next match",
    Tooltip_DirectReports: "Direct reports",
    Tooltip_TotalBranch: "Total in branch",
    Tooltip_LayersBelow: "Layers below",
    Tooltip_Span: "Span of control",
    Tooltip_SpanWide: "Wide",
    Tooltip_SpanNarrow: "Narrow",
    Tooltip_Status: "Status",
    Tooltip_Vacant: "Vacant",
    Tooltip_Group: "Group",
    Tooltip_Measure: "Measure",
    Tooltip_Note: "Note",
    Aria_DirectReports: "{0} direct reports",
};

/** Substitute {0}, {1}, … positionally. */
export function format(template: string, ...args: Array<string | number>): string {
    return template.replace(/\{(\d+)\}/g, (whole, idx) => {
        const i = Number(idx);
        return i >= 0 && i < args.length ? String(args[i]) : whole;
    });
}

export class Localization {
    private mgr: LocalizationManagerLike | null = null;
    /** The host locale, e.g. "de-DE". Drives number formatting too. */
    public readonly locale: string;

    constructor(host?: IVisualHost) {
        this.locale = (host as unknown as { locale?: string })?.locale || "en-US";
        const create = (host as unknown as {
            createLocalizationManager?: () => LocalizationManagerLike;
        })?.createLocalizationManager;
        if (typeof create === "function") {
            try {
                this.mgr = create.call(host);
            } catch {
                this.mgr = null;   // never let localization break construction
            }
        }
    }

    /** Localized string for `key`, falling back to English. */
    get(key: string): string {
        const fallback = DEFAULTS[key] ?? key;
        if (!this.mgr || typeof this.mgr.getDisplayName !== "function") return fallback;
        try {
            const v = this.mgr.getDisplayName(key);
            // A host that cannot resolve the key echoes it back — prefer English.
            return v && v !== key ? v : fallback;
        } catch {
            return fallback;
        }
    }

    /** Localized string with positional substitution. */
    fmt(key: string, ...args: Array<string | number>): string {
        return format(this.get(key), ...args);
    }
}
