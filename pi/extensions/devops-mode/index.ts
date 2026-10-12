import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import fs from "node:fs";
import { evaluatePlanMcpCall, evaluateReadOnlyToolCall, getReadOnlyVisibleTools, isRecallMcpCall } from "../../lib/devops-plan-policy.mjs";
import { acceptPlan, completeBuild, enterAsk, enterBuild, enterPlan, executePlan, extractPlanArtifact, initialModeState, isReadOnlyMode, sanitizeModeState } from "../../lib/devops-plan-state.mjs";
import { classifyBashMutation } from "../../lib/devops-plan-policy.mjs";
// Namespace imports: after `/reload` the entry file is re-executed while the
// already-imported `pi/lib/*.mjs` instances keep their old export set. A named
// import of a freshly added function then yields `undefined` (transpiled loader)
// or a hard link error (strict ESM), so the anonymous-session API is reached
// through property access only.
import * as planStateLib from "../../lib/devops-plan-state.mjs";
import * as planPolicyLib from "../../lib/devops-plan-policy.mjs";
import { resolveLocal } from "../../lib/devops-local.mjs";
import { getSnapshot, publish, registerAction, uiAvailable } from "../../lib/ui/index.mjs";
import { APPROVE_ALL, APPROVE_DENY, APPROVE_ONCE, summarizeToolAction } from "../../lib/ui/approval.mjs";
import {
  approvalScope,
  approveLevelName,
  classifyDanger,
  cycleApproveLevel,
  describeApprove,
  normalizeApproveLevel,
  parseApproveLevel,
  resolveApproveStartup,
  shouldPrompt,
} from "../../lib/approve-policy.mjs";
import { setDevopsMode } from "../../lib/mode-state.mjs";
import { overlayAnonSelect, overlayApproval, overlayApproveSelect, overlayCavemanSelect, overlayModeSelect } from "../devops-ui/overlays.ts";

type DevopsMode = "plan" | "build" | "ask";
type DevopsPhase = "build-idle" | "plan-draft" | "plan-ready" | "ask-idle" | "build-executing";
type PlanArtifact = { id: string; text: string; stepCount: number; createdAt: string };
type CavemanLevel = "off" | "lite" | "full" | "ultra";
// Where the style applies. `all` (default) = every mode. `task` (`/caveman auto`)
// = BUILD turns only.
type CavemanScope = "all" | "task";
type ModeState = {
  mode: DevopsMode;
  phase: DevopsPhase;
  plan: PlanArtifact | null;
  caveman?: CavemanLevel;
  cavemanScope?: CavemanScope;
  anonLevel?: number;
  // Mode carried by the last system prompt built in this process (persisted in
  // the session record), used to emit a one-shot in-band change notice.
  lastInjectedMode?: DevopsMode;
  approveLevel?: number;
  memoryGateRequired?: boolean;
  memoryGatePrompted?: boolean;
  dashboardGateRequired?: boolean;
  dashboardGatePrompted?: boolean;
  recallGateRequired?: boolean;
  recallGatePrompted?: boolean;
};
type SharedState = typeof globalThis & { __PI_DEVOPS_MODE__?: DevopsMode; __PI_DEVOPS_PHASE__?: DevopsPhase; __PI_DEVOPS_PLAN_ID__?: string };
const shared = globalThis as SharedState;

function sessionLocal() {
  return resolveLocal(process.env, process.cwd());
}

type SessionNetwork = {
  id: string;
  label: string;
  kind: "host" | "netns";
  footerLabel: string;
  proxy: string;
  proxyAllow: string;
};

const HOST_NETWORK: SessionNetwork = {
  id: "host",
  label: "host",
  kind: "host",
  footerLabel: "",
  proxy: "",
  proxyAllow: "",
};

function pinFromLocal(local: any): SessionNetwork {
  const active = local?.network?.active || {};
  const kind = active.kind === "netns" ? "netns" : "host";
  return {
    id: String(active.id || "host"),
    label: String(active.label || "host"),
    kind,
    footerLabel: String(local?.network?.footerLabel || ""),
    proxy: String(active.proxy || ""),
    proxyAllow: String(active.proxyAllow || ""),
  };
}

function dashboardLine(local: any): string {
  if (local?.dashboard?.enabled !== true) return "";
  const artifacts = Array.isArray(local.dashboard.artifacts) ? local.dashboard.artifacts.filter(Boolean) : [];
  const listed = artifacts.length ? artifacts.map((item: string) => "`" + item + "`").join(", ") : "the files named by the local map";
  const skill = local.dashboard.skill || "monitoring";
  return "dashboard artifacts (" + listed + ", skill `" + skill + "`)";
}

function networkNote(pin: SessionNetwork = pinSessionNetwork()): string {
  if (pin.kind !== "netns") {
    return "\n\n# Network profile\nCurrent network profile: host. docker, virsh and apt are available.";
  }
  const label = pin.label || pin.id;
  if (!pin.proxy) {
    return `\n\n# Network profile\nCurrent network profile: ${label}. The agent is in a network namespace. Host docker, virsh and apt may be unavailable. Do not bypass isolation.`;
  }
  const allowLine = pin.proxyAllow ? ", allowlist `" + pin.proxyAllow + "`" : "";
  return `\n\n# Network profile\nCurrent network profile: ${label}. Docker goes through the filtered proxy (\`${pin.proxy}\`${allowLine}): ordinary Engine API calls behave like the host, while host network, privileged, a docker.sock bind and exec into a host-net container are denied by design (403). Never bypass the proxy. virsh, apt and host systemctl need the host profile.`;
}

// Caveman defaults for a NEW session. `PI_DEVOPS_CAVEMAN=off|lite|full|ultra`
// sets the level, `auto` means level `full` with `task` scope (BUILD only).
// The launcher forwards its own `PI_DEVOPS_*` variables explicitly and the awg
// path goes through sudo + a whitelisting `env`, so this knob reaches the
// process only in `direct` mode and on manual `pi` runs; inside awg use
// `/caveman`. A session-scoped force always wins over it.
const CAVEMAN_LEVELS: CavemanLevel[] = ["off", "lite", "full", "ultra"];

function cavemanEnvRaw(): string {
  return String(process.env.PI_DEVOPS_CAVEMAN ?? "").trim().toLowerCase();
}

/** Level from `PI_DEVOPS_CAVEMAN`; `auto` is a scope, not a level. */
function cavemanEnvLevel(): CavemanLevel | undefined {
  const raw = cavemanEnvRaw();
  return CAVEMAN_LEVELS.includes(raw as CavemanLevel) ? (raw as CavemanLevel) : undefined;
}

/** `PI_DEVOPS_CAVEMAN=auto` → BUILD-only (`task`) scope. */
function cavemanEnvScope(): CavemanScope | undefined {
  return cavemanEnvRaw() === "auto" ? "task" : undefined;
}

/** Level used by `/caveman on` and as the last-resort default (`off` excluded). */
function cavemanProfileLevel(): CavemanLevel {
  const env = cavemanEnvLevel();
  return env && env !== "off" ? env : "full";
}

function normalizeCavemanLevel(value: unknown): CavemanLevel | undefined {
  const raw = String(value ?? "").trim().toLowerCase();
  return CAVEMAN_LEVELS.includes(raw as CavemanLevel) ? (raw as CavemanLevel) : undefined;
}

function normalizeCavemanScope(value: unknown): CavemanScope | undefined {
  if (value === "all" || value === "task") return value;
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "auto") return "task";
  return raw === "all" || raw === "task" ? (raw as CavemanScope) : undefined;
}

// Effective network mode of THIS session process. The launcher pins the exact
// value in PI_DEVOPS_NET_MODE; the on-disk mode file is only the preference for
// the *next* launch (the panel can rewrite it while this process keeps its
// netns), so it is used as a fallback only.
let sessionNetwork: SessionNetwork = { ...HOST_NETWORK };
let networkPinned = false;

function pinSessionNetwork(): SessionNetwork {
  if (networkPinned) return sessionNetwork;
  networkPinned = true;
  sessionNetwork = pinFromLocal(sessionLocal());
  return sessionNetwork;
}

// Session-level phrase triggers for the caveman output style (the `/caveman`
// command is the explicit surface; these only react to a user message). Rules,
// in order: an explicit stop phrase always wins; a negated mention never turns
// the style on; a question about the style is not a trigger; brevity words only
// count in a short command (<= 4 words) and never override a forced `off`; a
// bare mention is accepted only in a short utterance (<= 12 words), so a long
// prose request that happens to mention the style does not flip the state.
const CAVEMAN_OFF_RE = /(stop caveman|no caveman|normal mode|обычный режим|не надо caveman|без caveman|выключи caveman|caveman off)/i;
const CAVEMAN_MENTION_RE = /(caveman|пещерн)/i;
const CAVEMAN_BREVITY_RE = /(be brief|коротко|кратко|меньше токенов|сжатый стиль)/i;
const CAVEMAN_NEG_RE = /(не\s+(надо|нужно|включай|включать|хочу|используй)|не\s+caveman|без\s+caveman|stop\s+caveman|no\s+caveman|not\s+caveman|caveman\s+(не\s+нужен|off))/i;
const CAVEMAN_QUESTION_RE = /(\?|\bчто\s+(такое|делает)\b|\bкак\s+работ)/i;

function cavemanWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function parseCavemanIntent(text: string, current: CavemanLevel): CavemanLevel | undefined {
  const t = String(text ?? "").toLowerCase().trim();
  if (!t) return undefined;
  if (CAVEMAN_OFF_RE.test(t)) return current === "off" ? undefined : "off";
  const mention = CAVEMAN_MENTION_RE.test(t);
  const brevity = CAVEMAN_BREVITY_RE.test(t);
  if (!mention && !brevity) return undefined;
  if (CAVEMAN_NEG_RE.test(t)) return undefined;
  if (CAVEMAN_QUESTION_RE.test(t)) return undefined;
  const words = cavemanWordCount(t);
  if (!mention && words > 4) return undefined;
  if (mention && words > 12) return undefined;
  // Brevity words are a request to answer shorter, not a force-on: a session
  // stopped with "stop caveman" stays off until an explicit mention/command.
  if (!mention && current === "off") return undefined;
  const next: CavemanLevel = /\bultra\b/.test(t) ? "ultra" : /\blite\b/.test(t) ? "lite" : "full";
  return next === current ? undefined : next;
}

// --------------------------------------------------------------------------
// Anonymous session (DevOps profile)
//
// `/anon`, `Ctrl+Alt+A` and `--anon <N>` set a per-session level that suppresses
// the traces of this session in the shared memory/knowledge stores:
//   1 — no writes (Cognee/OpenViking stay read-only, no pending record);
//   2 — no reads either (the topic never reaches the stores);
//   3 — level 2 plus no local traces (launcher adds `--no-session`, no handoff).
// The level is enforced twice: `pi.on("tool_call")` blocks the call outright and
// the MCP adapter approval hook denies the resolved server/tool pair.
// --------------------------------------------------------------------------

// `/reload` refreshes only this entry file. Modules from `pi/lib/*.mjs` that the
// running process already imported keep their old export set, so a function
// added by this change can be missing after a reload (incident 2026-09-13).
// Property access on the namespace object never throws for a missing name, and
// every call below is wrapped in `libCall()` with a local fallback.
const ANON_LIB = {
  normalize: (planStateLib as Record<string, unknown>).normalizeAnonLevel,
  parse: (planStateLib as Record<string, unknown>).parseAnonLevel,
  blocksReads: (planStateLib as Record<string, unknown>).anonBlocksMemoryReads,
  mcpCall: (planPolicyLib as Record<string, unknown>).describeMcpCall,
  anonMcp: (planPolicyLib as Record<string, unknown>).evaluateAnonMcpCall,
  anonWrite: (planPolicyLib as Record<string, unknown>).evaluateAnonWriteCall,
};

type AnonVerdict = { allowed: boolean; reason: string };

function libCall<T>(fn: unknown, args: unknown[]): T | undefined {
  try {
    if (typeof fn !== "function") return undefined;
    return (fn as (...a: unknown[]) => T)(...args);
  } catch {
    return undefined;
  }
}

function anonNormalize(value: unknown): number {
  const viaLib = libCall<number>(ANON_LIB.normalize, [value]);
  if (typeof viaLib === "number") return viaLib;
  const raw = typeof value === "number" ? value : Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(raw)) return 0;
  const level = Math.trunc(raw);
  return level >= 1 && level <= 3 ? level : 0;
}

function anonParse(arg: unknown): { kind: "status" | "set" | "invalid"; level?: number } {
  const viaLib = libCall<{ kind: string; level?: number }>(ANON_LIB.parse, [arg]);
  if (viaLib && typeof viaLib.kind === "string") {
    return { kind: viaLib.kind as "status" | "set" | "invalid", level: viaLib.level };
  }
  const t = String(arg ?? "").trim().toLowerCase();
  if (!t || t === "status") return { kind: "status" };
  if (t === "off" || t === "0" || t === "no" || t === "false") return { kind: "set", level: 0 };
  if (t === "on" || t === "yes" || t === "true") return { kind: "set", level: 2 };
  if (/^[123]$/.test(t)) return { kind: "set", level: Number.parseInt(t, 10) };
  return { kind: "invalid" };
}

function anonBlocksReads(level: number): boolean {
  const viaLib = libCall<boolean>(ANON_LIB.blocksReads, [level]);
  return typeof viaLib === "boolean" ? viaLib : level >= 2;
}

// Fail-closed fallback used only when the loaded lib predates this change.
function fallbackAnonVerdict(level: number, input: unknown): AnonVerdict {
  let blob = "";
  try {
    blob = JSON.stringify(input ?? {});
  } catch {
    blob = String(input ?? "");
  }
  if (level >= 1 && blob.includes("/agent-memory/pending")) {
    return { allowed: false, reason: "anonymous session forbids pending-memory records (stale lib fallback)" };
  }
  if (level >= 3 && blob.includes(".devops/handoffs")) {
    return { allowed: false, reason: "anonymous level 3 forbids handoff documents (stale lib fallback)" };
  }
  if (level >= 1 && /knowledge_(remember|write|edit|add_resource|forget|move|delete|import)|memory_remember|memory_forget/.test(blob)) {
    return { allowed: false, reason: "anonymous session forbids shared-memory writes (stale lib fallback)" };
  }
  if (level >= 2 && /knowledge_(find|search|read|list|tree|grep|glob)|memory_recall|memory_search_tools/.test(blob)) {
    return { allowed: false, reason: "anonymous session forbids shared-memory reads (stale lib fallback)" };
  }
  return { allowed: true, reason: "no shared-memory trace detected (stale lib fallback)" };
}

function anonVerdict(level: number, toolName: string, input: unknown): AnonVerdict {
  if (level <= 0) return { allowed: true, reason: "anonymous mode off" };
  const call = libCall<{ server: string; tool: string } | null>(ANON_LIB.mcpCall, [toolName, input]);
  if (call) {
    const decision = libCall<AnonVerdict>(ANON_LIB.anonMcp, [level, call.server, call.tool]);
    return decision ?? fallbackAnonVerdict(level, input);
  }
  const write = libCall<AnonVerdict>(ANON_LIB.anonWrite, [level, toolName, input]);
  return write ?? fallbackAnonVerdict(level, input);
}

function anonDescribe(level: number): string {
  if (level === 1) return "shared memory read-only: no writes, no pending record";
  if (level === 2) return "no shared-memory reads or writes";
  return "no reads/writes, no local traces (ephemeral session, no handoff)";
}

// Injected into the system prompt of every mode while the level is active.
function anonNote(level: number): string {
  const noReads = level >= 2;
  const noTraces = level >= 3;
  const lines = [
    "",
    "",
    `# Anonymous session (anon:${level}, DevOps profile)`,
    `- Level meaning: ${anonDescribe(level)}. The flag is session-scoped and does not move to a new session.`,
    "- HARD RULE: never write to shared memory/knowledge in this session — no `memory_remember`, no `knowledge_remember`/`write`/`edit`/`add_resource`, no `call_tool` mutation, and no pending record in the agent-memory queue. Such calls are blocked and denied.",
    "- The shared post-task memory rule is SUSPENDED here: instead of a write, end every substantial turn with `Memory: skipped — anonymous` (never `recorded`, never `UNCONFIRMED` for a deliberate skip).",
    "- Never claim that anything was stored or queued, even if a write tool was attempted and blocked.",
  ];
  if (noReads) {
    lines.push("- Do not read shared memory/knowledge either (`memory_recall`, `knowledge_find|search|read|list|tree|grep|glob`). Skip the startup recall and finish the turn with `Recall: not required — anonymous` (`*_health` liveness checks stay allowed).");
  }
  if (noTraces) {
    lines.push("- Do not write handoff documents (skill `session-handoff`) and treat this conversation as ephemeral: keep durable results inside this session only.");
  }
  lines.push("- Still applies: `INDEX.md` and the subsystem `index.md` stay in sync with topology changes, and secrets stay out of notes and memory.");
  return lines.join("\n");
}

// Injected into the system prompt whenever the style applies: every mode under
// the default `all` scope, BUILD only under `/caveman auto`. The block carries
// the behaviour, not the mechanism — what to drop, what stays verbatim, the
// level semantics, the clarity switches and the boundaries — plus a pointer to
// the full skill, so the model does not have to guess the rules.
function cavemanNote(level: CavemanLevel, scope: CavemanScope, dashboard = false): string {
  if (level === "off") return "";
  const scopeLine = scope === "task"
    ? "Applies to BUILD turns only (`/caveman auto`); PLAN/ASK prose is not compressed."
    : "Applies to prose in every mode (BUILD, PLAN, ASK).";
  const kept = dashboard
    ? "`INDEX.md`/`index.md` content, plan artifacts (`## Plan` …), incident/handoff text, memory records, command blocks the user may run, and the required lines `DEV:*`, `Memory:`, `Dashboard:`, verification output."
    : "`INDEX.md`/`index.md` content, plan artifacts (`## Plan` …), incident/handoff text, memory records, command blocks the user may run, and the required lines `DEV:*`, `Memory:`, verification output.";
  return `\n\n# Output style — caveman (${level})
- ${scopeLine}
- Compression only — never add words to sound terse; if the short form is not shorter, use the plain one. Never announce or name the style in the answer.
- Drop filler, hedging, pleasantries, task restatement, meta-narration and narration around tool calls; no emoji, no decorative tables, no raw log dumps.
- Levels: \`lite\` = filler/hedging only, full sentences; \`full\` (default) = + fragments and short synonyms, no narration; \`ultra\` = telegraphic, causal arrows allowed, each fact once. Code, commands, names and error strings are never abbreviated at any level; no invented abbreviations.
- Keep verbatim: commands, compose/YAML, scripts, unit files, container/service names, ports, versions, image tags, paths, error and journal lines. Never drop a negation or a scope word (\`не\`, \`нет\`, \`только\`, \`без\`); ports, versions, sizes, dates stay exact.
- Normal grammar, not caveman, for: destructive or irreversible steps (\`compose down\`, volume removal, \`virsh destroy|undefine\`, snapshot revert, fstab/netns/firewall changes), security and data-loss warnings, ordered recovery procedures, and when the user asks to clarify.
- Never caveman: ${kept}
- \`AGENTS.md\` safety, docs-in-same-change and the completion gates always win. Force-off (a stop phrase or \`/caveman off\`) is final until an explicit force-on or session end.
- Read skill \`caveman\` (\`SKILL.md\`) **before the first answer of a session**, not mid-session: this block is only a summary.
- Auto-clarity is **per block**: after a destructive/security/ordered block, return to the current level inside the same answer.
- Tool-output hygiene saves more than prose compression: filter in the command itself (\`--format\`, \`head\`, \`tail\`, \`--include\`, \`2>/dev/null\`). No unfiltered \`ps -eo\`, no \`docker system df -v\` when \`docker system df\` answers, no whole-tree \`grep\` with repeating permission errors, no raw log dumps.
- Never list which tools you used — the tool log already shows them.`;
}

function planInstructions(local: any): string {
  const root = local.infraRoot;
  const dash = dashboardLine(local);
  const dashItem = dash ? `\n- If monitored infrastructure changes, include the ${dash} in the plan.` : "";
  return `# DevOps PLAN MODE

You are in a dedicated planning workflow for the infrastructure under \`${root}\`.

The purpose of PLAN is to investigate the live state read-only and produce a complete, executable plan. Do not implement.

Hard rules:
- No infrastructure mutations: no \`docker compose up/down/restart/stop\`, no \`docker run/rm/exec\`, no \`apt/dpkg\`, no \`systemctl start/stop/restart/enable\`, no \`virsh start/shutdown/destroy/define\`, no \`nft/iptables\`, no \`rm/mv/chmod/chown\`, no reboots.
- Read-only diagnostics are allowed: \`docker ps|inspect|logs|compose ps|compose config\`, \`systemctl status|is-active\`, \`journalctl\`, \`virsh list|dominfo|domblklist|snapshot-list\`, \`ss\`, \`ip addr|route show\`, \`df/du\`, health curls.
- Read \`INDEX.md\` under the infra root and the relevant subsystem \`index.md\` first; treat them as the source of truth. Paths, containers and addresses come from that index or the local map, never from memory of another machine.
- Trust the \`# Current DevOps mode\` block: it is injected on every run. Never ask the user to switch modes and never claim the session is in ASK/BUILD — the extension performs the switch and states the current mode in that block.
- Planning artifacts may be written only under \`${root}/.devops/plans/**\` or \`${root}/.devops/drafts/**\`. Never write project or infra files.
- Read-only MCP only: \`knowledge\` (find/glob/grep/health/list/read/search/tree), \`memory\` (recall/search_tools).
- If the task needs docker or virsh and the network profile is a namespace, say so; do not bypass isolation. The network-profile block below says whether a filtered docker proxy is configured.
- Do not propose BUILD merely because an action would require a write. First finish the plan.

Planning workflow:
1. Read \`INDEX.md\` and the subsystem \`index.md\`.
2. Inspect live state with read-only commands.
3. Identify services, containers, configs, dependencies, risks, rollback and verification.
4. Resolve material ambiguity; surface unresolved questions explicitly.
5. Produce the final plan using ALL required headings.

Required final format:
## Plan
1. Step — what will change, where, why.
2. ...
## Files / objects expected to change
- path/object — expected change.${dashItem}
## Risks / edge cases
- ...
## Verification
- Exact checks/commands to run in BUILD.

Do not implement. Once the complete plan exists, the extension marks it PLAN_READY and offers Execute in BUILD / Refine / Stay in PLAN.`;
}

function askInstructions(local: any): string {
  const root = local.infraRoot;
  return `# DevOps ASK MODE

You are in read-only Q&A mode for the infrastructure under \`${root}\`.
Answer the user's questions accurately; do not implement or change anything.

Hard rules (identical to PLAN):
- No infrastructure mutations: no \`docker compose up/down/restart/stop\`, no \`docker run/rm/exec\`, no \`apt/dpkg\`, no \`systemctl start/stop/restart/enable\`, no \`virsh start/shutdown/destroy/define\`, no \`nft/iptables\`, no \`rm/mv/chmod/chown\`, no reboots.
- Read-only diagnostics are allowed: \`docker ps|inspect|logs|compose ps|compose config\`, \`systemctl status|is-active\`, \`journalctl\`, \`virsh list|dominfo|domblklist|snapshot-list\`, \`ss\`, \`ip addr|route show\`, \`df/du\`, health curls.
- ASK is strictly read-only research: file writes are disabled completely. Do not call \`write\`/\`edit\` (they are not available) and do not write to \`.devops/plans|drafts/**\` (those are PLAN-only) or any other path.
- Read \`INDEX.md\` under the infra root and the relevant subsystem \`index.md\` first; treat them as the source of truth.
- Read-only MCP only: \`knowledge\` (find/glob/grep/health/list/read/search/tree), \`memory\` (recall/search_tools).
- If an answer requires docker or virsh and the network profile is a namespace, say so; do not bypass isolation.
- Never print or copy secrets; refer to variable names and paths only.

Answering workflow:
1. Ground the answer in \`INDEX.md\` / subsystem \`index.md\` and in fresh read-only checks; state the commands/files you used.
2. Mark anything you could not verify as unconfirmed instead of guessing.
3. Do NOT emit the PLAN artifact headings and do NOT mark anything PLAN_READY — this mode answers questions, it does not produce plans.
4. If the user asks for a change, explain the approach and point them to \`/mode plan\` to produce a plan or \`/mode build\` to implement; do not perform the change here. Say it ONCE per conversation: if that suggestion is already in this conversation, or a \`[DEVOPS MODE CHANGE]\` message confirms the switch happened, do not repeat it — answer from the \`# Current DevOps mode\` block instead.`;
}

function buildInstructions(local: any): string {
  const root = local.infraRoot;
  const dash = dashboardLine(local);
  const dashRule = dash
    ? `- Dashboard-in-same-change: a change to monitored infrastructure updates the ${dash} in the same change. Finish with \`Dashboard: updated\` or \`Dashboard: not required — <reason>\`.`
    : "- This profile has no dashboard gate. Do not invent a dashboard status line.";
  return `# DevOps BUILD MODE

Implementation is allowed.
- Follow \`${root}/INDEX.md\` as the source of truth and the canonical scripts that index names. Do not invent a script path.
- If this session has a PLAN_READY artifact, execute that exact plan_id rather than repeating full discovery. Re-plan only when new evidence invalidates a locked step.
- Prefer the smallest safe change; preserve unrelated changes; never \`git reset --hard\` or \`git checkout --\`.
- Use only the canonical update scripts from the index. Do not use \`apt upgrade\`, in-app updaters, \`dpkg -i\`, or \`curl | bash\`.
- Update \`INDEX.md\` and the subsystem \`index.md\` in the same change as any topology, port, service, or script change.
${dashRule}
- Never print or copy secrets; refer to variable names and paths only.
- Network: obey the network-profile block. Inside a namespace, do not bypass a filtered docker proxy; \`virsh\`, \`apt\` and host \`systemctl\` need the host profile when the block says so.
- Approval mode (\`/approve off|safe|strict\`, footer \`approve:\`) may pause a dangerous action (\`safe\`) or every tool call (\`strict\`). Do not retry a denied call in a loop.
- Post-task memory gate: every substantial task, including any durable file or configuration change, must run the shared memory policy before the final response. Write the redacted summary to the relevant stores, or save a redacted pending record and report \`Memory: UNCONFIRMED\` / \`UNVERIFIED\`.
- Finish non-trivial work with fresh verification output (health checks, \`docker ps\`, curls). If verification is impossible, report UNVERIFIED explicitly.`;
}

const SESSION_START_RECALL_NOTE = `

# Session start — shared context recall (all modes)
- Before answering the first user message of a session, check what is already known about the topic:
  \`mcp({ server: "memory", tool: "recall", args: { query: "<topic>" } })\` (Cognee)
  and \`mcp({ server: "knowledge", tool: "find", args: { query: "<topic>" } })\` (OpenViking).
  An explicit \`server\` is mandatory in PLAN/ASK; in BUILD the tool name alone resolves it.
- Follow skill \`context-bootstrap\` first, then \`shared-memory\` / \`knowledge-retrieval\`. Recall only what materially affects the task — never dump the whole store.
- The turn that performed the recall ends with the status line \`Recall: done — <what was found / URIs>\`.
- Trivial topic (greeting, meta question) or unavailable MCP: emit \`Recall: not required — <reason>\` / \`Recall: UNVERIFIED — <reason>\` instead.
- One of these forms (or an observed MCP recall call) is mandatory on the first turn of the session: the footer shows \`recall:pending\` until then.`;

const MODE_MEANING: Record<DevopsMode, string> = {
  plan: "read-only: investigate live state and produce the plan artifact; no infra or project writes",
  ask: "read-only Q&A: answer questions about the infrastructure, no writes at all",
  build: "implementation enabled",
};

function isModeLabel(value: unknown): value is DevopsMode {
  return value === "plan" || value === "build" || value === "ask";
}

function modeName(mode: DevopsMode): string {
  return mode.toUpperCase();
}

// Injected at the top of the instructions on EVERY run: the mode can change
// between turns while the transcript still carries the model's own older
// statements ("we are in ASK", "run /mode build"), so each turn must carry one
// authoritative value.
function modeNote(mode: DevopsMode): string {
  return `# Current DevOps mode
Current mode: ${modeName(mode)} — ${MODE_MEANING[mode]}.
This line is authoritative for this turn and is re-injected on every run: ignore any earlier statement about the mode in this conversation, including your own ("we are in ASK/PLAN/BUILD") and any "switch with \`/mode …\`" request that is already answered. Never ask the user to switch modes on the basis of history.`;
}

// One-shot, transcript-visible notice returned by `before_agent_start` on the
// first run after a mode change (previous value: `state.lastInjectedMode`).
function modeChangeNotice(from: DevopsMode, to: DevopsMode): string {
  return `[DEVOPS MODE CHANGE] DevOps mode changed: ${modeName(from)} → ${modeName(to)}. Current mode: ${modeName(to)} — ${MODE_MEANING[to]}. All earlier statements about the working mode in this conversation (including your own) are obsolete: do not repeat them, do not ask the user to switch again, and act only by the current mode.`;
}

function assistantText(message: any): string {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n");
}

function lastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = assistantText(messages[i]);
    if (text) return text;
  }
  return "";
}

// Status lines may be written as a plain line, a list item or inside backticks;
// normalize before matching so a correct report is never rejected.
function normalizeStatusText(text: string): string {
  return String(text ?? "")
    .replace(/[\u0060*_]/g, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s*/gm, "");
}

function hasMemoryStatus(text: string): boolean {
  const t = normalizeStatusText(text);
  // The optional second `Memory:` accepts wrapped forms such as
  // `**Memory:** `Memory: recorded`` (normalization keeps both field names).
  return /(^|\n)\s*Memory\s*:\s*(?:Memory\s*:\s*)?(recorded|UNCONFIRMED|UNVERIFIED|skipped\b|not required\b)/i.test(t);
}

function hasDashboardStatus(text: string): boolean {
  const t = normalizeStatusText(text);
  return /(^|\n)\s*Dashboard\s*:\s*(?:Dashboard\s*:\s*)?(updated\b|not required\s*[—–-]?\s*\S+)/i.test(t);
}

// Startup-recall evidence written by the model itself (used when the MCP call
// path is unavailable or the topic is trivially not covered by memory).
function hasRecallStatus(text: string): boolean {
  const t = normalizeStatusText(text);
  return /(^|\n)\s*Recall\s*:\s*(?:Recall\s*:\s*)?(done|retrieved|not required\b|UNCONFIRMED|UNVERIFIED)/i.test(t);
}

// `pi/lib/*.mjs` modules already imported by the running process are NOT
// refreshed by `/reload` (the extension entry file is, its imported libs are
// not). A freshly added named export can therefore be missing after a reload,
// and calling it used to abort EVERY tool call. Never let that happen again.
function detectRecallCall(toolName: unknown, input: unknown): boolean {
  try {
    const fn = isRecallMcpCall as unknown;
    if (typeof fn !== "function") return false;
    return (fn as (t: unknown, i: unknown) => boolean)(toolName, input) === true;
  } catch {
    return false;
  }
}

export default function devopsModeExtension(pi: ExtensionAPI): void {
  let state: ModeState = initialModeState() as ModeState;
  let buildTools: string[] = [];
  let lastReadyOffered: string | undefined;
  // Transient: the startup-recall gate was satisfied by an observed MCP call in
  // this run, so agent_end must still sync (and drop the footer status) even
  // though the model did not write a `Recall:` line.
  let recallGateCleared = false;
  // Transient: the startup recall was skipped because anon:2/3 forbids reading
  // shared memory. Leaving those levels makes the recall due again.
  let recallGateSkippedByAnon = false;
  const approveAllowlist = new Set<string>();

  pi.registerFlag("devops-mode", { description: "DevOps primary mode: plan, build, or ask", type: "string" });
  pi.registerFlag("anon", { description: "Anonymous session level: 1 = no memory writes, 2 = no reads, 3 = no local traces", type: "string" });
  pi.registerFlag("devops-approve", { description: "DevOps approval mode: off, safe, or strict. Not Pi --approve (project trust).", type: "string" });

  function approveLevel(): number {
    return normalizeApproveLevel(state.approveLevel);
  }

  function publishSharedState(): void {
    shared.__PI_DEVOPS_MODE__ = state.mode;
    shared.__PI_DEVOPS_PHASE__ = state.phase;
    shared.__PI_DEVOPS_PLAN_ID__ = state.plan?.id;
    const prev = (getSnapshot("mode") || {}) as Record<string, unknown>;
    publish("mode", {
      ...prev,
      mode: state.mode,
      phase: state.phase,
      planId: state.plan?.id || "",
      anonLevel: anonLevel(),
      approve: approveLevelName(approveLevel()),
      caveman: cavemanLevel(),
      net: pinSessionNetwork().footerLabel,
    });
    try { setDevopsMode(state.mode); } catch { /* ask | plan | build */ }
  }

  function setApproveLevel(level: number, ctx: ExtensionContext, notify = true): void {
    const next = normalizeApproveLevel(level);
    approveAllowlist.clear();
    state = { ...state, approveLevel: next };
    sync(ctx);
    if (!notify) return;
    const name = approveLevelName(next);
    ctx.ui.notify(`approve:${name} — ${describeApprove(next)}`, next > 0 ? "warning" : "info");
  }

  function actionCtx(args: unknown, ctx: unknown): ExtensionContext {
    if (ctx && typeof ctx === "object") return ctx as ExtensionContext;
    return args as ExtensionContext;
  }

  function actionArgs(args: unknown, ctx: unknown): string | undefined {
    return ctx && typeof ctx === "object" && typeof args === "string" ? args : undefined;
  }

  function readOnly(): boolean {
    return isReadOnlyMode(state.mode);
  }

  function cavemanLevel(): CavemanLevel {
    return normalizeCavemanLevel(state.caveman) ?? cavemanEnvLevel() ?? "full";
  }

  function cavemanScope(): CavemanScope {
    return normalizeCavemanScope(state.cavemanScope) ?? cavemanEnvScope() ?? "all";
  }

  // `task` scope is the pre-parity behaviour: BUILD only.
  function cavemanApplies(): boolean {
    return cavemanLevel() !== "off" && (cavemanScope() === "all" || state.mode === "build");
  }

  function anonLevel(): number {
    return anonNormalize(state.anonLevel);
  }

  function anonStatusText(): string {
    const level = anonLevel();
    const what = level === 0 ? "off — the shared post-task memory policy applies" : anonDescribe(level);
    return `anon=${level} · ${what} · session-scoped (new session starts at 0)`;
  }

  // Single entry point for changing the level (command, hotkey, launcher flag).
  function setAnonLevel(level: number, ctx: ExtensionContext, notify = true): void {
    const next = anonNormalize(level);
    state = { ...state, anonLevel: next };
    if (anonBlocksReads(next)) {
      // anon:2/3 must not keep nagging about a startup recall they may not make.
      recallGateSkippedByAnon = recallGateSkippedByAnon || Boolean(state.recallGateRequired);
      state = { ...state, recallGateRequired: false, recallGatePrompted: false };
      recallGateCleared = false;
    } else if (recallGateSkippedByAnon) {
      // Back on a level that may read shared context: the startup recall is due again.
      recallGateSkippedByAnon = false;
      state = { ...state, recallGateRequired: true, recallGatePrompted: false };
    }
    sync(ctx);
    if (notify) {
      if (next === 0) ctx.ui.notify("anon: off — shared memory policy restored", "info");
      else ctx.ui.notify(`anon:${next} — ${anonDescribe(next)}`, "warning");
    }
  }

  function persist(): void {
    pi.appendEntry("pi-devops-mode-state", { state });
  }

  function updateStatus(ctx: ExtensionContext): void {
    let label = "DEV:BUILD";
    let color = "success";
    if (state.mode === "plan") {
      label = state.phase === "plan-ready" ? "DEV:PLAN READY" : "DEV:PLAN";
      color = "warning";
    } else if (state.mode === "ask") {
      label = "DEV:ASK";
      color = "accent";
    } else if (state.phase === "build-executing" && state.plan) {
      label = `DEV:BUILD ${state.plan.id.slice(-6)}`;
    }
    // The style is session-wide now, so the level is visible in every mode;
    // `·task` marks the BUILD-only scope (`/caveman auto`).
    label = `${label} · caveman:${cavemanLevel()}${cavemanScope() === "task" ? "·task" : ""}`;
    ctx.ui.setStatus("pi-devops-mode", ctx.ui.theme.fg(color, label));
    const net = pinSessionNetwork();
    ctx.ui.setStatus(
      "pi-devops-net",
      net.footerLabel
        ? ctx.ui.theme.fg(net.kind === "netns" ? "success" : "warning", `net:${net.footerLabel}`)
        : undefined,
    );
    ctx.ui.setStatus(
      "pi-devops-recall",
      state.recallGateRequired ? ctx.ui.theme.fg("warning", "recall:pending") : undefined,
    );
    const anon = anonLevel();
    // Always visible next to the other footer items (`mcp 6/6 · DEV:BUILD ·
    // caveman:full · net:direct`), so an armed anonymous level can never be
    // forgotten: off | 1 | 2 | 3.
    ctx.ui.setStatus(
      "pi-devops-anon",
      anon > 0
        ? ctx.ui.theme.fg("warning", `anon:${anon}`)
        : ctx.ui.theme.fg("dim", "anon:off"),
    );
  }

  function applyReadOnlyTools(): void {
    const all = pi.getAllTools().map((t) => t.name);
    if (buildTools.length === 0) buildTools = pi.getActiveTools();
    pi.setActiveTools(getReadOnlyVisibleTools(state.mode, buildTools, all));
  }

  function applyBuildTools(): void {
    const available = new Set(pi.getAllTools().map((t) => t.name));
    const restored = buildTools.filter((name) => available.has(name));
    if (restored.length > 0) pi.setActiveTools([...new Set(restored)]);
  }

  function sync(ctx: ExtensionContext): void {
    publishSharedState();
    if (readOnly()) applyReadOnlyTools(); else applyBuildTools();
    updateStatus(ctx);
    persist();
  }

  // A mode change made while a run is in flight applies only to the NEXT run:
  // `before_agent_start` builds the system prompt once per run, so the running
  // turn keeps the mode it started with. Say so instead of leaving the footer
  // (updated immediately) to contradict the model's answer.
  function runningTurnSuffix(ctx: ExtensionContext): string {
    const isIdle = (ctx as { isIdle?: () => boolean }).isIdle;
    const idle = typeof isIdle === "function" ? isIdle.call(ctx) : true;
    return idle ? "" : " (takes effect on the next turn — the running turn keeps the mode it started with)";
  }

  async function switchToPlan(ctx: ExtensionContext, notify = true): Promise<void> {
    const suffix = runningTurnSuffix(ctx);
    state = enterPlan(state) as ModeState;
    sync(ctx);
    if (notify) ctx.ui.notify(`DEV PLAN: investigate read-only and produce a complete plan; infra changes are protected${suffix}`, suffix ? "warning" : "info");
  }

  async function switchToBuild(ctx: ExtensionContext, notify = true): Promise<void> {
    const suffix = runningTurnSuffix(ctx);
    state = enterBuild(state) as ModeState;
    sync(ctx);
    if (notify) {
      // No style announcement: the style is on by default, never names itself,
      // and the footer already carries its level.
      const what = state.plan ? `DEV BUILD: executing ${state.plan.id}` : "DEV BUILD: implementation enabled";
      ctx.ui.notify(`${what}${suffix}`, suffix ? "warning" : "info");
    }
  }

  async function switchToAsk(ctx: ExtensionContext, notify = true): Promise<void> {
    const suffix = runningTurnSuffix(ctx);
    state = enterAsk(state) as ModeState;
    sync(ctx);
    if (notify) ctx.ui.notify(`DEV ASK: read-only research; infrastructure changes and file writes are protected${suffix}`, suffix ? "warning" : "info");
  }

  async function executeCurrentPlan(ctx: ExtensionContext): Promise<void> {
    if (!state.plan || state.phase !== "plan-ready") {
      ctx.ui.notify("No PLAN_READY artifact exists. Finish/refine the plan first or use /mode build to override explicitly.", "warning");
      return;
    }
    state = executePlan(state) as ModeState;
    sync(ctx);
    const content = `Execute the approved DevOps plan below. Keep plan_id unchanged and do not redo full discovery unless new evidence invalidates a step.\n\nplan_id: ${state.plan.id}\n\n${state.plan.text}`;
    pi.sendMessage({ customType: "pi-devops-plan-execute", content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
  }

  async function handleMode(args: string | undefined, ctx: ExtensionContext): Promise<void> {
    const requested = args?.trim().toLowerCase();
    if (requested === "plan") return switchToPlan(ctx);
    if (requested === "build") return switchToBuild(ctx);
    if (requested === "ask") return switchToAsk(ctx);
    if (requested) {
      ctx.ui.notify(`Unknown DevOps mode: ${requested}. Use plan, build, or ask.`, "error");
      return;
    }
    const selected = uiAvailable(ctx)
      ? await overlayModeSelect(ctx)
      : await ctx.ui.select("DevOps mode", ["build", "plan", "ask"]);
    if (selected === "plan") await switchToPlan(ctx);
    if (selected === "build") await switchToBuild(ctx);
    if (selected === "ask") await switchToAsk(ctx);
  }

  pi.registerCommand("mode", {
    description: "Режим: /mode plan, build или ask. Пустой вызов открывает выбор",
    handler: handleMode,
  });
  registerAction("command:mode", (args: unknown, ctx: unknown) => handleMode(actionArgs(args, ctx), actionCtx(args, ctx)));
  registerAction("mode-select", (ctx: ExtensionContext) => handleMode(undefined, ctx));

  pi.registerCommand("devops-plan", { description: "Start a new DevOps PLAN workflow", handler: async (_args, ctx) => switchToPlan(ctx) });
  pi.registerCommand("devops-build", { description: "Switch to DevOps BUILD mode", handler: async (_args, ctx) => switchToBuild(ctx) });
  pi.registerCommand("devops-ask", { description: "Switch to DevOps ASK (read-only research) mode", handler: async (_args, ctx) => switchToAsk(ctx) });
  pi.registerCommand("devops-execute-plan", { description: "Execute the current PLAN_READY artifact in BUILD", handler: async (_args, ctx) => executeCurrentPlan(ctx) });

  async function applyCaveman(requested: string, ctx: ExtensionContext): Promise<void> {
    const current = cavemanLevel();
    if (requested === "off") {
      state = { ...state, caveman: "off" };
    } else if (requested === "on" || requested === "all") {
      state = { ...state, caveman: current === "off" ? cavemanProfileLevel() : current, cavemanScope: "all" };
    } else if (requested === "auto" || requested === "task") {
      state = { ...state, caveman: current === "off" ? cavemanProfileLevel() : current, cavemanScope: "task" };
    } else if (requested === "lite" || requested === "full" || requested === "ultra") {
      state = { ...state, caveman: requested };
    } else {
      ctx.ui.notify(`Unknown caveman argument: ${requested}. Use status | on | auto | off | lite | full | ultra.`, "error");
      return;
    }
    sync(ctx);
    ctx.ui.notify(
      `caveman: ${cavemanLevel()} · scope=${cavemanScope()}${cavemanLevel() === "off" ? " · until session end" : ""}`,
      "info",
    );
  }

  async function handleCaveman(args: string | undefined, ctx: ExtensionContext): Promise<void> {
    const requested = String(args ?? "").trim().toLowerCase();
    if (requested === "status") {
      const current = cavemanLevel();
      const scope = cavemanScope();
      const source = state.caveman
        ? "forced(session)"
        : cavemanEnvLevel() || cavemanEnvScope()
          ? "default(env)"
          : "default(profile)";
      ctx.ui.notify(
        `mode=${state.mode} · caveman=${current} · scope=${scope} · applies=${cavemanApplies() ? "yes" : "no"} · source=${source}`
          + (state.caveman === "off" ? " · off until session end" : "")
          + (scope === "task" ? " · auto = BUILD only" : ""),
        "info",
      );
      return;
    }
    if (!requested) {
      const picked = uiAvailable(ctx)
        ? await overlayCavemanSelect(ctx)
        : await ctx.ui.select("Caveman", ["off", "lite", "full", "ultra"]);
      if (!picked) return;
      await applyCaveman(String(picked), ctx);
      return;
    }
    await applyCaveman(requested, ctx);
  }

  pi.registerCommand("caveman", {
    description: "Краткость ответов: /caveman off, lite, full, ultra, on или auto. Пустой вызов открывает выбор",
    handler: handleCaveman,
  });
  registerAction("command:caveman", (args: unknown, ctx: unknown) => handleCaveman(actionArgs(args, ctx), actionCtx(args, ctx)));
  registerAction("caveman-select", (ctx: ExtensionContext) => handleCaveman(undefined, ctx));

  async function handleAnon(args: string | undefined, ctx: ExtensionContext): Promise<void> {
    if (!String(args ?? "").trim()) {
      const selected = uiAvailable(ctx)
        ? await overlayAnonSelect(ctx)
        : await ctx.ui.select("Anon", ["off", "1", "2", "3"]);
      if (!selected) return;
      const parsed = anonParse(selected);
      if (parsed.kind === "set") setAnonLevel(parsed.level ?? 0, ctx);
      return;
    }
    const parsed = anonParse(args);
    if (parsed.kind === "invalid") {
      ctx.ui.notify(`Unknown anon argument: ${String(args ?? "").trim()}. Use 1 | 2 | 3 | off | status.`, "error");
      return;
    }
    if (parsed.kind === "status") {
      ctx.ui.notify(anonStatusText(), "info");
      return;
    }
    setAnonLevel(parsed.level ?? 0, ctx);
  }

  pi.registerCommand("anon", {
    description: "Анонимная сессия: /anon 1, 2, 3 или off. Пустой вызов открывает выбор",
    handler: handleAnon,
  });
  registerAction("command:anon", (args: unknown, ctx: unknown) => handleAnon(actionArgs(args, ctx), actionCtx(args, ctx)));
  registerAction("anon-select", (ctx: ExtensionContext) => handleAnon(undefined, ctx));

  async function handleApprove(args: string | undefined, ctx: ExtensionContext): Promise<void> {
    const parsed = parseApproveLevel(args);
    if (parsed.kind === "invalid") {
      ctx.ui.notify(`Unknown approve argument: ${String(args ?? "").trim()}. Use off | safe | strict | status.`, "error");
      return;
    }
    if (parsed.kind === "status") {
      const level = approveLevel();
      ctx.ui.notify(`approve=${approveLevelName(level)} · ${describeApprove(level)} · session-scoped (new session starts at off)`, "info");
      return;
    }
    if (parsed.kind === "pick") {
      const selected = uiAvailable(ctx)
        ? await overlayApproveSelect(ctx)
        : await ctx.ui.select("Approve", ["off", "safe", "strict"]);
      if (selected === "off") setApproveLevel(0, ctx);
      if (selected === "safe") setApproveLevel(1, ctx);
      if (selected === "strict") setApproveLevel(2, ctx);
      return;
    }
    setApproveLevel(parsed.level ?? 0, ctx);
  }

  pi.registerCommand("approve", {
    description: "Подтверждение действий: /approve off, safe или strict. Пустой вызов открывает выбор",
    handler: handleApprove,
  });
  registerAction("command:approve", (args: unknown, ctx: unknown) => handleApprove(actionArgs(args, ctx), actionCtx(args, ctx)));
  registerAction("approve-select", (ctx: ExtensionContext) => handleApprove(undefined, ctx));

  pi.registerShortcut(Key.ctrlAlt("a"), {
    description: "Cycle anonymous session level: off → 1 → 2 → 3",
    handler: async (ctx) => {
      const current = anonLevel();
      setAnonLevel(current >= 3 ? 0 : current + 1, ctx);
    },
  });

  pi.registerShortcut(Key.ctrlAlt("s"), {
    description: "Переключить подтверждение: off, safe, strict",
    handler: async (ctx) => {
      setApproveLevel(cycleApproveLevel(approveLevel()), ctx);
    },
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Cycle DevOps BUILD/PLAN/ASK mode",
    handler: async (ctx) => {
      if (state.mode === "build") return switchToPlan(ctx);
      if (state.mode === "plan") return switchToAsk(ctx);
      return switchToBuild(ctx);
    },
  });

  // pi-mcp-adapter emits this event immediately before an MCP tool call.
  // PLAN allows only the explicit read-only inventory; BUILD leaves the
  // adapter's normal approval behavior unchanged.
  pi.events.on("pi-mcp-adapter:tool-approval-request", (request: any) => {
    if (typeof request?.claim !== "function") return;
    // Anonymous session: deny the resolved server/tool pair in EVERY mode, so a
    // write to Cognee/OpenViking is impossible even if the model tries it.
    const anon = anonLevel();
    if (anon > 0) {
      const verdict = anonVerdict(anon, "mcp", { server: request.serverName, tool: request.originalToolName });
      if (!verdict.allowed) {
        request.claim(() => "deny");
        return;
      }
    }
    if (!readOnly()) return;
    request.claim(() => {
      const decision = evaluatePlanMcpCall(request.serverName, request.originalToolName);
      return decision.allowed ? "allow_once" : "deny";
    });
  });

  pi.on("input", (event: any, ctx) => {
    if (event?.source === "extension") return;

    // Refresh the footer on every user turn. `/reload` re-fires session_start,
    // but a refresh here guarantees the `anon:off|1|2|3` item is rendered even
    // if a reload path skipped it (the status is otherwise only synced on
    // state changes).
    updateStatus(ctx);

    // Phrase triggers are silent: the style never announces itself, and the
    // `/caveman` command is the explicit, confirmed surface.
    const intent = parseCavemanIntent(typeof event?.text === "string" ? event.text : "", cavemanLevel());
    if (intent) {
      state = { ...state, caveman: intent };
      sync(ctx);
    }

    // Startup recall is session-scoped: a new user message re-arms its reminder
    // until the recall is actually done (it can be done in any mode).
    if (state.recallGateRequired) {
      state = { ...state, recallGatePrompted: false };
      sync(ctx);
    }

    if (state.mode !== "build") return;
    // A new user message re-arms the reminder (gates stay required until the
    // status lines are actually delivered), it never cancels the obligation.
    if (state.memoryGateRequired || state.dashboardGateRequired) {
      state = { ...state, memoryGatePrompted: false, dashboardGatePrompted: false };
    }
    sync(ctx);
  });

  async function maybeApprove(event: any, ctx: any) {
    const level = approveLevel();
    if (level <= 0 || readOnly()) return;
    const classification = classifyDanger(event.toolName, event.input ?? {});
    if (!shouldPrompt(level, classification.dangerous)) return;
    const scope = approvalScope(event.toolName, classification, event.input ?? {});
    if (approveAllowlist.has(scope)) return;
    if (!ctx?.hasUI) {
      return {
        block: true,
        reason: `Approval mode (${approveLevelName(level)}) blocked '${event.toolName}': ${classification.reason}. No UI available to confirm.`,
      };
    }
    const choice = uiAvailable(ctx)
      ? await overlayApproval(ctx, {
        toolName: event.toolName,
        action: summarizeToolAction(event.toolName, event.input ?? {}),
        reason: classification.reason,
      })
      : await ctx.ui.select(`Approve action? ${event.toolName}: ${classification.reason}`, [APPROVE_ONCE, APPROVE_ALL, APPROVE_DENY]);
    if (choice === APPROVE_ALL) {
      approveAllowlist.add(scope);
      return;
    }
    if (choice === APPROVE_ONCE) return;
    return { block: true, reason: "Отклонено пользователем (approve mode)" };
  }

  pi.on("tool_call", async (event, ctx) => {
    // Startup recall is proven by a real read of shared memory/knowledge: clear
    // the gate before agent_end so the same turn is not nagged about it.
    if (state.recallGateRequired && detectRecallCall(event.toolName, event.input ?? {})) {
      state = { ...state, recallGateRequired: false, recallGatePrompted: false };
      recallGateCleared = true;
    }
    // Anonymous session: hard block of shared-memory writes/reads and of the
    // local pending queue, in every mode. The adapter approval hook below is a
    // second net for the same rule.
    const anon = anonLevel();
    if (anon > 0) {
      const verdict = anonVerdict(anon, event.toolName, event.input ?? {});
      if (!verdict.allowed) {
        return {
          block: true,
          reason: `Anonymous mode (anon:${anon}) blocked '${event.toolName}': ${verdict.reason}. Nothing was stored — report \`Memory: skipped — anonymous\` in the final answer.`,
        };
      }
    }
    if (state.mode === "build") {
      const mutating = event.toolName === "write" || event.toolName === "edit"
        || (event.toolName === "bash" && classifyBashMutation(event?.input?.command));
      if (mutating) {
        const dash = sessionLocal().dashboard?.enabled === true;
        state = {
          ...state,
          memoryGateRequired: true,
          memoryGatePrompted: false,
          ...(dash ? { dashboardGateRequired: true, dashboardGatePrompted: false } : {}),
        };
      }
    }
    if (readOnly()) {
      const decision = evaluateReadOnlyToolCall(state.mode, event.toolName, event.input ?? {});
      if (!decision.allowed) {
        const hint = state.mode === "ask"
          ? "Continue answering in read-only research mode."
          : "Continue planning without mutating infrastructure.";
        return { block: true, reason: `DevOps ${state.mode.toUpperCase()} blocked '${event.toolName}': ${decision.reason}. ${hint}` };
      }
      return;
    }
    return maybeApprove(event, ctx);
  });

  pi.on("before_agent_start", async (event) => {
    // The system prompt is built once per run, while the transcript keeps the
    // model's own older statements about the mode. Carry the current value
    // in-band every turn and emit a one-shot notice on the first run after a
    // change; the previous value is persisted, so `/reload` and resume still
    // deliver that notice exactly once.
    const changedFrom = isModeLabel(state.lastInjectedMode) && state.lastInjectedMode !== state.mode ? state.lastInjectedMode : undefined;
    state = { ...state, lastInjectedMode: state.mode };
    persist();
    const local = sessionLocal();
    const body = state.mode === "plan" ? planInstructions(local) : state.mode === "ask" ? askInstructions(local) : buildInstructions(local);
    let instructions = `${modeNote(state.mode)}\n\n${body}`;
    if (state.mode === "build" && state.phase === "build-executing" && state.plan) {
      instructions += `\n\n# Approved plan handoff\nplan_id: ${state.plan.id}\n\n${state.plan.text}`;
    }
    if (cavemanApplies()) instructions += cavemanNote(cavemanLevel(), cavemanScope(), local.dashboard?.enabled === true);
    const anon = anonLevel();
    if (anon > 0) instructions += anonNote(anon);
    if (state.recallGateRequired && !anonBlocksReads(anon)) instructions += SESSION_START_RECALL_NOTE;
    const result: { systemPrompt: string; message?: { customType: string; content: string; display: boolean } } = {
      systemPrompt: `${event.systemPrompt}\n\n${instructions}${networkNote()}`,
    };
    if (changedFrom) {
      result.message = { customType: "pi-devops-mode-change", content: modeChangeNotice(changedFrom, state.mode), display: true };
    }
    return result;
  });

  pi.on("agent_end", async (event, ctx) => {
    const messages = event.messages ?? [];
    const text = lastAssistantText(messages);
    const runText = messages.map((m: any) => assistantText(m)).filter(Boolean).join("\n\n");

    // Startup-recall gate (all modes). Satisfied by an observed MCP read of
    // shared memory/knowledge (cleared in tool_call) or by the explicit line.
    // Deliberately NO early return — a PLAN turn must not lose its artifact.
    if (state.recallGateRequired || recallGateCleared) {
      const recallOk = !state.recallGateRequired || hasRecallStatus(runText) || hasRecallStatus(text);
      if (recallOk) {
        recallGateCleared = false;
        state = { ...state, recallGateRequired: false, recallGatePrompted: false };
        sync(ctx);
      } else if (!state.recallGatePrompted) {
        state = { ...state, recallGatePrompted: true };
        sync(ctx);
        pi.sendMessage({
          customType: "pi-devops-recall-gate",
          content: "Completion gate: сессия стартовала без обращения к общей памяти. Сделай startup recall — `mcp({ server: \"memory\", tool: \"recall\", args: { query: \"<тема>\" } })` и `mcp({ server: \"knowledge\", tool: \"find\", args: { query: \"<тема>\" } })` (skill `context-bootstrap`) — и заверши ход строкой `Recall: done — <что нашлось>`; для тривиальной темы или недоступного MCP — `Recall: not required — <reason>` / `Recall: UNVERIFIED — <reason>`.",
          display: true,
        }, { triggerTurn: true, deliverAs: "followUp" });
      } else {
        // Already reminded in this run: keep it armed, stop nagging.
        sync(ctx);
      }
    }

    if (state.mode === "build" && (state.memoryGateRequired || state.dashboardGateRequired)) {
      const dashOn = sessionLocal().dashboard?.enabled === true;
      const memoryOk = !state.memoryGateRequired || hasMemoryStatus(runText) || hasMemoryStatus(text);
      const dashboardOk = !dashOn || !state.dashboardGateRequired || hasDashboardStatus(runText) || hasDashboardStatus(text);
      if (memoryOk && dashboardOk) {
        state = { ...state, memoryGateRequired: false, memoryGatePrompted: false, dashboardGateRequired: false, dashboardGatePrompted: false };
        sync(ctx);
      } else if (!memoryOk && !state.memoryGatePrompted) {
        state = { ...state, memoryGatePrompted: true };
        sync(ctx);
        pi.sendMessage({
          customType: "pi-devops-completion-gate",
          content: "Completion gate: this BUILD turn changed something. Missing status line: `Memory:` with `recorded` / `UNCONFIRMED` / `UNVERIFIED` / `skipped — anonymous` (anonymous session) / `not required — <reason>` (shared post-task memory policy).",
          display: true,
        }, { triggerTurn: true, deliverAs: "followUp" });
        return;
      } else if (!dashboardOk && !state.dashboardGatePrompted) {
        state = { ...state, dashboardGatePrompted: true };
        sync(ctx);
        pi.sendMessage({
          customType: "pi-devops-completion-gate",
          content: "Completion gate: this BUILD turn changed something. Missing status line: `Dashboard: updated` or `Dashboard: not required — <reason>` (dashboard artifacts named by the local map).",
          display: true,
        }, { triggerTurn: true, deliverAs: "followUp" });
        return;
      } else {
        // Both gates already asked once in this run: stop nagging, keep them armed.
        state = { ...state, memoryGatePrompted: true, dashboardGatePrompted: true };
        sync(ctx);
      }
    }

    // Execution of an approved plan is finished with this run: leave the phase so
    // the handoff text is not re-injected into unrelated BUILD turns.
    if (state.mode === "build" && state.phase === "build-executing") {
      state = completeBuild(state) as ModeState;
      sync(ctx);
    }

    if (state.mode !== "plan") return;
    const artifact = extractPlanArtifact(text);
    if (!artifact?.ready) {
      state = { ...state, phase: "plan-draft" };
      sync(ctx);
      return;
    }

    state = acceptPlan(state, artifact) as ModeState;
    sync(ctx);
    const planId = state.plan?.id;
    if (planId && planId === lastReadyOffered) return;
    lastReadyOffered = planId;
    if (!ctx.hasUI) {
      pi.sendMessage({ customType: "pi-devops-plan-ready", content: `Plan ready: ${state.plan?.id}. Use /devops-execute-plan to switch to BUILD and execute it, or continue refining in PLAN.`, display: true }, { triggerTurn: false });
      return;
    }

    const choice = await ctx.ui.select(`Plan ready (${state.plan?.id})`, ["Execute in BUILD", "Refine plan", "Stay in PLAN"]);
    if (choice === "Execute in BUILD") {
      await executeCurrentPlan(ctx);
    } else if (choice === "Refine plan") {
      state = { ...state, phase: "plan-draft" };
      sync(ctx);
      pi.sendUserMessage("Refine the current plan. Keep the same task intent, address gaps/risks, and emit the complete required plan format again.", { deliverAs: "followUp" });
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    buildTools = pi.getActiveTools();

    const entries = ctx.sessionManager.getEntries();
    const entry = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "pi-devops-mode-state")
      .pop() as { data?: { state?: ModeState } } | undefined;
    const restored = entry?.data?.state;
    if (restored) state = sanitizeModeState(restored) as ModeState;
    // The anonymous level never travels into a NEW session (no record of its own):
    // a fresh conversation must start with the normal shared-memory policy.
    else state = { ...state, anonLevel: 0 };

    const flag = pi.getFlag("devops-mode");
    const requested = typeof flag === "string" ? flag.toLowerCase() : undefined;
    if (requested === "plan") state = enterPlan(state) as ModeState;
    if (requested === "build") state = enterBuild(state) as ModeState;
    if (requested === "ask") state = enterAsk(state) as ModeState;

    // Anonymous level: the launcher flag (`--anon <N>`) or PI_DEVOPS_ANON wins
    // over the restored record. A NEW session has no record of its own, so it
    // always starts at 0 — the flag is deliberately not inherited.
    const anonFlag = pi.getFlag("anon");
    const anonEnv = process.env.PI_DEVOPS_ANON;
    const anonRaw = anonFlag !== undefined && anonFlag !== null && String(anonFlag).trim() !== ""
      ? String(anonFlag)
      : (typeof anonEnv === "string" && anonEnv.trim() ? anonEnv : undefined);
    if (anonRaw !== undefined) {
      const parsed = anonParse(anonRaw);
      state = { ...state, anonLevel: anonNormalize(parsed.kind === "set" ? parsed.level : anonRaw) };
    }

    const approveOverride = resolveApproveStartup({
      flag: pi.getFlag("devops-approve"),
      env: process.env.PI_DEVOPS_APPROVE,
      restored: Boolean(restored),
    });
    if (approveOverride != null) state = { ...state, approveLevel: approveOverride };

    // Fresh sessions (and records predating this field) must recall first; a
    // resumed session that already did stays satisfied.
    if (state.recallGateRequired !== false) {
      state = { ...state, recallGateRequired: true, recallGatePrompted: false };
    }
    recallGateCleared = false;

    // anon:2/3 may not read shared memory at all, so the startup-recall gate
    // must not demand a call that is forbidden (it comes back when the level drops).
    if (anonBlocksReads(anonLevel())) {
      recallGateSkippedByAnon = recallGateSkippedByAnon || Boolean(state.recallGateRequired);
      state = { ...state, recallGateRequired: false, recallGatePrompted: false };
    }

    pinSessionNetwork();
    publishSharedState();
    if (readOnly()) applyReadOnlyTools(); else applyBuildTools();
    updateStatus(ctx);
  });
}
