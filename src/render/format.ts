"use strict";

import { valueFormatter } from "powerbi-visuals-utils-formattingutils";

/**
 * The bound measures' Power BI format strings (OC-049) — currency, percentage, fixed
 * places — honoured wherever the Measure (or a Tooltips-well measure) is printed: the
 * card badge, the hover card and native tooltip, branch totals, the Table, the Insight
 * view. Family origin HM-V2-31 (Calendar Heatmap), ported via Sankey Pro SP-123: the
 * field's format string through Microsoft's `valueFormatter`, with the report's locale
 * for grouping and separators. Without a usable format every helper returns `null` and
 * the caller keeps its pre-OC-049 path byte-for-byte, so a report authored before this
 * change reads exactly as it did. PURE: no DOM, no host.
 */

let numberLocale = "en-US";

/** The report's locale (`host.locale`); anything Intl rejects falls back to en-US.
 *  Set first thing in `update()`, before the model is built. */
export function setFormatLocale(locale: string | undefined): void {
    let next = "en-US";
    try { if (locale) { new Intl.NumberFormat(locale); next = locale; } } catch { next = "en-US"; }
    if (next !== numberLocale) { numberLocale = next; formatters.clear(); }
}

/** The locale in force (tests). */
export function formatLocale(): string { return numberLocale; }

/** A format string Power BI actually means: trimmed, and not the "General" placeholder. */
export function usableFormat(format: string | null | undefined): string | null {
    const f = (format ?? "").trim();
    return f && !/^(general|g)$/i.test(f) ? f : null;
}

/**
 * Cap a format's OPTIONAL decimals ("#") so digits before + after the point stay within
 * 15 — all a double holds. Power BI's "Auto" currency format carries 15 optional places,
 * which printed 456.7 as "$456.69999999999999" (heatmap / Pie PDS-QA-51).
 */
export function capOptionalDecimals(format: string, value: number): string {
    const abs = Math.abs(value);
    const intDigits = abs >= 1 ? Math.floor(Math.log10(abs)) + 1 : 0;
    const max = Math.max(0, 15 - intDigits);
    return format.replace(/\.(0*)(#+)/g, (whole, zeros: string, hashes: string) => {
        if (zeros.length + hashes.length <= max) return whole;
        const keep = Math.max(0, max - zeros.length);
        return keep || zeros.length ? `.${zeros}${"#".repeat(keep)}` : "";
    });
}

/*
 * One formatter per (locale, format, scale, precision). Constructing one costs far more
 * than using one, and the badge text is built once per ROW — the same reason
 * `formatMeasure` caches its Intl.NumberFormat (1180.2.4 profiling, 2026-09-28).
 */
const formatters = new Map<string, { format(v: unknown): string }>();
function formatterFor(format: string, scale: number, precision: number | undefined, locale: string): { format(v: unknown): string } | null {
    const k = `${locale}|${format}|${scale}|${precision ?? ""}`;
    let f = formatters.get(k);
    if (!f) {
        try {
            f = valueFormatter.create({ format, value: scale, precision, cultureSelector: locale });
        } catch {
            return null;
        }
        if (formatters.size > 200) formatters.clear();
        formatters.set(k, f);
    }
    return f;
}

/**
 * Format a value through its field's format string — or `null` when no usable format
 * applies, so the caller keeps its own plain path. `scale` is the display-unit divisor
 * (1 = none); `precision` overrides the format's own decimals (undefined = the
 * author's decimals win, as set on the field in Power BI).
 */
export function formatWithFieldFormat(value: number, format: string | null | undefined, scale = 1, precision?: number, locale?: string): string | null {
    const fmt = usableFormat(format);
    if (!fmt || value == null || !isFinite(value)) return null;
    const f = formatterFor(scale > 1 ? fmt : capOptionalDecimals(fmt, value), scale > 1 ? scale : 0, precision, locale || numberLocale);
    return f ? f.format(value) : null;
}

/**
 * A bound cell as display text: a numeric cell whose field carries a format string
 * prints through that format; everything else is the raw `String(v)` it always was.
 */
export function formatCell(v: unknown, format: string | null | undefined, locale?: string): string {
    if (v == null) return "";
    if (usableFormat(format)) {
        const n = typeof v === "number" ? v : Number(v);
        if (typeof v !== "boolean" && String(v).trim() !== "" && isFinite(n)) {
            const text = formatWithFieldFormat(n, format, 1, undefined, locale);
            if (text != null) return text;
        }
    }
    return String(v);
}
