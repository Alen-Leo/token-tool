// Minimal two-language dictionary for app-generated copy (en/zh).
//
// Layering rule: strings that come FROM a platform/API are passed through
// verbatim (plan names, provider error messages, brand names). Only strings the
// app itself composes — summaries, notes, window labels, part labels — go
// through this dictionary and follow the selected language.
//
// Placeholders use {0}, {1}, … and are filled positionally by tr().
// Unknown keys return the key itself so a missing translation degrades to a
// visible key instead of silently disappearing.

import { HttpError } from './util/http.js';

const DICT = {
  en: {
    // --- shared ---
    'error.requestFailed': 'request failed',
    'error.unknownProvider': 'unknown provider',
    'error.providerFailed': 'provider failed',
    'status.ok': 'OK',
    'status.unauthorized': 'Unauthorized',
    'status.sourceRateLimited': 'Rate limited',
    'status.timeout': 'Timeout',
    'status.unavailable': 'Unavailable',
    'status.notConfigured': 'No key',
    'status.blockedHost': 'Blocked',
    'window.5hour': '5-hour',
    'window.weekly': 'Weekly',
    'window.monthly': 'Monthly',
    // --- z.ai ---
    'summary.session': 'session {0}%',
    'summary.renews': 'renews {0}',
    // --- opencode ---
    'summary.keyValid': 'Key valid · {0} models',
    'summary.rolling': 'rolling ${0}/${1} ({2}%)',
    'summary.resets': 'resets {0}',
    'summary.usageInConsole': 'usage in console',
    // --- deepseek ---
    'summary.allTime': 'all-time {0} {1}',
    'summary.thisMonth': 'this month {0} {1}',
    'summary.todaySpend': 'today {0} {1}',
    'summary.balance': 'balance {0} {1}',
    'summary.usageUnavailable': 'usage unavailable',
    'summary.balanceToday': 'Balance {0} {1}',
    'summary.today': 'today {0}',
    'summary.insufficient': ' (insufficient)',
    'summary.noBalance': 'no balance info',
    'note.usageViaWeb': 'Usage via web session token · balance via API key when available.',
    'note.usageFailed': 'Usage detail unavailable — {0}.',
    'note.webRejected': 'Web token rejected by DeepSeek — {0}. Re-authorize in ⚙ Settings.',
    'note.webNotSet': 'Web token not set — add it in ⚙ Settings to see cumulative spend & token usage.',
    'parts.totalSpend': 'Total spend',
    'parts.bonusBalance': 'Bonus balance',
    'parts.balance': 'Balance',
    'parts.today': 'Today',
    'parts.thisMonth': 'This month',
    'parts.allTime': 'All-time',
    // --- moonshot ---
    'parts.cash': 'Cash',
    'parts.voucher': 'Voucher',
    'parts.available': 'Available',
    // --- openrouter ---
    'parts.purchased': 'Purchased',
    'parts.used': 'Used',
    'parts.remaining': 'Remaining',
    'summary.remaining': 'Remaining ${0}',
    'summary.noCredits': 'no credits info',
    // --- siliconflow ---
    'parts.paidIn': 'Paid-in',
    'parts.promotional': 'Promotional',
    'parts.total': 'Total',
    'summary.balanceCNY': 'Balance ¥{0}',
    'summary.issue': ' (issue)',
  },
  zh: {
    // --- shared ---
    'error.requestFailed': '请求失败',
    'error.unknownProvider': '未知服务商',
    'error.providerFailed': '服务商请求失败',
    'status.ok': '正常',
    'status.unauthorized': '未授权',
    'status.sourceRateLimited': '限流',
    'status.timeout': '超时',
    'status.unavailable': '不可用',
    'status.notConfigured': '无密钥',
    'status.blockedHost': '已拦截',
    'window.5hour': '5小时',
    'window.weekly': '本周',
    'window.monthly': '本月',
    // --- z.ai ---
    'summary.session': '会话 {0}%',
    'summary.renews': '{0} 后续费',
    // --- opencode ---
    'summary.keyValid': '密钥有效 · {0} 个模型',
    'summary.rolling': '滚动 ${0}/${1}（{2}%）',
    'summary.resets': '{0} 重置',
    'summary.usageInConsole': '用量请到控制台查看',
    // --- deepseek ---
    'summary.allTime': '累计 {0} {1}',
    'summary.thisMonth': '本月 {0} {1}',
    'summary.todaySpend': '今日 {0} {1}',
    'summary.balance': '余额 {0} {1}',
    'summary.usageUnavailable': '用量不可用',
    'summary.balanceToday': '余额 {0} {1}',
    'summary.today': '今日 {0}',
    'summary.insufficient': '（余额不足）',
    'summary.noBalance': '无余额信息',
    'note.usageViaWeb': '用量来自网页会话 token · 余额来自 API Key（可用时）。',
    'note.usageFailed': '明细获取失败 — {0}。',
    'note.webRejected': 'DeepSeek 拒绝了网页 token — {0}。请在 ⚙ 配置 中重新授权登录。',
    'note.webNotSet': '未设置网页 token — 在 ⚙ 配置 中添加后即可查看累计消费与 Token 用量。',
    'parts.totalSpend': '累计消费',
    'parts.bonusBalance': '赠送余额',
    'parts.balance': '余额',
    'parts.today': '今日',
    'parts.thisMonth': '本月',
    'parts.allTime': '累计',
    // --- moonshot ---
    'parts.cash': '现金',
    'parts.voucher': '代金券',
    'parts.available': '可用',
    // --- openrouter ---
    'parts.purchased': '已购',
    'parts.used': '已用',
    'parts.remaining': '剩余',
    'summary.remaining': '剩余 ${0}',
    'summary.noCredits': '无积分信息',
    // --- siliconflow ---
    'parts.paidIn': '充值',
    'parts.promotional': '赠送',
    'parts.total': '总额',
    'summary.balanceCNY': '余额 ¥{0}',
    'summary.issue': '（异常）',
  },
};

export function normalizeLang(lang) {
  return lang === 'zh' ? 'zh' : 'en';
}

// Translate a dictionary key into `lang` (default 'en'), filling {n} placeholders.
export function tr(lang, key, ...params) {
  const l = normalizeLang(lang);
  let tmpl = DICT[l][key] ?? DICT.en[key] ?? key;
  for (let i = 0; i < params.length; i += 1) {
    tmpl = tmpl.replaceAll(`{${i}}`, String(params[i]));
  }
  return tmpl;
}

// Translate an app-generated HTTP/provider error into the UI language.
// Platform messages are NOT routed through here (layering rule) — only our own
// error classifications, so a zh UI never shows English for 401 / timeout /
// rate-limit / blocked-host. The numeric HTTP status is kept as a suffix.
export function errorText(err, lang = 'en') {
  if (!(err instanceof HttpError)) return tr(lang, 'error.requestFailed');
  const key = {
    unauthorized: 'status.unauthorized',
    sourceRateLimited: 'status.sourceRateLimited',
    timeout: 'status.timeout',
    blockedHost: 'status.blockedHost',
  }[err.status];
  const label = key ? tr(lang, key) : tr(lang, 'error.requestFailed');
  return err.httpStatus ? `${label} (${err.httpStatus})` : label;
}
