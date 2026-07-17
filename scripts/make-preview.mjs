#!/usr/bin/env node
// make-preview.mjs — turn a compiled page (build.mjs output, a full HTML doc)
// into a SELF-CONTAINED Artifact fragment so it renders in the Claude Code web
// UI for approval.
//
// Why a fragment: the Artifact tool wraps its input in its own
// <!doctype html><head></head><body> skeleton, so the file must contain body
// content only — no <!DOCTYPE>/<html>/<head>/<body> tags. And Artifacts run under
// a strict CSP (no external hosts, no sibling files), so every referenced asset
// must be inlined as a data: URI.
//
// Usage: node scripts/make-preview.mjs public/index.html <out-fragment.html>
//
// Emits: any <style> from <head> + the <body> inner HTML, with src/href asset
// refs (./assets/…, /assets/…, assets/…) replaced by data: URIs read from the
// input file's directory. Publish the result with the Artifact tool.

import fs from 'node:fs';
import path from 'node:path';

const [inPath, outPath] = [process.argv[2], process.argv[3]];
if (!inPath || !outPath) { console.error('usage: make-preview.mjs <compiled.html> <out.html>'); process.exit(2); }

const html = fs.readFileSync(inPath, 'utf8');
const baseDir = path.dirname(inPath);

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

// <style> blocks from <head> (build.mjs may keep helmet styles there)
const head = (/<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1]) || '';
const styles = (head.match(/<style[\s\S]*?<\/style>/gi) || []).join('\n');

// body inner
let body = (/<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1]) ?? html;

// inline asset references as data: URIs
let inlined = 0, missing = 0;
body = body.replace(/((?:src|href)=")(?:\.\/|\/)?((?:assets)\/[^"]+)"/g, (m, pre, rel) => {
  const f = path.join(baseDir, rel);
  if (!fs.existsSync(f)) { missing++; return m; }
  const ext = path.extname(f).toLowerCase();
  const b64 = fs.readFileSync(f).toString('base64');
  inlined++;
  return `${pre}data:${MIME[ext] || 'application/octet-stream'};base64,${b64}"`;
});

fs.writeFileSync(outPath, `${styles}\n${body}`);
console.error(`preview: ${inlined} asset(s) inlined, ${missing} missing → ${outPath} (${(fs.statSync(outPath).size / 1024 | 0)} KB)`);
