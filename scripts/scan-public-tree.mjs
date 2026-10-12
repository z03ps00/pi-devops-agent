#!/usr/bin/env node
// Fails when the git tree contains a machine path, a lab address, or a lab container name.
// Patterns are concatenated so this file does not contain the forbidden text itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIR = new Set(['.git', 'node_modules', 'dist', 'state', 'sessions', 'lab', 'npm']);
const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.ts', '.json', '.yml', '.yaml', '.sh', '.tpl', '.txt', '.desktop', '.cmd', '.in', '.command']);

function patterns() {
  const home = '/' + 'home/';
  const users = '/' + 'Users/';
  return [
    { id: 'vol-a', re: new RegExp('/mnt/' + 'vol_328') },
    { id: 'vol-b', re: new RegExp('/mnt/' + 'vol_156') },
    { id: 'home-user', re: new RegExp(home + 'pavel') },
    { id: 'desktop', re: new RegExp('Рабочий ' + 'стол') },
    { id: 'awg-name', re: new RegExp('tunnel-' + 'awg-proxy-1') },
    { id: 'port-a', re: new RegExp(':145' + '5\\b') },
    { id: 'port-b', re: new RegExp(':145' + '7\\b') },
    { id: 'port-c', re: new RegExp(':87' + '87\\b') },
    { id: 'lan-a', re: new RegExp('172\\.' + '19\\.\\d') },
    { id: 'lan-b', re: new RegExp('192\\.' + '168\\.\\d') },
    { id: 'home-any', re: new RegExp(home + '[A-Za-z0-9._-]+') },
    { id: 'users-any', re: new RegExp(users + '[A-Za-z0-9._-]+') },
    { id: 'win-users', re: new RegExp('[A-Za-z]:\\\\Users\\\\') },
  ];
}

export function scanText(text, file, rules = patterns()) {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of rules) {
      if (rule.re.test(line)) hits.push({ file, line: index + 1, id: rule.id });
      rule.re.lastIndex = 0;
    }
  });
  return hits;
}

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

export function scanTree(root) {
  const rules = patterns();
  const hits = [];
  for (const file of walk(root)) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    hits.push(...scanText(text, path.relative(root, file), rules));
  }
  return hits;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (isMain()) {
  const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const hits = scanTree(root);
  if (!hits.length) {
    process.stdout.write(`scan ok: ${root}\n`);
  } else {
    for (const hit of hits) process.stderr.write(`${hit.file}:${hit.line} ${hit.id}\n`);
    process.stderr.write(`scan failed: ${hits.length}\n`);
    process.exitCode = 1;
  }
}
