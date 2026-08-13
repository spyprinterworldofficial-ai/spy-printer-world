// Runs automatically after `npm install` (see package.json's "postinstall"
// script). Copies the pdf.js worker file from node_modules into public/,
// guaranteeing it always matches whatever pdfjs-dist version actually got
// installed — a mismatch here (e.g. library v6 paired with a worker file
// manually copied from a v5 install) causes PDF parsing to fail silently,
// which was previously showing every PDF as "1 page".
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
const dest = path.join(__dirname, '..', 'public', 'pdf.worker.min.mjs');

if (!fs.existsSync(src)) {
  console.error(`[copy-pdf-worker] Could not find ${src} — is pdfjs-dist installed?`);
  process.exit(1);
}

fs.copyFileSync(src, dest);
console.log(`[copy-pdf-worker] Copied pdf.worker.min.mjs (matching installed pdfjs-dist version) to public/`);