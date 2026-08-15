// Provider: OpenRouter (account credits, USD).
//
//   GET https://openrouter.ai/api/v1/credits
//   Authorization: Bearer <api key>      (keys look like sk-or-v1-…)
//
// Response (official docs: openrouter.ai/docs/api-reference/get-credits):
//   { "data": { "total_credits": 100.5, "total_usage": 25.75 } }
//
// OpenRouter credits are denominated in USD. Remaining = total_credits −
// total_usage. We surface the headline remaining plus a purchased/used breakdown.

import { getJson, withDeadline, HttpError } from '../util/http.js';
import { toNum, round } from '../util/format.js';
import { tr, errorText } from '../i18n.js';

const BASE = 'https://openrouter.ai';
const PATH = '/api/v1/credits';
const DASHBOARD = 'https://openrouter.ai/credits';
const FETCH_TIMEOUT_MS = 12_000;

export const meta = {
  id: 'openrouter',
  name: 'OpenRouter',
  description: 'Account credits (purchased / used / remaining) in USD.',
  doc: 'https://openrouter.ai/docs/api-reference/get-credits',
  configFields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, env: ['OPENROUTER_API_KEY'] },
  ],
  offers: ['balance'],
};

export function parseCredits(body, lang = 'en') {
  const data = body?.data && typeof body.data === 'object' ? body.data : {};
  const total = toNum(data.total_credits ?? data.totalCredits);
  const usage = toNum(data.total_usage ?? data.totalUsage);
  if (total === null) return { balances: [] };
  const remaining = round(Math.max(0, total - (usage ?? 0)), 4);
  const parts = [];
  if (usage != null) parts.push({ label: tr(lang, 'parts.purchased'), value: round(total, 4) });
  if (usage != null) parts.push({ label: tr(lang, 'parts.used'), value: round(usage, 4) });
  // Remaining IS the headline number — not repeated as a part row.
  return {
    balances: [
      {
        currency: 'USD',
        total: remaining, // headline = what's left to spend
        parts,
      },
    ],
  };
}

export async function fetch({ config, lang = 'en' }) {
  const key = (config?.apiKey || '').trim();
  const updatedAt = new Date().toISOString();
  if (!key) return notConfigured(updatedAt);

  const headers = { Authorization: `Bearer ${key}` };
  try {
    const body = await withDeadline(
      (signal) => getJson(`${BASE}${PATH}`, { headers, signal, timeoutMs: FETCH_TIMEOUT_MS }),
      { deadlineMs: FETCH_TIMEOUT_MS },
    );
    const parsed = parseCredits(body, lang);
    const primary = parsed.balances[0] || null;
    return {
      provider: meta.id,
      name: meta.name,
      dashboard: DASHBOARD,
      currency: 'USD',
      status: parsed.balances.length ? 'ok' : 'unavailable',
      updatedAt,
      balances: parsed.balances,
      windows: [],
      summary: primary ? tr(lang, 'summary.remaining', round(primary.total, 2).toFixed(2)) : tr(lang, 'summary.noCredits'),
    };
  } catch (err) {
    return errorResult(updatedAt, err, lang);
  }
}

function notConfigured(updatedAt) {
  return {
    provider: meta.id,
    name: meta.name,
    dashboard: DASHBOARD,
    currency: 'USD',
    status: 'notConfigured',
    updatedAt,
    balances: [],
    windows: [],
  };
}

function errorResult(updatedAt, err, lang = 'en') {
  const status = err instanceof HttpError ? err.status : 'unavailable';
  return {
    provider: meta.id,
    name: meta.name,
    dashboard: DASHBOARD,
    currency: 'USD',
    status: ['unauthorized', 'sourceRateLimited', 'timeout', 'blockedHost'].includes(status) ? status : 'unavailable',
    updatedAt,
    balances: [],
    windows: [],
    error: errorText(err, lang),
  };
}
