function line(label, value) {
  const v = value == null || value === '' ? '—' : String(value);
  return `  ${label.padEnd(14)} ${v}`;
}

export function composeStatus(snapshot = {}) {
  const mode = String(snapshot.mode || 'ask').toUpperCase();
  const anon = Math.trunc(Number(snapshot.anonLevel) || 0);
  const approve = String(snapshot.approve || 'off');
  const pct = snapshot.contextPercent == null ? null : Math.round(Number(snapshot.contextPercent));
  const git = snapshot.gitBranch ? `${snapshot.gitBranch}${snapshot.gitDirty ? ' · dirty' : ''}` : '—';

  return [
    'PI DevOps Agent',
    '',
    'Infrastructure',
    `  ${snapshot.infraRoot || '(not set)'}`,
    `  Network ${snapshot.net || '—'}`,
    `  Git ${git}`,
    '',
    'Agent',
    line('Mode', mode),
    line('Approval', approve),
    line('Anonymous', anon > 0 ? String(anon) : 'off'),
    line('Caveman', snapshot.caveman || 'off'),
    line('Thinking', snapshot.thinkingLevel || 'off'),
    '',
    'Memory',
    line('Capture', snapshot.captureEnabled ? (snapshot.captureMode || 'on') : 'off'),
    line('Cognee', snapshot.cognee || 'unknown'),
    line('OpenViking', snapshot.openviking || 'unknown'),
    '',
    'Session',
    line('Context', pct == null ? '—' : `${pct}%`),
    line('MCP', `${Number(snapshot.mcpConnected) || 0}/${Number(snapshot.mcpEnabled) || 0}`),
    line('Rotation', `${snapshot.rotateEnabled ? 'on' : 'off'} · ${Number.isFinite(Number(snapshot.rotateThreshold)) ? Math.round(Number(snapshot.rotateThreshold)) : 85}%`),
  ].join('\n');
}
