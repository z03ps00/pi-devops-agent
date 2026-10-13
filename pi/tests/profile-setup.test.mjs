import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDevopsPackagePath, isProfileRoot } from '../../scripts/update-profile.mjs';
import { menuEntries } from '../../scripts/lib/pi-devops-ctl-lib.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('this repository is a DevOps profile root and setup points packages at pi/', () => {
  assert.equal(isProfileRoot(repo), true);
  const settings = applyDevopsPackagePath({ packages: ['npm:other'] }, path.join(repo, 'pi'));
  assert.equal(settings.packages[0], path.join(repo, 'pi'));
  assert.equal(settings.packages[1], 'npm:other');
});

test('the network menu row is always available', () => {
  const plain = menuEntries({ network: { profiles: [] } }).map(([key]) => key);
  assert.equal(plain.includes('5'), true);
  assert.equal(plain.includes('9'), true);
});
