import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addNetworkProfile,
  networkFooterLabel,
  readStoredNetworkId,
  removeNetworkProfile,
  resolveActiveNetwork,
  resolveLocal,
  selectNetworkProfile,
} from '../lib/devops-local.mjs';

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

test('adding a profile writes the map and a launcher from the template', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-net-'));
  const env = { PI_CODING_AGENT_DIR: dir, PI_DEVOPS_NET_MODE: '', PI_DEVOPS_NET_MODE_FILE: path.join(dir, 'mode') };
  const template = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'templates', 'app-launch.sh.tpl'), 'utf8');
  const missing = addNetworkProfile(env, { label: 'Wire Guard', container: 'wg0' }, template);
  assert.equal(missing.reason, 'need-net-exec');
  const added = addNetworkProfile(env, { label: 'Wire Guard', container: 'wg0', netExec: path.join(dir, 'enter.sh') }, template);
  assert.equal(added.ok, true);
  assert.equal(added.id, 'wire-guard');
  const script = fs.readFileSync(added.launcher, 'utf8');
  assert.match(script, /PROFILE_ID="wire-guard"/);
  assert.match(script, /CONTAINER="wg0"/);
  assert.equal(script.includes('<NET_EXEC>'), false);
  const selected = selectNetworkProfile(env, 'wire-guard');
  assert.equal(selected.ok, true);
  assert.equal(readStoredNetworkId(env.PI_DEVOPS_NET_MODE_FILE), 'wire-guard');
  const removed = removeNetworkProfile(env, 'wire-guard');
  assert.equal(removed.ok, true);
  assert.equal(removed.modeReset, true);
  assert.equal(fs.existsSync(added.launcher), false);
  assert.equal(readStoredNetworkId(env.PI_DEVOPS_NET_MODE_FILE), 'host');
  const foreign = path.join(dir, 'kept.sh');
  fs.writeFileSync(foreign, '#!/bin/sh\n');
  const map = JSON.parse(fs.readFileSync(path.join(dir, 'devops-local.json'), 'utf8'));
  map.network.profiles = [{ id: 'kept', label: 'Kept', kind: 'netns', container: 'c', launcher: foreign }];
  fs.writeFileSync(path.join(dir, 'devops-local.json'), JSON.stringify(map));
  removeNetworkProfile(env, 'kept');
  assert.equal(fs.existsSync(foreign), true);
});
