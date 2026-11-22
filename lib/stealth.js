'use strict';
/**
 * Stealth + human-like interaction helpers for the Nexus browser worker.
 *
 * Purpose: make Playwright-driven pages look like a real desktop Chrome
 * user (Chrome 120 on Windows 10, en-US, Asia/Dhaka) and move/type the
 * way a person does, so ordinary bot checks and behaviour heuristics
 * are less likely to flag the session.
 *
 * Safety: every page-side tweak is wrapped in its own try/catch, both
 * here and inside the init script, so applyStealth() never throws when
 * a property is read-only, frozen, or missing on a given page.
 * No new dependencies — plain Playwright + Node only.
 */

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1366, height: 768 };
const LOCALE = 'en-US';
const TIMEZONE_ID = 'Asia/Dhaka';

/**
 * Make a Playwright page look like a real desktop Chrome user.
 * Sets the user agent, viewport, locale and timezone on the page's
 * context where possible, then installs an init script (runs before
 * page scripts on every navigation) that hides navigator.webdriver
 * and supplies plausible navigator.plugins / navigator.languages.
 *
 * No-op-safe: each step is individually try/catch-guarded and the
 * function never throws, so a caller can safely await it on any page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
async function applyStealth(page) {
  // User agent / viewport / locale / timezone live on the browser
  // context, not the page — the reliable route is newContext({
  // userAgent, viewport, locale, timezoneId }) at context creation
  // (see /tmp/stealth-screenshot-integration.md for the exact
  // options). Here we apply what a live page still allows: viewport
  // + init script.
  try {
    await page.setViewportSize(VIEWPORT);
  } catch (_) { /* viewport may be fixed by the embedder — ignore */ }

  try {
    await page.addInitScript(() => {
      // Runs before any page script on every navigation. Each tweak
      // is guarded so a read-only / frozen property can never break
      // the page (or this script).
      try {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
          configurable: true,
        });
      } catch (_) { /* webdriver already non-configurable — ignore */ }

      try {
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
          configurable: true,
        });
      } catch (_) { /* ignore */ }

      try {
        Object.defineProperty(navigator, 'language', {
          get: () => 'en-US',
          configurable: true,
        });
      } catch (_) { /* ignore */ }

      try {
        // A plausible plugin list (Chrome ships PDF Viewer + friends).
        // Plugin objects must look array-like; a minimal fake that
        // satisfies `navigator.plugins.length` checks is enough for
        // the common `plugins.length === 0` bot heuristic.
        const fakePlugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        fakePlugins.forEach((p, i) => {
          try { Object.defineProperty(fakePlugins, i, { value: p, enumerable: false }); } catch (_) {}
        });
        Object.defineProperty(navigator, 'plugins', {
          get: () => fakePlugins,
          configurable: true,
        });
      } catch (_) { /* ignore */ }

      try {
        // Extra fingerprints bots commonly check: a real Chrome has
        // `window.chrome` and a non-empty hardwareConcurrency.
        if (!window.chrome) {
          Object.defineProperty(window, 'chrome', {
            value: { runtime: {} },
            configurable: true,
          });
        }
      } catch (_) { /* ignore */ }
    });
  } catch (_) { /* addInitScript failed (page closing?) — ignore */ }

  // Best-effort: also hide webdriver on the already-loaded document,
  // in case the init script ran after some page script. Same guards.
  try {
    await page.evaluate(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
          configurable: true,
        });
      } catch (_) { /* ignore */ }
    }).catch(() => {});
  } catch (_) { /* evaluate failed — ignore */ }
}

/**
 * Promise-based sleep with a uniform random duration in [minMs, maxMs].
 * @param {number} minMs
 * @param {number} maxMs
 * @returns {Promise<void>}
 */
function randomDelay(minMs, maxMs) {
  const min = Math.max(0, Math.floor(minMs));
  const max = Math.max(min, Math.floor(maxMs));
  const ms = min + Math.random() * (max - min);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Move the mouse to (x, y) in 5-10 small steps with random jitter
 * and 15-40ms pauses between steps, like a human hand.
 * @param {import('playwright').Page} page
 * @param {number} x target x (CSS px)
 * @param {number} y target y (CSS px)
 * @returns {Promise<void>}
 */
async function humanMouse(page, x, y) {
  const steps = 5 + Math.floor(Math.random() * 6); // 5..10
  // Start from the mouse's current position if we can read it, else (0,0).
  let startX = 0;
  let startY = 0;
  try {
    // Playwright does not expose the cursor position; track it cheaply
    // via the last known position stored on the page object instead.
    if (typeof page.__nexusMouseX === 'number') startX = page.__nexusMouseX;
    if (typeof page.__nexusMouseY === 'number') startY = page.__nexusMouseY;
  } catch (_) { /* ignore */ }

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Ease slightly toward the target, with jitter that shrinks as we
    // approach (humans wobble most mid-move, least on arrival).
    const jitterScale = i === steps ? 0 : 6 * (1 - t) + 1;
    const jx = (Math.random() - 0.5) * 2 * jitterScale;
    const jy = (Math.random() - 0.5) * 2 * jitterScale;
    const cx = startX + (x - startX) * t + jx;
    const cy = startY + (y - startY) * t + jy;
    await page.mouse.move(cx, cy);
    if (i < steps) await randomDelay(15, 40);
  }
  // Land exactly on the target (no jitter on the final position).
  await page.mouse.move(x, y);
  page.__nexusMouseX = x;
  page.__nexusMouseY = y;
}

/**
 * Type text character by character with random 40-120ms delays,
 * clicking the field first (via humanMouse to its centre) so focus
 * and real input events behave like a human typing.
 *
 * @param {import('playwright').Page} page
 * @param {string|import('playwright').Locator} selectorOrLocator
 *        CSS selector string, or a Playwright Locator.
 * @param {string} text
 * @returns {Promise<void>}
 */
async function humanType(page, selectorOrLocator, text) {
  const locator =
    typeof selectorOrLocator === 'string'
      ? page.locator(selectorOrLocator)
      : selectorOrLocator;
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  const box = await locator.boundingBox();
  if (box) {
    await humanMouse(page, box.x + box.width / 2, box.y + box.height / 2);
  }
  await locator.click({ timeout: 15000 });
  // Clear existing content first (triple-click select-all + backspace
  // is closer to human behaviour than fill()).
  await page.keyboard.press('ControlOrMeta+a').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  const str = String(text == null ? '' : text);
  for (const ch of str) {
    await page.keyboard.type(ch, { delay: 0 });
    await randomDelay(40, 120);
  }
}

module.exports = {
  applyStealth,
  humanMouse,
  humanType,
  randomDelay,
  // Exported for the integrator so context creation can match the
  // same fingerprint without duplicating constants.
  DESKTOP_USER_AGENT,
  VIEWPORT,
  LOCALE,
  TIMEZONE_ID,
};
