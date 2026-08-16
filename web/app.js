// token-tool frontend — vanilla JS, no build step, no dependencies.
// Talks only to the local loopback server. Session token lives in sessionStorage.

(() => {
  'use strict';

  // ---- i18n ----------------------------------------------------------------
  const { t, setLang, currentLang, applyStaticText } = window.TT_I18N;

  // ---- session token handling --------------------------------------------
  function initToken() {
    let token = sessionStorage.getItem('tt_token');
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('token');
    if (fromUrl) {
      token = fromUrl;
      sessionStorage.setItem('tt_token', token);
      // Strip the token from the URL so it isn't in history/referrer.
      params.delete('token');
      const qs = params.toString();
      history.replaceState(null, '', qs ? `/?${qs}` : '/');
    }
    if (!token) {
      document.getElementById('grid').innerHTML =
        `<p class="empty">${t('error.missingToken')}</p>`;
      return null;
    }
    return token;
  }

  const TOKEN = initToken();
  if (!TOKEN) return;

  async function api(path, opts = {}) {
    const headers = { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { ...opts, headers });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---- state --------------------------------------------------------------
  const state = { meta: [], config: { providers: {} }, results: [], lastUpdated: null, order: [], lang: 'en', renderPending: false };
  // True while a card drag is in flight — a refresh must not rebuild the grid
  // under the user's pointer (that tears the DOM out from the drag).
  let dragInProgress = false;

  // ---- small helpers ------------------------------------------------------
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v != null) node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  };

  function relativeFrom(iso) {
    if (!iso) return '';
    const t2 = new Date(iso).getTime();
    if (!Number.isFinite(t2)) return '';
    const diff = t2 - Date.now();
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60000);
    const zh = currentLang() === 'zh';
    // English puts the direction before ("in 51d") or after ("5m ago"); Chinese
    // always appends a suffix ("51天后", "5分钟前").
    const sign = diff >= 0 ? (zh ? '' : 'in ') : '';
    const suffix = diff >= 0 ? (zh ? '后' : '') : (zh ? '前' : ' ago');
    if (zh) {
      if (mins < 60) return `${mins}分钟${suffix}`;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      if (h < 48) return m ? `${h}小时${m}分${suffix}` : `${h}小时${suffix}`;
      return `${Math.round(h / 24)}天${suffix}`;
    }
    if (mins < 60) return `${sign}${mins}m${suffix}`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 48) return `${sign}${h}h${m ? ` ${m}m` : ''}${suffix}`;
    return `${sign}${Math.round(h / 24)}d${suffix}`;
  }

  function statusBadge(status) {
    const map = {
      ok: ['ok', t('status.ok')],
      unauthorized: ['err', t('status.unauthorized')],
      sourceRateLimited: ['warn', t('status.sourceRateLimited')],
      timeout: ['warn', t('status.timeout')],
      unavailable: ['err', t('status.unavailable')],
      notConfigured: ['muted', t('status.notConfigured')],
      blockedHost: ['err', t('status.blockedHost')],
    };
    const [cls, label] = map[status] || ['muted', status];
    return el('span', { class: `badge ${cls}` }, label);
  }

  function meterClass(pct) {
    if (pct == null) return '';
    if (pct >= 90) return 'err';
    if (pct >= 70) return 'warn';
    return '';
  }

  function fmtMoney(amount, currency = 'USD') {
    const n = Number(amount);
    if (!Number.isFinite(n)) return '—';
    const sym = { CNY: '¥', USD: '$', EUR: '€', GBP: '£' }[String(currency).toUpperCase()] || '';
    return `${sym}${n.toFixed(2)}`;
  }

  function fmtTokens(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return Math.round(v).toLocaleString('en-US');
  }

  // Compact token counts for sub-lines: 5.1M / 245.3M / 12K.
  function fmtCompactTokens(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return String(Math.round(v));
  }

  // Format a window's used/limit according to its unit: token counts (z.ai) get
  // thousands separators; currency (opencode spend) gets a $ prefix.
  function windowValues(w) {
    if (w.used == null || w.limit == null) return '';
    if (w.unit === 'tokens') return `${fmtTokens(w.used)} / ${fmtTokens(w.limit)}`;
    if (w.unit === 'currency') return `$${Number(w.used).toFixed(2)} / $${Number(w.limit).toFixed(2)}`;
    return `${w.used} / ${w.limit}`;
  }

  // Remaining value for a window: absolute remaining tokens or currency.
  // Rendered with a fixed 'Remaining' label in a meter-row.
  function windowRemaining(w) {
    if (w.remainingCount == null) return '';
    if (w.unit === 'tokens') return fmtTokens(w.remainingCount);
    if (w.unit === 'currency') return `$${Number(w.remainingCount).toFixed(2)}`;
    return String(w.remainingCount);
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ---- renderers per provider shape ---------------------------------------
  // DeepSeek usage-board detail (from the web token): TODAY's token
  // consumption per model (cache-hit / cache-miss input, output).
  function renderUsageDetail(u) {
    const nodes = [];

    // Per-model rows: today's token usage breakdown. Models with no usage
    // today are omitted by the server.
    if (Array.isArray(u.models) && u.models.length) {
      nodes.push(el('div', { class: 'usage-detail' },
        el('div', { class: 'meter-row' }, el('span', { class: 'label' }, t('ds.byModelToday'))),
        ...u.models.map((m) => el('div', { class: 'usage-model' },
          el('div', { class: 'meter-row' },
            el('span', { class: 'label model-name', title: m.model }, m.model)),
          el('div', { class: 'meter-row' },
            el('span', { class: 'label' }, t('ds.tokCacheHit')),
            el('span', { class: 'val' }, fmtCompactTokens(m.todayCacheHitTokens))),
          el('div', { class: 'meter-row' },
            el('span', { class: 'label' }, t('ds.tokCacheMiss')),
            el('span', { class: 'val' }, fmtCompactTokens(m.todayInputTokens))),
          el('div', { class: 'meter-row' },
            el('span', { class: 'label' }, t('ds.tokOut')),
            el('span', { class: 'val' }, fmtCompactTokens(m.todayOutputTokens))),
        )),
      ));
    }

    if (!nodes.length) {
      return el('div', { class: 'usage-detail' }, el('div', { class: 'meter-row' },
        el('span', { class: 'label' }, t('ds.noUsage'))));
    }
    return el('div', { class: 'usage-breakdown' }, ...nodes);
  }

  function renderWindows(windows) {
    if (!windows || !windows.length) return [];
    return windows.map((w) => {
      const pct = w.usedPercent;
      const barCls = meterClass(pct);
      const pctText = pct == null ? '—' : `${pct.toFixed(pct >= 100 ? 0 : 1)}%`;
      const values = windowValues(w);
      const reset = relativeFrom(w.resetsAt);
      const remaining = windowRemaining(w);
      return el('div', { class: 'window' },
        el('div', { class: 'meter' },
          el('div', { class: 'meter-row' },
            el('span', { class: 'label' }, w.label || w.kind),
            el('span', { class: 'val' }, values ? `${pctText} · ${values}` : pctText)),
          el('div', { class: `bar ${barCls}` }, el('span', { style: `width:${pct == null ? 0 : Math.min(100, pct)}%` })),
          remaining
            ? el('div', { class: 'meter-row' },
                el('span', { class: 'label' }, t('card.remaining')),
                el('span', { class: 'val' }, remaining))
            : null,
          reset ? el('div', { class: 'meter-row' }, el('span', { class: 'label' }, t('card.resets')), el('span', { class: 'val' }, `${reset}${fmtDate(w.resetsAt) ? ' · ' + fmtDate(w.resetsAt) : ''}`)) : null,
        ),
      );
    });
  }

  function renderCard(r, showAccountBadge) {
    const dotCls = r.status === 'ok' ? 'ok' : r.status === 'notConfigured' ? '' : 'err';
    const regionLabel = ({ 'bigmodel-cn': 'CN', 'moonshot-cn': 'CN', global: '' })[r.region] || (r.region ? r.region : '');
    // Account badge: distinguishes cards when a provider has several accounts.
    // Prefer the user label; fall back to the masked key's tail.
    const badgeText = r.accountLabel || (r.accountMask ? `…${r.accountMask.slice(-3)}` : '');
    const accountBadge = showAccountBadge && badgeText
      ? el('span', { class: 'badge muted account', title: t('card.account.title', r.accountLabel || r.accountMask) }, badgeText)
      : null;
    const head = el('div', { class: 'card-head' },
      el('div', { class: 'card-title' },
        el('span', { class: `dot ${dotCls}`, 'aria-hidden': 'true' }),
        el('span', {}, r.name),
      ),
      el('div', { class: 'head-badges' },
        accountBadge,
        regionLabel ? el('span', { class: 'badge muted', title: t('card.region.title', r.region) }, regionLabel) : null,
        statusBadge(r.status),
      ),
    );

    const body = [];

    if (r.status === 'notConfigured') {
      body.push(el('p', { class: 'card-sub' }, t('card.noKeySet')));
    } else if (r.error && r.status !== 'ok') {
      body.push(el('p', { class: 'card-sub' }, `⚠ ${r.error}`));
    }

    // At-a-glance human summary (z.ai, deepseek, …). OpenCode sends no
    // summary — its usage windows below carry all the info.
    if (r.summary && r.status === 'ok') {
      body.push(el('p', { class: 'card-summary' }, r.summary));
    }

    // Plan (z.ai)
    if (r.plan) body.push(el('div', {}, el('span', { class: 'plan' }, r.plan)));

    // Renewal date (z.ai subscription).
    if (r.renewsAt) {
      const rel = relativeFrom(r.renewsAt);
      const d = fmtDate(r.renewsAt);
      body.push(el('div', { class: 'meter-row renews' },
        el('span', { class: 'label' }, t('card.renews')),
        el('span', { class: 'val' }, [rel, d].filter(Boolean).join(' · ')),
      ));
    }

    // Balances (deepseek, openrouter, siliconflow, moonshot): big headline
    // number, breakdown rows (label left, value right) below it. DeepSeek's
    // rows also carry today / last-30-day spend, merged into the same block.
    if (Array.isArray(r.balances) && r.balances.length) {
      const blocks = r.balances.map((b) => {
        const partsNodes = (Array.isArray(b.parts) ? b.parts : []).map((p) =>
          el('div', { class: 'meter-row' },
            el('span', { class: 'label' }, p.label),
            el('span', { class: 'val' }, fmtMoney(p.value, p.currency || b.currency))));
        return el('div', { class: 'balance' },
          el('div', { class: 'balance-main' },
            el('span', { class: 'amount' }, fmtMoney(b.total, b.currency)),
            el('span', { class: 'currency' }, b.currency)),
          partsNodes.length ? el('div', { class: 'parts' }, ...partsNodes) : null,
        );
      });
      body.push(el('div', { class: 'balances' }, ...blocks));
      if (r.isAvailable === false) body.push(el('span', { class: 'badge warn' }, t('card.insufficientBalance')));
    }

    // DeepSeek usage-board detail: daily spend chart + per-model / per-key
    // breakdown, mirroring the official usage page.
    if (r.usageDetail) body.push(renderUsageDetail(r.usageDetail));

    // Provider note (DeepSeek usage explanation, etc.).
    if (r.note) {
      body.push(el('p', { class: 'card-sub small', style: r.webError ? 'color:var(--warn)' : '' }, r.note));
    }

    // Windows (z.ai tokens, opencode currency)
    const windowNodes = renderWindows(r.windows);
    if (windowNodes.length) body.push(el('div', { class: 'windows' }, ...windowNodes));

    // Rolling-usage source note (opencode) — no per-model breakdown needed.
    if (r.provider === 'opencode' && r.windows && r.windows.length) {
      let src;
      if (r.usageError) {
        src = t('card.openCode.src.serverError', r.usageError);
      } else if (r.remoteUsage) {
        src = t('card.openCode.src.server');
      } else if (r.localSource === 'defaults') {
        src = t('card.openCode.src.defaults');
      } else {
        src = t('card.openCode.src.local');
      }
      body.push(el('div', { class: 'card-sub small', style: r.usageError ? 'color:var(--warn)' : '' }, src));
    }

    const foot = el('div', { class: 'card-foot' },
      el('span', {}, r.dashboard ? el('a', { class: 'link', href: r.dashboard, target: '_blank', rel: 'noopener noreferrer' }, t('card.console')) : ''),
      el('span', {}, relativeFrom(r.updatedAt) ? t('card.updated', relativeFrom(r.updatedAt)) : ''),
    );

    return el('div', { class: 'card', 'data-provider': r.provider, 'data-card': `${r.provider}:${r.accountId || 'default'}`, title: t('card.dragHint') }, head, ...body, foot);
  }

  function render() {
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    // Only render cards that actually show subscription data: skip accounts
    // with no key (notConfigured) or an invalid/expired key (unauthorized).
    const HIDDEN = new Set(['notConfigured', 'unauthorized']);
    const visible = state.results.filter((r) => !HIDDEN.has(r.status));
    // Providers with more than one visible card get account badges.
    const counts = {};
    for (const r of visible) counts[r.provider] = (counts[r.provider] || 0) + 1;
    // Position of each account among its provider's visible cards (fallback
    // order for cards not covered by the persisted ui.order).
    const accountIdx = {};
    for (const r of visible) {
      accountIdx[r.provider] = accountIdx[r.provider] || {};
      accountIdx[r.provider][r.accountId || 'default'] = Object.keys(accountIdx[r.provider]).length;
    }
    // Sort key: exact card entry ('zai:a1b2c3') wins; a bare provider entry
    // ('zai') groups all its cards right after it; anything unlisted falls
    // back to registry order, accounts in config order.
    const sortIndex = (r) => {
      const key = `${r.provider}:${r.accountId || 'default'}`;
      const i = state.order.indexOf(key);
      if (i !== -1) return i;
      const p = state.order.indexOf(r.provider);
      if (p !== -1) return p + 0.5;
      const reg = state.meta.findIndex((m) => m.id === r.provider);
      return 10_000 + reg * 100 + (accountIdx[r.provider]?.[r.accountId || 'default'] || 0);
    };
    const sorted = [...visible].sort((a, b) => sortIndex(a) - sortIndex(b));
    for (const r of sorted) grid.appendChild(renderCard(r, counts[r.provider] > 1));
    // Empty state: nothing configured OR all keys invalid/expired.
    const hasAny = sorted.length > 0;
    document.getElementById('empty').classList.toggle('hidden', hasAny);
    if (state.lastUpdated) {
      const time = new Date(state.lastUpdated).toLocaleTimeString();
      document.getElementById('updated').textContent = t('top.updated', relativeFrom(state.lastUpdated), time);
    }
  }

  // A refresh that landed mid-drag deferred its render; run it once the drag
  // finishes so the grid rebuild never happens under the pointer.
  function flushPendingRender() {
    if (state.renderPending) {
      state.renderPending = false;
      render();
    }
  }

  // ---- drag-to-reorder (persisted via /api/config ui.order) ----------------
  // Pointer-based drag: the dragged card leaves the flow and follows the cursor
  // (fixed), while a same-height placeholder takes its slot and reflows in real
  // time as the cursor crosses other cards. On release the card drops into the
  // placeholder's position. Much smoother than HTML5 DnD's rigid ghost image.
  function attachDragHandlers(grid) {
    let dragging = null;     // the .card being dragged (fixed, follows cursor)
    let placeholder = null;  // same-height spacer other cards reflow around
    let startY = 0;
    let startX = 0;
    let offsetY = 0;         // cursor's initial offset within the card
    let dragActive = false;  // moved past the click threshold yet

    const isInteractive = (e) => e.target.closest('a, button, input, select');

    function makePlaceholder(card) {
      const ph = document.createElement('div');
      ph.className = 'card-placeholder';
      ph.style.height = `${card.offsetHeight}px`;
      return ph;
    }

    // Drop the card into the placeholder's slot and persist the order.
    function finish() {
      if (!dragging) return;
      const card = dragging;
      dragInProgress = false;
      const moved = dragActive; // capture before resetting below
      if (placeholder && placeholder.parentNode) placeholder.replaceWith(card);
      card.classList.remove('dragging');
      card.style.position = '';
      card.style.top = '';
      card.style.left = '';
      card.style.width = '';
      card.style.pointerEvents = '';
      document.body.classList.remove('dragging-active');
      dragging = null;
      placeholder = null;
      dragActive = false;
      flushPendingRender();
      if (!moved) return; // never crossed the threshold → a plain click
      const order = [...grid.querySelectorAll('.card')].map((c) => c.dataset.card);
      state.order = order;
      api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { order } }) })
        .then((cfg) => { state.config = cfg; })
        .catch(() => { /* order still applies for this session */ });
    }

    grid.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || isInteractive(e)) return;
      const card = e.target.closest('.card');
      if (!card) return;
      dragging = card;
      startY = e.clientY;
      startX = e.clientX;
      offsetY = e.clientY - card.getBoundingClientRect().top;
      dragActive = false;
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      if (!dragActive) {
        // Start dragging only after a small move so plain clicks still work.
        if (Math.abs(e.clientY - startY) < 6 && Math.abs(e.clientX - startX) < 6) return;
        dragActive = true;
        dragInProgress = true;
        const rect = dragging.getBoundingClientRect();
        placeholder = makePlaceholder(dragging);
        grid.insertBefore(placeholder, dragging);
        // Pull the card out of flow so it can follow the cursor.
        dragging.style.position = 'fixed';
        dragging.style.left = `${rect.left}px`;
        dragging.style.width = `${rect.width}px`;
        dragging.style.pointerEvents = 'none'; // so elementFromPoint sees through it
        dragging.classList.add('dragging');
        document.body.classList.add('dragging-active');
      }
      dragging.style.top = `${e.clientY - offsetY}px`;

      // Where would the card land? Ask the browser what's under the cursor —
      // the fixed card has pointer-events:none, so we get the real layout.
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under && under.closest('.card');
      if (!target || !placeholder) return;
      const after = e.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2;
      const anchor = after ? target.nextSibling : target;
      // Move the placeholder next to the anchor — other cards reflow instantly.
      if (anchor && anchor !== placeholder) {
        grid.insertBefore(placeholder, anchor);
      }
    });

    document.addEventListener('mouseup', () => {
      if (dragging) finish();
    });

    // Esc cancels an in-progress drag, restoring the original position.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !dragging) return;
      if (placeholder && placeholder.parentNode) placeholder.replaceWith(dragging);
      dragging.classList.remove('dragging');
      dragging.style.position = '';
      dragging.style.top = '';
      dragging.style.left = '';
      dragging.style.width = '';
      dragging.style.pointerEvents = '';
      document.body.classList.remove('dragging-active');
      dragging = null;
      placeholder = null;
      dragActive = false;
      dragInProgress = false;
      flushPendingRender();
    });
  }

  // ---- data loading -------------------------------------------------------
  async function loadAll() {
    const refreshBtn = document.getElementById('refresh');
    refreshBtn.disabled = true;
    refreshBtn.textContent = t('top.refreshing');
    try {
      if (!state.meta.length) state.meta = (await api('/api/providers')).providers || [];
      // Re-read config each load so a language/order change from another window
      // (main window ↔ popover) is picked up.
      state.config = await api('/api/config');
      if (state.config.ui) {
        if (state.config.ui.lang && state.config.ui.lang !== currentLang()) {
          setLang(state.config.ui.lang);
          applyStaticText();
        }
        if (Array.isArray(state.config.ui.order)) state.order = state.config.ui.order;
      }
      const data = await api(`/api/query?lang=${currentLang()}`);
      state.results = data.results || [];
      state.lastUpdated = data.generatedAt || new Date().toISOString();
      if (dragInProgress) {
        // Never rebuild the grid mid-drag; flush when the drag ends.
        state.renderPending = true;
      } else {
        render();
      }
    } catch (e) {
      if (e.status === 401) {
        document.getElementById('grid').innerHTML = `<p class="empty">${t('error.session')}</p>`;
      } else {
        document.getElementById('grid').innerHTML = `<p class="empty">${t('error.load', e.message)}</p>`;
      }
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = t('html.refresh');
    }
  }

  // ---- settings modal -----------------------------------------------------
  // One editor per ACCOUNT of each provider. Providers with no accounts yet
  // show a single "first account" editor (saving creates the default account)
  // to keep the single-account flow exactly as simple as before.
  function buildAccountSection(m, { mode, account = null, multi = false, onStructureChange = () => {} }) {
    // mode: 'first' (provider empty — save creates the default account),
    //       'new' (adding another account), 'existing'.
    const isEnv = account?.id === 'env';
    const showLabel = mode !== 'first' && !isEnv; // label only matters once there are ≥2
    const wrap = el('div', { class: 'account-wrap' });

    // Section header + remove/cancel — only when there is something to
    // distinguish (several accounts) or an unsaved new form to cancel.
    if (mode === 'new' || (mode === 'existing' && multi)) {
      const title = mode === 'new'
        ? t('settings.newAccount')
        : (account.label || account.keyMask || account.webTokenMask || account.id);
      const head = el('div', { class: 'account-head' }, el('span', { class: 'account-name' }, title));
      if (!isEnv) {
        const x = el('button', { class: 'btn btn-icon account-remove', title: t('settings.removeAccount'), 'aria-label': t('settings.removeAccount') }, '✕');
        x.addEventListener('click', async () => {
          if (mode === 'new') { wrap.remove(); return; }
          if (!window.confirm(t('settings.removeConfirm'))) return;
          try {
            state.config = await api('/api/config', { method: 'POST', body: JSON.stringify({ provider: m.id, removeAccount: account.id }) });
            onStructureChange(); // rebuild this provider's fieldset in place
            loadAll();
          } catch (e) {
            out.textContent = t('settings.testErr', e.message); out.className = 'test-out err';
          }
        });
        head.appendChild(x);
      }
      wrap.appendChild(head);
    }

    const inputs = {}; // fieldKey → DOM input/select
    const regionLabels = {
      global: t('settings.region.global'),
      'bigmodel-cn': t('settings.region.bigmodelCn'),
      'moonshot-cn': t('settings.region.moonshotCn'),
    };
    const fieldPlaceholders = {
      apiKey: { savedKey: 'hasKey', maskKey: 'keyMask', ph: t('settings.ph.pasteApiKey') },
      webToken: { savedKey: 'hasWebToken', maskKey: 'webTokenMask', ph: t('settings.ph.pasteWebToken') },
    };

    for (const f of m.configFields) {
      if (f.type === 'select') {
        const sel = el('select', { title: f.label },
          ...f.options.map((opt) => el('option', { value: opt }, regionLabels[opt] || opt)),
        );
        sel.value = account?.region || f.default || f.options[0];
        inputs[f.key] = sel;
      } else {
        const fp = fieldPlaceholders[f.key] || {};
        const saved = account?.[fp.savedKey];
        const mask = account?.[fp.maskKey];
        const inputEl = el('input', {
          type: f.type === 'password' ? 'password' : 'text',
          placeholder: saved ? t('settings.saved', mask) : (f.hint || fp.ph || t('settings.ph.pasteValue')),
          autocomplete: 'off',
          title: f.hint || '',
        });
        if (f.hint) inputEl.title = f.hint;
        // Mark the field as "cleared" when the user empties it, so Save can
        // send an empty value (server deletes the stored key/token).
        inputEl.addEventListener('input', () => {
          if (inputEl.value.trim() === '') inputEl.dataset.cleared = '1';
          else delete inputEl.dataset.cleared;
        });
        inputs[f.key] = inputEl;
      }
    }

    if (showLabel) {
      const li = el('input', { type: 'text', placeholder: t('settings.ph.accountLabel'), autocomplete: 'off', maxlength: '24' });
      li.value = account?.label || '';
      inputs.label = li;
    }

    const labelFor = (key) => ({ apiKey: t('settings.label.apiKey'), webToken: t('settings.label.webToken'), region: t('settings.label.region'), label: t('settings.label.label') }[key] || key);
    const fieldKeys = [...m.configFields.map((f) => f.key), ...(showLabel ? ['label'] : [])];
    for (const key of fieldKeys) {
      const fieldEl = inputs[key];
      if (!fieldEl) continue;
      wrap.appendChild(el('div', { class: 'field-row' },
        el('span', { class: 'field-label' }, labelFor(key)),
        fieldEl,
      ));
      const hint = m.configFields.find((f) => f.key === key)?.hint;
      if (hint) wrap.appendChild(el('p', { class: 'field-hint' }, hint));
    }

    const btnRow = el('div', { class: 'btn-row' });
    const out = el('div', { class: 'test-out' });
    const testBtn = el('button', { class: 'btn' }, t('settings.test'));
    const saveBtn = el('button', { class: 'btn btn-primary' }, t('settings.save'));
    btnRow.appendChild(testBtn);
    if (!isEnv) btnRow.appendChild(saveBtn);
    else btnRow.appendChild(el('span', { class: 'field-hint', style: 'align-self:center;margin:0' }, t('settings.envAccount')));

    // "授权登录" — providers with a webToken field (DeepSeek). Opens a login
    // window in the desktop shell; browser mode returns 501 (paste manually).
    if (m.configFields.some((f) => f.key === 'webToken') && mode === 'existing' && !isEnv) {
      const authBtn = el('button', { class: 'btn btn-ghost', title: currentLang() === 'zh' ? '打开 DeepSeek 登录窗口 — 自动获取会话 token' : 'Open DeepSeek login in a window — auto-captures the session token' }, '🔑 授权登录');
      const authOut = el('div', { class: 'test-out small' });
      btnRow.appendChild(authBtn);
      wrap.appendChild(authOut);
      authBtn.addEventListener('click', async () => {
        authOut.textContent = currentLang() === 'zh' ? '正在打开登录窗口…' : 'opening login window…'; authOut.className = 'test-out small';
        try {
          const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ provider: m.id }) });
          if (r.ok && r.token) {
            // Save the captured token as THIS account's webToken, then refresh.
            state.config = await api('/api/config', { method: 'POST', body: JSON.stringify({ provider: m.id, accountId: account.id, fields: { webToken: r.token } }) });
            if (inputs.webToken) {
              inputs.webToken.value = '';
              const updated = (state.config.providers[m.id]?.accounts || []).find((a) => a.id === account.id) || {};
              inputs.webToken.placeholder = updated.hasWebToken ? t('settings.saved', updated.webTokenMask) : t('settings.ph.pasteWebToken');
              delete inputs.webToken.dataset.cleared;
            }
            authOut.textContent = currentLang() === 'zh' ? '✓ 登录成功，已保存 web token' : '✓ Login OK, web token saved'; authOut.className = 'test-out small ok';
            loadAll();
          } else if (r.status) {
            authOut.textContent = t('settings.login.errStatus', r.status, r.error || 'failed'); authOut.className = 'test-out small err';
          } else {
            authOut.textContent = currentLang() === 'zh' ? `✗ ${r.message || '未能获取 token，请手动粘贴'}` : `✗ ${r.message || 'could not get token — paste manually'}`; authOut.className = 'test-out small err';
          }
        } catch (e) {
          // 501 = not available (browser mode); instruct manual paste.
          const msg = e.status === 501
            ? (currentLang() === 'zh' ? '⚠ 桌面端可用一键登录；浏览器模式请手动粘贴 web token' : '⚠ One-click login is desktop-only; paste the web token manually in browser mode')
            : `✗ ${e.message}`;
          authOut.textContent = msg; authOut.className = 'test-out small err';
        }
      });
    }

    wrap.appendChild(btnRow);
    wrap.appendChild(out);

    // Collect changed field values from the inputs.
    const collectFields = () => {
      const fields = {};
      for (const f of m.configFields) {
        if (f.type === 'select') {
          if (inputs[f.key]) fields[f.key] = inputs[f.key].value;
        } else {
          const v = inputs[f.key].value.trim();
          if (v) fields[f.key] = v;
          else if (inputs[f.key].dataset.cleared === '1') fields[f.key] = ''; // allow clearing
        }
      }
      if (inputs.label) {
        const v = inputs.label.value.trim();
        if (v !== (account?.label || '')) fields.label = v; // '' removes the label
      }
      return fields;
    };

    testBtn.addEventListener('click', async () => {
      const fields = collectFields();
      // For providers that need at least one credential (apiKey or webToken).
      if (!fields.apiKey && !fields.webToken) { out.textContent = t('settings.testEnterKey'); out.className = 'test-out err'; return; }
      out.textContent = t('settings.testing'); out.className = 'test-out';
      try {
        const r = await api(`/api/test/${m.id}?lang=${currentLang()}`, { method: 'POST', body: JSON.stringify({ fields }) });
        if (r.status === 'ok') {
          out.textContent = t('settings.testOk', r.summary || t('status.ok'));
          out.className = 'test-out ok';
        } else {
          // Show the localized status label instead of the raw English code.
          const KNOWN = ['ok', 'unauthorized', 'sourceRateLimited', 'timeout', 'unavailable', 'notConfigured', 'blockedHost'];
          const label = KNOWN.includes(r.status) ? t(`status.${r.status}`) : r.status;
          // The server error already carries the label + HTTP code (e.g. 「未授权 (401)」) —
          // prefer it directly to avoid 「未授权 — 未授权 (401)」.
          const text = r.error ? (r.error.startsWith(label) ? r.error : `${label} — ${r.error}`) : label;
          out.textContent = t('settings.testErr', text);
          out.className = 'test-out err';
        }
      } catch (e) {
        out.textContent = t('settings.testErr', e.message);
        out.className = 'test-out err';
      }
    });

    if (!isEnv) {
      saveBtn.addEventListener('click', async () => {
        const fields = collectFields();
        if (!Object.keys(fields).length) { out.textContent = t('settings.nothingToSave'); out.className = 'test-out err'; return; }
        // A new account is pointless without a credential — region/label alone
        // would just create a hidden notConfigured card.
        if (mode !== 'existing' && !fields.apiKey && !fields.webToken) {
          out.textContent = t('settings.enterKeyToSave'); out.className = 'test-out err'; return;
        }
        const payload = mode === 'first'
          ? { provider: m.id, fields }
          : mode === 'new'
            ? { provider: m.id, addAccount: true, fields }
            : { provider: m.id, accountId: account.id, fields };
        saveBtn.disabled = true; // guard against double-click double-add
        try {
          state.config = await api('/api/config', { method: 'POST', body: JSON.stringify(payload) });
          if (mode === 'existing') {
            // Refresh this section's placeholders in place.
            const updated = (state.config.providers[m.id]?.accounts || []).find((a) => a.id === account.id) || {};
            for (const key of Object.keys(inputs)) {
              if (key === 'label') { inputs.label.value = updated.label || ''; continue; }
              if (key === 'region') continue;
              inputs[key].value = '';
              const fp = fieldPlaceholders[key] || {};
              const hint = m.configFields.find((f) => f.key === key)?.hint;
              inputs[key].placeholder = updated[fp.savedKey] ? t('settings.saved', updated[fp.maskKey]) : (hint || fp.ph || t('settings.ph.pasteValue'));
              delete inputs[key].dataset.cleared;
            }
            out.textContent = t('settings.savedOk'); out.className = 'test-out ok';
          } else {
            onStructureChange(); // rebuild this provider's fieldset — a new account got its id
          }
          loadAll();
        } catch (e) {
          out.textContent = t('settings.testErr', e.message); out.className = 'test-out err';
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    return wrap;
  }

  // One provider's fieldset: all its account editors + the add-account
  // button. `rebuildProvider` swaps the whole fieldset for a fresh one when an
  // account is added/removed — scoped, so unsaved edits in OTHER providers'
  // sections survive.
  function buildProviderFieldset(m) {
    const provCfg = state.config.providers[m.id] || {};
    const accounts = Array.isArray(provCfg.accounts) ? provCfg.accounts : [];
    const hasWebToken = m.configFields.some((f) => f.key === 'webToken');
    // Short tag for the header — a quick hint of what this provider shows.
    const tags = { zai: t('settings.tag.codingPlan'), deepseek: t('settings.tag.balanceUsage'), opencode: t('settings.tag.goPlan'), openrouter: t('settings.tag.credits'), siliconflow: t('settings.tag.balance'), moonshot: t('settings.tag.balance') };
    const fs = el('div', { class: hasWebToken ? 'fieldset fieldset-wide' : 'fieldset' },
      el('h3', {}, m.name, el('span', { class: 'tag' }, tags[m.id] || t('settings.tag.api'))),
    );
    const rebuildProvider = () => fs.replaceWith(buildProviderFieldset(m));

    if (!accounts.length) {
      fs.appendChild(buildAccountSection(m, { mode: 'first', onStructureChange: rebuildProvider }));
    } else {
      const multi = accounts.length > 1;
      for (const a of accounts) fs.appendChild(buildAccountSection(m, { mode: 'existing', account: a, multi, onStructureChange: rebuildProvider }));
      const addBtn = el('button', { class: 'btn btn-ghost add-account' }, t('settings.addAccount'));
      addBtn.addEventListener('click', () => {
        fs.insertBefore(buildAccountSection(m, { mode: 'new', multi: true, onStructureChange: rebuildProvider }), addBtn);
      });
      fs.appendChild(addBtn);
    }
    return fs;
  }

  function openSettings() {
    const body = document.getElementById('settings-body');
    body.innerHTML = '';

    // Language switch — lives at the top of the settings panel.
    const langSwitch = el('div', { class: 'fieldset fieldset-wide lang-switch' },
      el('h3', {}, t('settings.lang')),
      el('div', { class: 'lang-options' },
        el('button', { class: `btn ${currentLang() === 'zh' ? 'btn-primary' : ''}` }, '中文'),
        el('button', { class: `btn ${currentLang() === 'en' ? 'btn-primary' : ''}` }, 'English'),
      ),
    );
    langSwitch.querySelectorAll('.lang-options .btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const next = btn.textContent === 'English' ? 'en' : 'zh';
        if (next === currentLang()) return;
        setLang(next);
        applyStaticText();
        try {
          state.config = await api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { lang: next } }) });
        } catch { /* keep in-memory language even if persist fails */ }
        loadAll();
        openSettings(); // re-render the panel in the new language
      });
    });
    body.appendChild(langSwitch);

    for (const m of state.meta) body.appendChild(buildProviderFieldset(m));
    document.getElementById('modal').classList.remove('hidden');
  }

  function closeSettings() {
    document.getElementById('modal').classList.add('hidden');
  }

  // ---- wiring -------------------------------------------------------------
  document.getElementById('refresh').addEventListener('click', loadAll);
  document.getElementById('settings').addEventListener('click', openSettings);
  document.getElementById('modal-close').addEventListener('click', closeSettings);
  document.getElementById('modal-done').addEventListener('click', closeSettings);
  document.getElementById('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeSettings(); });

  // Esc closes modal
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

  async function boot() {
    // Apply the persisted language; fresh installs (no config yet) default to
    // Chinese. The server always echoes a valid lang, so no detection is needed.
    try {
      const cfg = await api('/api/config');
      state.config = cfg;
      setLang(cfg.ui?.lang || 'zh');
      if (Array.isArray(cfg.ui?.order)) state.order = cfg.ui.order;
    } catch { /* no config yet — defaults */ }
    applyStaticText();
    attachDragHandlers(document.getElementById('grid'));
    loadAll();
  }

  boot();
  // Gentle auto-refresh every 90s. Deliberately NOT visibility-gated: a
  // refresh triggered the moment the popover reappears janks the UI right
  // when the user starts interacting.
  setInterval(loadAll, 90_000);
})();
