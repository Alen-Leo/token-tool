import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIso, clampPct, makeWindow, round, toNum, relativeFromNow } from '../src/util/format.js';

test('clampPct clamps and parses', () => {
  assert.equal(clampPct(150), 100);
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct('42'), 42);
  assert.equal(clampPct('nope'), null);
});

test('toIso handles seconds, ms, and strings', () => {
  assert.match(toIso(0), /^1970-01-01T00:00:00/); // 0 → seconds
  assert.match(toIso(1_700_000_000_000), /^2023/); // ms passthrough
  assert.equal(toIso('not-a-date'), null);
  assert.equal(toIso(''), null);
});

test('makeWindow derives percent from used/limit', () => {
  const w = makeWindow({ kind: 'session', label: '5h', used: 3, limit: 12 });
  assert.equal(w.usedPercent, 25);
  assert.equal(w.remainingPercent, 75);
  assert.equal(w.used, 3);
  assert.equal(w.limit, 12);
});

test('makeWindow respects explicit percent over used/limit', () => {
  const w = makeWindow({ usedPercent: 50, used: 9, limit: 12 });
  assert.equal(w.usedPercent, 50);
});

test('makeWindow carries the unit for UI formatting', () => {
  const tokenWin = makeWindow({ kind: 'session', unit: 'tokens', used: 3, limit: 12 });
  assert.equal(tokenWin.unit, 'tokens');
  const moneyWin = makeWindow({ kind: 'session', unit: 'currency', used: 3, limit: 12 });
  assert.equal(moneyWin.unit, 'currency');
  const bare = makeWindow({ kind: 'session', used: 3, limit: 12 });
  assert.equal(bare.unit, null);
});

test('round rounds to given digits', () => {
  assert.equal(round(1.25, 1), 1.3);
  assert.equal(round(1.234, 2), 1.23);
});

test('relativeFromNow returns relative labels', () => {
  const future = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  assert.match(relativeFromNow(future), /^in /);
  const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  assert.match(relativeFromNow(past), /ago$/);
  assert.equal(relativeFromNow(''), '');
});
