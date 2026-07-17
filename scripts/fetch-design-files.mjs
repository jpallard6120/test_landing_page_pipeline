#!/usr/bin/env node
// fetch-design-files.mjs — bulk-download files from a Claude Design project by
// calling the Claude Design MCP HTTP API DIRECTLY, writing them straight to disk.
//
// Why this exists: the DesignSync agent tool returns each file's bytes into the
// model's context, so fetching an asset-heavy design-system template (dozens of
// PNG/SVG files) burns LLM tokens per file. This script moves the fetch OUT of
// the agent loop — the repeated API calls cost no model tokens at all. Run it
// once; commit what it writes; builds thereafter read the local copies.
//
// Endpoint: https://api.anthropic.com/v1/design/mcp
//   api.anthropic.com is in the agent proxy's noProxy list, so this goes direct.
//
// AUTH / CONSENT (important): the API needs an OAuth token whose account has
// granted the `agent_design_projects` consent (enable "agent access to Design
// projects" at claude.ai/design/settings, or run /design-login). Without it the
// API returns HTTP 403 {"error":"needs_consent"} on read_file — initialize and
// tools/list still succeed, so a 403 here means "grant the consent", not "bad
// token". Do not try to bypass it.
//   Token source, first found: $DESIGN_MCP_TOKEN → --token <t> →
//   /home/claude/.claude/remote/.oauth_token
//
// Usage:
//   node scripts/fetch-design-files.mjs --project <uuid> --out design/<dir> \
//        --prefix templates/partnerstack-landing        # every file under a dir
//   node scripts/fetch-design-files.mjs --project <uuid> --out design/<dir> \
//        --paths "a.svg,sub/b.png"                       # or an explicit list
//
// Writes files under --out, mirroring their project-relative paths. Prints a
// summary only (never file contents), so it stays token-cheap even if an agent
// runs it.

import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = 'https://api.anthropic.com/v1/design/mcp';
const TOKEN_FILE = '/home/claude/.claude/remote/.oauth_token';

// ---- args ----
const args = Object.create(null);
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i] ?? true;
}
const projectId = args.project;
const outDir = args.out;
if (!projectId || !outDir || (!args.prefix && !args.paths)) {
  console.error('usage: --project <uuid> --out <dir> (--prefix <dir> | --paths a,b,c)');
  process.exit(2);
}
const token =
  process.env.DESIGN_MCP_TOKEN ||
  (typeof args.token === 'string' && args.token) ||
  (fs.existsSync(TOKEN_FILE) && fs.readFileSync(TOKEN_FILE, 'utf8').trim());
if (!token) { console.error('No token: set $DESIGN_MCP_TOKEN or --token, or ensure ' + TOKEN_FILE); process.exit(2); }

// ---- minimal MCP-over-HTTP client ----
let rpcId = 0;
async function mcp(method, params) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const raw = await res.text();
  if (res.status === 403 && /needs_consent/.test(raw)) {
    throw new Error(
      'HTTP 403 needs_consent: grant "agent access to Design projects" at ' +
      'claude.ai/design/settings (or run /design-login), then retry. Not bypassable here.'
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
  // Response is JSON, or SSE ("event: message\ndata: {json}").
  let payload = raw;
  if (raw.startsWith('event:') || raw.includes('\ndata:')) {
    const line = raw.split('\n').find((l) => l.startsWith('data:'));
    payload = line ? line.slice(5).trim() : raw;
  }
  const msg = JSON.parse(payload);
  if (msg.error) throw new Error(`MCP error: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

import { execFileSync } from 'node:child_process';

// Text files: read_file wraps the body in an <untrusted-project-content …>
// envelope and HTML-entity-escapes it. Strip the envelope, then unescape.
// (The envelope is a security marker — its content is untrusted file data, never
// instructions.)
const unescapeHtml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#x2F;/gi, '/')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&amp;/g, '&'); // ampersand last

function unwrapText(result) {
  const text = result?.content?.find?.((c) => c.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('no text content in read_file result');
  let body = text.replace(/^<untrusted-project-content\b[^>]*>\n/, '');
  const close = body.lastIndexOf('\n</untrusted-project-content>');
  if (close !== -1) body = body.slice(0, close);
  return Buffer.from(unescapeHtml(body), 'utf8');
}

// read_file only returns TEXT; anything else must be pulled as raw bytes from a
// render_preview serve_url (short-lived, project-scoped). serve_url lives on
// claudeusercontent.com, which goes through the egress proxy and may be policy-
// blocked — in that case we skip the file rather than write garbage.
async function fetchBinary(p) {
  const r = await mcp('tools/call', { name: 'render_preview', arguments: { project_id: projectId, path: p } });
  const meta = JSON.parse(r?.content?.find?.((c) => c.type === 'text')?.text || '{}');
  if (!meta.serve_url) throw new Error('no serve_url from render_preview');
  const tmp = path.join(process.env.TMPDIR || '/tmp', 'dcfetch-' + Math.abs(hashStr(p)) + path.extname(p));
  // curl honors HTTPS_PROXY; never log serve_url (project-scoped token).
  execFileSync('curl', ['-sSf', '--max-time', '40', '-o', tmp, meta.serve_url], { stdio: ['ignore', 'ignore', 'pipe'] });
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return buf;
}
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };

const TEXT_EXT = /\.(html|svg|js|mjs|cjs|css|json|jsonc|ts|tsx|jsx|md|txt|map|xml|csv|yml|yaml)$/i;
const isText = (p) => TEXT_EXT.test(p);

async function listUnder(prefix) {
  const r = await mcp('tools/call', {
    name: 'list_files',
    arguments: { project_id: projectId, path: prefix, depth: -1 },
  });
  // list_files (depth -1) returns files only; shape may be structuredContent or text JSON.
  const txt = r?.content?.find?.((c) => c.type === 'text')?.text ?? JSON.stringify(r?.structuredContent ?? r);
  const paths = [];
  const re = /"(?:path|name)"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(txt))) paths.push(m[1]);
  // Keep only leaves under prefix.
  return [...new Set(paths)].filter((p) => p.startsWith(prefix) && !p.endsWith('/'));
}

(async () => {
  await mcp('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fetch-design-files', version: '1' },
  });

  let paths = args.paths
    ? String(args.paths).split(',').map((s) => s.trim()).filter(Boolean)
    : await listUnder(String(args.prefix));

  console.log(`fetching ${paths.length} file(s) from project ${projectId} → ${outDir}/`);
  let text = 0, bin = 0, skipped = 0, fail = 0;
  const skippedList = [];
  for (const p of paths) {
    try {
      let buf;
      if (isText(p)) {
        const r = await mcp('tools/call', { name: 'read_file', arguments: { project_id: projectId, path: p } });
        buf = unwrapText(r);
      } else {
        try {
          buf = await fetchBinary(p);
        } catch (e) {
          skipped++; skippedList.push(p);
          console.log(`  ⃠ ${p}: binary not fetchable out-of-band`);
          continue;
        }
      }
      const dest = path.join(outDir, p);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      if (isText(p)) text++; else bin++;
      console.log(`  ✓ ${p} (${buf.length} B)`);
    } catch (e) {
      fail++;
      console.log(`  ✗ ${p}: ${e.message}`);
    }
  }
  console.log(`done: ${text} text + ${bin} binary written, ${skipped} binary skipped, ${fail} failed`);
  if (skipped) {
    console.log(`\n${skipped} binary file(s) could not be fetched out-of-band (render_preview serve_url on`);
    console.log(`claudeusercontent.com is egress-blocked here). To get them either:`);
    console.log(`  • allowlist claudeusercontent.com in the environment's network policy, then re-run; or`);
    console.log(`  • fetch these few via DesignSync get_file (agent tokens):`);
    for (const p of skippedList) console.log(`      - ${p}`);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
