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

// ─── createPaymentIntent ────────────────────────────────────────────────────
exports.createPaymentIntent = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const stripe = Stripe(STRIPE_SECRET_KEY.value());
    const { cartKey, shipping } = request.data || {};

    if (!cartKey || typeof cartKey !== "string") {
      throw new HttpsError("invalid-argument", "Missing cartKey");
    }
    if (!shipping || !shipping.name || !shipping.phone || !shipping.address) {
      throw new HttpsError("invalid-argument", "Missing shipping name/phone/address");
    }
    // If the customer is logged in, their cart key MUST be their own uid —
    // stops one logged-in user from paying against another user's cart.
    if (request.auth && request.auth.uid !== cartKey) {
      throw new HttpsError("permission-denied", "Cart does not belong to this account");
    }

    const cartSnap = await db.collection("carts").doc(cartKey).get();
    const items = cartSnap.exists ? cartSnap.data().items || [] : [];
    if (!items.length) {
      throw new HttpsError("failed-precondition", "Cart is empty");
    }
    if (items.length > 50) {
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
      if (canonical.status && canonical.status !== "available") {
        throw new HttpsError(
          "failed-precondition",
          `Item already sold/reserved: ${canonical.name || it.id}`
        );
      }
      const price = Number(canonical.price || 0);
      total += price;
      const key = `${it.type}:${it.id}`;
      verifiedItems.push({ type: it.type, id: it.id, name: canonical.name || "", price });
      itemKeys.push(key);
    }

    // Double-sale guard: block checkout if any of these items already has a
    // pending or paid order in flight (see the scope note at the top of this
    // file for why we don't auto-flip catalog status to "sold").
    const conflictSnap = await db
      .collection("orders")
      .where("status", "in", ["pending_payment", "paid"])
      .where("itemKeys", "array-contains-any", itemKeys)
      .limit(1)
      .get();
    if (!conflictSnap.empty) {
      throw new HttpsError(
        "failed-precondition",
        "One or more items in your cart were just purchased by someone else. Please refresh your cart."
      );
    }

    const amountCents = Math.round(total * 100); // SGD — Stripe wants smallest unit (cents)
    if (amountCents < 50) {
      // Stripe's practical minimum charge is roughly S$0.50 equivalent.
      throw new HttpsError("failed-precondition", "Order total is too low to charge");
    }

    const orderRef = db.collection("orders").doc();
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "sgd",
      metadata: { orderId: orderRef.id, cartKey },
      shipping: {
        name: shipping.name,
        phone: shipping.phone,
        address: { line1: String(shipping.address).slice(0, 500) },
      },
    });

    await orderRef.set({
      cartKey,
      uid: request.auth ? request.auth.uid : null,
      items: verifiedItems,
      itemKeys,
      total,
      currency: "sgd",
      shipping: {
        name: shipping.name,
        phone: shipping.phone,
        address: shipping.address,
        notes: shipping.notes || "",
      },
      status: "pending_payment",
      paymentIntentId: paymentIntent.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

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
            await orderRef.update({
              status: "paid",
              paidAt: admin.firestore.FieldValue.serverTimestamp(),
            });
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
      }
      res.json({ received: true });
    } catch (err) {
      console.error("[stripeWebhook] handler error:", err);
      // Return 500 so Stripe retries the webhook automatically.
      res.status(500).send("Internal error");
    }
  }
);
