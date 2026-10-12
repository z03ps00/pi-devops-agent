import fs from 'node:fs';
import path from 'node:path';

function unquote(value) {
  const text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

export function parseManifest(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((raw) => {
    if (!raw.trim() || raw.trim().startsWith('#')) return null;
    return { indent: raw.match(/^\s*/)[0].length, text: raw.trim() };
  }).filter(Boolean);

  function parseBlock(index, indent) {
    const obj = {};
    let i = index;
    while (i < lines.length && lines[i].indent >= indent) {
      const line = lines[i];
      if (line.indent > indent) break;
      const field = line.text.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (!field) throw new Error(`unsupported manifest line: ${line.text}`);
      const [, key, rest] = field;
      if (rest) {
        obj[key] = unquote(rest);
        i += 1;
        continue;
      }
      const next = lines[i + 1];
      if (next && next.indent > line.indent && next.text.startsWith('- ')) {
        const list = [];
        i += 1;
        while (i < lines.length && lines[i].indent > line.indent && lines[i].text.startsWith('- ')) {
          list.push(unquote(lines[i].text.slice(2)));
          i += 1;
        }
        obj[key] = list;
        continue;
      }
      const nested = parseBlock(i + 1, next ? next.indent : line.indent + 1);
      obj[key] = nested.value;
      i = nested.index;
    }
    return { value: obj, index: i };
  }

  return normalizeManifest(parseBlock(0, 0).value);
}

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter((item) => item && item !== '[]');
  if (value === '[]' || value == null || value === '') return [];
  if (value && typeof value === 'object') return Object.values(value).flat().map((item) => String(item)).filter((item) => item && item !== '[]');
  return [String(value)];
}

function asCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function normalizeManifest(root) {
  const requires = root.requires && typeof root.requires === 'object' && !Array.isArray(root.requires)
    ? { any: asList(root.requires.any), all: asList(root.requires.all) }
    : { any: asList(root.requires), all: [] };
  const learning = root.learning && typeof root.learning === 'object' ? root.learning : {};
  return {
    id: String(root.id ?? ''),
    version: String(root.version ?? ''),
    description: String(root.description ?? ''),
    status: root.status ? String(root.status) : 'active',
    triggers: asList(root.triggers),
    requires,
    optional: asList(root.optional),
    modes: asList(root.modes),
    tools: asList(root.tools),
    cost: String(root.cost?.context ?? root.cost ?? 'low'),
    quality: String(root.quality?.level ?? root.quality ?? 'verified'),
    learning: { successes: asCount(learning.successes), failures: asCount(learning.failures) },
  };
}

// Profile skills are usually symlinks into the repository.
function isDir(entry, dir) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

export function indexManifests(skillsDir) {
  if (!skillsDir || !fs.existsSync(skillsDir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    const dir = path.join(skillsDir, entry.name);
    if (!isDir(entry, dir)) continue;
    const file = path.join(dir, 'manifest.yaml');
    if (!fs.existsSync(file)) continue;
    const manifest = parseManifest(fs.readFileSync(file, 'utf8'));
    manifest.dir = dir;
    out.push(manifest);
  }
  return out;
}

export function mergeSkillCatalog(shipped = [], learned = []) {
  const shippedIds = new Set(shipped.map((item) => item.id).filter(Boolean));
  const collisions = [];
  const manifests = [...shipped];
  for (const item of learned) {
    if (item.id && shippedIds.has(item.id)) {
      collisions.push({ id: item.id, reason: 'shipped skill id' });
      continue;
    }
    manifests.push(item);
  }
  return { manifests, collisions };
}

function capabilityOn(available, name) {
  if (available instanceof Map) return available.get(name) === true;
  if (available instanceof Set) return available.has(name);
  return Boolean(available?.[name]);
}

export function requirementsMet(manifest, available) {
  const any = manifest.requires?.any ?? [];
  const all = manifest.requires?.all ?? [];
  if (any.length && !any.some((name) => capabilityOn(available, name))) {
    return { ok: false, reason: `missing dependency: ${any.join('|')}` };
  }
  if (all.some((name) => !capabilityOn(available, name))) {
    return { ok: false, reason: `missing dependency: ${all.filter((name) => !capabilityOn(available, name)).join('|')}` };
  }
  return { ok: true, reason: '' };
}

export function chooseSkills({ manifests = [], text = '', mode = 'ask', available = {}, limit = 2 } = {}) {
  const hay = String(text).toLowerCase();
  const selected = [];
  const skipped = [];
  for (const manifest of manifests) {
    const triggered = (manifest.triggers ?? []).some((trigger) => hay.includes(String(trigger).toLowerCase()));
    if (!triggered) continue;
    if (manifest.status === 'draft' || manifest.status === 'deactivated') {
      skipped.push({ id: manifest.id, reason: manifest.status });
      continue;
    }
    if (manifest.modes?.length && !manifest.modes.includes(mode)) {
      skipped.push({ id: manifest.id, reason: `mode ${mode}` });
      continue;
    }
    const gate = requirementsMet(manifest, available);
    if (!gate.ok) {
      skipped.push({ id: manifest.id, reason: gate.reason });
      continue;
    }
    selected.push(manifest);
  }
  selected.sort((a, b) => String(a.cost).localeCompare(String(b.cost)));
  return { selected: selected.slice(0, limit), skipped: skipped.concat(selected.slice(limit).map((item) => ({ id: item.id, reason: 'limit' }))) };
}

export function catalogMarkdownFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(dir, name);
    const raw = fs.readFileSync(file, 'utf8');
    const summary = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('---') && line !== '---') || name;
    out.push({ id: name, summary: summary.slice(0, 180), file });
  }
  return out;
}

export function readTextFile(file) {
  return fs.readFileSync(file, 'utf8');
}

export function readSkillBody(skillDir) {
  const file = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

export function auditSkillManifests(skillsDir) {
  if (!skillsDir || !fs.existsSync(skillsDir)) return { ok: true, details: 'no skills dir', missing: [] };
  const missing = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    const dir = path.join(skillsDir, entry.name);
    if (!isDir(entry, dir)) continue;
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    const file = path.join(dir, 'manifest.yaml');
    if (!fs.existsSync(file)) {
      missing.push(`${entry.name}: no manifest`);
      continue;
    }
    try {
      const manifest = parseManifest(fs.readFileSync(file, 'utf8'));
      if (!manifest.id) missing.push(`${entry.name}: id`);
      if (!manifest.requires) missing.push(`${entry.name}: requires`);
    } catch (error) {
      missing.push(`${entry.name}: ${error.message}`);
    }
  }
  return { ok: missing.length === 0, details: missing.join(', '), missing };
}
