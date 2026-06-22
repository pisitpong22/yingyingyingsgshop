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

// ════════════════════════════════════════════════════════════════════════════
//  firebase-shared.js
//  Shared Firebase init + database/storage/auth abstraction for both
//  index.html (customer-facing) and admin.html (CMS).
// ════════════════════════════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, onSnapshot, collection, getDocs,
  addDoc, serverTimestamp, query, orderBy, writeBatch, startAt, endAt, FieldPath
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js";
import {
  initializeAppCheck, ReCaptchaV3Provider
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app-check.js";

const firebaseConfig = {
  apiKey: "AIzaSyCvK5tsaz6AJDGdG7zVoy6a32yoU1_-koA",
  authDomain: "yingyingyingsgshop.firebaseapp.com",
  projectId: "yingyingyingsgshop",
  storageBucket: "yingyingyingsgshop.firebasestorage.app",
  messagingSenderId: "329334358389",
  appId: "1:329334358389:web:105a3024960b00a7c9533c"
};

const app  = initializeApp(firebaseConfig);

const APP_CHECK_SITE_KEY = '6LeDJQMtAAAAAJ_2o3lhLYQr-hRhEUG0RhK1iKqU'; 
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
}

const auth = getAuth(app);
const fs   = getFirestore(app);
const stg  = getStorage(app);

let _db = null;
let _dbListeners = [];       
let _authListeners = [];     
let _readyResolve;
const _readyPromise = new Promise(res => { _readyResolve = res; });
let _isReady = false;

const DB_DOC = doc(fs, 'app', 'db');
const DB_SPLIT_VERSION = 1;
const DB_SPLIT_KEYS = ['settings', 'amulets', 'accessories', 'casingTypes', 'projects', 'reviews', 'feedPosts', 'historyStories'];

const DB_ITEM_KEYS = new Set([]);
const DB_CHUNK_PREFIX = 'dbpart';
const DB_ITEM_PREFIX = 'dbitem';
const DB_CHUNK_CHARS = 700000; 
const DB_RECORD_INLINE_CHARS = 650000;
const DB_BATCH_MAX_WRITES = 6;
const DB_BATCH_MAX_BYTES = 3500000; 

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

const IS_ADMIN_PAGE = /(^|/)admin[^/]*.html$/i.test(location.pathname);

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
    case 'amulets':      return ['amulets'];
    case 'accessories':  return ['accessories'];
    case 'casing':       return ['casingTypes'];
    case 'projects':     return ['projects'];
    case 'reviews':      return ['reviews'];
    case 'history-stories': return ['historyStories'];
    case 'feed':         return ['feedPosts','amulets','projects','reviews','casingTypes','historyStories'];
    case 'home':         return ['settings','feedPosts','amulets','projects','reviews','casingTypes','historyStories'];
    default:             return ['settings'];
  }
}

function initialLoadKeys(){
  return IS_ADMIN_PAGE ? DB_SPLIT_KEYS : keysForStorePage(requestedPageFromUrl());
}

async function saveDB(newDb){
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
}

function onDBChange(cb){
  _dbListeners.push(cb);
  if(_db) cb(_db);   
  return () => {     
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
  
  // Get existing casing types to preserve data
  const existingTypes = (_db && Array.isArray(_db.casingTypes)) ? _db.casingTypes : [];

  list.forEach((type, typeIdx) => {
    const typeId = uniqueItemId(stableItemId(type, typeIdx), usedTypeIds);
    typeIds.push(typeId);
    
    // --- FIX FOR PART 5: Preserve protected fields if not explicitly edited ---
    const oldType = existingTypes.find(t => String(t.id) === String(typeId) || stableItemId(t, typeIdx) === typeId);
    if (oldType) {
      if (type.variants === undefined) type.variants = oldType.variants || [];
      if (type.sampleImgs === undefined) type.sampleImgs = oldType.sampleImgs || [];
      if (type.gallery === undefined) type.gallery = oldType.gallery || [];
      if (type._variantIds === undefined) type._variantIds = oldType._variantIds || [];
    }
    // ------------------------------------------------------------------------

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
  });
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
    return String(label).trim().toLowerCase().replace(/[^a-z0-9]+/gi, '').replace(/^_+|_+$/g, '').slice(0, 80);
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

const _casingVariantsLoaded = new Set();

async function loadCasingTypesV2(meta){
  const typeIds = Array.isArray(meta._casingTypeIds) ? meta._casingTypeIds : [];
  const variantIds = meta._casingVariantIds || {};
  
  const types = await Promise.all(typeIds.map(async typeId => {
    const type = JSON.parse(await readJsonRecord(
      casingTypeDoc(typeId),
      idx => casingTypeChunkDoc(typeId, idx),
      `casing type: ${typeId}`
    ));
    const ids = Array.isArray(variantIds[typeId]) ? variantIds[typeId] : [];
    type._variantIds = ids;
    if(!Array.isArray(type.variants)) type.variants = [];
    return type;
  }));
  return types;
}

// Phase 2: load variants for a specific casing type on-demand
async function ensureCasingVariants(typeId){
  const key = String(typeId);
  if(_casingVariantsLoaded.has(key)) return;
  
  const db = getDB();
  const ty = (db.casingTypes||[]).find(t=>String(t.id)===key);
  if(!ty) {
    console.warn('[CASING] type not found for id:', typeId);
    _casingVariantsLoaded.add(key);
    return;
  }

  console.log('[CASING TYPE RAW]', ty);
  console.log('[CASING DETAIL] Loading variants for type', typeId, 'via prefix query...');
  
  // Option A: Query only variants belonging to the selected casing type
  // Document IDs are formatted as: dbcasing_variant_<typeId>_<variantId>
  const safeTypeId = safeDocId(typeId);
  const startId = `dbcasing_variant_${safeTypeId}_`;
  const endId = startId + '\uf8ff';
  
  const q = query(
    collection(fs, 'app'), 
    orderBy(FieldPath.documentId()), 
    startAt(startId), 
    endAt(endId)
  );
  
  const snap = await getDocs(q);
  const variants = [];
  const promises = [];
  
  snap.forEach(docSnap => {
    const data = docSnap.data();
    if(!data || (!data.json && !data._chunked)) return;
    
    const docId = docSnap.id;
    const variantIdPart = docId.substring(startId.length);
    
    promises.push(
      readJsonRecord(
        docSnap.ref,
        idx => casingVariantChunkDoc(typeId, variantIdPart, idx),
        `casing variant: ${typeId}/${variantIdPart}`
      ).then(jsonStr => {
        try {
          const variant = JSON.parse(jsonStr);
          variant.typeId = data.typeId || typeId;
          variant.id = variant.id || variantIdPart;
          variants.push(variant);
        } catch(e) {
          console.warn('[CASING] Failed to parse variant json:', e);
        }
      }).catch(err => {
        console.error('[CASING] Failed to load variant:', err);
      })
    );
  });
  
  await Promise.all(promises);
  
  console.log('[VARIANT SAMPLE]', variants.slice(0,3));
  
  ty.variants = variants;
  _casingVariantsLoaded.add(key);
  console.log('[CASING DETAIL] variants loaded:', variants.length, 'for type', typeId);
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

onSnapshot(DB_DOC, async (snap) => {
  const seq = ++_snapshotSeq;
  try {
    if(snap.exists()){
      const data = snap.data();
      _dbMeta = data && data._splitVersion ? data : null;
      _loadedKeys = new Set();
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
      _db = null;   
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
  if(!_isReady){
    _isReady = true;
    _readyResolve(null);
  }
});

function ready(){ return _readyPromise; }

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

  const looksLikeImage =
    (blob.type && blob.type.startsWith('image/') && !blob.type.includes('svg')) ||
    (blob.name && /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp)$/i.test(blob.name)) ||
    blob.type === ''; 

  if(looksLikeImage){
    try {
      if(opts.stringOnly){
        blob = await optimiseImage(blob);
      } else {
        return await createImageSet(blob, pathHint);
      }
    } catch(err){
      console.warn('[FB] image optimise failed:', err);
      const orig = fileOrBlob;
      const isUnviewable =
        (orig && orig.type === 'image/heic') ||
        (orig && orig.type === 'image/heif') ||
        (orig && orig.name && /\.(heic|heif)$/i.test(orig.name));
      if(isUnviewable){
        throw err;  
      }
    }
  }
  const url = await uploadBlob(blob, pathHint);
  return opts.stringOnly ? url : { url, type: blob.type || '', bytes: blob.size || 0 };
}

async function uploadBlob(blob, pathHint){
  const ext = guessExtFromBlobOrHint(blob, pathHint);
  const safeHint = (pathHint || 'file').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
  const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeHint}.${ext}`;
  
  // Storage folders are for organization only.
  // Firestore is the source of truth.
  // Never determine relationships using Storage paths.
  
  let folder = 'general';
  if (pathHint) {
    const hint = String(pathHint).toLowerCase();
    if (hint.includes('amulet')) folder = 'amulets';
    else if (hint.includes('accessory') || hint.includes('accessories')) folder = 'accessories';
    else if (hint.includes('casing')) {
      if (hint.includes('style')) folder = 'casing/styles';
      else if (hint.includes('gallery')) folder = 'casing/gallery';
      else folder = 'casing/covers';
    }
    else if (hint.includes('project')) folder = 'projects';
    else if (hint.includes('review')) folder = 'reviews';
    else if (hint.includes('history') || hint.includes('story') || hint.includes('hs')) folder = 'history-stories';
    else if (hint.includes('social') || hint.includes('feed')) folder = 'social';
  }
  
  const ref = storageRef(stg, `uploads-v2/${folder}/${fname}`);
  
  await uploadBytes(ref, blob, blob.type ? {
    contentType: blob.type,
    cacheControl: 'public,max-age=31536000,immutable',
  } : undefined);
  
  const fbUrl = await getDownloadURL(ref);
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

window._rewriteLegacyImageUrl = (url) => url;

async function optimiseImage(blob, maxDim=1920){
  const MAX_DIM = maxDim;     
  const QUALITY = 0.85;       

  const isHeic =
    blob.type === 'image/heic' ||
    blob.type === 'image/heif' ||
    blob.type === '' ||  
    (blob.name && /\.(heic|heif)$/i.test(blob.name));

  if(isHeic){
    console.log('[FB] HEIC detected, converting to JPEG…', {
      type: blob.type,
      size: blob.size,
      name: blob.name,
    });
    try {
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

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch(_) {
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

  const alreadySmall = srcW <= MAX_DIM && srcH <= MAX_DIM;
  const isEfficient  = blob.type === 'image/webp';
  if(alreadySmall && isEfficient){
    return blob;
  }

  let dstW = srcW, dstH = srcH;
  if(srcW > MAX_DIM || srcH > MAX_DIM){
    const r = Math.min(MAX_DIM / srcW, MAX_DIM / srcH);
    dstW = Math.round(srcW * r);
    dstH = Math.round(srcH * r);
  }

  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, dstW, dstH);

  const hasAlpha = blob.type === 'image/png' || blob.type === 'image/gif';
  const outType  = hasAlpha ? 'image/png' : 'image/webp';

  const result = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if(b) resolve(b); else reject(new Error('canvas.toBlob failed'));
    }, outType, QUALITY);
  });

  if(result.size >= blob.size && alreadySmall){
    return blob;
  }
  console.log(`[FB] image optimised: ${(blob.size/1024).toFixed(0)}KB → ${(result.size/1024).toFixed(0)}KB` +
    `(${srcW}×${srcH} → ${dstW}×${dstH}, ${outType})`);
  return result;
}

function guessExtFromBlobOrHint(blob, pathHint){
  const t = blob.type || '';
  if(t.includes('webp')) return 'webp';
  if(t.includes('png')) return 'png';
  if(t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if(t.includes('gif')) return 'gif';
  if(t.includes('svg')) return 'svg';
  if(t.includes('gltf-binary')) return 'glb';
  if(t.includes('gltf')) return 'gltf';
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
  if(!url || typeof url !== 'string') return;
  if(!url.includes('firebasestorage.googleapis.com') && !url.includes('firebasestorage.app')){
    return;   
  }
  try {
    const m = url.match(/\/o\/([^?]+)/);
    if(!m) return;
    const path = decodeURIComponent(m[1]);
    await deleteObject(storageRef(stg, path));
  } catch(err){
    console.warn('[FB] deleteFile:', err.code || err.message);
  }
}

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

const REVIEW_SUBMISSIONS_COL = 'reviewSubmissions';

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

async function listReviewSubmissions(){
  try {
    const q = query(collection(fs, REVIEW_SUBMISSIONS_COL), orderBy('createdAt', 'asc'));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch(e){
    try {
      const snap = await getDocs(collection(fs, REVIEW_SUBMISSIONS_COL));
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch(e2){
      console.warn('[FB] listReviewSubmissions failed:', e2);
      return [];
    }
  }
}

async function deleteReviewSubmission(id){
  if(!id) return;
  await deleteDoc(doc(fs, REVIEW_SUBMISSIONS_COL, id));
}

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
  submitReview,
  listReviewSubmissions,
  deleteReviewSubmission,
  getAdminRecord,
  listAdmins,
  setAdminRecord,
  deleteAdminRecord,
  ensureFirstSuperAdmin,
  ensureCasingVariants,
  hsGetAll,
  hsAddArticle,
  hsUpdateArticle,
  hsDeleteArticle,
  hsSaveAll,
};

window.FB._app = app;
window.FB._auth = auth;
window.FB._fs = fs;
window.FB._stg = stg;
console.log('[FB] firebase-shared.js loaded');