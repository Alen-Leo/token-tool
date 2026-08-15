import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, maskSecret, cleanSecret } from '../src/config.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tt-cfg-'));
}

test('maskSecret hides middle of a key', () => {
  const masked = maskSecret('sk-abcdefghij1234567890');
  assert.match(masked, /^sk-/);
  assert.match(masked, /•/);
  assert.equal(masked.includes('abcdefghij1234567890'), false);
});

test('maskSecret handles short values', () => {
  assert.equal(maskSecret('sk-ab'), '•••••');
  assert.equal(maskSecret(''), '');
});

test('cleanSecret strips quotes and whitespace', () => {
  assert.equal(cleanSecret('  "abc"  '), 'abc');
  assert.equal(cleanSecret("'abc'"), 'abc');
  assert.equal(cleanSecret(123), '');
});

test('saveConfig writes 0600 file and round-trips', () => {
  const dir = tmpDir();
  const saved = saveConfig((c) => {
    c.providers = { deepseek: { apiKey: 'sk-test1234567890' } };
    return c;
  }, dir);
  assert.equal(saved.providers.deepseek.apiKey, 'sk-test1234567890');
  const file = path.join(dir, 'config.json');
  const stat = fs.statSync(file);
  // 0600 = 0o600. Lower 12 bits only. Windows has no Unix permission bits
  // (chmod is best-effort via ACLs, files report 0o666), so only assert the
  // strict mode on POSIX systems; on Windows just confirm the file exists.
  if (process.platform !== 'win32') {
    assert.equal(stat.mode & 0o777, 0o600);
  } else {
    assert.ok(stat.isFile(), 'config file written');
  }
  const loaded = loadConfig(dir);
  assert.equal(loaded.providers.deepseek.apiKey, 'sk-test1234567890');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig tolerates missing/malformed file', () => {
  const dir = tmpDir();
  const loaded = loadConfig(dir);
  assert.ok(loaded.providers);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ui prefs (lang/order) round-trip through save/load with defaults', () => {
  const dir = tmpDir();
  // Defaults on a fresh config.
  const fresh = loadConfig(dir);
  assert.equal(fresh.ui.lang, 'en');
  assert.deepEqual(fresh.ui.order, []);

  // Persist a language + order, then reload.
  saveConfig((c) => {
    c.ui = { lang: 'zh', order: ['deepseek', 'zai'] };
    return c;
  }, dir);
  const loaded = loadConfig(dir);
  assert.equal(loaded.ui.lang, 'zh');
  assert.deepEqual(loaded.ui.order, ['deepseek', 'zai']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadConfig merges partial ui from file over defaults', () => {
  const dir = tmpDir();
  // Only lang persisted — order must still default to [].
  saveConfig((c) => {
    c.ui = { lang: 'zh' };
    return c;
  }, dir);
  const loaded = loadConfig(dir);
  assert.equal(loaded.ui.lang, 'zh');
  assert.deepEqual(loaded.ui.order, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
