# Handoff — yingyingyingsgshop

Written 14 Aug 2026. Lives in `.claude/` so Firebase Hosting never serves it
(the `**/.*` ignore rule covers it).

---

## The project

A live Thai amulet shop taking real card payments.

- **Entity:** YINGYINGYINGSG PTE. LTD., Singapore, UEN `202433708R`
- **Live:** https://yingyingyingsgshop.web.app
- **Contact:** yingyingyingamulet@gmail.com
- **Stack:** static site on Firebase Hosting + Firestore + Cloud Functions (Stripe)
- **Currency:** SGD. Ships Thailand → Singapore/Malaysia, flat S$6.

### Files that matter

| File | What |
|---|---|
| `index.html` | Entire storefront — 595 KB, HTML+CSS+JS in one file, hash routing (`/#shop`) |
| `admin.html` | Entire admin panel — 520 KB, single file, login-gated |
| `firebase-shared.js` | `window.FB` API shared by both |
| `functions/index.js` | Stripe checkout. Verifies prices server-side against Firestore |
| `privacy/terms/refunds/shipping.html` + `legal.css` | Policy pages (static, real URLs) |

### Things that will bite you

- **`main` auto-deploys to production.** `.github/workflows/firebase-hosting-merge.yml`
  runs `firebase deploy --only hosting` on every push to `main`. There is no
  staging. Branch + PR if you want a preview URL first.
- **Hosting serves the repo root** (`"public": "."`). Any new file becomes
  publicly fetchable unless it matches the `ignore` list in `firebase.json`.
  After adding a file, actually curl it in production — do not assume.
- **`**/.*` does not do what it looks like.** It matches dot-*files*
  (`.gitignore`, `.firebaserc` → 404) but **not files inside dot-directories**.
  `.github/workflows/` and `.claude/` were being served until `**/.*/**` was
  added. Both patterns are needed.
- **App Check + reCAPTCHA fails on localhost and in automated browsers.**
  Expect `appCheck/recaptcha-error` in the console when testing locally — it is
  not a real failure. It also means the local preview cannot read Firestore, so
  admin panels render empty. Stub `window.getDB` to test rendering (see below).
- **Local preview:** `.claude/launch.json` defines `static-site` →
  `python3 -m http.server 8791`. Use the preview tools, not Bash.
- **Browser caching during local testing** is aggressive; append `?v=N` when
  verifying edits. Production too — a plain reload of
  `https://yingyingyingsgshop.web.app/` served the previous deploy's HTML during
  testing. Add `?cb=N` before believing a production check.
- **The storefront can be driven headlessly** for checks like this: stub
  `window.FB.getDB = () => fixture`, then call `renderShop('all')`,
  `renderP()`, `renderCasingTypes()`, `renderReviews()`, `openProd(type,id)`,
  `openProject(id)` (async — await it), `openVariant(typeId,varId)`,
  `openLightbox(i)`. Casing *variants* are lazy-loaded, so `casingTypes[].variants`
  is empty in the DB object until `openCasingType()` has run.
- **The storefront IS bilingual** (an earlier version of this file said
  otherwise — it is wrong). `toggleLang()` and a TH button in the feed header;
  `window.lang` is a getter derived from `body.classList.contains('th')`, so
  every consumer stays current without being notified. But it only localises
  text built at *render* time from `lang === 'th'` — there is no global
  `data-en`/`data-th` applier, so static markup carrying those attributes is
  inert outside `#reviewModal`. The *admin* is properly bilingual via
  `data-en`/`data-th` + `applyLang()`.
- **Never write `?.` or `??` in `index.html`.** See "Old phones saw a blank
  screen" below. One character of ES2020 anywhere in the main `<script>`
  discards the whole block on an old phone, and the whole site with it.

### Testing admin panels without Firebase

```js
document.getElementById('loginScreen').style.display='none';
var s=document.getElementById('adminScreen'); s.style.display='flex'; s.classList.add('show');
window.getDB=function(){return{
  settings:{nav:[],customPages:[],seo:{},payment:{}},
  products:[],casingTypes:[],projects:[],reviews:[],historyStories:[]};};
loadDash(); loadStorePages(); applyLang();
```

---

## What was done (commits `a8f5524`, `144d72e`)

### Admin redesign
- Sidebar regrouped around **what a visitor sees**, not how data is stored.
  Renamed to match the storefront: History & Stories → **Library**,
  Navigation → **Menu & Headers**, Custom Pages → **Pages**.
- **New Pages hub** (`loadStorePages()`) — one row per page, showing visibility
  and buttons to *every* screen that controls it. This was the core fix:
  editing the Library page used to require knowing to visit three menus.
- **Sidebar search**, `⌘K` / `/` (`filterSidebar()`). Matches Thai + English +
  `data-kw` keywords listing settings nested inside each screen.
- **Dashboard** — Quick Access grid (8 buttons duplicating the sidebar) replaced
  by `loadNeedsAttention()`: unapproved reviews, products with no price/photo,
  missing SEO description, unconfigured payment.
- **Light theme is now default**; dark is opt-in and remembered. Light lives on
  bare `:root`, dark on `:root[data-theme="dark"]`. Both pass WCAG AA.
  ~90 hard-coded gold tints became `rgba(var(--accent-rgb), α)`.
- **Fixed a real bug:** `loadFeatured()` threw a TypeError on every Homepage
  Editor open (its markup had been deleted). Being mid-sequence without a
  try/catch, it stopped `loadFeedPosts()` and `loadSocialChannels()` from
  running. Removed the dead Featured feature entirely.
- Removed the superseded Amulets/Accessories admin, `moveImg`, `getAuth`.

### Storefront / hosting
- **Closed source exposure** — `functions/index.js` and `functions-index.js`
  were returning 200 in production. Now 404. No credentials had leaked (Stripe
  keys are in Secret Manager) but the pricing logic was readable.
- **Security headers** — `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options`, `Permissions-Policy` enforced. CSP is **Report-Only**.
- **Four policy pages + site footer** linking them from every route.
  Refund policy reflects the owner's real "orders are final" stance *plus* the
  statutory carve-out for damaged/incorrect/misdescribed goods, which Singapore
  consumer law requires and which cannot be dropped.
- **SEO** — static `description`, OG, Twitter, JSON-LD tags. These were
  JS-injected only, and LINE/WhatsApp/Facebook crawlers don't run JS, so shared
  links previewed as bare URLs. Added `robots.txt` + `sitemap.xml`.
- **Contrast** — muted storefront text sat at 2.2:1–3.8:1 against `#0d0a06`,
  under the 4.5:1 AA floor. Raised the alpha values. Now 0 failures.

---

## What's left

### 1. ~~Firestore / Storage rules are not in git~~ — DONE

`firestore.rules` and `storage.rules` are now in git, byte-identical to what was
live, and wired into `firebase.json` (`firestore.rules` / `storage.rules` keys).
Edit the files and deploy; stop editing in the Console.

```bash
firebase deploy --only firestore:rules,storage
```

Notes for next time:
- **It is `storage`, not `storage:rules`.** Only `firestore` takes a `:rules`
  suffix (it also has `:indexes`); for storage the CLI reads `foo` in
  `storage:foo` as a *deploy target* name, so `--only storage:rules` fails with
  the misleading `Could not find rules for the following storage targets: rules`.
  There is one bucket and no targets configured, so plain `--only storage`
  deploys `storage.rules`.
- `firebase firestore:rules:get` **does not exist** (CLI 15.x). Pull rules with
  the Rules REST API instead: `GET firebaserules.googleapis.com/v1/projects/
  <proj>/releases/cloud.firestore` → `rulesetName` → `GET /v1/<rulesetName>`,
  bearer token from the CLI's own cached credentials.
- Both `.rules` files are excluded from Hosting via `*.rules` in `ignore`.
  **Not yet confirmed in production** — curl them after the next deploy.
- The **hosting emulator ignores the `ignore` list** (it happily serves
  `cors.json`, which is 404 in prod). It cannot verify this. Use a preview
  channel or prod.
- CI (`firebase-hosting-merge.yml`) runs `--only hosting`, so rules are never
  deployed automatically. That is deliberate: rules changes stay manual.

`orders` was verified: `allow write: if false` (Cloud Functions write via Admin
SDK, bypassing rules), read only for an admin or the order's own `uid`. Correct.

### 1b. Anyone who signs up could make themselves an admin — FIXED

Found while verifying the above. Email/password, Google **and** Facebook sign-in
are all enabled with open public sign-up. The rule used to read:

```
match /admins/{adminId} {
  allow create: if isSuperAdmin() ||
    (request.auth != null && request.auth.token.email.lower() == adminId);
```

Any stranger can register, then write `admins/<their own email>`. `isTeamMember()`
only checks that the doc **exists** — it does not check `role` — so that single
write grants them:

- read of every `orders` doc — real customer names, phones, addresses
- write on `app/{docId}` — the entire storefront database
- read/update/delete on `reviewSubmissions`

The self-create clause existed for the first-run bootstrap
(`ensureFirstSuperAdmin` in `firebase-shared.js`), which only fires when zero
admins exist. There are 3, so the client path was already dead code — but the
*rule* was the only real boundary, and it was open.

Now `create, update, delete` all require `isSuperAdmin()`, and `read` requires
`isTeamMember()` (it was `request.auth != null`, which leaked the admin roster
to anyone signed in). Deployed 15 Aug 2026.

**There is no self-service bootstrap any more.** Seed the first `admins` doc
from the Firebase Console — doc ID is the lowercased email, field
`role: "super_admin"`. `ensureFirstSuperAdmin()` was kept, but only so an
unauthorized signer still gets the "not authorized" alert instead of an
unhandled promise rejection; its write is expected to fail.

### 1c. Stored XSS from customer reviews — FIXED

Found in a security pass on 15 Aug 2026. Anyone can create a `reviewSubmissions`
doc (that is the feature) and the rules check only type and length, never
content. Both surfaces then interpolated that text straight into `innerHTML`.
Proven by injecting a payload — it executed in four places:

- **Admin, Reviews screen** — the reviewer's *name*, and an image URL breaking
  out of `src="…"` (submission `imgs` entries are unvalidated strings). Fired
  as soon as the admin OPENED the screen, before approving anything, in a
  session that can write all of `app/*` and read every `orders` doc.
- **Storefront, every visitor** — review *text* and *name*, once approved.

CSP contributed nothing: it is Report-Only, and `script-src` already allows
`'unsafe-inline'`. Enforcing it (item 2) would not have stopped this.

Now escaped at every render point. Review text keeps line breaks via `<br>`;
it never had other formatting. Admin image URLs go through `safePreviewUrl()`
+ `escapeAttr()`. **Anything reaching `innerHTML` from `reviews` or
`reviewSubmissions` must stay escaped** — those two collections are public
input.

### 1d. Storage rules let anyone replace any product photo — FIXED

`allow write: if request.auth != null || (size < 10MB && image/*)` had two holes:

- **An upload to an EXISTING path is evaluated as `create`, not `update`.** So
  the "customers may attach review photos" clause also let a complete stranger
  overwrite any file whose path they knew — and every product photo's path is
  public, it is right there in the download URL on the storefront. Silent
  defacement at the same URL, browser-cached for a year (`immutable`).
- `request.auth != null` is not staff. Sign-up is open, so any stranger with an
  account could write or delete anything under `uploads/`, any size, any type.

Now: `update`/`delete` require `isTeamMember()` (same Firestore `admins` lookup
as firestore.rules, via `firestore.exists`), and the public `create` clause is
guarded with `resource == null`. **That guard is load-bearing — without it the
create/update split does nothing.** Deployed 15 Aug 2026, ruleset `9c6493ea`.

`tests/storage.rules.test.mjs` pins all of this down — 14 cases, run it before
touching the rules again:

```bash
npm i --no-save @firebase/rules-unit-testing firebase
firebase emulators:exec --only storage,firestore --project demo-rules-test "node tests/storage.rules.test.mjs"
```

The old rules score 10/14 on it; the current ones 14/14. Note the emulator's
plain REST upload endpoint does **not** populate `request.resource` the way the
SDK does — curl-ing the emulator reports 403 for everything and proves nothing.
Use the SDK-based test.

### 1e. Old phones saw a blank screen — FIXED

Reported 15 Aug 2026: a customer on an old Android got a blank/white page that
looked frozen. Three separate causes, all now closed.

**a. `?.` killed the entire app.** `index.html` had 29 uses of optional
chaining, all inside the one `<script>` block that holds every render
function, `goPage()` and `bootIndex()`. `?.` is ES2020 — Chrome/Android WebView
**older than 80** rejects it at *parse* time, which throws away the whole block,
not just that line. Result: nothing rendered, no click handler existed, and
`bootIndex()` never ran so the splash was never removed. The visitor sat on a
dead screen forever.

Replaced with helpers defined at the top of that block — `pageIsActive(id)`,
`clsOf(id)` (returns a no-op classList when the element is missing),
`valOf(id)`, `elById(id)`. `index.html` is now ES2019-clean.

> **This is the trap to remember.** A `?.` is invisible in review and works
> perfectly on every machine you test on. It only fails on the devices you
> can't see. Check before every deploy:
> ```bash
> grep -n '?\.\|??\|||=\|&&=' index.html admin.html   # must print nothing
> ```

`admin.html` had the same disease — 68 `?.` and 3 `??`, all inside its single
6,000-line `<script>` — and was cleaned the same way. It carries two helpers
that `index.html` does not need:

- `dig(obj, k1, k2, …)` for deep paths. `getDB().casingTypes?.[ti]?.variants?.[vi]?.imgs`
  became `dig(getDB(),'casingTypes',ti,'variants',vi,'imgs')`.
- **`nn(a, b)` for `??` — do not "simplify" it to `||`.** `??` falls back only
  on null/undefined; `||` also swallows `0` and `''`. Two live call sites
  depend on that: `nn(p.stockQty, 1)` must keep a stock of **0** (`||` would
  silently resell a sold-out amulet), and the team sort `nn(rank[a.role], 9)`
  must keep rank **0**, which is `super_admin` (`||` would sort the owner last).

Also `qsVal` / `qsChecked` for the `document.querySelector(\`[data-fp-…]\`)?.value`
form-capture patterns, plus `valOf` / `checkedOf` / `clsOf` / `elById` as in
the storefront.

The admin deliberately did **not** get the boot watchdog. Its failure mode is
different — the login screen is static HTML, so a dead script shows a login box
that does nothing rather than a blank page — and it is staff-only, so there is
no stranger to reassure. Add one if the admin ever gets used from a phone.

**b. `inset:0` is Chrome 87+.** 24 uses, including `.fb-splash`, `#lightbox`,
`.modal-overlay` and `.mobile-overlay`. On older browsers the declaration is
dropped, so a `position:fixed` overlay collapses to a small box at the top-left
instead of covering the screen. All expanded to `top/right/bottom/left`.

**c. Lite mode, for renderer out-of-memory.** The page carries ~170
`backdrop-filter` blurs, a fixed 4-layer gradient body background
(`background-attachment:fixed` repaints the full viewport every scroll frame)
and a three.js/WebGL hero. On a 1–2 GB Android that combination can get Chrome's
renderer OOM-killed, which paints **plain white** and reads to the visitor as a
hang. `liteMode()` in `<head>` sets `<html class="lite-mode">` when
`deviceMemory <= 2`, `hardwareConcurrency <= 2`, or Chrome < 80; the last CSS
block in the stylesheet then drops backdrop-filters, the fixed background, the
decorative blurs and animations, and `initPhra3D()` returns early so WebGL is
never created. Layout, content and colours are unchanged — verified in the
preview by forcing the class.

**d. Boot watchdog** (`bootWatchdog()`, first `<script>` in `<head>`). The
storefront renders everything from JS, so any future failure means a blank
page again. The watchdog is deliberately **ES5** — `var`, `function`, string
concatenation, no arrow functions — so it parses on any browser ever shipped.
**Do not modernise it.** 12s after load, if neither `window.__yyyAppBooted`
(set on the last line of the main block, so it only runs if that block parsed
*and* executed) nor `<html class="fb-ready">` is present, it removes the splash
and renders an inline-styled fallback: what happened, "open in browser" advice
for in-app browsers like LINE, a Try again button, the shop email, and the
captured error message. Tested by serving a copy with a deliberate parse error
— fallback appeared and reported `Uncaught SyntaxError`.

Note the in-app-browser advice is load-bearing: links opened from LINE /
Facebook / Instagram run in Android System WebView, which on old devices is
frozen at a version far behind the user's Chrome.

Network weight was **not** the problem — `index.html` is 615 KB raw but 118 KB
over the wire (Firebase serves it brotli-compressed). The cost is parse and
render on weak hardware, which is what item 4 below addresses.

### 1f. Anyone could dump — and rewrite — every cart in the shop — FIXED

Found 15 Aug 2026. `/carts` was `allow read: if true` with a comment arguing
that the guest id is a UUID and therefore acts as a private token.

**`allow read` grants `get` AND `list`.** The token argument only holds if you
have to know the id, and you did not: a single unauthenticated
`getDocs(collection(db,'carts'))` returned every cart in the shop. Worse, once
a customer signs in `cartKey()` switches to their **Firebase uid**, so the doc
ids were a roster of real user ids paired with what each was about to buy.
`allow write` had no auth check at all, so anyone could also empty or stuff
any cart they had just listed.

Now: `list` is off entirely, a uid-keyed cart is reachable only by that uid,
and a guest cart must match the UUID shape (which is what keeps the guest
branch from being used to reach a uid-keyed cart — Firebase uids are not
UUIDs). `getGuestId()` in `firebase-shared.js` had a non-crypto fallback
(`'g'+Date.now()+…`) that both failed the new shape check and was guessable;
it now emits a real UUID v4 from `getRandomValues` and re-issues any stored id
that predates the change.

> **Read `allow read` as `get + list` every time.** Three of the four rules in
> this file are only safe because of a condition that constrains a `list`.
> `/orders` deliberately keeps a single `allow read` for exactly that reason —
> Firestore permits `where('uid','==',me)` and refuses an unfiltered dump, so
> splitting it into `get` + a team-only `list` would silently break customer
> order history.

`tests/firestore.rules.test.mjs` pins all of it down — 43 cases:

```bash
firebase emulators:exec --only firestore --project demo-fs-rules-test "node tests/firestore.rules.test.mjs"
```

The pre-fix rules score 32/43 on it; the current ones 43/43. Pass a path as
`argv[2]` to test an older copy.

### 1g. Free, permanent lockout of the entire catalogue — FIXED

The chain, all of it unauthenticated and costing the attacker nothing:

1. write a cart containing every available item (1f)
2. call `createPaymentIntent` — it had **no App Check enforcement**, so it was
   callable by anyone who knew the project id, which is in the page source
3. the order lands as `pending_payment`, and the double-sale guard blocks
   every real buyer on those items
4. nothing ever expired a pending order, and `admin.html` has **no orders
   screen at all** — clearing it meant the Firebase Console, by hand

No card is ever charged in that flow. For a shop where every piece is unique,
step 3 is the whole shop.

Now: `enforceAppCheck: true` on the callable, `PENDING_TTL_MS` (30 min) after
which a reservation lapses, stale pending orders marked `expired` in passing
whenever someone next tries to buy that item (no scheduler, no Cloud Scheduler
bill), `payment_intent.canceled` releases immediately, and a per-cart cap of
3 live pending orders.

Two things to know about the fix:

- **The per-cart cap is weak on its own** and the code says so. A guest cart id
  is client-generated, so it can be rotated. App Check and the TTL are what
  actually hold. If reservation abuse ever shows up for real, require sign-in
  at checkout so there is a rotation-proof identity to count.
- **A payment can still arrive after its reservation lapsed.** The webhook
  marks it `paid` regardless — money wins over the timer — and sets
  `needsReview: true` / `expiredThenPaid: true`. Nothing surfaces that flag
  yet; it needs an orders screen (see below).

Also fixed in the same pass: the guard queried
`status in [2] × array-contains-any [N]`, and Firestore caps a disjunctive
query at **30 terms total**, so a cart of 16+ items failed checkout with an
opaque INTERNAL error while the rules allowed 50. Item keys now fan out in
batches of 10, and the cart cap is 30 in both the rules and the function —
**keep those two numbers in step.**

### 1h. Storage: public uploads confined to `uploads/public/`

`uploads/` was flat, so the anonymous-create clause needed for review photos
applied to the whole prefix — anyone could add unlimited 10 MB files anywhere
under it. `firebase-shared.js` now routes uploads whose hint is `review`
(plus the `m_`/`t_` variants `createImageSet` derives) to `uploads/public/`,
and that is the only path with a public `create`. `update`/`delete` stay
staff-only everywhere, including inside `public/`. Storage tests: 20 cases,
20/20.

### 1i. SRI on the three CDN scripts

`three.min.js` (cdnjs), `GLTFLoader.js` (jsDelivr) and `heic2any` (jsDelivr,
unpkg fallback) run as first-party script — the first two on every visitor's
page, heic2any inside an **admin** session that can read every order. CSP
cannot help here: those hosts must be in `script-src` for the features to work
at all. All three now carry `integrity` + `crossorigin`.

**If any of them is version-bumped the hash must be recomputed or the feature
silently stops loading:**

```bash
curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A
```

### 2. ~~Confirm CSP on the checkout flow, then enforce it~~ — ENFORCED

The header is now `Content-Security-Policy` (enforcing), plus
`upgrade-insecure-requests`, `Cross-Origin-Opener-Policy:
same-origin-allow-popups` (the value matters — plain `same-origin` breaks the
Google/Facebook sign-in popup) and `X-Permitted-Cross-Domain-Policies: none`.

Verified before flipping it, in the **hosting emulator** (which does apply
headers, unlike its handling of the `ignore` list): all 11 storefront routes,
`admin.html`, a forced `loadStripeJs()` and a forced `initPhra3D()` — zero
violations, and both SRI-pinned 3D libraries loaded, which is also proof the
hashes are right.

```bash
firebase emulators:start --only hosting --project demo-rules-test   # :5002
```

Two things that pass through it unchanged:

- **`'unsafe-inline'` is still in `script-src`** and cannot be removed while
  every line of JS lives in a `<script>` block inside the HTML. So the CSP does
  **not** stop injected inline script — it stops injected *external* script,
  plugins (`object-src 'none'`), `<base>` hijacking and off-site form posts.
  Removing `'unsafe-inline'` becomes possible once item 4 (split JS into
  files) is done; do them in that order.
- **No `report-uri`**, so violations still only appear in each visitor's own
  console.

**The service worker does not register in the hosting emulator** — "An unknown
error occurred when fetching the script", even though `/sw.js` fetches 200 with
the right content-type. This is an emulator artifact, **not** a CSP problem:
it fails identically with the pre-change report-only config, and registers fine
on the plain python preview. Do not go hunting for a CSP directive to blame.

### 3. ~~alt text~~ — DONE

Every storefront image that carries meaning now gets an alt at render time.
The only empty ones left are the shop avatar icons (decorative — the shop name
sits right next to them, so `alt=""` is correct) and `#lbImg`, the lightbox's
single reused `<img>`, which is filled the moment it opens.

Two layers:

1. **Per-image alt, typed by the owner.** The admin's image uploader
   (`renderPrev()` in `admin.html` — one component behind *every* image field,
   not just products) now shows an Alt text box under each photo, outlined red
   while empty. It is stored on the image object itself: `{url, medium, thumb,
   alt}`. A legacy plain-string URL is promoted to an object the first time an
   alt is typed (`setImgAlt` / `withImgAlt`), and `captureImgs()` folds in an
   alt typed while the file was still uploading.
2. **Generated fallback** for the thousands of images that predate the field.
   `imageAlt(img, fallback)` prefers the typed alt; `photoAlt(name, i, total)`
   builds "Phra Somdej Wat Rakang — photo 2 of 5" from the product / casing
   style / project / review it belongs to. Whitespace-collapsed and capped at
   120 chars, because feed post titles are long and emoji-laden.

`imgAttrs()` gained a 4th argument for the fallback and now always emits an
`alt`, so any new call site gets one for free — pass the name.

**Never write a literal `alt=` next to an `imgAttrs()` call.** Duplicate
attributes resolve to the FIRST one, and `imgAttrs` emits its `alt` before the
hand-written one — so the hand-written value is silently discarded. This bit
during this very change: casing type tiles, product cards, accessory cards and
the PayNow QR each had a good alt that went empty the moment `imgAttrs` started
emitting one. All 28 call sites now pass the description as the 4th argument.
Caught only by checking the deployed page, not by reading the diff.

The Dashboard's **Needs attention** list gained a row counting product photos
with no alt. While wiring it up: the existing "N products have no photo" check
read `p.images` / `p.image`, fields no product has ever had (they are `coverImg`
and `gallery`), so it could never fire. Fixed.

### 3b. Language, and the cookie notice — DONE

`toggleLang()` only ever toggled `body.classList`. `<html lang>` stayed nailed
to `"en"` however the site was displayed, which is what a screen reader picks
its voice from (Thai read by an English synthesiser is unintelligible) and what
Google reads as the page language. It now sets `documentElement.lang`, persists
the choice to `localStorage`, and `restoreLang()` — called first thing in
`bootIndex()`, before anything renders — restores it, falling back to
`navigator.language` on a first visit.

A **cookie/storage notice** now sits above the footer. Deliberately a notice
with one "Got it" button, not an Accept/Reject consent gate: there is no
analytics, no ad pixel and no third-party tracker anywhere in this codebase —
only the cart id, the language key, the notice's own dismissal flag, Firebase
Auth, reCAPTCHA and Stripe, all strictly necessary. Under the PDPA that is the
case where notification is the obligation, and a Reject button that cannot turn
anything off would be a lie.

> **If analytics or an ad pixel is ever added, this has to become a real
> consent gate that blocks those scripts until the visitor opts in.** The
> comment above the markup says so too.

Note there is **no global `data-en`/`data-th` applier** in `index.html` —
`body.th` only switches the font, and dynamic text is built from the `lang`
flag at render time. Static markup carrying `data-th` is mostly inert. The
notice therefore localises itself (`localiseCookieNote()`). `privacy.html`
section 6 was rewritten to list what is actually stored, and section 3 now
discloses Google reCAPTCHA, which was being loaded but never mentioned.

### 4. Split CSS/JS out of the HTML (~1 day)

`index.html` is ~620 KB and served `no-cache` because it's `.html`. Extracting
to `.css`/`.js` files makes them eligible for the 1-year immutable cache
already configured in `firebase.json`. Biggest available speed win — **and it
is the prerequisite for dropping `'unsafe-inline'` from the CSP** (item 2).

Related, now fixed: the `**/*.html` no-cache rule matches the *filename*, and
the homepage is requested as `/`. So the storefront was going out with
Fastly's default `max-age=3600` — which is why a reload after a deploy kept
serving the previous build, and why a security fix could take an hour to reach
visitors. `firebase.json` now carries an explicit `"source": "/"` rule as well.
**Both patterns are needed.** Verified in the hosting emulator.

### 5. Hash routing → History API (multi-day)

All 13 pages share one URL, so Google indexes one page. Needed before
individual products or articles can rank. Requires a Hosting rewrite rule.

### 5b. ~~The admin panel has no orders screen~~ — DONE (read-only)

`admin.html` now has an **Orders** panel (sidebar, under Overview) backed by
`FB.listAllOrders(max)` in `firebase-shared.js`. Three filters — *Needs action*
(paid + pending_payment, the default), *Paid*, *All* — plus a copy-address
button for parcel labels, and the `needsReview` / `expiredThenPaid` flag from
item 1g is finally surfaced as a red banner on the order.

**It is deliberately read-only.** `orders` is `allow write: if false`; the
Cloud Functions write it with the Admin SDK, bypassing rules. An edit button
here would mean opening that rule, which is the only thing standing between a
stolen admin session and forged or repriced orders. Genuine corrections go
through the Firebase Console.

Everything on an order is customer-typed (`shipping.name/phone/address/notes`
are form fields, only length-capped server-side) — as hostile as
`reviewSubmissions`, see item 1c. Every field is escaped at render. Verified by
rendering an order whose name and item name carried
`"><img src=x onerror=…>`: nothing executed, no `<img>` reached the DOM.

Still missing, and still worth doing: no fulfilment states (packed / shipped /
delivered / tracking number), so a paid order stays in *Needs action* forever.
`ORDER_NEEDS_ACTION` in `admin.html` is where that changes when they exist.

The sidebar badge is filled by `refreshOrdersBadge()` on panel load only —
`orders` is not part of `getDB()`, so `refreshSidebarCounts()` cannot see it,
and polling it would spend Firestore reads on a number nobody is watching.

### 5c. Enquiry mode — the shop-wide chat-to-order switch

`settings.checkoutEnabled` (admin → **Shop → How Customers Buy**). When false
the catalogue and **every price stay visible**, but there is no cart and no
card payment: each item shows the shop's contact buttons instead, so the
customer messages to buy. This is what the shop is running on now.

Do not confuse it with the two neighbouring flags:

| Flag | Effect |
|---|---|
| `settings.shopEnabled=false` | whole Shop page becomes "coming soon" |
| product `allowEnquiryOnly` | that one item hides its price → "PM for price" |
| `settings.checkoutEnabled=false` | **whole shop**, prices stay, cart/card gone |

Enforced in two places, and it needs both:

- `checkoutOn()` in `index.html` — folded into `prodCanBuy()`, plus the legacy
  `buildCard`/`openProd` paths for `amulets`/`accessories`, `addToCart()`
  itself, the nav cart button (hidden in `updateCartBadge()`, which
  `applySettings()` now calls), and a redirect out of `/#cart` and
  `/#checkout`. It reads `getDB()` on every call rather than caching a
  boolean — settings arrive async and change live via the Firestore listener.
- `isCheckoutEnabled()` in `functions/index.js` — `createPaymentIntent`
  refuses before it touches Stripe. **The callable is reachable by name from
  anywhere once the project id is known (it is in the page source), so hiding
  buttons stops nobody.** It reads `settings` the same way the client does:
  chunk count from the `app/db` manifest, JSON from `app/dbpart_settings_N`.
  It **fails closed** — if the setting cannot be read it refuses rather than
  charging a card in a shop whose owner believes payments are off.

Nothing about Stripe was removed, only gated. Flipping the toggle back on
restores card checkout with no other change — server-side price verification,
the double-sale guard and the webhook are all still wired.

**The Cloud Function half does not ship with a hosting deploy.** CI runs
`--only hosting`, so until someone runs the command below, the storefront hides
the buttons while the server would still happily charge a card:

```bash
firebase deploy --only functions
```

### 6. Legal review

The policy pages follow standard practice and use the real registered entity,
but were not written by a lawyer. Worth a Singapore solicitor's read as sales
grow — particularly the 7-day claim window and the liability cap.

### Unconfirmed

Production returned an App Check **403 + 24h throttle** during testing, but
almost certainly because reCAPTCHA blocks automated browsers — the page loaded
data fine. Confirm from a normal browser; if 403 appears there, investigate.

---

## Verify current state

```bash
# server source must NOT be reachable
for p in functions/index.js functions-index.js cors.json; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' https://yingyingyingsgshop.web.app/$p)"
done   # expect 404 404 404

# policy pages + SEO files
for p in privacy.html terms.html refunds.html shipping.html robots.txt sitemap.xml; do
  echo "$p -> $(curl -s -o /dev/null -w '%{http_code}' https://yingyingyingsgshop.web.app/$p)"
done   # expect all 200

curl -sI https://yingyingyingsgshop.web.app/ | grep -iE 'content-security|x-frame|referrer-policy|cross-origin|cache-control'
# CSP must be enforcing (no "-Report-Only"), Cache-Control on `/` must be no-cache

# Rules tests — run BOTH before touching either .rules file
firebase emulators:exec --only firestore --project demo-fs-rules-test \
  "node tests/firestore.rules.test.mjs"                       # expect 43/43
firebase emulators:exec --only storage,firestore --project demo-rules-test \
  "node tests/storage.rules.test.mjs"                         # expect 20/20
# (npm i --no-save @firebase/rules-unit-testing firebase, first time only)

# ES2019 guard — must print nothing but comments
grep -n '?\.\|??\|||=\|&&=' index.html admin.html
```

**Rules are not deployed by CI** (`--only hosting`). After changing either
`.rules` file:

```bash
firebase deploy --only firestore:rules,storage
```

Full review with priorities:
https://claude.ai/code/artifact/6314dbb8-2556-4920-a405-dd29932ff53b
