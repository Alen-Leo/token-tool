// Local spend tracker — derives spend from periodic balance polls.
//
// Some providers (DeepSeek) expose no "usage" or "spend" API; only a balance
// endpoint. By polling the balance at intervals and persisting the last seen
// paid balance, we can attribute a balance drop-down to local spend:
//   spentSinceLastPoll = max(0, lastSeenPaid - currentPaid)
// We accumulate that into today's / this month's / all-time buckets, keyed by
// the provider id and currency. A top-up (balance going UP) resets the baseline
// without counting as spend.
//
// Storage lives in the config dir (~/.token-tool/) as spend.json and is shared
// across the server + desktop shell (same process). It is NOT secrets — only
// rounded spend totals — but it still only references provider ids/currencies.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILENAME = 'spend.json';

function configDir() {
  const override = process.env.TOKEN_TOOL_CONFIG_DIR;
  if (override) return override;
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.token-tool');
}

function spendPath() {
  return path.join(configDir(), FILENAME);
}

function readStore() {
  try {
    const raw = fs.readFileSync(spendPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  const dir = configDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const tmp = `${spendPath()}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, spendPath());
}

const pad2 = (n) => String(n).padStart(2, '0');

// Local-time keys so "today"/"this month" roll over on the user's wall clock,
// not at UTC midnight (8:00 for the CNY/China audience).
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

// Retention window for the per-day / per-month buckets. String keys sort in
// chronological order (YYYY-MM-DD, YYYY-MM), so a lexical < compare prunes by
// age. Keeps spend.json bounded over years of use instead of growing a key a
// day forever.
const RETAIN_DAYS = 400; // ~13 months of daily buckets
const RETAIN_MONTHS = 13; // a rolling year plus the current month
const DAY_MS = 86_400_000;

function pruneEntry(entry, now) {
  if (!entry.dailySpend || !entry.monthSpend) return;
  const cutoffDay = dayKey(new Date(now.getTime() - RETAIN_DAYS * DAY_MS));
  const cutoffMonth = monthKey(new Date(now.getTime() - RETAIN_MONTHS * 30 * DAY_MS));
  for (const k of Object.keys(entry.dailySpend)) {
    if (k < cutoffDay) delete entry.dailySpend[k];
  }
  for (const k of Object.keys(entry.monthSpend)) {
    if (k < cutoffMonth) delete entry.monthSpend[k];
  }
}

// Record a balance observation for a provider+currency. Returns the derived
// spend snapshot (today/month/allTime) AFTER incorporating this observation.
//   paidBalance: the TOPPED-UP (paid-in) balance — drops as you spend, climbs
//                when you top up. We track spend as decreases in this number.
export function trackBalance(providerId, currency, paidBalance) {
  const store = readStore();
  const key = `${providerId}:${currency}`;
  const now = new Date();
  const dk = dayKey(now);
  const mk = monthKey(now);

  const entry = store[key] || {
    currency,
    lastSeenPaid: null,
    trackingSince: now.toISOString(),
    dailySpend: {}, // { 'YYYY-MM-DD': amount }
    monthSpend: {}, // { 'YYYY-MM': amount }
    allTimeSpend: 0,
  };

  let spent = 0;
  if (entry.lastSeenPaid != null && Number.isFinite(paidBalance)) {
    const delta = entry.lastSeenPaid - paidBalance;
    if (delta > 0) spent = delta; // balance went down → spend
    // If balance went UP (top-up or grant), it's not spend — just update baseline.
  }

  if (spent > 0) {
    entry.dailySpend[dk] = round4((entry.dailySpend[dk] || 0) + spent);
    entry.monthSpend[mk] = round4((entry.monthSpend[mk] || 0) + spent);
    entry.allTimeSpend = round4(entry.allTimeSpend + spent);
  }
  entry.lastSeenPaid = Number.isFinite(paidBalance) ? round4(paidBalance) : entry.lastSeenPaid;

  pruneEntry(entry, now);
  store[key] = entry;
  writeStore(store);

  return {
    currency,
    tracked: true,
    todaySpend: entry.dailySpend[dk] || 0,
    monthSpend: entry.monthSpend[mk] || 0,
    allTimeSpend: entry.allTimeSpend || 0,
    trackingSince: entry.trackingSince,
  };
}

function round4(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1e4) / 1e4;
}
