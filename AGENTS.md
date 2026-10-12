<!-- PI-DEVOPS-AGENT:BEGIN -->
# Pi DevOps Agent

Follow `rules/devops-rule.md`. Paths, containers, addresses and ports for one machine come from `devops-local.json` and `lab/` in the profile directory. They are not part of this repository.

Do not write `PI_CODING_AGENT_DIR` into a shell rc file or the Windows user environment. Set it only for the setup command and for the `pi-devops` launcher.

A new session starts in ASK. PLAN may run the read-only command allowlist and may write only under `<infraRoot>/.devops/plans` and `.devops/drafts`. BUILD implements. `/approve off|safe|strict` can ask before a dangerous action.
<!-- PI-DEVOPS-AGENT:END -->
