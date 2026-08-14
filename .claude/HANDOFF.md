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
- **Hosting serves the repo root** (`"public": "."`). Any new file at the root
  becomes publicly fetchable unless added to the `ignore` list in
  `firebase.json`. `functions/`, `cors.json`, `functions-index.js`, `*.md`,
  `*.log` are already ignored.
- **App Check + reCAPTCHA fails on localhost and in automated browsers.**
  Expect `appCheck/recaptcha-error` in the console when testing locally — it is
  not a real failure. It also means the local preview cannot read Firestore, so
  admin panels render empty. Stub `window.getDB` to test rendering (see below).
- **Local preview:** `.claude/launch.json` defines `static-site` →
  `python3 -m http.server 8791`. Use the preview tools, not Bash.
- **Browser caching during local testing** is aggressive; append `?v=N` when
  verifying edits.
- **Storefront is English-only.** No language switcher. The *admin* is
  bilingual via `data-en` / `data-th` attributes + `applyLang()`.

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

### 1. Firestore / Storage rules are not in git — the only remaining "important" item

Rules are edited in the Firebase Console only. No history, no rollback, and a
misclick could expose the `orders` collection (real customer names, phones,
addresses) without anyone noticing.

```bash
firebase firestore:rules:get > firestore.rules
```

Then wire `"firestore": {"rules": "firestore.rules"}` into `firebase.json` and
deploy from the file. **Verify `orders` is admin-read-only while you're there.**

### 2. Confirm CSP on the checkout flow, then enforce it

The report-only policy already caught one real gap: App Check calls
`www.google.com/recaptcha`, which was missing from `connect-src`. Fixed in
`144d72e`. The homepage is now clean.

**The Stripe checkout flow has not been exercised yet** — most likely place for
a remaining violation. Place a real test order, watch DevTools Console for
"Content Security Policy", and only then rename the header
`Content-Security-Policy-Report-Only` → `Content-Security-Policy`.

Note there is no `report-uri`, so violations only appear in each visitor's own
console. Add a reporting endpoint if you want them collected.

### 3. alt text — 26 of 40 `<img>` have it

Add an alt field to the admin's image upload so product photos get one.
Matters for Google Image Search, which is a real channel for amulets.

### 4. Split CSS/JS out of the HTML (~1 day)

`index.html` is 595 KB and served `no-cache` because it's `.html`. Extracting
to `.css`/`.js` files makes them eligible for the 1-year immutable cache
already configured in `firebase.json`. Biggest available speed win.

### 5. Hash routing → History API (multi-day)

All 13 pages share one URL, so Google indexes one page. Needed before
individual products or articles can rank. Requires a Hosting rewrite rule.

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

curl -sI https://yingyingyingsgshop.web.app/ | grep -iE 'content-security|x-frame|referrer-policy'
```

Full review with priorities:
https://claude.ai/code/artifact/6314dbb8-2556-4920-a405-dd29932ff53b
