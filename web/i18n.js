// Frontend i18n: a tiny bilingual (en/zh) dictionary + helpers.
// Loaded before app.js (see index.html). Exposes window.TT_I18N.
// Static HTML copy (data-i18n attributes) is applied by applyStaticText().

(function () {
  'use strict';

  const DICT = {
    en: {
      // static HTML
      'html.subtitle': 'AI platform subscriptions & usage · local-only',
      'html.refresh': '↻ Refresh',
      'html.refresh.title': 'Refresh now',
      'html.settings': '⚙ Settings',
      'html.settings.title': 'Settings',
      'html.lang.title': 'Switch language',
      'html.empty': 'No active subscriptions to show. Add API keys or fix invalid keys in <strong>⚙ Settings</strong>.',
      'html.footer': 'Bound to 127.0.0.1 · keys stored locally (0600) · outbound limited to known hosts',
      'html.modalTitle': 'Settings',
      'html.modalClose': 'Close',
      'html.modalFoot': 'Keys are saved to <code>~/.token-tool/config.json</code> (owner-only).',
      'html.modalDone': 'Done',
      // dashboard
      'status.ok': 'OK',
      'status.unauthorized': 'Unauthorized',
      'status.sourceRateLimited': 'Rate limited',
      'status.timeout': 'Timeout',
      'status.unavailable': 'Unavailable',
      'status.notConfigured': 'No key',
      'status.blockedHost': 'Blocked',
      'card.remaining': 'Remaining',
      'card.resets': 'resets',
      'card.renews': 'Renews',
      'card.noKeySet': 'No API key set. Open ⚙ Settings to add one.',
      'card.insufficientBalance': 'Insufficient balance',
      'card.granted': 'granted',
      'card.toppedUp': 'topped-up',
      'card.console': 'console ↗',
      'card.updated': 'updated {0}',
      'card.region.title': 'region: {0}',
      'card.openCode.src.serverError': 'Server usage unavailable ({0})',
      'card.openCode.src.server': 'Server rolling usage (official API)',
      'card.openCode.src.defaults': 'No usage data yet — plan limits shown',
      'card.openCode.src.local': 'Local usage from OpenCode database',
      // deepseek usage board
      'ds.dailySpend': 'Daily spend (this month)',
      'ds.byModel': 'By model',
      'ds.byKey': 'By API key',
      'ds.requests': '{0} requests',
      'ds.tokIn': 'in {0}',
      'ds.tokCache': 'cache hit {0}',
      'ds.tokOut': 'out {0}',
      'ds.noUsage': 'No usage this month',
      'top.updated': 'updated {0} · {1}',
      'top.refreshing': '↻ Refreshing…',
      'error.session': 'Session expired or unauthorized. Relaunch token-tool.',
      'error.load': 'Failed to load: {0}',
      'error.missingToken': 'Missing session token. Launch via the token-tool command to open this page.',
      // settings modal
      'settings.tag.codingPlan': 'Coding Plan',
      'settings.tag.balanceUsage': 'Balance + Usage',
      'settings.tag.goPlan': 'Go Plan',
      'settings.tag.credits': 'Credits',
      'settings.tag.balance': 'Balance',
      'settings.tag.api': 'API',
      'settings.region.global': 'Global',
      'settings.region.bigmodelCn': 'China (bigmodel.cn)',
      'settings.region.moonshotCn': 'China (moonshot.cn)',
      'settings.ph.pasteApiKey': 'paste API key',
      'settings.ph.pasteWebToken': 'paste web token',
      'settings.ph.pasteValue': 'paste value',
      'settings.saved': 'saved: {0}',
      'settings.label.apiKey': 'API Key',
      'settings.label.webToken': 'Web Token',
      'settings.label.region': 'Region',
      'settings.test': 'Test',
      'settings.save': 'Save',
      'settings.testEnterKey': 'enter a key to test',
      'settings.testing': 'testing…',
      'settings.nothingToSave': 'nothing to save',
      'settings.savedOk': 'saved',
      'settings.testOk': '✓ {0}',
      'settings.testErr': '✗ {0}',
      'settings.login.errStatus': '✗ {0} — {1}',
      // drag hint
      'card.dragHint': 'drag to reorder',
      // language switch (in settings)
      'settings.lang': 'Language',
    },
    zh: {
      // static HTML
      'html.subtitle': 'AI 平台订阅与用量监控 · 仅本地',
      'html.refresh': '↻ 刷新',
      'html.refresh.title': '立即刷新',
      'html.settings': '⚙ 配置',
      'html.settings.title': '配置',
      'html.lang.title': '切换语言',
      'html.empty': '暂无可显示的订阅。请在 <strong>⚙ 配置</strong> 中添加 API 密钥，或修复无效的密钥。',
      'html.footer': '仅绑定 127.0.0.1 · 密钥本地存储（0600）· 出站仅限已知主机',
      'html.modalTitle': '配置',
      'html.modalClose': '关闭',
      'html.modalFoot': '密钥保存到 <code>~/.token-tool/config.json</code>（仅属主可读）。',
      'html.modalDone': '完成',
      // dashboard
      'status.ok': '正常',
      'status.unauthorized': '未授权',
      'status.sourceRateLimited': '限流',
      'status.timeout': '超时',
      'status.unavailable': '不可用',
      'status.notConfigured': '无密钥',
      'status.blockedHost': '已拦截',
      'card.remaining': '剩余',
      'card.resets': '重置',
      'card.renews': '续费',
      'card.noKeySet': '未设置 API 密钥。请在 ⚙ 配置 中添加。',
      'card.insufficientBalance': '余额不足',
      'card.granted': '赠送',
      'card.toppedUp': '充值',
      'card.console': '控制台 ↗',
      'card.updated': '更新于 {0}',
      'card.region.title': '区域：{0}',
      'card.openCode.src.serverError': '服务器用量不可用（{0}）',
      'card.openCode.src.server': '服务器滚动用量（官方 API）',
      'card.openCode.src.defaults': '暂无用量数据 — 显示套餐上限',
      'card.openCode.src.local': '来自 OpenCode 本地数据库的用量',
      // deepseek usage board
      'ds.dailySpend': '每日消费（本月）',
      'ds.byModel': '按模型',
      'ds.byKey': '按 API Key',
      'ds.requests': '{0} 次请求',
      'ds.tokIn': '输入 {0}',
      'ds.tokCache': '缓存命中 {0}',
      'ds.tokOut': '输出 {0}',
      'ds.noUsage': '本月暂无用量',
      'top.updated': '更新于 {0} · {1}',
      'top.refreshing': '↻ 刷新中…',
      'error.session': '会话已过期或未授权，请重新启动 token-tool。',
      'error.load': '加载失败：{0}',
      'error.missingToken': '缺少会话令牌。请通过 token-tool 命令打开此页面。',
      // settings modal
      'settings.tag.codingPlan': '编程套餐',
      'settings.tag.balanceUsage': '余额 + 用量',
      'settings.tag.goPlan': 'Go 套餐',
      'settings.tag.credits': '积分',
      'settings.tag.balance': '余额',
      'settings.tag.api': 'API',
      'settings.region.global': '全球',
      'settings.region.bigmodelCn': '中国（bigmodel.cn）',
      'settings.region.moonshotCn': '中国（moonshot.cn）',
      'settings.ph.pasteApiKey': '粘贴 API Key',
      'settings.ph.pasteWebToken': '粘贴网页 token',
      'settings.ph.pasteValue': '粘贴内容',
      'settings.saved': '已保存：{0}',
      'settings.label.apiKey': 'API Key',
      'settings.label.webToken': '网页 Token',
      'settings.label.region': '区域',
      'settings.test': '测试',
      'settings.save': '保存',
      'settings.testEnterKey': '请输入密钥后再测试',
      'settings.testing': '测试中…',
      'settings.nothingToSave': '没有可保存的内容',
      'settings.savedOk': '已保存',
      'settings.testOk': '✓ {0}',
      'settings.testErr': '✗ {0}',
      'settings.login.errStatus': '✗ {0} — {1}',
      // drag hint
      'card.dragHint': '拖动调整排序',
      // language switch (in settings)
      'settings.lang': '语言',
    },
  };

  let lang = 'en';

  function normalizeLang(l) {
    return l === 'zh' ? 'zh' : 'en';
  }

  // Best guess from the browser's language (zh* → Chinese, anything else → en).
  function detectLang() {
    const nav = (navigator.language || navigator.languages?.[0] || '').toLowerCase();
    return normalizeLang(nav.startsWith('zh') ? 'zh' : 'en');
  }

  // Translate a key, filling {n} placeholders positionally.
  function t(key, ...params) {
    let s = DICT[lang][key] ?? DICT.en[key] ?? key;
    for (let i = 0; i < params.length; i += 1) {
      s = s.split(`{${i}}`).join(String(params[i]));
    }
    return s;
  }

  // Replace static HTML copy in elements tagged data-i18n="key".
  function applyStaticText() {
    document.querySelectorAll('[data-i18n]').forEach((node) => {
      const key = node.getAttribute('data-i18n');
      const val = t(key);
      if (val !== key) node.innerHTML = val;
    });
  }

  function currentLang() {
    return lang;
  }

  function setLang(next) {
    lang = normalizeLang(next);
    document.documentElement.lang = lang;
  }

  window.TT_I18N = { t, setLang, currentLang, detectLang, applyStaticText };
})();
