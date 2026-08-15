// Firestore Security Rules tests.
//
//   npm i --no-save @firebase/rules-unit-testing firebase
//   firebase emulators:exec --only firestore --project demo-rules-test \
//     "node tests/firestore.rules.test.mjs"
//
// The rule these tests exist for: `allow read` in Firestore means get AND
// list. /carts used to be `allow read: if true`, which reads like "you need
// to know the cart id" but actually let anyone query the collection and walk
// off with every cart in the shop — keyed, for signed-in customers, by their
// real Firebase uid. The guest-UUID-as-bearer-token design only works while
// `list` is off, so that is asserted here rather than left to a comment.
//
// The same get/list distinction is why /orders must stay a single
// `allow read` with a uid condition: a customer listing their OWN orders has
// to keep working, while an unfiltered dump has to fail.

import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, deleteDoc, collection, getDocs, query, where, serverTimestamp,
} from 'firebase/firestore';
import fs from 'node:fs';

const rulesPath = process.argv[2] || new URL('../firestore.rules', import.meta.url).pathname;

const env = await initializeTestEnvironment({
  projectId: 'demo-fs-rules-test',
  firestore: { rules: fs.readFileSync(rulesPath, 'utf8'), host: '127.0.0.1', port: 8080 },
});

const GUEST  = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';   // UUID v4 shape
const GUEST2 = '9c858901-8a57-4791-81fe-4c455b099bc9';
const CUSTOMER_UID = 'customer-uid-123';                 // NOT a UUID — uids never are
const OTHER_UID    = 'other-uid-456';

await env.clearFirestore();
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'admins/staff@shop.com'), { role: 'admin' });
  await setDoc(doc(db, 'app/db'), { json: '{}' });
  await setDoc(doc(db, `carts/${GUEST}`), { items: [], updatedAt: new Date() });
  await setDoc(doc(db, `carts/${CUSTOMER_UID}`), { items: [], updatedAt: new Date() });
  await setDoc(doc(db, 'orders/order-of-customer'), { uid: CUSTOMER_UID, status: 'paid', shipping: { name: 'A', phone: 'B', address: 'C' } });
  await setDoc(doc(db, 'orders/order-of-guest'), { uid: null, status: 'paid', shipping: { name: 'D', phone: 'E', address: 'F' } });
  await setDoc(doc(db, 'reviewSubmissions/sub1'), { name: 'x', anonymous: true, rating: 5, text: 'hi', imgs: [], createdAt: new Date() });
});

const anon     = env.unauthenticatedContext().firestore();
const customer = env.authenticatedContext(CUSTOMER_UID, { email: 'buyer@gmail.com', email_verified: true }).firestore();
const stranger = env.authenticatedContext(OTHER_UID,    { email: 'stranger@gmail.com', email_verified: true }).firestore();
const staff    = env.authenticatedContext('staff',      { email: 'staff@shop.com', email_verified: true }).firestore();

const results = [];
const check = async (label, want, fn) => {
  try {
    await (want === 'allow' ? assertSucceeds(fn()) : assertFails(fn()));
    results.push(['PASS', label, want]);
  } catch (e) {
    results.push(['FAIL', label, want, (e.message || '').split('\n')[0].slice(0, 90)]);
  }
};

const cart = (items = []) => ({ items, updatedAt: serverTimestamp() });

// ── /carts — the headline fix ───────────────────────────────────────────────
await check('LIST every cart in the shop (anon)',       'deny',  () => getDocs(collection(anon, 'carts')));
await check('LIST every cart in the shop (signed in)',  'deny',  () => getDocs(collection(stranger, 'carts')));
await check('LIST every cart in the shop (staff)',      'deny',  () => getDocs(collection(staff, 'carts')));
await check('guest reads its own cart by UUID',         'allow', () => getDoc(doc(anon, `carts/${GUEST}`)));
await check('guest writes its own cart by UUID',        'allow', () => setDoc(doc(anon, `carts/${GUEST}`), cart([{ type: 'products', id: 'a' }])));
await check('guest writes a brand-new UUID cart',       'allow', () => setDoc(doc(anon, `carts/${GUEST2}`), cart()));
await check("anon READS a signed-in customer's cart",   'deny',  () => getDoc(doc(anon, `carts/${CUSTOMER_UID}`)));
await check("anon WRITES a signed-in customer's cart",  'deny',  () => setDoc(doc(anon, `carts/${CUSTOMER_UID}`), cart()));
await check("stranger WRITES another user's cart",      'deny',  () => setDoc(doc(stranger, `carts/${CUSTOMER_UID}`), cart()));
await check("stranger READS another user's cart",       'deny',  () => getDoc(doc(stranger, `carts/${CUSTOMER_UID}`)));
await check('customer writes their own cart',           'allow', () => setDoc(doc(customer, `carts/${CUSTOMER_UID}`), cart()));
await check('customer reads the device guest cart',     'allow', () => getDoc(doc(customer, `carts/${GUEST}`)));   // login merge path
await check('customer clears the device guest cart',    'allow', () => setDoc(doc(customer, `carts/${GUEST}`), cart()));
await check('anon writes a non-UUID, non-uid cart id',  'deny',  () => setDoc(doc(anon, 'carts/guessable-1'), cart()));
await check('cart with 31 items',                       'deny',  () => setDoc(doc(anon, `carts/${GUEST}`), cart(Array.from({ length: 31 }, (_, i) => ({ id: i })))));
await check('cart with 30 items',                       'allow', () => setDoc(doc(anon, `carts/${GUEST}`), cart(Array.from({ length: 30 }, (_, i) => ({ id: i })))));
await check('cart carrying an extra field',             'deny',  () => setDoc(doc(anon, `carts/${GUEST}`), { items: [], updatedAt: serverTimestamp(), total: 0 }));
await check('cart with a client-chosen updatedAt',      'deny',  () => setDoc(doc(anon, `carts/${GUEST}`), { items: [], updatedAt: 'yesterday' }));

// ── /orders — get/list split must NOT break order history ───────────────────
await check('customer lists THEIR OWN orders',          'allow', () => getDocs(query(collection(customer, 'orders'), where('uid', '==', CUSTOMER_UID))));
await check('stranger lists ALL orders',                'deny',  () => getDocs(collection(stranger, 'orders')));
await check("stranger queries another customer's",      'deny',  () => getDocs(query(collection(stranger, 'orders'), where('uid', '==', CUSTOMER_UID))));
await check('anon reads any order',                     'deny',  () => getDoc(doc(anon, 'orders/order-of-customer')));
await check('anon reads a GUEST order by id',           'deny',  () => getDoc(doc(anon, 'orders/order-of-guest')));
await check('staff lists all orders',                   'allow', () => getDocs(collection(staff, 'orders')));
await check('customer writes an order (fake it)',       'deny',  () => setDoc(doc(customer, 'orders/forged'), { total: 0 }));
await check('staff writes an order',                    'deny',  () => setDoc(doc(staff, 'orders/forged2'), { total: 0 }));

// ── /admins — the privilege boundary ────────────────────────────────────────
await check('stranger makes themselves an admin',       'deny',  () => setDoc(doc(stranger, 'admins/stranger@gmail.com'), { role: 'super_admin' }));
await check('stranger reads the admin roster',          'deny',  () => getDocs(collection(stranger, 'admins')));
await check('staff reads the admin roster',             'allow', () => getDocs(collection(staff, 'admins')));
await check('staff (not super) adds an admin',          'deny',  () => setDoc(doc(staff, 'admins/new@shop.com'), { role: 'admin' }));

// ── /app — public catalogue, staff-only writes ──────────────────────────────
await check('anyone reads the site database',           'allow', () => getDoc(doc(anon, 'app/db')));
await check('stranger writes the site database',        'deny',  () => setDoc(doc(stranger, 'app/db'), { json: 'pwned' }));
await check('staff writes the site database',           'allow', () => setDoc(doc(staff, 'app/db'), { json: '{}' }));

// ── /reviewSubmissions — public input ───────────────────────────────────────
const goodReview = { name: 'Somchai', anonymous: false, rating: 5, text: 'great', imgs: [], createdAt: serverTimestamp() };
await check('anyone submits a review',                  'allow', () => setDoc(doc(anon, 'reviewSubmissions/new1'), goodReview));
await check('review backdated to jump the queue',       'deny',  () => setDoc(doc(anon, 'reviewSubmissions/new2'), { ...goodReview, createdAt: new Date(0) }));
await check('review with 7 photos',                     'deny',  () => setDoc(doc(anon, 'reviewSubmissions/new3'), { ...goodReview, imgs: Array(7).fill('u') }));
await check('review with a 2001-char body',             'deny',  () => setDoc(doc(anon, 'reviewSubmissions/new4'), { ...goodReview, text: 'x'.repeat(2001) }));
await check('review with rating 9',                     'deny',  () => setDoc(doc(anon, 'reviewSubmissions/new5'), { ...goodReview, rating: 9 }));
await check('anon READS pending submissions',           'deny',  () => getDocs(collection(anon, 'reviewSubmissions')));
await check('stranger READS pending submissions',       'deny',  () => getDocs(collection(stranger, 'reviewSubmissions')));
await check('staff reads pending submissions',          'allow', () => getDocs(collection(staff, 'reviewSubmissions')));
await check('anon deletes a submission',                'deny',  () => deleteDoc(doc(anon, 'reviewSubmissions/sub1')));
await check('staff deletes a submission',               'allow', () => deleteDoc(doc(staff, 'reviewSubmissions/sub1')));

console.log('\n  ' + rulesPath);
for (const [st, label, want, err] of results) {
  console.log(`  ${st === 'PASS' ? '✓' : '✗'} [${want.padEnd(5)}] ${label}${err ? '   <- ' + err : ''}`);
}
console.log(`  ${results.filter(r => r[0] === 'PASS').length}/${results.length} as intended\n`);
await env.cleanup();
process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
