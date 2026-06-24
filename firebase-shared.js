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
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
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
const DB_SPLIT_KEYS = ['settings', 'amulets', 'accessories', 'casingTypes', 'projects', 'reviews', 'feedPosts', 'historyStories'];
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
    case 'feed':         return ['settings','feedPosts','amulets','projects','reviews','casingTypes','historyStories'];
    case 'home':         return ['settings','feedPosts','amulets','projects','reviews','casingTypes','historyStories'];
    default:             return ['settings'];
  }
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
    } else if(_casingVariantIds[typeId] && _casingVariantIds[typeId].length > 0){
      // variants array is empty (Phase 1 deferred load) but we KNOW variants exist
      // in Firestore from the cached _casingVariantIds — preserve them, do NOT write []
      // This prevents saveType (which runs without loading variants) from wiping variant index
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
    if(key === 'casingTypes' && meta._casingTypesV2){
      out[key] = await loadCasingTypesV2(meta);
      return;
    }

    if(Array.isArray(itemIds[key])){
      const snaps = await Promise.all(itemIds[key].map(itemId => getDoc(dbItemDoc(key, itemId))));
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

    const snaps = await Promise.all(
      Array.from({ length: count }, (_, idx) => getDoc(dbChunkDoc(key, idx)))
    );
    const json = snaps.map((snap, idx) => {
      if(!snap.exists()){
        throw new Error(`Missing DB chunk: ${key}[${idx}]`);
      }
      return snap.data().json || '';
    }).join('');
    out[key] = JSON.parse(json);
  }));

  _dbPartCounts = { ...counts };
  _dbPartHashes = { ...hashes };
  _dbItemIds = { ...itemIds };
  _dbItemHashes = { ...itemHashes };
  _casingTypeIds = Array.isArray(meta._casingTypeIds) ? [...meta._casingTypeIds] : [];
  _casingTypeHashes = { ...(meta._casingTypeHashes || {}) };
  _casingVariantIds = { ...(meta._casingVariantIds || {}) };
  _casingVariantHashes = { ...(meta._casingVariantHashes || {}) };
  return out;
}

// Track which types have had variants fully loaded
const _casingVariantsLoaded = new Set();

async function loadCasingTypesV2(meta){
  const typeIds = Array.isArray(meta._casingTypeIds) ? meta._casingTypeIds : [];
  const variantIds = meta._casingVariantIds || {};

  // Phase 1: load ALL type metadata in parallel (no variants yet)
  // This is fast — just one Firestore doc per type
  const types = await Promise.all(typeIds.map(async typeId => {
    const type = JSON.parse(await readJsonRecord(
      casingTypeDoc(typeId),
      idx => casingTypeChunkDoc(typeId, idx),
      `casing type: ${typeId}`
    ));
    // Attach variant ID list so UI knows how many styles exist
    const ids = Array.isArray(variantIds[typeId]) ? variantIds[typeId] : [];
    type._variantIds = ids;
    // Populate module-level cache so ensureCasingVariants can find IDs immediately
    _casingVariantIds[String(typeId)] = ids;
    // Set empty variants array — will be populated lazily when type is opened
    if(!Array.isArray(type.variants)) type.variants = [];
    return type;
  }));

  return types;
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
    console.warn('[ensureCasingVariants] EMPTY variantIds for key=',key,'_casingVariantIds=',_casingVariantIds[key],'ty._variantIds=',ty._variantIds,'_dbMeta ids=',(_dbMeta?._casingVariantIds||{})[key]);
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
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
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
//   gallery:[], featured, status:'published'|'draft', seoTitle, seoDescription,
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

window.FB = {
  getDB, saveDB, onDBChange, ready,
  ensureDBKeys,
  uploadFile, uploadImageSet, deleteFile,
  signIn: signInUser,
  signOut: signOutUser,
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
