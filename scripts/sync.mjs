#!/usr/bin/env node
// sync.mjs — one-shot, agent-free: pull the current Claude Design state and
// rebuild the site into public/. This is the whole "re-deploy from Claude Design
// without Claude Code" chain, minus scheduling and git (the CI workflow adds
// those). Run it anywhere Node + a design token are available.
//
// Reads design.config.json:
//   { projectId, fetchPrefix, template, out }
//
// Steps:
//   1. node scripts/fetch-design-files.mjs --project <id> --out design --prefix <fetchPrefix>
//   2. node build.mjs <template> <out>
//
// Auth: $DESIGN_MCP_TOKEN (an OAuth token with the agent_design_projects
// consent). In CI, set it as a secret; locally the fetch script falls back to
// the Claude Code token file.
//
// Change detection is left to git: this only writes files. Identical design →
// deterministic identical output → no git diff → nothing to deploy.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const cfg = JSON.parse(fs.readFileSync(new URL('../design.config.json', import.meta.url), 'utf8'));
for (const k of ['projectId', 'fetchPrefix', 'template', 'out']) {
  if (!cfg[k]) { console.error(`design.config.json missing "${k}"`); process.exit(2); }
}

const run = (args) => execFileSync('node', args, { stdio: 'inherit' });

console.log('› fetch design files');
run(['scripts/fetch-design-files.mjs', '--project', cfg.projectId, '--out', 'design', '--prefix', cfg.fetchPrefix]);

console.log('› build');
run(['build.mjs', cfg.template, cfg.out]);

console.log('✓ sync complete');
