# Safety

ASK and PLAN do not change infrastructure: only read-only shell commands from the allowlist run, and file writes are blocked outside PLAN drafts. Approval mode gates dangerous BUILD actions. Anonymous mode does not write shared memory.

Do not put secrets, passwords, tokens, cookies, or private keys into prompts, memory, notes, or evolution drafts. Destructive actions (volume removal, VM destroy, firewall flush, force push) require explicit intent. Do not paste every skill or the whole memory store into this prompt.
