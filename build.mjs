#!/usr/bin/env node
// build.mjs — deterministic compiler: Claude Design component (.dc.html) -> static HTML.
// Zero dependencies. Runs the design's own renderVals() data through the DC template
// language (sc-for / {{ }} / helmet), strips the x-dc runtime, emits plain HTML.
//
// Usage:  node build.mjs [srcFile.dc.html] [outFile.html]
// Default: node build.mjs design/*.dc.html public/index.html  (expects exactly one source)
//
// Design goal: fail LOUDLY on anything it can't resolve (unknown sc-* tag, leftover
// {{ }}, missing data) so broken output never ships silently — that failure is the
// signal to fall back to the LLM translation path.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// ---------- escaping (matches React text/attr escaping) ----------
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;');

// ---------- sandboxed evaluation ----------
function evalExpr(expr, scope) {
  const ctx = vm.createContext({ ...scope });
  try {
    return vm.runInContext(`(${expr})`, ctx, { timeout: 1000 });
  } catch (e) {
    throw new Error(`Cannot evaluate {{ ${expr} }} — ${e.message}`);
  }
}

// Run the <script data-dc-script> body to get renderVals() output. The component
// runs in a locked-down context: no require, no fs, no network, hard timeout.
function getRenderVals(scriptSrc, props = {}) {
  const sandbox = {
    DCLogic: class DCLogic { constructor(p) { this.props = p || {}; } },
    console: { log() {}, warn() {}, error() {} },
    __result: undefined,
  };
  const ctx = vm.createContext(sandbox);
  const code = `${scriptSrc}\n;__result = (new Component(${JSON.stringify(props)})).renderVals();`;
  try {
    vm.runInContext(code, ctx, { timeout: 2000 });
  } catch (e) {
    throw new Error(`Failed to run data-dc-script renderVals(): ${e.message}`);
  }
  return sandbox.__result || {};
}

// ---------- template engine ----------
// Find <tag ...> ... </tag> starting at openIdx, honoring nesting of the same tag.
function matchBlock(tpl, openIdx, tag) {
  const openTagEnd = tpl.indexOf('>', openIdx);
  if (openTagEnd === -1) throw new Error(`Malformed <${tag}> tag`);
  const openRe = new RegExp(`<${tag}[\\s/>]`, 'g');
  const close = `</${tag}>`;
  let depth = 1;
  let idx = openTagEnd + 1;
  while (depth > 0) {
    const nextClose = tpl.indexOf(close, idx);
    if (nextClose === -1) throw new Error(`Unclosed <${tag}>`);
    const seg = tpl.slice(idx, nextClose);
    depth += (seg.match(openRe) || []).length - 1;
    idx = nextClose + close.length;
  }
  return {
    openTag: tpl.slice(openIdx, openTagEnd + 1),
    inner: tpl.slice(openTagEnd + 1, idx - close.length),
    end: idx,
  };
}

const attrOf = (openTag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(openTag);
  return m ? m[1] : null;
};

// Fully resolve a template fragment against a scope: expand sc-for, then interpolate {{ }}.
function render(tpl, scope) {
  // 1. Expand every sc-for (recursively renders its body per item, in child scope).
  let out = '';
  let cursor = 0;
  while (true) {
    const at = tpl.indexOf('<sc-for', cursor);
    if (at === -1) { out += tpl.slice(cursor); break; }
    out += tpl.slice(cursor, at);
    const block = matchBlock(tpl, at, 'sc-for');
    const listRaw = attrOf(block.openTag, 'list');
    const asVar = attrOf(block.openTag, 'as') || 'item';
    if (listRaw == null) throw new Error('<sc-for> missing list attribute');
    const listExpr = listRaw.replace(/\{\{|\}\}/g, '').trim();
    const items = evalExpr(listExpr, scope);
    if (!Array.isArray(items)) throw new Error(`<sc-for list="{{ ${listExpr} }}"> did not resolve to an array`);
    out += items.map((item, i) =>
      render(block.inner, { ...scope, [asVar]: item, [`${asVar}Index`]: i })
    ).join('');
    cursor = block.end;
  }

  // 2. Guard: no other sc-* construct is supported yet — fail loudly (LLM fallback).
  const unknown = /<sc-([a-z-]+)/.exec(out);
  if (unknown) throw new Error(`Unsupported DC construct <sc-${unknown[1]}> — fall back to LLM translation`);

  // 3. Interpolate {{ }} in this scope (attr vs text escaping by position).
  return out.replace(/(=")?\{\{([^}]*)\}\}/g, (full, isAttr, expr) => {
    const val = evalExpr(expr.trim(), scope);
    const str = val == null ? '' : String(val);
    return isAttr ? `="${escAttr(str)}` : escHtml(str);
  });
}

// ---------- head assembly ----------
const firstText = (html, re) => {
  const m = re.exec(html);
  return m ? m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : null;
};

function buildHead(origHead, helmetInner, bodyHtml) {
  // Keep original head tags except the support.js loader.
  let head = origHead.replace(/<script[^>]*src=["']\.?\/?support\.js["'][^>]*>\s*<\/script>/gi, '');
  const parts = head.split('\n').map((l) => l.trim()).filter(Boolean);

  const title = firstText(bodyHtml, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const hasTitle = /<title>/i.test(head);
  if (title && !hasTitle) parts.push(`<title>${escHtml(title)}</title>`);

  const desc = firstText(bodyHtml, /<h1[^>]*>[\s\S]*?<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
  const hasDesc = /name=["']description["']/i.test(head);
  if (desc && !hasDesc) parts.push(`<meta name="description" content="${escAttr(desc)}">`);

  if (helmetInner && helmetInner.trim()) parts.push(helmetInner.trim());
  return parts.join('\n');
}

// ---------- compile one file ----------
function compile(src) {
  const doc = fs.readFileSync(src, 'utf8');

  const xdc = /<x-dc[^>]*>([\s\S]*?)<\/x-dc>/i.exec(doc);
  if (!xdc) throw new Error(`${src}: no <x-dc> root found — not a DC component?`);
  let template = xdc[1];

  // helmet -> head; remove from template
  let helmetInner = '';
  const helmet = /<helmet[^>]*>([\s\S]*?)<\/helmet>/i.exec(template);
  if (helmet) { helmetInner = helmet[1]; template = template.replace(helmet[0], ''); }

  const scriptM = /<script[^>]*\bdata-dc-script\b[^>]*>([\s\S]*?)<\/script>/i.exec(doc);
  const propsAttr = scriptM ? attrOf(scriptM[0], 'data-props') : null;
  let props = {};
  if (propsAttr) { try { props = JSON.parse(propsAttr); } catch { /* leave {} */ } }
  const data = scriptM ? getRenderVals(scriptM[1], props) : {};

  const body = render(template, data).trim();

  const headM = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(doc);
  const langM = /<html[^>]*\blang=["']([^"']*)["']/i.exec(doc);
  const lang = langM ? langM[1] : 'en';
  const head = buildHead(headM ? headM[1] : '', helmetInner, body);

  const html = `<!DOCTYPE html>
<html lang="${escAttr(lang)}">
<head>
${head}
</head>
<body>
${body}
</body>
</html>
`;

  // ---------- self-check: nothing runtime-y may survive ----------
  const leak = /x-dc|sc-for|sc-if|\{\{|<helmet|support\.js|data-dc/i.exec(html);
  if (leak) throw new Error(`${src}: compiled output still contains runtime scaffolding ("${leak[0]}")`);
  return html;
}

// ---------- cli ----------
function resolveSrc(arg) {
  if (arg) return arg;
  const dir = process.env.DC_SRC || 'design';
  const found = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.dc.html')).map((f) => path.join(dir, f))
    : [];
  if (found.length === 0) throw new Error(`No .dc.html found in ${dir}/`);
  if (found.length > 1) throw new Error(`Multiple .dc.html found (${found.join(', ')}); multi-page not supported yet — pass one explicitly`);
  return found[0];
}

const srcArg = process.argv[2];
const outArg = process.argv[3] || path.join(process.env.DC_OUT || 'public', 'index.html');
const src = resolveSrc(srcArg);
const html = compile(src);
fs.mkdirSync(path.dirname(outArg), { recursive: true });
fs.writeFileSync(outArg, html);
console.log(`✓ compiled ${src} -> ${outArg} (${html.length} bytes)`);
