---
name: app-icon-generator
description: Build a desktop launcher icon and a .desktop or shortcut file for a local app. Use when adding an application launcher on Linux, macOS, or Windows.
---

# Иконка и ярлык

Ярлык запускает штатный лаунчер, не голый бинарь, если лаунчер есть.

- Linux: файл `.desktop` с `Terminal` по смыслу программы. `Exec` — абсолютный путь, собранный при установке, не зашитый в git. Шаблон с плейсхолдером `@PI_DEVOPS_CTL@` заполняет setup.
- Иконка — png или svg рядом с приложением, размеры которые принимает среда (обычно 256 и 48).
- Не клади ярлык в каталог с хвостовым пробелом в имени. Не прописывай `PI_CODING_AGENT_DIR` в shell rc: переменная только у процесса лаунчера.

## Заметка лаборатории

Пути, контейнеры, адреса и порты этой машины в скилл не входят. Блок локальной карты в системном промпте называет каталог `labSkillNotes`. Если там есть файл `app-icon-generator.md`, прочитай его и следуй ему. Если каталога нет, скажи, что в `devops-local.json` не задан `labSkillNotes`, и не выдумывай путь.
