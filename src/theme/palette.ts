"use strict";

/**
 * Host-aware colour resolution: report theme + high contrast.
 *
 * Two Power BI platform behaviours meet here, and both are documented:
 *
 * 1. REPORT THEME — `colorPalette.getColor(key).value` returns a colour from the
 *    report's active theme, keyed by a stable string. Using it means a Zentrix
 *    org chart adopts the customer's corporate theme instead of fighting it. The
 *    Zentrix token palette remains the fallback when no host is present.
 *
 * 2. HIGH CONTRAST — when `colorPalette.isHighContrast` is true a visual may use
 *    ONLY four roles: foreground, background, foregroundSelected and hyperlink.
 *    Microsoft's own rules, followed here:
 *      • every data point uses the same colour (foreground)
 *      • thick shapes are outlines: >= 2px stroke, background fill
 *      • categories are distinguished by DASH / SHAPE, never colour
 *      • non-highlighted elements drop to 40% opacity
 *      • selected/active elements use foreground-selected
 *
 * Source: learn.microsoft.com/power-bi/developer/visuals/high-contrast-support
 *
 * This module takes a minimal structural view of the host palette so the whole
 * thing is unit-testable without a Power BI host.
 */

import { Surface, resolveSurface, groupColor as brandGroupColor, accentStrong } from "./zentrixTokens";

/** The subset of ISandboxExtendedColorPalette we actually consume. */
export interface HostColorPaletteLike {
    isHighContrast?: boolean;
    foreground?: { value: string };
    background?: { value: string };
    foregroundSelected?: { value: string };
    hyperlink?: { value: string };
    getColor?: (key: string) => { value: string };
}

/** Opacity for elements outside the current selection/highlight. */
export const DIM_OPACITY_NORMAL = 0.35;
/** Microsoft's documented high-contrast value. */
export const DIM_OPACITY_HIGH_CONTRAST = 0.4;

/** Card outline width. High contrast requires at least 2px. */
export const STROKE_NORMAL = 1;
export const STROKE_HIGH_CONTRAST = 2;

/**
 * Dash patterns used INSTEAD of colour to separate groups in high contrast.
 * Index 0 is solid so the commonest group stays cleanest.
 */
export const HC_DASHES = ["", "6 3", "2 3", "10 3 2 3", "1 3", "8 3 1 3", "4 2", "12 4"];

export interface ResolvedPalette {
    highContrast: boolean;
    surface: Surface;
    /** Card outline width in px. */
    strokeWidth: number;
    /** Opacity for un-selected / un-highlighted cards. */
    dimOpacity: number;
    /** Accent colour for a group index. */
    groupColor(index: number, key?: string): string;
    /** Dash array for a group index — empty string outside high contrast. */
    groupDash(index: number): string;
    /** Colour for the current selection. */
    selectedColor: string;
    /** Fill for a card. In high contrast this is always the background role. */
    cardFill: string;
}

export interface PaletteOptions {
    /** When true, group colours come from the report theme via getColor. */
    useReportTheme: boolean;
    /** Single-colour mode fallback / user-chosen accent. */
    accent?: string;
    /** Rendered dark? Power BI hands visuals light chrome unless HC is on. */
    dark?: boolean;
}

/**
 * Build the palette for this render.
 *
 * @param host the host's colorPalette, or undefined outside Power BI.
 */
export function resolvePalette(
    host: HostColorPaletteLike | undefined,
    opts: PaletteOptions,
): ResolvedPalette {
    const hc = !!(host && host.isHighContrast);
    const surface = resolveSurface(!!opts.dark, hc, hc ? {
        foreground: host?.foreground?.value,
        background: host?.background?.value,
        foregroundSelected: host?.foregroundSelected?.value,
        hyperlink: host?.hyperlink?.value,
    } : undefined);

    const accent = opts.accent || accentStrong;
    const themed = (key: string): string | null => {
        if (!opts.useReportTheme || !host || typeof host.getColor !== "function") return null;
        try {
            const c = host.getColor(key);
            return c && typeof c.value === "string" && c.value.length > 0 ? c.value : null;
        } catch {
            return null;   // a host that throws must never break the render
        }
    };

    return {
        highContrast: hc,
        surface,
        strokeWidth: hc ? STROKE_HIGH_CONTRAST : STROKE_NORMAL,
        dimOpacity: hc ? DIM_OPACITY_HIGH_CONTRAST : DIM_OPACITY_NORMAL,
        selectedColor: hc ? (surface.selected || surface.fg) : accent,
        // High contrast: outlined shapes are filled with the BACKGROUND role.
        cardFill: hc ? surface.bg : surface.cardFill,
        groupColor(index: number, key?: string): string {
            // Rule: in high contrast every data point is the foreground colour.
            if (hc) return surface.fg;
            const t = key !== undefined ? themed(key) : null;
            return t || brandGroupColor(index);
        },
        groupDash(index: number): string {
            if (!hc) return "";
            if (!isFinite(index) || index < 0) return HC_DASHES[0];
            return HC_DASHES[index % HC_DASHES.length];
        },
    };
}

/* ───────────────────────── readable ink ───────────────────────── */

function rgbOf(hex: string): [number, number, number] | null {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hexOf(rgb: [number, number, number]): string {
    return "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function luminance(rgb: [number, number, number]): number {
    const c = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** WCAG contrast ratio between two hex colours; 1 when either is unreadable. */
export function contrastRatio(a: string, b: string): number {
    const x = rgbOf(a), y = rgbOf(b);
    if (!x || !y) return 1;
    const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
    return (hi + 0.05) / (lo + 0.05);
}

/** `fg` laid over `bg` at `alpha` — what a tinted pill actually shows. */
export function composite(fg: string, bg: string, alpha: number): string {
    const f = rgbOf(fg), b = rgbOf(bg);
    if (!f || !b) return bg;
    return hexOf([0, 1, 2].map((i) => f[i] * alpha + b[i] * (1 - alpha)) as [number, number, number]);
}

/**
 * The group colour, darkened (or lightened on a dark background) just far enough
 * to read as TEXT on `bg` — WCAG AA, 4.5:1.
 *
 * Group colours come from the report theme, and Power BI's own defaults include
 * oranges and yellows that sit near 3:1 on white. As a bar or an outline that is
 * fine; as the number inside a measure badge it failed AA. The hue is kept, so the
 * badge still reads as belonging to its group.
 */
export function readableInk(color: string, bg: string, min = 4.5): string {
    const c = rgbOf(color), b = rgbOf(bg);
    if (!c || !b) return color;
    if (contrastRatio(color, bg) >= min) return color;
    const toward: [number, number, number] = luminance(b) > 0.4 ? [0, 0, 0] : [255, 255, 255];
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
        const next = hexOf([0, 1, 2].map((i) => c[i] * (1 - t) + toward[i] * t) as [number, number, number]);
        if (contrastRatio(next, bg) >= min) return next;
    }
    return hexOf(toward);
}
