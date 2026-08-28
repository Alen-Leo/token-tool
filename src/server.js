#!/usr/bin/env node
// token-tool — local-first AI platform subscription / usage monitor.
//
// Runs a tiny HTTP server bound to 127.0.0.1 only. A per-launch session token
// guards every data/mutating API route. When launched from the CLI the token is
// handed to the browser via a query string, which the page immediately moves
// into sessionStorage and strips from the URL. When embedded (e.g. from the
// Electron desktop shell) the caller drives the browser itself via the handle
// returned from createServer().
//
// Zero runtime dependencies: Node built-ins only.

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, maskSecret, cleanSecret, newAccountId, DEFAULT_ACCOUNT_ID } from './config.js';
import { generateSessionToken, timingSafeEqualStrings, extractToken } from './security.js';
import { providerMeta, runAll, runProvider, getProvider } from './providers/index.js';

export const VERSION = '0.2.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function parseArgs(argv) {
  const out = { port: undefined, open: true, host: '127.0.0.1' };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-open') out.open = false;
    else if (a === '--open') out.open = true;
    else if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || 0;
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function readBody(req, res, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        if (!oversized) {
          oversized = true;
          // Respond 413 cleanly, then drain the remaining body so the client
          // receives the error instead of an ECONNRESET. Do NOT destroy the
          // socket here — that would cut the response off mid-write.
          try { send(res, 413, { error: 'payload too large' }); } catch { /* socket gone */ }
          req.resume(); // discard the rest of the oversized body
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (oversized) { reject(new Error('payload too large')); return; }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

// Security headers applied to every response. The CSP mirrors the desktop
// shell's (electron/main.js) so the browser/CLI mode is locked down the same
// way: the page only ever loads its own resources and talks to its own origin.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  // If the response was already written (e.g. 413 from readBody) and an error
  // path tries to send a 500 afterwards, do nothing instead of throwing
  // ERR_HTTP_HEADERS_SENT.
  if (res.headersSent) return;
  const isObj = body && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(payload);
}

function serveStatic(req, res, urlPath) {
  // Prevent path traversal: resolve under WEB_DIR and ensure containment.
  // NOTE: startsWith must include the trailing separator — without it, sibling
  // directories whose names begin with "web" (e.g. web2/, web-build/) would
  // pass the check and their files would be served.
  let requested;
  try {
    requested = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    // Malformed percent-encoding — nothing to serve; 400 rather than an
    // accidental 500 from the outer handler.
    return send(res, 400, 'bad request');
  }
  const filePath = path.join(WEB_DIR, requested === '/' ? 'index.html' : requested);
  const safe = filePath === WEB_DIR || filePath.startsWith(WEB_DIR + path.sep);
  if (!safe) return send(res, 403, 'forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'not found');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  });
}

/**
 * Create and start the loopback server. Used both by the CLI launcher and by
 * the Electron shell (which embeds it in-process). Returns a handle with the
 * bound port, the session token, the authenticated launch URL, and a stop()
 * function. Never auto-runs on import.
 */
export async function createServer(options = {}) {
  // Config is always the on-disk store (env dir override applies) — /api
  // routes load it themselves; here we only need the configured port.
  const config = loadConfig();
  const SESSION_TOKEN = options.sessionToken ?? generateSessionToken();
  const host = options.host || '127.0.0.1';
  const wantPort = options.port ?? config.port ?? 0;
  const startedAt = new Date().toISOString();

  // Auth-login handlers registered by the desktop shell (providerId → async fn
  // returning a session token). Empty in CLI/browser mode → /api/auth/login
  // returns 501 instructing the user to paste a web token.
  const authLoginHandlers = new Map();
  if (options.authLoginHandlers) {
    for (const [id, fn] of Object.entries(options.authLoginHandlers)) {
      authLoginHandlers.set(id, fn);
    }
  }

  const requireToken = (req) => {
    const t = extractToken(req);
    return t && timingSafeEqualStrings(t, SESSION_TOKEN);
  };

  // Declared up front so the request handler closure can reference `base` for the
  // same-origin Origin check; assigned once the port is bound (a few lines down).
  let base = '';

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;

      // CORS: refuse cross-origin requests. Loopback-only already; this is
      // belt-and-braces. NOTE: a same-origin Origin header IS legitimate — modern
      // browsers / Electron's Chromium send `Origin: http://127.0.0.1:<port>` on
      // same-origin fetches. Rejecting any Origin at all (the old behaviour)
      // caused the desktop shell to receive HTTP 403 on every /api call on
      // Windows. We allow the Origin iff it points back at this exact server.
      const origin = req.headers.origin;
      if (origin && origin !== base) return send(res, 403, 'cross-origin refused');

      // Health is public.
      if (pathname === '/api/health' && req.method === 'GET') {
        return send(res, 200, { ok: true, startedAt, version: VERSION });
      }

      // Auth-gated API.
      if (pathname.startsWith('/api/')) {
        if (!requireToken(req)) return send(res, 401, { error: 'unauthorized' });
        return handleApi(req, res, url, { authLoginHandlers }).catch((e) => send(res, 500, { error: 'internal', detail: String(e?.message || e) }));
      }

      // Static + SPA: serve from web/.
      if (req.method === 'GET') return serveStatic(req, res, req.url);
      return send(res, 405, 'method not allowed');
    } catch (e) {
      return send(res, 500, { error: 'internal', detail: String(e?.message || e) });
    }
  });

  // Bind loopback only.
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen({ port: wantPort, host }, resolve);
  });

  const { port } = server.address();
  base = `http://${host}:${port}`;
  const launchUrl = `${base}/?token=${SESSION_TOKEN}`;

  return {
    server,
    host,
    port,
    base,
    sessionToken: SESSION_TOKEN,
    launchUrl,
    startedAt,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function handleApi(req, res, url, handlers = {}) {
  const pathname = url.pathname;
  const config = loadConfig();

  if (pathname === '/api/providers' && req.method === 'GET') {
    return send(res, 200, { providers: providerMeta() });
  }

  if (pathname === '/api/query' && req.method === 'GET') {
    const lang = url.searchParams.get('lang') === 'zh' ? 'zh' : 'en';
    const results = await runAll(config, { lang });
    return send(res, 200, { results, generatedAt: new Date().toISOString() });
  }

  const single = /^\/api\/query\/([\w-]+)$/.exec(pathname);
  if (single && req.method === 'GET') {
    const lang = url.searchParams.get('lang') === 'zh' ? 'zh' : 'en';
    const results = await runProvider(single[1], config, { lang });
    return send(res, 200, { results });
  }

  // Read config (keys masked, presence flagged).
  if (pathname === '/api/config' && req.method === 'GET') {
    return send(res, 200, publicConfig(config));
  }

  // Write provider config (per-account credentials) or UI prefs.
  // Body variants (may also carry { ui } in the same request):
  //   { provider, fields }                     update/create the default account
  //   { provider, accountId, fields }          update one account
  //   { provider, addAccount: true, fields }   append a new account
  //   { provider, removeAccount: <accountId> } drop an account
  //   { ui: { lang, order } }                  prefs only
  // `fields` supports apiKey / webToken / region / label; an empty string
  // removes the field, an absent key leaves it untouched.
  if (pathname === '/api/config' && req.method === 'POST') {
    const body = await readBody(req, res);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }
    const { provider: id, accountId, fields: rawFields, addAccount, removeAccount, ui } = parsed || {};
    if (!id && !ui) return send(res, 400, { error: 'nothing to update' });
    if (id && !getProvider(id)) return send(res, 400, { error: 'unknown provider' });
    // Absent fields = no field updates (e.g. a ui-only body that names a
    // provider); a present-but-non-object fields is a client error.
    const fields = rawFields ?? {};
    if (typeof fields !== 'object' || Array.isArray(fields)) return send(res, 400, { error: 'invalid fields' });
    const wantAccount = String(accountId || '').trim();
    if (id && wantAccount.includes(':')) return send(res, 400, { error: 'invalid account id' });
    if (id && addAccount && removeAccount) return send(res, 400, { error: 'conflicting operations' });
    if (id && removeAccount && (typeof removeAccount !== 'string' || !removeAccount.trim() || removeAccount.includes(':'))) {
      return send(res, 400, { error: 'invalid account id' });
    }
    if (id && addAccount && !['apiKey', 'webToken', 'region', 'label'].some((k) => fields[k] != null && String(fields[k]).trim())) {
      return send(res, 400, { error: 'nothing to add' });
    }

    saveConfig((c) => {
      c.providers = c.providers || {};
      if (id) {
        const slice = c.providers[id] || { accounts: [] };
        const accounts = Array.isArray(slice.accounts) ? slice.accounts : [];

        if (removeAccount) {
          const index = accounts.findIndex((a) => a.id === removeAccount);
          if (index !== -1) accounts.splice(index, 1);
          // Drop the removed card from the persisted order right away.
          if (Array.isArray(c.ui?.order)) {
            c.ui.order = c.ui.order.filter((e) => e !== `${id}:${removeAccount}`);
          }
        } else if (addAccount) {
          accounts.push({ id: newAccountId(accounts.map((a) => a.id)), ...applyFields({}, fields) });
        } else {
          // Update: the named account, or without an accountId the first one.
          // A provider with no accounts gets the "default" one materialized —
          // but only when the request actually carries a field to write, so a
          // provider-only body stays a no-op (legacy behaviour).
          let index = wantAccount ? accounts.findIndex((a) => a.id === wantAccount) : accounts.length ? 0 : -1;
          if (index === -1 && !wantAccount && Object.keys(fields).length) {
            accounts.push({ id: DEFAULT_ACCOUNT_ID });
            index = accounts.length - 1;
          }
          if (index !== -1) accounts[index] = applyFields(accounts[index], fields);
        }

        if (accounts.length) c.providers[id] = { accounts };
        else delete c.providers[id]; // last account removed → provider empty
      }
      if (ui && typeof ui === 'object') {
        c.ui = c.ui || {};
        // Language: only the two supported values are accepted.
        if (ui.lang === 'zh' || ui.lang === 'en') c.ui.lang = ui.lang;
        // Order: provider ids ('zai') or card keys ('zai:accountId'),
        // deduplicated, unknown/stale entries pruned.
        if (Array.isArray(ui.order)) {
          const known = new Set(providerMeta().map((p) => p.id));
          const seen = new Set();
          const order = [];
          for (const entry of ui.order) {
            if (typeof entry !== 'string') continue;
            const key = entry.trim();
            if (!key || seen.has(key)) continue;
            const [pid, acc, ...rest] = key.split(':');
            if (!known.has(pid) || rest.length) continue;
            // 'env' accounts exist only at runtime (env-var synthesized), never
            // on disk — their card entries must survive disk-state validation.
            if (acc !== undefined && acc !== 'env' && !accountExists(c.providers, pid, acc)) continue;
            seen.add(key);
            order.push(key);
          }
          c.ui.order = order;
        }
      }
      return c;
    });
    // Respond with the env-merged view (same shape as GET) so the client's
    // state.config keeps env-var accounts after a write, not just on reads.
    return send(res, 200, publicConfig(loadConfig()));
  }

  // Live-test a provider with a key WITHOUT saving it (ephemeral). Body: { fields }.
  if (/^\/api\/test\/[\w-]+$/.test(pathname) && req.method === 'POST') {
    const id = pathname.split('/').pop();
    const provider = getProvider(id);
    if (!provider) return send(res, 400, { error: 'unknown provider' });
    const body = await readBody(req, res);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }
    const fields = parsed?.fields || {};
    if (fields != null && (typeof fields !== 'object' || Array.isArray(fields))) {
      return send(res, 400, { error: 'invalid fields' });
    }
    // accountId: fall back to THIS account's saved credentials when the form
    // inputs are empty, so "Test" works without re-pasting the key. Pasted
    // values still win (applyFields overlays them), keeping unsaved edits
    // testable; unknown ids yield an empty base — same as before.
    let base = {};
    if (typeof parsed?.accountId === 'string' && parsed.accountId) {
      const acc = (config.providers[id]?.accounts || []).find((a) => a && a.id === parsed.accountId);
      if (acc) base = { apiKey: acc.apiKey, webToken: acc.webToken, region: acc.region };
    }
    const merged = applyFields(base, fields);
    const lang = url.searchParams.get('lang') === 'zh' ? 'zh' : 'en';
    // Test is ephemeral — skipSpendTrack prevents the probe from mutating the
    // persisted spend baseline (the key under test may be a different account).
    const ephemeralConfig = { ...merged, skipSpendTrack: true };
    const result = await provider.fetch({ config: ephemeralConfig, lang });
    return send(res, 200, result);
  }

  // Auth login — open a browser login window (Electron shell only) to capture a
  // web session token for a provider. Body: { provider }. Returns { token } on
  // success; 501 when no auth-login handler is registered (CLI / browser-only).
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req, res);
    let parsed;
    try { parsed = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid json' }); }
    const providerId = parsed?.provider;
    if (!providerId) return send(res, 400, { error: 'missing provider' });
    const handler = handlers.authLoginHandlers?.get(providerId);
    if (!handler) {
      return send(res, 501, { error: 'auth-login not available — run as desktop app, or paste the web token manually' });
    }
    try {
      const token = await handler();
      if (!token) return send(res, 200, { ok: false, message: 'login cancelled or timed out' });
      return send(res, 200, { ok: true, token });
    } catch (e) {
      return send(res, 500, { error: String(e?.message || e) });
    }
  }

  return send(res, 404, { error: 'not found' });
}

// Merge posted `fields` into an existing account (or a fresh {}). Present
// keys overwrite; an empty value removes the field; absent keys are no-ops.
function applyFields(account, fields) {
  const merged = { ...account };
  for (const key of ['apiKey', 'webToken', 'region', 'label']) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const v = String(fields[key] ?? '').trim();
    if (v) merged[key] = key === 'apiKey' || key === 'webToken' ? cleanSecret(v) : v;
    else delete merged[key]; // empty → remove the credential / label
  }
  return merged;
}

// Does provider `pid` currently hold an account with id `acc`? Used to prune
// stale card-order entries at save time.
function accountExists(providers, pid, acc) {
  const accounts = providers?.[pid]?.accounts;
  return Array.isArray(accounts) && accounts.some((a) => a && a.id === acc);
}

// What the UI sees: per-provider account descriptors with masked keys and
// explicit presence. Raw keys never leave the server.
function publicConfig(config) {
  const providers = {};
  for (const p of providerMeta()) {
    const slice = config.providers?.[p.id];
    const accounts = (Array.isArray(slice?.accounts) ? slice.accounts : [])
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({
        id: a.id,
        label: a.label || null,
        hasKey: Boolean(cleanSecret(a.apiKey)),
        keyMask: maskSecret(a.apiKey || ''),
        hasWebToken: Boolean(cleanSecret(a.webToken)),
        webTokenMask: maskSecret(a.webToken || ''),
        region: a.region || null,
      }));
    providers[p.id] = { accounts };
  }
  return {
    ui: { lang: config.ui?.lang === 'zh' ? 'zh' : 'en', order: Array.isArray(config.ui?.order) ? config.ui.order : [] },
    providers,
  };
}

async function openInBrowser(url) {
  const { spawn } = await import('node:child_process');
  const platform = process.platform;
  let cmd;
  if (platform === 'darwin') cmd = ['open', url];
  else if (platform === 'win32') cmd = ['cmd', '/c', 'start', '', url];
  else cmd = ['xdg-open', url];
  spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore' }).unref();
}

// CLI entry — only when run directly (node src/server.js), not when imported.
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write('token-tool — local AI subscription/usage monitor\n\nUsage: token-tool [--port N] [--no-open] [--host 127.0.0.1]\n');
    return;
  }

  // Omit the port when the user didn't pass one, so the port from
  // config.json takes effect (its default 0 = pick a free port).
  const handle = await createServer({ host: args.host, ...(args.port != null ? { port: args.port } : {}) });

  process.stdout.write('\n  token-tool running\n');
  process.stdout.write(`  → ${handle.launchUrl}\n`);
  process.stdout.write(`  bound to ${handle.host} only · session token active\n\n`);

  const config = loadConfig();
  if (args.open && config.openBrowser !== false) {
    openInBrowser(handle.launchUrl).catch(() => {
      process.stdout.write('  (could not auto-open browser — open the URL above manually)\n');
    });
  }
}

function invokedAsCLI() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(entry);
  } catch {
    return false;
  }
}

if (invokedAsCLI()) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${e?.stack || e}\n`);
    process.exit(1);
  });
}
