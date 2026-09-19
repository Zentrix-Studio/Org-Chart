"use strict";

/**
 * Annotations — PAID (`annotations`).
 *
 * A short note pinned to a person, persisted with the report so it travels with
 * the bookmark. Keyed by the person's KEY, never by row index — same reasoning
 * as collapse state: indices shift on every filter.
 *
 * The store is a pure value object; `visual.ts` owns persistence.
 */

export interface Note {
    /** Person key the note is pinned to. */
    key: string;
    /** Note body. Plain text only — never rendered as markup. */
    text: string;
    /** Optional author label, shown in the tooltip. */
    author?: string;
}

/** Longest note we persist. Keeps the property bag well under Power BI's limit. */
export const MAX_NOTE_LENGTH = 280;
/** Hard ceiling on notes per report. */
export const MAX_NOTES = 500;

/** Strip anything that could be interpreted as markup, and clamp the length. */
export function sanitizeNoteText(raw: unknown): string {
    if (raw === null || raw === undefined) return "";
    return String(raw)
        .replace(/[<>]/g, "")        // never let a note become markup
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_NOTE_LENGTH);
}

export class NotesStore {
    private map = new Map<string, Note>();

    /** Restore from a persisted JSON string. Never throws on corrupt input. */
    static parse(raw: string): NotesStore {
        const store = new NotesStore();
        if (!raw) return store;
        let arr: unknown;
        try {
            arr = JSON.parse(raw);
        } catch {
            return store;
        }
        if (!Array.isArray(arr)) return store;
        for (const item of arr) {
            if (!item || typeof item !== "object") continue;
            const o = item as Record<string, unknown>;
            const key = typeof o.key === "string" ? o.key.trim() : "";
            const text = sanitizeNoteText(o.text);
            if (key.length === 0 || text.length === 0) continue;
            if (store.map.size >= MAX_NOTES) break;
            const note: Note = { key, text };
            if (typeof o.author === "string" && o.author.length > 0) note.author = o.author.slice(0, 60);
            store.map.set(key, note);
        }
        return store;
    }

    /** Serialize deterministically so no spurious property writes occur. */
    serialize(): string {
        const arr = Array.from(this.map.values())
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return JSON.stringify(arr);
    }

    get(key: string): Note | undefined { return this.map.get(key); }
    has(key: string): boolean { return this.map.has(key); }
    get size(): number { return this.map.size; }
    keys(): string[] { return Array.from(this.map.keys()); }

    /** Add or replace a note. Empty text removes it. Returns true when changed. */
    set(key: string, text: string, author?: string): boolean {
        const k = (key || "").trim();
        if (k.length === 0) return false;
        const t = sanitizeNoteText(text);
        if (t.length === 0) return this.remove(k);
        if (!this.map.has(k) && this.map.size >= MAX_NOTES) return false;
        const existing = this.map.get(k);
        if (existing && existing.text === t && existing.author === author) return false;
        const note: Note = { key: k, text: t };
        if (author) note.author = author.slice(0, 60);
        this.map.set(k, note);
        return true;
    }

    remove(key: string): boolean { return this.map.delete(key); }

    /** Drop notes for people no longer in the data. Returns true when changed. */
    prune(liveKeys: ReadonlySet<string>): boolean {
        let changed = false;
        for (const k of Array.from(this.map.keys())) {
            if (!liveKeys.has(k)) { this.map.delete(k); changed = true; }
        }
        return changed;
    }
}
