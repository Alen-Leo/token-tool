// Tests for the embedded server factory (createServer) and routing.
//
// These spin up a real loopback server on an ephemeral port and exercise the
// HTTP contract: health is public, every /api route requires the session
// token, providers are listed, config round-trips with masking, and static
// files are served from web/. No network egress — provider fetches are not
// triggered here (no keys in the test config).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

// Run against an ISOLATED, empty config dir so the tests never touch the
// user's real ~/.token-tool/config.json (which may hold live API keys) and
// never make real provider network calls.
const TMP_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'token-tool-test-'));
process.env.TOKEN_TOOL_CONFIG_DIR = TMP_CONFIG;

let handle;

test.before(async () => {
  handle = await createServer({ host: '127.0.0.1', port: 0 });
});

test.after(async () => {
  if (handle) await handle.stop();
});

function authed(path, init = {}) {
  return fetch(`${handle.base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${handle.sessionToken}`, ...(init.headers || {}) },
  });
}

test('createServer returns a handle with port, base, and a 64-hex token', () => {
  assert.ok(handle.port > 0);
  assert.match(handle.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(handle.sessionToken, /^[0-9a-f]{64}$/);
  assert.ok(handle.launchUrl.startsWith(handle.base));
  assert.ok(handle.launchUrl.includes(`token=${handle.sessionToken}`));
});

test('health endpoint is public (no token required)', async () => {
  const res = await fetch(`${handle.base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.startedAt);
});

test('every /api data route rejects a missing token with 401', async () => {
  const res = await fetch(`${handle.base}/api/providers`);
  assert.equal(res.status, 401);
});

test('every /api data route rejects a wrong token with 401', async () => {
  const res = await fetch(`${handle.base}/api/providers`, {
    headers: { Authorization: 'Bearer deadbeef' },
  });
  assert.equal(res.status, 401);
});

test('a same-origin Origin header is allowed (Electron/Chromium sends one)', async () => {
  // Regression: the desktop shell on Windows received HTTP 403 on every /api
  // call because the server rejected ANY Origin header, including the
  // legitimate same-origin one Chromium attaches to same-origin fetches.
  const res = await fetch(`${handle.base}/api/providers`, {
    headers: { Authorization: `Bearer ${handle.sessionToken}`, Origin: handle.base },
  });
  assert.equal(res.status, 200);
});

test('a cross-origin Origin header is refused with 403', async () => {
  const res = await fetch(`${handle.base}/api/providers`, {
    headers: { Authorization: `Bearer ${handle.sessionToken}`, Origin: 'http://evil.example.com' },
  });
  assert.equal(res.status, 403);
});

test('providers list the six known providers when authed', async () => {
  const res = await authed('/api/providers');
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.providers.map((p) => p.id);
  assert.deepEqual(ids.sort(), ['deepseek', 'moonshot', 'opencode', 'openrouter', 'siliconflow', 'zai']);
});

test('query runs all providers and returns an array', async () => {
  const res = await authed('/api/query');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.results));
  assert.equal(body.results.length, 6);
  assert.ok(body.generatedAt);
});

test('config GET masks keys and never returns raw secrets', async () => {
  const res = await authed('/api/config');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.providers);
  for (const p of Object.values(body.providers)) {
    assert.ok(Array.isArray(p.accounts));
    assert.equal(p.accounts.length, 0); // nothing configured in this test dir
  }
});

test('config GET returns ui prefs (default zh, empty order)', async () => {
  const res = await authed('/api/config');
  const body = await res.json();
  assert.ok(body.ui);
  assert.equal(body.ui.lang, 'zh');
  assert.deepEqual(body.ui.order, []);
});

test('config POST persists ui.lang and ui.order (validated)', async () => {
  // Save lang + order.
  let res = await authed('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ui: { lang: 'zh', order: ['deepseek', 'zai', 'opencode', 'moonshot', 'openrouter', 'siliconflow'] } }),
  });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.ui.lang, 'zh');
  assert.deepEqual(body.ui.order, ['deepseek', 'zai', 'opencode', 'moonshot', 'openrouter', 'siliconflow']);

  // Round-trip via GET.
  res = await authed('/api/config');
  body = await res.json();
  assert.equal(body.ui.lang, 'zh');
  assert.deepEqual(body.ui.order, ['deepseek', 'zai', 'opencode', 'moonshot', 'openrouter', 'siliconflow']);
});

test('config POST ui.order drops unknown ids and duplicates', async () => {
  const res = await authed('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ui: { order: ['zai', 'nope', 'zai', 'deepseek'] } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.ui.order, ['zai', 'deepseek']);
});

test('config POST rejects unsupported ui.lang values', async () => {
  const res = await authed('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ui: { lang: 'fr' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // Unsupported values are ignored — the previously persisted 'zh' is kept.
  assert.equal(body.ui.lang, 'zh');
});

test('config POST with a provider but no fields is a no-op, not a 500', async () => {
  // Regression: provider-only bodies used to crash on
  // hasOwnProperty.call(undefined, …) and surface as 500.
  const res = await authed('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'zai' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providers.zai.accounts.length, 0);
});

test('config POST rejects non-object fields with 400 invalid fields', async () => {
  const res = await authed('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'zai', fields: 'oops' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid fields');
});

test('static index.html is served at /', async () => {
  const res = await fetch(`${handle.base}/?token=${handle.sessionToken}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>token-tool<\/title>/);
});

test('path traversal under web/ is refused', async () => {
  const res = await fetch(`${handle.base}/../package.json?token=${handle.sessionToken}`);
  // Node normalizes ../ in the URL path; expect not to leak source files.
  assert.ok(res.status >= 400);
});

test('path traversal sibling of web/ (web2-style prefix) is refused', async () => {
  // Regression: startsWith(WEB_DIR) without a trailing separator let sibling
  // directories whose names begin with "web" (web2/, web-build/) pass the
  // containment check. Must be refused with 403.
  const res = await fetch(`${handle.base}/..%2Fweb2%2Fsecret.txt?token=${handle.sessionToken}`);
  assert.equal(res.status, 403);
});

test('oversized request body gets 413, not a connection reset', async () => {
  const big = JSON.stringify({ provider: 'zai', fields: { apiKey: 'x'.repeat(2 * 1024 * 1024) } });
  const res = await authed('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
  assert.equal(res.status, 413);
});

test('stop closes the server so its port is released', async () => {
  const local = await createServer({ host: '127.0.0.1', port: 0 });
  const ok = await fetch(`${local.base}/api/health`);
  assert.equal(ok.status, 200);
  await local.stop();
  await assert.rejects(() => fetch(`${local.base}/api/health`));
});

test('createServer honors the port from config.json when none is passed', async () => {  // Find a free port, then point a temporary config dir at it.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const freePort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-tool-port-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: freePort, providers: {} }));
  const prevEnv = process.env.TOKEN_TOOL_CONFIG_DIR;
  process.env.TOKEN_TOOL_CONFIG_DIR = dir;
  try {
    const local = await createServer({ host: '127.0.0.1' });
    assert.equal(local.port, freePort);
    await local.stop();
  } finally {
    process.env.TOKEN_TOOL_CONFIG_DIR = prevEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- multi-account flow ----------------------------------------------------
// Keyless accounts only — provider fetches return notConfigured without any
// network egress, keeping these tests hermetic. (No /api/query call is made
// while any account carries an apiKey.)

function postConfig(payload) {
  return authed('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('config POST without accountId materializes the default account', async () => {
  let res = await postConfig({ provider: 'zai', fields: { apiKey: 'sk-multi-aaaaaaaaaa', region: 'global' } });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.providers.zai.accounts.length, 1);
  assert.equal(body.providers.zai.accounts[0].id, 'default');
  assert.equal(body.providers.zai.accounts[0].hasKey, true);
  assert.equal(body.providers.zai.accounts[0].keyMask.includes('sk-multi-aaaaaaaaaa'), false);
});

test('config POST addAccount appends a second, distinct account', async () => {
  const res = await postConfig({ provider: 'zai', addAccount: true, fields: { apiKey: 'sk-multi-bbbbbbbbbb', label: '工作' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providers.zai.accounts.length, 2);
  const ids = body.providers.zai.accounts.map((a) => a.id);
  assert.equal(new Set(ids).size, 2);
  const second = body.providers.zai.accounts[1];
  assert.equal(second.label, '工作');
  assert.equal(second.hasKey, true);
});

test('config POST updates one account by id, others untouched', async () => {
  const before = (await (await authed('/api/config')).json()).providers.zai.accounts;
  const target = before[1].id;
  const res = await postConfig({ provider: 'zai', accountId: target, fields: { label: '个人' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providers.zai.accounts.length, 2);
  assert.equal(body.providers.zai.accounts.find((a) => a.id === target).label, '个人');
  assert.equal(body.providers.zai.accounts.find((a) => a.id !== target).label, null);
});

test('config POST rejects updates for an unknown accountId cleanly', async () => {
  const res = await postConfig({ provider: 'zai', accountId: 'nosuch', fields: { label: 'x' } });
  assert.equal(res.status, 200); // no-op update, config unchanged
  const body = await res.json();
  assert.equal(body.providers.zai.accounts.length, 2);
});

test('config POST removeAccount deletes one account; last removal empties the provider', async () => {
  const cfg = (await (await authed('/api/config')).json()).providers.zai.accounts;
  let res = await postConfig({ provider: 'zai', removeAccount: cfg[1].id });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.providers.zai.accounts.length, 1);

  res = await postConfig({ provider: 'zai', removeAccount: 'default' });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.providers.zai.accounts.length, 0);

  // Provider is gone from the persisted file, not just the response.
  const raw = JSON.parse(fs.readFileSync(path.join(TMP_CONFIG, 'config.json'), 'utf8'));
  assert.equal(raw.providers.zai, undefined);
});

// Two KEYLESS accounts (label only) so /api/query stays hermetic.
test('query fans out per account — one notConfigured result each', async () => {
  await postConfig({ provider: 'zai', addAccount: true, fields: { label: '工作' } });
  await postConfig({ provider: 'zai', addAccount: true, fields: { label: '个人' } });

  const res = await authed('/api/query');
  assert.equal(res.status, 200);
  const body = await res.json();
  // 2 z.ai accounts + 5 providers with none (one notConfigured result each).
  assert.equal(body.results.length, 7);
  const zai = body.results.filter((r) => r.provider === 'zai');
  assert.equal(zai.length, 2);
  assert.equal(new Set(zai.map((r) => r.accountId)).size, 2);
  for (const r of zai) {
    assert.equal(r.status, 'notConfigured');
    assert.ok(r.accountId);
  }
});

test('single-provider query returns a per-account results array', async () => {
  const res = await authed('/api/query/zai');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.results));
  assert.equal(body.results.length, 2);
});

test('config POST addAccount without any fields is rejected with 400', async () => {
  const res = await postConfig({ provider: 'moonshot', addAccount: true, fields: {} });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'nothing to add');
});

test('config POST rejects malformed account ids', async () => {
  let res = await postConfig({ provider: 'moonshot', accountId: 'a:b', fields: { label: 'x' } });
  assert.equal(res.status, 400);
  res = await postConfig({ provider: 'moonshot', removeAccount: 'a:b' });
  assert.equal(res.status, 400);
});

test('ui.order accepts card keys, prunes stale accounts, keeps group entries', async () => {
  const cfg = (await (await authed('/api/config')).json()).providers.zai.accounts;
  const first = cfg[0].id;
  const second = cfg[1].id;

  // Card key + bare provider entry + unknown junk.
  let res = await postConfig({ ui: { order: [`zai:${first}`, 'zai', 'deepseek', `zai:${second}`, 'zai:ghost', 'nope', `zai:${first}`] } });
  assert.equal(res.status, 200);
  let body = await res.json();
  // 'zai:ghost' (no such account), 'nope' (no such provider) and the duplicate
  // 'zai:<first>' are dropped; the rest survives in order.
  assert.deepEqual(body.ui.order, [`zai:${first}`, 'zai', 'deepseek', `zai:${second}`]);

  // Removing an account prunes its card entry immediately.
  await postConfig({ provider: 'zai', removeAccount: second });
  res = await authed('/api/config');
  body = await res.json();
  assert.deepEqual(body.ui.order, [`zai:${first}`, 'zai', 'deepseek']);

  // Cleanup: leave the config empty for any later assertions.
  await postConfig({ provider: 'zai', removeAccount: first });
});

test('ui.order keeps runtime env-account card entries', async () => {
  // 'deepseek:env' refers to an env-var-synthesized account that never exists
  // on disk — order validation must not prune it.
  const res = await postConfig({ ui: { order: ['deepseek:env', 'zai'] } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.ui.order, ['deepseek:env', 'zai']);
});
