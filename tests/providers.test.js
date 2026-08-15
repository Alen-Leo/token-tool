import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage } from '../src/providers/zai.js';
import { parseBalances, parseWebSummary, parseWebUsage, buildUsageRange, meta as deepseekMeta } from '../src/providers/deepseek.js';
import { parseCredits } from '../src/providers/openrouter.js';
import { parseBalance as parseSiliconFlow } from '../src/providers/siliconflow.js';
import { parseBalance as parseMoonshot } from '../src/providers/moonshot.js';

// Sample quota payload modeled on the real Z.ai shape: a 5-hour TOKENS_LIMIT,
// a weekly TOKENS_LIMIT, and a monthly TIME_LIMIT.
const quota = {
  data: {
    limits: [
      // session: total 100000, used 10000 (remaining 90000) → 10%
      { type: 'TOKENS_LIMIT', usage: 100000, remaining: 90000, unit: 5, number: 300, nextResetTime: '2026-08-11T10:00:00.000Z' },
      // weekly: total 1000000, used 500000 (remaining 500000) → 50%
      { type: 'TOKENS_LIMIT', usage: 1000000, remaining: 500000, unit: 6, number: 1, nextResetTime: '2026-08-18T00:00:00.000Z' },
      // monthly (TIME_LIMIT): total 1000000, used 300000 (remaining 700000) → 30%
      { type: 'TIME_LIMIT', usage: 1000000, remaining: 700000, unit: 5, number: 1 },
    ],
  },
};

const subscription = {
  data: [
    { product_name: 'glm_coding_pro', next_renew_time: '2026-09-01T00:00:00.000Z' },
  ],
};

test('z.ai parseUsage builds session + weekly + monthly windows', () => {
  const { plan, renewsAt, windows } = parseUsage(quota, subscription);
  assert.equal(plan, 'GLM Coding Pro');
  assert.equal(renewsAt, '2026-09-01T00:00:00.000Z'); // next_renew_time
  const kinds = windows.map((w) => w.kind);
  assert.deepEqual(kinds.sort(), ['monthly', 'session', 'weekly']);
  const session = windows.find((w) => w.kind === 'session');
  assert.equal(session.usedPercent, 10); // 10000/100000
  assert.equal(session.label, '5-hour');
  assert.equal(session.unit, 'tokens'); // token counts, not currency
  assert.equal(session.used, 10000);
  assert.equal(session.limit, 100000);
  assert.equal(session.remainingCount, 90000); // remaining absolute tokens
  const weekly = windows.find((w) => w.kind === 'weekly');
  assert.equal(weekly.usedPercent, 50); // 500000/1000000
  assert.equal(weekly.unit, 'tokens');
  assert.equal(weekly.remainingCount, 500000);
  const monthly = windows.find((w) => w.kind === 'monthly');
  assert.equal(monthly.usedPercent, 30); // 300000/1000000
});

test('z.ai parseUsage is resilient without subscription', () => {
  const { windows } = parseUsage(quota, null);
  assert.ok(windows.length >= 2);
});

test('z.ai parseUsage handles empty quota', () => {
  const { windows } = parseUsage({ data: { limits: [] } }, null);
  assert.equal(windows.length, 0);
});

// Sample DeepSeek balance payload (official shape).
const ds = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '10.00', granted_balance: '10.00', topped_up_balance: '0.00' },
  ],
};

test('deepseek parseBalances extracts totals and parts', () => {
  const { isAvailable, balances } = parseBalances(ds);
  assert.equal(isAvailable, true);
  assert.equal(balances.length, 1);
  assert.equal(balances[0].currency, 'CNY');
  assert.equal(balances[0].total, 10);
  assert.equal(balances[0].granted, 10);
  assert.equal(balances[0].toppedUp, 0);
});

test('deepseek parseBalances tolerates missing block', () => {
  const { balances } = parseBalances({ is_available: false, balance_infos: [] });
  assert.equal(balances.length, 0);
});

test('deepseek parseBalances drops malformed entries', () => {
  const { balances } = parseBalances({ balance_infos: [{ currency: 'USD' }, { total_balance: '5.00', currency: 'USD' }] });
  assert.equal(balances.length, 1);
  assert.equal(balances[0].total, 5);
});

test('deepseek meta advertises only apiKey + webToken (no unused region field)', () => {
  // DeepSeek has no region handling in fetch(); a region selector would mislead
  // users. Lock the configFields down so it cannot regress.
  const keys = deepseekMeta.configFields.map((f) => f.key);
  assert.deepEqual(keys, ['apiKey', 'webToken']);
});

// ---- DeepSeek web summary (session-token auth) ------------------------------
// Shape matches the REAL live response (verified via curl): wallets and
// total_costs are OBJECTS keyed by index, not arrays; there is no
// total_usage/monthly_usage/current_token field in the actual API.
const webSummaryBody = {
  code: 0, msg: 'success', data: {
    biz_code: 0, biz_msg: '', biz_data: {
      normal_wallets: { 0: { balance: '8.00', currency: 'USD', token_estimation: '4000000' } },
      bonus_wallets: { 0: { balance: '2.00', currency: 'USD', token_estimation: '1000000' } },
      total_costs: { 0: { currency: 'USD', amount: '12.34' } },
    },
  },
};

test('deepseek parseWebSummary extracts spend + wallets from real response shape', () => {
  const w = parseWebSummary(webSummaryBody);
  assert.ok(w);
  assert.equal(w.totalUsage, 12.34); // summed from total_costs
  assert.equal(w.currency, 'USD');
  assert.equal(w.monthlyUsage, null); // field doesn't exist in the real API
  assert.equal(w.currentToken, null); // field doesn't exist in the real API
  assert.equal(w.tokenEstimate, 5000000); // 4M + 1M from both wallets
  assert.equal(w.wallets.length, 2);
  assert.equal(w.wallets[0].currency, 'USD');
  assert.equal(w.wallets[0].balance, 8);
  assert.equal(w.wallets[0].bonus, false);
  assert.equal(w.wallets[1].bonus, true);
  assert.equal(w.totalCosts[0].currency, 'USD');
  assert.equal(w.totalCosts[0].amount, 12.34);
});

test('deepseek parseWebSummary returns null for malformed body', () => {
  assert.equal(parseWebSummary(null), null);
  assert.equal(parseWebSummary({ data: {} }), null);
});

test('deepseek parseWebSummary exposes tokenEstimate (not tokenEstimation)', () => {
  // Regression: fetch() previously read webUsage.tokenEstimation (never written)
  // while parseWebSummary writes tokenEstimate — the "Est. remaining" row
  // rendered as "—". Verify the field name round-trips.
  const w = parseWebSummary(webSummaryBody);
  assert.equal(w.tokenEstimate, 5000000);
  assert.equal(w.tokenEstimation, undefined);
});

test('deepseek parseWebSummary throws on business error code (HTTP 200)', () => {
  // DeepSeek returns business errors as HTTP 200 with a non-zero code
  // (40003 = invalid/expired session token). Without this throw, fetch()
  // would silently show nothing for a stale web token.
  assert.throws(() => parseWebSummary({ code: 40003, msg: 'Authorization Failed (invalid token)' }));
  assert.throws(() => parseWebSummary({ code: 40002, msg: 'Missing Token' }));
  // code 0 = success, data present.
  const ok = parseWebSummary({ code: 0, msg: 'success', data: { biz_data: { total_costs: { 0: { currency: 'CNY', amount: '5.00' } } } } });
  assert.equal(ok.totalUsage, 5);
});

// ---- DeepSeek usage board (by_api_key/cost + /amount, session-token auth) ----
// Shapes match the REAL live responses: cost buckets carry string amounts,
// amount buckets carry integer usage counters, and `api_key` is a resolved
// object { tracking_id, name, sensitive_id }.
const DAY = 86_400;
const TZ = 8 * 3600;
const TODAY = Date.UTC(2026, 7, 15) / 1000 - TZ; // 2026-08-15 local midnight (+8)

const keyZcode = { tracking_id: 'k1', name: 'zcode', sensitive_id: 'sk-a***1' };
const keyDsh = { tracking_id: 'k2', name: '', sensitive_id: 'sk-b***2' }; // no name → fallback

const costBody = {
  code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: {
    start: TODAY - 2 * DAY, end: TODAY + DAY, bucket: DAY, models: ['deepseek-v4-pro'],
    data: [
      { currency: 'CNY', series: [
        { api_key: keyZcode, model: 'deepseek-v4-pro', buckets: [
          { time: TODAY - 2 * DAY, cost: '1.0000' },
          { time: TODAY, cost: '0.25' },
        ] },
        { api_key: keyDsh, model: 'deepseek-v4-pro', buckets: [
          { time: TODAY, cost: '0.75' },
        ] },
      ] },
      { currency: 'USD', series: [ // foreign-currency group must be ignored
        { api_key: keyZcode, model: 'deepseek-v4-pro', buckets: [{ time: TODAY, cost: '99' }] },
      ] },
    ],
  } },
};

const amountBody = {
  code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: {
    start: TODAY - 2 * DAY, end: TODAY + DAY, bucket: DAY, models: ['deepseek-v4-pro'],
    series: [
      { api_key: keyZcode, model: 'deepseek-v4-pro', buckets: [
        { time: TODAY - 2 * DAY, usage: { REQUEST: 10, PROMPT_CACHE_HIT_TOKEN: 100, PROMPT_CACHE_MISS_TOKEN: 200, RESPONSE_TOKEN: 50 } },
        { time: TODAY, usage: { REQUEST: 2, PROMPT_CACHE_HIT_TOKEN: 10, PROMPT_CACHE_MISS_TOKEN: 20, RESPONSE_TOKEN: 5 } },
      ] },
      { api_key: keyDsh, model: 'deepseek-v4-pro', buckets: [
        { time: TODAY, usage: { REQUEST: 3, PROMPT_CACHE_HIT_TOKEN: 30, PROMPT_CACHE_MISS_TOKEN: 40, RESPONSE_TOKEN: 15 } },
      ] },
    ],
  } },
};

test('deepseek parseWebUsage aggregates window/today totals and per-model today tokens', () => {
  const u = parseWebUsage(costBody, amountBody, { todayStart: TODAY });
  assert.ok(u);
  assert.equal(u.currency, 'CNY');
  assert.equal(u.last30Cost, 2); // 1 + 0.25 + 0.75 (USD group ignored)
  assert.equal(u.todayCost, 1); // 0.25 + 0.75
  assert.equal(u.requests, 15);
  assert.equal(u.todayRequests, 5);
  assert.equal(u.inputTokens, 260); // 200+20+40 cache-miss (month total)
  assert.equal(u.cacheHitTokens, 140); // 100+10+30
  assert.equal(u.outputTokens, 70); // 50+5+15
  // one model; per-model figures are TODAY only (both keys' today buckets):
  // hit 10+30, miss 20+40, out 5+15
  assert.equal(u.models.length, 1);
  assert.equal(u.models[0].model, 'deepseek-v4-pro');
  assert.equal(u.models[0].todayCacheHitTokens, 40);
  assert.equal(u.models[0].todayInputTokens, 60);
  assert.equal(u.models[0].todayOutputTokens, 20);
});

test('deepseek parseWebUsage works with cost alone (amount missing)', () => {
  const u = parseWebUsage(costBody, null, { todayStart: TODAY });
  assert.equal(u.last30Cost, 2);
  assert.equal(u.requests, 0);
  // No amount body → no token data → no per-model today rows.
  assert.equal(u.models.length, 0);
});

test('deepseek parseWebUsage drops models without today usage', () => {
  // Series has month usage on an earlier day but nothing today — the model
  // must be omitted from the today breakdown.
  const empty = { code: 0, data: { biz_code: 0, biz_data: { data: [{ currency: 'CNY', series: [
    { api_key: keyZcode, model: 'm', buckets: [{ time: TODAY, cost: '0' }] },
  ] }], series: [
    { api_key: keyZcode, model: 'm', buckets: [{ time: TODAY - 86_400, usage: { REQUEST: 9, PROMPT_CACHE_HIT_TOKEN: 90, PROMPT_CACHE_MISS_TOKEN: 90, RESPONSE_TOKEN: 90 } }] },
  ] } } };
  const u = parseWebUsage(empty, empty, { todayStart: TODAY });
  assert.equal(u.requests, 9);
  assert.equal(u.models.length, 0);
});

test('deepseek parseWebUsage throws on biz INVALID_PARAM (HTTP 200)', () => {
  const invalid = { code: 0, msg: '', data: { biz_code: 1, biz_msg: 'INVALID_PARAM', biz_data: null } };
  assert.throws(() => parseWebUsage(invalid, null, {}), /INVALID_PARAM/);
  assert.throws(() => parseWebUsage(null, invalid, {}), /INVALID_PARAM/);
});

test('deepseek parseWebUsage throws on session-token rejection and returns null on empty', () => {
  assert.throws(() => parseWebUsage({ code: 40003, msg: 'Authorization Failed' }, null, {}));
  assert.equal(parseWebUsage(null, null), null);
  assert.equal(parseWebUsage({ data: {} }, { data: {} }), null);
});

// ---- buildUsageRange: the usage endpoints' alignment rules ------------------
// start/end must be day boundaries in the whole-hour-truncated device tz, end
// exclusive (start of tomorrow), window a rolling 30 days (the API's max span).
test('deepseek buildUsageRange aligns to tomorrow and spans exactly 30 days', () => {
  const now = Date.UTC(2026, 7, 15, 4, 30); // 12:30 local (+8)
  const r = buildUsageRange(now, 8 * 3600);
  assert.equal(r.tz, 28800);
  assert.equal(r.todayStart, Date.UTC(2026, 7, 15) / 1000 - 28800);
  assert.equal(r.end, Date.UTC(2026, 7, 16) / 1000 - 28800);
  assert.equal(r.end - r.start, 30 * DAY);
  assert.equal(r.start, Date.UTC(2026, 7, 16) / 1000 - 28800 - 30 * DAY);
});

test('deepseek buildUsageRange truncates half-hour timezones to whole hours', () => {
  // +5:30 (19800s) → tz 18000; the local day is computed in that truncated tz.
  const now = Date.UTC(2026, 7, 15, 20, 0); // 2026-08-16T01:00 in +5:00
  const r = buildUsageRange(now, 19800);
  assert.equal(r.tz, 18000);
  assert.equal(r.todayStart, Date.UTC(2026, 7, 16) / 1000 - 18000);
  assert.equal(r.end, Date.UTC(2026, 7, 17) / 1000 - 18000);
});

test('deepseek buildUsageRange rolls back across month boundaries', () => {
  const now = Date.UTC(2026, 8, 1, 0, 30); // Sep 1 00:30, tz 0
  const r = buildUsageRange(now, 0);
  assert.equal(r.end, Date.UTC(2026, 8, 2) / 1000);
  assert.equal(r.start, Date.UTC(2026, 8, 2) / 1000 - 30 * DAY); // Aug 3
});

// ---- OpenRouter --------------------------------------------------------------
const openrouterBody = { data: { total_credits: 100.5, total_usage: 25.75 } };

test('openrouter parseCredits computes remaining and breakdown', () => {
  const { balances } = parseCredits(openrouterBody);
  assert.equal(balances.length, 1);
  assert.equal(balances[0].currency, 'USD');
  assert.equal(balances[0].total, 74.75); // 100.5 - 25.75 (headline = remaining)
  // Parts are the breakdown only — remaining is the headline, not a row.
  const labels = balances[0].parts.map((p) => p.label);
  assert.deepEqual(labels, ['Purchased', 'Used']);
  assert.equal(balances[0].parts[0].value, 100.5);
  assert.equal(balances[0].parts[1].value, 25.75);
});

test('openrouter parseCredits tolerates missing data', () => {
  assert.equal(parseCredits({ data: {} }).balances.length, 0);
  assert.equal(parseCredits({}).balances.length, 0);
});

// ---- SiliconFlow -------------------------------------------------------------
const siliconflowBody = {
  code: 20000,
  message: 'OK',
  status: true,
  data: { balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88' },
};

test('siliconflow parseBalance parses string amounts into numbers', () => {
  const { balances, isAvailable } = parseSiliconFlow(siliconflowBody);
  assert.equal(isAvailable, true);
  assert.equal(balances.length, 1);
  assert.equal(balances[0].currency, 'CNY');
  assert.equal(balances[0].total, 88.88);
  const byLabel = Object.fromEntries(balances[0].parts.map((p) => [p.label, p.value]));
  assert.equal(byLabel['Paid-in'], 88.0);
  assert.equal(byLabel['Promotional'], 0.88);
});

test('siliconflow parseBalance handles missing totalBalance', () => {
  assert.equal(parseSiliconFlow({ data: { balance: '1' } }).balances.length, 0);
});

// ---- Moonshot ----------------------------------------------------------------
const moonshotBody = {
  code: 0,
  scode: '0x0',
  status: true,
  data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
};

test('moonshot parseBalance splits available into cash + voucher', () => {
  const { balances, isAvailable } = parseMoonshot(moonshotBody);
  assert.equal(isAvailable, true);
  assert.equal(balances.length, 1);
  assert.equal(balances[0].currency, 'CNY');
  assert.equal(balances[0].total, 49.5889); // rounded to 4 dp
  const byLabel = Object.fromEntries(balances[0].parts.map((p) => [p.label, p.value]));
  assert.equal(byLabel['Cash'], 3.0);
  assert.equal(byLabel['Voucher'], 46.5889);
});

test('moonshot parseBalance flags insufficient when available <= 0', () => {
  const { isAvailable } = parseMoonshot({ code: 0, data: { available_balance: 0 } });
  assert.equal(isAvailable, false);
});
