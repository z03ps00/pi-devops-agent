export const MODES = Object.freeze(['ask', 'plan', 'build']);

const SHARED_KEY = '__PI_DEVOPS_MODE__';

export function setDevopsMode(mode) {
  const value = String(mode ?? '').trim().toLowerCase();
  if (!MODES.includes(value)) throw new Error(`Unknown DevOps mode: ${mode}. Use plan, build, or ask.`);
  globalThis[SHARED_KEY] = value;
  return value;
}

export function currentDevopsMode() {
  const value = globalThis[SHARED_KEY];
  return MODES.includes(value) ? value : 'ask';
}

export function isBuildMode() {
  return currentDevopsMode() === 'build';
}

export function resetModeStateForTests() {
  delete globalThis[SHARED_KEY];
}
