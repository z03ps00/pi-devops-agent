# DevOps domain

Infrastructure is live state, not a bag of files. Running containers, units, VMs, routes, and firewall rules are inspected with read-only commands before any change.

Resolve paths through the local map (`devops-local.json`) and environment variables, never through hardcoded machine paths. A service is changed through its documented owner: compose file, unit, or helper script. When a change touches a port, a bridge, or a namespace, check what else listens there first.
