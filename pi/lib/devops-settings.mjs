// Profile-level switches that survive a new session. Session-only state
// (mode, approve, anon, caveman) lives in session entries instead.
import fs from 'node:fs';
import path from 'node:path';

export const SETTINGS_FILE = path.join('state', 'devops-settings.json');

const DEFAULTS = Object.freeze({ economy: 'off' });

export function settingsPath(profileDir) {
  return path.join(profileDir, SETTINGS_FILE);
}

export function readSettings(profileDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(profileDir), 'utf8'));
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(profileDir, patch) {
  const next = { ...readSettings(profileDir), ...patch };
  const file = settingsPath(profileDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

export function parseOnOff(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return { kind: 'pick' };
  if (raw === 'status') return { kind: 'status' };
  if (raw === 'on' || raw === 'off') return { kind: 'set', value: raw };
  return { kind: 'invalid', raw };
}

export function economyEnabled(profileDir) {
  return readSettings(profileDir).economy === 'on';
}
