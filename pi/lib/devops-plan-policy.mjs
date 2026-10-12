// Read-only policy shared by the PLAN and ASK DevOps modes.
// PLAN may additionally write planning artifacts under PLAN_WRITABLE_ROOTS,
// ASK is strictly read-only and may not write anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { resolveLocal } from './devops-local.mjs';

const LOCAL = resolveLocal();

// Infrastructure root (`infraRoot` in the local map) and PLAN writable roots.
export const PLAN_BASE = LOCAL.infraRoot;
export const PLAN_WRITABLE_ROOTS = LOCAL.planRoots;

const EXACT_READ_ONLY = new Set(['read', 'grep', 'find', 'ls']);

const READ_ONLY_PATTERNS = [
  /(^|[_-])(read|get|list|find|grep|search|lookup|inspect|describe|show|query|review|check|validate|analy[sz]e|trace|status|health)([_-]|$)/i,
];

const PLAN_MCP_READ_ONLY_TOOLS = Object.freeze({
  knowledge: new Set(['find', 'glob', 'grep', 'health', 'list', 'list_watches', 'read', 'search', 'tree']),
  memory: new Set(['recall', 'search_tools']),
});

// Subset of the read-only tools above that counts as an actual *recall* of shared
// context. Status/discovery calls (health, list_watches, search_tools) are
// deliberately excluded: they read no memory and no knowledge.
const RECALL_MCP_READ_ONLY_TOOLS = Object.freeze({
  knowledge: new Set(['find', 'glob', 'grep', 'list', 'read', 'search', 'tree']),
  memory: new Set(['recall']),
});

const RECALL_TOOL_NAMES = new Set([
  ...RECALL_MCP_READ_ONLY_TOOLS.knowledge,
  ...RECALL_MCP_READ_ONLY_TOOLS.memory,
]);

// --------------------------------------------------------------------------
// Command analysis (shared)
//
// One conservative analysis serves two consumers:
//   * evaluatePlanBash()        — read-only policy: allow only what is clearly read-only
//   * classifyBashMutation()    — completion gates: arm only on real mutations
//
// It works on command *positions* (argv), not on raw text, therefore:
//   - `rg 'rm -rf' skills/` is read-only (the word sits in an argument);
//   - `"rm" -rf`, `docker${IFS}rm`, `docker --context default rm` are mutations.
// --------------------------------------------------------------------------

const SEGMENT_SPLIT = /[;&|\n]+/;

// Known-safe read-only utilities (command position). Everything else is denied
// in read-only modes (fail-closed). Extend deliberately.
const READ_ONLY_COMMANDS = new Set([
  'cat', 'tac', 'head', 'tail', 'less', 'more', 'wc', 'sort', 'uniq', 'cut', 'tr',
  'column', 'nl', 'od', 'xxd', 'strings', 'base64', 'grep', 'rg', 'egrep', 'fgrep',
  'find', 'ls', 'tree', 'stat', 'file', 'du', 'df', 'free', 'uptime', 'ps', 'top',
  'htop', 'lsof', 'ss', 'netstat', 'ping', 'dig', 'host', 'nslookup', 'getent',
  'which', 'command', 'type', 'realpath', 'readlink', 'basename', 'dirname',
  'md5sum', 'sha1sum', 'sha256sum', 'cksum', 'diff', 'cmp', 'jq', 'yq', 'paste',
  'join', 'comm', 'expand', 'unexpand', 'fold', 'rev', 'seq', 'test', '[', 'true',
  'false', 'echo', 'printf', 'date', 'hostname', 'uname', 'id', 'whoami', 'groups',
  'nproc', 'lscpu', 'lsblk', 'lsusb', 'lspci', 'dmidecode', 'smartctl', 'sensors',
  'nvidia-smi', 'xrandr', 'xwininfo', 'xdotool', 'pgrep', 'vmstat', 'iostat',
  'mpstat', 'pidstat', 'journalctl', 'curl', 'git', 'docker', 'podman', 'nerdctl',
  'systemctl', 'virsh', 'ip', 'nft', 'iptables', 'ip6tables',
]);

// Commands that always mutate something.
const MUTATING_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'install', 'rsync', 'tar', 'unzip', 'zip', '7z', 'patch',
  'chmod', 'chown', 'chgrp', 'mkdir', 'rmdir', 'touch', 'ln', 'truncate', 'dd',
  'fallocate', 'swapon', 'swapoff', 'mount', 'umount', 'mkfs', 'mkswap', 'shred',
  'wipefs', 'parted', 'fdisk', 'sgdisk', 'swapfile', 'setfacl', 'setfattr',
  'chattr', 'attr', 'tee', 'sponge', 'rename', 'apt', 'apt-get', 'aptitude',
  'dpkg', 'snap', 'dnf', 'yum', 'zypper', 'apk', 'rpm', 'pip', 'pip3', 'pipx',
  'npm', 'pnpm', 'yarn', 'gem', 'cargo', 'go', 'composer', 'nix', 'docker-compose',
  'service', 'invoke-rc.d', 'systemd-run', 'reboot', 'shutdown', 'poweroff',
  'halt', 'init', 'telinit', 'kexec', 'kill', 'pkill', 'killall', 'fuser',
  'modprobe', 'insmod', 'rmmod', 'depmod', 'sysctl', 'update-grub', 'grub-install',
  'ufw', 'firewall-cmd', 'tc', 'virt-install', 'virt-clone', 'printenv', 'set',
  'export', 'declare', 'typeset', 'env', 'source', 'eval',
]);

// Interpreters: in read-only modes we never execute scripts or inline code.
const INTERPRETERS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'python', 'python2',
  'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'awk', 'gawk',
  'mawk', 'sed', 'ed', 'make', 'xargs', 'timeout', 'nohup', 'watch', 'script',
  'expect', 'busybox', 'sudo', 'doas', '.',
]);

const CONTAINER_MUTATING_VERBS = new Set([
  'run', 'rm', 'rmi', 'stop', 'start', 'restart', 'kill', 'exec', 'pull', 'push',
  'build', 'create', 'cp', 'commit', 'tag', 'update', 'rename', 'pause',
  'unpause', 'prune', 'load', 'import', 'save', 'swarm', 'prune-images',
]);
const CONTAINER_PARENTS = new Set([
  'image', 'images', 'container', 'context', 'builder', 'volume', 'network',
  'secret', 'config', 'plugin', 'system', 'compose',
]);

const VIRSH_READ_ONLY_VERBS = new Set([
  'list', 'dominfo', 'domstate', 'domblklist', 'domiflist', 'snapshot-list',
  'pool-list', 'net-list', 'vol-list', 'nodedev-list', 'domstats', 'version',
  'nodeinfo', 'help',
]);

const SYSTEMCTL_READ_ONLY_VERBS = new Set([
  'status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files',
  'list-timers', 'show', 'cat', 'list-dependencies', 'get-default', 'has-failed',
  'list-jobs', 'version',
]);

const GIT_READ_ONLY_VERBS = new Set([
  'status', 'log', 'show', 'diff', 'branch', 'rev-parse', 'ls-files', 'describe',
  'shortlog', 'blame', 'grep', 'cat-file', 'for-each-ref', 'version', 'help',
  'rev-list', 'name-rev', 'whatchanged', 'count-objects', 'verify-pack', 'pretty',
]);

const IP_MUTATING_VERBS = new Set(['add', 'del', 'delete', 'set', 'flush', 'replace', 'change', 'append']);

const SECRET_PATH_RE = /(^|[\/.])(\.env(\..*)?|auth\.json|\.netrc|\.git-credentials|credentials\.json|token\.json|secrets?|\.ssh|id_rsa|id_ed25519|\.pem|\.key|\/proc\/\d+\/environ|\/proc\/\d+\/cmdline)/i;

const VALUE_FLAGS = new Set([
  '--context', '-c', '-H', '--host', '--user', '-u', '--config', '-C',
  '--profile', '-p', '--log-level', '--format', '--namespace', '-n',
  '--device', '--exec-opt', '--env', '-e', '--workdir', '-w',
]);

function unquote(cmd) {
  return String(cmd ?? '')
    .replace(/\$\{IFS\}|\$IFS/g, ' ')
    .replace(/\$'\\t'|\$"\\t"/g, ' ')
    .replace(/\\\n/g, ' ')
    .replace(/\\([\\'"` ])/g, '$1')
    .replace(/'([^']*)'/g, '$1')
    .replace(/"([^"]*)"/g, '$1');
}

// Removes quoted segments entirely — used for structural checks so that a `>`
// inside an argument no longer looks like a redirection.
function stripQuoted(cmd) {
  return String(cmd ?? '')
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, ' ');
}

function splitSegments(cmd) {
  return unquote(cmd)
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
}

function baseName(token) {
  const t = String(token ?? '');
  const idx = t.lastIndexOf('/');
  return (idx >= 0 ? t.slice(idx + 1) : t).toLowerCase();
}

function extractVerb(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) continue;
    if (i > 0 && VALUE_FLAGS.has(tokens[i - 1])) continue;
    return { verb: t, rest: tokens.slice(i + 1), at: i };
  }
  return { verb: '', rest: [], at: -1 };
}

function redirectionProblem(stripped) {
  const re = /\d*>>?/g;
  let m;
  while ((m = re.exec(stripped))) {
    const rest = stripped.slice(m.index + m[0].length);
    if (/^&/.test(rest)) continue; // 2>&1 and friends
    const target = (rest.match(/^\s*(\S+)/) || [])[1] ?? '';
    if (target === '' || target === '/dev/null') continue;
    return `output redirection to ${target}`;
  }
  return null;
}

function secretToken(tokens) {
  for (const t of tokens) {
    if (!t || t.startsWith('-')) continue;
    if (SECRET_PATH_RE.test(t)) return t;
    try {
      if (fs.existsSync(t)) {
        const real = fs.realpathSync(t);
        if (SECRET_PATH_RE.test(real)) return real;
      }
    } catch {
      /* ignore unreadable paths */
    }
  }
  return null;
}

/**
 * Classify a shell command for the DevOps agent.
 * @returns {{ verdict: 'read-only'|'mutating'|'unknown', reason: string }}
 */
export function classifyBashCommand(command) {
  const raw = typeof command === 'string' ? command.trim() : '';
  if (!raw) return { verdict: 'unknown', reason: 'empty shell command' };

  const stripped = stripQuoted(raw);
  if (stripped.includes('`')) return { verdict: 'mutating', reason: 'command substitution' };
  if (stripped.includes('$(')) return { verdict: 'mutating', reason: 'command substitution' };
  const redir = redirectionProblem(stripped);
  if (redir) return { verdict: 'mutating', reason: redir };

  const segments = splitSegments(raw);
  let sawUnknown = false;
  let unknownName = '';

  for (const segment of segments) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = baseName(tokens[0]);
    const args = tokens.slice(1);

    if (INTERPRETERS.has(name)) return { verdict: 'mutating', reason: `interpreter '${name}' is not allowed in read-only mode` };
    if (MUTATING_COMMANDS.has(name)) return { verdict: 'mutating', reason: `'${name}' mutates state` };

    const secret = secretToken(tokens);
    if (secret) return { verdict: 'mutating', reason: `secret path '${secret}'` };

    if (name === 'find') {
      if (args.some((a) => /^-(exec|execdir|delete|fprint|fprint0|fls|ok|okdir)$/.test(a))) {
        return { verdict: 'mutating', reason: 'find with -exec/-delete/-fprint' };
      }
    }
    if (name === 'date' && args.includes('-s')) return { verdict: 'mutating', reason: 'date -s sets the clock' };
    if (name === 'hostname' && args.some((a) => !a.startsWith('-'))) return { verdict: 'mutating', reason: 'hostname with an argument sets it' };
    if (name === 'journalctl' && args.some((a) => /^--(vacuum|rotate|flush)/.test(a))) {
      return { verdict: 'mutating', reason: 'journalctl maintenance' };
    }
    if (name === 'systemctl') {
      const { verb } = extractVerb(args);
      if (verb && !SYSTEMCTL_READ_ONLY_VERBS.has(verb)) return { verdict: 'mutating', reason: `systemctl ${verb}` };
      if (verb === 'show' && args.includes('-p') && args.some((a) => /Environment|Password|Token/i.test(a))) {
        return { verdict: 'mutating', reason: 'systemctl show environment' };
      }
    }
    if (name === 'docker' || name === 'podman' || name === 'nerdctl') {
      const { verb, rest } = extractVerb(args);
      if (CONTAINER_MUTATING_VERBS.has(verb)) return { verdict: 'mutating', reason: `${name} ${verb}` };
      if (verb === 'compose') {
        const inner = extractVerb(rest).verb;
        if (inner && !['ps', 'logs', 'top', 'version'].includes(inner)) return { verdict: 'mutating', reason: `${name} compose ${inner}` };
      }
      if (CONTAINER_PARENTS.has(verb)) {
        const inner = extractVerb(rest).verb;
        if (CONTAINER_MUTATING_VERBS.has(inner)) return { verdict: 'mutating', reason: `${name} ${verb} ${inner}` };
      }
    }
    if (name === 'virsh') {
      const { verb } = extractVerb(args);
      if (verb && !VIRSH_READ_ONLY_VERBS.has(verb)) return { verdict: 'mutating', reason: `virsh ${verb}` };
    }
    if (name === 'git') {
      const { verb } = extractVerb(args);
      if (verb && !GIT_READ_ONLY_VERBS.has(verb)) {
        // read-only forms of a few verbs that also mutate
        const text = args.join(' ');
        const safe = (verb === 'config' && /--(get|list)\b/.test(text))
          || (verb === 'stash' && /^list\b/.test((extractVerb(args).rest || []).join(' ')))
          || (verb === 'worktree' && /^list\b/.test((extractVerb(args).rest || []).join(' ')))
          || (verb === 'tag' && (args.length === 1 || /(-l|--list)\b/.test(text)))
          || (verb === 'remote' && (args.length === 1 || /(-v|--verbose|show)\b/.test(text)));
        if (!safe) return { verdict: 'mutating', reason: `git ${verb}` };
      }
    }
    if (name === 'ip') {
      const { verb, rest } = extractVerb(args);
      const inner = extractVerb(rest).verb;
      if (IP_MUTATING_VERBS.has(inner)) return { verdict: 'mutating', reason: `ip ${verb} ${inner}` };
    }
    if (name === 'nft' || name === 'iptables' || name === 'ip6tables') {
      const text = args.join(' ');
      if (/\s-(A|I|D|F|P|N|X|Z|R|E)\b/.test(` ${text}`)) return { verdict: 'mutating', reason: `${name} rule change` };
      if (name === 'nft' && !/^\s*(list|-L)/.test(text)) return { verdict: 'mutating', reason: 'nft without list' };
      if (name !== 'nft' && !/\s(-L|-S|-n)\b/.test(` ${text}`)) return { verdict: 'mutating', reason: `${name} without -L/-S` };
    }
    if (name === 'curl') {
      const text = args.join(' ');
      if (/(^|\s)(-O|--remote-name|-T|--upload-file)\b/.test(text)) return { verdict: 'mutating', reason: 'curl upload/remote-name' };
      const out = text.match(/(^|\s)(-o|--output)\s+(\S+)/);
      if (out && out[3] !== '/dev/null') return { verdict: 'mutating', reason: `curl writes ${out[3]}` };
      if (/(^|\s)(--data-binary|--data|--data-raw|--json)\s*@/.test(text)) return { verdict: 'mutating', reason: 'curl reads a local file' };
    }

    if (!READ_ONLY_COMMANDS.has(name)) {
      sawUnknown = true;
      unknownName = name;
    }
  }

  if (sawUnknown) return { verdict: 'unknown', reason: `command '${unknownName}' is not in the read-only allowlist` };
  return { verdict: 'read-only', reason: 'read-only diagnostics' };
}

/** True when the command really changes state (used by the completion gates). */
export function classifyBashMutation(command) {
  return classifyBashCommand(command).verdict === 'mutating';
}

export function isPlanReadOnlyToolName(name) {
  if (EXACT_READ_ONLY.has(name)) return true;
  if (name === 'write' || name === 'edit' || name === 'bash') return false;
  return READ_ONLY_PATTERNS.some((re) => re.test(name));
}

export function getPlanVisibleTools(activeTools, allTools) {
  const available = new Set(allTools);
  const requested = new Set(activeTools);
  const out = [];
  for (const name of activeTools) {
    if (!available.has(name)) continue;
    if (isPlanReadOnlyToolName(name) || name === 'bash' || name === 'write' || name === 'edit') out.push(name);
  }
  // Never re-enable a tool the caller had disabled: PLAN/ASK may keep write/edit/bash
  // only when they were already active.
  for (const name of ['write', 'edit', 'bash']) {
    if (available.has(name) && requested.has(name) && !out.includes(name)) out.push(name);
  }
  if (available.has('mcp') && requested.has('mcp') && !out.includes('mcp')) out.push('mcp');
  return [...new Set(out)];
}

// Visible tool set per read-only mode. ASK hides `write`/`edit` entirely so the
// model has no file-mutation tools at all; PLAN keeps them for planning artifacts.
export function getReadOnlyVisibleTools(mode, activeTools, allTools) {
  const base = getPlanVisibleTools(activeTools, allTools);
  if (mode === 'ask') return base.filter((name) => name !== 'write' && name !== 'edit');
  return base;
}

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function rejectSymlinkSegments(base, target) {
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let cur = base;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    if (!fs.existsSync(cur)) continue;
    const stat = fs.lstatSync(cur);
    if (stat.isSymbolicLink()) return false;
  }
  return true;
}

export function resolvePlanningWrite(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return { allowed: false, reason: 'missing target path' };
  }
  const base = path.resolve(PLAN_BASE);
  const target = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(base, candidate);
  const roots = PLAN_WRITABLE_ROOTS.map((r) => path.resolve(r));
  const root = roots.find((r) => isWithin(r, target));
  if (!root) {
    return { allowed: false, reason: `target is outside read-only writable roots: ${PLAN_WRITABLE_ROOTS.join(', ')}` };
  }
  if (!rejectSymlinkSegments(base, target)) {
    return { allowed: false, reason: 'symlink traversal is not allowed in read-only writes' };
  }
  return { allowed: true, target, root };
}

export function extractToolTarget(input = {}) {
  for (const key of ['path', 'file_path', 'filePath', 'target', 'filename', 'file', 'dest', 'destination', 'output']) {
    if (typeof input?.[key] === 'string' && input[key].trim()) return input[key];
  }
  return undefined;
}

/** All path-like values found in a tool input, including nested edits arrays. */
export function extractAllToolTargets(input = {}) {
  const out = [];
  const pushValue = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v);
  };
  const walk = (node, depth = 0) => {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (/^(path|file_path|filePath|target|filename|file|dest|destination|output|new_path|source|src)$/i.test(key)) {
        pushValue(value);
      } else if (value && typeof value === 'object') {
        walk(value, depth + 1);
      }
    }
  };
  walk(input);
  return [...new Set(out)];
}

/** Read-only tools must not be pointed at secret material. */
function readToolSecretProblem(input = {}) {
  const candidates = extractAllToolTargets(input);
  for (const candidate of candidates) {
    if (SECRET_PATH_RE.test(candidate)) return candidate;
    try {
      if (fs.existsSync(candidate)) {
        const real = fs.realpathSync(candidate);
        if (SECRET_PATH_RE.test(real)) return real;
      }
    } catch {
      /* ignore unreadable paths */
    }
  }
  return null;
}

export function evaluatePlanBash(command) {
  const cmd = typeof command === 'string' ? command : '';
  if (!cmd.trim()) return { allowed: false, reason: 'empty shell command' };
  const { verdict, reason } = classifyBashCommand(cmd);
  if (verdict === 'read-only') return { allowed: true, reason: 'read-only diagnostics' };
  if (verdict === 'mutating') return { allowed: false, reason: `read-only mode blocks ${reason}` };
  return { allowed: false, reason: `read-only mode denies ${reason}` };
}

function normalizeMcpToolName(serverName, toolName) {
  const tool = String(toolName ?? '').trim();
  if (serverName && tool.startsWith(`${serverName}_`)) return tool.slice(serverName.length + 1);
  return tool;
}

/**
 * Recall evidence: an MCP call that actually reads shared memory/knowledge.
 * Accepts both adapter shapes — the `mcp` gateway (`{ tool, server? }`) and
 * per-server tools (`mcp__<server>__<tool>`). Gateway calls without `tool`
 * (status/search/describe/auth actions) never count.
 */
export function isRecallMcpCall(toolName, input = {}) {
  if (typeof toolName !== 'string') return false;
  if (toolName === 'mcp') {
    if (!input || typeof input !== 'object') return false;
    const tool = typeof input.tool === 'string' ? input.tool.trim() : '';
    if (!tool) return false;
    const server = typeof input.server === 'string' ? input.server.trim() : '';
    if (!server) return RECALL_TOOL_NAMES.has(tool);
    return RECALL_MCP_READ_ONLY_TOOLS[server]?.has(normalizeMcpToolName(server, tool)) ?? false;
  }
  if (toolName.startsWith('mcp__')) {
    const rest = toolName.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep <= 0) return false;
    const server = rest.slice(0, sep);
    const tool = normalizeMcpToolName(server, rest.slice(sep + 2));
    return RECALL_MCP_READ_ONLY_TOOLS[server]?.has(tool) ?? false;
  }
  return false;
}

// --------------------------------------------------------------------------
// Anonymous-session policy (DevOps profile)
//
// Levels are normalised in devops-plan-state.mjs and arrive here as plain
// numbers:
//   1 — no writes into Cognee/OpenViking and no local pending-memory record;
//   2 — the same plus no reads: the topic must not reach the stores at all;
//   3 — the same plus no handoff documents.
//
// The policy is fail-closed for unknown tools of the two shared-memory servers:
// anything that is not in the read-only set counts as a write.
// --------------------------------------------------------------------------

export const ANON_SHARED_MEMORY_SERVERS = Object.freeze(['memory', 'knowledge']);

// Local roots that must never receive an anonymous-session record.
export const ANON_PENDING_ROOT = LOCAL.pendingRoot;
export const ANON_PENDING_ROOTS = Object.freeze([LOCAL.pendingRoot, ...LOCAL.legacyPendingRoots]);
export const ANON_HANDOFF_ROOTS = Object.freeze([...LOCAL.handoffRoots]);

// Read-only entry points of the two stores. `health` is a pure liveness probe
// and stays allowed even at level 2; every other tool is treated as a write.
const ANON_MEMORY_READ_TOOLS = new Set(['recall', 'search_tools', 'health', 'get', 'list', 'status']);
const ANON_KNOWLEDGE_READ_TOOLS = new Set(['find', 'search', 'read', 'list', 'list_watches', 'tree', 'grep', 'glob', 'health']);
const ANON_ALWAYS_ALLOWED_TOOLS = new Set(['health']);

/**
 * Resolves the server/tool pair of an MCP call in every adapter shape:
 *   `mcp__<server>__<tool>` direct tools, the `mcp` gateway (`{ server?, tool }`)
 * and bare `memory_*`/`knowledge_*` names. Returns null for non-MCP tools.
 */
export function describeMcpCall(toolName, input = {}) {
  if (typeof toolName !== 'string') return null;
  if (toolName === 'mcp') {
    const raw = typeof input?.tool === 'string' ? input.tool.trim() : '';
    if (!raw) return null;
    const explicit = typeof input?.server === 'string' ? input.server.trim() : '';
    if (explicit) return { server: explicit, tool: normalizeMcpToolName(explicit, raw) };
    const inferred = inferSharedMemoryServer(raw);
    return { server: inferred, tool: inferred ? normalizeMcpToolName(inferred, raw) : raw };
  }
  if (toolName.startsWith('mcp__')) {
    const rest = toolName.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep > 0) {
      const server = rest.slice(0, sep);
      return { server, tool: normalizeMcpToolName(server, rest.slice(sep + 2)) };
    }
    // Per-server namespace proxy: `mcp__memory` with `{ tool: 'memory_recall' }`.
    const nested = typeof input?.tool === 'string' ? input.tool.trim() : '';
    return { server: rest, tool: normalizeMcpToolName(rest, nested) };
  }
  const inferred = inferSharedMemoryServer(toolName);
  if (inferred) return { server: inferred, tool: normalizeMcpToolName(inferred, toolName) };
  return null;
}

function inferSharedMemoryServer(toolName) {
  const t = String(toolName ?? '').trim();
  for (const server of ANON_SHARED_MEMORY_SERVERS) {
    if (t === server || t.startsWith(`${server}_`)) return server;
  }
  return '';
}

function isSharedMemoryServer(serverName) {
  return ANON_SHARED_MEMORY_SERVERS.includes(String(serverName ?? '').trim());
}

/**
 * Anonymous verdict for a shared-memory MCP call.
 * @returns {{ allowed: boolean, reason: string }}
 */
export function evaluateAnonMcpCall(level, serverName, originalToolName) {
  const lvl = Math.trunc(Number(level)) || 0;
  if (lvl <= 0) return { allowed: true, reason: 'anonymous mode off' };
  const server = String(serverName ?? '').trim();
  if (!isSharedMemoryServer(server)) return { allowed: true, reason: 'not a shared-memory server' };
  const tool = normalizeMcpToolName(server, originalToolName);
  if (ANON_ALWAYS_ALLOWED_TOOLS.has(tool)) return { allowed: true, reason: 'liveness check only' };
  const readTools = server === 'memory' ? ANON_MEMORY_READ_TOOLS : ANON_KNOWLEDGE_READ_TOOLS;
  if (!readTools.has(tool)) {
    return { allowed: false, reason: `anonymous session (anon:${lvl}) forbids writing to '${server}.${originalToolName}'` };
  }
  if (lvl >= 2) {
    return { allowed: false, reason: `anonymous session (anon:${lvl}) forbids reading from '${server}.${originalToolName}'` };
  }
  return { allowed: true, reason: 'anon:1 keeps shared-memory reads' };
}

function anonPathCandidates(input = {}) {
  const out = [...extractAllToolTargets(input)];
  for (const key of ['command', 'cmd', 'script', 'content']) {
    if (typeof input?.[key] === 'string' && input[key].trim()) out.push(input[key]);
  }
  return out;
}

function mentionsRoot(candidate, root) {
  const value = String(candidate ?? '');
  if (!value) return false;
  const resolved = path.resolve(value.startsWith('/') ? value : path.join(PLAN_BASE, value));
  return isWithin(path.resolve(root), resolved) || value.includes(root);
}

/**
 * Anonymous verdict for a local file write (`write`, `edit`, mutating `bash`).
 * Only the trace-producing roots are blocked: normal infrastructure edits stay
 * allowed, because configs/docs are infrastructure state, not personal data.
 * @returns {{ allowed: boolean, reason: string }}
 */
export function evaluateAnonWriteCall(level, toolName, input = {}) {
  const lvl = Math.trunc(Number(level)) || 0;
  if (lvl <= 0) return { allowed: true, reason: 'anonymous mode off' };
  if (toolName !== 'write' && toolName !== 'edit' && toolName !== 'bash') {
    return { allowed: true, reason: 'not a file-writing tool' };
  }
  for (const candidate of anonPathCandidates(input)) {
    const pending = ANON_PENDING_ROOTS.find((root) => mentionsRoot(candidate, root))
      ?? (/agent-memory[\\/]pending/.test(String(candidate)) ? 'agent-memory/pending' : undefined);
    if (pending) {
      return { allowed: false, reason: `anonymous session forbids pending-memory records (${pending})` };
    }
    if (lvl >= 3 && ANON_HANDOFF_ROOTS.some((root) => mentionsRoot(candidate, root))) {
      return { allowed: false, reason: 'anonymous level 3 forbids handoff documents' };
    }
  }
  return { allowed: true, reason: 'target holds no anonymous-session trace' };
}

export function evaluatePlanMcpCall(serverName, originalToolName) {
  const tool = normalizeMcpToolName(serverName, originalToolName);
  const allowed = PLAN_MCP_READ_ONLY_TOOLS[serverName]?.has(tool) ?? false;
  return allowed
    ? { allowed: true, reason: 'read-only MCP tool' }
    : { allowed: false, reason: `MCP mutation or unknown tool '${serverName}.${originalToolName}'` };
}

export function evaluatePlanMcpProxyCall(input = {}, forcedServer) {  if (input && typeof input === 'object' && input.action) {
    return { allowed: false, reason: 'MCP authentication/UI actions are disabled in read-only mode' };
  }
  if (input && typeof input === 'object' && input.connect) {
    return { allowed: false, reason: 'MCP server connect is disabled in read-only mode' };
  }
  const tool = typeof input?.tool === 'string' ? input.tool.trim() : '';
  if (!tool) return { allowed: true, reason: 'read-only MCP status/search' };
  const server = forcedServer || (typeof input?.server === 'string' ? input.server.trim() : '');
  if (!server) {
    return { allowed: false, reason: `MCP call '${tool}' must name an explicit server in read-only mode` };
  }
  return evaluatePlanMcpCall(server, tool);
}

export function evaluatePlanToolCall(toolName, input = {}) {
  if (toolName === 'bash') {
    return evaluatePlanBash(input?.command);
  }
  if (toolName === 'write' || toolName === 'edit') {
    const targets = extractAllToolTargets(input);
    if (targets.length === 0) return { allowed: false, reason: 'missing target path' };
    for (const candidate of targets) {
      const result = resolvePlanningWrite(candidate);
      if (!result.allowed) return { allowed: false, reason: `${result.reason} (${candidate})` };
    }
    return { allowed: true, planningWrite: true, target: resolvePlanningWrite(targets[0]).target };
  }
  if (toolName === 'mcp') return evaluatePlanMcpProxyCall(input);
  if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
    const rest = toolName.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep > 0) return evaluatePlanMcpCall(rest.slice(0, sep), rest.slice(sep + 2));
    return evaluatePlanMcpCall(rest, '');
  }
  if (isPlanReadOnlyToolName(toolName)) {
    const secret = readToolSecretProblem(input);
    if (secret) return { allowed: false, reason: `read-only mode blocks secret path '${secret}'` };
    return { allowed: true, planningWrite: false };
  }
  return { allowed: false, reason: `tool '${toolName}' is not declared read-only for read-only mode` };
}

// Mode-aware entry point used by the extension. ASK forbids every file write
// (including planning artifacts); PLAN keeps its narrow .devops/plans|drafts write.
export function evaluateReadOnlyToolCall(mode, toolName, input = {}) {
  if (mode === 'ask' && (toolName === 'write' || toolName === 'edit')) {
    return { allowed: false, reason: 'ASK is read-only research; file writes are disabled' };
  }
  return evaluatePlanToolCall(toolName, input);
}
