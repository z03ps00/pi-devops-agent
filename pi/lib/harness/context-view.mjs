import { contextPercent } from './budget.mjs';

export function renderContextView({ budget, loaded = {}, skipped = [] } = {}) {
  const list = (items) => (items?.length ? items.join(', ') : 'none');
  const pending = skipped.length ? skipped.map((item) => `${item.id} (${item.reason})`).join('; ') : 'none';
  const pct = contextPercent(budget);
  return [
    'Context',
    `budget: ${pct}% (${budget?.used ?? 0}/${budget?.ceiling ?? 0} est. tokens)`,
    `kernel: ${budget?.buckets?.kernel ?? 0}`,
    `skills: ${list(loaded.skills)}`,
    `lab notes: ${list(loaded.lab)}`,
    `unavailable: ${pending}`,
  ].join('\n');
}
