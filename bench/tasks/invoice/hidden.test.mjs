// Hidden acceptance tests for the invoice refactor. Never shown to the agent.
// Every behaviour check compares the agent's module with reference.mjs (the original file) on the same input, so
// "unchanged" means unchanged, quirks included.
// Usage: BENCH_DIR=<the agent's project> node --test hidden.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ref from './reference.mjs'

const dir = resolve(process.env.BENCH_DIR ?? '.')
const load = async (p) => (existsSync(join(dir, p)) ? import(pathToFileURL(join(dir, p)).href) : null)
const mod = await load('invoice.mjs').catch((err) => ({ broken: err }))
const src = (p) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : null)

/** What a call gives: its value, or the error message it throws. */
const outcome = (fn) => {
  try {
    return { value: fn() }
  } catch (err) {
    return { error: String(err?.message ?? err) }
  }
}
/** invoiceTotals without the new `taxes` (compared on its own below). */
const totals = (m, lines, opts) =>
  outcome(() => {
    const { taxes, ...rest } = m.invoiceTotals(lines, opts)
    return rest
  })
const same = (name, cases, call) =>
  test(name, () => {
    assert.ok(mod && !mod.broken, `invoice.mjs did not load: ${mod?.broken?.message ?? 'missing'}`)
    for (const [i, c] of cases.entries()) assert.deepEqual(call(mod, ...c), call(ref, ...c), `case ${i + 1}: ${JSON.stringify(c)}`)
  })

const L = (sku, qty, unitPrice, taxClass, discount) => ({ sku, qty, unitPrice, taxClass, ...(discount !== undefined ? { discount } : {}) })
const basic = [L('MUG', 2, '12.50', 'standard', 10), L('BOOK', 1, '8', 'zero'), L('TEA', 3, '3.40', 'reduced')]

// ─── Structure ───────────────────────────────────────────────────────────────

test('the modules exist under src/', () => {
  for (const f of ['money', 'tax', 'coupons', 'totals', 'format']) assert.ok(existsSync(join(dir, 'src', `${f}.mjs`)), `src/${f}.mjs is missing`)
})

test('invoice.mjs only re-exports the public API', async () => {
  assert.ok(mod && !mod.broken, 'invoice.mjs did not load')
  for (const f of ['invoiceTotals', 'formatInvoice', 'formatMoney']) assert.equal(typeof mod[f], 'function', f)
  const text = src('invoice.mjs')
  assert.doesNotMatch(text, /Math\.|RATES|COUPONS|padStart|for \(/, 'invoice.mjs still holds logic')
  assert.equal(typeof (await load('src/totals.mjs'))?.invoiceTotals, 'function', 'src/totals.mjs exports invoiceTotals')
  assert.equal(typeof (await load('src/format.mjs'))?.formatInvoice, 'function', 'src/format.mjs exports formatInvoice')
})

test('no var anywhere', () => {
  for (const f of ['invoice.mjs', ...['money', 'tax', 'coupons', 'totals', 'format'].map((m) => `src/${m}.mjs`)]) {
    const text = src(f)
    if (text) assert.doesNotMatch(text.replace(/\/\/.*$/gm, ''), /\bvar\s/, `${f} uses var`)
  }
})

// ─── Totals: unchanged ───────────────────────────────────────────────────────

same('totals: tax classes, including unknown ones billed at standard', [[basic], [[L('A', 1, '10', 'std')]], [[L('A', 1, '10', '')]], [[L('A', 1, '10', undefined)]], [[L('A', 1, '10', 'REDUCED')]]], totals)

same('totals: line discounts and their rounding', [[[L('A', 1, '10.25', 'standard', 10)]], [[L('A', 3, '0.33', 'reduced', 33)]], [[L('A', 1, '10', 'standard', 100)]], [[L('A', 1, '10', 'standard', '10')]], [[L('A', 1, '0.10', 'reduced', 50)]], [[L('A', 7, '1.07', 'standard', 15)]]], totals)

same('totals: bad discounts', [[[L('A', 1, '10', 'standard', 101)]], [[L('A', 1, '10', 'standard', -1)]], [[L('A', 1, '10', 'standard', 0), L('B', 1, '5', 'zero', 150)]]], totals)

same('totals: quantities, including skipped zero lines', [[[L('A', 0, '10', 'standard')]], [[L('A', 0, 'not a price', 'standard')]], [[L('A', 0, '10', 'standard', 500), L('B', 2, '1', 'zero')]], [[L('A', -1, '10', 'standard')]], [[L('A', 1.5, '10', 'standard')]], [[{ sku: 'A', unitPrice: '1' }]], [[{ sku: 'A', qty: null, unitPrice: '1' }]], [[L('A', '2', '1', 'zero')]]], totals)

same('totals: prices', [[[L('A', 1, 12.5, 'standard')]], [[L('A', 1, 5, 'zero')]], [[L('A', 1, ' 3.40 ', 'zero')]], [[L('A', 1, '12.505', 'zero')]], [[L('A', 1, '1e3', 'zero')]], [[L('A', 1, '-1', 'zero')]], [[L('A', 1, '.5', 'zero')]], [[L('A', 1, '7.', 'zero')]], [[L('A', 1, undefined, 'zero')]]], totals)

same('totals: coupons', [[basic, { coupon: 'SAVE10' }], [[L('A', 10, '99', 'standard')], { coupon: 'SAVE10' }], [basic, { coupon: 'save10' }], [basic, { coupon: 'WELCOME5' }], [[L('A', 1, '5', 'zero')], { coupon: 'FLAT20' }], [basic, { coupon: 'FLAT20' }], [basic, { coupon: 'NOPE' }], [[L('A', 1, '0.99', 'standard', 10)], { coupon: 'SAVE10' }], [basic, { coupon: '' }]], totals)

same('totals: shipping and the free-shipping threshold', [[basic, { shipping: '4.99' }], [[L('A', 1, '50', 'zero')], { shipping: '4.99' }], [[L('A', 1, '55.56', 'zero', 10)], { shipping: '4.99' }], [[L('A', 1, '49.99', 'standard')], { shipping: 3 }], [[L('A', 1, '60', 'zero')], { shipping: '4.99', coupon: 'FLAT20' }], [basic, { shipping: '4.999' }], [basic, { shipping: undefined }]], totals)

same('totals: other inputs', [[[]], [[], { coupon: 'SAVE10', shipping: '2' }], ['nope'], [basic, null], [[L(42, 1, '1', 'zero')]]], totals)

// ─── Formatting: unchanged ───────────────────────────────────────────────────

same('formatMoney', [[0], [5], [-500], [123456789], [100000, 'EUR'], [-123450, 'EUR'], [99, 'USD'], [1000, 'JPY'], [1000, undefined]], (m, ...a) => outcome(() => m.formatMoney(...a)))

same(
  'formatInvoice',
  [[basic], [basic, { currency: 'EUR', coupon: 'save10', shipping: '4.99' }], [[L('A', 1, '60', 'zero')], { shipping: '4.99' }], [[L('LONG-SKU-NAME', 1234, '1234.56', 'standard', 5)], { currency: 'USD' }], [[L('A', 1, '5', 'standard')]], [[]], [basic, { coupon: 'NOPE' }], [basic, { currency: 'JPY' }]],
  (m, ...a) => outcome(() => m.formatInvoice(...a))
)

// ─── The feature: taxes by rate ──────────────────────────────────────────────

const taxes = (lines, opts) => mod.invoiceTotals(lines, opts).taxes

test('taxes: one entry per rate, highest first', () => {
  assert.deepEqual(taxes(basic), [
    { rate: 20, net: 2250, tax: 450 },
    { rate: 5, net: 1020, tax: 51 },
    { rate: 0, net: 800, tax: 0 }
  ])
})

test('taxes: only the rates that appear, summed across lines', () => {
  assert.deepEqual(taxes([L('A', 1, '10', 'reduced'), L('B', 2, '3.33', 'reduced', 10)]), [{ rate: 5, net: 1599, tax: 80 }])
})

test('taxes: unknown classes count at the standard rate', () => {
  assert.deepEqual(taxes([L('A', 1, '10', 'standard'), L('B', 1, '5', 'std')]), [{ rate: 20, net: 1500, tax: 300 }])
})

test('taxes: skipped lines are not counted, and coupons and shipping do not change it', () => {
  assert.deepEqual(taxes([L('A', 0, '10', 'reduced'), L('B', 1, '60', 'zero')], { coupon: 'SAVE10', shipping: '4.99' }), [{ rate: 0, net: 6000, tax: 0 }])
  assert.deepEqual(taxes([]), [])
})

test('taxes: its sums match the totals', () => {
  const t = mod.invoiceTotals(basic, { coupon: 'SAVE10' })
  assert.equal(t.taxes.reduce((n, x) => n + x.tax, 0), t.tax)
  assert.equal(t.taxes.reduce((n, x) => n + x.net, 0), t.subtotal - t.discount)
})
