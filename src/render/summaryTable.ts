"use strict";

/**
 * Table view (OC-029) — the hierarchy as a sortable people table, the family's
 * summary-table dashboard (Network Graph NG-113 / NG-253 / NG-288 / NG-291)
 * rebuilt around org columns:
 *  - stat cards (People · Levels · Avg span · Widest span, plus the measure
 *    total and open roles when those exist), foldable;
 *  - a strip with a live "N of M shown" count, search, a Group filter, a
 *    Columns picker and CSV export;
 *  - the table itself, in TREE ORDER by default (an indented outline of the
 *    chart), sortable by any column. Direct reports, Total team and Branch total
 *    draw proportional bars.
 * Clicking a row shows that person on the chart.
 *
 * Built with createElement/createElementNS + textContent — never innerHTML
 * (certifiable by construction).
 */

import { OrgTableRow } from "../model/orgTable";
import { OrgSummary, SpanThresholds, SpanFlag } from "../model/analytics";
import { Surface, fontFamily, accent } from "../theme/zentrixTokens";

const MONO = "'SF Mono', 'Cascadia Mono', Consolas, ui-monospace, monospace";
const SERIF = "Georgia, 'Times New Roman', serif";
const SVG_NS = "http://www.w3.org/2000/svg";

/** The reader's table choices, persisted as one blob (`tableState.data`). */
export interface TableState {
    columns: string[];
    sort: { key: string; desc: boolean };
    statsCollapsed: boolean;
}

export interface SummaryTableOptions {
    summary: OrgSummary;
    thresholds: SpanThresholds;
    hasTitle: boolean;
    hasGroup: boolean;
    groupLabel?: string | null;
    hasMeasure: boolean;
    measureLabel?: string | null;
    /** "Flag vacancies" is on — otherwise the column would be all "No" by construction. */
    vacanciesFlagged: boolean;
    /** Period comparison is live. */
    hasChanges: boolean;
    /** Another visual is highlighting; non-highlighted rows are dimmed. */
    hasHighlights: boolean;
    /** Group colour for a node index — the SAME accessor the cards use. */
    colorOf: (index: number) => string;
    /** Number formatting for totals the host did not format (branch totals). */
    formatNumber: (v: number) => string;
    hc?: boolean;
    /** Receives the CSV for the rows and columns currently shown. Hidden when absent. */
    onExport?: (csv: Array<Array<string | number | null>>) => void;
    /** A row was activated — show that person on the chart. */
    onActivate?: (index: number) => void;
    initial?: Partial<TableState> | null;
    onStateChange?: (state: TableState) => void;
    /** Session-local search text, so a host re-render does not wipe the reader's query. */
    initialQuery?: string;
    onQuery?: (q: string) => void;
    /** Room kept clear at the top / bottom for floating chrome (gear, view switch). */
    insetTop?: number;
    insetBottom?: number;
}

interface Column {
    /** Stable id — persisted, and the sort tracks it. Never rename. */
    key: string;
    label: string;
    numeric: boolean;
    value: (r: OrgTableRow) => string;
    sortKey: (r: OrgTableRow) => number | string;
    /** Raw value for the CSV (numbers stay numbers). */
    csv: (r: OrgTableRow) => string | number | null;
    bar?: { frac: (r: OrgTableRow) => number; color: (r: OrgTableRow) => string };
    dot?: (r: OrgTableRow) => string;
    defaultOn: boolean;
    hint?: string;
}

/** Chrome palette derived from the surface — the family recipe. */
function chrome(surface: Surface, hc: boolean) {
    const light = surface.bg === "#FFFFFF";
    if (hc) {
        return {
            pageBg: surface.bg, cardBg: surface.bg, border: surface.fg,
            zebra: "transparent", track: "transparent", shadow: "none",
        };
    }
    return light
        ? {
            pageBg: "#F0F1F7", cardBg: "#FFFFFF", border: "#E8EAF2",
            zebra: "#F7F8FC", track: "#EDEFF6", shadow: "0 2px 10px rgba(11,16,32,0.06)",
        }
        : {
            pageBg: surface.bg, cardBg: "#15161E", border: "#2A2B36",
            zebra: "rgba(255,255,255,0.03)", track: "rgba(255,255,255,0.10)",
            shadow: "0 2px 10px rgba(0,0,0,0.45)",
        };
}

function icon(paths: string[], size = 14): SVGSVGElement {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("width", String(size));
    s.setAttribute("height", String(size));
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    s.setAttribute("aria-hidden", "true");
    for (const d of paths) {
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", d);
        s.appendChild(p);
    }
    return s;
}
const SEARCH_ICON = ["M21 21l-4.8-4.8", "M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z"];
const FILTER_ICON = ["M4 5h16l-6.5 8v5.5L10 21v-8L4 5z"];
const EXPORT_ICON = ["M12 4v11", "M7 11l5 5 5-5", "M5 20h14"];
const COLUMNS_ICON = ["M4 5h16v14H4z", "M11 5v14", "M15.5 5v14"];

const SPAN_TEXT: Record<SpanFlag, string> = { wide: "Wide", narrow: "Narrow", ok: "OK", leaf: "—" };
const SPAN_RANK: Record<SpanFlag, number> = { leaf: 0, narrow: 1, ok: 2, wide: 3 };
const CHANGE_TEXT: Record<string, string> = { joiner: "Joiner", leaver: "Leaver", mover: "Mover", unchanged: "—" };

/** 5207225 → "5.2M" — a stat card has room for about six characters. */
export function compact(v: number): string {
    try {
        return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
    } catch {
        return String(Math.round(v));
    }
}

/** The sort key meaning "outline order" — the chart read top to bottom. */
export const TREE_SORT = "tree";

export function renderSummaryTable(
    host: HTMLElement,
    rows: OrgTableRow[],
    surface: Surface,
    opts: SummaryTableOptions,
): HTMLDivElement {
    const hc = Boolean(opts.hc);
    const c = chrome(surface, hc);
    const s = opts.summary;
    const barColor = hc ? surface.fg : accent;

    let maxDirect = 1, maxTeam = 1, maxBranch = 0;
    for (const r of rows) {
        if (r.direct > maxDirect) maxDirect = r.direct;
        if (r.team > maxTeam) maxTeam = r.team;
        if (r.branchTotal !== null && Math.abs(r.branchTotal) > maxBranch) maxBranch = Math.abs(r.branchTotal);
    }

    // ── columns ────────────────────────────────────────────────────────────
    const cols: Column[] = [
        {
            key: "name", label: "Person", numeric: false, defaultOn: true,
            value: (r) => r.name, sortKey: (r) => r.name.toLowerCase(), csv: (r) => r.name,
        },
    ];
    if (opts.hasTitle) {
        cols.push({
            key: "title", label: "Title", numeric: false, defaultOn: true,
            value: (r) => r.title, sortKey: (r) => r.title.toLowerCase(), csv: (r) => r.title,
        });
    }
    cols.push(
        {
            key: "manager", label: "Reports to", numeric: false, defaultOn: true,
            value: (r) => r.manager || "—", sortKey: (r) => r.manager.toLowerCase(), csv: (r) => r.manager,
        },
        {
            key: "level", label: "Level", numeric: true, defaultOn: true,
            value: (r) => String(r.level), sortKey: (r) => r.level, csv: (r) => r.level,
            hint: "1 is the top of the tree.",
        },
        {
            key: "direct", label: "Direct reports", numeric: true, defaultOn: true,
            value: (r) => String(r.direct), sortKey: (r) => r.direct, csv: (r) => r.direct,
            bar: { frac: (r) => r.direct / maxDirect, color: () => barColor },
        },
        {
            key: "team", label: "Total team", numeric: true, defaultOn: true,
            value: (r) => String(r.team), sortKey: (r) => r.team, csv: (r) => r.team,
            bar: { frac: (r) => r.team / maxTeam, color: (r) => (hc ? surface.fg : opts.colorOf(r.index)) },
            hint: "Everyone below this person, at any depth.",
        },
        {
            key: "layers", label: "Layers below", numeric: true, defaultOn: false,
            value: (r) => String(r.layersBelow), sortKey: (r) => r.layersBelow, csv: (r) => r.layersBelow,
        },
        {
            key: "span", label: "Span", numeric: false, defaultOn: false,
            value: (r) => SPAN_TEXT[r.span], sortKey: (r) => SPAN_RANK[r.span], csv: (r) => SPAN_TEXT[r.span],
            hint: `Wide above ${opts.thresholds.wide} direct reports, narrow below ${opts.thresholds.narrow}.`,
        },
    );
    if (opts.hasGroup) {
        cols.push({
            key: "group", label: opts.groupLabel || "Group", numeric: false, defaultOn: true,
            value: (r) => r.group ?? "", sortKey: (r) => (r.group ?? "").toLowerCase(), csv: (r) => r.group,
            dot: (r) => (hc ? surface.fg : opts.colorOf(r.index)),
        });
    }
    if (opts.hasMeasure) {
        cols.push(
            {
                key: "measure", label: opts.measureLabel || "Measure", numeric: true, defaultOn: true,
                value: (r) => r.measureText ?? (r.measure === null ? "—" : opts.formatNumber(r.measure)),
                sortKey: (r) => (r.measure === null ? -Infinity : r.measure), csv: (r) => r.measure,
            },
            {
                key: "branch", label: "Branch total", numeric: true, defaultOn: true,
                value: (r) => (r.branchTotal === null ? "—" : opts.formatNumber(r.branchTotal)),
                sortKey: (r) => (r.branchTotal === null ? -Infinity : r.branchTotal), csv: (r) => r.branchTotal,
                bar: { frac: (r) => (maxBranch > 0 && r.branchTotal !== null ? Math.abs(r.branchTotal) / maxBranch : 0), color: () => barColor },
                hint: "This person plus everyone below them.",
            },
        );
    }
    if (opts.vacanciesFlagged) {
        cols.push({
            key: "vacant", label: "Open role", numeric: false, defaultOn: true,
            value: (r) => (r.vacant ? "Yes" : ""), sortKey: (r) => (r.vacant ? 1 : 0), csv: (r) => (r.vacant ? "Yes" : "No"),
        });
    }
    if (opts.hasChanges) {
        cols.push({
            key: "change", label: "Change", numeric: false, defaultOn: true,
            value: (r) => (r.change ? CHANGE_TEXT[r.change] : "—"),
            sortKey: (r) => (r.change && r.change !== "unchanged" ? r.change : "~"),
            csv: (r) => (r.change ? CHANGE_TEXT[r.change] : ""),
        });
    }

    // ── state: columns, sort, folded cards (persisted) + query (session) ──
    const known = new Set(cols.map((col) => col.key));
    const restored = (opts.initial?.columns ?? []).filter((k) => known.has(k));
    const visible = new Set<string>(restored.length ? restored : cols.filter((col) => col.defaultOn).map((col) => col.key));
    visible.add("name");   // the one column you cannot lose — it says who the row is
    const visibleCols = (): Column[] => cols.filter((col) => visible.has(col.key));

    let sortKey = opts.initial?.sort?.key ?? TREE_SORT;
    let sortDesc = opts.initial?.sort?.desc ?? false;
    if (sortKey !== TREE_SORT && !visible.has(sortKey)) { sortKey = TREE_SORT; sortDesc = false; }
    let statsCollapsed = opts.initial?.statsCollapsed === true;
    const emitState = (): void => opts.onStateChange?.({
        columns: cols.filter((col) => visible.has(col.key)).map((col) => col.key),
        sort: { key: sortKey, desc: sortDesc },
        statsCollapsed,
    });

    const wrap = document.createElement("div");
    wrap.className = "zx-summary zx-org-table";
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "People table");
    const top = 18 + (opts.insetTop ?? 0), bottom = 18 + (opts.insetBottom ?? 0);
    wrap.style.cssText = `position:absolute;inset:0;overflow:auto;background:${c.pageBg};z-index:4;` +
        `color:${surface.fg};font:13px ${fontFamily};padding:${top}px 18px ${bottom}px;box-sizing:border-box`;
    // Keep presses inside the table: the chart's click-away and zoom never see them.
    wrap.addEventListener("mousedown", (ev) => ev.stopPropagation());

    // ── stat cards ─────────────────────────────────────────────────────────
    const cards = document.createElement("div");
    cards.className = "zx-sum-cards";
    cards.style.cssText = "display:flex;gap:14px;margin-bottom:18px;flex-wrap:wrap";
    /** `full` is the exact value, on hover, when `big` is a shortened one. */
    const statCard = (title: string, big: string, sub: string, full?: string): void => {
        const card = document.createElement("div");
        card.className = "zx-sum-card";
        card.style.cssText = `flex:1 1 120px;min-width:120px;background:${c.cardBg};border-radius:12px;` +
            `padding:16px 20px;box-shadow:${c.shadow};border:1px solid ${c.border}`;
        const t = document.createElement("div");
        t.textContent = title;
        t.style.cssText = `font:13px ${fontFamily};color:${surface.fg};opacity:0.85;margin-bottom:8px;white-space:nowrap`;
        const b = document.createElement("div");
        b.className = "zx-sum-big";
        b.textContent = big;
        b.title = full ?? big;
        b.style.cssText = `font:600 30px ${SERIF};color:${surface.fg};letter-spacing:0.5px;margin-bottom:6px;` +
            "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        const sub2 = document.createElement("div");
        sub2.textContent = sub;
        sub2.title = sub;
        sub2.style.cssText = `font:12px ${fontFamily};color:${surface.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
        card.appendChild(t); card.appendChild(b); card.appendChild(sub2);
        cards.appendChild(card);
    };
    statCard("People", s.people.toLocaleString("en-US"),
        `${s.managers.toLocaleString("en-US")} ${s.managers === 1 ? "manager" : "managers"}`);
    statCard("Levels", String(s.maxDepth + 1), s.roots > 1 ? `${s.roots} separate trees` : "top to bottom");
    statCard("Avg span", s.averageSpan === null ? "—" : s.averageSpan.toFixed(1), "per manager");
    let widest: OrgTableRow | null = null;
    for (const r of rows) if (r.direct > 0 && (!widest || r.direct > widest.direct)) widest = r;
    // The figure is the count and the person goes underneath: a name at 30px is cut
    // off at any ordinary width ("Rosa …"), and the card is about the NUMBER.
    statCard("Widest span", widest ? String(widest.direct) : "—", widest ? widest.name : "no managers");
    if (opts.hasMeasure) {
        let total = 0, any = false;
        for (const r of rows) if (r.measure !== null && isFinite(r.measure)) { total += r.measure; any = true; }
        statCard(`Total ${opts.measureLabel || "measure"}`, any ? compact(total) : "—", "across everyone",
            any ? opts.formatNumber(total) : undefined);
    }
    if (opts.vacanciesFlagged) {
        statCard("Open roles", String(s.vacancies.length), s.vacancies.length === 1 ? "position to fill" : "positions to fill");
    }

    const statsToggle = document.createElement("button");
    statsToggle.type = "button";
    statsToggle.className = "zx-sum-stats-toggle";
    statsToggle.setAttribute("aria-label", "Toggle summary cards");
    statsToggle.style.cssText = "display:inline-flex;align-items:center;gap:7px;margin-bottom:10px;padding:4px 8px;"
        + `border:none;background:transparent;color:${surface.muted};cursor:pointer;`
        + `font:600 12px ${fontFamily};letter-spacing:.03em`;
    const applyStats = (): void => {
        cards.style.display = statsCollapsed ? "none" : "flex";
        statsToggle.textContent = `${statsCollapsed ? "▸" : "▾"}  Summary`;
        statsToggle.setAttribute("aria-expanded", String(!statsCollapsed));
    };
    statsToggle.onclick = (ev) => { ev.stopPropagation(); statsCollapsed = !statsCollapsed; applyStats(); emitState(); };
    applyStats();
    wrap.appendChild(statsToggle);
    wrap.appendChild(cards);

    if (opts.hasHighlights) {
        const n = rows.filter((r) => r.highlighted).length;
        const banner = document.createElement("div");
        banner.className = "zx-sum-highlight-note";
        banner.textContent = `${n} of ${rows.length} highlighted by another visual — the rest are dimmed.`;
        banner.style.cssText = "margin:-6px 0 16px;padding:9px 13px;border-radius:9px;" +
            `font:600 12px ${fontFamily};background:${hc ? "transparent" : c.cardBg};` +
            `color:${surface.fg};border:1px solid ${hc ? surface.fg : accent}`;
        wrap.appendChild(banner);
    }

    // ── strip: title + count · search · filter · columns · export ─────────
    const strip = document.createElement("div");
    strip.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap";
    const title = document.createElement("span");
    title.textContent = "People";
    title.style.cssText = `font:700 17px ${SERIF};white-space:nowrap`;
    strip.appendChild(title);
    const countEl = document.createElement("span");
    countEl.className = "zx-sum-count";
    countEl.style.cssText = `font:12px ${MONO};color:${surface.muted};white-space:nowrap`;
    strip.appendChild(countEl);
    const spacer = document.createElement("span");
    spacer.style.cssText = "flex:1 1 auto";
    strip.appendChild(spacer);

    const searchWrap = document.createElement("span");
    searchWrap.style.cssText = "position:relative;display:inline-flex;align-items:center";
    const searchIco = icon(SEARCH_ICON);
    searchIco.style.cssText = `position:absolute;left:10px;pointer-events:none;color:${surface.muted}`;
    const search = document.createElement("input");
    search.type = "text";
    search.className = "zx-summary-search";
    search.placeholder = "Search people…";
    search.setAttribute("aria-label", "Search people");
    search.style.cssText = "width:190px;height:32px;padding:0 10px 0 32px;border-radius:9px;" +
        `border:1px solid ${c.border};background:${c.cardBg};color:${surface.fg};` +
        `font:400 12px ${fontFamily};outline:none;box-sizing:border-box`;
    let query = (opts.initialQuery ?? "").trim().toLowerCase();
    search.value = opts.initialQuery ?? "";
    search.oninput = () => {
        query = search.value.trim().toLowerCase();
        opts.onQuery?.(search.value);
        renderBody();
    };
    search.onclick = (ev) => ev.stopPropagation();
    // Arrow keys and +/- belong to the text box here, not to the chart's shortcuts.
    search.onkeydown = (ev) => ev.stopPropagation();
    searchWrap.appendChild(searchIco);
    searchWrap.appendChild(search);
    strip.appendChild(searchWrap);

    const chromeBtn = (label: string, ico: SVGSVGElement, cls: string): HTMLButtonElement => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = cls;
        b.appendChild(ico);
        const t = document.createElement("span");
        t.textContent = label;
        b.appendChild(t);
        b.style.cssText = "display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 13px;" +
            `border-radius:9px;border:1px solid ${c.border};background:${c.cardBg};color:${surface.fg};` +
            `font:600 12px ${fontFamily};cursor:pointer`;
        return b;
    };
    const popover = (holder: HTMLElement, btn: HTMLButtonElement, cls: string): HTMLDivElement => {
        const pop = document.createElement("div");
        pop.className = cls;
        pop.style.cssText = "display:none;position:absolute;top:38px;right:0;z-index:20;min-width:180px;" +
            `background:${c.cardBg};border:1px solid ${c.border};border-radius:10px;box-shadow:${c.shadow};` +
            "padding:8px;max-height:260px;overflow:auto";
        btn.onclick = (ev) => {
            ev.stopPropagation();
            pop.style.display = pop.style.display === "none" ? "block" : "none";
        };
        holder.appendChild(btn);
        holder.appendChild(pop);
        return pop;
    };
    const checkRow = (pop: HTMLElement, label: string, checked: boolean, onChange: (on: boolean) => void): void => {
        const row = document.createElement("label");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:7px;" +
            `font:12px ${fontFamily};color:${surface.fg};cursor:pointer;white-space:nowrap`;
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = checked;
        cb.onchange = () => onChange(cb.checked);
        const t = document.createElement("span");
        t.textContent = label;
        row.appendChild(cb); row.appendChild(t);
        row.onclick = (ev) => ev.stopPropagation();
        pop.appendChild(row);
    };

    // Group filter — only when the Group well is bound; there is nothing else to filter by.
    const activeGroups = new Set<string>();
    if (opts.hasGroup) {
        const groups = Array.from(new Set(rows.map((r) => r.group).filter((g): g is string => g !== null && g !== "")))
            .sort((a, b) => a.localeCompare(b));
        if (groups.length) {
            const holder = document.createElement("span");
            holder.style.cssText = "position:relative;display:inline-flex";
            const filterBtn = chromeBtn(opts.groupLabel || "Group", icon(FILTER_ICON), "zx-sum-filter");
            const pop = popover(holder, filterBtn, "zx-sum-filterpop");
            for (const g of groups) {
                checkRow(pop, g, false, (on) => {
                    if (on) activeGroups.add(g); else activeGroups.delete(g);
                    filterBtn.style.borderColor = activeGroups.size ? accent : c.border;
                    filterBtn.style.color = activeGroups.size ? accent : surface.fg;
                    renderBody();
                });
            }
            strip.appendChild(holder);
        }
    }

    // Columns picker — every column but Person can be switched off.
    {
        const holder = document.createElement("span");
        holder.style.cssText = "position:relative;display:inline-flex";
        const colsBtn = chromeBtn("Columns", icon(COLUMNS_ICON), "zx-sum-columns");
        const pop = popover(holder, colsBtn, "zx-sum-colspop");
        for (const col of cols) {
            if (col.key === "name") continue;
            checkRow(pop, col.label, visible.has(col.key), (on) => {
                if (on) visible.add(col.key); else visible.delete(col.key);
                if (sortKey !== TREE_SORT && !visible.has(sortKey)) { sortKey = TREE_SORT; sortDesc = false; }
                renderHead();
                renderBody();
                emitState();
            });
        }
        strip.appendChild(holder);
    }

    let shown: OrgTableRow[] = [];
    if (opts.onExport) {
        const exportBtn = chromeBtn("Export", icon(EXPORT_ICON), "zx-sum-export");
        exportBtn.title = "Download the rows and columns shown as CSV";
        exportBtn.onclick = (ev) => {
            ev.stopPropagation();
            const vc = visibleCols();
            const out: Array<Array<string | number | null>> = [vc.map((col) => col.label)];
            for (const r of shown) out.push(vc.map((col) => col.csv(r)));
            opts.onExport!(out);
        };
        strip.appendChild(exportBtn);
    }
    wrap.appendChild(strip);

    // ── the table ──────────────────────────────────────────────────────────
    const tableCard = document.createElement("div");
    tableCard.style.cssText = `background:${c.cardBg};border-radius:12px;border:1px solid ${c.border};` +
        `box-shadow:${c.shadow};overflow:hidden`;
    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;width:100%";
    table.setAttribute("aria-label", "People");
    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    tableCard.appendChild(table);
    wrap.appendChild(tableCard);

    const thBase = `padding:11px 14px;position:sticky;top:0;background:${c.cardBg};` +
        `border-bottom:2px solid ${c.border};font:700 11px ${fontFamily};letter-spacing:0.8px;` +
        `text-transform:uppercase;color:${surface.muted};user-select:none;white-space:nowrap;z-index:2;cursor:pointer`;

    // "#" returns the table to tree order — the chart, read top to bottom.
    const rankTh = document.createElement("th");
    rankTh.className = "zx-sum-rank";
    rankTh.style.cssText = `${thBase};text-align:left;width:1%`;
    rankTh.title = "Tree order — the chart read top to bottom";
    rankTh.onclick = () => { sortKey = TREE_SORT; sortDesc = false; updateArrows(); renderBody(); emitState(); };

    let headerCells: Array<{ col: Column; th: HTMLTableCellElement }> = [];
    function renderHead(): void {
        while (hr.firstChild) hr.removeChild(hr.firstChild);
        hr.appendChild(rankTh);
        headerCells = [];
        for (const col of visibleCols()) {
            const th = document.createElement("th");
            th.setAttribute("data-key", col.key);
            th.style.cssText = `${thBase};text-align:${col.numeric ? "right" : "left"}`;
            th.title = col.hint ? `${col.hint}  ·  Click to sort` : "Click to sort";
            th.onclick = () => {
                if (sortKey === col.key) sortDesc = !sortDesc;
                else { sortKey = col.key; sortDesc = col.numeric; }
                updateArrows();
                renderBody();
                emitState();
            };
            hr.appendChild(th);
            headerCells.push({ col, th });
        }
        updateArrows();
    }
    function updateArrows(): void {
        const tree = sortKey === TREE_SORT;
        rankTh.textContent = tree ? "# ▲" : "#";
        rankTh.style.color = tree ? (hc ? surface.fg : accent) : surface.muted;
        rankTh.setAttribute("aria-sort", tree ? "ascending" : "none");
        for (const { col, th } of headerCells) {
            const active = col.key === sortKey;
            th.textContent = col.label + (active ? (sortDesc ? " ▼" : " ▲") : "");
            th.style.color = active ? (hc ? surface.fg : accent) : surface.muted;
            th.setAttribute("aria-sort", active ? (sortDesc ? "descending" : "ascending") : "none");
        }
    }

    function barCell(td: HTMLTableCellElement, frac: number, color: string, value: string): void {
        const box = document.createElement("span");
        box.style.cssText = "display:inline-flex;align-items:center;gap:10px;justify-content:flex-end";
        const track = document.createElement("span");
        track.style.cssText = `display:inline-block;width:72px;height:6px;border-radius:3px;` +
            `background:${c.track};overflow:hidden;flex:0 0 auto`;
        const fill = document.createElement("span");
        fill.className = "zx-sum-bar";
        const p = Math.max(0, Math.min(1, frac)) * 100;
        fill.style.cssText = `display:block;height:100%;border-radius:3px;background:${color};width:${Math.round(p * 10) / 10}%`;
        track.appendChild(fill);
        const num = document.createElement("span");
        num.textContent = value;
        num.style.cssText = `font:600 12.5px ${MONO};min-width:26px;text-align:right`;
        box.appendChild(track);
        box.appendChild(num);
        td.appendChild(box);
    }

    const haystack = (r: OrgTableRow): string =>
        `${r.name} ${r.title} ${r.manager} ${r.group ?? ""}`.toLowerCase();

    function renderBody(): void {
        const vc = visibleCols();
        const col = vc.find((cc) => cc.key === sortKey);
        const tree = sortKey === TREE_SORT || !col;
        shown = rows
            .filter((r) => query === "" || haystack(r).indexOf(query) !== -1)
            .filter((r) => !activeGroups.size || (r.group !== null && activeGroups.has(r.group)))
            .sort((a, b) => {
                if (tree) return a.treeOrder - b.treeOrder;
                const ka = col.sortKey(a), kb = col.sortKey(b);
                const cmp = typeof ka === "number" && typeof kb === "number"
                    ? ka - kb : String(ka).localeCompare(String(kb));
                // Ties fall back to tree order, so equal rows never shuffle between renders.
                return (sortDesc ? -cmp : cmp) || a.treeOrder - b.treeOrder;
            });

        countEl.textContent = `${shown.length.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")} shown`;
        while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

        if (shown.length === 0) {
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.colSpan = vc.length + 1;
            td.textContent = "Nobody matches your search.";
            td.style.cssText = `padding:18px 14px;text-align:center;font:12px ${fontFamily};color:${surface.muted}`;
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
        }

        const tdBase = `padding:9px 14px;border-bottom:1px solid ${c.border};white-space:nowrap`;
        shown.forEach((r, n) => {
            const tr = document.createElement("tr");
            tr.className = "zx-sum-row";
            tr.setAttribute("data-index", String(r.index));
            tr.style.background = n % 2 ? c.zebra : "transparent";
            if (opts.hasHighlights && !r.highlighted) tr.style.opacity = "0.45";
            if (opts.onActivate) {
                tr.style.cursor = "pointer";
                tr.tabIndex = 0;
                tr.title = "Show on the chart";
                const go = (): void => opts.onActivate!(r.index);
                tr.onclick = (ev) => { ev.stopPropagation(); go(); };
                tr.onkeydown = (ev) => {
                    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); go(); }
                };
            }

            const rankTd = document.createElement("td");
            rankTd.textContent = String(n + 1);
            rankTd.style.cssText = `${tdBase};text-align:left;font:12px ${MONO};color:${surface.muted}`;
            tr.appendChild(rankTd);

            for (const cdef of vc) {
                const td = document.createElement("td");
                td.setAttribute("data-key", cdef.key);
                td.style.cssText = `${tdBase};text-align:${cdef.numeric ? "right" : "left"}`;
                const v = cdef.value(r);
                if (cdef.bar) {
                    barCell(td, cdef.bar.frac(r), cdef.bar.color(r), v);
                } else if (cdef.dot) {
                    if (v) {
                        const dot = document.createElement("span");
                        dot.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:50%;` +
                            `background:${cdef.dot(r)};margin-right:8px;vertical-align:0`;
                        td.appendChild(dot);
                    }
                    const t = document.createElement("span");
                    t.textContent = v;
                    t.style.cssText = `font:12.5px ${fontFamily};color:${surface.fg}`;
                    td.appendChild(t);
                } else if (cdef.key === "name") {
                    td.textContent = v;
                    td.style.font = `700 12.5px ${fontFamily}`;
                    // In tree order the name column IS the outline: indent by level.
                    if (tree) td.style.paddingLeft = `${14 + Math.min(r.level - 1, 12) * 14}px`;
                } else if (cdef.numeric) {
                    td.textContent = v;
                    td.style.font = `12.5px ${MONO}`;
                    if (v === "0") td.style.color = surface.muted;
                } else {
                    td.textContent = v;
                    td.style.font = `12.5px ${fontFamily}`;
                    // Weight, not colour: carries in high contrast and adds no off-token hex.
                    if (cdef.key === "span" && r.span === "wide") td.style.fontWeight = "700";
                }
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        });
    }

    renderHead();
    renderBody();
    host.appendChild(wrap);
    return wrap;
}
