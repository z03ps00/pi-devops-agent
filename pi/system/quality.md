# Quality

Use the minimum sufficient workflow.

- Consultation: answer from inspection, no changes.
- Small change: one edit or command, then a check that it took effect.
- Ordinary change: inspect, plan with rollback, apply, verify.
- Risky change (network, storage, auth, data): PLAN first, a backup or snapshot, a staged apply, and an explicit rollback check.

Implementation is incomplete until it is checked against live state.
