"use strict";

/**
 * Photo handling, constrained by Microsoft certification.
 *
 * Certified visuals may not make network calls of any kind, so a photo can only
 * ever be an inline base64 data URI that arrived with the data. A remote URL is
 * dropped rather than requested — silently, because a broken avatar is a far
 * better outcome than a visual that fails certification.
 *
 * Accepts: data:image/{png|jpeg|jpg|gif|webp|svg+xml};base64,<payload>
 * Rejects: everything else, including `javascript:`, `data:text/html`, remote
 * http(s) URLs, and any data URI that is not an allow-listed image type.
 */

const DATA_URI = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/i;

/**
 * Power BI caps a text value at 32,766 characters and cuts anything longer off
 * without saying so (zentrix-org-chart#11, OC-QA-32). A cut PNG still passes the
 * pattern above and the browser paints the part it can decode — a grey
 * half-image. A value that long is treated as truncated and rejected, so the card
 * shows its fallback instead. A genuine photo has to fit under the cap anyway.
 */
export const POWER_BI_TEXT_CAP = 32_766;

/** Returns a safe data URI, or null when the value cannot be trusted. */
export function safeImageDataUri(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    if (s.length === 0 || s.length >= POWER_BI_TEXT_CAP) return null;
    // Reject anything with whitespace or control characters inside the payload.
    if (/\s/.test(s)) return null;
    return DATA_URI.test(s) ? s : null;
}
