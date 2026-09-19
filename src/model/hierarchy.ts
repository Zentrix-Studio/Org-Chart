"use strict";

/**
 * Parent-child hierarchy resolution — the core of the visual, and the place
 * every competing org chart falls over.
 *
 * The contract, deliberately permissive (see docs/CHANGE-LEDGER.md OC-001):
 *
 *   A node becomes a ROOT when its parent key is any of:
 *     • null / undefined / empty / whitespace-only
 *     • equal to its own key (self-reference)
 *     • not present anywhere in the Person ID column (dangling parent)
 *     • the far end of a cycle (A→B→A, or any longer ring)
 *
 *   There is NO magic root value. The top row's ID does not have to be 1, or
 *   blank, or anything else — which is precisely the limitation that makes
 *   "Organization Chart by MAQ Software" unusable on real employee tables.
 *
 * Multiple roots are legal and expected: real data always has orphans, so the
 * result is a FOREST, not a single tree.
 *
 * Everything here is pure, deterministic, and cannot throw or hang on malformed
 * input. Cycle handling is O(n) via an iterative colour walk — never recursion,
 * so a 500-deep chain cannot blow the stack.
 */

export interface Hierarchy {
    /** children[i] = node indices whose resolved parent is i, in input order. */
    children: number[][];
    /** parentIdx[i] = resolved parent node index, or -1 for a root. */
    parentIdx: number[];
    /** Root node indices, in input order. */
    roots: number[];
    /** depth[i] = 0 for a root, parent depth + 1 otherwise. */
    depth: number[];
    /** Node indices whose parent link was dropped to break a cycle. Diagnostic. */
    cycleBroken: number[];
}

/** Normalise a bound key to the string used for parent matching. */
export function normalizeKey(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
}

/**
 * Build the forest from per-node keys and parent keys.
 *
 * @param keys       normalised Person ID per node (duplicates: first wins)
 * @param parentKeys normalised parent key per node, null where absent
 */
export function buildHierarchy(keys: (string | null)[], parentKeys: (string | null)[]): Hierarchy {
    const n = keys.length;
    const children: number[][] = [];
    const parentIdx = new Array<number>(n).fill(-1);
    const depth = new Array<number>(n).fill(0);
    const cycleBroken: number[] = [];
    for (let i = 0; i < n; i++) children.push([]);
    if (n === 0) return { children, parentIdx, roots: [], depth, cycleBroken };

    // Key -> first node index carrying it. Duplicate IDs are a data error we
    // survive rather than reject: the first row wins, later ones still render
    // as their own cards but cannot be pointed at.
    const byKey = new Map<string, number>();
    for (let i = 0; i < n; i++) {
        const k = keys[i];
        if (k !== null && !byKey.has(k)) byKey.set(k, i);
    }

    // Pass 1 — provisional parent links. Anything unresolvable is already a root.
    for (let i = 0; i < n; i++) {
        const pk = parentKeys[i];
        if (pk === null) continue;                 // blank / missing parent -> root
        const p = byKey.get(pk);
        if (p === undefined) continue;             // dangling parent -> root
        if (p === i) continue;                     // self-reference -> root
        parentIdx[i] = p;
    }

    // Pass 2 — break cycles. Iterative three-colour walk: 0 unvisited, 1 on the
    // current path, 2 settled. When the walk re-enters a node that is on the
    // current path we have found a ring; the node that closed it becomes a root.
    const state = new Uint8Array(n);
    const path: number[] = [];
    for (let s = 0; s < n; s++) {
        if (state[s] !== 0) continue;
        path.length = 0;
        let cur = s;
        // Walk upward until we hit a root, a settled node, or our own path.
        for (;;) {
            if (state[cur] === 1) {
                // `cur` is on the path we are currently walking -> cycle.
                parentIdx[cur] = -1;
                cycleBroken.push(cur);
                break;
            }
            if (state[cur] === 2) break;           // joins an already-settled chain
            state[cur] = 1;
            path.push(cur);
            const p = parentIdx[cur];
            if (p === -1) break;                   // reached a root
            cur = p;
        }
        for (let k = 0; k < path.length; k++) state[path[k]] = 2;
    }

    // Pass 3 — children lists and roots, in stable input order.
    const roots: number[] = [];
    for (let i = 0; i < n; i++) {
        const p = parentIdx[i];
        if (p === -1) roots.push(i);
        else children[p].push(i);
    }

    // Pass 4 — depth by breadth-first descent from every root. Iterative, so a
    // deep chain cannot overflow the stack.
    const queue: number[] = roots.slice();
    let head = 0;
    while (head < queue.length) {
        const i = queue[head++];
        const kids = children[i];
        for (let k = 0; k < kids.length; k++) {
            depth[kids[k]] = depth[i] + 1;
            queue.push(kids[k]);
        }
    }

    return { children, parentIdx, roots, depth, cycleBroken };
}

/** Every descendant of `i`, excluding `i` itself. Iterative. */
export function subtreeSet(h: Hierarchy, i: number): Set<number> {
    const out = new Set<number>();
    const stack = h.children[i] ? h.children[i].slice() : [];
    while (stack.length) {
        const j = stack.pop() as number;
        if (out.has(j)) continue;                  // defensive; the forest is acyclic by now
        out.add(j);
        const kids = h.children[j];
        for (let k = 0; k < kids.length; k++) stack.push(kids[k]);
    }
    return out;
}

/** Direct-report count. */
export function directReports(h: Hierarchy, i: number): number {
    return h.children[i] ? h.children[i].length : 0;
}

/** Total descendants under `i` (the whole branch). */
export function totalDescendants(h: Hierarchy, i: number): number {
    return subtreeSet(h, i).size;
}

/** True when `i` has at least one child and can therefore be collapsed. */
export function isParentNode(h: Hierarchy, i: number): boolean {
    return directReports(h, i) > 0;
}

/**
 * Nodes hidden because an ancestor is collapsed.
 *
 * The collapsed node itself stays visible — it is the thing you click to expand
 * again. Descend from the roots so a collapsed branch inside another collapsed
 * branch costs nothing.
 */
export function hiddenByCollapse(h: Hierarchy, collapsed: ReadonlySet<number>): Set<number> {
    const hidden = new Set<number>();
    if (collapsed.size === 0) return hidden;
    const stack: Array<{ i: number; under: boolean }> = [];
    for (let r = 0; r < h.roots.length; r++) stack.push({ i: h.roots[r], under: false });
    while (stack.length) {
        const { i, under } = stack.pop() as { i: number; under: boolean };
        if (under) hidden.add(i);
        const nextUnder = under || collapsed.has(i);
        const kids = h.children[i];
        for (let k = 0; k < kids.length; k++) stack.push({ i: kids[k], under: nextUnder });
    }
    return hidden;
}

/** Count of nodes hidden directly beneath a collapsed node — the "+N" badge. */
export function hiddenCount(h: Hierarchy, i: number): number {
    return totalDescendants(h, i);
}

/**
 * Serialize the collapsed set for persistence.
 *
 * Collapse state is stored as the collapsed nodes' KEYS, never their indices:
 * indices shift whenever the data is filtered or re-sorted, which is exactly how
 * MAQ's org chart loses its expand/collapse state on every refresh. Keys survive
 * a refresh, a cross-filter and a bookmark.
 */
export function serializeCollapsed(keys: (string | null)[], collapsed: ReadonlySet<number>): string {
    const out: string[] = [];
    collapsed.forEach((i) => {
        const k = keys[i];
        if (k !== null && k !== undefined) out.push(k);
    });
    out.sort();                                    // stable string -> no spurious property writes
    return JSON.stringify(out);
}

/** Restore a collapsed set from persisted keys. Unknown keys are ignored. */
export function deserializeCollapsed(keys: (string | null)[], raw: string): Set<number> {
    const set = new Set<number>();
    if (!raw) return set;
    let arr: unknown;
    try {
        arr = JSON.parse(raw);
    } catch {
        return set;                                // corrupt state must never break render
    }
    if (!Array.isArray(arr)) return set;
    const byKey = new Map<string, number>();
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k !== null && k !== undefined && !byKey.has(k)) byKey.set(k, i);
    }
    for (const v of arr) {
        const i = byKey.get(String(v));
        if (i !== undefined) set.add(i);
    }
    return set;
}
