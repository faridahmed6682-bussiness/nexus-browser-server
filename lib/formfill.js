'use strict';
/**
 * Form-fill module for the Nexus browser-worker server.
 *
 * fillForm(page, fields, opts) fills a web form field-by-field, locating
 * each input by selector, label text, name attribute, or placeholder —
 * in that order — and returns which fields were filled and which could
 * not be found.
 *
 * Safety rules (do not weaken these):
 *  - Password fields are NEVER filled unless the field explicitly has
 *    name/type "password" AND the caller passed allowPassword: true.
 *    Otherwise fillForm throws an Error naming the field.
 *  - Field VALUES are never logged anywhere in this module.
 *  - Payments are NEVER auto-submitted by this module. If opts.submit is
 *    true and the page contains a payment/card field, the submit is
 *    refused unless the caller passed checkoutApproved: true — and even
 *    then this module only fills and presses Enter / clicks a non-pay
 *    submit button; it NEVER clicks a button whose label means "pay".
 *
 * Human-like typing: if a stealth helper module is present next to this
 * file (./stealth, exporting humanType(page, locator, value) or
 * typeHumanly(page, locator, value)), it is used; otherwise the module
 * falls back to Playwright's page.fill. The require is defensive — a
 * missing stealth module is normal and silent.
 *
 * Contract:
 *   fillForm(page, fields, { submit = false, allowPassword = false,
 *                            checkoutApproved = false,
 *                            confirmBeforeSubmit = false })
 *     fields: [{ label?, name?, placeholder?, selector?, type?, value }]
 *     -> { filledCount, notFound: [identifiers], url, filledValues,
 *          submitDeferred }
 *     throws on a password field without allowPassword, or on a payment
 *     page submit without checkoutApproved.
 *
 * Loop-build additions (2026-11-24, Worker C — everything above is
 * unchanged; only these were added):
 *  - Fields are filled in LABEL ORDER: the caller's fields are sorted
 *    by label (falling back to name, then placeholder, then selector)
 *    before filling, so multi-field forms are filled deterministically.
 *  - The result includes filledValues: [{ label, value }] with the
 *    value actually filled — EXCEPT password fields, whose value is
 *    reported as '[hidden]', never the real value. Field values are
 *    never logged anywhere in this module.
 *  - Option confirmBeforeSubmit (default false): when true and submit
 *    is requested, all fields are filled but the form is NOT submitted;
 *    the result carries submitDeferred: true so the caller can show
 *    the filled values to the user first.
 *  - The payment guard still runs up-front, exactly as before, for
 *    any submit that WILL happen now — EXCEPT a deferred fill
 *    (confirmBeforeSubmit: true), which submits nothing: the fill is
 *    allowed so the user can review the filled values first, and the
 *    actual submit still requires checkoutApproved when the user
 *    confirms. Coordinator decision (2026-11-24): the guard's purpose
 *    is to stop submission without approval, not to stop filling for
 *    review — blocking the fill would make review-before-submit
 *    impossible for exactly the forms that need review most.
 *
 * Only Node built-ins + the Playwright `page` object passed in.
 * No new dependencies.
 */

const FIELD_TIMEOUT_MS = 3000;
const NAV_WAIT_MS = 5000;

// Accessible-name pattern for a generic submit button (pay excluded here
// on purpose — see the payment guard in maybeSubmit()).
const SUBMIT_BUTTON_RE = /submit|log ?in|sign ?in|continue|next|send|search|save/i;
const PAY_BUTTON_RE = /pay|checkout|place order|confirm (payment|purchase|order)/i;

// Locators that indicate a payment / card form is present on the page.
const PAYMENT_FIELD_SELECTORS = [
  'input[autocomplete="cc-number"]',
  'input[autocomplete="cc-exp"]',
  'input[autocomplete="cc-csc"]',
  'input[autocomplete="cc-name"]',
  'input[name*="card" i]',
  'input[name*="cc-" i]',
  'input[name*="cvv" i]',
  'input[name*="cvc" i]',
  'input[placeholder*="card number" i]',
  'input[placeholder*="card no" i]',
  'input[data-stripe="number"]',
  'iframe[title*="card" i]',
  'iframe[name*="card" i]',
];

// ---------------------------------------------------------------------------
// Optional stealth helper (defensive require — absence is fine).
// ---------------------------------------------------------------------------
let stealth = null;
try {
  // eslint-disable-next-line global-require
  stealth = require('./stealth');
} catch (err) {
  stealth = null;
}

function humanType(page, locator, value) {
  if (stealth) {
    if (typeof stealth.humanType === 'function') return stealth.humanType(page, locator, value);
    if (typeof stealth.typeHumanly === 'function') return stealth.typeHumanly(page, locator, value);
  }
  return null; // caller falls back to page.fill
}

// ---------------------------------------------------------------------------
// Field location + identification helpers.
// ---------------------------------------------------------------------------
function fieldId(field) {
  return field.label || field.name || field.placeholder || field.selector || '(unknown field)';
}

function isPasswordField(field) {
  if (field.type && String(field.type).toLowerCase() === 'password') return true;
  if (field.name && /pass(word)?/i.test(String(field.name))) return true;
  return false;
}

function escapeAttr(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Deterministic fill order: sort the caller's fields by label (falling
// back to name, then placeholder, then selector) before filling, so a
// multi-field form is always filled in the same order regardless of the
// order the caller listed the fields in.
// ---------------------------------------------------------------------------
function sortKey(field) {
  if (!field || typeof field !== 'object') return '';
  return String(field.label || field.name || field.placeholder || field.selector || '').toLowerCase();
}

function compareFields(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return 0;
}

/**
 * Locate one field. Returns a Locator, or null if nothing matches.
 * Tries, in order: explicit selector, label text, name attribute,
 * placeholder text. Each candidate gets a short wait so a slow-rendering
 * form does not produce false "not found" results.
 */
async function locateField(page, field) {
  const candidates = [];
  if (field.selector) candidates.push(page.locator(field.selector));
  if (field.label) candidates.push(page.getByLabel(field.label, { exact: false }));
  if (field.name) candidates.push(page.locator('[name="' + escapeAttr(field.name) + '"]'));
  if (field.placeholder) candidates.push(page.getByPlaceholder(field.placeholder, { exact: false }));

  for (const locator of candidates) {
    try {
      await locator.first().waitFor({ state: 'attached', timeout: FIELD_TIMEOUT_MS });
      if ((await locator.count()) > 0) return locator.first();
    } catch (err) {
      // Candidate did not appear — try the next locator strategy.
    }
  }
  return null;
}

async function isPasswordInput(locator) {
  try {
    const type = await locator.evaluate((el) => (el && el.type ? String(el.type).toLowerCase() : ''));
    return type === 'password';
  } catch (err) {
    return false;
  }
}

async function fillOne(page, locator, field) {
  const value = field.value == null ? '' : String(field.value);
  const tag = await locator.evaluate((el) => ({
    tag: el.tagName,
    type: (el.type || '').toLowerCase(),
    inputType: el.tagName === 'INPUT' ? (el.type || 'text').toLowerCase() : null,
  })).catch(() => ({ tag: 'INPUT', type: 'text', inputType: 'text' }));

  if (tag.tag === 'SELECT') {
    try {
      await locator.selectOption(value);
    } catch (err) {
      await locator.selectOption({ label: value });
    }
    return;
  }

  if (tag.tag === 'INPUT' && (tag.inputType === 'checkbox' || tag.inputType === 'radio')) {
    const truthy = /^(true|1|yes|on|checked)$/i.test(value.trim());
    if (truthy) await locator.check({ force: true });
    else await locator.uncheck({ force: true });
    return;
  }

  // Text-like input / textarea: human-like typing when available,
  // otherwise Playwright fill (clear + type, dispatches real input events).
  // A throwing stealth helper is treated like an absent one — the fill
  // fallback must always run (coordinator fix: fillOne used to let a
  // stealth throw escape, so a locator without boundingBox broke the
  // whole fill instead of falling back).
  let typed = null;
  try {
    typed = await humanType(page, locator, value);
  } catch (err) {
    typed = null;
  }
  if (typed === null || typed === undefined) {
    await locator.fill(value);
  }
}

// ---------------------------------------------------------------------------
// Payment guard for submits.
// ---------------------------------------------------------------------------
async function pageHasPaymentField(page) {
  for (const selector of PAYMENT_FIELD_SELECTORS) {
    try {
      if ((await page.locator(selector).count()) > 0) return true;
    } catch (err) {
      // Selector unsupported on this page — keep checking the rest.
    }
  }
  return false;
}

/**
 * Submit the form, if requested. Returns nothing; throws if the payment
 * guard refuses. Never clicks a pay/checkout button: on a payment page
 * (checkoutApproved) it presses Enter in the last field instead.
 */
async function maybeSubmit(page, lastLocator) {
  const hasPayment = await pageHasPaymentField(page);
  if (hasPayment) {
    // The integrator's /api/fill endpoint must already have refused this
    // submit without checkoutApproved; this is the second line of defence.
    // Even with approval, only fill + Enter — never click a pay button.
    if (lastLocator) {
      await lastLocator.press('Enter').catch(() => {});
    }
    await page.waitForLoadState('load', { timeout: NAV_WAIT_MS }).catch(() => {});
    return;
  }

  // Non-payment page: prefer a real submit button, fall back to Enter.
  let clicked = false;
  const submitBtn = page.locator('button[type="submit"]').first();
  try {
    await submitBtn.waitFor({ state: 'visible', timeout: 2000 });
    if ((await submitBtn.count()) > 0) {
      const name = await submitBtn.evaluate((el) => (el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).catch(() => '');
      if (!PAY_BUTTON_RE.test(name)) {
        await submitBtn.click().catch(() => {});
        clicked = true;
      }
    }
  } catch (err) {
    // No visible type=submit button — fall through to the role lookup.
  }

  if (!clicked) {
    const roleBtn = page.getByRole('button', { name: SUBMIT_BUTTON_RE }).first();
    try {
      await roleBtn.waitFor({ state: 'visible', timeout: 2000 });
      if ((await roleBtn.count()) > 0) {
        const name = await roleBtn.evaluate((el) => (el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).catch(() => '');
        if (!PAY_BUTTON_RE.test(name)) {
          await roleBtn.click().catch(() => {});
          clicked = true;
        }
      }
    } catch (err) {
      // No matching button — fall through to Enter.
    }
  }

  if (!clicked && lastLocator) {
    await lastLocator.press('Enter').catch(() => {});
  }

  // Up to 5s for navigation after submitting; a page that stays put
  // (SPA / validation error) is not an error — just report the final URL.
  await page.waitForLoadState('load', { timeout: NAV_WAIT_MS }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------
/**
 * Fill a form on `page`.
 *
 * @param {object} page - a Playwright Page (already navigated to the form)
 * @param {Array} fields - [{ label?, name?, placeholder?, selector?, type?, value }]
 * @param {object} [opts]
 * @param {boolean} [opts.submit=false] - submit after filling
 * @param {boolean} [opts.allowPassword=false] - required to fill password fields
 * @param {boolean} [opts.checkoutApproved=false] - required to submit a
 *        page that contains payment/card fields (and even then, no pay
 *        button is ever clicked)
 * @param {boolean} [opts.confirmBeforeSubmit=false] - when true and
 *        submit is requested, fill all fields but DO NOT submit;
 *        the result carries submitDeferred: true so the caller can
 *        show the filled values to the user first
 * @returns {Promise<{filledCount:number, notFound:string[], url:string,
 *   filledValues:{label:string, value:string}[], submitDeferred:boolean}>}
 *   filledValues lists the value actually filled per field, in label
 *   order — password fields report '[hidden]' instead of their value.
 */
async function fillForm(page, fields, opts) {
  if (!page || typeof page.locator !== 'function') {
    throw new TypeError('fillForm requires a Playwright page');
  }
  if (!Array.isArray(fields)) {
    throw new TypeError('fillForm requires fields to be an array');
  }
  const options = opts || {};
  const submit = Boolean(options.submit);
  const allowPassword = Boolean(options.allowPassword);
  const checkoutApproved = Boolean(options.checkoutApproved);
  const confirmBeforeSubmit = Boolean(options.confirmBeforeSubmit);
  // True only when a submit was requested AND deferred for user review.
  const submitDeferred = submit && confirmBeforeSubmit;

  // Payment guard, checked BEFORE any submit attempt: the endpoint must
  // refuse the whole request when a payment page is submitted without
  // explicit checkout approval. Checked up-front so the caller gets a
  // clear refusal instead of a half-filled form. Scoped to submits
  // that will happen NOW (submitDeferred fills submit nothing — the
  // user reviews first and the submit still needs checkoutApproved
  // at confirm time; see the header note).
  if (submit && !submitDeferred && !checkoutApproved && (await pageHasPaymentField(page))) {
    throw new Error('refusing to submit a page containing payment/card fields without checkoutApproved:true');
  }

  // Fill in LABEL ORDER (deterministic): sort a copy; the caller's
  // array is never mutated.
  const orderedFields = [...fields].sort(compareFields);

  let filledCount = 0;
  const notFound = [];
  const filledValues = [];
  let lastLocator = null;

  for (const field of orderedFields) {
    if (!field || typeof field !== 'object') {
      notFound.push('(invalid field entry)');
      continue;
    }
    const id = fieldId(field);

    // Password guard: refuse unless the field explicitly declares itself
    // a password field AND the caller opted in. (A field that merely
    // looks password-like by name is treated the same way.)
    if (isPasswordField(field) && !allowPassword) {
      throw new Error('refusing to fill password field "' + id + '" without allowPassword:true');
    }

    const locator = await locateField(page, field);
    if (!locator) {
      notFound.push(id);
      continue;
    }

    // Second password check on the real element: a field the caller did
    // not declare as a password may still be <input type="password">.
    // Remember the outcome: it decides whether the summary hides the
    // filled value below (the value itself is never logged).
    const elementIsPassword = await isPasswordInput(locator);
    if (!allowPassword && elementIsPassword) {
      throw new Error('refusing to fill password field "' + id + '" without allowPassword:true');
    }

    await fillOne(page, locator, field);
    filledCount += 1;
    // Summary of what was actually filled, in label order. Password
    // fields report '[hidden]' — never the real value.
    filledValues.push({
      label: id,
      value: isPasswordField(field) || elementIsPassword ? '[hidden]' : field.value == null ? '' : String(field.value),
    });
    lastLocator = locator;
  }

  // Deferred submit: fill only, never submit — the caller shows the
  // filled values to the user first. (maybeSubmit is not called, so no
  // button is clicked and no Enter is pressed.)
  if (submit && !submitDeferred) {
    await maybeSubmit(page, lastLocator);
  }

  return { filledCount, notFound, url: page.url(), filledValues, submitDeferred };
}

module.exports = { fillForm };
