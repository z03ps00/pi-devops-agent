// Local path map of one machine. The repository never carries machine paths:
// every lab-specific location comes from `devops-local.json` in the profile
// directory, from `PI_DEVOPS_*` variables, or from a neutral default.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOCAL_MAP_FILE = 'devops-local.json';

export function expandHome(value, home = os.homedir()) {
  if (typeof value !== 'string') return value;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

export function profileDir(env = process.env) {
  const raw = String(env.PI_CODING_AGENT_DIR ?? '').trim();
  if (raw) return path.resolve(expandHome(raw));
  return path.join(os.homedir(), '.pi', 'agent');
}

export function localMapPath(env = process.env) {
  const raw = String(env.PI_DEVOPS_LOCAL_MAP ?? '').trim();
  return raw ? path.resolve(expandHome(raw)) : path.join(profileDir(env), LOCAL_MAP_FILE);
}

/** Reads the map; a missing or broken file yields `{}` plus a reason. */
export function readLocalMap(env = process.env) {
  const file = localMapPath(env);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { file, map: {}, error: 'map is not an object' };
    return { file, map: data, error: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, map: {}, error: null, missing: true };
    return { file, map: {}, error: String(error?.message ?? error) };
  }
}

function pickOptional(env, envKey, mapValue) {
  const fromEnv = String(env[envKey] ?? '').trim();
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  if (typeof mapValue === 'string' && mapValue.trim()) return path.resolve(expandHome(mapValue.trim()));
  return '';
}

function pick(env, envKey, mapValue, fallback) {
  const fromEnv = String(env[envKey] ?? '').trim();
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  if (typeof mapValue === 'string' && mapValue.trim()) return path.resolve(expandHome(mapValue.trim()));
  return fallback;
}

function isPathLike(value) {
  return typeof value === 'string' && /^(~[\\/]|\/|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(value);
}

function configHome(env) {
  const xdg = String(env.XDG_CONFIG_HOME ?? '').trim();
  return xdg ? path.resolve(xdg) : path.join(os.homedir(), '.config');
}

/**
 * Resolved locations for this process. `infraRoot` is the workspace whose
 * `INDEX.md` is the source of truth; without a map it is the current directory.
 */
export function resolveLocal(env = process.env, cwd = process.cwd()) {
  const { file, map, error, missing } = readLocalMap(env);
  const profile = profileDir(env);
  const infraRoot = pick(env, 'PI_DEVOPS_MCP_ROOT', map.infraRoot, path.resolve(cwd));
  const netModeFile = pick(env, 'PI_DEVOPS_NET_MODE_FILE', map.netModeFile, path.join(configHome(env), 'pi-devops-vpn', 'mode'));
  const lab = map.lab && typeof map.lab === 'object' ? map.lab : {};
  const dashboard = map.dashboard && typeof map.dashboard === 'object' ? map.dashboard : {};
  const legacyPendingRoots = Array.isArray(map.legacyPendingRoots)
    ? map.legacyPendingRoots.filter((x) => typeof x === 'string' && x.trim()).map((x) => path.resolve(expandHome(x)))
    : [];
  return {
    mapFile: file,
    mapMissing: Boolean(missing),
    mapError: error,
    map,
    profile,
    infraRoot,
    netModeFile,
    sessionDir: pick(env, 'PI_CODING_AGENT_SESSION_DIR', map.sessionDir, path.join(profile, 'sessions')),
    piBin: pickOptional(env, 'PI_DEVOPS_PI_BIN', map.piBin),
    backupDir: pickOptional(env, 'PI_DEVOPS_BACKUP_DIR', map.backupDir),
    planRoots: [path.join(infraRoot, '.devops', 'plans'), path.join(infraRoot, '.devops', 'drafts'), path.join(infraRoot, '.devops', 'handoffs')],
    handoffRoots: [path.join(infraRoot, '.devops', 'handoffs'), path.join(infraRoot, '.devops', 'handoff')],
    pendingRoot: path.join(profile, 'state', 'agent-memory', 'pending'),
    legacyPendingRoots,
    labOverlay: pick(env, 'PI_DEVOPS_LAB_OVERLAY', map.labOverlay, path.join(profile, 'lab', 'overlay.md')),
    labSkillNotes: pick(env, 'PI_DEVOPS_LAB_SKILLS', map.labSkillNotes, path.join(profile, 'lab', 'skills')),
    sharedContextRoot: pick(env, 'PI_DEVOPS_SHARED_CONTEXT', map.sharedContextRoot, ''),
    dashboard: {
      enabled: dashboard.enabled === true,
      artifacts: Array.isArray(dashboard.artifacts) ? dashboard.artifacts.map(String) : [],
      skill: typeof dashboard.skill === 'string' ? dashboard.skill : 'monitoring',
    },
    lab: Object.fromEntries(Object.entries(lab).map(([k, v]) => [k, isPathLike(v) ? path.resolve(expandHome(v)) : v])),
  };
}

/** True when the map declares the lab launcher and it exists on disk. */
export function hasLabLauncher(local) {
  const launcher = local?.lab?.launcher;
  return typeof launcher === 'string' && launcher !== '' && fs.existsSync(launcher);
}

/** Lab overlay text, or '' when there is none. */
export function readLabOverlay(local) {
  try {
    return fs.readFileSync(local.labOverlay, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Message used when a skill or the panel needs a key the map does not have. */
export function missingKeyHint(key, local) {
  return `devops-local.json has no '${key}': set it in ${local?.mapFile ?? LOCAL_MAP_FILE}`;
}
