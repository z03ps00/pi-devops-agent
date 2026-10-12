import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  overlayEconomySelect,
  overlayLearningSelect,
  overlayMcpConfigSelect,
  overlaySelect,
  overlayText,
  pickOverlay,
} from "../devops-ui/overlays.ts";
import { getSnapshot, publish, registerAction, uiAvailable } from "../../lib/ui/index.mjs";
import { formatCapabilityBlock, formatCapabilitySummary, snapshotCapabilities } from "../../lib/harness/capabilities.mjs";
import { classifyDanger } from "../../lib/approve-policy.mjs";
import { tryAdmit } from "../../lib/harness/budget.mjs";
import { renderContextView } from "../../lib/harness/context-view.mjs";
import { approveDraft, createManualDraft, listDrafts, queueEvolutionMemory } from "../../lib/harness/evolution.mjs";
import { ensureMemoryFlushWorker } from "../../lib/memory-flush-worker.mjs";
import {
  approveLearnedSkill,
  formatLearningReview,
  learnedSkillsDir,
  learningStatus,
  queueLearningMemory,
  readLearningMode,
  recordSkillUse,
  reviewExperience,
  writeLearningMode,
} from "../../lib/harness/learning.mjs";
import { beginTurn, getSession, notePrompt, noteTools, noteTrace } from "../../lib/harness/session.mjs";
import { chooseSkills, indexManifests, mergeSkillCatalog, readSkillBody } from "../../lib/harness/skills.mjs";
import { bump, formatSessionStats } from "../../lib/harness/stats.mjs";
import { buildSystemKernel } from "../../lib/harness/system-prompt.mjs";
import { readLabOverlay, resolveLocal } from "../../lib/devops-local.mjs";
import { economyEnabled, parseOnOff, writeSettings } from "../../lib/devops-settings.mjs";
import {
  addMcpServer,
  parseMcpconfigArgs,
  readMcpConfig,
  removeMcpServer,
  resolveMcpConfigPath,
  serverChoices,
  serverNameFromChoice,
  writeMcpConfig,
} from "../../lib/mcp-config.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const profileRoot = process.env.PI_CODING_AGENT_DIR?.trim() || path.resolve(packageRoot, "..");
const LAB_MARKER = "LAB-OVERLAY:BEGIN";

const EVOLVE_CHOICES = [
  { value: "skill", label: "skill", description: "Черновик skill. Активные skills не меняются." },
  { value: "rule", label: "rule", description: "Черновик rule. Активные rules не меняются." },
  { value: "prompt", label: "prompt", description: "Черновик prompt." },
];

function show(pi: ExtensionAPI, ctx: any, title: string, body: string) {
  if (uiAvailable(ctx)) return overlayText(ctx, title, body);
  pi.sendMessage({ customType: "pi-devops-harness", content: body, display: true }, { triggerTurn: false });
  return undefined;
}

function currentMode() {
  return getSnapshot("mode")?.mode || "ask";
}

function anonLevel() {
  return Number(getSnapshot("mode")?.anonLevel) || 0;
}

function memoryConnected() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(profileRoot, "mcp.json"), "utf8"));
    const names = Object.keys(raw?.mcpServers || {});
    if (!names.some((name) => /memory|knowledge|cognee|viking/i.test(name))) return false;
  } catch {
    return false;
  }
  return Number(getSnapshot("mcp")?.connected) > 0;
}

function labNoteNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

/** Short map block: the agent learns where lab data lives without a hardcoded path. */
export function localMapBlock(local: ReturnType<typeof resolveLocal>): string {
  const notes = labNoteNames(local.labSkillNotes);
  const lines = [
    `Infra root: ${local.infraRoot}`,
    `Local map: ${local.mapMissing ? `missing (${local.mapFile})` : local.mapFile}`,
  ];
  if (notes.length) lines.push(`Lab skill notes: ${local.labSkillNotes}/<skill>.md for ${notes.join(", ")}`);
  else lines.push("Lab skill notes: none. A skill that needs machine data names the map key to set.");
  return lines.join("\n");
}

export default function devopsContext(pi: ExtensionAPI): void {
  pi.registerCommand("capabilities", {
    description: "Снимок возможностей DevOps в этой сессии",
    handler: async (_args, ctx) => {
      try { noteTools(pi.getActiveTools()); } catch { /* keep the previous tool list */ }
      await show(pi, ctx, "DevOps Capabilities", formatCapabilityBlock(snapshotCapabilities(getSession().tools)));
    },
  });

  pi.registerCommand("context", {
    description: "Бюджет контекста: ядро, навыки и lab-заметки этого хода",
    handler: async (_args, ctx) => {
      const session = getSession();
      await show(pi, ctx, "Context", renderContextView({ budget: session.budget, loaded: session.loaded, skipped: session.skipped }));
    },
  });

  pi.registerCommand("session-stats", {
    description: "Счётчики инструментов и контекста этой сессии",
    handler: async () => {
      pi.sendMessage({ customType: "pi-devops-session-stats", content: formatSessionStats(getSession().stats), display: true }, { triggerTurn: false });
    },
  });

  async function handleEvolve(args: string | undefined, ctx: any) {
    const raw = String(args ?? "").trim();
    let kind = raw.split(/\s+/)[0] || "";
    if (!kind) {
      const picked = uiAvailable(ctx)
        ? await overlaySelect(ctx, "Evolve", EVOLVE_CHOICES, "Черновик не меняет активные skills и rules.")
        : await ctx.ui.select("Evolve", EVOLVE_CHOICES.map((c) => c.value));
      kind = String(picked || "");
    }
    if (!kind) return;
    if (kind === "approve") {
      const id = raw.split(/\s+/).slice(1).join(" ");
      const learned = approveLearnedSkill(profileRoot, id);
      const result = learned.handled ? learned : approveDraft(profileRoot, id);
      const content = `${result.ok ? result.message || `Draft ${id} approved.` : result.reason || ""}${formatLearningReview(profileRoot)}`;
      pi.sendMessage({ customType: "pi-devops-evolve", content: content.trim(), display: true }, { triggerTurn: false });
      return;
    }
    const created = createManualDraft(profileRoot, kind);
    if (!created.ok) {
      ctx.ui.notify(created.reason || "evolve failed", "error");
      return;
    }
    const memory = queueEvolutionMemory({
      profileDir: profileRoot,
      draft: created.draft,
      connected: memoryConnected(),
      anonLevel: anonLevel(),
      cwd: ctx.cwd,
    });
    if (memory.queued > 0) ensureMemoryFlushWorker(profileRoot);
    const pending = listDrafts(profileRoot, kind).map((draft: any) => `- ${draft.id} [${draft.status}] ${draft.subject}`).join("\n");
    const memoryLine = memory.skipped ? "Memory write skipped." : `Memory queued: ${memory.queued}.`;
    pi.sendMessage({
      customType: "pi-devops-evolve",
      content: `Draft ${created.draft.id} is not active.\n${memoryLine}\n${pending}${formatLearningReview(profileRoot)}`,
      display: true,
    }, { triggerTurn: false });
  }

  pi.registerCommand("evolve", {
    description: "Черновик навыка, правила или промпта; /evolve approve <id>. Пустой вызов открывает выбор",
    handler: handleEvolve,
  });
  registerAction("command:evolve", (args: any, ctx: any) => handleEvolve(args, ctx));

  async function handleLearning(args: string | undefined, ctx: any) {
    const raw = String(args ?? "").trim().toLowerCase();
    if (raw === "status") {
      await show(pi, ctx, "Learning", learningStatus(profileRoot).text);
      return;
    }
    const mode = raw || String((await overlayLearningSelect(ctx)) || "");
    if (!mode) return;
    const saved = writeLearningMode(profileRoot, mode);
    if (!saved.ok) {
      ctx.ui.notify(saved.reason || "learning failed", "error");
      return;
    }
    ctx.ui.notify(`learning:${saved.mode}`, "info");
  }

  pi.registerCommand("learning", {
    description: "Обучение: /learning off, safe или auto. Пустой вызов открывает выбор",
    handler: handleLearning,
  });
  registerAction("command:learning", (args: any, ctx: any) => handleLearning(args, ctx));

  async function handleEconomy(args: string | undefined, ctx: any) {
    const parsed = parseOnOff(args);
    if (parsed.kind === "invalid") {
      ctx.ui.notify(`Unknown economymode argument: ${parsed.raw}. Use on, off or status.`, "error");
      return;
    }
    if (parsed.kind === "status") {
      ctx.ui.notify(`economymode:${economyEnabled(profileRoot) ? "on" : "off"}`, "info");
      return;
    }
    const value = parsed.kind === "set" ? parsed.value : String((await overlayEconomySelect(ctx)) || "");
    if (value !== "on" && value !== "off") return;
    writeSettings(profileRoot, { economy: value });
    publish("mode", { ...(getSnapshot("mode") || {}), economy: value });
    ctx.ui.notify(`economymode:${value}`, "info");
  }

  pi.registerCommand("economymode", {
    description: "Экономия контекста: /economymode on или off. Пустой вызов открывает выбор",
    handler: handleEconomy,
  });
  registerAction("command:economymode", (args: any, ctx: any) => handleEconomy(args, ctx));

  async function askLine(ctx: ExtensionContext, title: string) {
    if (typeof ctx.ui?.input !== "function") return null;
    const value = await ctx.ui.input(title);
    const text = value == null ? "" : String(value).trim();
    return text || null;
  }

  async function askConfirm(ctx: ExtensionContext, title: string, detail: string) {
    if (typeof ctx.ui?.confirm !== "function") return false;
    return Boolean(await ctx.ui.confirm(title, detail));
  }

  async function editMcpFile(ctx: ExtensionContext, file: string) {
    let loaded;
    try {
      loaded = readMcpConfig(file);
    } catch (error: any) {
      ctx.ui.notify(error?.message || String(error), "error");
      return;
    }
    const picked = await pickOverlay(ctx, "MCP servers", serverChoices(loaded.servers), file);
    if (!picked) return;
    if (picked === "add") {
      const name = await askLine(ctx, "Имя сервера");
      if (!name) return;
      const url = await askLine(ctx, "URL");
      if (!url) return;
      if (loaded.servers[name] && !(await askConfirm(ctx, "Заменить url?", `${name} уже есть. Остальные поля записи сохранятся.`))) return;
      writeMcpConfig(file, addMcpServer(loaded.raw, name, url));
      ctx.ui.notify(`${name} записан в ${file}. Нужен /reload.`, "info");
      return;
    }
    const name = serverNameFromChoice(picked);
    if (!name || !(await askConfirm(ctx, "Удалить сервер?", name))) return;
    writeMcpConfig(file, removeMcpServer(loaded.raw, name));
    ctx.ui.notify(`${name} удалён из ${file}. Нужен /reload.`, "info");
  }

  async function handleMcpconfig(args: string | undefined, ctx: ExtensionContext) {
    const parsed = parseMcpconfigArgs(args);
    if (parsed.kind === "invalid") {
      ctx.ui.notify("mcpconfig: local или global", "error");
      return;
    }
    if (currentMode() !== "build") {
      ctx.ui.notify("mcpconfig пишет mcp.json: нужен /mode build", "warning");
      return;
    }
    const scope = parsed.kind === "pick" ? await overlayMcpConfigSelect(ctx) : parsed.scope;
    if (!scope) return;
    const target = resolveMcpConfigPath(scope, { cwd: ctx.cwd });
    if (!target || target.missing) {
      ctx.ui.notify(target?.file ? `mcp.json не найден: ${target.file}` : "PI_CODING_AGENT_DIR не задан", "error");
      return;
    }
    await editMcpFile(ctx, target.file);
  }

  pi.registerCommand("mcpconfig", {
    description: "MCP этого каталога или профиля: добавить или удалить сервер. Пустой вызов открывает выбор",
    handler: handleMcpconfig,
  });
  registerAction("command:mcpconfig", (args: any, ctx: any) => handleMcpconfig(args, ctx));

  pi.on("session_start", async () => {
    try { noteTools(pi.getActiveTools()); } catch { noteTools([]); }
    publish("mode", { ...(getSnapshot("mode") || {}), economy: economyEnabled(profileRoot) ? "on" : "off" });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const session = getSession();
    try { noteTools(pi.getActiveTools()); } catch { /* keep the previous tool list */ }
    const capabilities = snapshotCapabilities(session.tools);
    const economy = economyEnabled(profileRoot);
    const local = resolveLocal(process.env, ctx?.cwd || process.cwd());
    const kernel = buildSystemKernel({
      packageRoot,
      projectConstraints: localMapBlock(local),
      capabilitySummary: economy ? "" : formatCapabilitySummary(capabilities),
    });
    beginTurn(kernel);
    const prompt = String(event.prompt || "");
    notePrompt(prompt);
    const base = String(event.systemPrompt || "");
    let extra = `\n\n${kernel}`;

    if (!base.includes(LAB_MARKER)) {
      const overlay = readLabOverlay(local);
      if (overlay && tryAdmit(session.budget, { id: "lab:overlay", bucket: "lab", text: overlay, protect: true }, session.stats).admitted) {
        session.loaded.lab.push("overlay");
        extra += `\n\n<!-- ${LAB_MARKER} -->\n${overlay}\n<!-- LAB-OVERLAY:END -->`;
      }
    }

    if (!economy) {
      const catalog = mergeSkillCatalog(
        indexManifests(path.join(profileRoot, "skills")),
        indexManifests(learnedSkillsDir(profileRoot)),
      );
      const choice = chooseSkills({ manifests: catalog.manifests, text: prompt, mode: currentMode(), available: capabilities, limit: 2 });
      session.skipped = [...catalog.collisions, ...choice.skipped];
      for (const manifest of choice.selected) {
        const body = readSkillBody(manifest.dir);
        const admitted = tryAdmit(session.budget, { id: `skill:${manifest.id}`, bucket: "skill", text: body }, session.stats);
        if (!admitted.admitted) {
          session.skipped.push({ id: manifest.id, reason: admitted.reason });
          continue;
        }
        session.loaded.skills.push(manifest.id);
        bump(session.stats, "skillsLoaded");
        extra += `\n\n# Skill ${manifest.id}\n${body}`;
        const notePath = path.join(local.labSkillNotes, `${manifest.id}.md`);
        if (!fs.existsSync(notePath)) continue;
        const note = fs.readFileSync(notePath, "utf8");
        if (!tryAdmit(session.budget, { id: `lab:${manifest.id}`, bucket: "lab", text: note }, session.stats).admitted) continue;
        session.loaded.lab.push(manifest.id);
        bump(session.stats, "labNotesLoaded");
        extra += `\n\n# Lab note ${manifest.id}\n${note}`;
      }
    }
    return { systemPrompt: `${base}${extra}` };
  });

  pi.on("tool_call", async (event) => {
    const session = getSession();
    const name = String(event.toolName || "");
    const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
    if (name === "bash") bump(session.stats, "bashCalls");
    else if (name === "read") bump(session.stats, "fileReads");
    else if (name === "write" || name === "edit") bump(session.stats, "fileWrites");
    else if (name.includes("mcp") || name.includes("_")) bump(session.stats, "mcpCalls");
    noteTrace({ name, dangerous: classifyDanger(name, input).dangerous });
    return undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const session = getSession();
    const mode = currentMode();
    const anon = anonLevel();
    const trace = session.trace.slice();
    if (anon > 0) {
      if (mode === "build" && trace.length) {
        pi.sendMessage({ customType: "pi-devops-learning", content: "Learning: skipped — anonymous", display: true }, { triggerTurn: false });
      }
      return;
    }
    if (mode !== "build") return;
    const learning = readLearningMode(profileRoot);
    const result = reviewExperience(profileRoot, {
      task: session.prompt,
      tools: trace,
      verification: session.verification,
      sessionMode: mode,
    }, { cwd: ctx?.cwd || process.cwd(), anonLevel: anon, sessionMode: mode });
    if (learning === "off") return;
    if (session.verification === "pass" || session.verification === "fail") {
      const outcome = session.verification === "pass" ? "success" : "failure";
      for (const id of session.loaded.skills) recordSkillUse(profileRoot, id, outcome);
    }
    if (!result.created && !result.activated) return;
    const memory = queueLearningMemory({
      profileDir: profileRoot,
      candidate: result,
      connected: memoryConnected(),
      anonLevel: anon,
      cwd: ctx?.cwd || profileRoot,
    });
    if (memory.queued > 0) ensureMemoryFlushWorker(profileRoot);
    pi.sendMessage({
      customType: "pi-devops-learning",
      content: result.message || `Learning candidate ${result.id || result.type}.`,
      display: true,
    }, { triggerTurn: false });
  });
}
