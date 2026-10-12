import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { networkFooterLabel, resolveActiveNetwork, resolveLocal } from '../lib/devops-local.mjs';

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
  assert.equal(bare.network.footerLabel, '');
  assert.equal(bare.network.active.id, 'host');
});

test('a stored tunnel id is host unless that profile is in the map', () => {
  const map = {
    network: {
      default: 'wg',
      profiles: [{ id: 'wg', label: 'WireGuard', kind: 'netns', container: 'wg0' }],
    },
  };
  assert.equal(resolveActiveNetwork(map, { env: {}, stored: 'missing' }).profile.id, 'host');
  assert.equal(resolveActiveNetwork(map, { env: {}, stored: 'direct' }).profile.id, 'host');
  assert.equal(resolveActiveNetwork(map, { env: {}, stored: 'wg' }).profile.label, 'WireGuard');
  assert.equal(resolveActiveNetwork(map, { env: { PI_DEVOPS_NET_MODE: 'host' }, stored: 'wg' }).profile.id, 'host');
  assert.equal(networkFooterLabel(map, { label: 'WireGuard' }), 'WireGuard');
  assert.equal(networkFooterLabel({}, { label: 'WireGuard' }), '');
});
