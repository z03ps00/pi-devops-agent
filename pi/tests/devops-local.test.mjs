import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocal } from '../lib/devops-local.mjs';

test('the local map sets the infra root and a missing map falls back to cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-map-'));
  const infra = path.join(dir, 'infra');
  fs.mkdirSync(infra);
  const map = path.join(dir, 'devops-local.json');
  fs.writeFileSync(map, JSON.stringify({
    schema: 1,
    infraRoot: infra,
    lab: { awgContainer: 'example-proxy', launcher: path.join(dir, 'missing-launcher') },
    dashboard: { enabled: false },
  }));
  const local = resolveLocal({ PI_DEVOPS_LOCAL_MAP: map, PI_CODING_AGENT_DIR: dir }, os.tmpdir());
  assert.equal(local.infraRoot, infra);
  assert.equal(local.lab.awgContainer, 'example-proxy');
  assert.equal(local.dashboard.enabled, false);
  assert.equal(local.planRoots[0], path.join(infra, '.devops', 'plans'));

  const bare = resolveLocal({ PI_DEVOPS_LOCAL_MAP: path.join(dir, 'nope.json'), PI_CODING_AGENT_DIR: '' }, infra);
  assert.equal(bare.mapMissing, true);
  assert.equal(bare.infraRoot, infra);
});
