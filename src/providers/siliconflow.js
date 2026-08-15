// Provider: SiliconFlow / 硅基流动 (account balance, CNY).
//
//   GET https://api.siliconflow.cn/v1/user/info
//   Authorization: Bearer <api key>
//
// Response (official OpenAPI spec):
//   { "code": 20000, "message": "OK", "status": true,
//     "data": { "balance": "0.88", "chargeBalance": "88.00", "totalBalance": "88.88", … } }
//
// All balance fields are STRINGS — parsed with parseFloat. totalBalance is the
// headline available balance; chargeBalance is paid-in, balance is promotional.

import { getJson, withDeadline, HttpError } from '../util/http.js';
import { toNum, round } from '../util/format.js';
import { tr, errorText } from '../i18n.js';

const BASE = 'https://api.siliconflow.cn';
const PATH = '/v1/user/info';
const DASHBOARD = 'https://cloud.siliconflow.cn/account';
const FETCH_TIMEOUT_MS = 12_000;

export const meta = {
  id: 'siliconflow',
  name: 'SiliconFlow',
  description: 'Account balance (total / paid-in / promotional) in CNY.',
  doc: 'https://docs.siliconflow.cn/',
  configFields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, env: ['SILICONFLOW_API_KEY'] },
  ],
  offers: ['balance'],
};

export function parseBalance(body, lang = 'en') {
  const data = body?.data && typeof body.data === 'object' ? body.data : {};
  const total = toNum(data.totalBalance ?? data.total_balance);
  if (total === null) return { balances: [], isAvailable: true };
  const charge = toNum(data.chargeBalance ?? data.charge_balance);
  const promo = toNum(data.balance);
  const parts = [];
  if (charge != null) parts.push({ label: tr(lang, 'parts.paidIn'), value: round(charge, 4) });
  if (promo != null) parts.push({ label: tr(lang, 'parts.promotional'), value: round(promo, 4) });
  // The total IS the headline number — not repeated as a part row.
  const status = String(body?.status);
  // status is a boolean in the spec; treat explicit false as an error envelope.
  const isAvailable = status !== 'false';
  return {
    isAvailable,
    balances: [
      {
        currency: 'CNY',
        total: round(total, 4),
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
    const parsed = parseBalance(body, lang);
    const primary = parsed.balances[0] || null;
    return {
      provider: meta.id,
      name: meta.name,
      dashboard: DASHBOARD,
      currency: 'CNY',
      status: parsed.balances.length ? 'ok' : 'unavailable',
      updatedAt,
      isAvailable: parsed.isAvailable,
      balances: parsed.balances,
      windows: [],
      summary: primary
        ? `${tr(lang, 'summary.balanceCNY', round(primary.total, 2).toFixed(2))}${parsed.isAvailable ? '' : tr(lang, 'summary.issue')}`
        : tr(lang, 'summary.noBalance'),
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
    currency: 'CNY',
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
    currency: 'CNY',
    status: ['unauthorized', 'sourceRateLimited', 'timeout', 'blockedHost'].includes(status) ? status : 'unavailable',
    updatedAt,
    balances: [],
    windows: [],
    error: errorText(err, lang),
  };
}
