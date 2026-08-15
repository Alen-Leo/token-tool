// token-tool frontend — vanilla JS, no build step, no dependencies.
// Talks only to the local loopback server. Session token lives in sessionStorage.

(() => {
  'use strict';

  // ---- i18n ----------------------------------------------------------------
  const { t, setLang, currentLang, detectLang, applyStaticText } = window.TT_I18N;

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
  // DeepSeek usage-board detail (from the web token): a compact bar chart of
  // daily spend this month plus per-model and per-API-key breakdowns.
  function renderUsageDetail(u) {
    const nodes = [];

    // Daily spend chart. Bars scale to the busiest day; hover shows the exact
    // figure. Days with no spend keep a hairline baseline.
    if (Array.isArray(u.daily) && u.daily.length > 1) {
      const max = Math.max(...u.daily.map((d) => d.cost || 0), 0.000001);
      const bars = u.daily.map((d) => {
        const pct = d.cost > 0 ? Math.max(6, Math.round((d.cost / max) * 100)) : 2;
        const title = `${d.date} · ${fmtMoney(d.cost, u.currency)}${d.tokens ? ` · ${fmtCompactTokens(d.tokens)} tk` : ''}`;
        return el('span', { class: `ubar${d.cost > 0 ? '' : ' empty'}`, style: `height:${pct}%`, title });
      });
      nodes.push(el('div', { class: 'usage-detail' },
        el('div', { class: 'meter-row' },
          el('span', { class: 'label' }, t('ds.dailySpend')),
          el('span', { class: 'val' }, `${u.daily[0].date} – ${u.daily[u.daily.length - 1].date}`),
        ),
        el('div', { class: 'usage-bars' }, ...bars),
      ));
    }

    // Per-model rows: cost headline, tokens/requests sub-line.
    if (Array.isArray(u.models) && u.models.length) {
      nodes.push(el('div', { class: 'usage-detail' },
        el('div', { class: 'meter-row' }, el('span', { class: 'label' }, t('ds.byModel'))),
        ...u.models.map((m) => el('div', { class: 'usage-model' },
          el('div', { class: 'meter-row' },
            el('span', { class: 'label model-name', title: m.model }, m.model),
            el('span', { class: 'val' }, fmtMoney(m.cost, u.currency)),
          ),
          el('div', { class: 'model-sub' },
            `${t('ds.requests', fmtTokens(m.requests))} · `,
            `${t('ds.tokIn', fmtCompactTokens(m.inputTokens))} · `,
            `${t('ds.tokCache', fmtCompactTokens(m.cacheHitTokens))} · `,
            t('ds.tokOut', fmtCompactTokens(m.outputTokens)),
          ),
        )),
      ));
    }

    // Per-API-key rows (the official usage table's grouping).
    if (Array.isArray(u.keys) && u.keys.length) {
      nodes.push(el('div', { class: 'usage-detail' },
        el('div', { class: 'meter-row' }, el('span', { class: 'label' }, t('ds.byKey'))),
        ...u.keys.map((k) => el('div', { class: 'meter-row' },
          el('span', { class: 'label model-name', title: k.name }, k.name),
          el('span', { class: 'val' }, fmtMoney(k.cost, u.currency)),
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

  function renderCard(r) {
    const dotCls = r.status === 'ok' ? 'ok' : r.status === 'notConfigured' ? '' : 'err';
    const regionLabel = ({ 'bigmodel-cn': 'CN', 'moonshot-cn': 'CN', global: '' })[r.region] || (r.region ? r.region : '');
    const head = el('div', { class: 'card-head' },
      el('div', { class: 'card-title' },
        el('span', { class: `dot ${dotCls}`, 'aria-hidden': 'true' }),
        el('span', {}, r.name),
      ),
      el('div', { class: 'head-badges' },
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

    // At-a-glance human summary (z.ai, deepseek, opencode, new providers).
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

    // Balances (deepseek, openrouter, siliconflow, moonshot)
    if (Array.isArray(r.balances) && r.balances.length) {
      const blocks = r.balances.map((b) => {
        // Generic parts breakdown when present; fall back to deepseek's
        // legacy granted/toppedUp fields otherwise.
        let partsNodes;
        if (Array.isArray(b.parts) && b.parts.length) {
          partsNodes = b.parts.map((p) =>
            el('div', {}, el('span', { class: 'parts-label' }, `${p.label}:`), ` ${fmtMoney(p.value, b.currency)}`));
        } else {
          partsNodes = [];
          if (b.granted != null) partsNodes.push(el('div', {}, `${t('card.granted')} ${fmtMoney(b.granted, b.currency)}`));
          if (b.toppedUp != null) partsNodes.push(el('div', {}, `${t('card.toppedUp')} ${fmtMoney(b.toppedUp, b.currency)}`));
        }
        return el('div', { class: 'balance' },
          el('div', { class: 'balance-main' },
            el('span', { class: 'amount' }, fmtMoney(b.total, b.currency)),
            el('span', { class: 'currency' }, b.currency)),
          el('div', { class: 'parts' }, ...partsNodes),
        );
      });
      body.push(el('div', { class: 'balances' }, ...blocks));
      if (r.isAvailable === false) body.push(el('span', { class: 'badge warn' }, t('card.insufficientBalance')));
    }

    // Usage parts (DeepSeek web token: cumulative spend, monthly, token usage).
    if (Array.isArray(r.usageParts) && r.usageParts.length) {
      const rows = r.usageParts.map((p) => {
        const valText = p.unit === 'tokens'
          ? fmtTokens(p.value)
          : fmtMoney(p.value, p.currency || 'USD');
        return el('div', { class: 'meter-row' },
          el('span', { class: 'label' }, p.label),
          el('span', { class: 'val' }, valText),
        );
      });
      body.push(el('div', { class: 'usage-parts' }, ...rows));
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

    return el('div', { class: 'card', 'data-provider': r.provider, title: t('card.dragHint') }, head, ...body, foot);
  }

  function render() {
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    // Card order: persisted user order when set, else the provider registry order.
    const order = state.order.length ? state.order : state.meta.map((m) => m.id);
    // Only render cards that actually show subscription data: skip providers
    // with no key (notConfigured) or an invalid/expired key (unauthorized).
    const HIDDEN = new Set(['notConfigured', 'unauthorized']);
    const sorted = [...state.results]
      .filter((r) => !HIDDEN.has(r.status))
      .sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
    for (const r of sorted) grid.appendChild(renderCard(r));
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
      const order = [...grid.querySelectorAll('.card')].map((c) => c.dataset.provider);
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

    for (const m of state.meta) {
      const cfg = state.config.providers[m.id] || {};
      const hasWebToken = m.configFields.some((f) => f.key === 'webToken');
      // Short tag for the header — a quick hint of what this provider shows.
      const tags = { zai: t('settings.tag.codingPlan'), deepseek: t('settings.tag.balanceUsage'), opencode: t('settings.tag.goPlan'), openrouter: t('settings.tag.credits'), siliconflow: t('settings.tag.balance'), moonshot: t('settings.tag.balance') };
      const fs = el('div', { class: hasWebToken ? 'fieldset fieldset-wide' : 'fieldset' },
        el('h3', {}, m.name, el('span', { class: 'tag' }, tags[m.id] || t('settings.tag.api'))),
      );

      // Build inputs generically from configFields — password, select, etc.
      const inputs = {}; // fieldKey → DOM input element (or select)
      const regionLabels = {
        global: t('settings.region.global'),
        'bigmodel-cn': t('settings.region.bigmodelCn'),
        'moonshot-cn': t('settings.region.moonshotCn'),
      };
      const fieldPlaceholders = {
        apiKey: { savedKey: 'hasKey', maskKey: 'keyMask', ph: t('settings.ph.pasteApiKey') },
        webToken: { savedKey: 'hasWebToken', maskKey: 'webTokenMask', ph: t('settings.ph.pasteWebToken') },
      };

      // Build the input elements first.
      for (const f of m.configFields) {
        if (f.type === 'select') {
          const sel = el('select', { title: f.label },
            ...f.options.map((opt) => el('option', { value: opt }, regionLabels[opt] || opt)),
          );
          sel.value = cfg.region || f.default || f.options[0];
          inputs[f.key] = sel;
        } else {
          // password / text input
          const fp = fieldPlaceholders[f.key] || {};
          const saved = cfg[fp.savedKey];
          const mask = cfg[fp.maskKey];
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

      // Layout: each credential on its own labeled row, then a single button
      // row. Region select sits inline with its label too.
      const labelFor = (key) => ({ apiKey: t('settings.label.apiKey'), webToken: t('settings.label.webToken'), region: t('settings.label.region') }[key] || key);

      for (const f of m.configFields) {
        const fieldEl = inputs[f.key];
        if (!fieldEl) continue;
        const frow = el('div', { class: 'field-row' },
          el('span', { class: 'field-label' }, labelFor(f.key)),
          fieldEl,
        );
        fs.appendChild(frow);
        if (f.hint) {
          fs.appendChild(el('p', { class: 'field-hint' }, f.hint));
        }
      }

      const btnRow = el('div', { class: 'btn-row' });
      const testOut = el('div', { class: 'test-out' });
      const testBtn = el('button', { class: 'btn' }, t('settings.test'));
      const saveBtn = el('button', { class: 'btn btn-primary' }, t('settings.save'));
      btnRow.appendChild(testBtn);
      btnRow.appendChild(saveBtn);

      // "授权登录" button — shown for providers with a webToken field (DeepSeek).
      // Opens a login window in the desktop shell; in browser mode the server
      // returns 501 instructing the user to paste a token manually.
      if (m.configFields.some((f) => f.key === 'webToken')) {
        const authBtn = el('button', { class: 'btn btn-ghost', title: currentLang() === 'zh' ? '打开 DeepSeek 登录窗口 — 自动获取会话 token' : 'Open DeepSeek login in a window — auto-captures the session token' }, '🔑 授权登录');
        const authOut = el('div', { class: 'test-out small' });
        btnRow.appendChild(authBtn);
        fs.appendChild(authOut);
        authBtn.addEventListener('click', async () => {
          authOut.textContent = currentLang() === 'zh' ? '正在打开登录窗口…' : 'opening login window…'; authOut.className = 'test-out small';
          try {
            const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ provider: m.id }) });
            if (r.ok && r.token) {
              // Save the captured token as webToken, then refresh.
              state.config = await api('/api/config', { method: 'POST', body: JSON.stringify({ provider: m.id, fields: { webToken: r.token } }) });
              // Update placeholder.
              if (inputs.webToken) {
                inputs.webToken.value = '';
                const updated = state.config.providers[m.id] || {};
                inputs.webToken.placeholder = updated.hasWebToken ? t('settings.saved', updated.webTokenMask) : t('settings.ph.pasteWebToken');
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

      fs.appendChild(btnRow);
      fs.appendChild(testOut);

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
        return fields;
      };

      testBtn.addEventListener('click', async () => {
        const fields = collectFields();
        // For providers that need at least one credential (apiKey or webToken).
        if (!fields.apiKey && !fields.webToken) { testOut.textContent = t('settings.testEnterKey'); testOut.className = 'test-out err'; return; }
        testOut.textContent = t('settings.testing'); testOut.className = 'test-out';
        try {
          const r = await api(`/api/test/${m.id}?lang=${currentLang()}`, { method: 'POST', body: JSON.stringify({ fields }) });
          if (r.status === 'ok') {
            testOut.textContent = t('settings.testOk', r.summary || t('status.ok'));
            testOut.className = 'test-out ok';
          } else {
            // Show the localized status label instead of the raw English code.
            const KNOWN = ['ok', 'unauthorized', 'sourceRateLimited', 'timeout', 'unavailable', 'notConfigured', 'blockedHost'];
            const label = KNOWN.includes(r.status) ? t(`status.${r.status}`) : r.status;
            // The server error already carries the label + HTTP code (e.g. 「未授权 (401)」) —
            // prefer it directly to avoid 「未授权 — 未授权 (401)」.
            const text = r.error ? (r.error.startsWith(label) ? r.error : `${label} — ${r.error}`) : label;
            testOut.textContent = t('settings.testErr', text);
            testOut.className = 'test-out err';
          }
        } catch (e) {
          testOut.textContent = t('settings.testErr', e.message);
          testOut.className = 'test-out err';
        }
      });

      saveBtn.addEventListener('click', async () => {
        const fields = collectFields();
        if (!Object.keys(fields).length) { testOut.textContent = t('settings.nothingToSave'); testOut.className = 'test-out err'; return; }
        try {
          state.config = await api('/api/config', { method: 'POST', body: JSON.stringify({ provider: m.id, fields }) });
          // Clear input values & update placeholders.
          for (const f of m.configFields) {
            if (f.type === 'select') continue;
            if (inputs[f.key]) {
              inputs[f.key].value = '';
              const fp = fieldPlaceholders[f.key] || {};
              const updated = state.config.providers[m.id] || {};
              const saved = updated[fp.savedKey];
              const mask = updated[fp.maskKey];
              inputs[f.key].placeholder = saved ? t('settings.saved', mask) : (f.hint || (fp.ph || t('settings.ph.pasteValue')));
              delete inputs[f.key].dataset.cleared;
            }
          }
          testOut.textContent = t('settings.savedOk'); testOut.className = 'test-out ok';
          loadAll();
        } catch (e) {
          testOut.textContent = t('settings.testErr', e.message); testOut.className = 'test-out err';
        }
      });

      body.appendChild(fs);
    }
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
    // Apply the persisted language (falls back to the browser's language).
    try {
      const cfg = await api('/api/config');
      state.config = cfg;
      let lang = cfg.ui?.lang || '';
      if (lang !== 'zh' && lang !== 'en') {
        lang = detectLang();
        // Persist the detected language so all windows agree on the first paint.
        api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { lang } }) }).catch(() => {});
      }
      setLang(lang);
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
