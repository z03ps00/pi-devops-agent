export const CAPABILITY_NAMES = Object.freeze([
  'container.engine',
  'container.compose',
  'host.services',
  'host.logs',
  'vm.libvirt',
  'net.firewall',
  'monitoring.metrics',
  'browser.web',
  'docs.web',
  'repository.status',
  'repository.diff',
  'repository.history',
  'memory.short',
  'knowledge.long',
]);

const MATCHERS = {
  'container.engine': [/\bdocker\b/, /\bpodman\b/, /container_list/, /list_containers/],
  'container.compose': [/compose/],
  'host.services': [/systemd/, /systemctl/, /service_status/],
  'host.logs': [/journal/, /\blogs?\b/, /log_search/],
  'vm.libvirt': [/libvirt/, /\bvirsh\b/, /\bqemu\b/, /\bvm_/],
  'net.firewall': [/firewall/, /nftables/, /iptables/, /\bufw\b/],
  'monitoring.metrics': [/prometheus/, /grafana/, /metrics/, /netdata/],
  'browser.web': [/browser/, /playwright/, /puppeteer/],
  'docs.web': [/web_?search/, /web_?fetch/, /context7/, /docs_search/],
  'repository.status': [/repository_status/, /git_status/],
  'repository.diff': [/repository_diff/, /git_diff/],
  'repository.history': [/repository_history/, /git_log/],
  'memory.short': [/memory_recall/, /memory_remember/, /\bcognee\b/],
  'knowledge.long': [/knowledge_find/, /knowledge_search/, /\bopenviking\b/],
};

export function normalizeTool(tool) {
  if (typeof tool === 'string') return { name: tool, description: '' };
  return {
    name: String(tool?.name || tool?.toolName || ''),
    description: String(tool?.description || ''),
  };
}

function haystack(tool) {
  const rec = normalizeTool(tool);
  return `${rec.name}\n${rec.description}`.toLowerCase();
}

export function snapshotCapabilities(tools = []) {
  const blobs = (Array.isArray(tools) ? tools : []).map(haystack);
  const snapshot = {};
  for (const name of CAPABILITY_NAMES) {
    const matchers = MATCHERS[name] || [];
    snapshot[name] = blobs.some((text) => matchers.some((re) => re.test(text)));
  }
  return snapshot;
}

export function formatCapabilitySummary(snapshot = {}) {
  const lines = ['DevOps capabilities:'];
  for (const name of CAPABILITY_NAMES) {
    lines.push(`${name} = ${snapshot[name] ? 'available' : 'unavailable'}`);
  }
  return lines.join('\n');
}

export function formatCapabilityBlock(snapshot = {}) {
  const lines = ['DevOps Capabilities', '────────────────────────────'];
  for (const name of CAPABILITY_NAMES) {
    lines.push(`${name.padEnd(22)} ${snapshot[name] ? '✓' : '✗'}`);
  }
  return lines.join('\n');
}

export function formatCapabilityFooter(snapshot = {}) {
  const any = (prefix) => CAPABILITY_NAMES.some((name) => name.startsWith(prefix) && snapshot[name]);
  return `ctr${any('container.') ? '✓' : '✗'} mem${any('memory.') ? '✓' : '✗'} kb${any('knowledge.') ? '✓' : '✗'}`;
}
