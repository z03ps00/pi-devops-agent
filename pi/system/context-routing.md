# Source priority

For the current state of the infrastructure:

1. Live read-only inspection: `docker ps`, `systemctl status`, `ss`, `ip`, `virsh list`, logs.
2. The infrastructure index and notes under the infra root from the local map.
3. A known current config file: compose, unit, env example, script.
4. Bounded file search.
5. Broad grep or directory scan only as fallback.

Live state wins over an old note. A file the user named, or the known edit target, is read immediately. Shared memory and documentation explain history and intent; they do not prove current state.
