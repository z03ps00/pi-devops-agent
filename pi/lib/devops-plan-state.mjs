import crypto from 'node:crypto';

export const PLAN_REQUIRED_SECTIONS = [
  '## Plan',
  '## Files / objects expected to change',
  '## Risks / edge cases',
  '## Verification',
];

// Modes that never mutate infrastructure and share the read-only policy.
export const READ_ONLY_MODES = Object.freeze(['plan', 'ask']);

// --------------------------------------------------------------------------
// Anonymous sessions (DevOps profile)
//
// `anonLevel` suppresses the traces of a session in the shared agent memory and
// knowledge stores:
//   0 — off (default): the shared post-task memory policy applies normally;
//   1 — no writes: Cognee/OpenViking stay read-only, nothing is stored and no
//       local pending record is written;
//   2 — no reads either: the topic never reaches Cognee/OpenViking at all;
//   3 — level 2 plus no local traces: the launcher adds `--no-session`
//       (ephemeral session, no JSONL) and handoff documents are not written.
//
// The flag is session-scoped: it lives in the session state record of the
// CURRENT session, so a resumed session keeps it while a NEW session always
// starts at 0 (unlike `mode`/`caveman`, which a new session also restores).
// --------------------------------------------------------------------------
export const ANON_MAX_LEVEL = 3;

export function normalizeAnonLevel(value) {
  const raw = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(raw)) return 0;
  const level = Math.trunc(raw);
  return level >= 1 && level <= ANON_MAX_LEVEL ? level : 0;
}

/** Parses a `/anon` argument: { kind: 'status' | 'set' | 'invalid', level? }. */
export function parseAnonLevel(arg) {
  const t = String(arg ?? '').trim().toLowerCase();
  if (!t || t === 'status') return { kind: 'status' };
  if (t === 'off' || t === '0' || t === 'no' || t === 'false') return { kind: 'set', level: 0 };
  if (t === 'on' || t === 'yes' || t === 'true') return { kind: 'set', level: 2 };
  if (/^[123]$/.test(t)) return { kind: 'set', level: Number.parseInt(t, 10) };
  return { kind: 'invalid' };
}

/** Hotkey cycle: 0 → 1 → 2 → 3 → 0. */
export function cycleAnonLevel(level) {
  const current = normalizeAnonLevel(level);
  return current >= ANON_MAX_LEVEL ? 0 : current + 1;
}

export function anonBlocksMemoryWrites(level) {
  return normalizeAnonLevel(level) >= 1;
}

export function anonBlocksMemoryReads(level) {
  return normalizeAnonLevel(level) >= 2;
}

export function anonBlocksLocalTraces(level) {
  return normalizeAnonLevel(level) >= 3;
}

export function isReadOnlyMode(mode) {
  return READ_ONLY_MODES.includes(mode);
}

export function extractPlanArtifact(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('## Plan');
  if (start < 0) return null;
  const artifact = text.slice(start).trim();
  const missing = PLAN_REQUIRED_SECTIONS.filter((h) => !artifact.includes(h));
  const numberedSteps = artifact.match(/^\s*\d+\.\s+.+$/gm) ?? [];
  if (missing.length || numberedSteps.length === 0) {
    return { ready: false, artifact, missing, stepCount: numberedSteps.length };
  }
  const hash = crypto.createHash('sha256').update(artifact).digest('hex').slice(0, 12);
  return { ready: true, artifact, missing: [], stepCount: numberedSteps.length, id: `devplan-${hash}` };
}

// Startup default for a NEW DevOps session. Resumed sessions keep their own
// persisted mode; `/mode …` and `--devops-mode …` override this value.
// ASK is the safest default: read-only until the user explicitly opts into
// PLAN or BUILD.
export const DEFAULT_MODE = 'ask';

const MODE_PHASES = Object.freeze({
  plan: 'plan-draft',
  ask: 'ask-idle',
  build: 'build-idle',
});

export function initialModeState() {
  return { mode: DEFAULT_MODE, phase: MODE_PHASES[DEFAULT_MODE], plan: null, anonLevel: 0 };
}

export function enterPlan(state = initialModeState()) {
  // A ready plan is NOT discarded: switching modes must not destroy an approved
  // artifact. It stops being "approved" (phase drops to draft) so nothing is
  // executed by accident, but the text stays available for reference/refine.
  return { ...state, mode: 'plan', phase: 'plan-draft' };
}

// ASK is read-only Q&A: keep any ready plan so it is not lost while answering
// questions (PLAN clears it on entry, ASK does not).
export function enterAsk(state = initialModeState()) {
  return { ...state, mode: 'ask', phase: 'ask-idle' };
}

export function acceptPlan(state, artifactResult) {
  if (!artifactResult?.ready) return { ...state, mode: 'plan', phase: 'plan-draft' };
  return {
    ...state,
    mode: 'plan',
    phase: 'plan-ready',
    plan: {
      id: artifactResult.id,
      text: artifactResult.artifact,
      stepCount: artifactResult.stepCount,
      createdAt: new Date().toISOString(),
    },
  };
}

export function executePlan(state) {
  if (!state?.plan?.id) throw new Error('No ready plan to execute');
  if (state.phase !== 'plan-ready') throw new Error('Plan is not approved (phase must be plan-ready)');
  return { ...state, mode: 'build', phase: 'build-executing' };
}

export function enterBuild(state = initialModeState()) {
  // Only an approved (plan-ready) artifact may start an execution phase.
  const approved = Boolean(state?.plan?.id) && state.phase === 'plan-ready';
  return { ...state, mode: 'build', phase: approved ? 'build-executing' : 'build-idle' };
}

/** Leaves the execution phase: the approved-plan handoff is not re-injected afterwards. */
export function completeBuild(state = initialModeState()) {
  if (state.mode !== 'build' || state.phase !== 'build-executing') return state;
  return { ...state, phase: 'build-idle' };
}

/**
 * Validates a state restored from a session record. A damaged or outdated
 * record must not crash session_start (e.g. `plan.id.slice`) or silently leave
 * an inconsistent mode/phase pair behind.
 */
export function sanitizeModeState(candidate) {
  const fallback = initialModeState();
  if (!candidate || typeof candidate !== 'object') return fallback;
  const mode = candidate.mode;
  if (mode !== 'plan' && mode !== 'build' && mode !== 'ask') return fallback;
  const phase = candidate.phase;
  if (phase !== MODE_PHASES[mode] && !['build-idle', 'build-executing', 'plan-draft', 'plan-ready', 'ask-idle'].includes(phase)) {
    return { ...fallback, mode };
  }
  let plan = null;
  const raw = candidate.plan;
  if (raw && typeof raw === 'object' && typeof raw.id === 'string' && raw.id.trim() && typeof raw.text === 'string') {
    plan = {
      id: raw.id,
      text: raw.text,
      stepCount: Number.isFinite(raw.stepCount) ? raw.stepCount : 0,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    };
  }
  // Anonymous level comes from a possibly damaged record too: a garbage value
  // must degrade to 0 (off) rather than to a truthy string that silently blocks
  // every memory call.
  const state = { ...fallback, ...candidate, mode, phase, plan, anonLevel: normalizeAnonLevel(candidate.anonLevel) };
  // Gate flags come from a possibly damaged record: coerce them to booleans so a
  // half-restored gate can never leak a truthy string into the checks.
  for (const flag of [
    'memoryGateRequired', 'memoryGatePrompted',
    'dashboardGateRequired', 'dashboardGatePrompted',
    'recallGateRequired', 'recallGatePrompted',
  ]) {
    if (flag in state) state[flag] = Boolean(state[flag]);
  }
  if (mode === 'build' && phase === 'build-executing' && !plan) state.phase = 'build-idle';
  if (mode === 'plan' && phase === 'plan-ready' && !plan) state.phase = 'plan-draft';
  return state;
}
