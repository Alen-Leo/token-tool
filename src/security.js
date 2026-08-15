// Security primitives for token-tool.
//
// 1. Session token — generated once per server launch. Required for every API
//    route that returns data or mutates config. The launcher passes it to the
//    browser via a query string; the page moves it into sessionStorage on first
//    load and strips it from the URL so it never lingers in history/referrers.
// 2. Outbound host allowlist — the only remote hosts the app will ever call.
//    Any other destination is refused before a socket is opened. This is the
//    core defence against a compromised config exfiltrating keys elsewhere.
// 3. Constant-time token comparison to avoid timing oracles.

import crypto from 'node:crypto';

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Constant-time equality for two strings of any length.
export function timingSafeEqualStrings(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // Still do a comparison to keep timing roughly constant.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// Extract bearer token from an IncomingMessage. Only Authorization: Bearer is
// accepted on API routes — the launch URL's ?token= is consumed by the page
// itself (it moves the token into sessionStorage before any API call), never
// by an API route. Keeping query tokens out of /api means the session token
// can never land in server/proxy access logs via an API request.
export function extractToken(req) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  return '';
}

// The definitive allowlist. Provider keys may only ever be sent to these hosts.
// Adding a provider means adding its host here — never relax this for arbitrary hosts.
export const OUTBOUND_ALLOWLIST = new Set([
  'api.z.ai',
  'open.bigmodel.cn',
  'api.deepseek.com',
  'platform.deepseek.com',
  'opencode.ai',
  'www.opencode.ai',
  'openrouter.ai',
  'api.siliconflow.cn',
  'api.moonshot.cn',
  'api.kimi.ai',
]);

export function isHostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/:\d+$/, '');
  return OUTBOUND_ALLOWLIST.has(host);
}
