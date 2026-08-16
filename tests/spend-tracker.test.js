import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate spend-tracker tests in a temp dir.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-spend-'));
process.env.TOKEN_TOOL_CONFIG_DIR = TMP;

// Import AFTER setting the env var so spendPath resolves to the temp dir.
const { trackBalance } = await import('../src/util/spend-tracker.js');

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

// Callers pass "provider:accountId" — the default (legacy) account is "default".
const KEY = 'deepseek:default';

test('trackBalance establishes a baseline on first call (no spend)', () => {
  const snap = trackBalance(KEY, 'CNY', 100.0);
  assert.equal(snap.tracked, true);
  assert.equal(snap.todaySpend, 0); // no prior baseline → 0 spend
  assert.equal(spendEntry().lastSeenPaid, 100);
});

test('trackBalance detects a balance drop as spend', () => {
  // Baseline was 100; now 95 → spent 5.
  const snap = trackBalance(KEY, 'CNY', 95.0);
  assert.equal(snap.todaySpend, 5);
  assert.ok(spendEntry().allTimeSpend >= 5);
});

test('trackBalance does NOT count a top-up as spend', () => {
  // Baseline was 95; now 200 (topped up) → no spend, just new baseline.
  trackBalance(KEY, 'CNY', 200.0);
  assert.equal(spendEntry().allTimeSpend, 5); // unchanged
  assert.equal(spendEntry().lastSeenPaid, 200);
});

test('trackBalance accumulates across multiple drops', () => {
  trackBalance(KEY, 'CNY', 190.0); // spent 10
  const snap = trackBalance(KEY, 'CNY', 180.0); // spent 10 more
  assert.ok(snap.allTimeSpend >= 25); // 5 + 10 + 10
});

test('two accounts of one provider keep independent baselines', () => {
  const before = spendEntry().allTimeSpend;
  // Second account starts fresh: its first call only sets a baseline and must
  // not see the default account's history.
  const snap = trackBalance('deepseek:a1b2c3', 'CNY', 50.0);
  assert.equal(snap.todaySpend, 0);
  assert.equal(spendEntry('a1b2c3').allTimeSpend, 0);
  // A drop in the second account books against ITS buckets only.
  trackBalance('deepseek:a1b2c3', 'CNY', 45.0);
  assert.equal(spendEntry('a1b2c3').allTimeSpend, 5);
  assert.equal(spendEntry().allTimeSpend, before);
});

test('legacy 2-segment keys are migrated to the default account on read', () => {
  const legacy = {
    'deepseek:CNY': {
      currency: 'CNY',
      lastSeenPaid: 80,
      trackingSince: '2026-01-01T00:00:00.000Z',
      dailySpend: { '2026-01-01': 3 },
      monthSpend: { '2026-01': 3 },
      allTimeSpend: 3,
    },
    'moonshot:CNY': {
      currency: 'CNY',
      lastSeenPaid: 10,
      trackingSince: '2026-01-01T00:00:00.000Z',
      dailySpend: {},
      monthSpend: {},
      allTimeSpend: 0,
    },
  };
  fs.writeFileSync(path.join(TMP, 'spend.json'), JSON.stringify(legacy));
  // First call after migration continues from the legacy baseline (80 → 75 = 5).
  const snap = trackBalance('deepseek:default', 'CNY', 75.0);
  assert.equal(snap.todaySpend, 5);
  assert.ok(snap.allTimeSpend >= 8); // 3 legacy + 5 new
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'spend.json'), 'utf8'));
  assert.ok(!('deepseek:CNY' in onDisk), 'legacy key must be rewritten');
  assert.ok('deepseek:default:CNY' in onDisk);
  assert.ok('moonshot:default:CNY' in onDisk);
});

function spendEntry(accountId = 'default', currency = 'CNY') {
  const raw = fs.readFileSync(path.join(TMP, 'spend.json'), 'utf8');
  return JSON.parse(raw)[`deepseek:${accountId}:${currency}`];
}
