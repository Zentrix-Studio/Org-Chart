"use strict";

/**
 * Zentrix Design System — token snapshot for the Org Chart pbiviz build.
 *
 * THIS FILE IS A HAND-MAINTAINED SNAPSHOT of the canonical tokens at
 * `@zentrix/packages/tokens/src/` — the SAME approach the Calendar Heatmap and
 * Network Graph use. pbiviz's webpack compiles an isolated sandbox and cannot
 * resolve the pnpm workspace symlink to `@zentrix/tokens` at bundle time, so the
 * visual imports these static values instead of the package directly. Keep them
 * in sync when canonical changes; never invent values here.
 *
 * Sourced from `@zentrix/packages/tokens/src/`:
 *   palettes.ts   — accent family + the 8-color categorical series
 *   themes.ts     — dark/light surface + text scales
 *   typography.ts — sans font stack
 */

/** Brand accent — canonical `palettes.aurora.accent` (#7C5CFF violet). */
export const accent = "#7C5CFF";
/** Accent strong — canonical `accentStrong` (#6344E0), for emphasized chrome. */
export const accentStrong = "#6344E0";
/** CVD-safe good/bad (Okabe–Ito), shared across the family. */
export const posSafe = "#0072B2";
export const negSafe = "#E69F00";

/** UI font stack — canonical `typography.fontFamily.sans` (sandbox-safe fallback). */
export const fontFamily = "'Inter', system-ui, -apple-system, sans-serif";

/**
 * Categorical palette for the Group role — the canonical 8-color series from
 * `palettes.ts` (accent-led, colour-blind-considerate ordering).
 */
export const categoryPalette = [
    "#7C5CFF", "#00C2A8", "#FF8A5C", "#4DA3FF",
    "#F2C94C", "#E25C9E", "#56C271", "#B59CFF",
];

export interface Surface {
    /** Canvas background. */
    bg: string;
    /** Primary text. */
    fg: string;
    /** Muted text (the card's title line). */
    muted: string;
    /** Card fill when no Group is bound. */
    cardFill: string;
    /** Card border. */
    cardStroke: string;
    /** Connector stroke. */
    connector: string;
    /** Emphasis colour for the current selection. Optional: falls back to `fg`.
     *  In high contrast this is the host's `foregroundSelected` role. */
    selected?: string;
}

// Dark theme — canonical themes.dark (base surface + text scale).
const DARK: Surface = {
    bg: "#0A0A0F",          // surface.base
    fg: "#F4F4F6",          // text.primary
    muted: "#A6A6B5",       // text.secondary
    cardFill: "#15161E",    // surface.raised
    cardStroke: "#2A2A38",  // border.subtle
    connector: "#70707F",   // text.tertiary
};

// Light theme — canonical themes.light.
const LIGHT: Surface = {
    bg: "#FFFFFF",          // surface.card
    fg: "#15161E",          // text.primary
    muted: "#54566B",       // text.secondary
    cardFill: "#FFFFFF",    // surface.card
    cardStroke: "#E4E4EC",  // border.subtle
    connector: "#C9C9D4",   // border.strong
};

// High contrast — LAST-RESORT fallback only. Power BI ships several HC themes
// (black-on-white "Desert" and "White", yellow-on-black "Night sky", …), so a
// hard-coded black/white pair is wrong for most of them. The real colours come
// from `host.colorPalette` and are threaded in via `hcSurface` below; these
// values only apply when the host hands us no roles at all.
const HIGH_CONTRAST: Surface = {
    bg: "#000000",
    fg: "#FFFFFF",
    muted: "#FFFFFF",
    cardFill: "#000000",
    cardStroke: "#FFFFFF",
    connector: "#FFFFFF",
    selected: "#FFFFFF",
};

/**
 * The high-contrast roles Power BI exposes on `host.colorPalette` when
 * `isHighContrast` is true. Only these four colours may be used in HC — no brand
 * hex, no categorical palette (see the Power BI HC guidance). Group encoding
 * therefore falls back to the accent bar's dash pattern and the card outline.
 */
export interface HCRoles {
    foreground?: string;
    background?: string;
    foregroundSelected?: string;
    hyperlink?: string;
}

/** Build the surface palette from the host's actual high-contrast roles. */
export function hcSurface(roles?: HCRoles): Surface {
    const fg = roles?.foreground || HIGH_CONTRAST.fg;
    const bg = roles?.background || HIGH_CONTRAST.bg;
    return {
        bg,
        fg,
        muted: fg,        // no dimmed text in HC — everything is full-contrast
        cardFill: bg,
        cardStroke: fg,
        connector: fg,
        selected: roles?.foregroundSelected || roles?.hyperlink || fg,
    };
}

/** Resolve the surface palette for the current theme. In high contrast the
 *  host's own roles win over any built-in value. */
export function resolveSurface(dark: boolean, highContrast: boolean, hcRoles?: HCRoles): Surface {
    if (highContrast) return hcSurface(hcRoles);
    return dark ? DARK : LIGHT;
}

/** Stable colour for a group index — wraps the 8-colour categorical series. */
export function groupColor(index: number): string {
    if (!isFinite(index) || index < 0) return accentStrong;
    return categoryPalette[index % categoryPalette.length];
}
