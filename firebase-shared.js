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
//  DB shape: identical to the previous localStorage `yyy_db` value. The whole
//  DB is stored in ONE Firestore document at `app/db` for simplicity (a few KB
//  to ~1 MB of mostly-text data). Images are referenced by URL pointing to
//  Firebase Storage, NOT stored inline as base64.
// ════════════════════════════════════════════════════════════════════════════

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, onSnapshot, collection, getDocs
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-storage.js";

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

// ─── DB API ────────────────────────────────────────────────────────────────
function getDB(){ return _db || {}; }

async function saveDB(newDb){
  // Persist whole document. Firestore writes are atomic per-document.
  _db = newDb;
  try {
    await setDoc(DB_DOC, newDb);
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

// Subscribe to realtime updates from Firestore.
// Whenever the document changes, _db is updated and listeners are notified.
onSnapshot(DB_DOC, (snap) => {
  if(snap.exists()){
    _db = snap.data();
  } else {
    _db = null;   // doc doesn't exist yet — first run
  }
  _dbListeners.forEach(cb => {
    try { cb(_db); } catch(err){ console.error('[FB] listener error:', err); }
  });
  if(!_isReady){
    _isReady = true;
    _readyResolve(_db);
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
async function uploadFile(fileOrBlob, pathHint){
  let blob;
  if(typeof fileOrBlob === 'string' && fileOrBlob.startsWith('data:')){
    const res = await fetch(fileOrBlob);
    blob = await res.blob();
  } else {
    blob = fileOrBlob;
  }

  // Image optimisation: resize big images + convert to WebP. Anything that
  // isn't an image (or is already small) skips this and uploads unchanged.
  if(blob.type && blob.type.startsWith('image/') && !blob.type.includes('svg')){
    try {
      blob = await optimiseImage(blob);
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

  // Generate a unique path: uploads/{timestamp}-{random}.{ext}
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

// No-op rewriter kept for backwards compatibility with index.html/admin.html.
// (Older versions of this file rewrote URLs to/from ImageKit and to/from a
// legacy bucket — neither applies anymore now that everything's in one
// fresh Asia project.)
window._rewriteLegacyImageUrl = (url) => url;

// Resize & re-encode an image Blob.
//   - Keeps aspect ratio
//   - Caps longest side at MAX_DIM
//   - Output: WebP at QUALITY (PNG with transparency uses 'image/png' instead)
async function optimiseImage(blob){
  const MAX_DIM = 1920;       // longest side
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
    console.log('[FB] HEIC detected, converting to JPEG…');
    try {
      // Load heic2any from JsDelivr CDN if not already loaded
      if(!window.heic2any){
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
          s.onload = res;
          s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      const converted = await window.heic2any({
        blob: blob,
        toType: 'image/jpeg',
        quality: 0.92,
      });
      // heic2any can return Blob or Blob[]; coalesce to single Blob
      blob = Array.isArray(converted) ? converted[0] : converted;
      console.log('[FB] HEIC → JPEG conversion done, size:', blob.size);
    } catch(e){
      console.error('[FB] HEIC conversion failed:', e);
      throw new Error(
        'HEIC files cannot be converted. Please use a JPEG/PNG image instead, ' +
        'or take screenshots on your iPhone with the camera set to "Most Compatible" ' +
        '(Settings → Camera → Formats → Most Compatible).'
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

// ─── EXPOSE GLOBALLY ───────────────────────────────────────────────────────
window.FB = {
  getDB, saveDB, onDBChange, ready,
  uploadFile, deleteFile,
  signIn: signInUser,
  signOut: signOutUser,
  onAuthChange,
  currentUser,
  // Admin role management
  getAdminRecord,
  listAdmins,
  setAdminRecord,
  deleteAdminRecord,
  ensureFirstSuperAdmin,
};

// Optional debug helper
window.FB._app = app;
window.FB._auth = auth;
window.FB._fs = fs;
window.FB._stg = stg;

console.log('[FB] firebase-shared.js loaded');
