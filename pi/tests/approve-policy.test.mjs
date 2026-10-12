import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDanger,
  cycleApproveLevel,
  resolveApproveStartup,
  shouldPrompt,
} from '../lib/approve-policy.mjs';

test('off never asks, safe asks only for a dangerous call, strict asks always', () => {
  assert.equal(shouldPrompt(0, true), false);
  assert.equal(shouldPrompt(1, false), false);
  assert.equal(shouldPrompt(1, true), true);
  assert.equal(shouldPrompt(2, false), true);
  assert.equal(cycleApproveLevel(2), 0);
});

test('read-only docker ps is not dangerous and rm -rf is', () => {
  assert.equal(classifyDanger('bash', { command: 'docker ps' }).dangerous, false);
  assert.equal(classifyDanger('bash', { command: 'rm -rf /tmp/example' }).dangerous, true);
  assert.equal(classifyDanger('write', { path: 'compose.yml' }).category, 'file_write');
});

test('startup flag wins and the env applies only to a new session', () => {
  assert.equal(resolveApproveStartup({ flag: 'safe', env: 'strict', restored: true }), 1);
  assert.equal(resolveApproveStartup({ flag: true, env: 'strict', restored: false }), 2);
  assert.equal(resolveApproveStartup({ flag: true, env: 'strict', restored: true }), null);
});
