import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHostAllowed, OUTBOUND_ALLOWLIST, timingSafeEqualStrings, generateSessionToken } from '../src/security.js';

test('allowlist permits known provider hosts', () => {
  assert.ok(isHostAllowed('api.z.ai'));
  assert.ok(isHostAllowed('api.deepseek.com'));
  assert.ok(isHostAllowed('opencode.ai'));
  assert.ok(isHostAllowed('open.bigmodel.cn'));
  assert.ok(isHostAllowed('openrouter.ai'));
  assert.ok(isHostAllowed('api.siliconflow.cn'));
  assert.ok(isHostAllowed('api.moonshot.cn'));
  assert.ok(isHostAllowed('api.kimi.ai'));
});

test('allowlist blocks unknown hosts (exfil defence)', () => {
  assert.equal(isHostAllowed('evil.example.com'), false);
  assert.equal(isHostAllowed('127.0.0.1'), false);
  assert.equal(isHostAllowed('attacker.collect'), false);
  // host:port should be normalized
  assert.equal(isHostAllowed('api.deepseek.com:443'), true);
});

test('allowlist does not match lookalike subdomains', () => {
  // api.z.ai.evil.com must NOT match api.z.ai
  assert.equal(isHostAllowed('api.z.ai.evil.com'), false);
  assert.equal(isHostAllowed('not-api.z.ai'), false);
});

test('timingSafeEqualStrings matches and rejects', () => {
  assert.equal(timingSafeEqualStrings('abc', 'abc'), true);
  assert.equal(timingSafeEqualStrings('abc', 'abd'), false);
  assert.equal(timingSafeEqualStrings('abc', 'abcd'), false);
});

test('session token is 64 hex chars and unique', () => {
  const a = generateSessionToken();
  const b = generateSessionToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('OUTBOUND_ALLOWLIST is a frozen known set', () => {
  assert.ok(OUTBOUND_ALLOWLIST instanceof Set);
  assert.ok(OUTBOUND_ALLOWLIST.size >= 4);
});
