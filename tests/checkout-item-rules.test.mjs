// Unit test for the two pure helpers that decide, on the server, whether an
// item may be sold and for how much: whyNotBuyable() and canonicalPrice()
// in functions/index.js.
//
// Why it loads the source as TEXT instead of importing it: functions/index.js
// calls admin.initializeApp() at module scope, so `import`ing it needs real
// GCP credentials and a network round trip. The two helpers are pure, so the
// test lifts them out of the file and evaluates them on their own. That means
// it tests the code that actually ships, not a copy — but it WILL fail loudly
// if either function is renamed or stops being self-contained, which is the
// right failure: this file is the only thing standing between a schema drift
// and a wrong card charge.
//
// Run:  node tests/checkout-item-rules.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'functions', 'index.js'), 'utf8');

function lift(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name}() not found in functions/index.js`);
  // Walk braces from the first { after the signature to find the body end.
  let i = src.indexOf('{', start);
  if (i < 0) throw new Error(`${name}() has no body`);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) throw new Error(`${name}() body is unbalanced`);
  return src.slice(start, end);
}

const sandbox = new Function(
  `${lift('whyNotBuyable')}\n${lift('canonicalPrice')}\nreturn { whyNotBuyable, canonicalPrice };`
);
const { whyNotBuyable, canonicalPrice } = sandbox();

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; }
  else { fail++; console.error(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const buyable = (label, type, item) => check(label, whyNotBuyable(type, item) === null, true);
const refused = (label, type, item) => check(label, whyNotBuyable(type, item) !== null, true);

// A product as saveProduct() writes it, on sale and ready to sell.
const product = (over = {}) => ({
  name: 'Phra Somdej',
  publishStatus: 'active',
  stockStatus: 'in_stock',
  allowCheckout: true,
  allowEnquiryOnly: false,
  price: 500,
  salePrice: null,
  ...over,
});

console.log('whyNotBuyable — products schema');
buyable('an active, in-stock product sells', 'products', product());
buyable('low_stock still sells', 'products', product({ stockStatus: 'low_stock' }));
refused('sold_out is refused', 'products', product({ stockStatus: 'sold_out' }));
refused('reserved is refused', 'products', product({ stockStatus: 'reserved' }));
refused('preorder is refused', 'products', product({ stockStatus: 'preorder' }));
refused('a draft is refused', 'products', product({ publishStatus: 'draft' }));
refused('a retired listing is refused', 'products', product({ publishStatus: 'sold_out' }));
refused('allowCheckout:false is refused', 'products', product({ allowCheckout: false }));
refused('allowEnquiryOnly is refused', 'products', product({ allowEnquiryOnly: true }));
// The regression this whole file exists for: a product carries no `status`
// field, so the old `canonical.status && …` guard let every one of these pass.
refused('REGRESSION: sold_out with no legacy `status` field', 'products', {
  name: 'Sold piece', publishStatus: 'active', stockStatus: 'sold_out',
});

console.log('whyNotBuyable — legacy amulets/accessories schema');
buyable('status:available sells', 'amulets', { name: 'x', status: 'available', price: 100 });
buyable('a missing status is treated as available', 'amulets', { name: 'x', price: 100 });
refused('status:sold is refused', 'amulets', { name: 'x', status: 'sold', price: 100 });
refused('status:reserved is refused', 'accessories', { name: 'x', status: 'reserved', price: 100 });

console.log('canonicalPrice');
check('plain price', canonicalPrice('products', product()), 500);
check('salePrice wins when set', canonicalPrice('products', product({ salePrice: 399 })), 399);
check('salePrice of 0 is ignored', canonicalPrice('products', product({ salePrice: 0 })), 500);
check('empty-string salePrice is ignored', canonicalPrice('products', product({ salePrice: '' })), 500);
check('null salePrice is ignored', canonicalPrice('products', product({ salePrice: null })), 500);
check('a numeric string salePrice still applies', canonicalPrice('products', product({ salePrice: '250' })), 250);
// Legacy items have no salePrice concept — never read one off them.
check('legacy item uses price', canonicalPrice('amulets', { price: 100, salePrice: 1 }), 100);
check('missing price is 0, not NaN', canonicalPrice('products', product({ price: undefined })), 0);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
