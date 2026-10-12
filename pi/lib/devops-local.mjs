// Local path map of one machine. The repository never carries machine paths:
// every lab-specific location comes from `devops-local.json` in the profile
// directory, from `PI_DEVOPS_*` variables, or from a neutral default.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOCAL_MAP_FILE = 'devops-local.json';

export const HOST_PROFILE = Object.freeze({
  id: 'host',
  label: 'host',
  kind: 'host',
  container: '',
  namespace: '',
  launcher: '',
  envName: 'direct',
  proxy: '',
  proxyAllow: '',
});

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

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathIfNeeded(value) {
  const text = asText(value);
  if (!text) return '';
  return isPathLike(text) ? path.resolve(expandHome(text)) : text;
}

/** Named netns profiles from the map. Host is implicit and is not listed. */
export function networkProfiles(map) {
  const network = map?.network && typeof map.network === 'object' ? map.network : {};
  const raw = Array.isArray(network.profiles) ? network.profiles : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = asText(item.id);
    if (!id || id === 'host' || id === 'direct' || seen.has(id)) continue;
    if (item.kind === 'host') continue;
    seen.add(id);
    out.push({
      id,
      label: asText(item.label) || id,
      kind: 'netns',
      container: asText(item.container),
      namespace: asText(item.namespace),
      launcher: pathIfNeeded(item.launcher),
      envName: asText(item.envName) || id,
      proxy: pathIfNeeded(item.proxy),
      proxyAllow: pathIfNeeded(item.proxyAllow),
    });
  }
  return out;
}

export function readStoredNetworkId(netModeFile) {
  try {
    return fs.readFileSync(netModeFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Active profile for this process. Env wins, then the mode file, then
 * `network.default`. An unknown id is host, never a built-in tunnel name.
 */
export function resolveActiveNetwork(map, { env = process.env, stored = '' } = {}) {
  const profiles = networkProfiles(map);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const fromEnv = asText(env.PI_DEVOPS_NET_MODE);
  const preferred = asText(map?.network?.default);
  const candidates = [fromEnv, asText(stored), preferred].filter(Boolean);
  for (const id of candidates) {
    if (id === 'host' || id === 'direct') return { profile: { ...HOST_PROFILE }, unknown: false };
    const hit = byId.get(id);
    if (hit) return { profile: hit, unknown: false };
    return { profile: { ...HOST_PROFILE }, unknown: true };
  }
  return { profile: { ...HOST_PROFILE }, unknown: false };
}

/** Footer text. Empty when the map declares no netns profile. */
export function networkFooterLabel(map, profile) {
  if (!networkProfiles(map).length) return '';
  return asText(profile?.label) || 'host';
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
  const stored = readStoredNetworkId(netModeFile);
  const active = resolveActiveNetwork(map, { env, stored });
  const profiles = networkProfiles(map);
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
    network: {
      profiles,
      active: active.profile,
      unknown: active.unknown,
      footerLabel: networkFooterLabel(map, active.profile),
    },
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
