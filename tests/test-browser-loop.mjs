// tests/test-browser-loop.mjs — tests for lib/browser-loop.js.
// Node built-ins only (node:test + node:assert). NO browser needed:
// snapshotTree() is exercised with a stub page object whose
// accessibility.snapshot() returns canned raw trees, and locatorFor()
// with a stub page whose getByRole()/getByLabel() return stub locators.
//
//   node --test tests/test-browser-loop.mjs
//
// Exit code: 0 = all cases PASS, non-zero = at least one FAIL.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
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
} = require('../lib/browser-loop.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub Playwright page: accessibility.snapshot() returns `rawTree`. */
function stubPage(rawTree, url = 'https://example.com/shop', title = 'Example Shop') {
  return {
    url: () => url,
    title: async () => title,
    accessibility: { snapshot: async () => rawTree },
  };
}

const RAW_TREE = {
  role: 'WebArea',
  name: 'Example Shop',
  children: [
    { role: 'heading', name: 'Granola bars' },
    {
      role: 'button',
      name: 'Add to cart',
      children: [{ role: 'generic', name: 'icon' }],
    },
    { role: 'link', name: 'See all sizes', url: 'https://example.com/sizes' },
    { role: 'textbox', name: 'Search products', value: 'granola' },
    { role: 'textbox', name: 'Password', value: 'hunter2-secret' },
    { role: 'textbox', name: 'Enter OTP', value: '123456' },
    { role: 'textbox', name: 'Verification code', value: '999999' },
    { role: 'textbox', name: 'Card password', type: 'password', value: 'tok-abc' },
    { role: 'checkbox', name: 'Subscribe', checked: false },
    { role: 'button', name: 'Buy now', disabled: true },
    { role: 'button', name: 'Build app', expanded: false },
    { role: 'textbox', name: 'Notes', value: 'x'.repeat(250) },
    { role: 'button', name: '', }, // icon-only: no accessible name
  ],
};

function snapshotFixture() {
  return {
    url: 'https://example.com/shop',
    title: 'Example Shop',
    nodes: [
      { ref: 'n1', role: 'heading', name: 'Granola bars' },
      { ref: 'n2', role: 'button', name: 'Add to cart' },
      { ref: 'n3', role: 'link', name: 'See all sizes' },
      { ref: 'n4', role: 'textbox', name: 'Search products', value: 'granola' },
      { ref: 'n5', role: 'checkbox', name: 'Subscribe', state: { checked: false } },
      { ref: 'n6', role: 'button', name: 'Save' },
      { ref: 'n7', role: 'button', name: 'Save' },
    ],
  };
}

// ---------------------------------------------------------------------------
// snapshotTree
// ---------------------------------------------------------------------------

test('snapshotTree flattens the tree in pre-order with stable refs', async () => {
  const snap = await snapshotTree(stubPage(RAW_TREE));
  assert.equal(snap.url, 'https://example.com/shop');
  assert.equal(snap.title, 'Example Shop');
  assert.equal(snap.truncated, false);
  // Root WebArea + 13 children + 1 nested generic = 15 nodes.
  assert.equal(snap.nodes.length, 15);
  assert.deepEqual(
    snap.nodes.map((n) => n.ref),
    snap.nodes.map((_, i) => 'n' + (i + 1)),
  );
  assert.equal(snap.nodes[0].role, 'WebArea');
  assert.equal(snap.nodes[1].role, 'heading');
  assert.equal(snap.nodes[1].name, 'Granola bars');
  // Nested generic node is present, in pre-order after its parent.
  const addToCart = snap.nodes.find((n) => n.name === 'Add to cart');
  const icon = snap.nodes.find((n) => n.name === 'icon');
  assert.ok(addToCart.ref < icon.ref);
  // No raw DOM/HTML leaks: no children, no html/innerText keys anywhere.
  for (const n of snap.nodes) {
    assert.equal('children' in n, false);
    assert.equal('html' in n, false);
    assert.equal('innerText' in n, false);
  }
  // Plain JSON-able.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(snap)));
});

test('snapshotTree keeps state fields only when present', async () => {
  const snap = await snapshotTree(stubPage(RAW_TREE));
  const byName = (name) => snap.nodes.find((n) => n.name === name);
  assert.deepEqual(byName('Subscribe').state, { checked: false });
  assert.deepEqual(byName('Buy now').state, { disabled: true });
  assert.deepEqual(byName('Build app').state, { expanded: false });
  assert.equal('state' in byName('Granola bars'), false);
  assert.equal('state' in byName('Add to cart'), false);
});

test('snapshotTree strips password/OTP/verification-code values', async () => {
  const snap = await snapshotTree(stubPage(RAW_TREE));
  const byName = (name) => snap.nodes.find((n) => n.name === name);
  for (const name of ['Password', 'Enter OTP', 'Verification code', 'Card password']) {
    const node = byName(name);
    assert.ok(node, name + ' node exists');
    assert.equal('value' in node, false, name + ' must carry no value');
    assert.equal(node.valueStripped, true, name + ' must record the strip');
  }
  // The secret values themselves appear nowhere in the snapshot.
  const json = JSON.stringify(snap);
  for (const secret of ['hunter2-secret', '123456', '999999', 'tok-abc']) {
    assert.equal(json.includes(secret), false, 'secret leaked: ' + secret);
  }
  // A normal textbox keeps its value.
  assert.equal(byName('Search products').value, 'granola');
  assert.equal('valueStripped' in byName('Search products'), false);
});

test('snapshotTree truncates long textbox values to 200 chars', async () => {
  assert.equal(VALUE_MAX_CHARS, 200);
  const snap = await snapshotTree(stubPage(RAW_TREE));
  const notes = snap.nodes.find((n) => n.name === 'Notes');
  assert.equal(typeof notes.value, 'string');
  assert.equal(notes.value.length, 200);
  assert.equal(notes.value, 'x'.repeat(200));
});

test('snapshotTree never carries a value on non-textbox roles', async () => {
  const raw = {
    role: 'WebArea',
    name: 't',
    children: [
      { role: 'button', name: 'Go', value: 'should-not-appear' },
      { role: 'link', name: 'Home', value: 'should-not-appear' },
    ],
  };
  const snap = await snapshotTree(stubPage(raw));
  for (const n of snap.nodes) {
    assert.equal('value' in n, false, n.role + ' must not carry a value');
  }
});

test('snapshotTree caps at 200 nodes and reports truncated', async () => {
  assert.equal(MAX_NODES, 200);
  const children = [];
  for (let i = 0; i < 250; i++) {
    children.push({ role: 'button', name: 'Size ' + (i + 1) });
  }
  const snap = await snapshotTree(stubPage({ role: 'WebArea', name: 't', children }));
  assert.equal(snap.nodes.length, 200);
  assert.equal(snap.truncated, true);
  assert.equal(snap.nodes[199].name, 'Size 199');
  // A tree of exactly 200 nodes is NOT truncated.
  const exact = await snapshotTree(stubPage({
    role: 'WebArea',
    name: 't',
    children: children.slice(0, 199),
  }));
  assert.equal(exact.nodes.length, 200);
  assert.equal(exact.truncated, false);
});

test('snapshotTree handles a null snapshot (blank page)', async () => {
  const snap = await snapshotTree(stubPage(null));
  assert.deepEqual(snap.nodes, []);
  assert.equal(snap.truncated, false);
  assert.equal(snap.url, 'https://example.com/shop');
});

// ---------------------------------------------------------------------------
// groundAction
// ---------------------------------------------------------------------------

test('groundAction returns the ref on a unique exact match', () => {
  const tree = snapshotFixture();
  assert.deepEqual(groundAction(tree, { role: 'button', name: 'Add to cart' }), { ref: 'n2' });
});

test('groundAction matches names case-insensitively and trimmed', () => {
  const tree = snapshotFixture();
  assert.deepEqual(groundAction(tree, { role: 'BUTTON', name: '  add to CART ' }), { ref: 'n2' });
});

test('groundAction falls back to substring when no exact match', () => {
  const tree = snapshotFixture();
  assert.deepEqual(groundAction(tree, { role: 'textbox', name: 'search' }), { ref: 'n4' });
  assert.deepEqual(groundAction(tree, { role: 'link', name: 'sizes' }), { ref: 'n3' });
});

test('groundAction prefers an exact match over a substring match', () => {
  const tree = {
    nodes: [
      { ref: 'n1', role: 'button', name: 'Build' },
      { ref: 'n2', role: 'button', name: 'Build app' },
    ],
  };
  // 'Build' is an exact match for n1 and a substring of n2: exact wins.
  assert.deepEqual(groundAction(tree, { role: 'button', name: 'Build' }), { ref: 'n1' });
});

test('groundAction returns not-found when nothing matches', () => {
  const tree = snapshotFixture();
  assert.deepEqual(groundAction(tree, { role: 'button', name: 'No such button' }), { error: 'not-found' });
  assert.deepEqual(groundAction(tree, { role: 'link', name: 'Add to cart' }), { error: 'not-found' });
});

test('groundAction returns unnamed when the target has no name', () => {
  const tree = snapshotFixture();
  assert.deepEqual(groundAction(tree, { role: 'button' }), { error: 'unnamed' });
  assert.deepEqual(groundAction(tree, { role: 'button', name: '   ' }), { error: 'unnamed' });
  assert.deepEqual(groundAction(tree, {}), { error: 'unnamed' });
  assert.deepEqual(groundAction(tree, null), { error: 'unnamed' });
  // The icon-only node in the tree is never returned by guessing.
  assert.deepEqual(groundAction(tree, { role: 'button', name: 'icon' }), { error: 'not-found' });
});

test('groundAction returns duplicate with candidate refs for 2+ matches', () => {
  const tree = snapshotFixture();
  assert.deepEqual(groundAction(tree, { role: 'button', name: 'Save' }), {
    error: 'duplicate',
    candidates: ['n6', 'n7'],
  });
  // Substring duplicates also report all candidates.
  const sized = {
    nodes: [
      { ref: 'n1', role: 'button', name: 'Select size 8' },
      { ref: 'n2', role: 'button', name: 'Select size 9' },
      { ref: 'n3', role: 'button', name: 'Select size 10' },
    ],
  };
  assert.deepEqual(groundAction(sized, { role: 'button', name: 'Select size' }), {
    error: 'duplicate',
    candidates: ['n1', 'n2', 'n3'],
  });
});

test('groundAction never returns coordinates or selectors', () => {
  const tree = snapshotFixture();
  const result = groundAction(tree, { role: 'button', name: 'Add to cart' });
  const json = JSON.stringify(result);
  for (const banned of ['x', 'y', 'selector', 'css', 'xpath']) {
    assert.equal(banned in result, false);
  }
  assert.equal(json.includes('n2'), true);
});

// ---------------------------------------------------------------------------
// snapshotDiff
// ---------------------------------------------------------------------------

test('snapshotDiff reports added, removed, and changed nodes', () => {
  const before = snapshotFixture();
  const after = {
    url: 'https://example.com/shop',
    title: 'Example Shop',
    nodes: [
      { ref: 'n1', role: 'heading', name: 'Granola bars' },
      { ref: 'n2', role: 'button', name: 'Add to cart' },
      { ref: 'n3', role: 'link', name: 'See all sizes' },
      // n4 textbox value changed; n5 checkbox checked flipped.
      { ref: 'n4', role: 'textbox', name: 'Search products', value: 'oats' },
      { ref: 'n5', role: 'checkbox', name: 'Subscribe', state: { checked: true } },
      { ref: 'n6', role: 'button', name: 'Save' },
      // n7 (second Save) removed; new node added.
      { ref: 'n8', role: 'button', name: 'Notify me' },
    ],
  };
  const diff = snapshotDiff(before, after);
  assert.equal(diff.truncated, false);
  assert.deepEqual(diff.added, [{ ref: 'n8', role: 'button', name: 'Notify me' }]);
  assert.deepEqual(diff.removed, ['n7']);
  assert.deepEqual(diff.changed, [
    { ref: 'n4', field: 'value', from: 'granola', to: 'oats' },
    { ref: 'n5', field: 'state.checked', from: false, to: true },
  ]);
});

test('snapshotDiff pairs duplicate (role, name) nodes in tree order', () => {
  const before = {
    nodes: [
      { ref: 'n1', role: 'button', name: 'Save' },
      { ref: 'n2', role: 'button', name: 'Save' },
    ],
  };
  const after = {
    nodes: [
      { ref: 'n1', role: 'button', name: 'Save' },
      { ref: 'n2', role: 'button', name: 'Save', state: { disabled: true } },
    ],
  };
  const diff = snapshotDiff(before, after);
  // Only the SECOND Save changed — pairing must not confuse the two.
  assert.deepEqual(diff.changed, [
    { ref: 'n2', field: 'state.disabled', from: null, to: true },
  ]);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test('snapshotDiff of identical snapshots is empty', () => {
  const snap = snapshotFixture();
  assert.deepEqual(snapshotDiff(snap, snap), {
    added: [],
    removed: [],
    changed: [],
    truncated: false,
  });
});

test('snapshotDiff caps at 20 changes total', () => {
  assert.equal(MAX_DIFF_CHANGES, 20);
  const beforeNodes = [];
  const afterNodes = [];
  for (let i = 0; i < 40; i++) {
    beforeNodes.push({ ref: 'n' + (i + 1), role: 'button', name: 'Item ' + i });
    afterNodes.push({ ref: 'n' + (i + 1), role: 'button', name: 'Item ' + i, state: { disabled: true } });
  }
  const diff = snapshotDiff({ nodes: beforeNodes }, { nodes: afterNodes });
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  assert.equal(total, 20);
  assert.equal(diff.truncated, true);
  assert.equal(diff.changed.length, 20);
});

// ---------------------------------------------------------------------------
// locatorFor (stub Playwright page — no browser)
// ---------------------------------------------------------------------------

function stubLocatorPage({ roleCounts = {}, labelCounts = {} } = {}) {
  const calls = [];
  return {
    calls,
    getByRole: (role, opts) => {
      calls.push(['getByRole', role, opts]);
      const key = role + '|' + (opts && opts.name);
      return { count: async () => (roleCounts[key] ?? 0) };
    },
    getByLabel: (name, opts) => {
      calls.push(['getByLabel', name, opts]);
      return { count: async () => (labelCounts[name] ?? 0) };
    },
  };
}

test('locatorFor resolves via getByRole with the exact accessible name', async () => {
  const tree = snapshotFixture();
  const page = stubLocatorPage({ roleCounts: { 'button|Add to cart': 1 } });
  const locator = await locatorFor(page, tree, 'n2');
  assert.ok(locator);
  assert.deepEqual(page.calls[0], ['getByRole', 'button', { name: 'Add to cart', exact: true }]);
});

test('locatorFor falls back to getByLabel when getByRole finds nothing', async () => {
  const tree = snapshotFixture();
  const page = stubLocatorPage({
    roleCounts: { 'textbox|Search products': 0 },
    labelCounts: { 'Search products': 1 },
  });
  const locator = await locatorFor(page, tree, 'n4');
  assert.ok(locator);
  assert.equal(page.calls[0][0], 'getByRole');
  assert.equal(page.calls[1][0], 'getByLabel');
});

test('locatorFor returns null when the role/name no longer resolves', async () => {
  const tree = snapshotFixture();
  const page = stubLocatorPage({ roleCounts: {}, labelCounts: {} });
  assert.equal(await locatorFor(page, tree, 'n2'), null);
});

test('locatorFor returns null for an unknown ref or an unnamed node', async () => {
  const tree = snapshotFixture();
  const page = stubLocatorPage({ roleCounts: { 'button|Add to cart': 1 } });
  assert.equal(await locatorFor(page, tree, 'n999'), null);
  const unnamedTree = { nodes: [{ ref: 'n1', role: 'button', name: '' }] };
  assert.equal(await locatorFor(page, unnamedTree, 'n1'), null);
  // No CSS selectors, coordinates, or DOM queries are ever used.
  for (const [method] of page.calls) {
    assert.ok(method === 'getByRole' || method === 'getByLabel', method);
  }
});

test('locatorFor returns null when getByRole matches more than one element', async () => {
  const tree = snapshotFixture();
  const page = stubLocatorPage({
    roleCounts: { 'button|Save': 2 },
    labelCounts: {},
  });
  assert.equal(await locatorFor(page, tree, 'n6'), null);
});

// ---------------------------------------------------------------------------
// duplicateTrialState / nextUntried
// ---------------------------------------------------------------------------

test('duplicateTrialState starts empty and nextUntried walks candidates in order', () => {
  assert.equal(MAX_DUPLICATE_TRIALS, 3);
  const state = duplicateTrialState();
  assert.deepEqual(state, { triedRefs: [] });
  const candidates = ['n1', 'n2', 'n3', 'n4', 'n5'];
  assert.equal(nextUntried(candidates, state), 'n1');
  assert.equal(nextUntried(candidates, state), 'n2');
  assert.equal(nextUntried(candidates, state), 'n3');
  assert.deepEqual(state.triedRefs, ['n1', 'n2', 'n3']);
});

test('nextUntried returns null after 3 trials even with untried candidates left', () => {
  const state = duplicateTrialState();
  const candidates = ['n1', 'n2', 'n3', 'n4', 'n5'];
  assert.equal(nextUntried(candidates, state), 'n1');
  assert.equal(nextUntried(candidates, state), 'n2');
  assert.equal(nextUntried(candidates, state), 'n3');
  // n4 and n5 were never tried, but the cap is 3 trials per (role, name).
  assert.equal(nextUntried(candidates, state), null);
  assert.equal(nextUntried(candidates, state), null);
  assert.deepEqual(state.triedRefs, ['n1', 'n2', 'n3']);
});

test('nextUntried skips refs already tried and returns null when all are tried', () => {
  const state = duplicateTrialState();
  state.triedRefs.push('n2');
  assert.equal(nextUntried(['n1', 'n2', 'n3'], state), 'n1');
  assert.equal(nextUntried(['n1', 'n2', 'n3'], state), 'n3');
  assert.equal(nextUntried(['n1', 'n2', 'n3'], state), null);
});

test('nextUntried returns null for empty candidates or a bad state', () => {
  const state = duplicateTrialState();
  assert.equal(nextUntried([], state), null);
  assert.equal(nextUntried(['n1'], null), null);
  assert.equal(nextUntried(null, state), null);
});

test('duplicateTrialState is per-target: separate states have separate caps', () => {
  const a = duplicateTrialState();
  const b = duplicateTrialState();
  nextUntried(['n1', 'n2', 'n3'], a);
  nextUntried(['n1', 'n2', 'n3'], a);
  nextUntried(['n1', 'n2', 'n3'], a);
  assert.equal(nextUntried(['n1', 'n2', 'n3'], a), null);
  assert.equal(nextUntried(['n1', 'n2', 'n3'], b), 'n1');
});
