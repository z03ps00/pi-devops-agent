# Tool policy

Read before write: inspect the unit, container, or file that will change. Read is for a named file, an edit target, or a path a lookup already returned. Grep is for literal text and bounded searches.

Do not mutate containers, VMs, networks, or MCP servers unless the user asked for that change. Prefer the owner's tooling (compose, systemctl, helper scripts) over ad hoc commands. Keep long-running commands bounded with a timeout.
