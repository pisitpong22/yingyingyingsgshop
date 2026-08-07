// ════════════════════════════════════════════════════════════════════════════
//  firebase-shared.js
//  Shared Firebase init + database/storage/auth abstraction for both
//  index.html (customer-facing) and admin.html (CMS).
//
//  Loaded as a regular <script> with type="module" — exposes one global
//  object: window.FB with these methods:
//
//    FB.getDB() ............ synchronous read of current DB (from memory cache)
//    FB.saveDB(db) ......... save full DB to Firestore
//    FB.onDBChange(cb) ..... subscribe to realtime updates from Firestore
//    FB.uploadFile(...) .... upload to Firebase Storage, returns public URL
//    FB.deleteFile(url) .... delete a previously-uploaded file
//    FB.signIn(email,pw) ... admin login via Firebase Auth
//    FB.signOut() .......... admin logout
//    FB.onAuthChange(cb) ... subscribe to auth state changes
//    FB.currentUser() ...... current logged-in user (or null)
//    FB.ready() ............ promise that resolves after initial DB load
//
//  DB shape exposed to the app is identical to the previous localStorage
//  `yyy_db` value. Internally the DB is split into small Firestore documents
//  under /app so it can grow beyond Firestore's 1 MiB per-document limit.
//  Images are referenced by URL pointing to Firebase Storage, NOT stored
//  inline as base64.
// ════════════════════════════════════════════════════════════════════════════

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  GoogleAuthProvider, FacebookAuthProvider, signInWithPopup, createUserWithEmailAndPassword,
  fetchSignInMethodsForEmail, linkWithCredential
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, onSnapshot, collection, getDocs,
  addDoc, serverTimestamp, query, where, orderBy, writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js";
import {
  initializeAppCheck, ReCaptchaV3Provider
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app-check.js";
import {
  getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js";

// ─── CONFIG (PUBLIC — safe to commit; protection is via Security Rules) ────
// Project: yingyingyingsgshop (Singapore — asia-southeast1)
// Firestore + Storage + Auth all hosted in Asia for low-latency delivery
// to Thai/SG customers. Created fresh after migrating from the original
// US-EAST1 project (yingyingying-sg) which had cold-cache latency issues.
const firebaseConfig = {
  apiKey: "AIzaSyCvK5tsaz6AJDGdG7zVoy6a32yoU1_-koA",
  authDomain: "yingyingyingsgshop.firebaseapp.com",
  projectId: "yingyingyingsgshop",
  storageBucket: "yingyingyingsgshop.firebasestorage.app",
  messagingSenderId: "329334358389",
  appId: "1:329334358389:web:105a3024960b00a7c9533c"
};

// ─── INIT ──────────────────────────────────────────────────────────────────
const app  = initializeApp(firebaseConfig);

// ─── APP CHECK ───────────────────────────────────────────────────────────────
// App Check verifies every request to Firestore/Storage actually comes from
// THIS website (not a bot, script, or someone calling the API directly). It
// uses reCAPTCHA v3 invisibly in the background — visitors never see a puzzle.
//
// SETUP (one-time, see REVIEW_SETUP.md):
//   1. Firebase Console → App Check → register this web app with the
//      reCAPTCHA v3 provider. Google gives you a SITE KEY.
//   2. Paste that site key below into APP_CHECK_SITE_KEY.
//   3. Deploy, confirm the site still works, THEN turn on "Enforce" for
//      Firestore + Storage in the console.
//
// IMPORTANT: leave APP_CHECK_SITE_KEY empty until you've pasted a real key.
// With it empty, App Check stays OFF and the site works as before — so the
// page never breaks just because the key isn't in yet. Only after you paste
// the key AND enable enforcement does protection kick in.
const APP_CHECK_SITE_KEY = '6LeDJQMtAAAAAJ_2o3lhLYQr-hRhEUG0RhK1iKqU'; // reCAPTCHA v3 site key

// For local testing against an enforced project, set a debug token:
// open the browser console once, copy the printed debug token, and register
// it in Firebase Console → App Check → Manage debug tokens. Uncomment:
// self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;

if (APP_CHECK_SITE_KEY) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(APP_CHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
    console.log('[FB] App Check enabled');
  } catch (err) {
    console.error('[FB] App Check init failed:', err);
  }
} else {
  console.log('[FB] App Check NOT configured (no site key) — running unprotected');
}

const auth = getAuth(app);
const fs   = getFirestore(app);
const stg  = getStorage(app);
const fns  = getFunctions(app, 'asia-southeast1');

// ─── STATE ─────────────────────────────────────────────────────────────────
// In-memory mirror of the current DB. Updated whenever Firestore changes.
let _db = null;
let _dbListeners = [];       // callbacks for DB changes
let _authListeners = [];     // callbacks for auth changes
let _readyResolve;
const _readyPromise = new Promise(res => { _readyResolve = res; });
let _isReady = false;

const DB_DOC = doc(fs, 'app', 'db');
const DB_SPLIT_VERSION = 1;
const DB_SPLIT_KEYS = ['settings', 'amulets', 'accessories', 'products', 'casingTypes', 'projects', 'reviews', 'feedPosts', 'historyStories'];
const DB_LAZY_ITEM_KEYS = new Set(['amulets', 'accessories', 'products', 'projects']);

// ─── CASING STYLE AVAILABILITY ──────────────────────────────────────────────
// Single source of truth for casing-style stock status, shared by admin.html
// (edit form + inline quick-select) and index.html (style grid + sample
// modal), so labels/copy never drift between the two.
//
// To add a new status later (e.g. "coming_soon", "discontinued"): add one
// entry below with a unique cssClass, then add the matching visual treatment
// for that cssClass in index.html's CSS (search ".var-card.is-oos" for the
// pattern to copy). No other code changes are needed — both admin.html and
// index.html read this registry, not hardcoded values.
const CASING_AVAILABILITY_DEFAULT = 'available';
const CASING_AVAILABILITY = {
  available: {
    en: 'Available', th: 'มีสินค้า',
    adminIcon: '🟢',
  },
  out_of_stock: {
    en: 'Out of Stock', th: 'สินค้าหมด',
    adminIcon: '🔴',
    cssClass: 'is-oos',              // applied to .var-card / .var-price-badge
    cardHintEn: 'Sold out — tap to view samples',
    cardHintTh: 'หมดชั่วคราว · แตะเพื่อดูตัวอย่าง',
    bannerEn: 'This style is currently out of stock. You are welcome to browse the sample photos below, or message us to ask about the next restock.',
    bannerTh: 'แบบนี้หมดชั่วคราว ยังสามารถดูตัวอย่างรูปด้านล่างได้ตามปกติ หากสนใจสามารถทักสอบถามคิวถัดไปได้เลยค่ะ',
  },
};
// Given a variant object, returns its status key — falls back to "available"
// for legacy variants that predate this field (no migration needed).
function casingAvailabilityStatus(v){
  const key = v && v.availability;
  return (key && CASING_AVAILABILITY[key]) ? key : CASING_AVAILABILITY_DEFAULT;
}
function casingAvailabilityMeta(v){
  const key = casingAvailabilityStatus(v);
  return { key, ...CASING_AVAILABILITY[key] };
}
function casingAvailabilityOptions(){
  return Object.keys(CASING_AVAILABILITY).map(key => ({ key, ...CASING_AVAILABILITY[key] }));
}


// Bump this whenever lazyItemSummary()'s output shape changes for any key.
// Summaries are only rewritten when the full item's content-hash changes
// (see queueLazyItemWrites) — that's an optimisation so untouched items don't
// get re-written on every save. But it means: if lazyItemSummary() itself
// changes (e.g. the 'products' branch was added after some items already had
// a stale legacy-shaped summary written), an item whose data was never
// edited again will keep serving that stale summary forever, since its
// full-item hash never changes. Folding this version into the hash forces a
// one-time rewrite of every item's summary the next time ANY save happens,
// after which it goes back to being skipped as normal.
const SUMMARY_SCHEMA_VERSION = 5; // bumped: projects summary now includes priceTiers + hideStats
// Keep every large collection chunked. A single casing type can grow past
// Firestore's 1 MiB document limit when it contains many style/photo URLs.
const DB_ITEM_KEYS = new Set([]);
const DB_CHUNK_PREFIX = 'dbpart';
const DB_ITEM_PREFIX = 'dbitem';
const DB_CHUNK_CHARS = 700000; // safely below Firestore's 1 MiB document limit, fewer writes per save
const DB_RECORD_INLINE_CHARS = 650000;
const DB_BATCH_MAX_WRITES = 6;
const DB_BATCH_MAX_BYTES = 3500000; // stay well below Firestore's 10 MiB request payload limit
let _dbPartCounts = {};
let _dbPartHashes = {};
let _dbItemIds = {};
let _dbItemHashes = {};
let _snapshotSeq = 0;
let _dbMeta = null;
let _loadedKeys = new Set();
let _casingTypeIds = [];
let _casingTypeHashes = {};
let _casingVariantIds = {};
let _casingVariantHashes = {};
let _historyStoryIds = [];
let _historyStoryHashes = {};
let _lazyItemIds = {};
let _lazyItemHashes = {};
const IS_ADMIN_PAGE = /(^|\/)admin[^/]*\.html$/i.test(location.pathname);

// ─── DB API ────────────────────────────────────────────────────────────────
function getDB(){ return _db || {}; }

function requestedPageFromUrl(){
  const params = new URLSearchParams(location.search);
  const qPage = params.get('page');
  if(qPage) return qPage.replace(/^page-/, '');
  const h = (location.hash || '').replace(/^#/, '');
  if(!h) return 'home';
  if(h.startsWith('page-')) return h.slice(5);
  if(/^(amulets|accessories)-\d+$/.test(h)) return '';
  return h;
}

function keysForStorePage(page){
  switch(page){
    case 'amulets':      return ['settings','amulets'];
    case 'accessories':  return ['settings','accessories'];
    case 'casing':       return ['settings','casingTypes'];
    case 'projects':     return ['settings','projects'];
    case 'reviews':      return ['settings','reviews'];
    case 'history-stories': return ['settings','historyStories'];
    case 'feed':         return ['settings','feedPosts','amulets','projects','reviews','casingTypes'];
    case 'home':         return ['settings','feedPosts','amulets','projects','reviews','casingTypes'];
    default:             return ['settings'];
  }
}

async function mapLimit(items, limit, mapper){
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit || 1), list.length || 1) }, async () => {
    while(next < list.length){
      const idx = next++;
      out[idx] = await mapper(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function initialLoadKeys(){
  return IS_ADMIN_PAGE ? DB_SPLIT_KEYS : keysForStorePage(requestedPageFromUrl());
}

async function saveDB(newDb){
  // Persist as many small documents. This avoids Firestore's hard 1 MiB
  // limit for a single document while keeping FB.getDB()/saveDB() unchanged.
  _db = newDb;
  try {
    const nextCounts = {};
    const nextHashes = {};
    const nextItemIds = {};
    const nextItemHashes = {};
    let nextCasingMeta = {
      typeIds: [],
      typeHashes: {},
      variantIds: {},
      variantHashes: {},
    };
    let nextHistoryMeta = {
      storyIds: [],
      storyHashes: {},
    };
    let nextLazyItemMeta = {
      itemIds: {},
      itemHashes: {},
    };
    const writes = [];

    DB_SPLIT_KEYS.forEach(key => {
      if(key === 'casingTypes'){
        const casingMeta = queueCasingTypeWrites(newDb && newDb[key], writes);
        nextCounts[key] = 0;
        nextHashes[key] = [];
        nextItemIds[key] = [];
        nextItemHashes[key] = {};
        nextCasingMeta = casingMeta;
        return;
      }

      if(key === 'historyStories'){
        const incomingStories = Array.isArray(newDb && newDb[key]) ? newDb[key] : [];
        if(!incomingStories.length && ((_historyStoryIds && _historyStoryIds.length) || (_dbPartCounts.historyStories > 0))){
          nextCounts[key] = _dbPartCounts.historyStories || 0;
          nextHashes[key] = _dbPartHashes.historyStories || [];
          nextItemIds[key] = [];
          nextItemHashes[key] = {};
          nextHistoryMeta = { storyIds:[...(_historyStoryIds||[])], storyHashes:{...(_historyStoryHashes||{})} };
          return;
        }
        const historyMeta = queueHistoryStoryWrites(incomingStories, writes);
        nextCounts[key] = 0;
        nextHashes[key] = [];
        nextItemIds[key] = [];
        nextItemHashes[key] = {};
        nextHistoryMeta = historyMeta;
        return;
      }

      if(DB_LAZY_ITEM_KEYS.has(key)){
        const incomingItems = Array.isArray(newDb && newDb[key]) ? newDb[key] : [];
        if(!incomingItems.length && ((_lazyItemIds[key] && _lazyItemIds[key].length) || (_dbPartCounts[key] > 0))){
          nextCounts[key] = _dbPartCounts[key] || 0;
          nextHashes[key] = _dbPartHashes[key] || [];
          nextItemIds[key] = [];
          nextItemHashes[key] = {};
          nextLazyItemMeta.itemIds[key] = [...((_lazyItemIds && _lazyItemIds[key]) || [])];
          nextLazyItemMeta.itemHashes[key] = {...((_lazyItemHashes && _lazyItemHashes[key]) || {})};
          return;
        }
        const itemMeta = queueLazyItemWrites(key, incomingItems, writes);
        nextCounts[key] = 0;
        nextHashes[key] = [];
        nextItemIds[key] = [];
        nextItemHashes[key] = {};
        nextLazyItemMeta.itemIds[key] = itemMeta.itemIds;
        nextLazyItemMeta.itemHashes[key] = itemMeta.itemHashes;
        return;
      }

      if(DB_ITEM_KEYS.has(key)){
        const items = Array.isArray(newDb && newDb[key]) ? newDb[key] : [];
        const ids = [];
        const hashes = {};

        items.forEach((item, idx) => {
          const itemId = stableItemId(item, idx);
          const json = JSON.stringify(item);
          const hash = hashString(json);
          ids.push(itemId);
          hashes[itemId] = hash;
          if(!_dbItemHashes[key] || _dbItemHashes[key][itemId] !== hash){
            writes.push({
              type: 'set',
              ref: dbItemDoc(key, itemId),
              data: { key, itemId, index: idx, json },
            });
          }
        });

        nextCounts[key] = 0;
        nextHashes[key] = [];
        nextItemIds[key] = ids;
        nextItemHashes[key] = hashes;
        return;
      }

      const json = JSON.stringify(newDb && newDb[key] !== undefined ? newDb[key] : defaultDbValueForKey(key));
      const chunks = chunkString(json, DB_CHUNK_CHARS);
      nextCounts[key] = chunks.length;
      nextHashes[key] = chunks.map(hashString);
      chunks.forEach((part, idx) => {
        const prevHash = _dbPartHashes[key] && _dbPartHashes[key][idx];
        if(prevHash !== nextHashes[key][idx]){
          writes.push({
            type: 'set',
            ref: dbChunkDoc(key, idx),
            data: { key, index: idx, json: part },
          });
        }
      });

      // Do not delete stale chunks during normal saves. The manifest's
      // _partCounts tells readers exactly which chunks are current, so older
      // extras are ignored. Skipping deletes keeps a one-image edit from
      // enqueueing a long tail of cleanup writes.
    });

    writes.push({ type: 'set', ref: DB_DOC, data: {
      _splitVersion: DB_SPLIT_VERSION,
      _partKeys: DB_SPLIT_KEYS,
      _partCounts: nextCounts,
      _partHashes: nextHashes,
      _itemKeys: Array.from(DB_ITEM_KEYS),
      _itemIds: nextItemIds,
      _itemHashes: nextItemHashes,
      _casingTypesV2: true,
      _casingTypeIds: nextCasingMeta.typeIds,
      _casingTypeHashes: nextCasingMeta.typeHashes,
      _casingVariantIds: nextCasingMeta.variantIds,
      _casingVariantHashes: nextCasingMeta.variantHashes,
      _historyStoriesV2: true,
      _historyStoryIds: nextHistoryMeta.storyIds,
      _historyStoryHashes: nextHistoryMeta.storyHashes,
      _lazyItemsV2: true,
      _lazyItemIds: nextLazyItemMeta.itemIds,
      _lazyItemHashes: nextLazyItemMeta.itemHashes,
      _updatedAt: serverTimestamp(),
    }});

    console.log('[FB] saveDB writes:', writes.length);
    await commitWritesSequentially(writes);
    _dbPartCounts = nextCounts;
    _dbPartHashes = nextHashes;
    _dbItemIds = nextItemIds;
    _dbItemHashes = nextItemHashes;
    _casingTypeIds = nextCasingMeta.typeIds;
    _casingTypeHashes = nextCasingMeta.typeHashes;
    _casingVariantIds = nextCasingMeta.variantIds;
    _casingVariantHashes = nextCasingMeta.variantHashes;
    _historyStoryIds = nextHistoryMeta.storyIds;
    _historyStoryHashes = nextHistoryMeta.storyHashes;
    _lazyItemIds = nextLazyItemMeta.itemIds;
    _lazyItemHashes = nextLazyItemMeta.itemHashes;
  } catch(err){
    console.error('[FB] saveDB failed:', err);
    throw err;
  }
  // Don't manually fire listeners — Firestore onSnapshot will do that
}

function onDBChange(cb){
  _dbListeners.push(cb);
  if(_db) cb(_db);   // fire immediately if we already have data
  return () => {     // unsubscribe function
    _dbListeners = _dbListeners.filter(x => x !== cb);
  };
}

function defaultDbValueForKey(key){
  return key === 'settings' ? {} : [];
}

function dbChunkDoc(key, idx){
  return doc(fs, 'app', `${DB_CHUNK_PREFIX}_${key}_${idx}`);
}

function dbItemDoc(key, itemId){
  return doc(fs, 'app', `${DB_ITEM_PREFIX}_${key}_${safeDocId(itemId)}`);
}

function casingTypeDoc(typeId){
  return doc(fs, 'app', `dbcasing_type_${safeDocId(typeId)}`);
}

function casingVariantDoc(typeId, variantId){
  return doc(fs, 'app', `dbcasing_variant_${safeDocId(typeId)}_${safeDocId(variantId)}`);
}

function casingTypeChunkDoc(typeId, idx){
  return doc(fs, 'app', `dbcasing_typechunk_${safeDocId(typeId)}_${idx}`);
}

function casingVariantChunkDoc(typeId, variantId, idx){
  return doc(fs, 'app', `dbcasing_variantchunk_${safeDocId(typeId)}_${safeDocId(variantId)}_${idx}`);
}

function historyStoryDoc(storyId){
  return doc(fs, 'app', `dbhistory_story_${safeDocId(storyId)}`);
}

function historyStoryChunkDoc(storyId, idx){
  return doc(fs, 'app', `dbhistory_storychunk_${safeDocId(storyId)}_${idx}`);
}

function historyStorySummaryDoc(storyId){
  return doc(fs, 'app', `dbhistory_summary_${safeDocId(storyId)}`);
}

function lazyItemDoc(key, itemId){
  return doc(fs, 'app', `dblazy_${safeDocId(key)}_${safeDocId(itemId)}`);
}

function lazyItemChunkDoc(key, itemId, idx){
  return doc(fs, 'app', `dblazy_chunk_${safeDocId(key)}_${safeDocId(itemId)}_${idx}`);
}

function lazyItemSummaryDoc(key, itemId){
  return doc(fs, 'app', `dblazy_summary_${safeDocId(key)}_${safeDocId(itemId)}`);
}

function queueCasingTypeWrites(types, writes){
  const list = Array.isArray(types) ? types : [];
  const typeIds = [];
  const typeHashes = {};
  const variantIds = {};
  const variantHashes = {};
  const usedTypeIds = new Set();

  list.forEach((type, typeIdx) => {
    const typeId = uniqueItemId(stableItemId(type, typeIdx), usedTypeIds);
    typeIds.push(typeId);

    const typeData = { ...(type || {}) };
    delete typeData.variants;
    const typeJson = JSON.stringify(typeData);
    const typeHash = hashString(typeJson);
    typeHashes[typeId] = typeHash;
    if(_casingTypeHashes[typeId] !== typeHash){
      queueJsonRecord(writes, casingTypeDoc(typeId), typeJson, { key: 'casingTypes', typeId }, idx => casingTypeChunkDoc(typeId, idx));
    }

    const vars = Array.isArray(type && type.variants) ? type.variants : [];
    variantIds[typeId] = [];
    variantHashes[typeId] = {};
    const usedVariantIds = new Set();

    if(vars.length > 0){
      // Have real variant data — write it
      vars.forEach((variant, variantIdx) => {
        const variantId = uniqueItemId(stableItemId(variant, variantIdx), usedVariantIds);
        variantIds[typeId].push(variantId);
        const variantJson = JSON.stringify(variant || {});
        const variantHash = hashString(variantJson);
        variantHashes[typeId][variantId] = variantHash;
        if(!_casingVariantHashes[typeId] || _casingVariantHashes[typeId][variantId] !== variantHash){
          queueJsonRecord(writes, casingVariantDoc(typeId, variantId), variantJson, { key: 'casingTypes', typeId, variantId }, idx => casingVariantChunkDoc(typeId, variantId, idx));
        }
      });
    } else if(_casingVariantIds[typeId] && _casingVariantIds[typeId].length > 0 && !_casingVariantsLoaded.has(String(typeId))){
      // variants array is empty AND we never actually loaded them for this type
      // (Phase 1 deferred load) — but we KNOW variants exist in Firestore from the
      // cached _casingVariantIds — preserve them, do NOT write [].
      // This prevents saveType (which runs without loading variants) from wiping variant index.
      // IMPORTANT: if _casingVariantsLoaded HAS this type, variants were fully loaded
      // and the user genuinely deleted all of them — do NOT preserve in that case,
      // or deleting the last remaining style becomes impossible (silently restored).
      variantIds[typeId] = _casingVariantIds[typeId];
      variantHashes[typeId] = (_casingVariantHashes[typeId]) || {};
      console.log('[FB] preserving', variantIds[typeId].length, 'existing variant IDs for type', typeId, '(variants not loaded yet)');
    }
  });

  // Old casing docs are ignored once they disappear from the manifest below.
  // Skipping delete cleanup keeps reorder/delete operations from enqueueing a
  // long tail of Firestore writes and hitting the queued-writes limit.

  return { typeIds, typeHashes, variantIds, variantHashes };
}

function historySummaryFromArticle(a){
  if(!a) return null;
  // Robust fallbacks for old documents that may not have all fields
  const title = a.title || a.name || 'Untitled';
  const coverImage = a.coverImage || a.imageUrl || a.image || a.thumbnail || '';
  const rawText = (a.content || a.body || a.description || '').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
  const excerpt = a.excerpt || a.summary || a.shortContent || (rawText ? rawText.slice(0,150) : '');
  const createdAt = a.createdAt || a.publishedAt || a.updatedAt || 0;
  return {
    id: a.id,
    title,
    slug: a.slug || '',
    category: a.category || 'guides-articles',
    excerpt,
    coverImage,
    coverPositionX: a.coverPositionX,
    coverPositionY: a.coverPositionY,
    featured: !!a.featured,
    status: a.status || 'published',
    createdAt,
    updatedAt: a.updatedAt || createdAt,
    hasVideo: !!a.videoUrl,
    _summaryOnly: true,
  };
}

function queueHistoryStoryWrites(stories, writes){
  const list = Array.isArray(stories) ? stories : [];
  const storyIds = [];
  const storyHashes = {};
  const usedStoryIds = new Set();

  list.forEach((story, idx) => {
    const storyId = uniqueItemId(stableItemId(story, idx), usedStoryIds);
    storyIds.push(storyId);

    const full = { ...(story || {}) };
    const fullJson = JSON.stringify(full);
    const summaryJson = JSON.stringify(historySummaryFromArticle(full));
    const hash = hashString(fullJson);
    storyHashes[storyId] = hash;

    if(_historyStoryHashes[storyId] !== hash){
      queueJsonRecord(
        writes,
        historyStoryDoc(storyId),
        fullJson,
        { key:'historyStories', storyId },
        chunkIdx => historyStoryChunkDoc(storyId, chunkIdx)
      );
      writes.push({
        type:'set',
        ref:historyStorySummaryDoc(storyId),
        data:{ key:'historyStories', storyId, json:summaryJson },
      });
    }
  });

  return { storyIds, storyHashes };
}

function lazyItemSummary(key, item){
  if(key === 'products'){
    // Products has its own schema (coverImg/category/stockStatus/etc) and
    // its own renderer on both admin and storefront — it does NOT share
    // field names with the legacy amulets/accessories summary shape below.
    // Keep this summary lean (it's fetched before the full item loads) but
    // include everything the shop grid needs to render/filter/sort without
    // waiting for the full record: name, cover image, price, stock, and the
    // filter fields (category/master/temple/material).
    return {
      id: item && item.id,
      sku: item && item.sku || '',
      name: item && item.name || '',
      type: item && item.type || 'other',
      category: item && item.category || '',
      subCategory: item && item.subCategory || '',
      shortDesc: item && item.shortDesc || '',
      coverImg: item && item.coverImg
        ? item.coverImg
        : (item && Array.isArray(item.gallery) && item.gallery[0] ? item.gallery[0] : ''),
      price: item && item.price || 0,
      salePrice: item && item.salePrice != null ? item.salePrice : null,
      discountLabel: item && item.discountLabel || '',
      badgeText: item && item.badgeText || '',
      stockStatus: item && item.stockStatus || 'in_stock',
      allowCheckout: item ? item.allowCheckout !== false : true,
      allowEnquiryOnly: !!(item && item.allowEnquiryOnly),
      publishStatus: item && item.publishStatus || 'draft',
      featured: !!(item && item.featured),
      bestSeller: !!(item && item.bestSeller),
      newArrival: !!(item && item.newArrival),
      temple: item && item.temple || '',
      master: item && item.master || '',
      material: item && item.material || '',
      createdAt: item && item.createdAt || 0,
      updatedAt: item && item.updatedAt || 0,
      _summaryOnly: true,
    };
  }
  const base = {
    id: item && item.id,
    name: item && item.name || '',
    cat: item && item.cat || '',
    desc: item && item.desc || '',
    imgs: item && Array.isArray(item.imgs) && item.imgs[0] ? [item.imgs[0]] : [],
    status: item && item.status || 'available',
    badge: item && item.badge || '',
    price: item && item.price || 0,
    hidePrice: !!(item && item.hidePrice),
    featured: !!(item && item.featured),
    _summaryOnly: true,
  };
  if(key === 'amulets'){
    base.temple = item && item.temple || '';
    base.year = item && item.year || '';
  }
  if(key === 'projects'){
    base.date = item && item.date || '';
    base.status = item && item.status || 'active';
    base.type = item && item.type || 'campaign';
    base.category = item && item.category || '';
    base.size = item && item.size || 'normal';
    base.goal = item && item.goal || 0;
    base.raised = item && item.raised || 0;
    base.price = item && item.price || 0;
    base.unit = item && item.unit || '';
    base.priceTiers = Array.isArray(item && item.priceTiers) ? item.priceTiers : [];
    base.hideStats = !!(item && item.hideStats);
    base.donors = item && item.donors || 0;
    base.closing = item && item.closing || '';
    base.focal = item && item.focal || 'center center';
  }
  return base;
}

function queueLazyItemWrites(key, items, writes){
  const list = Array.isArray(items) ? items : [];
  const itemIds = [];
  const itemHashes = {};
  const usedIds = new Set();

  list.forEach((item, idx) => {
    const itemId = uniqueItemId(stableItemId(item, idx), usedIds);
    itemIds.push(itemId);
    const fullJson = JSON.stringify(item || {});
    const summaryJson = JSON.stringify(lazyItemSummary(key, item || {}));
    // Versioned hash: same content + same summary schema version → same
    // hash → skip (as before). If SUMMARY_SCHEMA_VERSION was bumped since
    // this item's summary was last written, the hash differs even though
    // fullJson is identical, forcing a rewrite with the current summary shape.
    const hash = hashString(fullJson) + ':v' + SUMMARY_SCHEMA_VERSION;
    itemHashes[itemId] = hash;
    if(!_lazyItemHashes[key] || _lazyItemHashes[key][itemId] !== hash){
      queueJsonRecord(
        writes,
        lazyItemDoc(key, itemId),
        fullJson,
        { key, itemId },
        chunkIdx => lazyItemChunkDoc(key, itemId, chunkIdx)
      );
      writes.push({
        type:'set',
        ref:lazyItemSummaryDoc(key, itemId),
        data:{ key, itemId, json:summaryJson },
      });
    }
  });

  return { itemIds, itemHashes };
}

function queueJsonRecord(writes, ref, json, baseData, chunkRefForIndex){
  if(json.length <= DB_RECORD_INLINE_CHARS){
    writes.push({
      type: 'set',
      ref,
      data: { ...baseData, json, _chunked: false },
    });
    return;
  }

  const chunks = chunkString(json, DB_RECORD_INLINE_CHARS);
  writes.push({
    type: 'set',
    ref,
    data: {
      ...baseData,
      _chunked: true,
      _chunkCount: chunks.length,
      _chunkHashes: chunks.map(hashString),
    },
  });
  chunks.forEach((part, idx) => {
    writes.push({
      type: 'set',
      ref: chunkRefForIndex(idx),
      data: { ...baseData, index: idx, json: part },
    });
  });
}

function stableItemId(item, idx){
  if(item && item.id !== undefined && item.id !== null) return String(item.id);
  const label = item && (item.slug || item.key || item.name || item.title);
  if(label !== undefined && label !== null && String(label).trim()){
    return String(label).trim().toLowerCase().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  }
  return `idx_${idx}`;
}

function uniqueItemId(base, used){
  let id = base || 'item';
  let n = 2;
  while(used.has(id)){
    id = `${base}_${n++}`;
  }
  used.add(id);
  return id;
}

function safeDocId(id){
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'item';
}

function chunkString(str, size){
  const chunks = [];
  for(let i = 0; i < str.length; i += size){
    chunks.push(str.slice(i, i + size));
  }
  return chunks.length ? chunks : ['null'];
}

function hashString(str){
  let h = 2166136261;
  for(let i = 0; i < str.length; i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + ':' + str.length;
}

async function commitWritesSequentially(writes){
  let batch = writeBatch(fs);
  let count = 0;
  let bytes = 0;

  const flush = async () => {
    if(!count) return;
    await batch.commit();
    batch = writeBatch(fs);
    count = 0;
    bytes = 0;
  };

  for(const w of writes){
    const size = estimateWriteBytes(w);
    if(count && (count >= DB_BATCH_MAX_WRITES || bytes + size > DB_BATCH_MAX_BYTES)){
      await flush();
    }
    if(w.type === 'delete') batch.delete(w.ref);
    else batch.set(w.ref, w.data);
    count++;
    bytes += size;
  }
  await flush();
}

function estimateWriteBytes(w){
  if(!w || w.type === 'delete') return 128;
  try {
    return JSON.stringify(w.data || {}).length + 512;
  } catch(err) {
    return DB_BATCH_MAX_BYTES;
  }
}

function notifyDBReady(){
  _dbListeners.forEach(cb => {
    try { cb(_db); } catch(err){ console.error('[FB] listener error:', err); }
  });
  if(!_isReady){
    _isReady = true;
    _readyResolve(_db);
  }
}

async function ensureDBKeys(keys){
  if(!_isReady) await _readyPromise;
  if(!_dbMeta || !_dbMeta._splitVersion) return getDB();
  const wanted = [...new Set((keys || []).filter(k => DB_SPLIT_KEYS.includes(k)))];
  const missing = wanted.filter(k => !_loadedKeys.has(k));
  if(!missing.length) return getDB();
  const partial = await loadSplitDB(_dbMeta, missing);
  _db = { ...(_db || {}), ...partial };
  missing.forEach(k => _loadedKeys.add(k));
  notifyDBReady();
  return getDB();
}

async function loadSplitDB(meta, wantedKeys){
  const out = {};
  const keys = Array.isArray(meta._partKeys) ? meta._partKeys : DB_SPLIT_KEYS;
  const wanted = wantedKeys ? new Set(wantedKeys) : new Set(keys);
  const counts = meta._partCounts || {};
  const hashes = meta._partHashes || {};
  const itemIds = meta._itemIds || {};
  const itemHashes = meta._itemHashes || {};

  await Promise.all(keys.map(async key => {
    if(!wanted.has(key)) return;
    try {
      if(key === 'casingTypes' && meta._casingTypesV2){
        out[key] = await loadCasingTypesV2(meta);
        return;
      }
      if(key === 'historyStories' && meta._historyStoriesV2 && !IS_ADMIN_PAGE){
        out[key] = await loadHistorySummariesV2OrFallback(meta);
        return;
      }
      if(key === 'historyStories' && meta._historyStoriesV2 && IS_ADMIN_PAGE){
        out[key] = await loadHistoryStoriesFullV2(meta);
        return;
      }
      if(DB_LAZY_ITEM_KEYS.has(key) && meta._lazyItemsV2 && !IS_ADMIN_PAGE){
        out[key] = await loadLazyItemSummariesV2(meta, key);
        return;
      }
      if(DB_LAZY_ITEM_KEYS.has(key) && meta._lazyItemsV2 && IS_ADMIN_PAGE){
        out[key] = await loadLazyItemsFullV2(meta, key);
        return;
      }

      if(Array.isArray(itemIds[key])){
        const snaps = await mapLimit(itemIds[key], 4, itemId => getDoc(dbItemDoc(key, itemId)));
        out[key] = snaps.map((snap, idx) => {
          if(!snap.exists()){
            throw new Error(`Missing DB item: ${key}[${itemIds[key][idx]}]`);
          }
          return JSON.parse(snap.data().json || 'null');
        }).filter(Boolean);
        return;
      }

      const count = Math.max(0, Number(counts[key]) || 0);
      if(!count){
        out[key] = defaultDbValueForKey(key);
        return;
      }

      const snaps = await mapLimit(
        Array.from({ length: count }, (_, idx) => idx),
        4,
        idx => getDoc(dbChunkDoc(key, idx))
      );
      const json = snaps.map((snap, idx) => {
        if(!snap.exists()){
          throw new Error(`Missing DB chunk: ${key}[${idx}]`);
        }
        return snap.data().json || '';
      }).join('');
      out[key] = JSON.parse(json || 'null') ?? defaultDbValueForKey(key);
    } catch(err) {
      console.warn(`[FB] load ${key} failed; using fallback value:`, err);
      if(key === 'historyStories' && !IS_ADMIN_PAGE){
        try {
          const legacyJson = await loadLegacyHistoryChunks();
          out[key] = summarizeHistoryJson(legacyJson);
          return;
        } catch(legacyErr) {
          console.warn('[FB] history legacy fallback failed:', legacyErr);
        }
      }
      out[key] = defaultDbValueForKey(key);
    }
  }));

  _dbPartCounts = { ...counts };
  _dbPartHashes = { ...hashes };
  _dbItemIds = { ...itemIds };
  _dbItemHashes = { ...itemHashes };
  _casingTypeIds = Array.isArray(meta._casingTypeIds) ? [...meta._casingTypeIds] : [];
  _casingTypeHashes = { ...(meta._casingTypeHashes || {}) };
  _casingVariantIds = { ...(meta._casingVariantIds || {}) };
  _casingVariantHashes = { ...(meta._casingVariantHashes || {}) };
  _historyStoryIds = Array.isArray(meta._historyStoryIds) ? [...meta._historyStoryIds] : [];
  _historyStoryHashes = { ...(meta._historyStoryHashes || {}) };
  _lazyItemIds = { ...(meta._lazyItemIds || {}) };
  _lazyItemHashes = { ...(meta._lazyItemHashes || {}) };
  return out;
}

// Track which types have had variants fully loaded
const _casingVariantsLoaded = new Set();

async function loadCasingTypesV2(meta){
  const typeIds = Array.isArray(meta._casingTypeIds) ? meta._casingTypeIds : [];
  const variantIds = meta._casingVariantIds || {};

  // Phase 1: load ALL type metadata in parallel (no variants yet)
  // This is fast — just one Firestore doc per type
  const types = await mapLimit(typeIds, 4, async typeId => {
    try {
      const type = JSON.parse(await readJsonRecord(
        casingTypeDoc(typeId),
        idx => casingTypeChunkDoc(typeId, idx),
        `casing type: ${typeId}`
      ));
      const ids = Array.isArray(variantIds[typeId]) ? variantIds[typeId] : [];
      type._variantIds = ids;
      _casingVariantIds[String(typeId)] = ids;
      if(!Array.isArray(type.variants)) type.variants = [];
      return type;
    } catch(err) {
      console.warn('[FB] casing type skipped:', typeId, err);
      return null;
    }
  });

  return types.filter(Boolean);
}

// Phase 2: load variants for a specific casing type on-demand
async function ensureCasingVariants(typeId, opts={}){
  const key = String(typeId);
  if(opts.force) _casingVariantsLoaded.delete(key);
  if(_casingVariantsLoaded.has(key)){
    // Verify the variants are actually present in the current _db.
    // _db may have been replaced by loadSplitDB (Phase1) between the time this key
    // was added and now — Phase1 sets ty.variants=[] even though we loaded them before.
    const dbCheck = getDB();
    const tyCheck = (dbCheck.casingTypes||[]).find(t=>String(t.id)===key);
    if(tyCheck && Array.isArray(tyCheck.variants) && tyCheck.variants.length > 0){
      return; // truly loaded — variants exist in current _db ✓
    }
    // Stale marker: _db was replaced by Phase1 after we loaded, variants are gone.
    // Remove marker and fall through to reload from Firestore.
    _casingVariantsLoaded.delete(key);
  }

  const db = getDB();
  const ty = (db.casingTypes||[]).find(t=>String(t.id)===key);
  if(!ty){ _casingVariantsLoaded.add(key); return; }

  // Get variant IDs from cache (set during loadCasingTypesV2 Phase 1)
  // Try both string and number key to handle schema variations
  const meta = _dbMeta || {};
  const metaVariantIds = meta._casingVariantIds || {};
  const variantIds =
    (_casingVariantIds[key]?.length    ? _casingVariantIds[key]    : null) ||
    (_casingVariantIds[typeId]?.length ? _casingVariantIds[typeId] : null) ||
    (metaVariantIds[key]?.length       ? metaVariantIds[key]       : null) ||
    (metaVariantIds[typeId]?.length    ? metaVariantIds[typeId]    : null) ||
    (ty._variantIds?.length            ? ty._variantIds            : null) ||
    [];

  if(!variantIds.length){
    // No variants in index — type genuinely has no styles yet
    ty.variants = [];
    _casingVariantsLoaded.add(key);
    return;
  }

  // Load variants by their known IDs
  const variants = await Promise.all(variantIds.map(async variantId => {
    return JSON.parse(await readJsonRecord(
      casingVariantDoc(typeId, variantId),
      idx => casingVariantChunkDoc(typeId, variantId, idx),
      `casing style: ${typeId}/${variantId}`
    ));
  }));

  // CRITICAL: Re-read ty from current _db after the await.
  // During Promise.all above, onSnapshot may have fired and replaced
  // _db.casingTypes with new objects (via loadSplitDB Phase 1).
  // Writing to the stale `ty` reference would have no effect on the live _db.
  const currentDb = getDB();
  const currentTy = (currentDb.casingTypes||[]).find(t=>String(t.id)===key);
  if(currentTy){
    currentTy.variants = variants;
    currentTy._variantIds = variantIds;
  } else {
    // _db was replaced but new casingTypes don't have this type yet — write to stale ref as fallback
    ty.variants = variants;
    ty._variantIds = variantIds;
  }
  _casingVariantIds[key] = variantIds;
  _casingVariantsLoaded.add(key);
  notifyDBReady();
}

async function loadHistorySummariesV2(meta){
  const storyIds = Array.isArray(meta._historyStoryIds) ? meta._historyStoryIds : [];
  const summaries = await mapLimit(storyIds, 4, async storyId => {
    try {
      const snap = await getDoc(historyStorySummaryDoc(storyId));
      if(snap.exists()){
        return JSON.parse(snap.data().json || 'null');
      }
      console.warn('[FB] missing history summary, reading full article:', storyId);
    } catch(err) {
      console.warn('[FB] history summary read failed, reading full article:', storyId, err);
    }
    try {
      const full = JSON.parse(await readJsonRecord(
        historyStoryDoc(storyId),
        idx => historyStoryChunkDoc(storyId, idx),
        `history story: ${storyId}`
      ));
      return historySummaryFromArticle(full);
    } catch(err) {
      console.warn('[FB] history full fallback failed:', storyId, err);
      return null;
    }
  });
  return summaries.filter(Boolean);
}

async function loadHistorySummariesV2OrFallback(meta){
  try {
    const summaries = await loadHistorySummariesV2(meta);
    if(summaries.length) return summaries;
  } catch(err) {
    console.warn('[FB] history V2 summaries failed:', err);
  }
  try {
    const fullStories = await loadHistoryStoriesFullV2(meta);
    const summaries = fullStories.map(historySummaryFromArticle).filter(Boolean);
    if(summaries.length) return summaries;
  } catch(err) {
    console.warn('[FB] history V2 full summary fallback failed:', err);
  }
  const legacyJson = await loadLegacyHistoryChunks();
  return summarizeHistoryJson(legacyJson);
}

async function loadHistoryStoriesFullV2(meta){
  const storyIds = Array.isArray(meta._historyStoryIds) ? meta._historyStoryIds : [];
  const stories = await mapLimit(storyIds, IS_ADMIN_PAGE ? 3 : 2, async storyId => {
    try {
      return JSON.parse(await readJsonRecord(
        historyStoryDoc(storyId),
        idx => historyStoryChunkDoc(storyId, idx),
        `history story: ${storyId}`
      ));
    } catch(err) {
      console.warn('[FB] history full story skipped:', storyId, err);
      return null;
    }
  });
  return stories.filter(Boolean);
}

async function loadLazyItemSummariesV2(meta, key){
  const idsMap = meta._lazyItemIds || {};
  const itemIds = Array.isArray(idsMap[key]) ? idsMap[key] : [];
  const items = await mapLimit(itemIds, 4, async itemId => {
    try {
      const snap = await getDoc(lazyItemSummaryDoc(key, itemId));
      if(snap.exists()){
        return JSON.parse(snap.data().json || 'null');
      }
      console.warn(`[FB] missing ${key} summary, reading full item:`, itemId);
    } catch(err) {
      console.warn(`[FB] ${key} summary read failed, reading full item:`, itemId, err);
    }
    try {
      const full = JSON.parse(await readJsonRecord(
        lazyItemDoc(key, itemId),
        idx => lazyItemChunkDoc(key, itemId, idx),
        `${key} item: ${itemId}`
      ));
      return lazyItemSummary(full);
    } catch(err) {
      console.warn(`[FB] ${key} full fallback failed:`, itemId, err);
      return null;
    }
  });
  return items.filter(Boolean);
}

async function loadLazyItemsFullV2(meta, key){
  const idsMap = meta._lazyItemIds || {};
  const itemIds = Array.isArray(idsMap[key]) ? idsMap[key] : [];
  const items = await mapLimit(itemIds, IS_ADMIN_PAGE ? 3 : 2, async itemId => {
    try {
      return JSON.parse(await readJsonRecord(
        lazyItemDoc(key, itemId),
        idx => lazyItemChunkDoc(key, itemId, idx),
        `${key} item: ${itemId}`
      ));
    } catch(err) {
      console.warn(`[FB] ${key} full item skipped:`, itemId, err);
      return null;
    }
  });
  return items.filter(Boolean);
}

async function readJsonRecord(ref, chunkRefForIndex, label){
  const snap = await getDoc(ref);
  if(!snap.exists()){
    throw new Error(`Missing ${label}`);
  }
  const data = snap.data() || {};
  if(!data._chunked){
    return data.json || '{}';
  }
  const count = Math.max(0, Number(data._chunkCount) || 0);
  const parts = await readJsonRecordChunks(chunkRefForIndex, count, label);
  let json = parts.join('');
  if(canParseJson(json)) return json;

  // Some records were saved while the large-record migration was still
  // changing. If the stored _chunkCount is too low, continue reading any
  // extra chunk docs that exist so one stale counter doesn't break the admin.
  const originalJson = json;
  for(let idx = count; idx < count + 40; idx++){
    const extra = await getDoc(chunkRefForIndex(idx));
    if(!extra.exists()) break;
    json += extra.data().json || '';
    if(canParseJson(json)) return json;
  }
  return originalJson;
}

async function readJsonRecordChunks(chunkRefForIndex, count, label){
  const snaps = await Promise.all(
    Array.from({ length: count }, (_, idx) => getDoc(chunkRefForIndex(idx)))
  );
  return snaps.map((partSnap, idx) => {
    if(!partSnap.exists()){
      throw new Error(`Missing ${label} chunk ${idx}`);
    }
    return partSnap.data().json || '';
  });
}

function canParseJson(value){
  try {
    JSON.parse(value);
    return true;
  } catch(err) {
    return false;
  }
}

// Subscribe to realtime updates from Firestore.
// Whenever the manifest changes, _db is rebuilt and listeners are notified.
onSnapshot(DB_DOC, async (snap) => {
  const seq = ++_snapshotSeq;
  try {
    if(snap.exists()){
      const data = snap.data();
      _dbMeta = data && data._splitVersion ? data : null;
      _loadedKeys = new Set();
      // Reset variant cache on DB reload so stale "not found" entries don't persist
      _casingVariantsLoaded.clear();
      _historySummaryCache = null;
      _historyStoriesJsonCache = '';
      _lazyItemIds = {};
      _lazyItemHashes = {};
      if(data && data._splitVersion){
        const keys = initialLoadKeys();
        _db = await loadSplitDB(data, keys);
        keys.forEach(k => _loadedKeys.add(k));
      } else {
        _db = data;
        DB_SPLIT_KEYS.forEach(k => _loadedKeys.add(k));
      }
    } else {
      _db = null;   // doc doesn't exist yet — first run
      _dbMeta = null;
      _loadedKeys = new Set();
      _dbPartCounts = {};
      _dbPartHashes = {};
      _dbItemIds = {};
      _dbItemHashes = {};
      _casingTypeIds = [];
      _casingTypeHashes = {};
      _casingVariantIds = {};
      _casingVariantHashes = {};
      _historyStoryIds = [];
      _historyStoryHashes = {};
      _lazyItemIds = {};
      _lazyItemHashes = {};
      _historySummaryCache = null;
      _historyStoriesJsonCache = '';
    }
    if(seq !== _snapshotSeq) return;
    notifyDBReady();
  } catch(err){
    console.error('[FB] DB load failed:', err);
    if(seq !== _snapshotSeq) return;
    _db = null;
    notifyDBReady();
  }
}, (err) => {
  console.error('[FB] onSnapshot error:', err);
  // Still mark as ready so the page can proceed (with no data)
  if(!_isReady){
    _isReady = true;
    _readyResolve(null);
  }
});

function ready(){ return _readyPromise; }

// ─── STORAGE API ───────────────────────────────────────────────────────────
//  Upload a File (or Blob, or data URL) to a path under /uploads/.
//  Returns the public download URL.
//
//  Image files are automatically resized & re-encoded to WebP before upload:
//    - Max dimension: 1920px (preserves aspect ratio)
//    - Quality: 0.85 (visually lossless but ~70-90% smaller than JPEG)
//    - Non-image files (.glb, .gltf, PDFs, etc.) upload as-is.
//
//  This usually cuts a 5MB phone photo to 200-400KB → uploads in seconds
//  on mobile networks and loads much faster for visitors.
// ─── STORAGE ORGANIZATION (for NEW uploads only) ────────────────────────────
// Storage folders are for organization only.
// Firestore is the source of truth.
// Never determine relationships using Storage paths.
// Existing files are NOT moved — URLs remain valid.
//
// New uploads use: uploads-v2/{category}/{filename}
// Categories: amulets/ accessories/ casing/covers/ casing/styles/
//             casing/gallery/ projects/ reviews/ history-stories/ social/
// ──────────────────────────────────────────────────────────────────────────────
async function uploadFile(fileOrBlob, pathHint){
  const uploaded = await uploadImageSet(fileOrBlob, pathHint, { stringOnly: true });
  return uploaded && uploaded.url ? uploaded.url : uploaded;
}

async function uploadImageSet(fileOrBlob, pathHint, opts={}){
  let blob;
  if(typeof fileOrBlob === 'string' && fileOrBlob.startsWith('data:')){
    const res = await fetch(fileOrBlob);
    blob = await res.blob();
  } else {
    blob = fileOrBlob;
  }

  // Image optimisation: resize big images + convert to WebP. Anything that
  // isn't an image (or is already small) skips this and uploads unchanged.
  //
  // We also explicitly detect HEIC/HEIF by filename or empty type because
  // iPhone Safari often gives `blob.type === ''` for HEIC uploads instead
  // of `image/heic`. Without this check, HEIC files would slip past the
  // image-detection and upload as raw binary the browser can't display.
  const looksLikeImage =
    (blob.type && blob.type.startsWith('image/') && !blob.type.includes('svg')) ||
    (blob.name && /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp)$/i.test(blob.name)) ||
    blob.type === ''; // assume image if no MIME — optimiseImage will validate

  if(looksLikeImage){
    try {
      if(opts.stringOnly){
        blob = await optimiseImage(blob);
      } else {
        return await createImageSet(blob, pathHint);
      }
    } catch(err){
      console.warn('[FB] image optimise failed:', err);
      // If the source is a format browsers can't display (HEIC/HEIF), do NOT
      // upload the original — it would just sit in storage unviewable. Surface
      // the error to the caller so they can show a clear message.
      const orig = fileOrBlob;
      const isUnviewable =
        (orig && orig.type === 'image/heic') ||
        (orig && orig.type === 'image/heif') ||
        (orig && orig.name && /\.(heic|heif)$/i.test(orig.name));
      if(isUnviewable){
        throw err;  // propagate — admin UI will show the message
      }
      // For other formats (jpg/png) it's safe to upload the original
    }
  }

  const url = await uploadBlob(blob, pathHint);
  return opts.stringOnly ? url : { url, type: blob.type || '', bytes: blob.size || 0 };
}

async function uploadBlob(blob, pathHint){
  const ext = guessExtFromBlobOrHint(blob, pathHint);
  const safeHint = (pathHint || 'file').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
  const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeHint}.${ext}`;
  const ref = storageRef(stg, `uploads/${fname}`);
  await uploadBytes(ref, blob, blob.type ? {
    contentType: blob.type,
    // Long browser cache (1 year) — files are content-addressed via the
    // random filename, so they never change after upload.
    cacheControl: 'public,max-age=31536000,immutable',
  } : undefined);
  const fbUrl = await getDownloadURL(ref);
  // Direct Firebase Storage URL — bucket is in Singapore, so Asian
  // visitors get sub-100ms delivery without any CDN proxy.
  return fbUrl;
}

async function createImageSet(blob, pathHint){
  const original = await optimiseImage(blob, 1920);
  const fullUrl = await uploadBlob(original, pathHint);
  const set = {
    url: fullUrl,
    type: original.type || '',
    bytes: original.size || 0,
  };
  try {
    const medium = await optimiseImage(blob, 960);
    set.medium = await uploadBlob(medium, `m_${pathHint || 'image'}`);
    set.mediumBytes = medium.size || 0;
  } catch(err){
    console.warn('[FB] medium thumbnail failed:', err);
  }
  try {
    const thumb = await optimiseImage(blob, 480);
    set.thumb = await uploadBlob(thumb, `t_${pathHint || 'image'}`);
    set.thumbBytes = thumb.size || 0;
  } catch(err){
    console.warn('[FB] thumbnail failed:', err);
  }
  return set;
}

// No-op rewriter kept for backwards compatibility with index.html/admin.html.
// (Older versions of this file rewrote URLs to/from ImageKit and to/from a
// legacy bucket — neither applies anymore now that everything's in one
// fresh Asia project.)
window._rewriteLegacyImageUrl = (url) => url;

// Resize & re-encode an image Blob.
//   - Keeps aspect ratio
//   - Caps longest side at MAX_DIM
//   - Output: WebP at QUALITY (PNG with transparency uses 'image/png' instead)
// ─── WATERMARK ────────────────────────────────────────────────────────────────
// Loads Allura from Google Fonts once, then draws a semi-transparent text
// watermark at middle-right on any canvas context.
// All measurements scale proportionally with image width.

let _alluraLoaded = false;
async function _ensureAlluraFont(){
  if(_alluraLoaded) return;
  if(document.fonts && document.fonts.check && document.fonts.check('12px Allura')) {
    _alluraLoaded = true; return;
  }
  if(!document.querySelector('link[href*="Allura"]')){
    await new Promise((res, rej) => {
      const lnk = document.createElement('link');
      lnk.rel = 'stylesheet';
      lnk.href = 'https://fonts.googleapis.com/css2?family=Allura&display=swap';
      lnk.onload = res; lnk.onerror = rej;
      document.head.appendChild(lnk);
    });
  }
  if(document.fonts && document.fonts.load){
    await Promise.race([
      document.fonts.load('48px Allura'),
      new Promise(r => setTimeout(r, 4000)),
    ]);
  } else {
    await new Promise(r => setTimeout(r, 800));
  }
  _alluraLoaded = true;
}

// Draw watermark onto an existing 2D canvas context (w × h are canvas dimensions)
async function _drawWatermarkOnCtx(ctx, w, h){
  await _ensureAlluraFont();
  const fontSize  = Math.round(w * 0.048);
  const rightEdge = Math.round(w * 0.03);
  const rad       = (-10 * Math.PI) / 180;

  ctx.save();
  ctx.translate(w - rightEdge, h / 2);
  ctx.rotate(rad);
  ctx.font         = `${fontSize}px Allura`;
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';
  ctx.shadowColor   = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur    = Math.max(2, Math.round(fontSize * 0.12));
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.globalAlpha  = 0.52;
  ctx.fillStyle    = '#ffffff';
  ctx.fillText('YingyingyingSG', 0, 0);
  ctx.restore();
}

// Public: apply watermark to a Blob, returns JPEG Blob at 90% quality.
// Used by the migration tool and exposed as FB.applyWatermark.
async function applyWatermark(blob){
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch(_) {
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error("Image load failed: " + (e?.message || "onerror"))); };
      img.src = url;
    });
  }
  const w = bitmap.width  || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  await _drawWatermarkOnCtx(ctx, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => {
      if(b) resolve(b);
      else   reject(new Error('applyWatermark: canvas.toBlob failed'));
    }, 'image/jpeg', 0.90);
  });
}
// ─── END WATERMARK ────────────────────────────────────────────────────────────

async function optimiseImage(blob, maxDim=1920){
  const MAX_DIM = maxDim;     // longest side
  const QUALITY = 0.85;       // 0–1; 0.85 looks identical to humans for most photos

  // ─── HEIC / HEIF handling ───
  // Apple devices (iPhone, iPad) save photos as HEIC by default. Most
  // desktop browsers (Chrome, Firefox, Edge) CANNOT decode HEIC at all —
  // createImageBitmap throws, <img> shows broken. The only reliable fix
  // is to convert HEIC → JPEG before processing using a dedicated library.
  //
  // We lazy-load heic2any from a CDN only when needed, to keep the page's
  // initial bundle small. The library produces an ordinary Blob that
  // createImageBitmap can then read.
  const isHeic =
    blob.type === 'image/heic' ||
    blob.type === 'image/heif' ||
    blob.type === '' ||  // some browsers leave HEIC type blank
    (blob.name && /\.(heic|heif)$/i.test(blob.name));

  if(isHeic){
    console.log('[FB] HEIC detected, converting to JPEG…', {
      type: blob.type,
      size: blob.size,
      name: blob.name,
    });
    try {
      // Load heic2any from CDN if not already loaded. Try jsDelivr first,
      // fall back to unpkg if it fails (rare network issue).
      if(!window.heic2any){
        console.log('[FB] loading heic2any library…');
        const tryLoad = (src) => new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = src;
          s.onload = () => { console.log('[FB] heic2any loaded from', src); res(); };
          s.onerror = () => rej(new Error('failed to load ' + src));
          document.head.appendChild(s);
        });
        try {
          await tryLoad('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js');
        } catch(e){
          console.warn('[FB] jsDelivr failed, trying unpkg…');
          await tryLoad('https://unpkg.com/heic2any@0.0.4/dist/heic2any.min.js');
        }
        if(!window.heic2any){
          throw new Error('heic2any loaded but window.heic2any is undefined');
        }
      }
      console.log('[FB] calling heic2any…');
      const converted = await window.heic2any({
        blob: blob,
        toType: 'image/jpeg',
        quality: 0.92,
      });
      // heic2any can return Blob or Blob[]; coalesce to single Blob
      blob = Array.isArray(converted) ? converted[0] : converted;
      console.log('[FB] HEIC → JPEG conversion done, size:', blob.size, 'type:', blob.type);
    } catch(e){
      console.error('[FB] HEIC conversion failed:', e);
      throw new Error(
        'HEIC conversion failed: ' + (e.message || e) +
        '. Please check internet connection or use a JPEG/PNG image instead.'
      );
    }
  }

  // Decode the source image. We use createImageBitmap when available — it's
  // faster than <img> and avoids EXIF orientation issues on most browsers.
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch(_) {
    // Fallback: <img> + ObjectURL
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error("Image load failed: " + (e?.message || "onerror"))); };
      img.src = url;
    });
  }

  const srcW = bitmap.width || bitmap.naturalWidth;
  const srcH = bitmap.height || bitmap.naturalHeight;

  // If the image is already smaller than the cap AND the source is already
  // an efficient format, skip — re-encoding could even make it bigger.
  const alreadySmall = srcW <= MAX_DIM && srcH <= MAX_DIM;
  const isEfficient  = blob.type === 'image/webp';
  if(alreadySmall && isEfficient){
    return blob;
  }

  // Compute target dimensions preserving aspect ratio
  let dstW = srcW, dstH = srcH;
  if(srcW > MAX_DIM || srcH > MAX_DIM){
    const r = Math.min(MAX_DIM / srcW, MAX_DIM / srcH);
    dstW = Math.round(srcW * r);
    dstH = Math.round(srcH * r);
  }

  // Render to canvas at target size
  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext('2d');
  // Better quality for downscale
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, dstW, dstH);

  // ── Watermark (applied to every product image at upload time) ──
  try { await _drawWatermarkOnCtx(ctx, dstW, dstH); }
  catch(e){ console.warn('[FB] watermark failed, continuing without:', e); }

  // PNG with transparency? Keep PNG to avoid alpha loss
  const hasAlpha = blob.type === 'image/png' || blob.type === 'image/gif';
  const outType  = hasAlpha ? 'image/png' : 'image/webp';

  // Encode
  const result = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if(b) resolve(b); else reject(new Error('canvas.toBlob failed'));
    }, outType, QUALITY);
  });

  // Safety check: if encoding made it BIGGER (rare on small files), use original
  if(result.size >= blob.size && alreadySmall){
    return blob;
  }

  console.log(`[FB] image optimised: ${(blob.size/1024).toFixed(0)}KB → ${(result.size/1024).toFixed(0)}KB ` +
              `(${srcW}×${srcH} → ${dstW}×${dstH}, ${outType})`);
  return result;
}

function guessExtFromBlobOrHint(blob, pathHint){
  // Prefer the blob's actual type (after optimisation it might be WebP even
  // though the user uploaded a JPG).
  const t = blob.type || '';
  if(t.includes('webp')) return 'webp';
  if(t.includes('png')) return 'png';
  if(t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if(t.includes('gif')) return 'gif';
  if(t.includes('svg')) return 'svg';
  if(t.includes('gltf-binary')) return 'glb';
  if(t.includes('gltf')) return 'gltf';
  // Last resort: use the hint extension
  if(pathHint && pathHint.includes('.')){
    return pathHint.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g,'');
  }
  return 'bin';
}

async function deleteFile(url){
  if(url && typeof url === 'object'){
    const urls = [url.url, url.medium, url.thumb].filter(Boolean);
    await Promise.all(urls.map(u => deleteFile(u).catch(() => {})));
    return;
  }
  // Only delete if it's actually a Firebase Storage URL
  if(!url || typeof url !== 'string') return;
  if(!url.includes('firebasestorage.googleapis.com') && !url.includes('firebasestorage.app')){
    return;   // not our file
  }
  try {
    // Extract path from URL — URLs look like:
    // https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encoded-path>?alt=media&token=...
    const m = url.match(/\/o\/([^?]+)/);
    if(!m) return;
    const path = decodeURIComponent(m[1]);
    await deleteObject(storageRef(stg, path));
  } catch(err){
    // 404 etc. — don't crash, just log
    console.warn('[FB] deleteFile:', err.code || err.message);
  }
}

// ─── AUTH API ──────────────────────────────────────────────────────────────
async function signInUser(email, password){
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

async function signOutUser(){
  await signOut(auth);
}

function onAuthChange(cb){
  _authListeners.push(cb);
  return onAuthStateChanged(auth, cb);
}

function currentUser(){ return auth.currentUser; }

// ─── CUSTOMER LOGIN (Google / Facebook / Email+Password) ───────────────────
// Separate from admin email/password login above — this is for shoppers.
// Facebook requires an App ID configured in Firebase Console → Authentication
// → Sign-in method → Facebook (see CHECKOUT_SETUP.md).
// If a user tries to sign in with a provider (Google/Facebook) but their
// email is already registered via a *different* provider, Firebase blocks
// the sign-in with `auth/account-exists-with-different-credential` (Firebase
// projects default to "one account per email address"). We resolve this by
// finding which method the email already uses and linking the new
// credential onto that existing account instead of failing outright.
async function _resolveAccountExistsError(err, attemptedProvider){
  if(err?.code !== 'auth/account-exists-with-different-credential') throw err;
  const email = err.customData?.email;
  const pendingCred = attemptedProvider === 'facebook'
    ? FacebookAuthProvider.credentialFromError(err)
    : GoogleAuthProvider.credentialFromError(err);
  if(!email || !pendingCred) throw err;
  const methods = await fetchSignInMethodsForEmail(auth, email);
  if(methods.includes('google.com') && attemptedProvider !== 'google'){
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    await linkWithCredential(result.user, pendingCred);
    return result.user;
  }
  if(methods.includes('facebook.com') && attemptedProvider !== 'facebook'){
    const result = await signInWithPopup(auth, new FacebookAuthProvider());
    await linkWithCredential(result.user, pendingCred);
    return result.user;
  }
  if(methods.includes('password')){
    // Can't link silently — need the user's password. Surface a distinct
    // error so the UI can prompt for it, then call
    // linkPendingCredentialWithPassword() to finish linking.
    const linkErr = new Error('Account exists — password needed to link');
    linkErr.code = 'custom/link-needs-password';
    linkErr.email = email;
    linkErr.pendingCred = pendingCred;
    throw linkErr;
  }
  throw err;
}
async function signInWithGoogle(){
  const provider = new GoogleAuthProvider();
  try{
    const cred = await signInWithPopup(auth, provider);
    await mergeGuestCartIntoUser(cred.user.uid);
    return cred.user;
  }catch(err){
    const user = await _resolveAccountExistsError(err, 'google');
    await mergeGuestCartIntoUser(user.uid);
    return user;
  }
}
async function signInWithFacebook(){
  const provider = new FacebookAuthProvider();
  try{
    const cred = await signInWithPopup(auth, provider);
    await mergeGuestCartIntoUser(cred.user.uid);
    return cred.user;
  }catch(err){
    const user = await _resolveAccountExistsError(err, 'facebook');
    await mergeGuestCartIntoUser(user.uid);
    return user;
  }
}
// Completes account linking for the 'password' branch above — called by the
// UI after the user enters the password for their existing email/password account.
async function linkPendingCredentialWithPassword(email, password, pendingCred){
  const cred = await signInWithEmailAndPassword(auth, email, password);
  await linkWithCredential(cred.user, pendingCred);
  await mergeGuestCartIntoUser(cred.user.uid);
  return cred.user;
}
async function customerSignUpWithEmail(email, password){
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await mergeGuestCartIntoUser(cred.user.uid);
  return cred.user;
}
async function customerSignInWithEmail(email, password){
  const cred = await signInWithEmailAndPassword(auth, email, password);
  await mergeGuestCartIntoUser(cred.user.uid);
  return cred.user;
}
async function customerSignOut(){
  await signOut(auth);
}

// ─── CHECKOUT (calls Cloud Function — see functions/index.js) ──────────────
// The server (Cloud Function) re-reads each item's real price from
// Firestore and recomputes the total itself — the client-sent price is
// NEVER trusted for the actual charge amount.
async function createPaymentIntent(shipping){
  const call = httpsCallable(fns, 'createPaymentIntent');
  const res = await call({ cartKey: cartKey(), shipping });
  return res.data; // { clientSecret, orderId, amount }
}

// ─── ORDER HISTORY (customer-facing) ────────────────────────────────────────
// Requires login — the Firestore rule for `orders` only allows a client to
// read documents where `uid` matches their own auth uid (or an admin).
// Guest checkouts (uid: null) are not readable by any client, only admin.
async function getMyOrders(){
  const user = auth.currentUser;
  if(!user) return [];
  try{
    const q = query(collection(fs, 'orders'), where('uid', '==', user.uid), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }catch(err){
    console.error('[FB] getMyOrders failed:', err);
    return [];
  }
}

// ─── ADMIN ROLES ───────────────────────────────────────────────────────────
// Each admin is stored as a doc under `admins/{lowercased-email}` with
// shape: { email, role, addedBy, addedAt, displayName? }
// Roles in order of decreasing privilege:
//   super_admin — full access; manages other admins
//   admin       — full CRUD; cannot manage admins or see Settings
//   editor      — can create/edit but not delete; no Settings, no admin mgmt
//
// IMPORTANT: enforcing access control here is convenience, not security.
// Real enforcement lives in Firestore Security Rules — without them an
// "editor" could still bypass the UI by calling the SDK directly.

const ADMINS_COL = 'admins';
const adminEmailKey = (email) => (email || '').toLowerCase().trim();

async function getAdminRecord(email){
  const key = adminEmailKey(email);
  if(!key) return null;
  try {
    const snap = await getDoc(doc(fs, ADMINS_COL, key));
    return snap.exists() ? { id: key, ...snap.data() } : null;
  } catch(e){
    console.warn('[FB] getAdminRecord failed:', e);
    return null;
  }
}

async function listAdmins(){
  try {
    const snap = await getDocs(collection(fs, ADMINS_COL));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e){
    console.warn('[FB] listAdmins failed:', e);
    return [];
  }
}

async function setAdminRecord(email, data){
  const key = adminEmailKey(email);
  if(!key) throw new Error('email is required');
  const payload = {
    email: key,
    role: data.role || 'editor',
    displayName: data.displayName || '',
    addedBy: data.addedBy || (auth.currentUser ? auth.currentUser.email : 'system'),
    addedAt: data.addedAt || new Date().toISOString(),
    ...data,
  };
  await setDoc(doc(fs, ADMINS_COL, key), payload, { merge: true });
  return payload;
}

async function deleteAdminRecord(email){
  const key = adminEmailKey(email);
  if(!key) return;
  await deleteDoc(doc(fs, ADMINS_COL, key));
}

// Bootstrap: if there are NO admins yet, the first email to sign in
// becomes the super_admin. After that, every login must match an
// existing record. This lets the very first deploy work without
// needing manual Firestore seeding.
async function ensureFirstSuperAdmin(email){
  const key = adminEmailKey(email);
  if(!key) return null;
  const existing = await getAdminRecord(key);
  if(existing) return existing;
  const all = await listAdmins();
  if(all.length === 0){
    console.log('[FB] No admins yet — promoting first signer to super_admin:', key);
    return await setAdminRecord(key, { role: 'super_admin', addedBy: 'bootstrap' });
  }
  return null;
}

// ─── CUSTOMER REVIEW SUBMISSIONS ───────────────────────────────────────────
// Customers (not logged in) can submit reviews from the storefront. To keep
// the main DB safe, submissions go into a SEPARATE collection that Security
// Rules allow anyone to `create` but only admins to `read`/`delete`. Nothing
// here can touch `app/db`. Admins review each submission and, on approval,
// copy it into db.reviews (the public list) and delete the submission.
//
// Submission shape:
//   { name, anonymous, rating, text, imgs[], createdAt }
const REVIEW_SUBMISSIONS_COL = 'reviewSubmissions';

// Called from the storefront. `imgs` should already be uploaded URLs
// (use FB.uploadFile first). Returns the new submission id.
async function submitReview(data){
  const payload = {
    name: (data.name || '').toString().slice(0, 80),
    anonymous: !!data.anonymous,
    rating: Math.max(0, Math.min(5, Number(data.rating) || 0)),
    text: (data.text || '').toString().slice(0, 2000),
    imgs: Array.isArray(data.imgs) ? data.imgs.slice(0, 6) : [],
    createdAt: serverTimestamp(),
  };
  const ref = await addDoc(collection(fs, REVIEW_SUBMISSIONS_COL), payload);
  return ref.id;
}

// Admin only — list all pending submissions (oldest first).
async function listReviewSubmissions(){
  try {
    const q = query(collection(fs, REVIEW_SUBMISSIONS_COL), orderBy('createdAt', 'asc'));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e){
    // orderBy fails if a doc is missing createdAt — fall back to unordered.
    try {
      const snap = await getDocs(collection(fs, REVIEW_SUBMISSIONS_COL));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch(e2){
      console.warn('[FB] listReviewSubmissions failed:', e2);
      return [];
    }
  }
}

// Admin only — remove a submission after approving or rejecting it.
async function deleteReviewSubmission(id){
  if(!id) return;
  await deleteDoc(doc(fs, REVIEW_SUBMISSIONS_COL, id));
}

// ─── EXPOSE GLOBALLY ───────────────────────────────────────────────────────
// ─── HISTORY & STORIES CRUD ────────────────────────────────────────────────
// historyStories is stored as db.historyStories[] — same pattern as reviews/amulets.
// Each article: { id, title, slug, category, excerpt, content, coverImage,
//   videoUrl, gallery:[], featured, status:'published'|'draft', seoTitle, seoDescription,
//   createdAt, updatedAt }

function hsGenId(arr){
  const ids = (Array.isArray(arr) ? arr : []).map(x => Number(x.id)||0);
  return ids.length ? Math.max(...ids) + 1 : 1;
}

function hsGetAll(){
  return (window.FB.getDB().historyStories || []);
}

async function hsSaveAll(articles){
  const db = window.FB.getDB();
  db.historyStories = articles;
  await window.FB.saveDB(db);
}

async function hsAddArticle(data){
  const db = window.FB.getDB();
  if(!db.historyStories) db.historyStories = [];
  const id = hsGenId(db.historyStories);
  const article = {
    id,
    title: data.title || '',
    slug:  data.slug  || '',
    category: data.category || 'guides-articles',
    excerpt: data.excerpt || '',
    content: data.content || '',
    coverImage: data.coverImage || '',
    videoUrl: data.videoUrl || '',
    gallery: Array.isArray(data.gallery) ? data.gallery : [],
    featured: !!data.featured,
    status: data.status || 'published',
    seoTitle: data.seoTitle || '',
    seoDescription: data.seoDescription || '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.historyStories.push(article);
  await window.FB.saveDB(db);
  return article;
}

async function hsUpdateArticle(id, data){
  const db = window.FB.getDB();
  if(!db.historyStories) db.historyStories = [];
  const idx = db.historyStories.findIndex(x => String(x.id) === String(id));
  if(idx < 0) throw new Error('Article not found: ' + id);
  db.historyStories[idx] = {
    ...db.historyStories[idx],
    ...data,
    id: db.historyStories[idx].id,
    createdAt: db.historyStories[idx].createdAt,
    updatedAt: Date.now(),
  };
  await window.FB.saveDB(db);
  return db.historyStories[idx];
}

async function hsDeleteArticle(id){
  const db = window.FB.getDB();
  if(!db.historyStories) return;
  db.historyStories = db.historyStories.filter(x => String(x.id) !== String(id));
  await window.FB.saveDB(db);
}

let _historyStoriesJsonCache = '';
let _historySummaryCache = null;

async function loadHistoryStoriesJson(){
  if(_historyStoriesJsonCache && _historyStoriesJsonCache !== '[]') return _historyStoriesJsonCache;
  if(!_isReady) await _readyPromise;
  // V2 path: stories stored in separate docs — use ensureDBKeys, not legacy chunks
  const meta = _dbMeta || {};
  if(meta._historyStoriesV2){
    await ensureDBKeys(['historyStories']);
    const stories = Array.isArray(_db && _db.historyStories) ? _db.historyStories : [];
    if(stories.length){
      _historyStoriesJsonCache = JSON.stringify(stories);
      return _historyStoriesJsonCache;
    }
  }
  if(Array.isArray(_db && _db.historyStories) && _loadedKeys.has('historyStories') && _db.historyStories.length){
    _historyStoriesJsonCache = JSON.stringify(_db.historyStories);
    return _historyStoriesJsonCache;
  }
  const count = Math.max(0, Number(meta._partCounts && meta._partCounts.historyStories) || 0);
  if(count){
    const snaps = await Promise.all(
      Array.from({ length: count }, (_, idx) => getDoc(dbChunkDoc('historyStories', idx)))
    );
    _historyStoriesJsonCache = snaps.map((snap, idx) => {
      if(!snap.exists()) throw new Error(`Missing DB chunk: historyStories[${idx}]`);
      return snap.data().json || '';
    }).join('');
    return _historyStoriesJsonCache;
  }
  // Legacy: sequential chunk docs
  const legacy = await loadLegacyHistoryChunks();
  if(legacy && legacy !== '[]'){
    _historyStoriesJsonCache = legacy;
    return legacy;
  }
  return '[]';
}

async function loadLegacyHistoryChunks(){
  let json = '';
  for(let idx = 0; idx < 40; idx++){
    const snap = await getDoc(dbChunkDoc('historyStories', idx));
    if(!snap.exists()) break;
    json += snap.data().json || '';
    if(canParseJson(json)) return json;
  }
  return '[]';
}

function forEachHistoryObject(json, cb){
  let inString = false;
  let escape = false;
  let depth = 0;
  let start = -1;
  for(let i=0;i<json.length;i++){
    const ch = json[i];
    if(inString){
      if(escape){
        escape = false;
      } else if(ch === '\\'){
        escape = true;
      } else if(ch === '"'){
        inString = false;
      }
      continue;
    }
    if(ch === '"'){
      inString = true;
      continue;
    }
    if(ch === '{'){
      if(depth === 0) start = i;
      depth++;
      continue;
    }
    if(ch === '}'){
      depth--;
      if(depth === 0 && start >= 0){
        if(cb(json.slice(start, i + 1)) === false) return;
        start = -1;
      }
    }
  }
}

function stripHeavyHistoryFields(objJson){
  return objJson
    .replace(/"content"\s*:\s*"(?:\\.|[^"\\])*"/g, '"content":""')
    .replace(/"gallery"\s*:\s*\[(?:\\.|[^\]])*?\]/g, '"gallery":[]')
    .replace(/"seoDescription"\s*:\s*"(?:\\.|[^"\\])*"/g, '"seoDescription":""');
}

function summarizeHistoryJson(json){
  const summaries = [];
  forEachHistoryObject(json, objJson => {
    try {
      const item = JSON.parse(stripHeavyHistoryFields(objJson));
      const summary = historySummaryFromArticle(item);
      if(summary) summaries.push(summary);
    } catch(err) {
      console.warn('[FB] history summary parse skipped:', err);
    }
  });
  return summaries;
}

async function loadHistorySummaries(){
  if(_historySummaryCache && _historySummaryCache.length) return _historySummaryCache;
  console.log('[History] loadHistorySummaries called, V2:', !!(_dbMeta && _dbMeta._historyStoriesV2), 'storyIds:', (_dbMeta && _dbMeta._historyStoryIds)||[]);
  if(_dbMeta && _dbMeta._historyStoriesV2){
    const summaries = await loadHistorySummariesV2OrFallback(_dbMeta);
    console.log('[History] V2 summaries loaded:', summaries.length, 'first:', summaries[0]);
    if(summaries.length){
      _historySummaryCache = summaries;
      if(_db) _db.historyStories = summaries;
      return summaries;
    }
  }
  const json = await loadHistoryStoriesJson();
  const summaries = summarizeHistoryJson(json);
  console.log('[History] legacy summaries loaded:', summaries.length, 'first:', summaries[0]);
  if(summaries.length) _historySummaryCache = summaries;
  if(_db) _db.historyStories = summaries;
  return summaries;
}

async function loadHistoryArticle(id){
  const sid = String(id);
  if(Array.isArray(_db && _db.historyStories)){
    const loaded = _db.historyStories.find(a => String(a.id) === sid && !a._summaryOnly && a.content !== undefined);
    if(loaded) return loaded;
  }
  if(_dbMeta && _dbMeta._historyStoriesV2){
    const storyIds = Array.isArray(_dbMeta._historyStoryIds) ? _dbMeta._historyStoryIds : [];
    const storyId = storyIds.find(x => String(x) === sid) || sid;
    try {
      const foundV2 = JSON.parse(await readJsonRecord(
        historyStoryDoc(storyId),
        idx => historyStoryChunkDoc(storyId, idx),
        `history story: ${storyId}`
      ));
      if(foundV2 && _db){
        const list = Array.isArray(_db.historyStories) ? _db.historyStories.slice() : [];
        const idx = list.findIndex(a => String(a.id) === sid || String(a.id) === String(foundV2.id));
        if(idx >= 0) list[idx] = foundV2;
        else list.push(foundV2);
        _db.historyStories = list;
      }
      return foundV2;
    } catch(err) {
      console.warn('[FB] history V2 article load failed, falling back:', err);
    }
  }
  const json = await loadHistoryStoriesJson();
  let found = null;
  forEachHistoryObject(json, objJson => {
    if(!new RegExp(`"id"\\s*:\\s*"?${sid}"?`).test(objJson)) return;
    try {
      const item = JSON.parse(objJson);
      if(String(item.id) === sid){
        found = item;
        return false;
      }
    } catch(err) {
      console.warn('[FB] history article parse failed:', err);
    }
  });
  if(found && _db){
    const list = Array.isArray(_db.historyStories) ? _db.historyStories.slice() : [];
    const idx = list.findIndex(a => String(a.id) === sid);
    if(idx >= 0) list[idx] = found;
    else list.push(found);
    _db.historyStories = list;
  }
  return found;
}

async function loadFullItem(key, id){
  const allowed = DB_LAZY_ITEM_KEYS.has(key);
  if(!allowed) return null;
  const sid = String(id);
  if(Array.isArray(_db && _db[key])){
    const loaded = _db[key].find(item => String(item.id) === sid && !item._summaryOnly);
    if(loaded) return loaded;
  }
  if(_dbMeta && _dbMeta._lazyItemsV2){
    const ids = (_dbMeta._lazyItemIds && _dbMeta._lazyItemIds[key]) || [];
    const itemId = ids.find(x => String(x) === sid) || sid;
    try {
      const full = JSON.parse(await readJsonRecord(
        lazyItemDoc(key, itemId),
        idx => lazyItemChunkDoc(key, itemId, idx),
        `${key} item: ${itemId}`
      ));
      if(full && _db){
        const list = Array.isArray(_db[key]) ? _db[key].slice() : [];
        const idx = list.findIndex(item => String(item.id) === String(full.id) || String(item.id) === sid);
        if(idx >= 0) list[idx] = full;
        else list.push(full);
        _db[key] = list;
      }
      return full;
    } catch(err) {
      console.warn(`[FB] ${key} V2 item load failed, falling back:`, err);
    }
  }
  await ensureDBKeys([key]);
  return (_db[key] || []).find(item => String(item.id) === sid) || null;
}

// ─── CART (guest-device based, pre-login) ──────────────────────────────────
// There is no account system yet (Phase 2), so the cart is stored as one
// Firestore doc per device, keyed by a random id persisted in localStorage.
// This survives refreshes/tabs on the same device. When login is added
// later, this guest cart should be merged into the user's account cart by
// re-keying the doc to the signed-in uid.
//
// Every amulet/accessory is a unique physical piece (no stock/qty field
// exists anywhere in this app), so a cart "item" is presence/absence only —
// there is no quantity to increment. Adding an item already in the cart is
// a no-op, and "remove" deletes it from the array entirely.
const GUEST_ID_KEY = 'yyy_guest_id';
function getGuestId(){
  let id = localStorage.getItem(GUEST_ID_KEY);
  if(!id){
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('g'+Date.now()+Math.random().toString(16).slice(2));
    localStorage.setItem(GUEST_ID_KEY, id);
  }
  return id;
}
// Once logged in, the cart is keyed by uid instead of the device guest id.
function cartKey(){
  return auth.currentUser ? auth.currentUser.uid : getGuestId();
}
function cartDocRef(key){
  return doc(fs, 'carts', key || cartKey());
}
async function cartGet(){
  try{
    const snap = await getDoc(cartDocRef());
    return snap.exists() ? (snap.data().items || []) : [];
  }catch(err){
    console.error('[FB] cartGet failed:', err);
    return [];
  }
}
// Called right after a successful login. Copies any items sitting in the
// device's guest cart into the now-logged-in user's cart (union by
// type+id, since items are unique pieces — no quantity to add up), then
// empties the guest cart doc so it isn't left orphaned.
async function mergeGuestCartIntoUser(uid){
  const guestId = getGuestId();
  if(guestId === uid) return; // nothing to merge
  try{
    const guestSnap = await getDoc(cartDocRef(guestId));
    const guestItems = guestSnap.exists() ? (guestSnap.data().items || []) : [];
    if(!guestItems.length) return;
    const userSnap = await getDoc(cartDocRef(uid));
    const userItems = userSnap.exists() ? (userSnap.data().items || []) : [];
    const merged = [...userItems];
    guestItems.forEach(gi => {
      if(!merged.some(ui => ui.type===gi.type && String(ui.id)===String(gi.id))) merged.push(gi);
    });
    await setDoc(cartDocRef(uid), { items: merged, updatedAt: serverTimestamp() });
    await setDoc(cartDocRef(guestId), { items: [], updatedAt: serverTimestamp() });
  }catch(err){
    console.error('[FB] mergeGuestCartIntoUser failed:', err);
  }
}
// item: {type:'amulets'|'accessories', id, name, price, imgs|img, hidePrice}
async function cartAdd(item){
  const items = await cartGet();
  const already = items.some(i => i.type===item.type && String(i.id)===String(item.id));
  if(already) return items;
  const next = [...items, {
    type: item.type,
    id: item.id,
    name: item.name || '',
    price: Number(item.price || 0),
    img: (item.imgs && item.imgs[0]) || item.img || '',
    catLabel: item.catLabel || '',
    addedAt: Date.now()
  }];
  await setDoc(cartDocRef(), { items: next, updatedAt: serverTimestamp() });
  return next;
}
async function cartRemove(type, id){
  const items = await cartGet();
  const next = items.filter(i => !(i.type===type && String(i.id)===String(id)));
  await setDoc(cartDocRef(), { items: next, updatedAt: serverTimestamp() });
  return next;
}
async function cartClear(){
  await setDoc(cartDocRef(), { items: [], updatedAt: serverTimestamp() });
}
function onCartChange(cb){
  return onSnapshot(cartDocRef(), snap => {
    cb(snap.exists() ? (snap.data().items || []) : []);
  }, err => console.error('[FB] cart listener failed:', err));
}

window.FB = {
  getDB, saveDB, onDBChange, ready,
  // Cart (guest-device based — see comment above)
  getGuestId, cartGet, cartAdd, cartRemove, cartClear, onCartChange,
  ensureDBKeys,
  loadHistorySummaries,
  loadHistoryArticle,
  loadFullItem,
  uploadFile, uploadImageSet, deleteFile, applyWatermark,
  signIn: signInUser,
  signOut: signOutUser,
  // Customer login (Google / Facebook / Email+Password) — separate from admin signIn/signOut above
  signInWithGoogle, signInWithFacebook,
  linkPendingCredentialWithPassword,
  customerSignUpWithEmail, customerSignInWithEmail,
  customerSignOut,
  createPaymentIntent,
  getMyOrders,
  onAuthChange,
  currentUser,
  // Customer review submissions
  submitReview,
  listReviewSubmissions,
  deleteReviewSubmission,
  // Admin role management
  getAdminRecord,
  listAdmins,
  setAdminRecord,
  deleteAdminRecord,
  ensureFirstSuperAdmin,
  // Casing variants lazy loader
  ensureCasingVariants,
  // Expose variant ID cache so admin can show counts without loading all variants
  get _casingVariantIds(){ return _casingVariantIds; },
  // Casing style availability (single source of truth — see definition above)
  CASING_AVAILABILITY,
  CASING_AVAILABILITY_DEFAULT,
  casingAvailabilityStatus,
  casingAvailabilityMeta,
  casingAvailabilityOptions,

  // Delete all casing variant Firestore docs (called by admin Reset Casing Styles tool)
  async resetCasingVariantDocs(){
    const colRef = collection(fs, 'app');
    const snap = await getDocs(colRef);
    const toDelete = snap.docs.filter(d => {
      const id = d.id;
      return id.startsWith('dbcasing_variant_') || id.startsWith('dbcasing_variantchunk_');
    });
    if(!toDelete.length) return 0;
    // Delete in batches of 20
    const batches = [];
    for(let i=0;i<toDelete.length;i+=20){
      const b = writeBatch(fs);
      toDelete.slice(i,i+20).forEach(d=>b.delete(d.ref));
      batches.push(b.commit());
    }
    await Promise.all(batches);
    return toDelete.length;
  },
  // History & Stories
  hsGetAll,
  hsAddArticle,
  hsUpdateArticle,
  hsDeleteArticle,
  hsSaveAll,
};

// Optional debug helper
window.FB._app = app;
window.FB._auth = auth;
window.FB._fs = fs;
window.FB._stg = stg;

console.log('[FB] firebase-shared.js loaded');
