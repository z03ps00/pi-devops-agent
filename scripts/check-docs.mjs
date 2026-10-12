#!/usr/bin/env node
// Live documentation check. Patterns and roots come from devops-local.json
// (docsCheck). Without that map the command skips and exits 0, so CI stays green.
import fs from 'node:fs';
import path from 'node:path';

function mapPath(env = process.env) {
  const fromEnv = String(env.PI_DEVOPS_LOCAL_MAP ?? '').trim();
  if (fromEnv) return fromEnv;
  const profile = String(env.PI_CODING_AGENT_DIR ?? '').trim();
  if (!profile) return '';
  return path.join(profile, 'devops-local.json');
}

export function loadDocsCheck(env = process.env) {
  const file = mapPath(env);
  if (!file || !fs.existsSync(file)) return { file, check: null };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const check = data && typeof data.docsCheck === 'object' ? data.docsCheck : null;
  return { file, check };
}

function mentionedPaths(text) {
  const re = /(?:^|[\s`'"(=])(\/(?:mnt|home|Users)\/[^\s`'"),]+)/g;
  const out = [];
  let match;
  while ((match = re.exec(text))) out.push(match[1].replace(/[.,;:]+$/, ''));
  return out;
}

function looksConcrete(value) {
  if (!value) return false;
  if (/[<*{}$:]|xxx|\.\.\./i.test(value)) return false;
  return true;
}

export function reviewDocs(check, { strict = false } = {}) {
  const fails = [];
  const warns = [];
  const files = Array.isArray(check.files) ? check.files : [];
  const extra = Array.isArray(check.extraFiles) ? check.extraFiles : [];
  const present = [];
  for (const file of files) {
    if (!fs.existsSync(file)) fails.push(`missing ${file}`);
    else present.push(file);
  }
  for (const file of extra) {
    if (fs.existsSync(file)) present.push(file);
  }
  const roots = (Array.isArray(check.failRoots) ? check.failRoots : []).map((root) => (root.endsWith('/') ? root : `${root}/`));
  const regressions = Array.isArray(check.regressions) ? check.regressions : [];
  for (const file of present) {
    const text = fs.readFileSync(file, 'utf8');
    for (const row of regressions) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const [severity, message, ere] = row;
      let hit = false;
      try { hit = new RegExp(ere, 'm').test(text); } catch { warns.push(`bad regression in map: ${message}`); continue; }
      if (!hit) continue;
      const line = `${severity || 'FAIL'} ${file}: ${message}`;
      if (String(severity).toUpperCase() === 'WARN' && !strict) warns.push(line);
      else fails.push(line);
    }
    for (const mentioned of mentionedPaths(text)) {
      if (!looksConcrete(mentioned)) continue;
      if (!roots.some((root) => mentioned === root.slice(0, -1) || mentioned.startsWith(root))) continue;
      if (fs.existsSync(mentioned)) continue;
      const line = `path not on disk ${file}: ${mentioned}`;
      if (strict) fails.push(line);
      else warns.push(line);
    }
  }
  return { fails, warns, scanned: present.length };
}

function printResult(result) {
  for (const line of result.fails) process.stderr.write(`FAIL  ${line}\n`);
  for (const line of result.warns) process.stdout.write(`WARN  ${line}\n`);
  process.stdout.write(`check-docs: scanned ${result.scanned}, fail ${result.fails.length}, warn ${result.warns.length}\n`);
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return fs.realpathSync(entry) === fs.realpathSync(new URL(import.meta.url).pathname); } catch { return false; }
}

if (isMain()) {
  const strict = process.argv.includes('--strict');
  const loaded = loadDocsCheck();
  if (!loaded.check) {
    process.stdout.write('check-docs: no local map, live doc check skipped\n');
  } else {
    const result = reviewDocs(loaded.check, { strict });
    printResult(result);
    if (result.fails.length) process.exitCode = 1;
  }
}
