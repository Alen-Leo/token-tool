// Provider: DeepSeek.
//
// Two data paths:
//
//   1. API key (optional) — prepaid balance:
//        GET https://api.deepseek.com/user/balance
//        Authorization: Bearer <api key>
//      {
//        "is_available": true,
//        "balance_infos": [
//          { "currency": "CNY", "total_balance": "10.00",
//            "granted_balance": "10.00", "topped_up_balance": "0.00" }
//        ]
//      }
//
//   2. Web session token (optional) — the same data the official usage board
//      (platform.deepseek.com/usage) renders, via the console's own endpoints:
//        GET /api/v0/users/get_user_summary          wallets + all-time spend
//        GET /api/v0/usage/by_api_key/cost           spend by model/key/day
//        GET /api/v0/usage/by_api_key/amount         tokens & requests
//      All three take `Authorization: Bearer <webToken>`. The usage endpoints
//      require `start`/`end`/`tz` (epoch seconds) where start/end are day
//      boundaries in the tz (truncated to whole hours), end is exclusive, and
//      the span is at most 30 days — otherwise the API answers INVALID_PARAM
//      on HTTP 200. (Contract verified against the console bundle + live API.)
//
// DeepSeek has no quota windows; the meaningful figures are the prepaid balance
// and the spend breakdown above. Optional local spend tracking (API-key mode)
// is handled by the app shell observing balance drawdown.

import { getJson, withDeadline, HttpError } from '../util/http.js';
import { toNum, round } from '../util/format.js';
import { trackBalance } from '../util/spend-tracker.js';
import { tr, errorText } from '../i18n.js';

const BASE = 'https://api.deepseek.com';
const PATH = '/user/balance';
const WEB_BASE = 'https://platform.deepseek.com';
const SUMMARY_PATH = '/api/v0/users/get_user_summary';
const USAGE_COST_PATH = '/api/v0/usage/by_api_key/cost';
const USAGE_AMOUNT_PATH = '/api/v0/usage/by_api_key/amount';
const FETCH_TIMEOUT_MS = 12_000;
const MAX_USAGE_RANGE_SEC = 30 * 86_400; // usage endpoints reject spans > 30 days

export const meta = {
  id: 'deepseek',
  name: 'DeepSeek',
  description: 'Balance + usage board (today/month spend, per-model breakdown). Web token optional.',
  doc: 'https://platform.deepseek.com/usage',
  configFields: [
    { key: 'apiKey', label: 'API Key', type: 'password', required: false, env: ['DEEPSEEK_API_KEY'] },
    { key: 'webToken', label: 'Web Token', type: 'password', required: false, env: ['DEEPSEEK_WEB_TOKEN'],
      hint: '可选。点击"授权登录"一键获取，或手动粘贴 platform.deepseek.com 的 userToken。' },
  ],
  offers: ['balance', 'usage'],
};

export function parseBalances(body) {
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const balances = infos
    .map((info) => {
      const total = toNum(info?.total_balance);
      if (total === null) return null;
      return {
        currency: String(info?.currency || 'CNY').toUpperCase(),
        total,
        granted: toNum(info?.granted_balance),
        toppedUp: toNum(info?.topped_up_balance),
      };
    })
    .filter(Boolean);
  return {
    isAvailable: Boolean(body?.is_available),
    balances,
  };
}

// DeepSeek's console API reports business errors on HTTP 200 in two layers:
// a top-level `code` (40003 = invalid/expired session token) and, on the usage
// endpoints, a nested `data.biz_code` (1 = INVALID_PARAM). Throw so fetch()
// can surface why.
function ensureOk(body, layer) {
  if (!body || typeof body !== 'object') return null;
  if (body.code != null && Number(body.code) !== 0) {
    const e = new Error(body.msg || `web session error (${body.code})`);
    e.code = body.code;
    throw e;
  }
  const data = body.data;
  if (!data || typeof data !== 'object') return null;
  if (data.biz_code != null && Number(data.biz_code) !== 0) {
    throw new Error(`${layer} rejected: ${data.biz_msg || data.biz_code}`);
  }
  return data.biz_data && typeof data.biz_data === 'object' ? data.biz_data : null;
}

// Parse the web-console get_user_summary response (session-token auth).
// Real response (verified live): { code, msg, data: { biz_data: {
//   normal_wallets: [ { currency, balance, token_estimation } ],
//   bonus_wallets:  [ ... ],
//   total_costs:    [ { currency, amount } ] } } }
// (The wallet fields have been observed as both arrays and index-keyed objects;
// Object.values covers both.) There is no monthly/token field in the real API —
// those figures come from the usage endpoints below.
export function parseWebSummary(body) {
  const biz = ensureOk(body, 'summary');
  if (!biz) return null;

  // Wallets: arrays live, index-keyed objects tolerated. Flatten them.
  const walletEntries = (src, bonus) => Object.values(src || {}).map((w) => ({ ...w, bonus }));
  const wallets = [...walletEntries(biz.normal_wallets, false), ...walletEntries(biz.bonus_wallets, true)]
    .map((w) => {
      const bal = toNum(w.balance);
      const cur = String(w.currency || 'USD').toUpperCase();
      const est = toNum(w.token_estimation);
      if (bal === null) return null;
      return { currency: cur, balance: bal, tokenEstimate: est, bonus: Boolean(w.bonus) };
    })
    .filter(Boolean);

  // total_costs: sum per currency for cumulative spend.
  const costMap = new Map();
  for (const c of Object.values(biz.total_costs || {})) {
    const amt = toNum(c?.amount);
    const cur = String(c?.currency || 'USD').toUpperCase();
    if (amt === null) continue;
    costMap.set(cur, (costMap.get(cur) || 0) + amt);
  }
  const totalCosts = [...costMap.entries()].map(([currency, amount]) => ({ currency, amount: round(amount, 4) }));

  // Total spend = sum of all cost currencies (the primary is the largest).
  const totalUsage = totalCosts.length ? Math.max(...totalCosts.map((c) => c.amount)) : null;
  const primaryCurrency = totalCosts.length ? totalCosts[0].currency : null;
  // Token estimate for what the balance buys (may be 0/absent — not reliable).
  const tokenEstimate = wallets.reduce((acc, w) => acc + (toNum(w.tokenEstimate) || 0), 0) || null;

  return {
    totalUsage,
    monthlyUsage: null, // get_user_summary does not return a monthly figure
    currentToken: null, // nor an aggregate token-consumption number
    tokenEstimate,
    wallets,
    totalCosts,
    currency: primaryCurrency,
  };
}

// Time range for the usage query. Mirrors the console client's tz rules: the
// device timezone is truncated to whole hours, start/end are day boundaries in
// that truncated tz, end is exclusive (start of tomorrow). The window is a
// rolling 30 days — the API's maximum span.
export function buildUsageRange(nowMs = Date.now(), tzSec = -new Date(nowMs).getTimezoneOffset() * 60) {
  const tz = 3600 * Math.floor(tzSec / 3600);
  const local = new Date(nowMs + tz * 1000);
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();
  const dayStart = (yy, mm, dd) => Date.UTC(yy, mm, dd) / 1000 - tz;
  const todayStart = dayStart(y, mo, d);
  const end = dayStart(y, mo, d + 1); // Date.UTC rolls day overflow into the next month
  const start = end - MAX_USAGE_RANGE_SEC;
  return { start, end, tz, todayStart };
}

// Aggregate the usage-board responses into the 30-day window view:
//   cost body   → data: [ { currency, series: [ { api_key, model,
//                  buckets: [ { time, cost } ] } ] } ]
//   amount body → series: [ { api_key, model, buckets: [ { time, usage: {
//                  REQUEST, PROMPT_CACHE_HIT_TOKEN, PROMPT_CACHE_MISS_TOKEN,
//                  RESPONSE_TOKEN } } ] } ]
// Buckets are keyed by day (`time` = local day start, matching todayStart).
// The cost body feeds only the money totals; the amount body feeds token
// totals plus the per-model TODAY token breakdown. Series carry an `api_key`
// object which we ignore. Costs are aggregated in the first currency group —
// accounts are single-currency (the console shows a currency picker for the
// same reason).
export function parseWebUsage(costBody, amountBody, { todayStart = null } = {}) {
  const cost = ensureOk(costBody, 'usage query');
  const amount = ensureOk(amountBody, 'usage query');
  if (!cost && !amount) return null;

  const models = new Map();
  const totals = { requests: 0, inputTokens: 0, cacheHitTokens: 0, outputTokens: 0, todayRequests: 0 };

  const model_ = (name) => {
    let m = models.get(name);
    if (!m) {
      m = { model: name, todayInputTokens: 0, todayCacheHitTokens: 0, todayOutputTokens: 0 };
      models.set(name, m);
    }
    return m;
  };

  let currency = null;
  let last30Cost = 0;
  let todayCost = 0;
  if (cost) {
    const groups = Array.isArray(cost.data) ? cost.data : [];
    currency = groups[0]?.currency ? String(groups[0].currency).toUpperCase() : null;
    for (const g of groups) {
      if (currency && String(g?.currency || '').toUpperCase() !== currency) continue; // single-currency accounts
      for (const se of g?.series || []) {
        for (const b of se?.buckets || []) {
          const c = toNum(b?.cost) || 0;
          last30Cost += c;
          if (todayStart != null && b.time === todayStart) todayCost += c;
        }
      }
    }
  }

  if (amount) {
    for (const se of amount?.series || []) {
      const m = model_(String(se?.model || 'unknown'));
      for (const b of se?.buckets || []) {
        const u = b?.usage || {};
        const req = toNum(u.REQUEST) || 0;
        const inTok = toNum(u.PROMPT_CACHE_MISS_TOKEN) || 0;
        const hit = toNum(u.PROMPT_CACHE_HIT_TOKEN) || 0;
        const out = toNum(u.RESPONSE_TOKEN) || 0;
        totals.requests += req; totals.inputTokens += inTok; totals.cacheHitTokens += hit; totals.outputTokens += out;
        if (todayStart != null && b.time === todayStart) {
          totals.todayRequests += req;
          m.todayInputTokens += inTok;
          m.todayCacheHitTokens += hit;
          m.todayOutputTokens += out;
        }
      }
    }
  }

  const todayTotal = (m) => m.todayInputTokens + m.todayCacheHitTokens + m.todayOutputTokens;
  return {
    currency,
    last30Cost: round(last30Cost, 4),
    todayCost: round(todayCost, 4),
    ...totals,
    models: [...models.values()]
      .filter((m) => todayTotal(m) > 0)
      .sort((a, b) => todayTotal(b) - todayTotal(a)),
  };
}

function classifyWebError(err, lang) {
  if (err instanceof HttpError) {
    return { message: errorText(err, lang), status: err.status };
  }
  // Business error envelope from DeepSeek (HTTP 200, code != 0) — these are
  // auth/session rejections, so show the translated status instead of the raw
  // English platform message.
  return {
    message: err?.code ? tr(lang, 'status.unauthorized') : String(err?.message || tr(lang, 'error.requestFailed')),
    status: err?.code ? 'unauthorized' : 'unavailable',
  };
}

export async function fetch({ config, lang = 'en' }) {
  const key = (config?.apiKey || '').trim();
  const webToken = (config?.webToken || '').trim();
  const updatedAt = new Date().toISOString();
  if (!key && !webToken) return notConfigured(updatedAt);

  // --- API-key balance path (always when a key is present) -----------------
  let balances = [];
  let spend = null;
  let apiError = null;
  let apiStatus = null;
  if (key) {
    try {
      const body = await withDeadline(
        (signal) => getJson(`${BASE}${PATH}`, { headers: { Authorization: `Bearer ${key}` }, signal, timeoutMs: FETCH_TIMEOUT_MS }),
        { deadlineMs: FETCH_TIMEOUT_MS },
      );
      const parsed = parseBalances(body);
      balances = parsed.balances;
      const primary = balances[0] || null;
      // Track spend only on real queries — the /api/test route passes
      // skipSpendTrack so a Test (which may use a different account's key)
      // never mutates the persisted spend baseline. Spend is scoped per
      // account so two DeepSeek keys keep independent baselines.
      if (primary && primary.toppedUp != null && !config?.skipSpendTrack) {
        spend = trackBalance(`${meta.id}:${config?.accountId || 'default'}`, primary.currency, primary.toppedUp);
      }
    } catch (err) {
      apiError = errorText(err, lang);
      apiStatus = err instanceof HttpError ? err.status : 'unavailable';
    }
  }

  // --- Web-session-token path (when a web token is present) ----------------
  // Summary (wallets + all-time spend) and the usage board (month breakdown)
  // run in parallel — same wall-clock cost as the old single summary call.
  // A business error (code 40003 etc., HTTP 200) throws from the parsers and
  // lands in webError so the UI can say why usage isn't showing.
  let webUsage = null;
  let webError = null;
  let webStatus = null;
  let usageDetail = null;
  let usageError = null;
  if (webToken) {
    const range = buildUsageRange();
    const auth = { Authorization: `Bearer ${webToken}` };
    const call = (path, qs = '') =>
      withDeadline(
        (signal) => getJson(`${WEB_BASE}${path}${qs}`, { headers: auth, signal, timeoutMs: FETCH_TIMEOUT_MS }),
        { deadlineMs: FETCH_TIMEOUT_MS },
      );
    const usageQs = `?start=${range.start}&end=${range.end}&tz=${range.tz}`;
    const [sumR, costR, amountR] = await Promise.all([
      call(SUMMARY_PATH).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
      call(USAGE_COST_PATH, usageQs).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
      call(USAGE_AMOUNT_PATH, usageQs).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
    ]);

    if (sumR.ok) {
      try {
        webUsage = parseWebSummary(sumR.v);
        if (!webUsage) webError = 'unexpected response from DeepSeek usage API';
      } catch (err) {
        ({ message: webError, status: webStatus } = classifyWebError(err, lang));
      }
    } else {
      ({ message: webError, status: webStatus } = classifyWebError(sumR.e, lang));
    }

    // The usage pair is a supplement — a failure here degrades the card to
    // summary-only numbers instead of failing it. Both endpoints share the
    // token, so when the summary was rejected (expired token) don't pile a
    // second identical error on top.
    if (costR.ok) {
      try {
        usageDetail = parseWebUsage(costR.v, amountR.ok ? amountR.v : null, { todayStart: range.todayStart });
      } catch (err) {
        usageError = String(err?.message || err);
      }
      if (!usageError && !amountR.ok) {
        usageError = classifyWebError(amountR.e, lang).message;
      }
    } else if (!webError) {
      usageError = classifyWebError(costR.e, lang).message;
    }
  }

  // Determine overall status.
  const hasData = balances.length > 0 || webUsage || usageDetail;
  const notes = [];

  if (webUsage || usageDetail) {
    notes.push(tr(lang, 'note.usageViaWeb'));
    if (!balances.length && webUsage?.wallets.length) {
      // No API key — the main (non-bonus) web wallet carries the balance.
      const main = webUsage.wallets.find((w) => !w.bonus) || webUsage.wallets[0];
      balances = [{ currency: main.currency, total: main.balance }];
    }
    if (usageError) notes.push(tr(lang, 'note.usageFailed', usageError));
    // Summary rejected while the usage pair still answered (rare — e.g. the
    // summary endpoint alone failing): hint at re-auth when it was the token.
    if (webError && webStatus === 'unauthorized') notes.push(tr(lang, 'note.webRejected', webError));
  } else if (webError) {
    // A web token is configured but the usage API rejected it (expired /
    // invalid session). Surface the reason instead of silently showing only
    // the API-key balance. webError itself is a platform/HTTP message — kept
    // verbatim.
    notes.push(tr(lang, 'note.webRejected', webError));
  } else if (balances.length > 0) {
    notes.push(tr(lang, 'note.webNotSet'));
  }

  if (apiError && !hasData) {
    // Both paths failed and no data at all.
    const status = apiStatus === 'unauthorized' ? 'unauthorized' : 'unavailable';
    return {
      provider: meta.id,
      name: meta.name,
      dashboard: 'https://platform.deepseek.com/usage',
      status,
      updatedAt,
      balances: [],
      windows: [],
      error: apiError,
    };
  }

  if (!hasData && webError) {
    return {
      provider: meta.id,
      name: meta.name,
      dashboard: 'https://platform.deepseek.com/usage',
      status: webStatus === 'unauthorized' ? 'unauthorized' : 'unavailable',
      updatedAt,
      balances: [],
      windows: [],
      error: webError,
    };
  }

  // Money rows live inside the balance block (no separate box): today +
  // last-30-days from the usage board, or today from the local tracker. The
  // balance composition (topped-up / granted) is deliberately not shown.
  const spendRows = [];
  if (usageDetail) {
    const cur = usageDetail.currency || 'USD';
    if (usageDetail.todayCost != null) spendRows.push({ label: tr(lang, 'parts.today'), value: round(usageDetail.todayCost, 2), currency: cur });
    if (usageDetail.last30Cost != null) spendRows.push({ label: tr(lang, 'parts.last30d'), value: round(usageDetail.last30Cost, 2), currency: cur });
  } else if (spend?.tracked) {
    spendRows.push({ label: tr(lang, 'parts.today'), value: round(spend.todaySpend, 2), currency: spend.currency });
  }
  if (balances.length && spendRows.length) balances[0].parts = spendRows;

  // The balance block below carries the figures — no summary line duplicating
  // it. summary remains only as a fallback when no balance block can render.
  let summary = null;
  if (!balances.length) {
    summary = usageDetail?.todayCost != null
      ? tr(lang, 'summary.todaySpend', round(usageDetail.todayCost, 2).toFixed(2), usageDetail.currency || 'USD')
      : tr(lang, 'summary.noBalance');
  }

  return {
    provider: meta.id,
    name: meta.name,
    dashboard: 'https://platform.deepseek.com/usage',
    status: hasData ? 'ok' : 'unavailable',
    updatedAt,
    balances,
    usageDetail: usageDetail || null,
    webError: webError || null,
    windows: [],
    note: notes.length ? notes.join(' ') : null,
    summary,
  };
}

function notConfigured(updatedAt) {
  return {
    provider: meta.id,
    name: meta.name,
    dashboard: 'https://platform.deepseek.com/usage',
    status: 'notConfigured',
    updatedAt,
    balances: [],
    windows: [],
  };
}
