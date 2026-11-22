// Independent acceptance tests for the harness benchmark. Do NOT show this file to the agent.
// Usage: BENCH_DIR=<path-to-agent-project> node --test acceptance.test.mjs   (default: ./run)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const project = resolve(process.env.BENCH_DIR ?? './run')
const cli = join(project, 'reconcile.mjs')

function run(csv, stock) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'))
  writeFileSync(join(dir, 'orders.csv'), csv)
  writeFileSync(join(dir, 'stock.json'), typeof stock === 'string' ? stock : JSON.stringify(stock))
  const r = spawnSync(process.execPath, [cli, join(dir, 'orders.csv'), join(dir, 'stock.json')], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) }
}
const H = 'order_id,sku,qty,unit_price,status\n'
const STOCK = { A1: { on_hand: 10, name: 'Mug' }, B2: { on_hand: 3, name: 'Lamp, desk' }, C3: { on_hand: 0, name: 'Pen' } }

test('reconcile.mjs exists', () => assert.ok(existsSync(cli), `missing ${cli}`))

test('basic paid orders: revenue and stock', () => {
  const r = run(H + '1,A1,2,19.99,paid\n2,B2,1,45,paid\n', STOCK)
  assert.equal(r.code, 0, r.err)
  const j = r.json()
  assert.equal(j.revenue, 84.98)
  assert.deepEqual(j.stock, { A1: 8, B2: 2, C3: 0 })
  assert.deepEqual(j.oversold, [])
  assert.deepEqual(j.duplicates, [])
  assert.deepEqual(j.unknown_skus, [])
})

test('refunds add stock back and subtract revenue; cancelled is ignored', () => {
  const j = run(H + '1,A1,3,10,paid\n2,A1,1,10,refunded\n3,B2,2,99.99,cancelled\n', STOCK).json()
  assert.equal(j.revenue, 20)
  assert.equal(j.stock.A1, 8)
  assert.equal(j.stock.B2, 3)
})

test('money is exact (no float drift)', () => {
  const rows = Array.from({ length: 10 }, (_, i) => `${i + 1},A1,1,0.1,paid`).join('\n')
  const j = run(H + rows + '\n', { A1: { on_hand: 100, name: 'x' } }).json()
  assert.equal(j.revenue, 1)
  const k = run(H + '1,A1,3,1.15,paid\n', STOCK).json()
  assert.equal(k.revenue, 3.45)
})

test('oversold SKUs are listed sorted', () => {
  const j = run(H + '1,C3,1,1,paid\n2,B2,5,1,paid\n', STOCK).json()
  assert.deepEqual(j.oversold, ['B2', 'C3'])
  assert.equal(j.stock.B2, -2)
})

test('duplicate order ids: first row wins, ids reported once, sorted', () => {
  const j = run(H + '9,A1,1,5,paid\n9,A1,4,5,paid\n10,A1,1,5,paid\n10,B2,1,5,paid\n9,A1,1,5,refunded\n', STOCK).json()
  assert.deepEqual(j.duplicates, ['10', '9'].sort())
  assert.equal(j.stock.A1, 8)
  assert.equal(j.revenue, 10)
})

test('unknown SKUs are reported and do not touch revenue', () => {
  const j = run(H + '1,ZZ,1,50,paid\n2,ZZ,1,50,paid\n3,AA,1,1,refunded\n4,A1,1,2,paid\n', STOCK).json()
  assert.deepEqual(j.unknown_skus, ['AA', 'ZZ'])
  assert.equal(j.revenue, 2)
  assert.deepEqual(Object.keys(j.stock).sort(), ['A1', 'B2', 'C3'])
})

test('RFC 4180 quoting: commas and doubled quotes inside fields', () => {
  const j = run(H + '"1","A1","2","10.50","paid"\n"2,b","A1",1,"1.00",paid\n"3""x",B2,1,2,paid\n', STOCK).json()
  assert.equal(j.revenue, 24)
  assert.equal(j.stock.A1, 7)
})

test('CRLF line endings, BOM and trailing blank lines are accepted', () => {
  const j = run('﻿' + H.replace('\n', '\r\n') + '1,A1,1,5,paid\r\n2,A1,1,5,paid\r\n\r\n\r\n', STOCK).json()
  assert.equal(j.revenue, 10)
  assert.equal(j.stock.A1, 8)
})

test('header-only file is valid', () => {
  const r = run(H, STOCK)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(r.json(), { revenue: 0, stock: { A1: 10, B2: 3, C3: 0 }, oversold: [], duplicates: [], unknown_skus: [] })
})

for (const [label, row, reason] of [
  ['zero quantity', '2,A1,0,5,paid', /qty/i],
  ['fractional quantity', '2,A1,1.5,5,paid', /qty/i],
  ['negative price', '2,A1,1,-5,paid', /price/i],
  ['three decimals', '2,A1,1,1.005,paid', /price/i],
  ['unknown status', '2,A1,1,5,shipped', /status/i],
  ['wrong column count', '2,A1,1,5', /column/i]
]) {
  test(`invalid row (${label}) exits 1 with "line N:" on stderr and nothing on stdout`, () => {
    const r = run(H + '1,A1,1,5,paid\n' + row + '\n', STOCK)
    assert.equal(r.code, 1)
    assert.equal(r.out.trim(), '')
    assert.match(r.err, /line 3:/)
    assert.match(r.err, reason)
  })
}

test('invalid row is checked even when it is a duplicate or cancelled', () => {
  const r = run(H + '1,A1,1,5,paid\n1,A1,x,5,cancelled\n', STOCK)
  assert.equal(r.code, 1)
  assert.match(r.err, /line 3:/)
})

test('bad stock.json or missing file exits 1', () => {
  assert.equal(run(H, '{not json').code, 1)
  const r = spawnSync(process.execPath, [cli, 'nope.csv', 'nope.json'], { encoding: 'utf8' })
  assert.equal(r.status, 1)
})

test('wrong header exits 1 on line 1', () => {
  const r = run('id,sku,qty,unit_price,status\n1,A1,1,5,paid\n', STOCK)
  assert.equal(r.code, 1)
  assert.match(r.err, /line 1:/)
})

test('agent wrote its own tests and they pass', () => {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test', '--silent'], { cwd: project, encoding: 'utf8', shell: process.platform === 'win32' })
  assert.equal(r.status, 0, `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ?? ''}`.slice(-2000))
})
