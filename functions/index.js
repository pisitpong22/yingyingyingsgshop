// ════════════════════════════════════════════════════════════════════════════
//  functions/index.js
//  Server-side checkout logic for yingyingyingsgshop.
//
//  Why this needs to exist at all: index.html/firebase-shared.js run entirely
//  in the customer's browser. A browser can be tampered with (devtools,
//  intercepted requests, etc), so the ACTUAL charge amount and the ACTUAL
//  item price/availability must be decided here, on the server, by reading
//  Firestore directly with Admin privileges — never by trusting whatever
//  price/total the client sends up.
//
//  Two entry points:
//    createPaymentIntent  — callable from the client. Reads the cart,
//                            re-verifies every item's real price/availability
//                            against Firestore, creates a Stripe
//                            PaymentIntent for the verified total, and
//                            records a pending order.
//    stripeWebhook         — HTTP endpoint Stripe calls directly (not the
//                            client). Confirms payment actually succeeded
//                            and finalizes the order + empties the cart.
//
//  Deliberate scope decision (read before changing):
//  This does NOT automatically flip the purchased amulet/accessory's status
//  to "sold" in the main catalog. That data is stored in a hand-tuned chunked
//  JSON format (see firebase-shared.js: dblazy_/dblazy_chunk_ docs) that the
//  admin panel's own save path already handles correctly. Re-implementing
//  that chunking logic here — in a second codebase — risks silently
//  corrupting a real item record if the two implementations ever drift.
//  Instead: paid orders land in the `orders` collection, and a
//  double-sale guard below blocks a second checkout of the same item while
//  an order for it is pending/paid. Marking the item "sold" in the catalog
//  is a manual step in admin.html until we're ready to safely automate it
//  (flag this to Arm if/when he wants that automated).
// ════════════════════════════════════════════════════════════════════════════

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const Stripe = require("stripe");

admin.initializeApp();
const db = admin.firestore();

// Keep all functions in the same region as Firestore/Hosting (asia-southeast1)
// to minimize latency for Thai/SG customers.
setGlobalOptions({ region: "asia-southeast1" });

// Secrets — set these once via:
//   firebase functions:secrets:set STRIPE_SECRET_KEY
//   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
// (STRIPE_WEBHOOK_SECRET comes from the Stripe Dashboard AFTER you register
// the webhook URL — see CHECKOUT_SETUP.md for the exact steps/order.)
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

// ─── Helpers: read the CANONICAL item record straight out of Firestore ─────
// Ported from firebase-shared.js's lazyItemDoc/readJsonRecord so the server
// can verify price/status the exact same way the client reconstructs an
// item — without trusting anything the client sent.
function safeDocId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "item";
}

async function readJsonRecord(ref, chunkRefForIndex, label) {
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Missing ${label}`);
  const data = snap.data() || {};
  if (!data._chunked) return data.json || "{}";
  const count = Math.max(0, Number(data._chunkCount) || 0);
  const parts = await Promise.all(
    Array.from({ length: count }, (_, idx) => chunkRefForIndex(idx).get())
  );
  return parts
    .map((p, idx) => {
      if (!p.exists) throw new Error(`Missing ${label} chunk ${idx}`);
      return p.data().json || "";
    })
    .join("");
}

async function getCanonicalItem(type, id) {
  const key = safeDocId(type);
  const itemId = safeDocId(id);
  const ref = db.collection("app").doc(`dblazy_${key}_${itemId}`);
  const chunkRef = (idx) => db.collection("app").doc(`dblazy_chunk_${key}_${itemId}_${idx}`);
  try {
    const json = await readJsonRecord(ref, chunkRef, `${type} item ${id}`);
    return JSON.parse(json);
  } catch (err) {
    console.warn(`[checkout] could not read canonical item ${type}/${id}:`, err.message);
    return null;
  }
}

// ─── What may actually be sold, and for how much ────────────────────────────
//
// There are TWO item schemas in this database and they share almost no field
// names. Everything here has to know which one it is looking at:
//
//   legacy `amulets` / `accessories` — `status: 'available'|'sold'|'reserved'`
//                                      and a single `price`
//   current `products`              — `publishStatus`, `stockStatus`,
//                                      `allowCheckout`, `allowEnquiryOnly`,
//                                      and `price` + optional `salePrice`
//
// This used to read `canonical.status` for everything. A product has no
// `status` field at all, so the guard was `undefined && …` — falsy — and every
// products-schema item walked straight through, sold out or not. Keep these
// two helpers in step with `prodCanBuy()` / `prodPrice()` in index.html: the
// browser decides which buttons to draw, this decides whether a card is
// charged, and they must agree.
function whyNotBuyable(type, item) {
  if (type === "products") {
    // A draft was never published; `sold_out` as a publish state means the
    // owner has retired the listing. Only `active` is on sale.
    if (item.publishStatus !== "active") return "Item is not on sale";
    if (item.stockStatus === "sold_out") return "Item already sold";
    // `reserved` is stricter here than the storefront, deliberately. Every
    // piece is one of a kind, so letting a card through on something the owner
    // has set aside for a named buyer costs a refund and an apology; blocking it
    // costs one message. If the reservation lapsed, the owner clears the flag.
    if (item.stockStatus === "reserved") return "Item is reserved";
    // Pre-orders are taken by message, never by card — see preorderInfoHtml()
    // in index.html for why (no arrival date, deposit is not the full price).
    if (item.stockStatus === "preorder") return "Pre-order items are arranged by message";
    if (item.allowCheckout === false) return "Item is not available for checkout";
    if (item.allowEnquiryOnly) return "Item is enquiry-only";
    return null;
  }
  // Legacy schema — unchanged behaviour.
  if (item.status && item.status !== "available") {
    return "Item already sold/reserved";
  }
  return null;
}

// The cart stores `prodPrice()`, which prefers `salePrice`. The server used to
// re-verify against `price` alone, so an item on sale was charged at its FULL
// price — the customer saw one number and their card was debited a larger one.
// Server-side verification exists to stop a tampered browser paying less; it
// must not quietly charge more than the shop advertised.
function canonicalPrice(type, item) {
  if (type === "products") {
    const sale = Number(item.salePrice);
    if (item.salePrice !== null && item.salePrice !== "" && Number.isFinite(sale) && sale > 0) {
      return sale;
    }
  }
  return Number(item.price || 0);
}

// A cart id is either the signed-in user's uid or a guest UUID v4 — same
// shapes firestore.rules accepts. Anything else is not a cart this shop
// issued, and must not reach a Firestore lookup.
const GUEST_CART_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A pending order holds its items hostage against every other buyer (see the
// double-sale guard below). Nothing here charges a card, so without an expiry
// a stranger could reserve the whole catalogue for free and permanently — the
// shop sells one-of-a-kind pieces, so that is the whole shop. 30 minutes is
// well past the time it takes to type a card in, and the reservation is
// released the moment it lapses.
const PENDING_TTL_MS = 30 * 60 * 1000;

// How many live pending orders one cart may hold at once. A real customer
// needs one; retries after a declined card make a couple plausible.
//
// Be clear about what this is worth: a guest cart id is client-generated, so
// anyone determined can rotate to a fresh UUID and get a fresh allowance.
// This stops double-submits and naive loops, nothing more. The two things
// actually holding the line against item-reservation abuse are
// enforceAppCheck (the caller has to present a real reCAPTCHA token) and
// PENDING_TTL_MS (a reservation lapses on its own). If reservation abuse ever
// shows up in the order log for real, the fix is to require sign-in at
// checkout so there is a rotation-proof identity to count against.
const MAX_LIVE_PENDING_PER_CART = 3;

// Firestore caps a disjunctive query at 30 terms TOTAL. This query already
// spends 2 on `status in [...]`, so an `array-contains-any` over 15+ item
// keys was rejected outright — a 16-item cart used to fail checkout with an
// opaque INTERNAL error. Fan out in small batches instead.
const ITEM_KEY_BATCH = 10;

// ─── Enquiry mode gate ──────────────────────────────────────────────────────
// `settings.checkoutEnabled === false` means the shop is running chat-to-order:
// the catalogue and prices stay up, but no card is charged. index.html hides
// every buy button, and this is the half that makes it true — the callable is
// reachable by name from anywhere once the project id is known (it is in the
// page source), so a hidden button stops nobody.
//
// `settings` is a normal split-DB key: JSON chunked across app/dbpart_settings_N
// with the count in the app/db manifest (firebase-shared.js: dbChunkDoc).
async function isCheckoutEnabled() {
  const metaSnap = await db.collection("app").doc("db").get();
  if (!metaSnap.exists) throw new Error("missing app/db manifest");
  const counts = (metaSnap.data() || {})._partCounts || {};
  const n = Math.max(0, Number(counts.settings) || 0);
  if (!n) throw new Error("settings has no chunks in the manifest");
  const parts = await Promise.all(
    Array.from({ length: n }, (_, idx) => db.collection("app").doc(`dbpart_settings_${idx}`).get())
  );
  const json = parts
    .map((p, idx) => {
      if (!p.exists) throw new Error(`missing settings chunk ${idx}`);
      return p.data().json || "";
    })
    .join("");
  const settings = JSON.parse(json);
  // Absent means enabled — every shop predates this flag.
  return settings.checkoutEnabled !== false;
}

function trimField(value, max, label) {
  const s = String(value == null ? "" : value).trim();
  if (!s) throw new HttpsError("invalid-argument", `Missing ${label}`);
  return s.slice(0, max);
}

// ─── createPaymentIntent ────────────────────────────────────────────────────
exports.createPaymentIntent = onCall(
  {
    secrets: [STRIPE_SECRET_KEY],
    // This endpoint writes to Firestore and reserves stock without anyone
    // having paid anything, and it is callable by name from anywhere once the
    // project id is known (it is — it's in the page source). App Check is what
    // makes the caller prove it is the real storefront rather than a script.
    enforceAppCheck: true,
  },
  async (request) => {
    const stripe = Stripe(STRIPE_SECRET_KEY.value());
    const { cartKey, shipping } = request.data || {};

    // First thing, before any Stripe object or order doc exists.
    //
    // Fails CLOSED: if the setting cannot be read we refuse rather than charge.
    // The alternative is taking a customer's money in a shop whose owner
    // believes payments are switched off, which is far worse than a checkout
    // that errors. This costs nothing in practice — the function already reads
    // Firestore for every cart item below, so a Firestore outage fails this
    // request either way.
    let checkoutOpen;
    try {
      checkoutOpen = await isCheckoutEnabled();
    } catch (err) {
      console.error("[checkout] could not read settings.checkoutEnabled:", err.message);
      throw new HttpsError("unavailable", "Checkout is temporarily unavailable. Please contact the shop.");
    }
    if (!checkoutOpen) {
      throw new HttpsError(
        "failed-precondition",
        "This shop is taking orders by message right now. Please contact us to purchase."
      );
    }

    if (!cartKey || typeof cartKey !== "string") {
      throw new HttpsError("invalid-argument", "Missing cartKey");
    }
    if (!shipping || !shipping.name || !shipping.phone || !shipping.address) {
      throw new HttpsError("invalid-argument", "Missing shipping name/phone/address");
    }
    // If the customer is logged in, their cart key MUST be their own uid —
    // stops one logged-in user from paying against another user's cart.
    // If they are not, it must be a guest UUID, never someone else's uid.
    if (request.auth) {
      if (request.auth.uid !== cartKey) {
        throw new HttpsError("permission-denied", "Cart does not belong to this account");
      }
    } else if (!GUEST_CART_RE.test(cartKey)) {
      throw new HttpsError("invalid-argument", "Invalid cartKey");
    }

    // Bound everything that lands in Firestore. These strings come straight
    // off a form; without a cap a caller can write megabytes per request.
    const shipName = trimField(shipping.name, 120, "shipping name");
    const shipPhone = trimField(shipping.phone, 40, "shipping phone");
    const shipAddress = trimField(shipping.address, 500, "shipping address");
    const shipNotes = String(shipping.notes == null ? "" : shipping.notes).slice(0, 1000);

    // Rate limit per cart. Single-field equality only, so this needs no
    // composite index; the status/age filtering happens in memory.
    const liveSnap = await db.collection("orders").where("cartKey", "==", cartKey).limit(25).get();
    const now = Date.now();
    const livePending = liveSnap.docs.filter((d) => {
      const o = d.data();
      if (o.status !== "pending_payment") return false;
      const created = o.createdAt && o.createdAt.toMillis ? o.createdAt.toMillis() : 0;
      return created && now - created < PENDING_TTL_MS;
    });
    if (livePending.length >= MAX_LIVE_PENDING_PER_CART) {
      throw new HttpsError(
        "resource-exhausted",
        "There are already several unfinished payments for this cart. Please complete or wait a few minutes before trying again."
      );
    }

    const cartSnap = await db.collection("carts").doc(cartKey).get();
    const items = cartSnap.exists ? cartSnap.data().items || [] : [];
    if (!items.length) {
      throw new HttpsError("failed-precondition", "Cart is empty");
    }
    // Matches the 30-item cap in firestore.rules. Keep the two in step.
    if (items.length > 30) {
      throw new HttpsError("invalid-argument", "Too many items in cart");
    }

    // Re-verify EVERY item against the canonical record — price and
    // availability both. This is the one part of the whole checkout that
    // must never trust the browser.
    let total = 0;
    const verifiedItems = [];
    const itemKeys = [];
    for (const it of items) {
      const canonical = await getCanonicalItem(it.type, it.id);
      if (!canonical) {
        throw new HttpsError("not-found", `Item no longer exists: ${it.type}/${it.id}`);
      }
      const blocked = whyNotBuyable(it.type, canonical);
      if (blocked) {
        throw new HttpsError(
          "failed-precondition",
          `${blocked}: ${canonical.name || it.id}`
        );
      }
      const price = canonicalPrice(it.type, canonical);
      total += price;
      const key = `${it.type}:${it.id}`;
      verifiedItems.push({ type: it.type, id: it.id, name: canonical.name || "", price });
      itemKeys.push(key);
    }

    const amountCents = Math.round(total * 100); // SGD — Stripe wants smallest unit (cents)
    if (amountCents < 50) {
      // Stripe's practical minimum charge is roughly S$0.50 equivalent.
      throw new HttpsError("failed-precondition", "Order total is too low to charge");
    }

    // Double-sale guard: block checkout if any of these items already has a
    // pending or paid order in flight (see the scope note at the top of this
    // file for why we don't auto-flip catalog status to "sold").
    //
    // This runs in a TRANSACTION on purpose. The previous version read the
    // conflicting orders and wrote the new reservation in two separate steps,
    // so two checkouts for the same one-of-a-kind piece could BOTH pass the
    // check and BOTH reserve it — a genuine double-charge on unique stock. A
    // Firestore transaction re-runs its reads when a concurrent write touches
    // the same query, so the second writer is forced to retry and then sees
    // the first reservation. The Stripe PaymentIntent cannot live inside a
    // Firestore transaction (it is an external call), so we reserve here first
    // and create/attach the PaymentIntent only once the reservation is held.
    //
    // `paid` blocks forever — the piece is gone. `pending_payment` blocks only
    // until PENDING_TTL_MS, and lapsed ones are marked `expired` inside the
    // same transaction so the reservation is actually released rather than
    // re-checked on every future checkout — no scheduler, no Cloud Scheduler
    // bill; a lapsed order is cleaned up the next time someone buys that item.
    const orderRef = db.collection("orders").doc();
    try {
      await db.runTransaction(async (tx) => {
        // All reads first — Firestore transactions forbid a read after a write.
        const conflictDocs = [];
        for (let i = 0; i < itemKeys.length; i += ITEM_KEY_BATCH) {
          const batch = itemKeys.slice(i, i + ITEM_KEY_BATCH);
          const snap = await tx.get(
            db.collection("orders")
              .where("status", "in", ["pending_payment", "paid"])
              .where("itemKeys", "array-contains-any", batch)
              .limit(30)
          );
          snap.docs.forEach((d) => conflictDocs.push(d));
        }

        const staleRefs = [];
        for (const d of conflictDocs) {
          const o = d.data();
          if (o.status === "paid") {
            throw new HttpsError(
              "failed-precondition",
              "One or more items in your cart were just purchased by someone else. Please refresh your cart."
            );
          }
          const created = o.createdAt && o.createdAt.toMillis ? o.createdAt.toMillis() : 0;
          // No createdAt at all: treat as live rather than release the item on
          // the strength of a missing field.
          if (!created || Date.now() - created < PENDING_TTL_MS) {
            throw new HttpsError(
              "failed-precondition",
              "One or more items in your cart were just purchased by someone else. Please refresh your cart."
            );
          }
          staleRefs.push(d.ref);
        }

        // Reads done — now the writes.
        staleRefs.forEach((ref) =>
          tx.update(ref, { status: "expired", expiredAt: admin.firestore.FieldValue.serverTimestamp() })
        );
        tx.set(orderRef, {
          cartKey,
          uid: request.auth ? request.auth.uid : null,
          items: verifiedItems,
          itemKeys,
          total,
          currency: "sgd",
          shipping: {
            name: shipName,
            phone: shipPhone,
            address: shipAddress,
            notes: shipNotes,
          },
          status: "pending_payment",
          // Filled in right after Stripe returns; the webhook keys off the
          // PaymentIntent's metadata.orderId, not this field, so a brief null
          // window is safe.
          paymentIntentId: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    } catch (err) {
      // A conflict is an intentional HttpsError — surface it as-is. Anything
      // else is contention/backend trouble: fail rather than reserve blindly.
      if (err instanceof HttpsError) throw err;
      console.error("[checkout] reservation transaction failed:", err.message);
      throw new HttpsError("aborted", "Could not reserve your items. Please try again.");
    }

    // The items are reserved. Create the PaymentIntent and attach it; if Stripe
    // fails, release the reservation we just took so the piece is not stranded
    // (payment_failed is not a conflicting status, so the item frees up).
    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: "sgd",
        metadata: { orderId: orderRef.id, cartKey },
        shipping: {
          name: shipName,
          phone: shipPhone,
          address: { line1: shipAddress },
        },
      });
    } catch (err) {
      console.error("[checkout] Stripe PaymentIntent creation failed:", err.message);
      await orderRef
        .update({ status: "payment_failed" })
        .catch((e) => console.warn("[checkout] releasing reservation after Stripe failure failed:", e.message));
      throw new HttpsError("internal", "Could not start payment. Please try again.");
    }

    await orderRef.update({ paymentIntentId: paymentIntent.id });

    return { clientSecret: paymentIntent.client_secret, orderId: orderRef.id, amount: total };
  }
);

// ─── stripeWebhook ──────────────────────────────────────────────────────────
// Stripe calls this directly (not the browser) once a payment actually
// clears. This is the only place an order is allowed to flip to "paid" —
// the client confirming the card on-screen is not, by itself, proof of
// payment (the connection could drop, the tab could close, etc).
exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const stripe = Stripe(STRIPE_SECRET_KEY.value());
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET.value());
    } catch (err) {
      console.error("[stripeWebhook] signature verification failed:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    try {
      if (event.type === "payment_intent.succeeded") {
        const pi = event.data.object;
        const orderId = pi.metadata && pi.metadata.orderId;
        const cartKey = pi.metadata && pi.metadata.cartKey;
        if (orderId) {
          const orderRef = db.collection("orders").doc(orderId);
          const orderSnap = await orderRef.get();
          if (orderSnap.exists && orderSnap.data().status !== "paid") {
            const wasExpired = orderSnap.data().status === "expired";
            await orderRef.update({
              status: "paid",
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
              // The reservation had already lapsed when the money arrived, so
              // the same piece may have been sold to someone else in between.
              // Money always wins over the timer — the order is marked paid —
              // but flag it, because a human has to decide who gets the item.
              ...(wasExpired ? { needsReview: true, expiredThenPaid: true } : {}),
            });
            if (wasExpired) {
              console.warn(`[stripeWebhook] order ${orderId} was paid after its reservation expired — needs manual review`);
            }
          }
        }
        if (cartKey) {
          await db
            .collection("carts")
            .doc(cartKey)
            .set({ items: [], updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
      } else if (event.type === "payment_intent.payment_failed") {
        const pi = event.data.object;
        const orderId = pi.metadata && pi.metadata.orderId;
        if (orderId) {
          await db
            .collection("orders")
            .doc(orderId)
            .update({ status: "payment_failed" })
            .catch(() => {});
        }
      } else if (event.type === "payment_intent.canceled") {
        // Release the item reservation immediately rather than waiting out
        // PENDING_TTL_MS — the customer is definitively not paying.
        const pi = event.data.object;
        const orderId = pi.metadata && pi.metadata.orderId;
        if (orderId) {
          await db
            .collection("orders")
            .doc(orderId)
            .update({ status: "expired", expiredAt: admin.firestore.FieldValue.serverTimestamp() })
            .catch(() => {});
        }
      }
      res.json({ received: true });
    } catch (err) {
      console.error("[stripeWebhook] handler error:", err);
      // Return 500 so Stripe retries the webhook automatically.
      res.status(500).send("Internal error");
    }
  }
);

// ════════════════════════════════════════════════════════════════════════════
//  FACEBOOK PAGE FEED SYNC — SEVERAL PAGES INTO ONE FEED
//
//  Pulls posts from EVERY Facebook Page the shop runs (Genuine Thai Buddha,
//  Yingyingying Amulet, Guardian House, …) into one Firestore collection, so
//  the storefront can render them as ordinary feed cards
//  (index.html: buildFacebookFeedPosts) mixed in with amulets, casing styles,
//  projects and reviews. Each card is labelled with the page it came from.
//
//  Why a server job instead of Facebook's <iframe> Page Plugin:
//    • the plugin is one un-styleable white box PER PAGE — six pages would be
//      six separate boxes that cannot be interleaved by date
//    • Page access tokens must never reach the browser. They can read and
//      post as the Page; anyone who views source would have them.
//    • Facebook's CDN image URLs expire after a few days. Every image is
//      therefore COPIED into our own Storage bucket here; the storefront only
//      ever loads firebasestorage.googleapis.com URLs, which is also the only
//      image host the site's CSP allows.
//
//  Setup (must be done BEFORE `firebase deploy --only functions`, because a
//  missing secret fails the whole deploy):
//     firebase functions:secrets:set FB_PAGE_TOKENS
//  The value is ONE PAGE ACCESS TOKEN PER LINE — add a line to add a page.
//  See .claude/FACEBOOK_FEED_SETUP.md for how to mint them.
//
//  This job only ever READS from Facebook. It never posts, likes or comments.
// ════════════════════════════════════════════════════════════════════════════

const FB_PAGE_TOKENS = defineSecret("FB_PAGE_TOKENS");

// Bump this when Meta retires a version (they support each for ~2 years; the
// current list is at developers.facebook.com/docs/graph-api/changelog).
// A retired version does not hard-fail — calls fall back to the oldest live
// one — but the response shape can shift under you, so keep it current.
const GRAPH_VERSION = "v21.0";

const FB_POSTS_COL = "fbPosts";      // one doc per post — publicly readable
const FB_SYNC_COL = "fbSync";        // last-run status — staff readable
const FB_FETCH_LIMIT = 15;           // newest N posts asked of EACH page
const FB_KEEP_PER_PAGE = 20;         // stored cap, PER PAGE — one busy page
                                     // must not push the quieter ones out
const FB_MAX_IMAGES = 4;             // per post — the card shows one, the
                                     // rest are for the post detail/lightbox
const FB_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FB_MIRROR_PREFIX = "uploads-v2/social/facebook";

// One Page access token per line. Blank lines and #-comments are ignored so
// the secret can be kept readable — `# Guardian House` above its token.
function parsePageTokens(raw) {
  const seen = new Set();
  return String(raw || "")
    .split(/[\r\n,]+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((tok) => {
      // The same token pasted twice would sync the page twice and fight
      // itself over the same documents.
      if (seen.has(tok)) return false;
      seen.add(tok);
      return true;
    });
}

// ─── Graph API ──────────────────────────────────────────────────────────────
// NOTE: the access token is a query parameter, so this URL must never be
// logged — not in an error message, not in a console.warn. Only `err.message`
// from Graph's own JSON body goes anywhere near the logs.
async function graphGet(path, params, token) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("access_token", token);

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new Error(`Graph API unreachable: ${err.message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    const e = (body && body.error) || {};
    const err = new Error(e.message || `Graph API returned HTTP ${res.status}`);
    err.fbCode = e.code;
    throw err;
  }
  return body;
}

// A post's photos, in the order Facebook lists them.
//
// An album/carousel post carries its images in attachments[].subattachments;
// a single-photo post carries one in attachments[].media. `full_picture` is
// the last resort — for a link post it is the link's preview thumbnail, which
// is still the right image to show on a card.
function facebookPostImages(post) {
  const urls = [];
  const push = (u) => {
    if (typeof u === "string" && /^https:\/\//i.test(u) && !urls.includes(u)) urls.push(u);
  };
  const attachments = (post.attachments && post.attachments.data) || [];
  for (const att of attachments) {
    const subs = (att.subattachments && att.subattachments.data) || [];
    if (subs.length) {
      for (const sub of subs) push(sub.media && sub.media.image && sub.media.image.src);
    } else {
      push(att.media && att.media.image && att.media.image.src);
    }
  }
  if (!urls.length) push(post.full_picture);
  return urls.slice(0, FB_MAX_IMAGES);
}

// ─── Copy one Facebook CDN image into our own bucket ────────────────────────
// Returns a tokenised firebasestorage.googleapis.com download URL — the same
// shape getDownloadURL() hands the admin panel, and the same shape the CSP's
// img-src allows. Storage rules do not gate tokenised URLs, which is why the
// storefront can read these while `uploads-v2/**` has no public read rule.
async function mirrorFacebookImage(srcUrl, destPathNoExt) {
  const res = await fetch(srcUrl, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`image fetch returned HTTP ${res.status}`);

  const contentType = String(res.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^image\//i.test(contentType)) throw new Error(`not an image (${contentType || "no type"})`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("empty image");
  if (buf.length > FB_MAX_IMAGE_BYTES) throw new Error(`image too large (${buf.length} bytes)`);

  const ext = contentType === "image/png" ? "png"
    : contentType === "image/webp" ? "webp"
    : contentType === "image/gif" ? "gif"
    : "jpg";
  const downloadToken = crypto.randomUUID();
  const bucket = admin.storage().bucket();
  const file = bucket.file(`${destPathNoExt}.${ext}`);

  await file.save(buf, {
    resumable: false,
    contentType,
    metadata: {
      cacheControl: "public,max-age=31536000,immutable",
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
  });

  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(file.name)}?alt=media&token=${downloadToken}`;
}

async function deleteMirroredImages(docId) {
  try {
    await admin.storage().bucket().deleteFiles({ prefix: `${FB_MIRROR_PREFIX}/${docId}/` });
  } catch (err) {
    // A leftover file costs a few KB; a thrown error costs the whole sync.
    console.warn(`[fbSync] could not clear mirrored images for ${docId}:`, err.message);
  }
}

// Identity of a post AS WE STORED IT. If this is unchanged we skip the post
// entirely — no Storage writes, no Firestore write. Without it every run would
// re-download every image of every post of every page, forever.
function facebookPostHash(post, srcUrls) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({
      m: post.message || "",
      t: post.created_time || "",
      p: post.permalink_url || "",
      i: srcUrls,
    }))
    .digest("hex");
}

// ─── One page ───────────────────────────────────────────────────────────────
// `existing` is every stored post, keyed by doc id — shared across pages so
// the whole collection is read once per run rather than once per page.
//
// Returns what this page owns now, so the caller can prune PER PAGE. Pruning
// across all pages at once would be wrong: page A posting today would make
// every post of quiet page B look "deleted on Facebook".
async function syncOnePage(token, existing) {
  // A Page token's `me` IS the Page, so the page id and name come free and
  // always match what Facebook shows — nothing to keep in step by hand.
  const page = await graphGet("me", { fields: "id,name" }, token);
  const pageId = String(page.id || "");
  const pageName = String(page.name || "").slice(0, 80);
  if (!pageId) throw new Error("token did not resolve to a page");

  const body = await graphGet(
    "me/posts",
    {
      // `/me/posts` is posts BY the page (not visitors' posts on it — that is
      // /feed, which would put strangers' text on the storefront).
      fields: "id,created_time,message,permalink_url,full_picture," +
        "attachments{media_type,media,subattachments{media}}",
      limit: FB_FETCH_LIMIT,
    },
    token
  );

  const fetched = Array.isArray(body.data) ? body.data : [];
  const seen = new Set();
  const createdAtById = new Map();
  let written = 0;
  let skipped = 0;
  let oldestFetchedAt = Infinity;

  for (const post of fetched) {
    const docId = safeDocId(post.id);
    if (!docId || seen.has(docId)) continue;

    const srcUrls = facebookPostImages(post);
    const message = String(post.message || "").slice(0, 2000);
    // A post with neither text nor a picture (a bare share, a profile-picture
    // change) has nothing a card could show.
    if (!message && !srcUrls.length) continue;

    const createdAt = Date.parse(post.created_time || "") || 0;
    seen.add(docId);
    createdAtById.set(docId, createdAt);
    if (createdAt) oldestFetchedAt = Math.min(oldestFetchedAt, createdAt);

    const prev = existing.get(docId);
    const srcHash = facebookPostHash(post, srcUrls);
    if (prev && prev.srcHash === srcHash && prev.pageId === pageId &&
        Array.isArray(prev.imgs) && prev.imgs.length === srcUrls.length) {
      skipped++;
      continue;
    }

    // Re-mirroring: clear the old files first so a post edited from 5 photos
    // down to 2 does not leave 3 orphans in the bucket.
    if (prev) await deleteMirroredImages(docId);

    const imgs = [];
    for (let i = 0; i < srcUrls.length; i++) {
      try {
        imgs.push(await mirrorFacebookImage(srcUrls[i], `${FB_MIRROR_PREFIX}/${docId}/${i}`));
      } catch (err) {
        // One unreachable photo must not cost us the post's text.
        console.warn(`[fbSync] image ${i} of ${docId} skipped:`, err.message);
      }
    }
    if (!message && !imgs.length) continue;

    await db.collection(FB_POSTS_COL).doc(docId).set({
      fbId: String(post.id),
      // Which page this came from. The card shows `pageName` on its badge, so
      // a visitor can tell Guardian House's posts from the gallery's.
      pageId,
      pageName,
      message,
      permalink: String(post.permalink_url || ""),
      createdAt,
      imgs,
      srcHash,
      // Set `hidden: true` by hand in the Firestore console to drop one post
      // from the storefront without deleting it — the next sync preserves it.
      hidden: prev ? prev.hidden === true : false,
      syncedAt: Date.now(),
    });
    written++;
  }

  // ─── Prune, within this page only ─────────────────────────────────────────
  // A stored post of THIS page that Facebook no longer returns, but which is
  // newer than the oldest post it did return, was deleted on Facebook — drop
  // it. Anything older simply fell out of the FB_FETCH_LIMIT window and must
  // be left alone, or every run would delete the page's back catalogue.
  //
  // `oldestFetchedAt === Infinity` means this page returned nothing usable.
  // That is the one case where the rule above would delete the page entirely,
  // so it deletes nothing instead.
  const removals = new Set();
  for (const [docId, data] of existing) {
    if (data.pageId !== pageId || seen.has(docId)) continue;
    const ts = Number(data.createdAt) || 0;
    if (oldestFetchedAt !== Infinity && ts >= oldestFetchedAt) removals.add(docId);
  }

  // Then keep this page bounded, newest first. Posts written for the first
  // time this run are ranked by the timestamp just read from Graph — they are
  // not in `existing` yet, and ranking them at 0 would prune the newest posts.
  const mine = new Set([...seen]);
  for (const [docId, data] of existing) if (data.pageId === pageId) mine.add(docId);
  const ranked = [...mine]
    .filter((id) => !removals.has(id))
    .map((id) => ({
      id,
      ts: createdAtById.has(id)
        ? createdAtById.get(id)
        : Number((existing.get(id) || {}).createdAt) || 0,
    }));
  ranked.sort((a, b) => b.ts - a.ts);
  for (const extra of ranked.slice(FB_KEEP_PER_PAGE)) removals.add(extra.id);

  for (const docId of removals) {
    await deleteMirroredImages(docId);
    await db.collection(FB_POSTS_COL).doc(docId).delete().catch(() => {});
  }

  return { pageId, pageName, fetched: fetched.length, written, skipped, removed: removals.size };
}

// ─── All pages ──────────────────────────────────────────────────────────────
// One page's failure must never take down the others: a revoked token on
// Guardian House cannot be allowed to stop the gallery's posts from syncing,
// and — just as important — must not delete the posts already stored for it.
// A page that threw is simply skipped this run, its documents untouched.
async function runFacebookSync(tokens) {
  const existingSnap = await db.collection(FB_POSTS_COL).get();
  const existing = new Map(existingSnap.docs.map((d) => [d.id, d.data() || {}]));

  const pages = [];
  const failures = [];
  const donePageIds = new Set();

  for (const token of tokens) {
    try {
      const result = await syncOnePage(token, existing);
      if (donePageIds.has(result.pageId)) {
        // Two different tokens for the same page — the second pass would
        // just redo the first's work. Report it so the secret gets tidied.
        failures.push({ page: result.pageName, error: "duplicate token for a page already synced" });
        continue;
      }
      donePageIds.add(result.pageId);
      pages.push(result);
    } catch (err) {
      // Which page? We may not know — the failure can be the /me call itself.
      // Never put the token in this message.
      const hint = err.fbCode === 190
        ? " (token expired or revoked — mint a new one for this page)"
        : "";
      failures.push({ page: `token #${tokens.indexOf(token) + 1}`, error: `${err.message}${hint}` });
      console.error("[fbSync] page failed:", err.message);
    }
  }

  return {
    pages,
    failures,
    pagesOk: pages.length,
    pagesFailed: failures.length,
    written: pages.reduce((n, p) => n + p.written, 0),
    removed: pages.reduce((n, p) => n + p.removed, 0),
  };
}

exports.syncFacebookPosts = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "Asia/Singapore",
    secrets: [FB_PAGE_TOKENS],
    timeoutSeconds: 540,
    memory: "512MiB",
    retryCount: 0,   // it runs again in an hour anyway; a retry storm on an
                     // expired token would just burn image bandwidth
  },
  async () => {
    const statusRef = db.collection(FB_SYNC_COL).doc("status");
    const startedAt = Date.now();
    const tokens = parsePageTokens(FB_PAGE_TOKENS.value());

    if (!tokens.length) {
      await statusRef.set({
        ok: false, startedAt, finishedAt: Date.now(),
        error: "FB_PAGE_TOKENS is empty — set it (one Page access token per line) with " +
          "`firebase functions:secrets:set FB_PAGE_TOKENS`.",
      });
      return;
    }

    try {
      const result = await runFacebookSync(tokens);
      await statusRef.set({
        // Partial success is still a failure worth seeing in the console: one
        // of the shop's pages stopped syncing and somebody has to notice.
        ok: result.pagesFailed === 0 && result.pagesOk > 0,
        startedAt,
        finishedAt: Date.now(),
        error: result.pagesFailed
          ? `${result.pagesFailed} of ${tokens.length} page(s) failed — see \`failures\`.`
          : null,
        ...result,
      });
      console.log("[fbSync] done:", JSON.stringify({
        pagesOk: result.pagesOk, pagesFailed: result.pagesFailed,
        written: result.written, removed: result.removed,
      }));
      if (result.pagesOk === 0) throw new Error("every Facebook page failed to sync");
    } catch (err) {
      await statusRef.set({
        ok: false, startedAt, finishedAt: Date.now(), error: err.message,
      }, { merge: true }).catch(() => {});
      console.error("[fbSync] failed:", err.message);
      throw err;   // surface it in the Cloud Functions error dashboard
    }
  }
);
