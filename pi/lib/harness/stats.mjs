const COUNTERS = [
  'mcpCalls',
  'bashCalls',
  'bashBlocked',
  'fileReads',
  'fileWrites',
  'skillsLoaded',
  'labNotesLoaded',
  'verificationFailures',
];

export function createStats() {
  const stats = { contextPeak: 0 };
  for (const key of COUNTERS) stats[key] = 0;
  return stats;
}

export function bump(stats, key, amount = 1) {
  if (!stats || !Object.prototype.hasOwnProperty.call(stats, key) || key === 'contextPeak') return stats;
  const n = Number(amount);
  stats[key] += Number.isFinite(n) ? n : 1;
  return stats;
}

export function noteContextPeak(stats, percent) {
  const n = Number(percent);
  if (!stats || !Number.isFinite(n)) return stats;
  stats.contextPeak = Math.max(stats.contextPeak || 0, Math.round(n));
  return stats;
}

export function formatSessionStats(stats = {}) {
  const n = (key) => Number(stats[key]) || 0;
  return [
    'Session efficiency',
    '',
    `MCP calls:            ${n('mcpCalls')}`,
    `Shell commands:       ${n('bashCalls')}`,
    `Shell blocked:        ${n('bashBlocked')}`,
    `File reads:           ${n('fileReads')}`,
    `File writes:          ${n('fileWrites')}`,
    `Skills loaded:        ${n('skillsLoaded')}`,
    `Lab notes loaded:     ${n('labNotesLoaded')}`,
    `Context peak:         ${n('contextPeak')}%`,
    `Verification failed:  ${n('verificationFailures')}`,
  ].join('\n');
}
