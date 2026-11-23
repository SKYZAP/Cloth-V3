# invoice

Invoice totals and printing for the billing service.

```js
import { invoiceTotals, formatInvoice, formatMoney } from './invoice.mjs'
invoiceTotals([{ sku: 'MUG', qty: 2, unitPrice: '12.50', taxClass: 'standard' }], { coupon: 'SAVE10', shipping: '4.99' })
```

Run the tests with `npm test`.
