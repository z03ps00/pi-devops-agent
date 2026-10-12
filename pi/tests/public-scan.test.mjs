import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, scanTree } from '../../scripts/scan-public-tree.mjs';

test('a machine path in a fixture is reported and this repository is clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-scan-'));
  const bad = '/mnt/' + 'vol_328/example';
  fs.writeFileSync(path.join(dir, 'note.md'), `see ${bad}\n`);
  const hits = scanTree(dir);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'vol-a');
  assert.equal(scanText('use $HOME/.config\n', 'ok.md').length, 0);

  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  assert.equal(scanTree(repo).length, 0);
});
