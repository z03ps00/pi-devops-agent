#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hasLabLauncher, resolveLocal } from '../pi/lib/devops-local.mjs';
import { doctorReport } from '../pi/tools/doctor.mjs';
import {
  THINKING_LEVELS,
  applySettingsObject,
  authStatus,
  expandProjectPath,
  jsonValidate,
  listBackupFiles,
  listSessionFiles,
  menuEntries,
  packageVersion,
  parseModelCatalog,
  resolveBackupDir,
  resolveProfileDir,
  settingsGet,
} from './lib/pi-devops-ctl-lib.mjs';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const BOX_W = 74;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const profileDir = resolveProfileDir({ scriptDir });
const local = resolveLocal({ ...process.env, PI_CODING_AGENT_DIR: profileDir }, repoRoot);
const sessionDir = local.sessionDir;
const backupDir = resolveBackupDir({ fromMap: local.backupDir });
const packageDir = path.join(repoRoot, 'pi');
const settingsJson = path.join(profileDir, 'settings.json');
const authJson = path.join(profileDir, 'auth.json');
const piCmd = local.piBin && fs.existsSync(local.piBin) ? local.piBin : (process.platform === 'win32' ? 'pi.cmd' : 'pi');

function visLen(str) {
  return [...String(str).replace(/\x1b\[[0-9;]*m/g, '')].length;
}
function rep(ch, n) { return String(ch).repeat(Math.max(0, n)); }
function boxTop() { return `${CYAN}╔${rep('═', BOX_W - 2)}╗${RESET}`; }
function boxBottom() { return `${CYAN}╚${rep('═', BOX_W - 2)}╝${RESET}`; }
function boxSep() { return `${CYAN}╠${rep('═', BOX_W - 2)}╣${RESET}`; }
function boxDash() { return `${CYAN}║${RESET}${rep('─', BOX_W - 2)}${CYAN}║${RESET}`; }
function boxLine(str) {
  const max = BOX_W - 5;
  let text = String(str);
  if (visLen(text) > max) text = [...text.replace(/\x1b\[[0-9;]*m/g, '')].slice(0, max - 1).join('') + '…';
  const pad = Math.max(0, BOX_W - 4 - visLen(text));
  return `${CYAN}║${RESET} ${text}${rep(' ', pad)} ${CYAN}║${RESET}`;
}
function boxCenter(str) {
  const pad = Math.max(0, Math.floor((BOX_W - 4 - visLen(str)) / 2));
  const rem = Math.max(0, (BOX_W - 4 - visLen(str)) % 2);
  return `${CYAN}║${RESET}${rep(' ', pad + 1)}${str}${rep(' ', pad + 1 + rem)} ${CYAN}║${RESET}`;
}
function printBox(lines) { output.write(`${lines.join('\n')}\n`); }

function piEnv(extra = {}) {
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: profileDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    ...extra,
  };
}

function runPi(args = [], { cwd } = {}) {
  const bin = piCmd;
  const result = spawnSync(bin, args, {
    stdio: 'inherit',
    cwd: cwd || process.cwd(),
    env: piEnv(),
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

function launchAgent(args = [], cwd) {
  const launcher = local.lab?.launcher;
  if (hasLabLauncher(local)) {
    return spawnSync(launcher, args, { stdio: 'inherit', cwd: cwd || process.cwd(), env: piEnv() }).status ?? 1;
  }
  return runPi(args, { cwd });
}

function piVersion() {
  const r = spawnSync(piCmd, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
  return String(r.stdout || '').trim() || '?';
}

function currentMode() {
  try {
    const value = fs.readFileSync(local.netModeFile, 'utf8').trim();
    return value === 'direct' ? 'direct' : 'awg';
  } catch {
    return 'awg';
  }
}

function setMode(mode) {
  if (mode !== 'awg' && mode !== 'direct') {
    output.write(`${RED}Режим: awg или direct${RESET}\n`);
    return;
  }
  fs.mkdirSync(path.dirname(local.netModeFile), { recursive: true });
  fs.writeFileSync(local.netModeFile, `${mode}\n`, { mode: 0o600 });
  const helper = local.lab?.routeraiHelper;
  const snapshot = local.lab?.modelSnapshot;
  if (typeof helper === 'string' && fs.existsSync(helper) && snapshot) {
    const action = mode === 'direct' ? 'apply-direct' : 'restore';
    spawnSync(process.execPath, [helper, 'pi-model', action, settingsJson, snapshot], { stdio: 'inherit' });
  }
  output.write(`${GREEN}Режим сети для следующего запуска: ${mode}${RESET}\n`);
}

function ensureBackupDir() {
  fs.mkdirSync(backupDir, { recursive: true });
  try { fs.chmodSync(backupDir, 0o700); } catch { /* windows */ }
}

function backupSettings(reason = 'manual') {
  ensureBackupDir();
  if (!jsonValidate(settingsJson)) {
    output.write(`${RED}settings.json невалиден — backup отменён.${RESET}\n`);
    return false;
  }
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dst = path.join(backupDir, `settings-${ts}-${reason}.json`);
  fs.copyFileSync(settingsJson, dst);
  try { fs.chmodSync(dst, 0o600); } catch { /* windows */ }
  output.write(`${GREEN}Backup создан:${RESET} ${dst}\n`);
  return true;
}

function applySettings(provider, model, level) {
  if (!THINKING_LEVELS.has(level)) {
    output.write(`${RED}Недопустимый thinking level: ${level}${RESET}\n`);
    return false;
  }
  if (!fs.existsSync(settingsJson) || !jsonValidate(settingsJson)) {
    output.write(`${RED}settings.json отсутствует или невалиден.${RESET}\n`);
    return false;
  }
  if (!backupSettings('before-model-change')) return false;
  const next = applySettingsObject(JSON.parse(fs.readFileSync(settingsJson, 'utf8')), provider, model, level);
  const tmp = path.join(profileDir, `.settings.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  if (!jsonValidate(tmp)) {
    fs.unlinkSync(tmp);
    output.write(`${RED}Временный settings.json невалиден.${RESET}\n`);
    return false;
  }
  fs.renameSync(tmp, settingsJson);
  output.write(`${GREEN}Применено:${RESET} ${provider} / ${model} / thinking=${level}\n`);
  return true;
}

async function pause(rl) { await rl.question(`${GRAY}Нажмите Enter…${RESET}`); }

async function confirmPhrase(rl, phrase, prompt) {
  output.write(`${YELLOW}${prompt}${RESET}\n`);
  const answer = await rl.question(`Введите ${BOLD}${phrase}${RESET} для подтверждения: `);
  return answer === phrase;
}

async function statusScreen(rl) {
  console.clear();
  const sessions = listSessionFiles(sessionDir);
  const net = hasLabLauncher(local) ? currentMode() : '—';
  printBox([
    boxTop(),
    boxCenter('Pi DevOps Agent — статус'),
    boxSep(),
    boxLine(` Профиль:  ${profileDir}`),
    boxLine(` Сессии:   ${sessionDir}`),
    boxLine(` Пакет:    ${packageDir}`),
    boxDash(),
    boxLine(` Pi:       ${piVersion()}`),
    boxLine(` Пакет:    ${packageVersion(path.join(packageDir, 'package.json'))}`),
    boxLine(` Модель:   ${settingsGet(settingsJson, 'defaultProvider') || '?'} / ${settingsGet(settingsJson, 'defaultModel') || '?'}`),
    boxLine(` Сеть:     ${net}`),
    boxLine(` auth:     ${authStatus(authJson)} (секреты не выводятся)`),
    boxLine(` Сессий:   ${sessions.length}; latest=${sessions[0]?.name || 'нет'}`),
    boxBottom(),
  ]);
  await pause(rl);
}

async function sessionsScreen(rl) {
  console.clear();
  const sessions = listSessionFiles(sessionDir);
  printBox([
    boxTop(),
    boxCenter('Сессии'),
    boxSep(),
    ...(sessions.length ? sessions.map((s) => boxLine(` ${s.stamp}  ${s.name}`)) : [boxLine(' Нет сессий')]),
    boxDash(),
    boxLine(' [1] Продолжить последнюю'),
    boxLine(' [2] Выбрать сессию'),
    boxLine(' [0] Назад'),
    boxBottom(),
  ]);
  const choice = await rl.question(`\n${BOLD}Выбор:${RESET} `);
  if (choice === '1') { launchAgent(['-c']); await pause(rl); }
  else if (choice === '2') { launchAgent(['-r']); await pause(rl); }
}

async function newChat(rl) {
  console.clear();
  output.write(`${CYAN}Новый чат. Выход — /quit или Ctrl+C.${RESET}\n\n`);
  launchAgent([]);
  await pause(rl);
}

async function openProjectByPath(rl) {
  console.clear();
  const raw = await rl.question(`${CYAN}Путь к каталогу проекта:${RESET} `);
  const project = expandProjectPath(raw);
  if (!project || !fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
    output.write(`${RED}Каталог не найден.${RESET}\n`);
    await pause(rl);
    return;
  }
  output.write(`${CYAN}Запуск в${RESET} ${project}\n\n`);
  launchAgent([], project);
  await pause(rl);
}

async function diagnosticsScreen(rl) {
  console.clear();
  const report = doctorReport({ profileDir, repo: repoRoot });
  const mark = (item) => boxLine(` ${item.ok ? GREEN + 'OK' : RED + 'FAIL'}${RESET} ${item.id}: ${item.detail}`);
  printBox([
    boxTop(),
    boxCenter('Диагностика'),
    boxSep(),
    ...report.checks.map(mark),
    boxBottom(),
  ]);
  await pause(rl);
}

async function networkMenu(rl) {
  while (true) {
    console.clear();
    printBox([
      boxTop(),
      boxCenter('Сетевой режим'),
      boxSep(),
      boxLine(` Сейчас для следующего запуска: ${currentMode()}`),
      boxDash(),
      boxLine(' [1] awg — изоляция, kill switch'),
      boxLine(' [2] direct — сеть хоста'),
      boxLine(' [0] Назад'),
      boxBottom(),
    ]);
    const choice = await rl.question(`\n${BOLD}Выбор:${RESET} `);
    if (choice === '1') { setMode('awg'); await pause(rl); }
    else if (choice === '2') { setMode('direct'); await pause(rl); }
    else if (choice === '0' || choice === '') return;
  }
}

async function backupMenu(rl) {
  while (true) {
    console.clear();
    printBox([
      boxTop(),
      boxCenter('Backup settings.json'),
      boxSep(),
      boxLine(` Каталог: ${backupDir}`),
      boxDash(),
      boxLine(' [1] Создать backup'),
      boxLine(' [2] Восстановить'),
      boxLine(' [0] Назад'),
      boxBottom(),
    ]);
    const choice = await rl.question(`\n${BOLD}Выбор:${RESET} `);
    if (choice === '1') { backupSettings('manual'); await pause(rl); }
    else if (choice === '2') {
      const files = listBackupFiles(backupDir);
      if (!files.length) { output.write(`${YELLOW}Backups не найдены.${RESET}\n`); await pause(rl); continue; }
      files.forEach((file, index) => output.write(` [${index + 1}] ${file.name}\n`));
      const n = Number(await rl.question('Номер: '));
      const picked = files[n - 1];
      if (!picked || !jsonValidate(picked.full)) { output.write(`${RED}Некорректный выбор.${RESET}\n`); await pause(rl); continue; }
      if (!(await confirmPhrase(rl, 'RESTORE', `Восстановить ${picked.name}?`))) continue;
      if (!backupSettings('before-restore')) continue;
      fs.copyFileSync(picked.full, settingsJson);
      output.write(`${GREEN}Восстановлено.${RESET}\n`);
      await pause(rl);
    } else if (choice === '0' || choice === '') return;
  }
}

async function modelsMenu(rl) {
  console.clear();
  const catalog = spawnSync(piCmd, ['--list-models'], { encoding: 'utf8', env: piEnv() });
  const models = parseModelCatalog(catalog.stdout);
  if (!models.length) {
    output.write(`${YELLOW}Каталог моделей пуст. Задайте provider и model вручную в settings.json.${RESET}\n`);
    await pause(rl);
    return;
  }
  models.slice(0, 20).forEach((item, index) => output.write(` [${index + 1}] ${item.provider} / ${item.model}\n`));
  const n = Number(await rl.question('Номер (0 — отмена): '));
  const picked = models[n - 1];
  if (!picked) return;
  let level = (await rl.question('Thinking (пусто = не менять): ')).trim().toLowerCase();
  if (!level) level = '__KEEP__';
  applySettings(picked.provider, picked.model, level);
  await pause(rl);
}

async function updateMenu(rl) {
  console.clear();
  printBox([
    boxTop(),
    boxCenter('Обновление'),
    boxSep(),
    boxLine(' [1] Профиль из origin (settings, mcp, auth, карта остаются)'),
    boxLine(' [2] Сам Pi CLI, без конфигов профиля'),
    boxLine(' [0] Назад'),
    boxBottom(),
  ]);
  const choice = await rl.question(`\n${BOLD}Выбор:${RESET} `);
  if (choice === '1' && await confirmPhrase(rl, 'UPDATE-PROFILE', 'Обновить файлы профиля из origin?')) {
    spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'update-profile.mjs')], { stdio: 'inherit', cwd: repoRoot });
    await pause(rl);
  } else if (choice === '2' && await confirmPhrase(rl, 'UPDATE-PI', 'Обновить Pi CLI?')) {
    spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'update-pi-cli.mjs')], { stdio: 'inherit', cwd: repoRoot });
    await pause(rl);
  }
}

async function mainMenu() {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      console.clear();
      const rows = menuEntries(local);
      printBox([
        boxTop(),
        boxCenter('Pi DevOps Agent'),
        boxSep(),
        boxLine(` Модель: ${settingsGet(settingsJson, 'defaultProvider') || '?'} / ${settingsGet(settingsJson, 'defaultModel') || '?'}`),
        boxDash(),
        ...rows.map(([key, label]) => boxLine(` ${BOLD}[${key}]${RESET} ${label}`)),
        boxBottom(),
      ]);
      const choice = (await rl.question(`\n${BOLD}Выбор:${RESET} `)).trim();
      if (choice === '1') await statusScreen(rl);
      else if (choice === '2') await newChat(rl);
      else if (choice === '9') await openProjectByPath(rl);
      else if (choice === '3') await sessionsScreen(rl);
      else if (choice === '4') await modelsMenu(rl);
      else if (choice === '5' && rows.some(([key]) => key === '5')) await networkMenu(rl);
      else if (choice === '6') await diagnosticsScreen(rl);
      else if (choice === '7') await backupMenu(rl);
      else if (choice === '8') await updateMenu(rl);
      else if (choice === '0' || choice === 'q' || choice === 'Q') { console.clear(); return; }
      else { output.write(`${RED}Неверный выбор${RESET}\n`); await pause(rl); }
    }
  } finally {
    rl.close();
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url; } catch { return false; }
}

if (isDirectRun()) {
  mainMenu().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
