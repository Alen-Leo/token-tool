// Safe outbound JSON getter.
//
// - Enforces the host allowlist (defined in security.js) before any request.
// - Limits redirects to allowed hosts only and bounds the hop count.
// - Enforces per-request and total timeouts.
// - Never throws raw secrets in error messages.
// - Returns a normalized { status, body } where body is parsed JSON when
//   possible, otherwise text.

import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import { isHostAllowed } from '../security.js';

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;
// Cap on a single response body buffered in memory. Request bodies are already
// bounded (server.js readBody); this bounds the response side so a misbehaving
// allowlisted host can't stream unbounded data into the process during the
// request timeout window.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(message, { status = 'unavailable', httpStatus = 0 } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status; // provider-facing status
    this.httpStatus = httpStatus;
  }
}

function classifyStatus(code) {
  if (code === 401 || code === 403) return 'unauthorized';
  if (code === 429) return 'sourceRateLimited';
  if (code >= 500) return 'unavailable';
  return 'unavailable';
}

// Core single-request. Returns { status, headers, bodyText, url }.
function once(rawUrl, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      reject(new HttpError('invalid url', { status: 'unavailable' }));
      return;
    }

    if (!isHostAllowed(url.hostname)) {
      reject(new HttpError(`host not allowed: ${url.hostname}`, { status: 'blockedHost' }));
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      reject(new HttpError(`protocol not allowed: ${url.protocol}`, { status: 'unavailable' }));
      return;
    }

    const lib = url.protocol === 'https:' ? https : http;
    const reqOptions = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'User-Agent': 'token-tool/0.2.0', Accept: 'application/json', ...headers },
    };

    const timer = setTimeout(() => {
      req.destroy(new HttpError('request timeout', { status: 'timeout' }));
    }, timeoutMs);

    const onAbort = () => req.destroy(new HttpError('aborted', { status: 'timeout' }));
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const req = lib.request(reqOptions, (res) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      // Single settle point: clearTimeout + removeEventListener once, reject or
      // resolve exactly once even if res.destroy() later fires req 'error'.
      const done = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn();
      };
      res.on('data', (c) => {
        if (settled) return;
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          res.destroy();
          done(() => reject(new HttpError('response too large', { status: 'unavailable' })));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => done(() => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        bodyText: Buffer.concat(chunks).toString('utf8'),
        url: rawUrl,
      })));
      res.on('error', (err) => done(() => {
        if (err instanceof HttpError) reject(err);
        else reject(new HttpError(err.message || 'network error', { status: 'unavailable' }));
      }));
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err instanceof HttpError) reject(err);
      else reject(new HttpError(err.message || 'network error', { status: 'unavailable' }));
    });

    req.end();
  });
}

// Public helper: GET a URL, follow allowlisted redirects, parse JSON.
export async function getJson(rawUrl, options = {}) {
  let current = rawUrl;
  let headers = options.headers;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await once(current, { ...options, headers });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, current).toString();
      const u = new URL(next);
      if (!isHostAllowed(u.hostname)) {
        throw new HttpError(`redirect to disallowed host: ${u.hostname}`, { status: 'blockedHost' });
      }
      // Credentials must never follow a redirect to a different host — an
      // allowlisted provider redirecting elsewhere would otherwise receive the
      // user's key for the original host.
      if (u.hostname !== new URL(current).hostname && headers?.Authorization) {
        headers = { ...headers };
        delete headers.Authorization;
      }
      current = next;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(`unauthorized (${res.status})`, { status: 'unauthorized', httpStatus: res.status });
    }
    if (res.status === 429) {
      throw new HttpError('rate limited', { status: 'sourceRateLimited', httpStatus: res.status });
    }
    if (res.status >= 400) {
      throw new HttpError(`http ${res.status}`, { status: classifyStatus(res.status), httpStatus: res.status });
    }
    return parseBody(res.bodyText);
  }
  throw new HttpError('too many redirects', { status: 'unavailable' });
}

function parseBody(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

// Run an async fn with a deadline; resolves the fn's promise or rejects with a
// timeout. Mirrors the reference project's probe-deadline pattern.
export function withDeadline(fn, { deadlineMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const inner = new AbortController();
    const timer = setTimeout(() => inner.abort(), deadlineMs);

    const link = () => {
      if (signal?.aborted) inner.abort();
    };
    link();
    if (signal) signal.addEventListener('abort', link, { once: true });
    const unlink = () => { if (signal) signal.removeEventListener('abort', link); };

    fn(inner.signal)
      .then((v) => {
        clearTimeout(timer);
        unlink();
        resolve(v);
      })
      .catch((err) => {
        clearTimeout(timer);
        unlink();
        if (err?.name === 'AbortError' || inner.signal.aborted) {
          reject(new HttpError('timeout', { status: 'timeout' }));
        } else {
          reject(err);
        }
      });
  });
}

export { HttpError };
