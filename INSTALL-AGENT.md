# Установка Pi DevOps Agent

Скрипт определяет ОС и ставит только её ярлык. `PI_CODING_AGENT_DIR` не записывается в `~/.bashrc`, `~/.zshrc` и в переменные среды Windows. Переменная нужна только на время `setup.mjs` и процесса `pi-devops`.

Обычный `pi` не подменяется.

## Общее

Нужны Node.js 22.19+ и Pi Coding Agent 1.1.x (`@earendil-works/pi-coding-agent`).

```bash
git clone https://github.com/z03ps00/pi-devops-agent.git ~/pi-devops-agent
cd ~/pi-devops-agent
PI_CODING_AGENT_DIR="$PWD" node scripts/setup.mjs
```

Windows, в том же окне cmd:

```bat
git clone https://github.com/z03ps00/pi-devops-agent.git "%USERPROFILE%\pi-devops-agent"
cd /d "%USERPROFILE%\pi-devops-agent"
set PI_CODING_AGENT_DIR=%CD%
node scripts\setup.mjs
set PI_CODING_AGENT_DIR=
```

`setup.mjs` пишет `settings.json` (пакет `pi/`) и копирует `auth.example.json` / `trust.example.json`, если своих файлов ещё нет. Повторный запуск не затирает уже существующие `settings.json`, `auth.json` и `trust.json`.

Дальше `/doctor` внутри сессии.

Машинные пути, контейнеры и адреса в репозиторий не входят. Их кладут в `devops-local.json` профиля (см. `pi/lib/devops-local.mjs`). Без карты корень инфраструктуры — текущий каталог.

## Linux

```bash
chmod +x ~/pi-devops-agent/scripts/pi-devops ~/pi-devops-agent/scripts/pi-devops-ctl
ln -sfn ~/pi-devops-agent/scripts/pi-devops ~/.local/bin/pi-devops
```

Ярлык панели: скопировать `scripts/Pi-DevOps-Agent.desktop.in` в `~/.local/share/applications/Pi-DevOps-Agent.desktop` и заменить `@PI_DEVOPS_CTL@` на полный путь к `scripts/pi-devops-ctl`. В файле `Terminal=true`.

## macOS

```bash
chmod +x ~/pi-devops-agent/scripts/pi-devops ~/pi-devops-agent/scripts/pi-devops-ctl ~/pi-devops-agent/scripts/Pi-DevOps-Agent.command
ln -sfn ~/pi-devops-agent/scripts/pi-devops ~/.local/bin/pi-devops
cp ~/pi-devops-agent/scripts/Pi-DevOps-Agent.command ~/Desktop/"Pi DevOps Agent.command"
```

`~/.local/bin` должен быть в `PATH` без экспорта `PI_CODING_AGENT_DIR`.

## Windows

Скопировать `scripts\pi-devops.cmd` в каталог, который уже есть в `PATH` пользователя. Не задавать `PI_CODING_AGENT_DIR` в свойствах системы.

Ярлык на рабочем столе: объект `Pi DevOps Agent.lnk`, цель `scripts\pi-devops-ctl.cmd` этого клона.

## Обновление

В каталоге клона:

```bash
node scripts/update-profile.mjs
node scripts/update-pi-cli.mjs
```

Первая команда обновляет файлы из `origin` и не затирает `settings.json`, `mcp.json`, `auth.json`, `trust.json`, `devops-local.json`, `lab/` и `state/`. Вторая обновляет только пакет Pi CLI в его npm prefix.
