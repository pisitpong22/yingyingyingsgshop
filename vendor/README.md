# vendor/

Third-party code we serve from our own origin instead of a CDN.

## heic-to-1.5.2.js

HEIC/HEIF → JPEG decoder, used by `optimiseImage()` in `firebase-shared.js`
when the browser can't decode HEIC itself (everything except Safari).

- Source: https://cdn.jsdelivr.net/npm/heic-to@1.5.2/dist/csp/heic-to.js
- sha384: `1a3zcxcf+YeJXpW2iFC/gO1DyJO7ZveuW5UTE3o0Z8rgnukCcjqmKbNI51k8loB0`

It has to be the **`dist/csp/`** build, not `dist/heic-to.js`. The csp build is
compiled through wasm2js: plain JavaScript, no `eval`, no `new Function`, no
`WebAssembly`. Our CSP grants none of those, and the library this replaced
(heic2any, asm.js) died on `new Function` with an uncaught EvalError that hung
the upload spinner forever.

Vendored rather than loaded from jsDelivr so that `script-src 'self'` covers it
— this runs inside an admin session with access to every order, and a local
copy is a stronger guarantee than an SRI hash on a third-party URL.

To update: download the new `dist/csp/heic-to.js`, verify it still contains no
`eval` / `new Function` / `WebAssembly`, save it under a version-stamped
filename, update the `import()` path in `firebase-shared.js`, and record the
new hash here:

    curl -sL <url> -o vendor/heic-to-<ver>.js
    grep -c 'new Function\|WebAssembly' vendor/heic-to-<ver>.js   # must be 0
    openssl dgst -sha384 -binary vendor/heic-to-<ver>.js | openssl base64 -A
