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

test('trackBalance establishes a baseline on first call (no spend)', () => {
  const snap = trackBalance('deepseek', 'CNY', 100.0);
  assert.equal(snap.tracked, true);
  assert.equal(snap.todaySpend, 0); // no prior baseline → 0 spend
  assert.equal(spendEntry().lastSeenPaid, 100);
});

test('trackBalance detects a balance drop as spend', () => {
  // Baseline was 100; now 95 → spent 5.
  const snap = trackBalance('deepseek', 'CNY', 95.0);
  assert.equal(snap.todaySpend, 5);
  assert.ok(spendEntry().allTimeSpend >= 5);
});

test('trackBalance does NOT count a top-up as spend', () => {
  // Baseline was 95; now 200 (topped up) → no spend, just new baseline.
  trackBalance('deepseek', 'CNY', 200.0);
  assert.equal(spendEntry().allTimeSpend, 5); // unchanged
  assert.equal(spendEntry().lastSeenPaid, 200);
});

test('trackBalance accumulates across multiple drops', () => {
  trackBalance('deepseek', 'CNY', 190.0); // spent 10
  const snap = trackBalance('deepseek', 'CNY', 180.0); // spent 10 more
  assert.ok(snap.allTimeSpend >= 25); // 5 + 10 + 10
});

function spendEntry(currency = 'CNY') {
  const raw = fs.readFileSync(path.join(TMP, 'spend.json'), 'utf8');
  return JSON.parse(raw)[`deepseek:${currency}`];
}