"use strict";

/**
 * Export — PAID (`export`), and the strongest paid lever this visual has.
 *
 * Certification forbids network calls, so everything happens in-sandbox:
 * the live SVG is serialized to a string, and for raster output that string is
 * drawn onto a <canvas> through a `data:` URL. No fetch, no remote fonts, no
 * external rasterizer.
 *
 * Hand-off is via the host's download service, which requires the
 * `ExportContent` privilege in capabilities.json.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export interface ExportSize { width: number; height: number; }

/**
 * Serialize a live SVG element to a standalone document string.
 *
 * The node is cloned so the on-screen chart is never mutated, the namespace and
 * an explicit background are added (exported images must not be transparent),
 * and the viewBox is set so the output is not clipped.
 */
export function serializeSvg(svg: SVGSVGElement, size: ExportSize, background: string): string {
    const clone = svg.cloneNode(true) as SVGSVGElement;
    // Interactive chrome is part of the app, not of the picture: an exported
    // PNG with zoom buttons stamped into the corner is a defect, not a feature.
    // The minimap and the lens joined the list in OC-034 — a loupe frozen into a
    // PNG is the same defect, and the lens `<use>` would not resolve anyway once
    // the chart group it re-uses is serialized out of its document.
    const chrome = clone.querySelectorAll(
        ".zoom-controls, .zx-minimap-layer, .zx-lens-layer");
    for (let i = 0; i < chrome.length; i++) {
        const el = chrome[i];
        if (el.parentNode) el.parentNode.removeChild(el);
    }
    clone.setAttribute("xmlns", SVG_NS);
    // No xlink namespace: the renderer uses the modern `href` attribute on
    // <image>, so the legacy xlink declaration would be dead weight — and the
    // certification linter rightly objects to an http: literal in shipped source.
    clone.setAttribute("width", String(size.width));
    clone.setAttribute("height", String(size.height));
    if (!clone.getAttribute("viewBox")) {
        clone.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
    }
    // An explicit backdrop, inserted first so it paints behind everything.
    const bg = clone.ownerDocument.createElementNS(SVG_NS, "rect");
    bg.setAttribute("x", "0");
    bg.setAttribute("y", "0");
    bg.setAttribute("width", String(size.width));
    bg.setAttribute("height", String(size.height));
    bg.setAttribute("fill", background);
    clone.insertBefore(bg, clone.firstChild);

    const xml = new XMLSerializer().serializeToString(clone);
    return `<?xml version="1.0" standalone="no"?>\n${xml}`;
}

/** UTF-8 safe base64 — btoa alone throws on non-Latin1 names. */
export function toBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

/** An SVG string as a `data:` URL — the only image source we ever load. */
export function svgDataUrl(svgText: string): string {
    return `data:image/svg+xml;base64,${toBase64(svgText)}`;
}

/**
 * Rasterize an SVG string to a PNG data URL.
 *
 * `scale` oversamples for print — 2 gives a crisp result in a slide deck.
 * Rejects rather than hanging if the image cannot be decoded.
 */
export function rasterizeToPng(
    svgText: string,
    size: ExportSize,
    scale = 2,
    background = "#FFFFFF",
): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(size.width * scale));
                canvas.height = Math.max(1, Math.round(size.height * scale));
                const ctx = canvas.getContext("2d");
                if (!ctx) { reject(new Error("no 2d context")); return; }
                ctx.fillStyle = background;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/png"));
            } catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        };
        img.onerror = () => reject(new Error("svg rasterization failed"));
        img.src = svgDataUrl(svgText);
    });
}

/**
 * Split a wide chart into page-sized tiles for the print layout.
 *
 * Returns the tile rectangles in reading order (left to right, top to bottom),
 * which is what a paginated PDF needs. A chart that already fits returns one tile.
 */
export function paginate(content: ExportSize, page: ExportSize): Array<{ x: number; y: number; width: number; height: number }> {
    const pw = Math.max(1, page.width);
    const ph = Math.max(1, page.height);
    const cols = Math.max(1, Math.ceil(content.width / pw));
    const rows = Math.max(1, Math.ceil(content.height / ph));
    const tiles: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            tiles.push({
                x: c * pw,
                y: r * ph,
                width: Math.min(pw, content.width - c * pw),
                height: Math.min(ph, content.height - r * ph),
            });
        }
    }
    return tiles;
}

/** File name safe across Windows and macOS. */
export function safeFileName(base: string, ext: string): string {
    const cleaned = (base || "org-chart")
        .replace(/[\\/:*?"<>|]/g, "-")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80);
    return `${cleaned || "org-chart"}.${ext}`;
}
