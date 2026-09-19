"use strict";

/**
 * In-visual settings overlay — the host wrapper around the shared Zentrix
 * Settings Bar (the gear). It wires the live formatting model and
 * `persistProperties` to the bar, and forwards theme, corner and visibility from
 * the visual's update loop.
 *
 * The bar engine and this wrapper are family-standard; the only org-chart code is
 * `settingsSchema.ts`. Ported from the Calendar Heatmap's copy, which is the
 * simplest in the family and the closest fit for a visual with one settings model
 * and no colour blob.
 */

import type powerbi from "powerbi-visuals-api";
type IVisualHost = powerbi.extensibility.visual.IVisualHost;

import { VisualFormattingSettingsModel } from "../settings";
import { ZentrixSettingsBar } from "./zentrixSettingsBar";
import {
    SB_CATS, SB_FONTS, SB_PALETTES, SB_PRESETS, SB_EMOJI,
    makeCfg, applyLocal, readLocal, PersistWrite,
} from "./settingsSchema";

type Model = VisualFormattingSettingsModel;

/** Shallow-clone a slice value so the live model never shares an object
 *  reference with the throwaway defaults model. */
function clone<T>(v: T): T {
    return v && typeof v === "object" ? { ...(v as object) } as T : v;
}

/** Serialize a slice value into the shape `persistProperties` expects. Returns
 *  undefined for kinds that cannot be persisted, so they are skipped rather than
 *  corrupted. */
function persistValue(slice: { value: unknown; items?: unknown[] }): powerbi.DataViewPropertyValue | undefined {
    const v = slice.value as { value?: unknown } | boolean | number | string | null;
    if (Array.isArray(slice.items)) return String((v as { value: unknown }).value);
    if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
    if (v && typeof (v as { value?: unknown }).value === "string") {
        return { solid: { color: (v as { value: string }).value } } as unknown as powerbi.DataViewPropertyValue;
    }
    return undefined;
}

export class SettingsOverlay {
    private bar: ZentrixSettingsBar;
    private settings!: Model;
    private pref = "auto";
    /** Optimistic edits not yet confirmed by a host round-trip. Replayed onto each
     *  freshly populated model so a stale update() cannot revert the canvas. */
    private pending = new Map<string, unknown>();

    /**
     * @param onReset fired after a Reset, so the visual can drop the view state it
     *                holds in memory. Resetting the PROPERTIES is not enough: the
     *                collapse set lives on the instance, and without this the
     *                chart stayed collapsed after a Reset that had already wiped
     *                the stored state.
     */
    constructor(
        root: HTMLElement,
        private host: IVisualHost,
        private onChange?: () => void,
        private onReset?: () => void,
    ) {
        // One persistProperties merge per edit, grouped by object: several
        // synchronous calls are coalesced by the host and all but the last are lost.
        const persist = (writes: PersistWrite[]): void => {
            const byObject = new Map<string, Record<string, powerbi.DataViewPropertyValue>>();
            for (const w of writes) {
                const props = byObject.get(w.object) ?? {};
                props[w.prop] = w.value;
                byObject.set(w.object, props);
            }
            const merge = [...byObject].map(([objectName, properties]) => ({
                objectName, selector: null, properties,
            }));
            this.host.persistProperties({ merge } as unknown as powerbi.VisualObjectInstancesToPersist);
        };

        const cfg = makeCfg(() => this.settings, persist, (key, value) => {
            this.pending.set(key, value);
            this.onChange?.();
        }, () => this.reset());

        this.bar = new ZentrixSettingsBar(root, {
            cfg, cats: SB_CATS, fonts: SB_FONTS, palettes: SB_PALETTES,
            presets: SB_PRESETS, emoji: SB_EMOJI,
            corner: "bl", dark: false, closeOnAway: true,
        });
    }

    /**
     * Re-apply optimistic edits onto a freshly populated model, dropping the ones
     * the host has since confirmed.
     *
     * Called by the visual immediately after `populateFormattingSettingsModel`
     * and BEFORE it renders. It used to happen inside `update()` at the end of
     * the render, which meant a gear edit repainted with the value it had before
     * the edit — every control looked dead until the host round-trip landed, and
     * colours, which the host never confirms, looked dead permanently.
     */
    reconcile(s: Model): void {
        for (const [key, val] of this.pending) {
            if (String(readLocal(s, key)) === String(val)) this.pending.delete(key);
            else applyLocal(s, key, val);
        }
        this.settings = s;
    }

    update(s: Model, dark: boolean, forceHidden = false): void {
        this.reconcile(s);
        this.applyTheme(dark);
        this.bar.setVisible(s.toolbar.show.value && !forceHidden);
        this.bar.setCloseOnAway(s.toolbar.closeOnClickAway.value);
        this.pref = (s.toolbar.position.value.value as string) || "auto";
        if (this.pref !== "auto") this.bar.setCorner(this.pref);
    }

    /** Power BI high contrast wins over light/dark, so the gear matches the chart. */
    private applyTheme(dark: boolean): void {
        const palette = this.host.colorPalette;
        if (palette && palette.isHighContrast) {
            const v = (c?: { value?: string }): string | undefined => c && c.value;
            this.bar.setHighContrast(true, {
                foreground: v(palette.foreground),
                background: v(palette.background),
                foregroundSelected: v(palette.foregroundSelected),
                hyperlink: v(palette.hyperlink),
            });
        } else {
            this.bar.setHighContrast(false);
            this.bar.setTheme(dark);
        }
    }

    /**
     * Reset every visual property to its declared default. Power BI owns the
     * persisted formatting, so both routes are used: `removeObject` (honoured by
     * the Service) and an explicit merge of the defaults (Desktop silently ignores
     * removeObject — proven in the heatmap's 2026-07-15 UAT). Where both land the
     * net state is identical.
     */
    private reset(): void {
        if (!this.settings) return;
        const removeObject = (this.settings.cards as { name: string }[]).map((c) => ({
            objectName: c.name, selector: null, properties: {},
        }));
        this.host.persistProperties({ removeObject } as unknown as powerbi.VisualObjectInstancesToPersist);

        const defaults = new VisualFormattingSettingsModel();
        const merge: Array<{ objectName: string; selector: null; properties: Record<string, powerbi.DataViewPropertyValue> }> = [];
        type Slice = { name: string; value: unknown; items?: unknown[] };
        for (const card of defaults.cards as Array<{ name: string; slices?: Slice[] }>) {
            const properties: Record<string, powerbi.DataViewPropertyValue> = {};
            for (const slice of card.slices ?? []) {
                const v = persistValue(slice);
                if (v !== undefined) properties[slice.name] = v;
            }
            if (Object.keys(properties).length) merge.push({ objectName: card.name, selector: null, properties });
        }
        this.host.persistProperties({ merge } as unknown as powerbi.VisualObjectInstancesToPersist);

        // Optimistic local revert so the canvas changes now, not after the round-trip.
        const liveCards = this.settings.cards as Array<{ slices?: Array<{ value: unknown; name: string }> }>;
        const defCards = defaults.cards as Array<{ slices?: Array<{ value: unknown; name: string }> }>;
        liveCards.forEach((card, ci) => {
            const defSlices = defCards[ci]?.slices ?? [];
            (card.slices ?? []).forEach((slice, si) => {
                const d = defSlices[si];
                if (d && d.name === slice.name) slice.value = clone(d.value);
            });
        });
        this.pending.clear();
        this.onReset?.();
        this.onChange?.();
    }

    /** Called by the visual after layout when position = Auto. No-op otherwise. */
    setCorner(corner: string): void {
        if (this.pref === "auto") this.bar.setCorner(corner);
    }

    /** Dismiss the bar — used when a press lands on the chart (see visual.ts). */
    forceClose(): void { this.bar.forceClose(); }

    /** Harness helper — open the bar, and optionally a sub-group. */
    forceOpen(active?: string): void { this.bar.forceOpen(active); }

    /** True while the gear is open — the hover card stays down while it is. */
    isOpen(): boolean { return this.bar.isOpen(); }
}
