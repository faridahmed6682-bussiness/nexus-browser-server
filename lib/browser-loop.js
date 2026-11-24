'use strict';
/**
 * lib/browser-loop.js — the Nexus browser agent's eyes and hands.
 *
 * This module REPLACES the raw-DOM approach of aistudio-agent.js's
 * observe() (page.evaluate over document.querySelectorAll) for general
 * browsing. The agent never sees raw DOM/HTML, never gets a screenshot,
 * and never runs JavaScript in the page. Everything it perceives comes
 * from Playwright's accessibility tree (page.accessibility.snapshot()),
 * and everything it acts on is grounded by role + accessible name in
 * that tree — the same perception model Meta documents for its browser
 * sub-agent (accessibility-tree snapshot, not the raw DOM; see the
 * research report, sections 1-2).
 *
 * Public API:
 *   snapshotTree(page)                 -> { url, title, nodes, truncated }
 *   snapshotDiff(before, after)        -> { added, removed, changed, truncated }
 *   groundAction(tree, target)         -> { ref } | { error, candidates? }
 *   locatorFor(page, tree, ref)        -> Promise<Locator|null>
 *   duplicateTrialState()              -> { triedRefs: [] }
 *   nextUntried(candidates, state)     -> ref | null
 *
 * Caps (Nexus's own choice — no published source gives these numbers):
 *   MAX_NODES = 200            — snapshotTree keeps at most 200 nodes.
 *   MAX_DIFF_CHANGES = 20      — snapshotDiff reports at most 20 changes.
 *   MAX_DUPLICATE_TRIALS = 3   — at most 3 trials per (role, name) when
 *                                disambiguating duplicate controls.
 *   VALUE_MAX_CHARS = 200      — textbox values are truncated to 200 chars.
 *
 * Privacy rules (hard):
 *   - Password-field values are NEVER included. A value is stripped when
 *     the node is a textbox whose type is 'password', or whose accessible
 *     name matches /pass(word)?|otp|verification code/i. The stripped
 *     node carries `valueStripped: true` — a flag, never the value.
 *   - No cookie values, passwords, or API keys are ever logged by this
 *     module. It logs nothing at all.
 *   - No coordinates, no CSS selectors, no raw DOM queries anywhere.
 *     locatorFor() uses ONLY page.getByRole() / page.getByLabel().
 *
 * No new npm dependencies: Node 20 built-ins + the Playwright page
 * object supplied by the caller.
 */

const MAX_NODES = 200; // Nexus's own choice: snapshot node cap.
const MAX_DIFF_CHANGES = 20; // Nexus's own choice: diff change cap.
const MAX_DUPLICATE_TRIALS = 3; // Nexus's own choice: trials per (role, name).
const VALUE_MAX_CHARS = 200; // textbox value truncation (per spec).

// Accessible names that mark a field as credential/secret-bearing. The
// value is stripped and only `valueStripped: true` is recorded.
const SENSITIVE_NAME_RE = /pass(word)?|otp|verification code/i;

// State keys copied from a raw accessibility node when present.
const STATE_KEYS = [
  'disabled',
  'checked',
  'expanded',
  'focusable',
  'selected',
  'focused',
  'readonly',
  'required',
  'level',
];

// Roles whose value (if any) may be carried into the snapshot, once
// password/sensitive stripping has been applied.
const VALUE_ROLES = new Set(['textbox', 'searchbox']);

/** True when this node's value must never reach the agent/LLM. */
function isSensitiveField(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'password') return true;
  return typeof node.name === 'string' && SENSITIVE_NAME_RE.test(node.name);
}

function truncateValue(value) {
  return value.length > VALUE_MAX_CHARS
    ? value.slice(0, VALUE_MAX_CHARS)
    : value;
}

/**
 * Flatten one raw accessibility node (and its subtree) into compact
 * snapshot nodes, in pre-order. `out` collects nodes; `seen` tracks
 * how many nodes were visited and how many keepable nodes were dropped
 * by the cap, so the caller can tell the tree was capped. Nodes without
 * a role are skipped but their children are still visited.
 */
function flattenNode(raw, out, seen) {
  if (!raw || typeof raw !== 'object') return;
  seen.count += 1;
  if (typeof raw.role === 'string' && raw.role !== '') {
    if (out.length >= MAX_NODES) {
      seen.dropped += 1;
    } else {
      const node = {
        ref: 'n' + (out.length + 1),
        role: raw.role,
        name: typeof raw.name === 'string' ? raw.name : '',
      };
      const state = {};
      for (const key of STATE_KEYS) {
        if (raw[key] !== undefined) state[key] = raw[key];
      }
      if (Object.keys(state).length > 0) node.state = state;
      if (VALUE_ROLES.has(raw.role) && typeof raw.value === 'string') {
        if (isSensitiveField(raw)) {
          node.valueStripped = true;
        } else {
          node.value = truncateValue(raw.value);
        }
      } else if (VALUE_ROLES.has(raw.role) && isSensitiveField(raw)) {
        // Sensitive textbox with no string value: still record the strip
        // so the agent knows a secret field exists here without seeing it.
        node.valueStripped = true;
      }
      out.push(node);
    }
  }
  const children = Array.isArray(raw.children) ? raw.children : [];
  for (const child of children) {
    flattenNode(child, out, seen);
    // Once the cap has dropped a node, truncation is proven — unwind.
    if (seen.dropped > 0) break;
  }
}

/**
 * Take a Playwright page and return a compact accessibility-tree view
 * small enough to paste into an LLM prompt:
 *   { url, title, nodes, truncated }
 * nodes are { ref, role, name, state?, value?, valueStripped? }.
 * `truncated` is true when the raw tree held more than MAX_NODES nodes.
 * Never includes raw DOM/HTML, screenshots, or password-field values.
 */
async function snapshotTree(page) {
  const raw = await page.accessibility.snapshot();
  let url = '';
  let title = '';
  try {
    url = typeof page.url === 'function' ? page.url() : '';
  } catch (_) {
    url = '';
  }
  try {
    title = typeof page.title === 'function' ? await page.title() : '';
  } catch (_) {
    title = '';
  }
  const nodes = [];
  const seen = { count: 0, dropped: 0 };
  if (raw) flattenNode(raw, nodes, seen);
  return { url, title, nodes, truncated: seen.dropped > 0 };
}

// ---------------------------------------------------------------------------
// snapshotDiff
// ---------------------------------------------------------------------------

/**
 * Identity key for pairing nodes across two snapshots: role + accessible
 * name, plus the occurrence index among identical (role, name) pairs, so
 * duplicate controls pair up in tree order instead of collapsing.
 */
function diffKey(node, occurrence) {
  return node.role + '\u0000' + (node.name || '') + '#' + occurrence;
}

function indexByDiffKey(nodes) {
  const map = new Map();
  const counts = new Map();
  for (const node of nodes || []) {
    const base = node.role + '\u0000' + (node.name || '');
    const occ = counts.get(base) || 0;
    counts.set(base, occ + 1);
    map.set(diffKey(node, occ), node);
  }
  return map;
}

function fieldsOf(node) {
  const fields = {};
  if (node.value !== undefined) fields.value = node.value;
  if (node.state && typeof node.state === 'object') {
    for (const key of Object.keys(node.state)) {
      fields['state.' + key] = node.state[key];
    }
  }
  return fields;
}

function jsonable(value) {
  return value === undefined ? null : value;
}

/**
 * Pure diff of two snapshots from snapshotTree().
 *   { added, removed, changed, truncated }
 * - added:   nodes present in `after` but not in `before`.
 * - removed: refs (from `before`) of nodes absent in `after`.
 * - changed: [{ ref, field, from, to }] for paired nodes whose value or
 *   state field differs; `ref` is the `after` node's ref.
 * Total entries across the three lists are capped at MAX_DIFF_CHANGES
 * (Nexus's own choice), in added -> removed -> changed order;
 * `truncated` is true when changes beyond the cap were dropped.
 * URL/title changes are NOT reported here — the caller compares those
 * fields directly.
 */
function snapshotDiff(before, after) {
  const beforeNodes = (before && Array.isArray(before.nodes)) ? before.nodes : [];
  const afterNodes = (after && Array.isArray(after.nodes)) ? after.nodes : [];
  const beforeByKey = indexByDiffKey(beforeNodes);
  const afterByKey = indexByDiffKey(afterNodes);

  const added = [];
  const removed = [];
  const changed = [];

  for (const node of afterNodes) {
    const key = diffKey(node, afterOccurrence(afterNodes, node));
    if (!beforeByKey.has(key)) added.push(node);
  }
  for (const node of beforeNodes) {
    const key = diffKey(node, beforeOccurrence(beforeNodes, node));
    if (!afterByKey.has(key)) removed.push(node.ref);
  }
  // Paired nodes: compare value + state fields.
  for (const node of afterNodes) {
    const key = diffKey(node, afterOccurrence(afterNodes, node));
    const prev = beforeByKey.get(key);
    if (!prev) continue;
    const prevFields = fieldsOf(prev);
    const nextFields = fieldsOf(node);
    const allKeys = new Set([...Object.keys(prevFields), ...Object.keys(nextFields)]);
    for (const field of allKeys) {
      const from = jsonable(prevFields[field]);
      const to = jsonable(nextFields[field]);
      if (from !== to) changed.push({ ref: node.ref, field, from, to });
    }
  }

  // Cap the total at MAX_DIFF_CHANGES, added -> removed -> changed.
  const total = added.length + removed.length + changed.length;
  const truncated = total > MAX_DIFF_CHANGES;
  let budget = MAX_DIFF_CHANGES;
  const take = (list) => {
    const n = Math.min(list.length, budget);
    budget -= n;
    return list.slice(0, n);
  };
  return {
    added: take(added),
    removed: take(removed),
    changed: take(changed),
    truncated,
  };
}

// Occurrence index of `target` among nodes sharing its (role, name).
// Recomputed per call; snapshots are small (<= 200 nodes), so the
// linear scan is fine and keeps snapshotDiff pure and dependency-free.
function occurrenceOf(nodes, target) {
  let occ = 0;
  for (const node of nodes) {
    if (node === target) return occ;
    if (node.role === target.role && (node.name || '') === (target.name || '')) occ += 1;
  }
  return occ;
}
function afterOccurrence(nodes, node) { return occurrenceOf(nodes, node); }
function beforeOccurrence(nodes, node) { return occurrenceOf(nodes, node); }

// ---------------------------------------------------------------------------
// groundAction
// ---------------------------------------------------------------------------

function normaliseName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Ground a { role, name } target against a snapshot tree.
 * Name matching is case-insensitive and trimmed; an exact name match is
 * tried first, then a substring match.
 * Returns:
 *   { ref }                              — exactly one node matches.
 *   { error: 'not-found' }               — nothing matches.
 *   { error: 'unnamed' }                 — the target has no name.
 *                                          Icon-only controls are
 *                                          UNIDENTIFIABLE: never guess
 *                                          from position.
 *   { error: 'duplicate', candidates }   — 2+ nodes match; candidates
 *                                          are their refs in tree order.
 * Never returns coordinates or selectors.
 */
function groundAction(tree, target) {
  const nodes = Array.isArray(tree)
    ? tree
    : (tree && Array.isArray(tree.nodes) ? tree.nodes : []);
  const name = normaliseName(target && target.name);
  if (!name) return { error: 'unnamed' };
  const role = normaliseName(target && target.role);
  const pool = role ? nodes.filter((n) => normaliseName(n.role) === role) : nodes;

  const exact = pool.filter((n) => normaliseName(n.name) === name);
  if (exact.length === 1) return { ref: exact[0].ref };
  if (exact.length > 1) {
    return { error: 'duplicate', candidates: exact.map((n) => n.ref) };
  }
  const partial = pool.filter((n) => normaliseName(n.name).includes(name));
  if (partial.length === 1) return { ref: partial[0].ref };
  if (partial.length > 1) {
    return { error: 'duplicate', candidates: partial.map((n) => n.ref) };
  }
  return { error: 'not-found' };
}

// ---------------------------------------------------------------------------
// locatorFor
// ---------------------------------------------------------------------------

function findNode(tree, ref) {
  const nodes = Array.isArray(tree)
    ? tree
    : (tree && Array.isArray(tree.nodes) ? tree.nodes : []);
  return nodes.find((n) => n && n.ref === ref) || null;
}

/**
 * Map a snapshot ref back to a Playwright locator, using ONLY
 * page.getByRole(role, { name, exact: true }) with a
 * page.getByLabel(name, { exact: true }) fallback for form controls.
 * No CSS selectors, no coordinates, no raw DOM queries.
 * Returns null when the ref is unknown, the node has no name, or the
 * role/name no longer resolves to exactly one element (the page
 * changed) — the caller must then take a fresh snapshot.
 */
async function locatorFor(page, tree, ref) {
  const node = findNode(tree, ref);
  if (!node) return null;
  const name = typeof node.name === 'string' ? node.name.trim() : '';
  if (!name || typeof node.role !== 'string' || !node.role) return null;

  const tryLocator = async (locator) => {
    try {
      if (!locator) return null;
      const count = await locator.count();
      return count === 1 ? locator : null;
    } catch (_) {
      return null;
    }
  };

  let locator = null;
  try {
    locator = page.getByRole(node.role, { name, exact: true });
  } catch (_) {
    locator = null;
  }
  const byRole = await tryLocator(locator);
  if (byRole) return byRole;

  try {
    locator = page.getByLabel(name, { exact: true });
  } catch (_) {
    locator = null;
  }
  return tryLocator(locator);
}

// ---------------------------------------------------------------------------
// duplicateTrialState — disambiguating duplicate controls by trial.
// ---------------------------------------------------------------------------

/**
 * Fresh trial state for ONE (role, name) target. The engine creates one
 * state per ambiguous target, clicks one candidate, takes a fresh
 * snapshot, and learns from the new tree. One state must NOT be shared
 * across different (role, name) targets — the 3-trial cap applies per
 * target.
 */
function duplicateTrialState() {
  return { triedRefs: [] };
}

/**
 * Return the next candidate ref that has not been tried yet, claiming
 * it as a trial (it is appended to state.triedRefs). Returns null when
 * every candidate was tried, or when MAX_DUPLICATE_TRIALS trials have
 * already been claimed — even if untried candidates remain. The cap of
 * 3 trials per (role, name) is Nexus's own choice.
 */
function nextUntried(candidates, state) {
  if (!Array.isArray(candidates) || !state || !Array.isArray(state.triedRefs)) {
    return null;
  }
  if (state.triedRefs.length >= MAX_DUPLICATE_TRIALS) return null;
  const tried = new Set(state.triedRefs);
  for (const ref of candidates) {
    if (typeof ref !== 'string') continue;
    if (!tried.has(ref)) {
      state.triedRefs.push(ref);
      return ref;
    }
  }
  return null;
}

module.exports = {
  snapshotTree,
  snapshotDiff,
  groundAction,
  locatorFor,
  duplicateTrialState,
  nextUntried,
  MAX_NODES,
  MAX_DIFF_CHANGES,
  MAX_DUPLICATE_TRIALS,
  VALUE_MAX_CHARS,
};
