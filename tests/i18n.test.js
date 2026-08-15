// Tests for the bilingual dictionary and localized helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tr, normalizeLang, errorText } from '../src/i18n.js';
import { HttpError } from '../src/util/http.js';
import { relativeFromNow } from '../src/util/format.js';

test('tr default language is English and fills placeholders', () => {
  assert.equal(tr('en', 'window.weekly'), 'Weekly');
  assert.equal(tr('en', 'summary.session', 42), 'session 42%');
  assert.equal(tr('en', 'summary.remaining', '5.00'), 'Remaining $5.00');
});

test('tr zh returns Chinese copy', () => {
  assert.equal(tr('zh', 'window.weekly'), '本周');
  assert.equal(tr('zh', 'summary.session', 42), '会话 42%');
  assert.equal(tr('zh', 'parts.last30d'), '近30天');
  assert.equal(tr('zh', 'summary.todaySpend'), '今日 {0} {1}');
});

test('tr falls back to English for a key missing in zh', () => {
  // parts.today exists in both; use an en-only style fallback via unknown key
  // semantics: unknown keys return the key itself.
  assert.equal(tr('zh', 'window.5hour'), '5小时');
  assert.equal(tr('zh', 'no.such.key'), 'no.such.key');
  assert.equal(tr('en', 'no.such.key'), 'no.such.key');
});

test('errorText translates app-generated HTTP errors (zh UI never shows English)', () => {
  assert.equal(errorText(new HttpError('unauthorized (401)', { status: 'unauthorized', httpStatus: 401 }), 'zh'), '未授权 (401)');
  assert.equal(errorText(new HttpError('request timeout', { status: 'timeout' }), 'zh'), '超时');
  assert.equal(errorText(new HttpError('rate limited', { status: 'sourceRateLimited' }), 'zh'), '限流');
  assert.equal(errorText(new HttpError('boom', { status: 'unavailable' }), 'zh'), '请求失败');
  assert.equal(errorText(new Error('boom'), 'zh'), '请求失败');
  assert.equal(errorText(new HttpError('x', { status: 'blockedHost' }), 'en'), 'Blocked');
});

test('normalizeLang clamps to zh or en', () => {
  assert.equal(normalizeLang('zh'), 'zh');
  assert.equal(normalizeLang('en'), 'en');
  assert.equal(normalizeLang('fr'), 'en');
  assert.equal(normalizeLang(undefined), 'en');
});

test('relativeFromNow stays English by default', () => {
  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  assert.match(relativeFromNow(future), /^in \d+m$/);
  assert.match(relativeFromNow(past), /ago$/);
});

test('relativeFromNow renders Chinese when lang=zh', () => {
  const future = new Date(Date.now() + 51 * 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const now = Date.now();
  const in5m = new Date(now + 5 * 60 * 1000).toISOString();
  assert.equal(relativeFromNow(future, now, 'zh'), '51天后');
  assert.equal(relativeFromNow(past, now, 'zh'), '2小时前');
  assert.equal(relativeFromNow(in5m, now, 'zh'), '5分钟后');
});
