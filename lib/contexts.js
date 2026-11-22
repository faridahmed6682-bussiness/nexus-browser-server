'use strict';
/**
 * lib/contexts.js — pooled Playwright browser contexts for the
 * Nexus Browser Worker.
 *
 * Caps concurrent contexts (free-tier RAM: 512 MB on Railway) and
 * refuses new work instead of crashing when memory is low. Refusing
 * is correct; crashing is not.
 *
 * Only Node built-ins (os) + the browser object passed to the
 * constructor are used. No state is persisted to disk.
 */

const os = require('os');

const ERR_TOO_MANY =
  '৪টি ব্রাউজার একসাথে চলছে — একটু পরে চেষ্টা করুন · 4 browsers already running — try again shortly';
const ERR_LOW_MEMORY =
  'মেমোরি কম — পরে আবার চেষ্টা করুন · Low memory — try again later';

class ContextPool {
  /**
   * @param {import('playwright').Browser} browser — shared Chromium instance
   * @param {{maxContexts?:number, minFreeMemMB?:number,
   *   newContextOptions?:import('playwright').BrowserContextOptions}} [opts]
   *   newContextOptions is passed through to browser.newContext() on
   *   every acquire() (e.g. { userAgent, locale, timezoneId, viewport })
   *   so pooled contexts carry the same fingerprint as one-off
   *   contexts. When omitted, behaviour is exactly as before: a
   *   1366x768 viewport and no UA/locale/timezone set.
   */
  constructor(browser, opts = {}) {
    if (!browser || typeof browser.newContext !== 'function') {
      throw new Error('ContextPool requires a Playwright Browser');
    }
    this.browser = browser;
    this.maxContexts = opts.maxContexts != null ? opts.maxContexts : 4;
    this.minFreeMemMB = opts.minFreeMemMB != null ? opts.minFreeMemMB : 150;
    this.newContextOptions =
      opts.newContextOptions && typeof opts.newContextOptions === 'object'
        ? { ...opts.newContextOptions }
        : {};
    this._active = new Set();
  }

  /**
   * Create a new tracked browser context, or throw a BN+EN error.
   * The memory guard runs BEFORE creating the context.
   * @param {import('playwright').BrowserContextOptions} [overrides]
   *   merged over the constructor's newContextOptions (overrides win),
   *   e.g. a per-task locale/timezone. Defaults to no overrides.
   * @returns {Promise<import('playwright').BrowserContext>}
   */
  async acquire(overrides) {
    if (this._active.size >= this.maxContexts) {
      throw new Error(ERR_TOO_MANY);
    }
    const freeMB = os.freemem() / (1024 * 1024);
    if (freeMB < this.minFreeMemMB) {
      throw new Error(ERR_LOW_MEMORY);
    }
    const context = await this.browser.newContext({
      viewport: { width: 1366, height: 768 },
      ...this.newContextOptions,
      ...(overrides && typeof overrides === 'object' ? overrides : {}),
    });
    this._active.add(context);
    return context;
  }

  /**
   * Close a context and untrack it. Always safe to call twice, and
   * safe to call with a context this pool never tracked.
   * @param {import('playwright').BrowserContext} context
   */
  async release(context) {
    if (!context) return;
    this._active.delete(context);
    await context.close().catch(() => {});
  }

  /** Number of contexts currently checked out. */
  activeCount() {
    return this._active.size;
  }
}

module.exports = { ContextPool };
