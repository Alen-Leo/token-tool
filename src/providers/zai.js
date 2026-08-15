// Provider: Z.ai / GLM (Coding Plan).
//
// Two endpoints, both authenticated with `Authorization: Bearer <key>`:
//   GET https://api.z.ai/api/monitor/usage/quota/limit     — usage windows
//   GET https://api.z.ai/api/biz/subscription/list         — plan + renewal
//
// Region `bigmodel-cn` (China) uses https://open.bigmodel.cn instead.
//
// The quota response (data.limits[]) carries TOKENS_LIMIT rows (a 5-hour
// "session" bucket and a weekly bucket) and a TIME_LIMIT row (a monthly/MCP
// bucket). Each row reports usage/remaining or a percentage plus a reset time.
//
// Parsing follows the reference implementation (Javis603/token-monitor) but is
// self-contained: no imports from that project.

import { getJson, withDeadline, HttpError } from '../util/http.js';
import { toNum, clampPct, toIso, makeWindow, relativeFromNow } from '../util/format.js';
import { tr, errorText } from '../i18n.js';

const REGIONS = {
  global: {
    baseUrl: 'https://api.z.ai',
    dashboard: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan',
  },
  'bigmodel-cn': {
    baseUrl: 'https://open.bigmodel.cn',
    dashboard: 'https://bigmodel.cn/coding-plan/personal/usage',
  },
};
const QUOTA_PATH = '/api/monitor/usage/quota/limit';
const SUBSCRIPTION_PATH = '/api/biz/subscription/list';
const FETCH_TIMEOUT_MS = 12_000;

export const meta = {
  id: 'zai',
  name: 'Z.ai / GLM',
  description: 'Coding Plan quota (5-hour / weekly / monthly windows) and plan name.',
  doc: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan',
  configFields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, env: ['ZAI_API_KEY', 'GLM_API_KEY', 'ZHIPU_API_KEY'] },
    { key: 'region', label: 'Region', type: 'select', options: ['global', 'bigmodel-cn'], default: 'global' },
  ],
  offers: ['plan', 'usageWindows'],
};

function regionOf(config) {
  const r = String(config?.region || 'global').toLowerCase();
  if (r === 'bigmodel-cn' || r === 'cn' || r === 'china' || r === 'bigmodel') return 'bigmodel-cn';
  return 'global';
}

// window unit/number → minutes. unit 5=min, 3=hour, 1=day, 6=week.
function windowMinutes(unit, number) {
  const u = toNum(unit);
  const n = toNum(number);
  if (u === null || n === null || n <= 0) return null;
  if (u === 5) return n;
  if (u === 3) return n * 60;
  if (u === 1) return n * 1440;
  if (u === 6) return n * 10080;
  return null;
}

function usedPercent(limit) {
  const total = toNum(limit?.usage ?? limit?.total);
  const remaining = toNum(limit?.remaining);
  const current = toNum(limit?.currentValue ?? limit?.current_value);
  if (total !== null && total > 0) {
    let usedRaw = null;
    if (remaining !== null) {
      const fromRemaining = total - remaining;
      usedRaw = current === null ? fromRemaining : Math.max(fromRemaining, current);
    } else if (current !== null) {
      usedRaw = current;
    }
    if (usedRaw !== null) {
      const used = Math.max(0, Math.min(total, usedRaw));
      return clampPct((used / total) * 100);
    }
  }
  return clampPct(limit?.percentage ?? limit?.usedPercent ?? limit?.used_percent);
}

function firstSubscription(body) {
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.find((r) => r && typeof r === 'object') || null;
}

function textField(src, fields) {
  if (!src || typeof src !== 'object') return '';
  for (const f of fields) {
    const v = String(src[f] || '').trim();
    if (v) return prettyPlan(v);
  }
  return '';
}

function prettyPlan(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bglm\b/gi, 'GLM')
    .replace(/\bz\.?ai\b/gi, 'Z.ai')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bZ\.Ai\b/g, 'Z.ai');
}

function planFrom(quotaBody, subscriptionBody) {
  const sub = firstSubscription(subscriptionBody);
  return (
    textField(sub, ['product_name', 'productName', 'plan_name', 'planName', 'package_name', 'packageName', 'plan', 'plan_type', 'planType', 'level']) ||
    textField(quotaBody?.data, ['planName', 'plan_name', 'packageName', 'package_name', 'plan', 'plan_type', 'planType', 'level'])
  );
}

function subscriptionResetAt(body) {
  const sub = firstSubscription(body);
  return toIso(sub?.next_renew_time ?? sub?.nextRenewTime);
}

function isSessionTokenLimit(limit) {
  const m = windowMinutes(limit?.unit, limit?.number);
  return m !== null && m <= 360; // ≤ 6h → session bucket
}

export function parseUsage(quotaBody, subscriptionBody, lang = 'en') {
  const plan = planFrom(quotaBody, subscriptionBody);
  const resetAt = subscriptionResetAt(subscriptionBody);
  const limits = Array.isArray(quotaBody?.data?.limits) ? quotaBody.data.limits : [];
  const tokenLimits = [];
  let timeLimit = null;

  for (const limit of limits) {
    if (!limit || typeof limit !== 'object') continue;
    const type = String(limit.type || limit.limit_type || '').trim().toUpperCase();
    if (type === 'TOKENS_LIMIT' && usedPercent(limit) !== null) tokenLimits.push(limit);
    else if (type === 'TIME_LIMIT' && usedPercent(limit) !== null) timeLimit = limit;
  }

  tokenLimits.sort((a, b) => (windowMinutes(a.unit, a.number) ?? Infinity) - (windowMinutes(b.unit, b.number) ?? Infinity));
  const onlyToken = tokenLimits[0] || null;
  const session = tokenLimits.length >= 2 ? tokenLimits[0] : isSessionTokenLimit(onlyToken) ? onlyToken : null;
  const weekly = tokenLimits.length >= 2 ? tokenLimits[tokenLimits.length - 1] : session ? null : onlyToken;

  const windows = [];
  if (session) windows.push(buildWindow(session, 'session', tr(lang, 'window.5hour')));
  if (weekly) windows.push(buildWindow(weekly, 'weekly', tr(lang, 'window.weekly')));
  if (timeLimit) {
    // 'MCP' is a platform label — kept as-is in every language.
    const w = buildWindow(timeLimit, 'monthly', 'MCP', { fallbackResetAt: resetAt, monthly: true });
    if (w) windows.push(w);
  }
  return { plan, renewsAt: resetAt, windows };
}

function buildWindow(limit, kind, label, { fallbackResetAt = null, monthly = false } = {}) {
  const pct = usedPercent(limit);
  if (pct === null) return null;
  const resetsAt = toIso(limit.nextResetTime ?? limit.next_reset_time) || fallbackResetAt;
  const total = toNum(limit?.usage ?? limit?.total);
  const remaining = toNum(limit?.remaining);
  const used = total !== null && remaining !== null ? Math.max(0, total - remaining) : null;
  const w = makeWindow({
    kind,
    label,
    usedPercent: pct,
    used,
    limit: total,
    unit: 'tokens',
    resetsAt,
    resetDescription: monthly ? 'Monthly' : null,
  });
  // Carry the absolute remaining token count for richer display — the UI shows
  // "10% · used 10,000 / 100,000 · remaining 90,000" for Z.ai windows.
  w.remainingCount = remaining;
  return w;
}

// One-line human summary, e.g. "GLM Coding Pro · session 10% · renews in 20d".
function buildSummary({ plan, windows, renewsAt }, lang) {
  const parts = [];
  if (plan) parts.push(plan);
  const session = windows.find((w) => w.kind === 'session');
  if (session && session.usedPercent != null) parts.push(tr(lang, 'summary.session', Math.round(session.usedPercent)));
  if (renewsAt) {
    const rel = relativeFromNow(renewsAt, Date.now(), lang);
    if (rel) parts.push(tr(lang, 'summary.renews', rel));
  }
  return parts.length ? parts.join(' · ') : null;
}

export async function fetch({ config, lang = 'en' }) {
  const region = regionOf(config);
  const base = REGIONS[region].baseUrl;
  const dashboard = REGIONS[region].dashboard;
  const key = (config?.apiKey || '').trim();
  const updatedAt = new Date().toISOString();

  if (!key) return notConfigured(updatedAt, region, dashboard);

  const headers = { Authorization: `Bearer ${key}` };
  try {
    const [quota, subscription] = await Promise.allSettled([
      withDeadline((signal) => getJson(`${base}${QUOTA_PATH}`, { headers, signal, timeoutMs: FETCH_TIMEOUT_MS }), { deadlineMs: FETCH_TIMEOUT_MS }),
      withDeadline((signal) => getJson(`${base}${SUBSCRIPTION_PATH}`, { headers, signal, timeoutMs: FETCH_TIMEOUT_MS }), { deadlineMs: FETCH_TIMEOUT_MS }),
    ]);
    if (quota.status === 'rejected') throw quota.reason;
    const sub = subscription.status === 'fulfilled' ? subscription.value : null;
    const usage = parseUsage(quota.value, sub, lang);
    return {
      provider: meta.id,
      name: meta.name,
      region,
      dashboard,
      status: usage.windows.length ? 'ok' : 'unavailable',
      updatedAt,
      plan: usage.plan || null,
      renewsAt: usage.renewsAt || null,
      windows: usage.windows,
      summary: buildSummary(usage, lang),
    };
  } catch (err) {
    return errorResult(updatedAt, region, dashboard, err, lang);
  }
}

function notConfigured(updatedAt, region, dashboard) {
  return {
    provider: meta.id,
    name: meta.name,
    region,
    dashboard,
    status: 'notConfigured',
    updatedAt,
    plan: null,
    renewsAt: null,
    windows: [],
  };
}

function errorResult(updatedAt, region, dashboard, err, lang = 'en') {
  const status = err instanceof HttpError ? err.status : 'unavailable';
  return {
    provider: meta.id,
    name: meta.name,
    region,
    dashboard,
    status: ['unauthorized', 'sourceRateLimited', 'timeout', 'blockedHost'].includes(status) ? status : 'unavailable',
    updatedAt,
    plan: null,
    renewsAt: null,
    windows: [],
    error: errorText(err, lang),
  };
}
