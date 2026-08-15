// Provider: Moonshot / 月之暗面 / Kimi (account balance, CNY).
//
//   GET https://api.moonshot.cn/v1/users/me/balance   (China)
//   GET https://api.kimi.ai/v1/users/me/balance       (international)
//   Authorization: Bearer <api key>
//
// Response (official Kimi platform docs):
//   { "code": 0, "scode": "0x0", "status": true,
//     "data": { "available_balance": 49.59, "voucher_balance": 46.59, "cash_balance": 3.00 } }
//
// available_balance (cash + voucher) is the headline; if it drops to/below 0 the
// account can no longer call inference. voucher_balance is promotional credit,
// cash_balance may go negative (arrears).

import { getJson, withDeadline, HttpError } from '../util/http.js';
import { toNum, round } from '../util/format.js';
import { tr, errorText } from '../i18n.js';

const REGIONS = {
  global: {
    baseUrl: 'https://api.kimi.ai',
    dashboard: 'https://kimi.ai/account',
  },
  'moonshot-cn': {
    baseUrl: 'https://api.moonshot.cn',
    dashboard: 'https://platform.moonshot.cn/console/account',
  },
};
const PATH = '/v1/users/me/balance';
const FETCH_TIMEOUT_MS = 12_000;

export const meta = {
  id: 'moonshot',
  name: 'Moonshot / Kimi',
  description: 'Account balance (available / cash / voucher) in CNY.',
  doc: 'https://platform.moonshot.cn/docs/api/balance',
  configFields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: true, env: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
    { key: 'region', label: 'Region', type: 'select', options: ['moonshot-cn', 'global'], default: 'moonshot-cn' },
  ],
  offers: ['balance'],
};

function regionOf(config) {
  const r = String(config?.region || 'moonshot-cn').toLowerCase();
  if (r === 'global' || r === 'kimi' || r === 'intl') return 'global';
  return 'moonshot-cn';
}

export function parseBalance(body, lang = 'en') {
  const data = body?.data && typeof body.data === 'object' ? body.data : {};
  const available = toNum(data.available_balance ?? data.availableBalance);
  if (available === null) return { balances: [], isAvailable: true };
  const cash = toNum(data.cash_balance ?? data.cashBalance);
  const voucher = toNum(data.voucher_balance ?? data.voucherBalance);
  const parts = [];
  if (cash != null) parts.push({ label: tr(lang, 'parts.cash'), value: round(cash, 4) });
  if (voucher != null) parts.push({ label: tr(lang, 'parts.voucher'), value: round(voucher, 4) });
  parts.push({ label: tr(lang, 'parts.available'), value: round(available, 4) });
  return {
    isAvailable: available > 0,
    balances: [
      {
        currency: 'CNY',
        total: round(available, 4),
        parts,
      },
    ],
  };
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
    const body = await withDeadline(
      (signal) => getJson(`${base}${PATH}`, { headers, signal, timeoutMs: FETCH_TIMEOUT_MS }),
      { deadlineMs: FETCH_TIMEOUT_MS },
    );
    const parsed = parseBalance(body, lang);
    const primary = parsed.balances[0] || null;
    return {
      provider: meta.id,
      name: meta.name,
      region,
      dashboard,
      currency: 'CNY',
      status: parsed.balances.length ? 'ok' : 'unavailable',
      updatedAt,
      isAvailable: parsed.isAvailable,
      balances: parsed.balances,
      windows: [],
      summary: primary
        ? `${tr(lang, 'summary.balanceCNY', round(primary.total, 2).toFixed(2))}${parsed.isAvailable ? '' : tr(lang, 'summary.insufficient')}`
        : tr(lang, 'summary.noBalance'),
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
    currency: 'CNY',
    status: 'notConfigured',
    updatedAt,
    balances: [],
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
    currency: 'CNY',
    status: ['unauthorized', 'sourceRateLimited', 'timeout', 'blockedHost'].includes(status) ? status : 'unavailable',
    updatedAt,
    balances: [],
    windows: [],
    error: errorText(err, lang),
  };
}
