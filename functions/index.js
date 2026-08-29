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
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
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
