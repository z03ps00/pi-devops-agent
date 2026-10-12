#!/usr/bin/env node
// Profile and package check. No model, no 1C probes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanTree } from '../../scripts/scan-public-tree.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..');

function check(id, ok, detail) {
  return { id, ok: Boolean(ok), detail: String(detail ?? '') };
}

function brokenSymlinks(dir) {
  const bad = [];
  if (!dir || !fs.existsSync(dir)) return bad;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (!entry.isSymbolicLink()) continue;
    try { fs.statSync(full); } catch { bad.push(full); }
  }
  return bad;
}

export function doctorReport({ profileDir = '', repo = repoRoot } = {}) {
  const checks = [];
  const pkgFile = path.join(packageRoot, 'package.json');
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch (error) {
    checks.push(check('package-json', false, error.message));
  }
  if (pkg) {
    checks.push(check('package-name', pkg.name === 'pi-devops-agent', pkg.name || ''));
    const extensions = pkg.pi?.extensions || [];
    const missing = extensions.filter((rel) => !fs.existsSync(path.join(packageRoot, rel)));
    checks.push(check('extensions', missing.length === 0, missing.join(', ') || `${extensions.length} entries`));
    const peer = pkg.peerDependencies?.['@earendil-works/pi-coding-agent'] || '';
    checks.push(check('pi-peer', peer.includes('1.1') && peer.includes('<1.2'), peer || 'missing'));
  }
  const hits = scanTree(repo);
  checks.push(check('forbidden-strings', hits.length === 0, hits.slice(0, 8).map((hit) => `${hit.file}:${hit.line}`).join(', ') || 'none'));

  if (profileDir) {
    const auth = path.join(profileDir, 'auth.json');
    let authOk = false;
    let authDetail = 'missing';
    try {
      const stat = fs.statSync(auth);
      authOk = stat.isFile();
      authDetail = authOk ? 'file' : 'not a file';
    } catch (error) {
      authDetail = error.code === 'ENOENT' ? 'missing or broken symlink' : error.message;
    }
    checks.push(check('auth', authOk, authDetail));
    const map = path.join(profileDir, 'devops-local.json');
    checks.push(check('local-map', fs.existsSync(map), fs.existsSync(map) ? map : 'missing'));
    const skills = path.join(profileDir, 'skills');
    const bad = brokenSymlinks(skills);
    checks.push(check('skill-symlinks', bad.length === 0, bad.join(', ') || 'ok'));
  }
  const ok = checks.every((item) => item.ok);
  return { ok, checks };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  const json = process.argv.includes('--json');
  const profile = process.argv.includes('--global') || !process.argv.includes('--package-only')
    ? String(process.env.PI_CODING_AGENT_DIR ?? '').trim()
    : '';
  const report = doctorReport({ profileDir: profile });
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    for (const item of report.checks) process.stdout.write(`${item.ok ? 'ok' : 'FAIL'}  ${item.id}  ${item.detail}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}

export const doctorModuleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
