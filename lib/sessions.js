'use strict';
/**
 * lib/sessions.js — per-request session cookie handling for the
 * Nexus Browser Worker.
 *
 * HARD RULE: session cookies are NEVER persisted on the server disk.
 * They arrive per-request from the phone (where they are stored
 * encrypted), are applied to a fresh browser context, and the updated
 * cookies are returned in the response. The server keeps nothing after
 * the context closes.
 *
 * Cookie values are never logged anywhere in this module.
 */

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isValidCookie(c) {
  if (!c || typeof c !== 'object') return false;
  if (!isNonEmptyString(c.name)) return false;
  if (!isNonEmptyString(c.value)) return false;
  if (!isNonEmptyString(c.domain)) return false;
  if (c.path !== undefined && typeof c.path !== 'string') return false;
  if (c.expires !== undefined && typeof c.expires !== 'number') return false;
  return true;
}

/**
 * Apply cookies to a fresh Playwright browser context.
 * @param {import('playwright').BrowserContext} context
 * @param {Array<{name:string,value:string,domain:string,path?:string,expires?:number}>} cookies
 * @returns {Promise<{applied:number, skipped:number}>}
 */
async function applyCookies(context, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { applied: 0, skipped: 0 };
  }
  const valid = [];
  let skipped = 0;
  for (const c of cookies) {
    if (isValidCookie(c)) {
      const entry = { name: c.name, value: c.value, domain: c.domain };
      if (typeof c.path === 'string' && c.path.length > 0) entry.path = c.path;
      if (typeof c.expires === 'number') entry.expires = c.expires;
      valid.push(entry);
    } else {
      skipped += 1; // invalid entries are skipped silently (never logged)
    }
  }
  if (valid.length > 0) {
    await context.addCookies(valid);
  }
  return { applied: valid.length, skipped };
}

/**
 * Harvest the context's current cookies into the minimal wire shape.
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<Array<{name:string,value:string,domain:string,path:string,expires:number}>>}
 */
async function harvestCookies(context) {
  const all = await context.cookies();
  return all.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
  }));
}

module.exports = { applyCookies, harvestCookies };
