// Invoice totals and printing. Used by the billing service and the monthly statements job.
// Money is kept in integer minor units (cents/pence) internally.

const RATES = { standard: 20, reduced: 5, zero: 0 }
const CURRENCIES = { GBP: { symbol: '£', before: true, group: ',', dec: '.' }, USD: { symbol: '$', before: true, group: ',', dec: '.' }, EUR: { symbol: '€', before: false, group: '.', dec: ',' } }
const COUPONS = { SAVE10: { pct: 10, cap: 5000 }, WELCOME5: { pct: 5, cap: 1000 }, FLAT20: { flat: 2000 } }

function toMinor(price, n) {
  if (typeof price === 'number') price = String(price)
  if (typeof price !== 'string' || !/^\d+(\.\d{1,2})?$/.test(price.trim())) throw new Error(`line ${n}: bad unitPrice ${JSON.stringify(price)}`)
  var parts = price.trim().split('.')
  var frac = (parts[1] || '').padEnd(2, '0')
  return Number(parts[0]) * 100 + Number(frac)
}

export function invoiceTotals(lines, opts) {
  opts = opts || {}
  if (!Array.isArray(lines)) throw new Error('lines must be an array')
  var subtotal = 0, discount = 0, tax = 0, count = 0, rows = []
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i], n = i + 1
    if (l.qty === undefined || l.qty === null) throw new Error(`line ${n}: qty is required`)
    if (!Number.isInteger(l.qty) || l.qty < 0) throw new Error(`line ${n}: qty must be >= 0`)
    if (l.qty === 0) continue // zero lines are skipped (statements job sends them)
    var unit = toMinor(l.unitPrice, n)
    var net = unit * l.qty
    var pct = l.discount || 0
    if (pct < 0 || pct > 100) throw new Error(`line ${n}: discount must be 0-100`)
    var d = Math.round(net * pct / 100)
    // unknown tax classes are billed at the standard rate (legacy data has 'std' and '')
    var rate = RATES[l.taxClass] !== undefined ? RATES[l.taxClass] : RATES.standard
    var t = Math.round((net - d) * rate / 100)
    subtotal += net
    discount += d
    tax += t
    count += l.qty
    rows.push({ sku: String(l.sku), qty: l.qty, unit: unit, net: net - d, tax: t })
  }
  var coupon = 0
  if (opts.coupon) {
    var c = COUPONS[String(opts.coupon).toUpperCase()]
    if (!c) throw new Error(`unknown coupon ${opts.coupon}`)
    var base = subtotal - discount
    if (c.flat) coupon = Math.min(c.flat, base)
    else coupon = Math.min(Math.floor(base * c.pct / 100), c.cap)
  }
  // the coupon comes off after tax: tax is charged on the pre-coupon amount
  var total = subtotal - discount + tax - coupon
  if (opts.shipping !== undefined) {
    var ship = toMinor(opts.shipping, 'shipping')
    // free shipping from 50.00 after line discounts (before the coupon)
    if (subtotal - discount >= 5000) ship = 0
    total += ship
  } else ship = 0
  return { subtotal: subtotal, discount: discount, coupon: coupon, tax: tax, shipping: ship, total: total, items: count, rows: rows }
}

export function formatMoney(minor, currency) {
  var cur = CURRENCIES[currency || 'GBP']
  if (!cur) throw new Error(`unknown currency ${currency}`)
  var neg = minor < 0
  var abs = Math.abs(minor)
  var whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, cur.group)
  var s = whole + cur.dec + String(abs % 100).padStart(2, '0')
  s = cur.before ? cur.symbol + s : s + ' ' + cur.symbol
  return neg ? '-' + s : s
}

export function formatInvoice(lines, opts) {
  opts = opts || {}
  var t = invoiceTotals(lines, opts)
  var cur = opts.currency
  var out = []
  for (var r of t.rows) out.push(`${r.sku.padEnd(10)} ${String(r.qty).padStart(4)} x ${formatMoney(r.unit, cur).padStart(10)} = ${formatMoney(r.net, cur).padStart(11)}`)
  out.push('-'.repeat(42))
  var label = (s, v) => out.push(`${s.padEnd(29)}${formatMoney(v, cur).padStart(13)}`)
  label('Subtotal', t.subtotal)
  if (t.discount) label('Line discounts', -t.discount)
  label('Tax', t.tax)
  if (t.coupon) label(`Coupon ${String(opts.coupon).toUpperCase()}`, -t.coupon)
  if (opts.shipping !== undefined) label(t.shipping ? 'Shipping' : 'Shipping (free)', t.shipping)
  label('Total', t.total)
  out.push(`${t.items} item${t.items === 1 ? '' : 's'}`)
  return out.join('\n')
}
