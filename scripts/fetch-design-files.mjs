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

// read_file returns MCP content; a full text body may be HTML-entity-escaped,
// binary comes back base64. Normalize to a Buffer.
const unescapeHtml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#x2F;/gi, '/')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&amp;/g, '&'); // ampersand last

function contentToBuffer(result, isBinary) {
  const items = result?.content ?? [];
  for (const it of items) {
    const b64 = it.data || it.blob || it.resource?.blob;
    if (b64 && (it.type === 'image' || it.type === 'resource' || isBinary)) {
      return Buffer.from(b64, 'base64');
    }
    if (typeof it.text === 'string') {
      if (isBinary) return Buffer.from(it.text, 'base64');
      return Buffer.from(unescapeHtml(it.text), 'utf8');
    }
  }
  if (result?.structuredContent?.content != null) {
    return Buffer.from(String(result.structuredContent.content), isBinary ? 'base64' : 'utf8');
  }
  throw new Error('unrecognized read_file result shape: ' + JSON.stringify(result).slice(0, 200));
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|pdf)$/i;

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
  let ok = 0, fail = 0;
  for (const p of paths) {
    try {
      const isBinary = BINARY_EXT.test(p);
      const r = await mcp('tools/call', { name: 'read_file', arguments: { project_id: projectId, path: p } });
      const buf = contentToBuffer(r, isBinary);
      const dest = path.join(outDir, p);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      ok++;
      console.log(`  ✓ ${p} (${buf.length} B)`);
    } catch (e) {
      fail++;
      console.log(`  ✗ ${p}: ${e.message}`);
    }
  }
  console.log(`done: ${ok} written, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
