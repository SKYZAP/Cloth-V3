import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatInvoice, formatMoney, invoiceTotals } from '../invoice.mjs'

test('totals with tax and a line discount', () => {
  const t = invoiceTotals([{ sku: 'MUG', qty: 2, unitPrice: '12.50', taxClass: 'standard', discount: 10 }, { sku: 'BOOK', qty: 1, unitPrice: '8', taxClass: 'zero' }])
  assert.deepEqual([t.subtotal, t.discount, t.tax, t.total], [3300, 250, 450, 3500])
})

test('money formats', () => {
  assert.equal(formatMoney(123450, 'GBP'), '£1,234.50')
  assert.equal(formatMoney(123450, 'EUR'), '1.234,50 €')
})

test('prints an invoice', () => {
  assert.match(formatInvoice([{ sku: 'MUG', qty: 1, unitPrice: '5', taxClass: 'standard' }]), /Total\s+£6\.00\n1 item$/)
})
