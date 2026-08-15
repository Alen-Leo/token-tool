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
    // --- deepseek ---
    'summary.todaySpend': 'today {0} {1}',
    'summary.insufficient': ' (insufficient)',
    'summary.noBalance': 'no balance info',
    'note.usageViaWeb': 'Usage via web session token · balance via API key when available.',
    'note.usageFailed': 'Usage detail unavailable — {0}.',
    'note.webRejected': 'Web token rejected by DeepSeek — {0}. Re-authorize in ⚙ Settings.',
    'note.webNotSet': 'Web token not set — add it in ⚙ Settings to see spend & token usage.',
    'parts.today': 'Today',
    'parts.last30d': 'Last 30 days',
    // --- moonshot ---
    'parts.cash': 'Cash',
    'parts.voucher': 'Voucher',
    // --- openrouter ---
    'parts.purchased': 'Purchased',
    'parts.used': 'Used',
    'summary.remaining': 'Remaining ${0}',
    'summary.noCredits': 'no credits info',
    // --- siliconflow ---
    'parts.paidIn': 'Paid-in',
    'parts.promotional': 'Promotional',
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
    // --- deepseek ---
    'summary.todaySpend': '今日 {0} {1}',
    'summary.insufficient': '（余额不足）',
    'summary.noBalance': '无余额信息',
    'note.usageViaWeb': '用量来自网页会话 token · 余额来自 API Key（可用时）。',
    'note.usageFailed': '明细获取失败 — {0}。',
    'note.webRejected': 'DeepSeek 拒绝了网页 token — {0}。请在 ⚙ 配置 中重新授权登录。',
    'note.webNotSet': '未设置网页 token — 在 ⚙ 配置 中添加后即可查看消费与 Token 用量。',
    'parts.today': '今日',
    'parts.last30d': '近30天',
    // --- moonshot ---
    'parts.cash': '现金',
    'parts.voucher': '代金券',
    // --- openrouter ---
    'parts.purchased': '已购',
    'parts.used': '已用',
    'summary.remaining': '剩余 ${0}',
    'summary.noCredits': '无积分信息',
    // --- siliconflow ---
    'parts.paidIn': '充值',
    'parts.promotional': '赠送',
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
