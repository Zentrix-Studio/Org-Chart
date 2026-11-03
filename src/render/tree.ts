"use strict";

/**
 * SVG render layer. Draws connectors beneath cards, then one <g.card> per
 * visible node, styled from the Zentrix token snapshot.
 *
 * Card anatomy (matches the product-definition mockup):
 *   accent bar | avatar | name / title | measure badge | collapse toggle
 */

import { Selection } from "d3";
import { Hierarchy, directReports, totalDescendants } from "../model/hierarchy";
import { LayoutResult } from "../model/treeLayout";
import { OrgNode, ConnectorStyle, Orientation } from "../types";
import { CardBox, connectorPath, dottedPath, stackedPath } from "./connectors";
import { Surface, fontFamily, posSafe, negSafe } from "../theme/zentrixTokens";
import { composite, contrastRatio, readableInk } from "../theme/palette";

export type PhotoShape = "circle" | "rounded" | "square";
export type PhotoFallback = "initials" | "icon" | "blank" | "none";

/**
 * Clip-path ids have to be unique across the DOCUMENT, not the visual: two Org
 * Charts on one report page share a document, and a duplicated id makes the
 * second visual clip to the first one's geometry. A counter (not a random
 * value) keeps the markup deterministic, which the export and the jsdom sweeps
 * both rely on.
 */
let UID = 0;
type RootNode = SVGGElement & { __zxAvatarUid?: string };

/** Up to two initials for the no-photo fallback. Falls back to the key's first
 *  character, so a row with a blank Name still gets something rather than a hole. */
export function initialsOf(name: string): string {
    const words = String(name || "").trim().split(/[\s,]+/).filter((w) => w.length > 0);
    if (words.length === 0) return "";
    const first = words[0][0] || "";
    const last = words.length > 1 ? (words[words.length - 1][0] || "") : "";
    return (first + last).toUpperCase();
}

/** Corner radius that turns one rounded rect into all three avatar shapes. */
export function avatarRx(shape: PhotoShape, r: number): number {
    if (shape === "square") return 0;
    if (shape === "rounded") return r * 0.32;
    return r;
}

export interface RenderOptions {
    orientation: Orientation;
    connectorStyle: ConnectorStyle;
    connectorWidth: number;
    connectorColor: string;
    cardWidth: number;
    cardHeight: number;
    cornerRadius: number;
    showPhoto: boolean;
    /** Avatar shape. The image is CLIPPED to it — see `avatarRx`. */
    photoShape: PhotoShape;
    /** Avatar diameter as a percentage of card height. */
    photoSize: number;
    photoRing: boolean;
    /** Blank follows the card's own accent. */
    photoRingColor: string;
    photoRingWidth: number;
    /** What a row with no photo gets. `none` reserves no space at all. */
    photoFallback: PhotoFallback;
    /**
     * Whether a photo actually decodes (zentrix-org-chart#10). A value can pass
     * `imageSafety` and still not be an image — PH30 is valid base64 of the text
     * "notanimage" — and the browser then draws its broken-image glyph. Unknown or
     * bad photos get the fallback. Omitted: every safe photo is drawn (tests).
     */
    photoOk?: (uri: string) => boolean;
    showMeasure: boolean;
    showTitle: boolean;
    nameSize: number;
    titleSize: number;
    accentBar: boolean;
    surface: Surface;
    /** Accent colour per node index (group / level / single already resolved). */
    colorOf: (i: number) => string;
    /** Card outline width. High contrast requires >= 2px. */
    strokeWidth: number;
    /** Dash array encoding the group in high contrast; "" otherwise. */
    dashOf: (i: number) => string;
    /** True in high contrast: cards become outlines on the background colour. */
    highContrast: boolean;
    /** Collapsed node indices — drives the toggle glyph and the +N badge. */
    collapsed: ReadonlySet<number>;
    /**
     * PAID (`orgAnalytics`) — span of control per node, or null when the
     * analytics layer is off. The control is called "Show span metrics" and its
     * help text promises numbers ON THE CARD, so this is where they go; before
     * OC-015 they only ever reached the tooltip (OC-QA-16).
     */
    metricOf?: ((i: number) => { direct: number; span: string } | null) | null;
    /**
     * "Flag vacancies" — true for an open role. The control promises the CARD is
     * marked; before OC-028 only the tooltip and the summary count changed. Marked
     * as the org-chart convention for an unfilled seat: a dashed outline in the
     * card's colour and the name in muted italics. In high contrast the dash
     * already encodes the group, so the outline doubles in width instead.
     */
    vacantOf?: ((i: number) => boolean) | null;
}

type SvgG = Selection<SVGGElement, unknown, null, undefined>;
/** A card selection: one <g> per node index. */
type CardSel = Selection<SVGGElement, number, SVGGElement, unknown>;
type LinkDatum = { p: number; c: number };
type LinkSel = Selection<SVGPathElement, LinkDatum, SVGGElement, unknown>;

const ACCENT_BAR_W = 4;
const AVATAR_PAD = 9;
/** Type stack: em box per line, lead between lines, vertical padding. See `typeScale`. */
const LINE = 1.25;
const LEAD = 2;
const VPAD = 2;

/**
 * The name size a scale-1 card draws, with its title line shown — the smallest
 * a name is ever drawn at by default. The legibility floor (OC-030) is set
 * against this, so it holds whether the title is on or off: with the title off a
 * name may grow into the freed line, but never shrinks below this (OC-QA-24).
 */
export function baseNameSize(cardHeight: number, nameSize: number, titleSize: number): number {
    const room = cardHeight - 2 * VPAD - LEAD;
    const want = LINE * nameSize + LINE * titleSize;
    return want <= 0 || want <= room ? nameSize : nameSize * Math.max(0.25, room / want);
}

/** Labels → Name size default. A larger name may shrink to fit its card down to this. */
export const NAME_SIZE_DEFAULT = 12.5;

/**
 * The smallest a name is ever drawn at on a scale-1 card: its title-on size, or
 * the default size if the author set a larger one (a large name gives way to the
 * card's width down to the default). The legibility floor is set against this.
 */
export function smallestNameSize(cardHeight: number, nameSize: number, titleSize: number): number {
    return Math.min(baseNameSize(cardHeight, nameSize, titleSize), Math.max(nameSize > NAME_SIZE_DEFAULT ? NAME_SIZE_DEFAULT : nameSize, 0));
}

/**
 * A collapsed branch's count, short enough for its pill (OC-QA-33, #6): exact
 * below 10,000, then 13.7K / 137K / 1.4M. A 36,000-person org read "3689" for
 * 13,689 because a fifth digit did not fit the disc.
 */
export function compactCount(n: number): string {
    if (!isFinite(n) || n < 10000) return String(Math.max(0, Math.round(n)));
    const unit = (v: number, suffix: string): string => {
        const s = v < 100 ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, "") : String(Math.round(v));
        return s + suffix;
    };
    if (n < 999500) return unit(n / 1000, "K");
    return unit(n / 1e6, "M");
}

/**
 * Truncate to fit an approximate pixel width.
 *
 * This is a FIRST GUESS only. The 0.56em advance is right for lowercase Inter and
 * badly wrong for anything else: measured in a browser, "Senior Analyst" at
 * 10.5px came out at 0.80em per character, so the guess let a title run 28px past
 * where it was allowed to stop (OC-QA-05). `trimToWidth` below corrects it
 * against the real rendered width wherever the host can measure text; the guess
 * stands alone only in jsdom, which measures nothing.
 */
export function fitText(text: string, maxPx: number, fontPx: number): string {
    if (!text) return "";
    const perChar = fontPx * 0.56;                 // Inter/Segoe average advance
    const maxChars = Math.max(1, Math.floor(maxPx / perChar));
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(1, maxChars - 1)) + "…";
}

/**
 * Shrink a rendered line until it really fits `room`, measuring as we go.
 *
 * `getComputedTextLength` is the only honest answer — it accounts for the font
 * the host actually resolved, which is not necessarily the one we asked for. It
 * costs a layout, so it runs only on lines the guess got wrong.
 *
 * A binary search over the character count, so it ALWAYS converges: ~8
 * measurements for a 200-character name. The earlier proportional cut scaled the
 * FULL string by a width measured on the already-truncated guess — for a long name
 * that asked for more characters, not fewer — and its six fixed steps then ran out
 * with the line still spilling past the card (54px on a default card). Characters
 * are counted by code point, so an emoji or a CJK supplementary character is never
 * split in half.
 */
export function trimToWidth(el: SVGTextElement, full: string, room: number): void {
    if (typeof el.getComputedTextLength !== "function") return;   // jsdom
    let width: number;
    try { width = el.getComputedTextLength(); } catch { return; }
    if (!(width > room)) return;
    if (room <= 0) { el.textContent = ""; return; }

    const chars = Array.from(full || "");
    const fits = (n: number): boolean => {
        el.textContent = n >= chars.length ? full : (n > 0 ? chars.slice(0, n).join("") + "…" : "…");
        try { return el.getComputedTextLength() <= room; } catch { return true; }
    };
    let lo = 0, hi = chars.length - 1;       // the whole string is already known not to fit
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(mid)) lo = mid; else hi = mid - 1;
    }
    if (lo > 0 || fits(0)) { fits(lo); return; }
    el.textContent = "";                     // not even an ellipsis fits
}

export function renderTree(
    root: SvgG,
    nodes: OrgNode[],
    h: Hierarchy,
    layout: LayoutResult,
    opts: RenderOptions,
): void {
    // Connectors meet the card the LAYOUT reserved, so a level-sized parent and
    // its smaller children still join edge to edge.
    const boxOf = (i: number): CardBox => ({
        cx: layout.x[i], cy: layout.y[i],
        w: layout.w[i] || opts.cardWidth, h: layout.h[i] || opts.cardHeight,
    });

    // ---- connectors (drawn first so cards sit above them) --------------------
    const links: Array<{ p: number; c: number }> = [];
    for (let k = 0; k < layout.placed.length; k++) {
        const i = layout.placed[k];
        const p = h.parentIdx[i];
        if (p >= 0 && isFinite(layout.x[p])) links.push({ p, c: i });
    }

    let gLinks = root.select<SVGGElement>("g.connectors");
    if (gLinks.empty()) gLinks = root.append("g").attr("class", "connectors") as SvgG;

    const link: LinkSel = gLinks.selectAll<SVGPathElement, LinkDatum>("path.connector")
        .data(links, (d: LinkDatum) => `${d.p}>${d.c}`);
    link.exit().remove();
    link.enter().append("path").attr("class", "connector")
        .merge(link)
        // A stacked report hangs off its column's spine (OC-030); the elbow would
        // cut straight through the rows above it.
        .attr("d", (d) => (layout.spine && isFinite(layout.spine[d.c])
            ? stackedPath(boxOf(d.p), boxOf(d.c), opts.orientation, layout.spine[d.c], layout.bus[d.c])
            : connectorPath(boxOf(d.p), boxOf(d.c), opts.orientation, opts.connectorStyle)))
        .attr("fill", "none")
        .attr("stroke", opts.connectorColor)
        .attr("stroke-width", opts.connectorWidth)
        .attr("stroke-linejoin", "round");

    // ---- cards ---------------------------------------------------------------
    let gCards = root.select<SVGGElement>("g.cards");
    if (gCards.empty()) gCards = root.append("g").attr("class", "cards") as SvgG;

    // The key function runs over the EXISTING elements too, where the bound
    // datum is an index into the PREVIOUS render's node array. When the node set
    // shrinks — a slicer, a cross-filter, a drill-up, or the free-tier cap
    // landing after the licence resolves — that index is out of range, so the
    // lookup must not assume a node is there. A stale element gets a key that
    // cannot collide with a real one, which puts it in the exit selection where
    // it belongs.
    const cardKey = (d: number): string => (nodes[d] ? nodes[d].key : " stale:" + d);
    const card: CardSel = gCards.selectAll<SVGGElement, number>("g.card")
        .data(layout.placed, cardKey);
    card.exit().remove();
    const enter = card.enter().append("g").attr("class", "card");
    enter.append("rect").attr("class", "card-bg");
    enter.append("rect").attr("class", "card-accent");
    // Avatar, bottom to top: the clip, the image, the fallback mark, then the
    // outline LAST so it is never painted over. Before OC-025 the ring was
    // appended first and the unclipped square image covered it — which is why
    // photos rendered as squares with an invisible outline.
    enter.append("clipPath").attr("class", "avatar-clip").append("rect");
    enter.append("rect").attr("class", "avatar-fill");
    enter.append("image").attr("class", "avatar");
    enter.append("text").attr("class", "avatar-initials");
    enter.append("path").attr("class", "avatar-icon");
    enter.append("rect").attr("class", "avatar-ring");
    enter.append("text").attr("class", "card-name");
    enter.append("text").attr("class", "card-title");
    enter.append("g").attr("class", "card-badge");
    enter.append("g").attr("class", "card-metric");
    enter.append("g").attr("class", "card-toggle");

    const all: CardSel = enter.merge(card);
    // Card geometry comes from the LAYOUT, not from the settings: with level
    // sizing each card has its own size, and the space reserved for it is the
    // only size it may draw at. Everything inside — the accent bar, the avatar,
    // the type, the badge, the toggle — scales with its own card.
    const W = (i: number): number => layout.w[i] || opts.cardWidth;
    const H = (i: number): number => layout.h[i] || opts.cardHeight;
    const scale = (i: number): number => W(i) / Math.max(1, opts.cardWidth);
    // The radius grows with the card but never past half of it: beyond that SVG
    // clamps silently, which turned a short card into a pill while its larger
    // ancestor stayed a rounded rectangle (OC-QA-08).
    const R = (i: number): number => Math.min(
        opts.cornerRadius * Math.min(2, Math.max(1, scale(i))), W(i) / 2, H(i) / 2,
    );
    const bar = (i: number): number => ACCENT_BAR_W * Math.min(2, Math.max(1, scale(i)));
    /**
     * Vertical type fitting (OC-QA-14).
     *
     * The two text lines used to sit at fixed baselines, so raising Name size
     * past ~18 on a default card made the name descend into the title, and the
     * maxima pushed both lines out of the card entirely. Every one of those
     * values is inside its allowed range, so the settings were not at fault.
     *
     * The lines are now stacked from their real type sizes and centred, and when
     * the stack is taller than the card BOTH shrink together by one factor — the
     * vertical twin of what `textRoom`/`trimToWidth` do across the card's width.
     * `LINE` (em box) and `LEAD` come from measured `getBBox` extents: ascent is
     * ~0.97em and descent ~0.22em, so 1.25em holds one line with a hair to spare.
     */
    const hasTitleLine = (i: number): boolean => opts.showTitle && !!nodes[i].title;
    /** 1 when the type already fits; below 1 only when the card is too short. */
    const typeScale = (i: number): number => {
        const s = scale(i);
        const room = H(i) - 2 * VPAD * s - (hasTitleLine(i) ? LEAD * s : 0);
        const want = LINE * opts.nameSize * s
            + (hasTitleLine(i) ? LINE * opts.titleSize * s : 0);
        if (want <= 0 || want <= room) return 1;
        return Math.max(0.25, room / want);
    };
    const nameSize = (i: number): number => opts.nameSize * scale(i) * typeScale(i);
    /** The same, as if this card's title line were shown — the name's lower bound. */
    const typeScaleWithTitle = (i: number): number => {
        const s = scale(i);
        const room = H(i) - 2 * VPAD * s - LEAD * s;
        const want = LINE * opts.nameSize * s + LINE * opts.titleSize * s;
        if (want <= 0 || want <= room) return 1;
        return Math.max(0.25, room / want);
    };
    const titleSize = (i: number): number => opts.titleSize * scale(i) * typeScale(i);
    /** Top of the centred text block. */
    const blockTop = (i: number): number => {
        const blockH = LINE * nameSize(i)
            + (hasTitleLine(i) ? LEAD * scale(i) + LINE * titleSize(i) : 0);
        return (H(i) - blockH) / 2;
    };
    /**
     * Avatar radius from the author's percentage, clamped so it can never crowd
     * the card out: it must leave a little vertical breathing room and may not
     * take more than a third of the width, or a large percentage on a short wide
     * card would leave no room for a name.
     */
    const avatarR = (i: number): number => {
        const wanted = (H(i) * (opts.photoSize / 100)) / 2;
        return Math.max(0, Math.min(wanted, (H(i) - 4 * scale(i)) / 2, W(i) / 3));
    };
    /** A real picture is present and photos are on. */
    const hasImage = (i: number): boolean => opts.showPhoto && !!nodes[i].photo
        && (!opts.photoOk || opts.photoOk(nodes[i].photo as string));
    /**
     * Space is reserved for an avatar. With `none`, a row without a picture
     * reserves nothing and its text slides left — which is the behaviour that
     * made a part-filled dataset draw cards whose text started in two different
     * places, so it is no longer the default.
     */
    const hasAvatar = (i: number): boolean =>
        opts.showPhoto && (hasImage(i) || opts.photoFallback !== "none");
    const ringColor = (i: number): string =>
        opts.highContrast ? opts.surface.fg : (opts.photoRingColor || opts.colorOf(i));
    /**
     * The outline is stroked OUTSIDE the clipped image, not along its edge.
     *
     * An SVG stroke straddles its path — half in, half out — so an outline drawn
     * on the clip boundary paints over the photo it is outlining: 0.6px at the
     * default, 3px at the maximum width, which is ~15% of the radius and reads as
     * a ring sitting on top of the picture. Offsetting by half the stroke puts
     * the inner edge exactly on the photo's edge, so the photo is never covered.
     */
    const ringW = (i: number): number =>
        (opts.photoRing && opts.photoRingWidth > 0 && hasAvatar(i)) ? opts.photoRingWidth : 0;
    const avatarX = (i: number): number => bar(i) + pad(i) + ringW(i) / 2;
    const avatarY = (i: number): number => H(i) / 2 - avatarR(i);
    /** Width the avatar claims on the card, outline included, so text clears it. */
    const avatarSpan = (i: number): number => avatarR(i) * 2 + ringW(i);
    const pad = (i: number): number => AVATAR_PAD * Math.min(1.6, Math.max(1, scale(i)));
    const textLeft = (i: number): number =>
        (hasAvatar(i) ? bar(i) + pad(i) * 2 + avatarSpan(i) : bar(i) + pad(i));

    // The measure badge sits bottom-right. A text line that shares its vertical
    // band has to stop at its left edge, not at the card edge — budgeting against
    // the card width is what let a job title run under the badge on a third of
    // the cards at default settings (OC-QA-05, OC-QA-07).
    const pillWidth = (i: number, t: string): number =>
        Math.max(26 * scale(i), t.length * titleSize(i) * 0.62 + 12 * scale(i));
    /** Does a badge carrying `t` still leave the name its room? */
    const pillFits = (i: number, t: string): boolean =>
        W(i) - pillWidth(i, t) - 8 * scale(i) - textLeft(i) >= nameSize(i) * 2;
    /**
     * OC-051: the text the badge actually carries. The full formatted value when it fits;
     * otherwise the compact form ("$125K" — the field's own format under Auto display
     * units, OC-049); null only when even that cannot fit. Before this, a Currency-formatted
     * Measure ("$125,000.50" — always longer than the plain number) dropped the badge on
     * nearly every card, so setting a format made the numbers vanish from the chart.
     */
    const badgeText = (i: number): string | null => {
        const full = nodes[i].measureText;
        if (!opts.showMeasure || !full) return null;
        if (pillFits(i, full)) return full;
        const compact = nodes[i].measureCompact;
        return compact && compact !== full && pillFits(i, compact) ? compact : null;
    };
    const badgeWidth = (i: number): number => pillWidth(i, badgeText(i) ?? nodes[i].measureText ?? "");
    const badgeLeft = (i: number): number => W(i) - badgeWidth(i) - 8 * scale(i);
    /**
     * A long measure on a narrow card can want the whole card. Reserving that
     * space would leave no room for a name, and drawing it anyway put the badge
     * across both text lines. The name is what the card is for, so past this
     * point the badge is dropped instead — widen the card, or turn the badge off.
     */
    const badgeShown = (i: number): boolean => badgeText(i) !== null;

    // Span-of-control pill, top-right — the opposite corner from the measure
    // badge, so the two never compete for the same space.
    const metricFor = (i: number): { direct: number; span: string } | null =>
        (opts.metricOf ? opts.metricOf(i) : null);
    const metricText = (i: number): string => {
        const m = metricFor(i);
        return m ? String(m.direct) : "";
    };
    const metricWidth = (i: number): number =>
        Math.max(22 * scale(i), metricText(i).length * titleSize(i) * 0.62 + 10 * scale(i));
    const metricLeft = (i: number): number => W(i) - metricWidth(i) - 8 * scale(i);
    const metricTop = (i: number): number => 5 * scale(i);
    const metricBottom = (i: number): number => metricTop(i) + titleSize(i) + 6 * scale(i);
    /** A leaf has no span to report, and a pill that crowds the name is worse than none. */
    const metricShown = (i: number): boolean => {
        const m = metricFor(i);
        return !!m && m.direct > 0 && metricLeft(i) - textLeft(i) >= nameSize(i) * 2;
    };
    /** Wide and narrow spans are the point of the feature, so they read differently. */
    const metricColor = (i: number): string => {
        if (opts.highContrast) return opts.surface.fg;
        const m = metricFor(i);
        if (m && m.span === "wide") return negSafe;
        if (m && m.span === "narrow") return posSafe;
        return opts.surface.muted;
    };
    const badgeTop = (i: number): number => H(i) - titleSize(i) - 11 * scale(i);
    /** Baselines derived from the stack, so the lines can never run into each other. */
    const nameY = (i: number): number => blockTop(i) + nameSize(i);
    const titleY = (i: number): number => blockTop(i)
        + LINE * nameSize(i) + LEAD * scale(i) + titleSize(i);
    /** Horizontal room for a text line whose ink spans `top`..`bottom`. */
    const textRoom = (i: number, top: number, bottom: number): number => {
        let right = W(i) - 10 * scale(i);
        if (badgeShown(i) && bottom > badgeTop(i)) right = Math.min(right, badgeLeft(i) - 4 * scale(i));
        if (metricShown(i) && top < metricBottom(i)) right = Math.min(right, metricLeft(i) - 4 * scale(i));
        return right - textLeft(i);
    };

    all.attr("transform", (i) => `translate(${layout.x[i] - W(i) / 2},${layout.y[i] - H(i) / 2})`)
        .attr("tabindex", 0)
        .attr("role", "treeitem")
        .attr("aria-level", (i) => h.depth[i] + 1)
        .attr("aria-label", (i) => {
            const n = nodes[i];
            const reports = directReports(h, i);
            const vacant = opts.vacantOf && opts.vacantOf(i) ? ", vacant role" : "";
            return `${n.name}${n.title ? ", " + n.title : ""}${vacant}${reports ? `, ${reports} direct reports` : ""}`;
        });
    const vacant = (i: number): boolean => !!(opts.vacantOf && opts.vacantOf(i));
    /** Text drawn in the group colour sits on a 14% tint of it; darken until it reads. */
    const tintInk = (i: number, alpha = 0.14): string =>
        (opts.highContrast ? opts.colorOf(i) : readableInk(opts.colorOf(i), composite(opts.colorOf(i), opts.surface.cardFill, alpha)));

    // High contrast: a thick outline on the background fill, with the group
    // encoded as a dash pattern rather than a colour.
    all.select("rect.card-bg")
        .attr("width", (i) => W(i)).attr("height", (i) => H(i))
        .attr("rx", (i) => R(i)).attr("ry", (i) => R(i))
        .attr("fill", opts.surface.cardFill)
        .attr("stroke", (i) => (opts.highContrast || vacant(i) ? opts.colorOf(i) : opts.surface.cardStroke))
        .attr("stroke-width", (i) => (vacant(i) ? opts.strokeWidth * (opts.highContrast ? 2 : 1.5) : opts.strokeWidth))
        .attr("stroke-dasharray", (i) => opts.dashOf(i)
            || (vacant(i) && !opts.highContrast ? `${5 * Math.max(1, scale(i))} ${4 * Math.max(1, scale(i))}` : null));

    all.select("rect.card-accent")
        .attr("width", (i) => (opts.accentBar ? bar(i) : 0))
        .attr("height", (i) => H(i))
        .attr("rx", (i) => bar(i) / 2).attr("ry", (i) => bar(i) / 2)
        .attr("fill", (i) => opts.colorOf(i));

    // ---- avatar ---------------------------------------------------------------
    // One rounded rect drives all three shapes: rx = r is a circle, rx = 0 a
    // square. The same rect is the clip, the fallback fill and the outline, so
    // they can never disagree about where the avatar is.
    const rootEl = root.node() as RootNode;
    if (!rootEl.__zxAvatarUid) rootEl.__zxAvatarUid = "zxav" + (UID++);
    const uid = rootEl.__zxAvatarUid;
    const clipId = (i: number): string => `${uid}-${i}`;

    all.select("clipPath.avatar-clip").attr("id", (i) => clipId(i));
    all.select("clipPath.avatar-clip").select("rect")
        .attr("x", (i) => avatarX(i)).attr("y", (i) => avatarY(i))
        .attr("width", (i) => avatarR(i) * 2).attr("height", (i) => avatarR(i) * 2)
        .attr("rx", (i) => avatarRx(opts.photoShape, avatarR(i)))
        .attr("ry", (i) => avatarRx(opts.photoShape, avatarR(i)));

    // A tinted plate behind the initials / icon. It is also what "Empty circle"
    // draws, and it sits under a photo where it is simply never seen.
    const plateShown = (i: number): boolean =>
        hasAvatar(i) && !hasImage(i) && opts.photoFallback !== "none";
    all.select("rect.avatar-fill")
        .attr("x", (i) => avatarX(i)).attr("y", (i) => avatarY(i))
        .attr("width", (i) => avatarR(i) * 2).attr("height", (i) => avatarR(i) * 2)
        .attr("rx", (i) => avatarRx(opts.photoShape, avatarR(i)))
        .attr("ry", (i) => avatarRx(opts.photoShape, avatarR(i)))
        .attr("fill", (i) => (opts.highContrast ? opts.surface.bg : ringColor(i)))
        .attr("stroke", (i) => (opts.highContrast ? opts.surface.fg : "none"))
        .attr("stroke-width", opts.highContrast ? 1 : 0)
        .attr("opacity", (i) => (plateShown(i) ? (opts.highContrast ? 1 : 0.16) : 0));

    all.select("image.avatar")
        .attr("x", (i) => avatarX(i)).attr("y", (i) => avatarY(i))
        .attr("width", (i) => avatarR(i) * 2).attr("height", (i) => avatarR(i) * 2)
        .attr("preserveAspectRatio", "xMidYMid slice")
        // THE FIX: without this the image drew as a square over the outline.
        .attr("clip-path", (i) => `url(#${clipId(i)})`)
        // Never hand the browser a photo that has not decoded: that is where the
        // broken-image glyph came from.
        .attr("href", (i) => (hasImage(i) ? (nodes[i].photo as string) : ""))
        .attr("opacity", (i) => (hasImage(i) ? 1 : 0));

    const initialsShown = (i: number): boolean =>
        plateShown(i) && opts.photoFallback === "initials" && !!initialsOf(nodes[i].name);
    all.select("text.avatar-initials")
        .attr("x", (i) => avatarX(i) + avatarR(i))
        .attr("y", (i) => H(i) / 2 + avatarR(i) * 0.36)
        .attr("text-anchor", "middle")
        .attr("font-family", fontFamily)
        .attr("font-size", (i) => avatarR(i) * 0.92)
        .attr("font-weight", 700)
        .attr("fill", (i) => (opts.highContrast ? opts.surface.fg
            : readableInk(ringColor(i), composite(ringColor(i), opts.surface.cardFill, 0.16))))
        .attr("opacity", (i) => (initialsShown(i) ? 1 : 0))
        .text((i) => (initialsShown(i) ? initialsOf(nodes[i].name) : ""));

    // A head and shoulders, drawn from the avatar box so it scales with it.
    const iconShown = (i: number): boolean => plateShown(i) && opts.photoFallback === "icon";
    all.select("path.avatar-icon")
        .attr("d", (i) => {
            const r = avatarR(i);
            const cx = avatarX(i) + r;
            const cy = H(i) / 2;
            const head = r * 0.30;
            const hy = cy - r * 0.22;
            const bw = r * 0.60;
            const by = cy + r * 0.56;
            return `M${cx - head},${hy} a${head},${head} 0 1,1 ${head * 2},0 a${head},${head} 0 1,1 ${-head * 2},0 `
                + `M${cx - bw},${by} a${bw},${bw * 0.86} 0 0,1 ${bw * 2},0`;
        })
        .attr("fill", "none")
        .attr("stroke", (i) => (opts.highContrast ? opts.surface.fg : ringColor(i)))
        .attr("stroke-width", (i) => Math.max(1, avatarR(i) * 0.16))
        .attr("stroke-linecap", "round")
        .attr("opacity", (i) => (iconShown(i) ? 0.85 : 0));

    // Drawn LAST: the outline is never covered by what it outlines.
    const ringShown = (i: number): boolean =>
        hasAvatar(i) && opts.photoRing && opts.photoRingWidth > 0;
    all.select("rect.avatar-ring")
        .attr("x", (i) => avatarX(i) - ringW(i) / 2)
        .attr("y", (i) => avatarY(i) - ringW(i) / 2)
        .attr("width", (i) => avatarR(i) * 2 + ringW(i))
        .attr("height", (i) => avatarR(i) * 2 + ringW(i))
        .attr("rx", (i) => avatarRx(opts.photoShape, avatarR(i) + ringW(i) / 2))
        .attr("ry", (i) => avatarRx(opts.photoShape, avatarR(i) + ringW(i) / 2))
        .attr("fill", "none")
        .attr("stroke", (i) => ringColor(i))
        .attr("stroke-width", opts.photoRingWidth)
        .attr("opacity", (i) => (ringShown(i) ? 1 : 0));

    all.select("text.card-name")
        .attr("x", (i) => textLeft(i))
        .attr("y", (i) => nameY(i))
        .attr("font-family", fontFamily)
        .attr("font-size", (i) => nameSize(i))
        .attr("font-weight", 700)
        .attr("font-style", (i) => (vacant(i) ? "italic" : null))
        .attr("fill", (i) => (vacant(i) && !opts.highContrast ? opts.surface.muted : opts.surface.fg))
        .text((i) => fitText(nodes[i].name, textRoom(i, nameY(i) - nameSize(i), nameY(i) + nameSize(i) * 0.2), nameSize(i)))
        .each(function (i) {
            const el = this as SVGTextElement;
            const room = (size: number, y: number): number => textRoom(i, y - size, y + size * 0.2);
            /*
             * OC-QA-24 (#13): a 20px name on a 124px card truncated to "Far…",
             * and hiding the title made it worse by growing the name into the
             * freed height. A size is only worth having if the name fits across
             * the card at it, so a name that would be cut short gives way to the
             * card's WIDTH first — down to `floor` — and only then is ellipsized.
             */
            const grown = nameSize(i);
            // Never below the size the name draws at with its title shown, and a
            // name set LARGER than the default gives way to the card's width down
            // to the default, no further — the size the legibility floor is set
            // against (see `smallestNameSize`).
            const floor = Math.min(grown, opts.nameSize * scale(i) * typeScaleWithTitle(i),
                NAME_SIZE_DEFAULT * scale(i));
            if (floor < grown - 0.01) {
                const want = measureAt(el, nodes[i].name, grown);
                const avail = room(grown, nameY(i));
                if (want > avail && want > 0) {
                    const size = Math.max(floor, grown * (avail / want));
                    // Alone on the card, the smaller name re-centres. Above a
                    // title it keeps its baseline, so it can only move AWAY from
                    // the title line (OC-QA-14 must still hold).
                    const y = hasTitleLine(i) ? nameY(i) : (H(i) - LINE * size) / 2 + size;
                    el.setAttribute("font-size", String(size));
                    el.setAttribute("y", String(y));
                    el.textContent = fitText(nodes[i].name, room(size, y), size);
                    trimToWidth(el, nodes[i].name, room(size, y));
                    return;
                }
            }
            trimToWidth(el, nodes[i].name, room(grown, nameY(i)));
        });

    all.select("text.card-title")
        .attr("x", (i) => textLeft(i))
        .attr("y", (i) => titleY(i))
        .attr("font-family", fontFamily)
        .attr("font-size", (i) => titleSize(i))
        .attr("fill", opts.surface.muted)
        .attr("opacity", opts.showTitle ? 1 : 0)
        .text((i) => (opts.showTitle
            ? fitText(nodes[i].title, textRoom(i, titleY(i) - titleSize(i), titleY(i) + titleSize(i) * 0.2), titleSize(i))
            : ""))
        .each(function (i) {
            if (!opts.showTitle) return;
            trimToWidth(this as SVGTextElement, nodes[i].title,
                textRoom(i, titleY(i) - titleSize(i), titleY(i) + titleSize(i) * 0.2));
        });

    // Measure badge — bottom-right of the card.
    const badge: CardSel = all.select<SVGGElement>("g.card-badge");
    badge.selectAll("*").remove();
    if (opts.showMeasure) {
        badge.each(function (i) {
            const text = badgeText(i);
            if (text === null) return;
            const sel = (this as SVGGElement);
            const ts = titleSize(i);
            const w = badgeWidth(i);
            const ns = "http://www.w3.org/2000/svg";
            // OC-027: the pill and its number were positioned independently — the
            // rect from the card bottom, the text from its own offset — so the digit
            // sat BELOW the centre of its own background. Measured before the fix:
            // dx 0 (text-anchor handles the horizontal) but dy +3.49px on a 19.3px
            // pill, on every badge, at every card size. Both now derive from the same
            // two numbers, so they cannot drift apart again.
            const padY = 7 * scale(i);
            const rectY = H(i) - ts - 11 * scale(i);
            const rectH = ts + padY;
            const fontPx = ts * 0.92;
            const rect = document.createElementNS(ns, "rect");
            rect.setAttribute("x", String(W(i) - w - 8 * scale(i)));
            rect.setAttribute("y", String(rectY));
            rect.setAttribute("width", String(w));
            rect.setAttribute("height", String(rectH));
            rect.setAttribute("rx", String(rectH / 2));
            rect.setAttribute("fill", opts.colorOf(i));
            rect.setAttribute("fill-opacity", "0.14");
            const t = document.createElementNS(ns, "text");
            t.setAttribute("x", String(W(i) - w / 2 - 8 * scale(i)));
            // Baseline, not centre: SVG text has no dominant-baseline here (jsdom in
            // the sweeps does not implement it), so the optical centre is placed by
            // arithmetic — half the cap height below the middle of the pill.
            t.setAttribute("y", String(rectY + rectH / 2 + fontPx * 0.35));
            t.setAttribute("text-anchor", "middle");
            t.setAttribute("font-family", fontFamily);
            t.setAttribute("font-size", String(fontPx));
            t.setAttribute("font-weight", "700");
            // OC-028: the number used the raw group colour — Power BI's default
            // orange measured 3.2:1 on its own tint, under WCAG AA.
            t.setAttribute("fill", tintInk(i));
            t.textContent = text;
            sel.appendChild(rect);
            sel.appendChild(t);
        });
    }

    // Span-of-control pill, top-right. PAID and off by default; when it is on,
    // the numbers belong here because that is what the control promises.
    const metric: CardSel = all.select<SVGGElement>("g.card-metric");
    metric.selectAll("*").remove();
    metric.each(function (i) {
        if (!metricShown(i)) return;
        const sel = this as SVGGElement;
        const ns = "http://www.w3.org/2000/svg";
        const ts = titleSize(i);
        const w = metricWidth(i);
        const h = ts + 6 * scale(i);
        const color = metricColor(i);
        const rect = document.createElementNS(ns, "rect");
        rect.setAttribute("x", String(metricLeft(i)));
        rect.setAttribute("y", String(metricTop(i)));
        rect.setAttribute("width", String(w));
        rect.setAttribute("height", String(h));
        rect.setAttribute("rx", String(h / 2));
        rect.setAttribute("fill", opts.highContrast ? "none" : color);
        rect.setAttribute("fill-opacity", opts.highContrast ? "1" : "0.14");
        if (opts.highContrast) {
            rect.setAttribute("stroke", color);
            rect.setAttribute("stroke-width", String(opts.strokeWidth));
        }
        const t = document.createElementNS(ns, "text");
        t.setAttribute("x", String(metricLeft(i) + w / 2));
        t.setAttribute("y", String(metricTop(i) + h - 5 * scale(i)));
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("font-family", fontFamily);
        t.setAttribute("font-size", String(ts * 0.9));
        t.setAttribute("font-weight", "700");
        t.setAttribute("fill", opts.highContrast ? color : readableInk(color, composite(color, opts.surface.cardFill, 0.14)));
        t.textContent = metricText(i);
        sel.appendChild(rect);
        sel.appendChild(t);
    });

    // Collapse toggle — only on nodes that actually have children.
    const toggle: CardSel = all.select<SVGGElement>("g.card-toggle");
    toggle.selectAll("*").remove();
    toggle.each(function (i) {
        if (directReports(h, i) === 0) return;
        const isCollapsed = opts.collapsed.has(i);
        const ns = "http://www.w3.org/2000/svg";
        const sel = this as SVGGElement;
        const cx = opts.orientation === "leftRight" ? W(i) : W(i) / 2;
        const cy = opts.orientation === "leftRight" ? H(i) / 2 : H(i);
        const rr = 9 * Math.min(1.6, Math.max(1, scale(i)));
        const count = totalDescendants(h, i);
        const label = isCollapsed ? compactCount(count) : "−";
        const fontPx = isCollapsed ? 9 * Math.min(1.6, Math.max(1, scale(i))) : rr * 1.33;
        // A disc for up to three digits, a pill past that, so the leading digit
        // is never cut off (OC-QA-33, #6). Same height, same centre either way.
        const pw = isCollapsed ? Math.max(rr * 2, label.length * fontPx * 0.62 + rr * 0.9) : rr * 2;
        const disc = document.createElementNS(ns, "rect");
        disc.setAttribute("class", "toggle-disc");
        disc.setAttribute("x", String(cx - pw / 2));
        disc.setAttribute("y", String(cy - rr));
        disc.setAttribute("width", String(pw));
        disc.setAttribute("height", String(rr * 2));
        disc.setAttribute("rx", String(rr));
        disc.setAttribute("ry", String(rr));
        disc.setAttribute("fill", isCollapsed ? opts.colorOf(i) : opts.surface.cardFill);
        disc.setAttribute("stroke", opts.colorOf(i));
        disc.setAttribute("stroke-width", "1.3");
        disc.setAttribute("cursor", "pointer");
        const glyph = document.createElementNS(ns, "text");
        glyph.setAttribute("x", String(cx));
        glyph.setAttribute("y", String(cy + (isCollapsed ? fontPx * 0.35 : rr * 0.44)));
        glyph.setAttribute("text-anchor", "middle");
        glyph.setAttribute("font-family", fontFamily);
        glyph.setAttribute("font-size", String(fontPx));
        glyph.setAttribute("font-weight", "700");
        // Collapsed: a count on a solid disc — white or ink, whichever reads.
        const fill = opts.colorOf(i);
        glyph.setAttribute("fill", isCollapsed
            ? (contrastOnDisc(fill))
            : (opts.highContrast ? fill : readableInk(fill, opts.surface.cardFill)));
        glyph.setAttribute("pointer-events", "none");
        glyph.textContent = label;
        // The exact number is always one hover away, however it is shortened.
        const title = document.createElementNS(ns, "title");
        title.textContent = isCollapsed ? `Expand: ${count.toLocaleString("en-US")} people` : "Collapse";
        sel.appendChild(disc);
        sel.appendChild(glyph);
        sel.appendChild(title);
        sel.setAttribute("class", "card-toggle");
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// PAID — dotted-line (matrix) reporting.
// Drawn as a separate layer ON TOP of the tree so it can be toggled without a
// relayout, and so it can never influence where a card sits.
// ─────────────────────────────────────────────────────────────────────────────

/** White or near-black on a solid disc — whichever reads better. */
function contrastOnDisc(disc: string): string {
    return contrastRatio("#FFFFFF", disc) >= contrastRatio("#15161E", disc) ? "#FFFFFF" : "#15161E";
}

export interface DottedRenderOptions {
    orientation: Orientation;
    cardWidth: number;
    cardHeight: number;
    color: string;
    width: number;
}

/** A dotted link between two node indices. */
export interface DottedPair { from: number; to: number; }

export function renderDottedLines(
    root: SvgG,
    links: DottedPair[],
    layout: LayoutResult,
    opts: DottedRenderOptions,
): void {
    let g = root.select<SVGGElement>("g.dotted");
    if (g.empty()) g = root.append("g").attr("class", "dotted") as SvgG;

    // The layout's own card sizes: with level sizing a manager is larger than the
    // settings say, and routing around the settings size cut its corners.
    const boxOf = (i: number): CardBox => ({
        cx: layout.x[i], cy: layout.y[i],
        w: layout.w[i] || opts.cardWidth, h: layout.h[i] || opts.cardHeight,
    });
    const drawable = links.filter((l) => isFinite(layout.x[l.from]) && isFinite(layout.x[l.to]));
    const cards = layout.placed.filter((i) => isFinite(layout.x[i])).map(boxOf);

    const sel: Selection<SVGPathElement, DottedPair, SVGGElement, unknown> =
        g.selectAll<SVGPathElement, DottedPair>("path.dotted-link")
            .data(drawable, (d: DottedPair) => `${d.from}~${d.to}`);
    sel.exit().remove();
    sel.enter().append("path").attr("class", "dotted-link")
        .merge(sel)
        // Routed through the gaps between levels, never across a card (OC-028);
        // bends are rounded so a dashed line still never reads as a broken elbow.
        .attr("d", (d) => dottedPath(boxOf(d.from), boxOf(d.to), cards, opts.orientation))
        .attr("fill", "none")
        .attr("stroke", opts.color)
        .attr("stroke-width", Math.max(1, opts.width))
        .attr("stroke-dasharray", "4 4")
        .attr("stroke-linecap", "round")
        .attr("opacity", 0.75);
}

/** Rendered width of `text` at `fontPx` — measured where the host can, estimated in jsdom. */
function measureAt(el: SVGTextElement, text: string, fontPx: number): number {
    const guess = Array.from(text || "").length * fontPx * 0.56;
    if (typeof el.getComputedTextLength !== "function") return guess;
    try {
        el.setAttribute("font-size", String(fontPx));
        el.textContent = text;
        const w = el.getComputedTextLength();
        return w > 0 ? w : guess;
    } catch { return guess; }
}
