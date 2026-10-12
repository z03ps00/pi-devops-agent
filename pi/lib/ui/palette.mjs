export const PALETTE_SHORTCUT = 'ctrl+shift+k';

export const PALETTE_ACTIONS = Object.freeze([
  { id: 'mode', label: 'Режим', keywords: 'mode build plan ask', command: '/mode' },
  { id: 'status', label: 'Статус сессии', keywords: 'status health net', command: '/status' },
  { id: 'approve', label: 'Подтверждение действий', keywords: 'approve safe strict', command: '/approve' },
  { id: 'anon', label: 'Анонимная сессия', keywords: 'anon privacy', command: '/anon' },
  { id: 'caveman', label: 'Краткость ответов', keywords: 'caveman short lite ultra', command: '/caveman' },
  { id: 'memory', label: 'Память', keywords: 'wrap capture cognee', command: '/wrap auto status' },
  { id: 'session', label: 'Ротация сессии', keywords: 'session rotate context', command: '/session-rotate status' },
  { id: 'context', label: 'Бюджет контекста', keywords: 'context budget tokens', command: '/context' },
  { id: 'capabilities', label: 'Возможности MCP', keywords: 'capabilities mcp tools', command: '/capabilities' },
  { id: 'mcpconfig', label: 'Конфиг MCP', keywords: 'mcp json servers', command: '/mcpconfig' },
  { id: 'theme', label: 'Тема', keywords: 'theme color dracula dark light standard', command: '/theme' },
  { id: 'doctor', label: 'Диагностика', keywords: 'doctor health check', command: '/doctor' },
]);

function score(action, query) {
  const hay = `${action.id} ${action.label} ${action.keywords || ''}`.toLowerCase();
  if (hay.startsWith(query)) return 3;
  if (action.label.toLowerCase().includes(query)) return 2;
  if (hay.includes(query)) return 1;
  return 0;
}

export function filterPaletteActions(query, actions = PALETTE_ACTIONS) {
  const q = String(query || '').trim().toLowerCase();
  const list = [...actions];
  if (!q) return list;
  return list
    .map((a) => ({ action: a, score: score(a, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.action.label.localeCompare(b.action.label))
    .map((x) => x.action);
}

export function paletteBindsCtrlK() {
  return PALETTE_SHORTCUT === 'ctrl+k';
}
