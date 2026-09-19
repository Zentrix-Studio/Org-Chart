"use strict";

/**
 * Conditional-formatting rules engine — PAID (`rules`).
 *
 * A rule colours a card (and optionally badges it) when a field passes a test.
 * Rules are evaluated in order; the FIRST match wins, so authors can put the
 * most specific rule at the top. Everything is pure: parse, evaluate, serialize.
 *
 * Rules persist as a JSON string in a hidden settings property, so a corrupt or
 * hand-edited value must never break the render — `parseRules` returns [] rather
 * than throwing, on any malformed input.
 */

export type RuleField =
    | "measure" | "branchTotal" | "directReports" | "totalDescendants"
    | "depth" | "layersBelow" | "group" | "name" | "title" | "span" | "vacant";

export type RuleOp =
    | "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
    | "contains" | "startsWith" | "isBlank" | "notBlank" | "isTrue" | "isFalse";

export interface CFRule {
    field: RuleField;
    op: RuleOp;
    /** Compared against the field. Ignored by isBlank / notBlank / isTrue / isFalse. */
    value?: string | number;
    /** Card accent applied on a match. */
    color: string;
    /** Optional badge text shown on the card. */
    label?: string;
}

/** The value bag a rule is evaluated against, assembled per node. */
export interface RuleContext {
    measure: number | null;
    branchTotal: number | null;
    directReports: number;
    totalDescendants: number;
    depth: number;
    layersBelow: number;
    group: string | null;
    name: string;
    title: string;
    span: string;
    vacant: boolean;
}

const FIELDS: RuleField[] = [
    "measure", "branchTotal", "directReports", "totalDescendants",
    "depth", "layersBelow", "group", "name", "title", "span", "vacant",
];
const OPS: RuleOp[] = [
    "eq", "ne", "gt", "gte", "lt", "lte",
    "contains", "startsWith", "isBlank", "notBlank", "isTrue", "isFalse",
];

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Parse persisted rules. Never throws; drops anything malformed. */
export function parseRules(raw: string): CFRule[] {
    if (!raw) return [];
    let arr: unknown;
    try {
        arr = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(arr)) return [];
    const out: CFRule[] = [];
    for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const field = r.field as RuleField;
        const op = r.op as RuleOp;
        const color = typeof r.color === "string" ? r.color : "";
        if (FIELDS.indexOf(field) < 0) continue;
        if (OPS.indexOf(op) < 0) continue;
        if (!HEX.test(color)) continue;               // colour must be a literal hex, never arbitrary CSS
        const rule: CFRule = { field, op, color };
        if (typeof r.value === "string" || typeof r.value === "number") rule.value = r.value;
        if (typeof r.label === "string" && r.label.length <= 24) rule.label = r.label;
        out.push(rule);
    }
    return out;
}

/** Serialize rules for persistence. Stable ordering — the author's order. */
export function serializeRules(rules: CFRule[]): string {
    return JSON.stringify(rules.map((r) => {
        const o: Record<string, unknown> = { field: r.field, op: r.op, color: r.color };
        if (r.value !== undefined) o.value = r.value;
        if (r.label !== undefined) o.label = r.label;
        return o;
    }));
}

function fieldValue(ctx: RuleContext, field: RuleField): string | number | boolean | null {
    switch (field) {
        case "measure": return ctx.measure;
        case "branchTotal": return ctx.branchTotal;
        case "directReports": return ctx.directReports;
        case "totalDescendants": return ctx.totalDescendants;
        case "depth": return ctx.depth;
        case "layersBelow": return ctx.layersBelow;
        case "group": return ctx.group;
        case "name": return ctx.name;
        case "title": return ctx.title;
        case "span": return ctx.span;
        case "vacant": return ctx.vacant;
        default: return null;
    }
}

function asNum(v: unknown): number | null {
    if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
    const n = typeof v === "number" ? v : Number(v);
    return isFinite(n) ? n : null;
}

/** Evaluate one rule against a node's context. */
export function matches(rule: CFRule, ctx: RuleContext): boolean {
    const actual = fieldValue(ctx, rule.field);
    switch (rule.op) {
        case "isBlank": return actual === null || actual === undefined || actual === "";
        case "notBlank": return !(actual === null || actual === undefined || actual === "");
        case "isTrue": return actual === true;
        case "isFalse": return actual === false;
        default: break;
    }
    if (rule.value === undefined) return false;
    if (rule.op === "contains" || rule.op === "startsWith") {
        const a = String(actual ?? "").toLowerCase();
        const b = String(rule.value).toLowerCase();
        return rule.op === "contains" ? a.indexOf(b) >= 0 : a.indexOf(b) === 0;
    }
    const an = asNum(actual);
    const bn = asNum(rule.value);
    if (an !== null && bn !== null) {
        switch (rule.op) {
            case "eq": return an === bn;
            case "ne": return an !== bn;
            case "gt": return an > bn;
            case "gte": return an >= bn;
            case "lt": return an < bn;
            case "lte": return an <= bn;
            default: return false;
        }
    }
    // Fall back to case-insensitive string comparison for eq / ne only.
    const as = String(actual ?? "").toLowerCase();
    const bs = String(rule.value).toLowerCase();
    if (rule.op === "eq") return as === bs;
    if (rule.op === "ne") return as !== bs;
    return false;
}

export interface RuleHit { color: string; label?: string; index: number; }

/** First matching rule, or null. Order is the author's priority order. */
export function firstMatch(rules: CFRule[], ctx: RuleContext): RuleHit | null {
    for (let i = 0; i < rules.length; i++) {
        if (matches(rules[i], ctx)) {
            return { color: rules[i].color, label: rules[i].label, index: i };
        }
    }
    return null;
}
