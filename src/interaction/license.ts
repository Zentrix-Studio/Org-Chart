"use strict";

import powerbi from "powerbi-visuals-api";
type IVisualHost = powerbi.extensibility.visual.IVisualHost;

/**
 * Licence gate — the free/paid boundary.
 *
 * The paid features below are BUILT and LOCKED from their first published
 * version. They have never been free, so gating them withdraws nothing. That is
 * the one legal way to add a paid tier to a free visual.
 *
 * ⚠️ THE ONE-WAY DOOR. Microsoft: "customers must receive the same level of free
 * functionality as before the update." Anything that works for free in a
 * published version is free FOREVER. Never move a shipped-free feature into
 * `pro`: cross-filtering, both orientations, collapse/persistence, search,
 * styling, photos, legend, tooltips and keyboard access are free permanently.
 *
 * ⚠️ Two rules that have each already caused an S1 elsewhere in this portfolio
 * (see visuals/PRICING-MODEL.md):
 *   1. Check `hostEnv & Desktop` FIRST, before any licence branch. A signed-in
 *      Desktop session reaches the licence service and gets "no plan" back, so a
 *      late check locks Desktop to free.
 *   2. NEVER raise `LicenseNotificationType.UnsupportedEnv` — it overlays a
 *      blocker on exactly the environments we deliberately render in full.
 */

export type Tier = "free" | "pro";

/** Features the paid tier unlocks. Each ships locked; none was ever free. */
export type Feature =
    | "export"         // PNG / PDF / SVG + paginated print layout
    | "dottedLines"    // second manager / matrix reporting
    | "orgAnalytics"   // span of control, layers, descendants, vacancy flags
    | "rules"          // conditional-formatting rules engine
    | "temporal"       // org over time — joiners / leavers / movers
    | "annotations"    // pinned notes on people or branches
    | "scale";         // render beyond the free node cap

/**
 * The free/paid line — and for this visual there is no longer a line.
 *
 * ⚠️ CEO DECISION, 2026-09-11: the Org Chart ships as a FREE visual. Every
 * capability below is free, everywhere, for everyone. This is a **one-way
 * door**: Microsoft's rule — "customers must receive the same level of free
 * functionality as before the update" — means that once a version publishes
 * with these free, **none of them can ever be moved back behind a paywall.**
 *
 * The map itself is kept rather than deleted. It costs nothing, `allows()`
 * stays a single honest choke point, and a capability invented LATER can be
 * added here as "pro" without touching anything that shipped free — which is
 * the only kind of paid tier this visual can ever have.
 */
export const FEATURE_TIER: Record<Feature, Tier> = {
    export: "free",
    dottedLines: "free",
    orgAnalytics: "free",
    rules: "free",
    temporal: "free",
    annotations: "free",
    scale: "free",
};

/**
 * ⚠️ FROZEN ON PUBLICATION, and raised to "no cap" by the same 2026-09-11 CEO
 * decision. A cap may be RAISED at any time but can never be lowered, so this
 * can never go back to a finite number once a version has published uncapped.
 *
 * `Infinity` keeps every caller honest: `dataTransform` still compares against
 * it, `model.capped` simply never becomes true, and the "showing N of M" notice
 * correctly never appears. The row ceiling is now the host's own data-reduction
 * window (30,000) plus fetch-more-data, not a licence.
 */
export const FREE_NODE_CAP = Infinity;

/** Node cap for a tier. Infinity = uncapped. */
export function tierCap(tier: Tier): number {
    return tier === "free" ? FREE_NODE_CAP : Infinity;
}

/**
 * Plan IDs are PERMANENT. Add new ones, never delete an old one, or an existing
 * subscriber silently drops to free. Populated when the Partner Center plans are
 * created; empty until then.
 */
const PLAN_TIERS: Record<string, Tier> = {
    "zentrix-org-chart-seat": "pro",
    "zentrix-org-chart-companywide": "pro",
};

/**
 * ⚠️ STAYS TRUE, and since 2026-09-11 it no longer withholds anything.
 *
 * "Supported environment, no plans returned" still resolves to the FREE tier —
 * but free is now the whole product, so the flag decides nothing a user can
 * see. It is deliberately left alone rather than flipped: it is the safe
 * default, it is what the rest of the family does, and if a capability is ever
 * added to `FEATURE_TIER` as "pro" this is the behaviour that keeps it honest
 * from its first build.
 */
const LOCK_ON_NO_PLAN = true;

const ACTIVE_STATES = new Set(["Active", "Purchased"]);

interface ServicePlanLike { state?: string; status?: string; spState?: string; spIdentifier?: string; }
interface LicenseInfoLike { isLicenseUnsupportedEnv?: boolean; plans?: ServicePlanLike[]; servicePlans?: ServicePlanLike[]; }
interface LicenseManagerLike {
    getAvailableServicePlans?: () => Promise<LicenseInfoLike>;
}
interface HostLike {
    hostEnv?: unknown;
    licenseManager?: LicenseManagerLike;
}

/** Power BI's `HostEnv` bit for Desktop. */
const HOST_ENV_DESKTOP = 1;

/** True when this is a Power BI Desktop session — fully unlocked, forever. */
export function isDesktop(host: IVisualHost | HostLike | undefined): boolean {
    const raw = (host as HostLike | undefined)?.hostEnv;
    if (raw === undefined || raw === null) return false;
    if (typeof raw === "number") return (raw & HOST_ENV_DESKTOP) !== 0;
    const s = String(raw).toLowerCase();
    return s.indexOf("desktop") >= 0;
}

function planIsActive(p: ServicePlanLike): boolean {
    const s = p.state || p.status || p.spState;
    return s !== undefined && ACTIVE_STATES.has(s);
}

/**
 * Resolves the tier once and exposes a synchronous `tier` for the render loop,
 * which cannot await. Calls `onResolved` when the async answer lands so the
 * visual can repaint.
 */
export class LicenseGate {
    /** Current tier. Optimistic until the async resolution lands. */
    public tier: Tier = "pro";
    /** True once the host has answered (or failed). */
    public resolved = false;

    constructor(private host: IVisualHost, private onResolved?: () => void) {
        // RULE 1 — Desktop is checked FIRST, before touching the licence service.
        if (isDesktop(host)) {
            this.tier = "pro";
            this.resolved = true;
            return;
        }
        this.resolve();
    }

    private settle(tier: Tier): void {
        this.tier = tier;
        this.resolved = true;
        if (this.onResolved) this.onResolved();
    }

    private resolve(): void {
        const mgr = (this.host as unknown as HostLike).licenseManager;
        if (!mgr || typeof mgr.getAvailableServicePlans !== "function") {
            this.settle("pro");                       // older host — fail open, never block
            return;
        }
        let p: Promise<LicenseInfoLike>;
        try {
            p = mgr.getAvailableServicePlans() as Promise<LicenseInfoLike>;
        } catch {
            this.settle("pro");
            return;
        }
        if (!p || typeof p.then !== "function") {
            this.settle("pro");
            return;
        }
        p.then((info) => {
            // RULE 2 — an unsupported environment renders in FULL and raises nothing.
            // Report Server / embedded / national clouds are licensed off-marketplace
            // (see PRICING-MODEL.md), so AppSource plans cannot apply there. Failing
            // open is the family-wide behaviour and is deliberate, not an oversight.
            if (!info || info.isLicenseUnsupportedEnv) { this.settle("pro"); return; }
            const plans = info.plans || info.servicePlans || [];
            if (plans.length === 0) { this.settle(LOCK_ON_NO_PLAN ? "free" : "pro"); return; }
            for (const plan of plans) {
                if (!planIsActive(plan)) continue;
                const t = (plan.spIdentifier && PLAN_TIERS[plan.spIdentifier]) || "pro";
                if (t === "pro") { this.settle("pro"); return; }
            }
            this.settle("free");
        }).catch(() => this.settle("pro"));           // any API error -> demoable, never crash
    }

    /** True when the current tier may use `feature`. */
    allows(feature: Feature): boolean {
        return this.tier === "pro" || FEATURE_TIER[feature] === "free";
    }

    /** Node cap for the current tier. */
    get nodeCap(): number {
        return tierCap(this.tier);
    }
}
