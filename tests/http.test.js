// Tests for the outbound HTTP helper: abort semantics and allowlist gates.
// No real sockets are opened — every case rejects before a request is sent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getJson, withDeadline, HttpError } from '../src/util/http.js';

test('getJson with a pre-aborted signal rejects as a timeout, not a ReferenceError', async () => {
  // Regression: the pre-abort path used to call req.destroy() above `req`'s
  // declaration (TDZ ReferenceError) AND leak the request timeout, whose later
  // firing crashed the process with an uncaught exception.
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => getJson('https://api.deepseek.com/user/balance', { signal: ac.signal }),
    (err) => err instanceof HttpError && err.status === 'timeout',
  );
});

test('withDeadline converts an inner abort into a timeout HttpError', async () => {
  await assert.rejects(
    () => withDeadline(
      (signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('gone')));
      }),
      { deadlineMs: 20 },
    ),
    (err) => err instanceof HttpError && err.status === 'timeout',
  );
});

test('getJson rejects non-allowlisted hosts before any request', async () => {
  await assert.rejects(
    () => getJson('https://evil.example.com/x'),
    (err) => err instanceof HttpError && err.status === 'blockedHost',
  );
});

test('getJson rejects disallowed protocols without throwing', async () => {
  // A file: URL has an empty hostname, so it is refused by the allowlist gate
  // before the protocol check — either way, no request is ever sent.
  await assert.rejects(
    () => getJson('file:///etc/passwd'),
    (err) => err instanceof HttpError && err.status === 'blockedHost',
  );
});

test('getJson rejects invalid URLs without throwing', async () => {
  await assert.rejects(
    () => getJson('not a url'),
    (err) => err instanceof HttpError,
  );
});

test('withDeadline passes non-timeout errors through unchanged', async () => {
  const boom = new HttpError('nope', { status: 'unauthorized', httpStatus: 401 });
  await assert.rejects(
    () => withDeadline(() => Promise.reject(boom), { deadlineMs: 50 }),
    (err) => err === boom,
  );
});
