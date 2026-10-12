import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSnapshot, registerAction } from "../../lib/ui/index.mjs";
import { formatCapabilityBlock, snapshotCapabilities } from "../../lib/harness/capabilities.mjs";
import { getSession, noteTools } from "../../lib/harness/session.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageRoot, "..");

function runNode(script: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
}

function output(result: ReturnType<typeof spawnSync>, label: string) {
  return `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim() || `${label} exited ${result.status}`;
}

export default function devopsAdmin(pi: ExtensionAPI): void {
  async function handleDoctor(args: string | undefined, ctx: any) {
    const flags = String(args ?? "").trim().split(/\s+/).filter(Boolean).map((a) => (a.startsWith("--") ? a : `--${a}`));
    const result = runNode(path.join(packageRoot, "tools", "doctor.mjs"), flags, ctx.cwd);
    if (result.status !== 0) ctx.ui.notify(`doctor: найдены проблемы (exit ${result.status})`, "warning");
    try { noteTools(pi.getActiveTools()); } catch { /* doctor still prints an empty snapshot */ }
    const capabilities = formatCapabilityBlock(snapshotCapabilities(getSession().tools));
    pi.sendMessage({ customType: "pi-devops-doctor", content: `${output(result, "doctor")}\n\n${capabilities}`, display: true }, { triggerTurn: false });
  }

  pi.registerCommand("doctor", {
    description: "Проверка профиля, пакета, карты и ссылок без модели: /doctor, /doctor json",
    handler: async (args, ctx) => handleDoctor(args, ctx),
  });
  registerAction("command:doctor", (args: string | undefined, ctx: any) => handleDoctor(args, ctx));

  function requireBuild(ctx: any, what: string) {
    if ((getSnapshot("mode")?.mode || "ask") === "build") return true;
    ctx.ui.notify(`${what} меняет файлы профиля: нужен /mode build`, "warning");
    return false;
  }

  pi.registerCommand("update-profile", {
    description: "Обновить файлы профиля и пакет из origin; settings, mcp, auth, state и карта остаются",
    handler: async (args, ctx) => {
      if (!requireBuild(ctx, "update-profile")) return;
      const result = runNode(path.join(repoRoot, "scripts", "update-profile.mjs"), String(args ?? "").trim().split(/\s+/).filter(Boolean), repoRoot);
      pi.sendMessage({ customType: "pi-devops-update", content: `${output(result, "update-profile")}\n\nНовые команды появятся после /reload.`, display: true }, { triggerTurn: false });
    },
  });

  pi.registerCommand("update-pi-cli", {
    description: "Обновить сам Pi CLI в найденном npm prefix без правки конфигов",
    handler: async (args, ctx) => {
      if (!requireBuild(ctx, "update-pi-cli")) return;
      const result = runNode(path.join(repoRoot, "scripts", "update-pi-cli.mjs"), String(args ?? "").trim().split(/\s+/).filter(Boolean), repoRoot);
      pi.sendMessage({ customType: "pi-devops-update", content: output(result, "update-pi-cli"), display: true }, { triggerTurn: false });
    },
  });
}
