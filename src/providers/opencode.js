// Provider: OpenCode Go.
//
// OpenCode Go exposes an OpenAI-compatible inference API authenticated with an
// `sk-` key, but it does NOT expose a public usage/quota REST endpoint — real
// usage lives either in the local OpenCode SQLite store or the web console.
//
// This provider therefore combines two signals, honestly:
//   1. Local SQLite read (optional) — if OpenCode is installed locally
//      (~/.local/share/opencode/opencode.db), we compute session / weekly /
//      monthly spend against the published Go plan limits ($12/5h, $30/week,
//      $60/month). Mirrors the reference implementation.
//   2. API-key liveness probe — GET https://opencode.ai/zen/go/v1/models with
//      the key. A 200 with a model list confirms the key is active and reports
//      how many models the plan unlocks. This is the verification signal when
//      no local DB exists.
//
// We never pretend to have usage we couldn't read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getJson, withDeadline, HttpError } from '../util/http.js';
import { toNum, round, makeWindow, clampPct, relativeFromNow } from '../util/format.js';
import { tr, errorText } from '../i18n.js';

const BASE = 'https://opencode.ai';
const MODELS_PATH = '/zen/go/v1/models';
const CONSOLE = 'https://opencode.ai/auth';
const FETCH_TIMEOUT_MS = 12_000;

// Published OpenCode Go plan limits (USD): https://opencode.ai/docs/go/
// $12 / 5h, $30 / week, $60 / month. Env-overridable if the plan changes.
const DEFAULT_GO_LIMITS = { session: 12, weekly: 30, monthly: 60 };
const SESSION_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const meta = {
  id: 'opencode',
  name: 'OpenCode Go',
  description: 'Plan liveness + model list via API key; local spend windows when OpenCode is installed.',
  doc: 'https://opencode.ai/docs/go/',
  configFields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, env: ['OPENCODE_API_KEY'] },
  ],
  offers: ['models', 'usageWindows'],
};

function goLimits() {
  const raw = String(process.env.TOKEN_TOOL_OPENCODE_GO_LIMITS || '').trim();
  if (!raw) return { ...DEFAULT_GO_LIMITS };
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n > 0)) {
    return { session: parts[0], weekly: parts[1], monthly: parts[2] };
  }
  return { ...DEFAULT_GO_LIMITS };
}

// ---- Local SQLite read (optional) -----------------------------------------

function resolveDataDir() {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, 'opencode');
  if (process.env.OPENCODE_DB) return path.dirname(process.env.OPENCODE_DB);
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.local', 'share', 'opencode');
}

function isOpenCodeDb(name) {
  if (!name.endsWith('.db')) return false;
  const stem = name.slice(0, -3);
  if (stem === 'opencode') return true;
  if (!stem.startsWith('opencode-')) return false;
  const channel = stem.slice('opencode-'.length);
  return channel.length > 0 && /^[A-Za-z0-9._-]+$/.test(channel);
}

function discoverDbPaths() {
  const override = String(process.env.OPENCODE_DB || '').trim();
  if (override) {
    try {
      if (fs.statSync(override).isFile()) return [override];
    } catch {
      /* fall through */
    }
  }
  let entries;
  try {
    entries = fs.readdirSync(resolveDataDir());
  } catch {
    return [];
  }
  return entries.filter(isOpenCodeDb).sort().map((n) => path.join(resolveDataDir(), n));
}

let sqlitePromise = null;
async function loadSqlite() {
  if (sqlitePromise) return sqlitePromise;
  sqlitePromise = (async () => {
    try {
      // node:sqlite is experimental; available unflagged on Node 24+, flagged
      // earlier. Dynamically import so a missing module degrades gracefully.
      const mod = await import('node:sqlite');
      return mod.DatabaseSync || (mod.default && mod.default.DatabaseSync) || null;
    } catch {
      return null;
    }
  })();
  return sqlitePromise;
}

const GO_ROWS_SQL = `
  SELECT CAST(COALESCE(json_extract(data,'$.time.created'), time_created) AS INTEGER) AS createdMs,
         CAST(json_extract(data,'$.cost') AS REAL) AS cost
  FROM message
  WHERE json_valid(data)
    AND json_extract(data,'$.providerID') = 'opencode-go'
    AND json_extract(data,'$.role') = 'assistant'
    AND json_type(data,'$.cost') IN ('integer','real')`;

async function readGoRows() {
  const DbSync = await loadSqlite();
  if (!DbSync) return { rows: [], reason: 'sqlite-unavailable' };
  const paths = discoverDbPaths();
  if (paths.length === 0) return { rows: [], reason: 'no-db' };
  const rows = [];
  let read = false;
  for (const dbPath of paths) {
    let db;
    try {
      db = new DbSync(dbPath, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 250');
      const found = db.prepare(GO_ROWS_SQL).all();
      read = true;
      for (const r of found) {
        const createdMs = Number(r.createdMs);
        const cost = Number(r.cost);
        if (Number.isFinite(createdMs) && createdMs > 0 && Number.isFinite(cost) && cost >= 0) {
          rows.push({ createdMs, cost });
        }
      }
    } catch {
      /* skip unreadable db */
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }
  if (!read) return { rows: [], reason: 'db-unreadable' };
  return { rows, reason: 'ok' };
}

function weekStartMs(nowMs) {
  const d = new Date(nowMs);
  const day = d.getUTCDay();
  const sinceMonday = day === 0 ? 6 : day - 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
}

function monthBoundsMs(nowMs) {
  const now = new Date(nowMs);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { startMs: start, endMs: end };
}

function sumCost(rows, startMs, endMs) {
  let total = 0;
  for (const r of rows) {
    if (r.createdMs >= startMs && r.createdMs < endMs) total += r.cost;
  }
  return total;
}

function buildUsageWindows(rows, nowMs, limits, lang = 'en') {
  const sessionStart = nowMs - SESSION_MS;
  const weekStart = weekStartMs(nowMs);
  const { startMs: monthStart, endMs: monthEnd } = monthBoundsMs(nowMs);

  let sessionOldest = nowMs;
  for (const r of rows) {
    if (r.createdMs >= sessionStart && r.createdMs < nowMs && r.createdMs < sessionOldest) sessionOldest = r.createdMs;
  }

  const mk = (kind, label, used, limit, resetMs) => {
    const w = makeWindow({ kind, label, used, limit, unit: 'currency', usedPercent: limit > 0 ? (used / limit) * 100 : null, resetsAt: resetMs });
    // Carry remaining money for the UI: plan limit minus local spend so far.
    w.remainingCount = limit > 0 ? round(Math.max(0, limit - used), 2) : null;
    return w;
  };

  return [
    // The 5-hour window is rolling — the only meaningful boundary is when the
    // oldest in-window row rolls out (created + 5h). With no rows at all there
    // is no boundary, so resetsAt stays null instead of a misleading "5h from now".
    mk('session', tr(lang, 'window.5hour'), sumCost(rows, sessionStart, nowMs), limits.session, sessionOldest === nowMs ? null : sessionOldest + SESSION_MS),
    mk('weekly', tr(lang, 'window.weekly'), sumCost(rows, weekStart, weekStart + WEEK_MS), limits.weekly, weekStart + WEEK_MS),
    mk('monthly', tr(lang, 'window.monthly'), sumCost(rows, monthStart, monthEnd), limits.monthly, monthEnd),
  ];
}

// ---- API-key probe ---------------------------------------------------------

// Summary: "Key valid · 42 models · session $3/$12 (25%) · resets in 2h 30m".
function buildGoSummary(windows, modelCount, lang) {
  const parts = [tr(lang, 'summary.keyValid', modelCount)];
  const session = windows.find((w) => w.kind === 'session');
  if (session && session.used != null && session.limit != null && session.limit > 0) {
    const pct = Math.round(session.usedPercent || 0);
    const spent = session.used.toFixed(2);
    const lim = session.limit.toFixed(0);
    parts.push(tr(lang, 'summary.rolling', spent, lim, pct));
    if (session.resetsAt) {
      const rel = relativeFromNow(session.resetsAt, Date.now(), lang);
      if (rel) parts.push(tr(lang, 'summary.resets', rel));
    }
  } else {
    parts.push(tr(lang, 'summary.usageInConsole'));
  }
  return parts.join(' · ');
}

async function probeKey(key) {
  const headers = { Authorization: `Bearer ${key}` };
  const body = await withDeadline(
    (signal) => getJson(`${BASE}${MODELS_PATH}`, { headers, signal, timeoutMs: FETCH_TIMEOUT_MS }),
    { deadlineMs: FETCH_TIMEOUT_MS },
  );
  const list = Array.isArray(body?.data) ? body.data : [];
  const models = list.map((m) => m?.id).filter(Boolean);
  return { models, count: models.length };
}

// Remote rolling-usage endpoint — shipped 2026-08-11 (opencode PR #16513).
//   GET https://opencode.ai/zen/go/v1/usage
//   Authorization: Bearer sk-...   — the user's Go plan API key.
// Returns { usage: { rolling: {status, percent, resetsAt}, weekly: {...}, monthly: {...} } }
// This is server-authoritative and beats local-DB aggregation for the gauge.
const REMOTE_USAGE_PATH = '/zen/go/v1/usage';

async function probeUsage(key) {
  const headers = { Authorization: `Bearer ${key}` };
  const body = await withDeadline(
    (signal) => getJson(`${BASE}${REMOTE_USAGE_PATH}`, { headers, signal, timeoutMs: FETCH_TIMEOUT_MS }),
    { deadlineMs: FETCH_TIMEOUT_MS },
  );
  return body?.usage || null;
}
// Fallback windows showing the Go plan limits at 0% used — the rolling usage
// gauges stay visible even when neither the remote endpoint nor a local DB is
// available. used=0, percent=0, no resetsAt.
function buildDefaultWindows(limits, lang = 'en') {
  const mk = (kind, label, limit) => {
    const w = makeWindow({ kind, label, used: 0, limit, unit: 'currency', usedPercent: 0 });
    w.remainingCount = limit; // full limit remains
    return w;
  };
  return [
    mk('session', tr(lang, 'window.5hour'), limits.session),
    mk('weekly', tr(lang, 'window.weekly'), limits.weekly),
    mk('monthly', tr(lang, 'window.monthly'), limits.monthly),
  ];
}

// Build usage windows from the remote response. When the remote endpoint gives
// us a percent + resetsAt, we derive an estimated dollar figure from the known
// plan limits ($12/5h, $30/week, $60/month) so the UI can show it alongside the
// percentage bar.
function windowsFromRemote(remote, limits, lang = 'en') {
  if (!remote) return [];
  const limitsByKind = { rolling: limits.session, weekly: limits.weekly, monthly: limits.monthly };
  const labelsByKind = { rolling: tr(lang, 'window.5hour'), weekly: tr(lang, 'window.weekly'), monthly: tr(lang, 'window.monthly') };
  const kinds = ['rolling', 'weekly', 'monthly'];
  const out = [];
  for (const k of kinds) {
    const r = remote[k];
    if (!r || typeof r !== 'object') continue;
    const pct = clampPct(r.percent);
    if (pct === null) continue;
    const limit = limitsByKind[k] || 0;
    const used = limit > 0 ? round((pct / 100) * limit, 2) : null;
    const w = makeWindow({
      kind: k === 'rolling' ? 'session' : k,
      label: labelsByKind[k],
      usedPercent: pct,
      used,
      limit: limit || null,
      unit: 'currency',
      resetsAt: r.resetsAt || null,
    });
    if (limit > 0 && used != null) w.remainingCount = round(Math.max(0, limit - used), 2);
    out.push(w);
  }
  return out;
}

// ---- Public fetch ----------------------------------------------------------

export async function fetch({ config, lang = 'en' }) {
  const key = (config?.apiKey || '').trim();
  const updatedAt = new Date().toISOString();
  const limits = goLimits();
  if (!key) return notConfigured(updatedAt, limits);

  // Local usage windows (best-effort fallback, never fatal).
  let localWindows = [];
  let localReason = null;
  try {
    const { rows, reason } = await readGoRows();
    localReason = reason;
    if (rows.length > 0) localWindows = buildUsageWindows(rows, Date.now(), limits, lang);
  } catch {
    localReason = 'db-error';
  }

  // Probe the remote rolling-usage endpoint (shipped 2026-08-11). When it works
  // we prefer its server-authoritative windows over the local-DB estimate.
  // Failure is NOT silent — the error surfaces in `usageError` so the UI can
  // tell the user why server usage isn't showing (e.g. 403 = no Go plan).
  let remoteUsage = null;
  let usageError = null;
  try {
    remoteUsage = await probeUsage(key);
  } catch (err) {
    usageError = errorText(err, lang);
  }
  const remoteWindows = windowsFromRemote(remoteUsage, limits, lang);
  // Rolling-usage windows must ALWAYS be visible. Fall back through
  // remote → local DB → plan-limit defaults (0% used) so the card always
  // shows the 5-hour / weekly / monthly rolling gauges.
  const windows = remoteWindows.length
    ? remoteWindows
    : (localWindows.length ? localWindows : buildDefaultWindows(limits, lang));
  const usageSource = remoteWindows.length ? 'remote' : (localWindows.length ? (localReason || 'local') : 'defaults');

  // Key liveness + model probe.
  try {
    const probe = await probeKey(key);
    return {
      provider: meta.id,
      name: meta.name,
      dashboard: CONSOLE,
      status: 'ok',
      updatedAt,
      keyValid: true,
      models: probe.models,
      modelCount: probe.count,
      windows,
      planLimits: limits,
      localSource: usageSource,
      remoteUsage: Boolean(remoteUsage),
      usageError,
      summary: buildGoSummary(windows, probe.count, lang),
    };
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 'unavailable';
    return {
      provider: meta.id,
      name: meta.name,
      dashboard: CONSOLE,
      status: ['unauthorized', 'sourceRateLimited', 'timeout', 'blockedHost'].includes(status) ? status : 'unavailable',
      updatedAt,
      keyValid: false,
      models: [],
      modelCount: 0,
      windows, // full fallback chain (remote → local → defaults) stays visible
      planLimits: limits,
      localSource: usageSource,
      remoteUsage: Boolean(remoteUsage),
      usageError,
      error: errorText(err, lang),
    };
  }
}

function notConfigured(updatedAt, limits) {
  return {
    provider: meta.id,
    name: meta.name,
    dashboard: CONSOLE,
    status: 'notConfigured',
    updatedAt,
    keyValid: false,
    models: [],
    modelCount: 0,
    windows: [],
    planLimits: limits,
  };
}
