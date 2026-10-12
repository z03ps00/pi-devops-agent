// Approval mode for BUILD: `off` never asks, `safe` asks before a dangerous
// action, `strict` asks before every tool call. A UX guard, not a sandbox.
import {
  ANON_SHARED_MEMORY_SERVERS,
  classifyBashCommand,
  describeMcpCall,
  evaluatePlanMcpCall,
  extractToolTarget,
  isPlanReadOnlyToolName,
} from './devops-plan-policy.mjs';

export const APPROVE_MAX_LEVEL = 2;
export const APPROVE_LEVEL_NAMES = Object.freeze(['off', 'safe', 'strict']);

const RM_RF_RE = /(^|[\n;&|`])\s*(?:sudo\s+)?(?:env\s+)?rm\s+(?:-[^\s]+\s+)*-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/i;
const GIT_PUSH_RE = /(^|[\n;&|`])\s*(?:sudo\s+)?git\s+push\b/i;
const GIT_RESET_HARD_RE = /(^|[\n;&|`])\s*(?:sudo\s+)?git\s+reset\s+--hard\b/i;
const COMPOSE_DOWN_RE = /\bcompose\b[^\n;&|]*\bdown\b/i;
const VOLUME_RM_RE = /\b(docker|podman)\s+(volume\s+(rm|prune)|system\s+prune)\b/i;
const VIRSH_DESTROY_RE = /\bvirsh\s+(destroy|undefine|snapshot-revert|snapshot-delete)\b/i;
const FIREWALL_RE = /\b(nft|iptables|ip6tables|ufw|firewall-cmd)\b/i;
const FSTAB_RE = /\/etc\/fstab\b/;

export function approveLevelName(level) {
  return APPROVE_LEVEL_NAMES[normalizeApproveLevel(level)] ?? 'off';
}

export function describeApprove(level) {
  const name = approveLevelName(level);
  if (name === 'safe') return 'ask before writes, non-read-only shell, and MCP mutations (UX guard, not an OS sandbox)';
  if (name === 'strict') return 'approve every tool call';
  return 'do not ask — current BUILD behaviour';
}

export function normalizeApproveLevel(value) {
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t === 'off' || t === 'no' || t === 'false') return 0;
    if (t === 'safe' || t === 'on' || t === 'yes' || t === 'true') return 1;
    if (t === 'strict') return 2;
  }
  const raw = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(raw)) return 0;
  const level = Math.trunc(raw);
  return level >= 1 && level <= APPROVE_MAX_LEVEL ? level : 0;
}

/** Parses a `/approve` argument: { kind: 'status' | 'pick' | 'set' | 'invalid', level? }. */
export function parseApproveLevel(arg) {
  const t = String(arg ?? '').trim().toLowerCase();
  if (!t) return { kind: 'pick' };
  if (t === 'status') return { kind: 'status' };
  if (t === 'off' || t === '0' || t === 'no' || t === 'false') return { kind: 'set', level: 0 };
  if (t === 'safe' || t === '1' || t === 'on' || t === 'yes' || t === 'true') return { kind: 'set', level: 1 };
  if (t === 'strict' || t === '2') return { kind: 'set', level: 2 };
  return { kind: 'invalid' };
}

/**
 * CLI/env startup value. Pi core `--approve` is a boolean (project trust), so
 * booleans and stringified true/false never set the approval mode.
 */
export function parseApproveCliValue(value) {
  if (typeof value === 'boolean' || value == null) return null;
  const t = String(value).trim().toLowerCase();
  if (!t || t === 'true' || t === 'false') return null;
  const parsed = parseApproveLevel(t);
  return parsed.kind === 'set' ? parsed.level : null;
}

/** `--devops-approve` wins; `PI_DEVOPS_APPROVE` applies to a new session only. */
export function resolveApproveStartup({ flag, env, restored } = {}) {
  const fromFlag = parseApproveCliValue(flag);
  if (fromFlag != null) return fromFlag;
  if (!restored) {
    const fromEnv = parseApproveCliValue(env);
    if (fromEnv != null) return fromEnv;
  }
  return null;
}

export function cycleApproveLevel(level) {
  const current = normalizeApproveLevel(level);
  return current >= APPROVE_MAX_LEVEL ? 0 : current + 1;
}

export function shouldPrompt(level, dangerous) {
  const lvl = normalizeApproveLevel(level);
  if (lvl >= 2) return true;
  if (lvl === 1) return Boolean(dangerous);
  return false;
}

function shellRiskTarget(command) {
  const tokens = String(command ?? '').trim().split(/\s+/).filter(Boolean);
  const head = tokens[0] === 'sudo' ? tokens.slice(1) : tokens;
  if (['git', 'docker', 'podman', 'systemctl', 'virsh'].includes(head[0])) return `${head[0]} ${head[1] || ''}`.trim();
  return head[0] || 'shell';
}

export function approvalScope(toolName, classification = {}, input = {}) {
  const tool = String(toolName ?? '').trim() || 'unknown';
  const risk = String(classification.category || 'unclassified');
  let target = extractToolTarget(input) || '';
  if (!target && tool === 'bash') target = shellRiskTarget(input?.command);
  if (!target) target = String(classification.reason || '').slice(0, 80);
  return [tool, risk, target].join(':');
}

/** Reason a shell command needs approval, or null for read-only diagnostics. */
export function dangerousBashReason(command) {
  const text = typeof command === 'string' ? command : '';
  if (!text.trim()) return 'empty shell command';
  if (RM_RF_RE.test(text)) return 'rm -rf';
  if (COMPOSE_DOWN_RE.test(text)) return 'docker compose down';
  if (VOLUME_RM_RE.test(text)) return 'docker volume/system removal';
  if (VIRSH_DESTROY_RE.test(text)) return 'virsh destroy/undefine/snapshot change';
  if (GIT_PUSH_RE.test(text)) return 'git push';
  if (GIT_RESET_HARD_RE.test(text)) return 'git reset --hard';
  const verdict = classifyBashCommand(text);
  if (verdict.verdict === 'read-only') return null;
  if (FIREWALL_RE.test(text)) return 'firewall change';
  if (FSTAB_RE.test(text)) return 'fstab change';
  return verdict.reason;
}

function classifyMcp(toolName, input) {
  const call = describeMcpCall(toolName, input);
  if (!call) {
    if (toolName === 'mcpScript') {
      return { dangerous: true, category: 'mcp_mutation', reason: 'mcpScript can run arbitrary MCP actions' };
    }
    if (toolName === 'mcp') {
      if (input && typeof input === 'object' && input.action) {
        return { dangerous: true, category: 'mcp_mutation', reason: 'MCP authentication/UI action' };
      }
      return { dangerous: false, category: 'mcp_status', reason: 'MCP status/search' };
    }
    return null;
  }
  const tool = String(call.tool ?? '').trim();
  const plan = evaluatePlanMcpCall(call.server, tool);
  if (plan.allowed) return { dangerous: false, category: 'mcp_read', reason: plan.reason };
  if (ANON_SHARED_MEMORY_SERVERS.includes(String(call.server ?? '').trim())) {
    return { dangerous: true, category: 'mcp_mutation', reason: plan.reason };
  }
  if (isPlanReadOnlyToolName(tool)) {
    return { dangerous: false, category: 'mcp_read', reason: `read-only MCP tool '${call.server}.${tool}'` };
  }
  return { dangerous: true, category: 'mcp_mutation', reason: `MCP mutation '${call.server}.${tool}'` };
}

function isMcpGateway(toolName) {
  return toolName === 'mcp' || toolName === 'mcpScript' || (typeof toolName === 'string' && toolName.startsWith('mcp__'));
}

export function classifyDanger(toolName, input = {}) {
  const name = String(toolName ?? '');
  if (name === 'write' || name === 'edit') {
    const target = extractToolTarget(input) || '(unspecified path)';
    return { dangerous: true, category: 'file_write', reason: `${name} ${target}` };
  }
  if (name === 'bash') {
    const hit = dangerousBashReason(input?.command);
    if (hit) return { dangerous: true, category: 'bash', reason: hit };
    return { dangerous: false, category: 'shell-read', reason: 'read-only shell command' };
  }
  if (isMcpGateway(name)) {
    return classifyMcp(name, input) ?? { dangerous: true, category: 'mcp_mutation', reason: `MCP call '${name}'` };
  }
  if (isPlanReadOnlyToolName(name)) return { dangerous: false, category: 'read', reason: `read-only tool '${name}'` };
  return { dangerous: true, category: 'unknown', reason: `unclassified tool '${name}'` };
}
