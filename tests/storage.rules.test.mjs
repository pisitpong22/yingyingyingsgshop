// Storage Security Rules tests.
//
//   npm i --no-save @firebase/rules-unit-testing firebase
//   firebase emulators:exec --only storage,firestore --project demo-rules-test \
//     "node tests/storage.rules.test.mjs"
//
// Deliberately not wired into package.json — nothing else in this repo needs
// npm to build. The rules matter enough to be testable, though: the rule these
// tests pin down is that an upload over an EXISTING path counts as `create`,
// not `update`, which is not obvious and was a live hole (anyone could replace
// any product photo at its own public URL).

import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, deleteObject, getBytes } from 'firebase/storage';
import { setDoc, doc } from 'firebase/firestore';
import fs from 'node:fs';

const rulesPath = process.argv[2] || new URL('../storage.rules', import.meta.url).pathname;
const png = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, ...new Array(60).fill(0)]);
const big = new Uint8Array(11 * 1024 * 1024);

const env = await initializeTestEnvironment({
  projectId: 'demo-rules-test',
  storage: { rules: fs.readFileSync(rulesPath, 'utf8'), host: '127.0.0.1', port: 9199 },
  firestore: { rules: 'rules_version="2";service cloud.firestore{match /databases/{db}/documents{match /{d=**}{allow read,write:if true;}}}',
               host: '127.0.0.1', port: 8080 },
});

// The team-member check reads Firestore, so seed one admin record.
await env.withSecurityRulesDisabled(async ctx => {
  await setDoc(doc(ctx.firestore(), 'admins/staff@shop.com'), { role: 'admin' });
});

const anon  = env.unauthenticatedContext().storage();
const rando = env.authenticatedContext('stranger', { email: 'stranger@gmail.com', email_verified: true }).storage();
const staff = env.authenticatedContext('staff',    { email: 'staff@shop.com',     email_verified: true }).storage();
// Registered a seeded admin email via open sign-up, but never verified it.
const unverifiedStaff = env.authenticatedContext('imposter', { email: 'staff@shop.com', email_verified: false }).storage();

// Seed existing objects the way a real upload would have created them.
await env.withSecurityRulesDisabled(async ctx => {
  await uploadBytes(ref(ctx.storage(), 'uploads/existing-product-photo.png'), png, { contentType: 'image/png' });
  await uploadBytes(ref(ctx.storage(), 'uploads/public/existing-review-photo.png'), png, { contentType: 'image/png' });
});

const results = [];
const check = async (label, want, fn) => {
  try {
    await (want === 'allow' ? assertSucceeds(fn()) : assertFails(fn()));
    results.push(['PASS', label, want]);
  } catch (e) {
    results.push(['FAIL', label, want, (e.message || '').split('\n')[0].slice(0, 90)]);
  }
};

const up = (s, path, opts) => () => uploadBytes(ref(s, path), opts?.data || png, { contentType: opts?.type || 'image/png' });

await check('customer uploads a new review photo',      'allow', up(anon, 'uploads/public/new-review-' + Date.now() + '.png'));
await check('customer uploads a non-image',             'deny',  up(anon, 'uploads/public/evil.html', { type: 'text/html' }));
await check('customer uploads 11MB',                    'deny',  up(anon, 'uploads/public/huge.png', { data: big }));
// The public corner is uploads/public/ ONLY — anonymous writes anywhere else
// under uploads/ would make the shop's bucket free file hosting.
await check('anon uploads outside uploads/public',      'deny',  up(anon, 'uploads/not-public-' + Date.now() + '.png'));
await check('anon uploads into a deeper public subdir', 'deny',  up(anon, 'uploads/public/sub/nested.png'));
await check('anon OVERWRITES an existing review photo',  'deny',  up(anon, 'uploads/public/existing-review-photo.png'));
await check('anon DELETES an existing review photo',     'deny',  () => deleteObject(ref(anon, 'uploads/public/existing-review-photo.png')));
await check('anon OVERWRITES an existing product photo', 'deny',  up(anon, 'uploads/existing-product-photo.png'));
await check('anon DELETES an existing product photo',    'deny',  () => deleteObject(ref(anon, 'uploads/existing-product-photo.png')));
await check('signed-up stranger overwrites a photo',     'deny',  up(rando, 'uploads/existing-product-photo.png'));
await check('signed-up stranger deletes a photo',        'deny',  () => deleteObject(ref(rando, 'uploads/existing-product-photo.png')));
await check('signed-up stranger uploads a .exe',         'deny',  up(rando, 'uploads/x.exe', { type: 'application/octet-stream' }));
await check('signed-up stranger uploads to public/',     'allow', up(rando, 'uploads/public/stranger-review-' + Date.now() + '.png'));
await check('STAFF uploads a new image',                 'allow', up(staff, 'uploads/staff-new-' + Date.now() + '.png'));
await check('STAFF replaces a review photo',             'allow', up(staff, 'uploads/public/existing-review-photo.png'));
await check('STAFF uploads a non-image (3D model etc.)', 'allow', up(staff, 'uploads/model.glb', { type: 'model/gltf-binary' }));
await check('STAFF replaces an existing photo',          'allow', up(staff, 'uploads/existing-product-photo.png'));
await check('STAFF deletes a photo',                     'allow', () => deleteObject(ref(staff, 'uploads/existing-product-photo.png')));
await check('UNVERIFIED-email staff writes a photo',     'deny',  up(unverifiedStaff, 'uploads/imposter.png'));
await check('UNVERIFIED-email staff replaces a photo',   'deny',  up(unverifiedStaff, 'uploads/existing-product-photo.png'));
await env.withSecurityRulesDisabled(async ctx => {   // STAFF delete above removed it
  await uploadBytes(ref(ctx.storage(), 'uploads/existing-product-photo.png'), png, { contentType: 'image/png' });
});
await check('anyone reads a photo',                      'allow', () => getBytes(ref(anon, 'uploads/existing-product-photo.png')));
await check('write outside /uploads',                    'deny',  up(anon, 'other/x.png'));

console.log('\n  ' + rulesPath);
for (const [st, label, want, err] of results) {
  console.log(`  ${st === 'PASS' ? '✓' : '✗'} [${want.padEnd(5)}] ${label}${err ? '   <- ' + err : ''}`);
}
console.log(`  ${results.filter(r => r[0] === 'PASS').length}/${results.length} as intended\n`);
await env.cleanup();
process.exit(results.some(r => r[0] === 'FAIL') ? 1 : 0);
